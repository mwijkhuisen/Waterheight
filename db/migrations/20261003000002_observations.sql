-- migrate:up

-- Observations (A§6). H is cm and Q is m³/s, as `real`; ts is UTC. Monthly
-- range partitions, created only by ensure_partitions(): there is NO default
-- partition, so a row outside the partition horizon fails loudly.

CREATE TABLE obs (
  series_id int NOT NULL REFERENCES series,
  ts        timestamptz NOT NULL,
  value     real NOT NULL CHECK (value <> 'NaN'::real AND abs(value) <> 'infinity'::real),
  qc        int2 NOT NULL DEFAULT 0 CHECK (qc BETWEEN 0 AND 1023),
  -- The ingest_batch that last wrote the row (no foreign key on the hot path).
  batch_id  bigint NOT NULL,
  PRIMARY KEY (series_id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX obs_ts_brin ON obs USING brin (ts);

CREATE TABLE obs_latest (
  series_id int PRIMARY KEY REFERENCES series,
  ts        timestamptz NOT NULL,
  value     real NOT NULL,
  qc        int2 NOT NULL,
  batch_id  bigint NOT NULL
);

-- One row whenever a stored value or its qc changes (A§7.4 step 4).
CREATE TABLE obs_revision (
  series_id  int NOT NULL REFERENCES series,
  ts         timestamptz NOT NULL,
  old_value  real NOT NULL,
  new_value  real NOT NULL,
  old_qc     int2 NOT NULL,
  new_qc     int2 NOT NULL,
  batch_id   bigint NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX obs_revision_series_ts ON obs_revision (series_id, ts);

-- Rollups on UTC buckets (date_bin with origin 2000-01-01Z), kept by the
-- loader in the same transaction as the rows they summarise.
CREATE TABLE obs_1h (
  series_id int NOT NULL REFERENCES series,
  bucket    timestamptz NOT NULL,
  vmin      real NOT NULL,
  vmax      real NOT NULL,
  vavg      real NOT NULL,
  vlast     real NOT NULL,
  n         int NOT NULL CHECK (n > 0),
  qc_or     int2 NOT NULL,
  PRIMARY KEY (series_id, bucket)
);
CREATE INDEX obs_1h_bucket ON obs_1h (bucket);

CREATE TABLE obs_1d (LIKE obs_1h INCLUDING ALL);
ALTER TABLE obs_1d ADD FOREIGN KEY (series_id) REFERENCES series;

CREATE TABLE gauge_zero (
  series_id int NOT NULL REFERENCES series,
  value_m   double precision NOT NULL,
  datum     text NOT NULL CHECK (datum IN ('NAP', 'TAW', 'DNG', 'NHN', 'NN', 'IGN69', 'NGF1884', 'LN02', 'NG95', 'LOCAL', 'MSL')),
  valid     tstzrange NOT NULL CHECK (NOT isempty(valid)),
  batch_id  bigint NOT NULL,
  PRIMARY KEY (series_id, valid WITHOUT OVERLAPS)
);

-- migrate:down

DROP TABLE gauge_zero;
DROP TABLE obs_1d;
DROP TABLE obs_1h;
DROP TABLE obs_revision;
DROP TABLE obs_latest;
DROP TABLE obs;
