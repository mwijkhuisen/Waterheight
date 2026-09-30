-- migrate:up

-- Registry tables (A§6), filled only by the registry sync from registry/*.yaml
-- (the `migrate` role, acting as the object owner). The loader reads them and
-- can never change an audience or a channel flag.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Declared in this order on purpose: LEAST() of two audiences is the narrower
-- one (public > owner > off), so a series can narrow its source, never widen it.
CREATE TYPE audience AS ENUM ('off', 'owner', 'public');

CREATE TABLE provider (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]*$'),
  name       text NOT NULL,
  country    text NOT NULL,
  contact    text,
  terms_url  text
);

CREATE TABLE source (
  id                 text PRIMARY KEY CHECK (id ~ '^((NL|DE|BE|FR|LU|CH)-[1-9][0-9]?|CANARY-[A-Z]+)$'),
  provider_id        text NOT NULL REFERENCES provider,
  name               text NOT NULL,
  licence            text,
  licence_kind       text,
  audience           audience NOT NULL,
  permission_ref     text,
  -- {clause, url, retrieved}: catalogue §0.8, verbatim from the registry.
  private_basis      jsonb,
  -- Licence channels (catalogue §0.7).
  lic_display        boolean NOT NULL,
  lic_api            boolean NOT NULL,
  lic_bulk_export    boolean NOT NULL,
  lic_history_export boolean NOT NULL,
  -- The provider's own public window. Rows older than now() - history_window
  -- need lic_history_export; '0' with the flag off hides everything (fail closed).
  -- Hours and smaller only (the registry sync writes hours): a day or month part
  -- would make now() - history_window depend on the session's time zone.
  history_window     interval NOT NULL DEFAULT '0'
                     CHECK (history_window >= '0' AND EXTRACT(YEAR FROM history_window) = 0
                            AND EXTRACT(MONTH FROM history_window) = 0 AND EXTRACT(DAY FROM history_window) = 0),
  capture_enabled    boolean NOT NULL,
  canary             boolean NOT NULL DEFAULT false,
  notes              text,
  CONSTRAINT source_owner_has_private_basis CHECK (
    audience <> 'owner'
    OR (private_basis IS NOT NULL
        AND jsonb_typeof(private_basis) = 'object'
        AND private_basis ?& ARRAY['clause', 'url', 'retrieved'])),
  CONSTRAINT source_private_basis_only_for_owner CHECK (private_basis IS NULL OR audience = 'owner'),
  CONSTRAINT source_owner_no_bulk_export CHECK (audience <> 'owner' OR NOT lic_bulk_export)
);

CREATE TABLE attribution (
  source_id    text NOT NULL REFERENCES source ON DELETE CASCADE,
  -- 0 is the source's attribution text, 1… its variants in registry order.
  ord          int2 NOT NULL CHECK (ord >= 0),
  lang         text CHECK (lang IN ('nl', 'en', 'de', 'fr')),
  text         text NOT NULL,
  url          text,
  needs_date   boolean NOT NULL,
  date_kind    text CHECK (date_kind IN ('retrieval', 'update', 'stand', 'reference')),
  logo_allowed boolean,
  required     boolean NOT NULL,
  PRIMARY KEY (source_id, ord),
  CHECK (needs_date = (date_kind IS NOT NULL))
);

CREATE TABLE river (
  id              text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]*$'),
  names           jsonb NOT NULL DEFAULT '{}',
  osm_relation_id bigint,
  wikidata        text,
  parent_river_id text REFERENCES river,
  confluence_km   real
);

CREATE TABLE reach (
  id                 int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  river_id           text NOT NULL REFERENCES river,
  seq                int NOT NULL,
  up_station_id      text,
  down_station_id    text,
  length_km          real,
  flags              jsonb NOT NULL DEFAULT '{}',
  travel_time_h      numrange,
  travel_time_source text,
  UNIQUE (river_id, seq)
);

CREATE TABLE station (
  id                   text PRIMARY KEY CHECK (id ~ '^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$' AND length(id) <= 80),
  -- Exactly as published by the operating agency: untrusted text, data only.
  name                 text NOT NULL,
  water_name           text,
  country              text NOT NULL CHECK (country IN ('NL', 'DE', 'BE', 'FR', 'LU', 'CH')),
  lon                  double precision CHECK (lon BETWEEN -180 AND 180),
  lat                  double precision CHECK (lat BETWEEN -90 AND 90),
  operator_provider_id text REFERENCES provider,
  river_id             text REFERENCES river,
  reach_id             int REFERENCES reach,
  km_official          real,
  km_system            text,
  km_to_nl_entry       real,
  nl_entry_node        text,
  flags                jsonb NOT NULL DEFAULT '{}',
  tier                 int2 NOT NULL CHECK (tier IN (1, 2)),
  CHECK ((lon IS NULL) = (lat IS NULL))
);

ALTER TABLE reach
  ADD FOREIGN KEY (up_station_id) REFERENCES station,
  ADD FOREIGN KEY (down_station_id) REFERENCES station;

CREATE TABLE station_alias (
  station_id    text NOT NULL REFERENCES station,
  source_id     text NOT NULL REFERENCES source,
  provider_code text NOT NULL,
  role          text NOT NULL CHECK (role IN ('primary', 'twin', 'mirror')),
  precedence    int2 NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, provider_code)
);
CREATE INDEX station_alias_station ON station_alias (station_id);

CREATE TABLE series (
  id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  station_id      text NOT NULL REFERENCES station,
  source_id       text NOT NULL REFERENCES source,
  quantity        text NOT NULL CHECK (quantity IN ('H', 'Q')),
  value_kind      text CHECK (value_kind IN ('stage', 'level')),
  -- The series key inside its source (DE-1: "<station uuid>/<W|Q>").
  provider_key    text NOT NULL,
  -- Declared per series in the registry, never inferred per row (catalogue §4.5).
  native_unit     text NOT NULL,
  to_canonical    double precision NOT NULL CHECK (to_canonical > 0),
  datum           text CHECK (datum IN ('NAP', 'TAW', 'DNG', 'NHN', 'NN', 'IGN69', 'NGF1884', 'LN02', 'NG95', 'LOCAL', 'MSL')),
  native_step     interval NOT NULL CHECK (native_step > '0'),
  expected_step   interval NOT NULL CHECK (expected_step > '0'),
  staleness_limit interval NOT NULL CHECK (staleness_limit > '0'),
  -- May switch a channel of the source off (false); it can never switch one on:
  -- the effective flag is "source flag AND override" (view series_eff).
  lic_override    jsonb,
  -- May narrow the source's audience; a wider value has no effect (LEAST).
  audience        audience,
  role            text NOT NULL CHECK (role IN ('primary', 'twin', 'mirror')),
  active          boolean NOT NULL DEFAULT true,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz,
  UNIQUE (source_id, provider_key),
  CHECK ((quantity = 'Q') = (value_kind IS NULL)),
  CHECK (quantity = 'Q' OR datum IS NOT NULL),
  CONSTRAINT series_lic_override_shape CHECK (
    lic_override IS NULL
    OR (jsonb_typeof(lic_override) = 'object'
        AND lic_override - ARRAY['display', 'api', 'bulk_export', 'history_export'] = '{}'::jsonb
        AND (NOT lic_override ? 'display'        OR jsonb_typeof(lic_override -> 'display') = 'boolean')
        AND (NOT lic_override ? 'api'            OR jsonb_typeof(lic_override -> 'api') = 'boolean')
        AND (NOT lic_override ? 'bulk_export'    OR jsonb_typeof(lic_override -> 'bulk_export') = 'boolean')
        AND (NOT lic_override ? 'history_export' OR jsonb_typeof(lic_override -> 'history_export') = 'boolean')))
);
CREATE INDEX series_station ON series (station_id);

-- A twin pair (registry/twins.yaml from P2b): the twin views need both series
-- to decide a pair's audience.
CREATE TABLE twin (
  id       text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  series_a int NOT NULL REFERENCES series,
  series_b int NOT NULL REFERENCES series,
  relation jsonb NOT NULL DEFAULT '{}',
  CHECK (series_a <> series_b)
);

-- migrate:down

DROP TABLE twin;
DROP TABLE series;
DROP TABLE station_alias;
ALTER TABLE reach DROP CONSTRAINT reach_up_station_id_fkey, DROP CONSTRAINT reach_down_station_id_fkey;
DROP TABLE station;
DROP TABLE reach;
DROP TABLE river;
DROP TABLE attribution;
DROP TABLE source;
DROP TABLE provider;
DROP TYPE audience;
DROP EXTENSION btree_gist;
