-- migrate:up

-- P8a: forecast runs are loaded from the raw archive (PHASES P8a, A§7.4 item 9, A§8 Q2).
--
-- forecast_value: the LU-3 percentiles p30 and p70 keep their names (KG-146: AGE publishes p10, p30, p50, p70 and
-- p90, and none is relabelled). The tables are empty in production until the P8a replay.
ALTER TABLE forecast_value
  ADD COLUMN p30 real,
  ADD COLUMN p70 real;

-- The loader's merge lookup: the stored runs of one series and source that end where the incoming run ends.
CREATE INDEX forecast_run_merge ON forecast_run (series_id, source_id, last_valid);
-- Q2 (A§8): per (series, source) the latest run known as of `asof`, one backward step on this index; its leading
-- columns also serve the loose index scan over the (series, source) pairs.
CREATE INDEX forecast_run_asof ON forecast_run (series_id, source_id, (COALESCE(issued_at, fetched_at)), fetched_at, id);

-- migrate:down

DROP INDEX forecast_run_asof;
DROP INDEX forecast_run_merge;
ALTER TABLE forecast_value
  DROP COLUMN p70,
  DROP COLUMN p30;
