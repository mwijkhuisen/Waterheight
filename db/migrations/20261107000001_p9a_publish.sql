-- migrate:up

-- P9a: the publishers' dirty log (A§9.1 "Cache versioning"). In the transaction that writes them, the loader records
-- which instants and stations its changes touch, one row per (family, kind) per transaction; the publishers read
-- their family's rows through the dirty views (security_barrier, granted to the family's roles) and keep their
-- cursor in memory. The loader may only add rows (no UPDATE, no DELETE: invariant 2 and T-LOAD-3); `migrate` prunes
-- rows older than 3 days as the owner role, under the loader lock. The settled-day versions live in app_meta
-- (`day_versions:public`, `day_versions:owner`), which rws_load may already insert and update.
CREATE TABLE publish_dirty (
  id bigserial PRIMARY KEY,
  family text NOT NULL CHECK (family IN ('public', 'owner')),
  kind text NOT NULL CHECK (kind IN ('obs', 'forecast', 'reference', 'class', 'warning', 'gauge_zero')),
  from_ts timestamptz NOT NULL,
  to_ts timestamptz NOT NULL CHECK (to_ts >= from_ts),
  stations text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT ON publish_dirty TO rws_load;
GRANT USAGE ON SEQUENCE publish_dirty_id_seq TO rws_load;

-- The newest loaded batch of a family (meta.latestFrom, health's loader.last_commit): one backward index step.
CREATE INDEX ingest_batch_loaded ON ingest_batch (loaded_at);

-- migrate:down

DROP INDEX ingest_batch_loaded;
DROP TABLE publish_dirty;
