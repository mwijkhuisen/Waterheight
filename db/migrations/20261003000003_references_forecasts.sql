-- migrate:up

-- References, provider classes, forecasts and warnings (A§6). P2a creates the
-- tables; P2b (NL-4), P7 and P8 fill them. Every row names the source that
-- published it (source_id): its audience gates the row in the views.

CREATE TABLE reference_value (
  series_id             int NOT NULL REFERENCES series,
  -- The publisher of the threshold (e.g. LU-4 on an LU-1 series).
  source_id             text NOT NULL REFERENCES source,
  kind                  text NOT NULL CHECK (kind ~ '^[A-Z0-9_]{1,40}$'),
  value                 real NOT NULL,
  unit                  text NOT NULL,
  semantics             text NOT NULL CHECK (semantics IN ('operational', 'statistical', 'historical', 'provider_class')),
  percentile_convention text CHECK (percentile_convention IN ('exceedance', 'non_exceedance')),
  period                daterange,
  -- A recurring MMDD window (NL-4 seasonal rows); it wraps the year when
  -- season_from_md > season_to_md. 101–1231 is the whole year.
  season_from_md        int2 NOT NULL DEFAULT 101,
  season_to_md          int2 NOT NULL DEFAULT 1231,
  -- NL-4 Priority: the lower number wins where two rows apply.
  priority              int2 NOT NULL DEFAULT 0,
  basis_label           text,
  valid                 tstzrange NOT NULL CHECK (NOT isempty(valid)),
  batch_id              bigint,
  PRIMARY KEY (series_id, source_id, kind, season_from_md, season_to_md, priority, valid WITHOUT OVERLAPS),
  CONSTRAINT reference_value_season_from CHECK (
    season_from_md / 100 BETWEEN 1 AND 12
    AND season_from_md % 100 BETWEEN 1 AND
        CASE WHEN season_from_md / 100 = 2 THEN 29 WHEN season_from_md / 100 IN (4, 6, 9, 11) THEN 30 ELSE 31 END),
  CONSTRAINT reference_value_season_to CHECK (
    season_to_md / 100 BETWEEN 1 AND 12
    AND season_to_md % 100 BETWEEN 1 AND
        CASE WHEN season_to_md / 100 = 2 THEN 29 WHEN season_to_md / 100 IN (4, 6, 9, 11) THEN 30 ELSE 31 END)
);

-- Provider classes, stored on change only.
CREATE TABLE class_obs (
  subject_type   text NOT NULL CHECK (subject_type IN ('station', 'area')),
  subject_id     text NOT NULL,
  ts             timestamptz NOT NULL,
  source_id      text NOT NULL REFERENCES source,
  provider_code  text,
  provider_label text,
  level_norm     int2,
  batch_id       bigint,
  PRIMARY KEY (subject_type, subject_id, source_id, ts)
);

-- Forecasts are bi-temporal: issue time × valid time (ADR-0010).
CREATE TABLE forecast_run (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id            int NOT NULL REFERENCES series,
  source_id            text NOT NULL REFERENCES source,
  issued_at            timestamptz,
  issued_inferred      boolean NOT NULL DEFAULT false,
  first_valid          timestamptz NOT NULL,
  last_valid           timestamptz NOT NULL,
  fetched_at           timestamptz NOT NULL,
  content_hash         bytea NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('deterministic', 'quantiles', 'ensemble_summary')),
  step                 interval,
  provider_segment_end timestamptz,
  batch_id             bigint,
  UNIQUE (series_id, first_valid, content_hash),
  CHECK (last_valid >= first_valid)
);
CREATE INDEX forecast_run_source ON forecast_run (source_id);

CREATE TABLE forecast_value (
  run_id   bigint NOT NULL REFERENCES forecast_run ON DELETE CASCADE,
  valid_ts timestamptz NOT NULL,
  value    real,
  p05      real,
  p10      real,
  p25      real,
  p50      real,
  p75      real,
  p90      real,
  p95      real,
  vmin     real,
  vmax     real,
  -- estimate · below_floor · censored
  flags    int2 NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, valid_ts)
) PARTITION BY RANGE (valid_ts);

CREATE TABLE warning_area (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        text NOT NULL REFERENCES source,
  area_key         text NOT NULL,
  name             text,
  geometry_geojson text,
  level_norm       int2 CHECK (level_norm BETWEEN 1 AND 5),
  level_raw        text,
  label_raw        text,
  valid            tstzrange NOT NULL CHECK (NOT isempty(valid)),
  issued_at        timestamptz,
  batch_id         bigint
);
CREATE INDEX warning_area_source_valid ON warning_area USING gist (source_id, valid);

-- migrate:down

DROP TABLE warning_area;
DROP TABLE forecast_value;
DROP TABLE forecast_run;
DROP TABLE class_obs;
DROP TABLE reference_value;
