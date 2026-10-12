-- migrate:up

-- P14a (issue #29): the backfill of history before go-live. The runner (role `backfill`, database role
-- rws_backfill) keeps one job per series and writes only its own table; the loader loads the payloads it archives
-- (spec `nl-1-backfill-obs`) under the row rules of load/store.ts and keeps the counts and the per-payload ledger.

-- One job per (spec, series, range). `cursor_ts` is the end of the last committed chunk: a killed runner resumes
-- there, and the chunk it re-fetches reloads idempotently. The count columns from `provider_values` to
-- `unreconciled` are the loader's (one addition per ledger row); the rest is the runner's. `last_error` is one of
-- our fixed codes, never provider text (invariant 6).
CREATE TABLE backfill_job (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  spec_id text NOT NULL CHECK (spec_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  source_id text NOT NULL REFERENCES source (id),
  series_key text NOT NULL CHECK (length(series_key) BETWEEN 1 AND 300),
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  chunk interval NOT NULL CHECK (chunk > interval '0'),
  data_from timestamptz,                      -- probe result; NULL = not probed yet
  cursor_ts timestamptz NOT NULL,             -- end of the last committed chunk (= range_from at creation)
  chunks_done integer NOT NULL DEFAULT 0 CHECK (chunks_done >= 0),
  chunks_with_data integer NOT NULL DEFAULT 0 CHECK (chunks_with_data >= 0), -- chunks that wrote a manifest line
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','paused','done','failed','aborted')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  request_budget integer NOT NULL CHECK (request_budget > 0),
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  provider_values bigint NOT NULL DEFAULT 0,  -- loader-maintained counters from here …
  inserted bigint NOT NULL DEFAULT 0,
  revised bigint NOT NULL DEFAULT 0,
  skipped bigint NOT NULL DEFAULT 0,
  dropped bigint NOT NULL DEFAULT 0,
  unreconciled integer NOT NULL DEFAULT 0,    -- … to here
  last_error text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (range_from < range_to),
  CHECK (cursor_ts >= range_from AND cursor_ts <= range_to),
  UNIQUE (spec_id, series_key, range_from, range_to)
);

-- The load ledger: one row per loaded backfill payload. Its key makes the job counters count a payload once, however
-- often it is re-fetched or replayed. `reconciled`: provider_values = kept + dropped and kept = inserted + revised +
-- skipped (plan §3.6).
CREATE TABLE backfill_chunk (
  job_id bigint NOT NULL REFERENCES backfill_job (id),
  archive_key text NOT NULL,
  chunk_from timestamptz NOT NULL,
  chunk_to timestamptz NOT NULL,
  provider_values integer NOT NULL, kept integer NOT NULL, inserted integer NOT NULL,
  revised integer NOT NULL, skipped integer NOT NULL, dropped integer NOT NULL,
  reconciled boolean NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, archive_key)
);

-- One runner per host (review C1/S1): advisory locks are revoked from PUBLIC (roles.sql), so a run holds a lease
-- row per host it fetches from. It takes the row when it is free or expired (`until < now()`) or already its own,
-- renews it to now() + 2 minutes before every request and gives it back at exit; a killed runner's lease lapses
-- within 2 minutes. `holder` is a random id per process.
CREATE TABLE backfill_lease (
  host text PRIMARY KEY CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  holder text NOT NULL CHECK (holder ~ '^[a-f0-9-]{1,64}$'),
  until timestamptz NOT NULL
);

-- Which loader path a batch came through. A batch never changes its origin, so a row's kind (live, fill or backfill:
-- qc bit 512 plus this) never changes with a confirmation; the health queries count `live` batches only.
ALTER TABLE ingest_batch ADD COLUMN origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live','backfill'));

-- May the runner fetch now? 'ok', or why not: `loader_lag` (the loader's app_meta `loader` row is older than 5 minutes
-- or has no `computed_at`: fail closed), `backlog` (its oldest unread line is over 600 s old or more than 3 files
-- wait), `unloaded` (an active job of the source, planned, running or paused, has more than 30 chunks with data that
-- the ledger does not hold yet: archived and not loaded, or quarantined; review S6/C5, N1/N4) or `stale` (the source
-- is not healthy). The 30 is the arithmetic of a healthy night: the runner writes at most 1 chunk/s, the loader reads
-- every 10 s (TICK_MS) and for up to 20 s a tick (TICK_BUDGET_MS), so up to 10 chunks wait for the next tick and
-- up to 30 while a tick is still reading; more than that is a loader that does not keep up, not a normal state.
-- The runner holds no privilege on app_meta or source_health; this is its one window onto them, with the thresholds
-- fixed here. SECURITY DEFINER, so: a fixed search_path with pg_temp last and every name schema-qualified.
CREATE FUNCTION backfill_guard(p_source text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN l.value IS NULL
      OR COALESCE((l.value ->> 'computed_at')::timestamptz, '-infinity') < now() - interval '5 minutes' THEN 'loader_lag'
    WHEN COALESCE((l.value ->> 'backlog_age_s')::numeric, 0) > 600
      OR COALESCE((l.value ->> 'backlog_files')::numeric, 0) > 3 THEN 'backlog'
    WHEN EXISTS (
        SELECT 1 FROM public.backfill_job j
        WHERE j.source_id = p_source
          AND j.status IN ('planned', 'running', 'paused')
          AND j.chunks_with_data - (SELECT count(*) FROM public.backfill_chunk c WHERE c.job_id = j.id) > 30
      ) THEN 'unloaded'
    WHEN h.status IS DISTINCT FROM 'ok' THEN 'stale'
    ELSE 'ok'
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.app_meta l ON l.key = 'loader'
  LEFT JOIN public.source_health h ON h.source_id = p_source
$$;

REVOKE ALL ON FUNCTION backfill_guard(text) FROM PUBLIC;

-- The runner: its job table (counts excluded), its lease and the guard, nothing else (not even the registry tables:
-- it resolves series against the registry files).
GRANT USAGE ON SCHEMA public TO rws_backfill;
GRANT SELECT, INSERT ON backfill_job TO rws_backfill;
GRANT UPDATE (cursor_ts, chunks_done, chunks_with_data, status, attempts, requests, data_from, last_error, started_at,
              updated_at, finished_at) ON backfill_job TO rws_backfill;
GRANT SELECT, INSERT, UPDATE ON backfill_lease TO rws_backfill;
GRANT USAGE ON SEQUENCE backfill_job_id_seq TO rws_backfill;
GRANT EXECUTE ON FUNCTION backfill_guard(text) TO rws_backfill;

-- The loader: reads the jobs and adds to their counts; writes the ledger (no DELETE).
GRANT SELECT ON backfill_job TO rws_load;
GRANT UPDATE (provider_values, inserted, revised, skipped, dropped, unreconciled, updated_at) ON backfill_job TO rws_load;
GRANT SELECT, INSERT, UPDATE ON backfill_chunk TO rws_load;

-- migrate:down

DROP FUNCTION backfill_guard(text);
DROP TABLE backfill_chunk;
DROP TABLE backfill_lease;
DROP TABLE backfill_job;
ALTER TABLE ingest_batch DROP COLUMN origin;
REVOKE USAGE ON SCHEMA public FROM rws_backfill;
