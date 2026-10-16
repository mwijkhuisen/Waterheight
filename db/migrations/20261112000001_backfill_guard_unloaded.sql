-- migrate:up

-- The backfill guard allows no unloaded chunk (P14a queue fix). `unloaded`: a chunk of an active job wrote a manifest
-- line and the loader's ledger does not hold it yet (it allowed 30). Backfill lines share the daily manifest with the
-- live lines and the loader reads it in order, so every unloaded chunk sits in front of the live lines behind it: on
-- the night of 2026-10-15/16 a chunk took up to about a minute to load, 30 of them held live data back up to 34
-- minutes, and live lag rose past the 120 s limit while the other verdicts held. A chunk the loader sets aside
-- (quarantined, skipped) gets a ledger row too. The ledger is counted by distinct chunk start: a chunk fetched again
-- after a kill between its manifest line and its cursor has two rows and one count in chunks_with_data (review Q2).
-- Only these two change: the body, SECURITY DEFINER, the search_path, the owner, the REVOKE and the GRANT to
-- rws_backfill (CREATE OR REPLACE keeps them) stay as in 20261111000001_backfill_guard_60s.sql.
CREATE OR REPLACE FUNCTION backfill_guard(p_source text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN l.value IS NULL
      OR COALESCE((l.value ->> 'computed_at')::timestamptz, '-infinity') < now() - interval '150 seconds' THEN 'loader_lag'
    WHEN COALESCE((l.value ->> 'backlog_age_s')::numeric, 0) > 60
      OR COALESCE((l.value ->> 'backlog_files')::numeric, 0) > 3 THEN 'backlog'
    WHEN EXISTS (
        SELECT 1 FROM public.backfill_job j
        WHERE j.source_id = p_source
          AND j.status IN ('planned', 'running', 'paused')
          AND j.chunks_with_data - (SELECT count(DISTINCT c.chunk_from) FROM public.backfill_chunk c WHERE c.job_id = j.id) > 0
      ) THEN 'unloaded'
    WHEN h.status IS DISTINCT FROM 'ok' THEN 'stale'
    ELSE 'ok'
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.app_meta l ON l.key = 'loader'
  LEFT JOIN public.source_health h ON h.source_id = p_source
$$;

-- migrate:down

CREATE OR REPLACE FUNCTION backfill_guard(p_source text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN l.value IS NULL
      OR COALESCE((l.value ->> 'computed_at')::timestamptz, '-infinity') < now() - interval '150 seconds' THEN 'loader_lag'
    WHEN COALESCE((l.value ->> 'backlog_age_s')::numeric, 0) > 60
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
