-- Re-key the backfill queue from series to (location, compartiment, grootheid).
--
-- Migration 008 keyed the queue on series_id, which cannot work for planning:
-- a `series` row is only created once observations have been fetched and their
-- full AquoMetadata is known, so the work that has *not* run yet -- exactly the
-- work a queue exists to track -- has no series_id to reference.
--
-- The plannable unit is what the WFS layer already tells us a location
-- publishes: (location_code, compartiment, grootheid). One month of that is one
-- request, which keeps responses manageable and failures cheap to retry. A
-- single chunk may write to several series rows, since one quantity pair fans
-- out into multiple physical streams; that is expected and handled at ingest.
--
-- Dropping rather than migrating: the queue is transient work state rebuilt by
-- `backfill plan`, never a source of truth, and Phase 4 is the first time it is
-- populated at all, so there is no in-flight progress to preserve.
DROP TABLE IF EXISTS backfill_jobs;

CREATE TABLE backfill_jobs (
  id            bigserial PRIMARY KEY,
  location_code text NOT NULL REFERENCES locations (code),
  compartiment  text NOT NULL,
  grootheid     text NOT NULL,
  -- First instant of the month in UTC. The job covers [month, month + 1 month].
  -- Both period endpoints are inclusive upstream, so adjacent chunks overlap by
  -- one timestamp; the idempotent upsert makes that harmless.
  month         timestamptz NOT NULL,

  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'empty', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  rows_written  integer NOT NULL DEFAULT 0,

  -- Lower runs first. Set from the tier configuration at plan time.
  priority      integer NOT NULL DEFAULT 100,
  tier          text NOT NULL DEFAULT 'eager',

  -- When this chunk's data was fetched, so the freshness of any slice of
  -- history is always visible -- including after the rolling re-fetch.
  fetched_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,

  UNIQUE (location_code, compartiment, grootheid, month)
);

-- The claim query: lowest priority first, then oldest month. Partial index so
-- it stays small as the queue drains.
CREATE INDEX backfill_jobs_claim_idx ON backfill_jobs (priority, month)
  WHERE status = 'pending';
CREATE INDEX backfill_jobs_status_idx ON backfill_jobs (status);
-- Backs the rolling re-fetch, which re-queues recent months.
CREATE INDEX backfill_jobs_month_idx ON backfill_jobs (month);
