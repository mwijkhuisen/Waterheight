-- @no-transaction
-- Continuous aggregates cannot be created inside a transaction block.
--
-- Both rollups are built directly from `observations` rather than stacking
-- daily on top of hourly. Stacking would be cheaper to refresh, but avg() of
-- avg() is only correct when weighted by each bucket's count, and getting that
-- subtly wrong is a silent data bug. At this volume the extra refresh cost is
-- the better trade.
--
-- Gaps (quality code '99') carry a 99999 sentinel that migration 005 stores as
-- a NULL value_numeric, so min/max/avg skip them automatically. count() is over
-- value_numeric, not *, so it reports real readings rather than row count.
CREATE MATERIALIZED VIEW observations_hourly
WITH (timescaledb.continuous) AS
SELECT
  series_id,
  time_bucket(INTERVAL '1 hour', ts) AS bucket,
  min(value_numeric)   AS min_value,
  max(value_numeric)   AS max_value,
  avg(value_numeric)   AS mean_value,
  count(value_numeric) AS point_count
FROM observations
GROUP BY series_id, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW observations_daily
WITH (timescaledb.continuous) AS
SELECT
  series_id,
  time_bucket(INTERVAL '1 day', ts) AS bucket,
  min(value_numeric)   AS min_value,
  max(value_numeric)   AS max_value,
  avg(value_numeric)   AS mean_value,
  count(value_numeric) AS point_count
FROM observations
GROUP BY series_id, bucket
WITH NO DATA;

-- Refresh policies. end_offset keeps the most recent window out of the
-- materialised set so in-flight ingest does not fight the refresh; the API
-- falls back to raw rows for those, which is what short windows use anyway.
SELECT add_continuous_aggregate_policy('observations_hourly',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');

SELECT add_continuous_aggregate_policy('observations_daily',
  start_offset => INTERVAL '30 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour');
