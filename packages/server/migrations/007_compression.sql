-- @no-transaction
-- Compression delayed to 90 days, comfortably beyond the 60-day correction
-- re-fetch window: recompressing chunks that the rolling re-fetch still needs
-- to rewrite is avoidable friction.
--
-- Segmenting by series_id keeps each series' values contiguous within a chunk,
-- which is exactly how they are read back ("one series over a window").
ALTER TABLE observations SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'series_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy('observations', INTERVAL '90 days');

-- No retention policy: one year of history is the product, so nothing is
-- dropped on a schedule.
