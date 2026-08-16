-- A series is one physically distinct measurement stream at a location.
--
-- Crucially, (location, quantity) is NOT one series: the same quantity at the
-- same location fans out ~2.2x into streams that differ by instrument,
-- sampling height, sampling method and so on. Phase 1 measured a12 returning
-- 50 series from 19 quantity pairs, and ijgeul.1 returning 131 from 16.
-- Keying observations on (location, quantity, timestamp, proces_type) would
-- silently collapse those into one another and lose data.
--
-- So each distinct AquoMetadata combination gets a synthetic id, and the
-- observations hypertable references only that id. This keeps the hypertable
-- narrow (the dimensions are stored once here, not on all ~190M rows) while
-- keeping the uniqueness constraint honest.
CREATE TABLE series (
  id                 bigserial PRIMARY KEY,
  location_code      text NOT NULL REFERENCES locations (code),

  -- The dimensions a user actually filters and charts on.
  compartiment       text NOT NULL,
  grootheid          text NOT NULL,
  eenheid            text,
  parameter          text,
  proces_type        text NOT NULL,

  -- The dimensions that distinguish sibling series of the same quantity.
  hoedanigheid              text,
  typering                  text,
  orgaan                    text,
  biotaxon                  text,
  groepering                text,
  bemonstering_apparaat     text,
  bemonstering_methode      text,
  bemonstering_soort        text,
  meetapparaat              text,
  waardebepaling_methode    text,
  waardebepaling_techniek   text,
  waardebewerking_methode   text,
  -- From WaarnemingMetadata rather than AquoMetadata, but still identifying.
  bemonsteringshoogte       text,
  referentievlak            text,
  opdrachtgevende_instantie text,

  description        text,

  -- Canonical join of every dimension above. Upserts conflict on this, which
  -- avoids a 20-column ON CONFLICT target and an unwieldy composite index.
  natural_key        text NOT NULL UNIQUE,

  -- Denormalised coverage, maintained by the ingester so the detail endpoint
  -- does not have to scan the hypertable per series on every page load.
  first_observed_at  timestamptz,
  last_observed_at   timestamptz,
  point_count        bigint NOT NULL DEFAULT 0,
  backfilled_at      timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- "All series at this location" drives the detail panel.
CREATE INDEX series_location_idx ON series (location_code);
-- "Which locations report WATHTE" drives the sidebar filters.
CREATE INDEX series_grootheid_idx ON series (grootheid, compartiment);
