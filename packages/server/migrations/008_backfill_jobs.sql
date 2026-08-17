-- The backfill work queue. Unit of work is (series, month): one month per
-- request keeps responses manageable and makes failures cheap to retry.
--
-- Ordinary table in the same database as the observations on purpose -- a
-- chunk is marked done in the SAME transaction that commits its rows, which is
-- what makes the backfill crash-safe rather than merely restartable.
CREATE TABLE backfill_jobs (
  id            bigserial PRIMARY KEY,
  series_id     bigint NOT NULL REFERENCES series (id),
  -- First instant of the month, UTC. The job covers [month, month + 1 month).
  month         timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'empty', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  rows_written  integer NOT NULL DEFAULT 0,
  priority      integer NOT NULL DEFAULT 100,
  -- When the chunk's data was fetched, so slice freshness is always visible.
  fetched_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  UNIQUE (series_id, month)
);

-- The claim query: lowest priority number first, then oldest month.
CREATE INDEX backfill_jobs_claim_idx ON backfill_jobs (priority, month)
  WHERE status = 'pending';
CREATE INDEX backfill_jobs_status_idx ON backfill_jobs (status);
