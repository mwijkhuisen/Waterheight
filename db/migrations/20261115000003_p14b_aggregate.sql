-- migrate:up

-- P14b: a provider's own aggregate over the series' expected_step (FR-2 QmnJ the daily mean, HIXnJ the daily
-- maximum), stamped at the interval start in UTC; NULL is an instantaneous series. An aggregate is never a primary
-- series, so no reader view (they all take role primary), state or forecast can serve it; the loader keeps it out of
-- obs_1h and obs_1d (a rollup of daily means is not a rollup of the river).
ALTER TABLE series
  ADD COLUMN aggregate text CONSTRAINT series_aggregate_check CHECK (aggregate IN ('mean', 'max', 'min')),
  ADD CONSTRAINT series_aggregate_not_primary CHECK (aggregate IS NULL OR role <> 'primary');

-- migrate:down

ALTER TABLE series DROP CONSTRAINT series_aggregate_not_primary;
ALTER TABLE series DROP COLUMN aggregate;
