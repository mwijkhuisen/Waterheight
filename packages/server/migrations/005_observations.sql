-- The observations hypertable. Deliberately narrow: at ~190M rows for one year
-- of active locations, every column here costs ~190M times its width.
--
-- On values and quality codes: Rijkswaterstaat advises storing the raw quality
-- code and filtering at read time, so a change of display policy does not mean
-- re-downloading a year of data. We do that -- quality_code always holds the
-- code exactly as received.
--
-- But code '99' (gap) arrives with a sentinel *value* of 99999, against real
-- readings in the 90-420 range for that same series. Storing 99999 in
-- value_numeric would poison every min/max/mean in the continuous aggregates.
-- So value_numeric is NULL for gaps while value_text keeps the raw payload:
-- nothing is lost, aggregates stay correct, and read-time filtering on
-- quality_code still works.
CREATE TABLE observations (
  series_id     bigint NOT NULL REFERENCES series (id),
  ts            timestamptz NOT NULL,
  -- NULL for gaps and for genuinely non-numeric readings.
  value_numeric double precision,
  -- Waarde_Alfanumeriek is always populated upstream, even for numeric values.
  value_text    text,
  quality_code  text,
  -- 'Ongecontroleerd' until Rijkswaterstaat validates it, then 'Gecontroleerd'.
  status        text,
  -- When we fetched this row, so it is always clear how fresh a slice is.
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, ts)
);

-- 7-day chunks, per the brief. Phase 1's volume numbers (~190M rows/year over
-- ~7,700 series) give roughly 3.6M rows per chunk, which is a reasonable size.
-- Note: this also creates observations_ts_idx on (ts DESC) automatically, which
-- covers "latest across series". Reads are otherwise "one series over a time
-- window", which the primary key already serves, so no further index is needed.
SELECT create_hypertable('observations', by_range('ts', INTERVAL '7 days'));
