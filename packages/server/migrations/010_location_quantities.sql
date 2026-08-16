-- What each location *reports*, as stated by the WFS
-- locatiesmetlaatstewaarneming layer.
--
-- This is deliberately separate from `series`. The WFS layer knows the
-- (compartiment, grootheid, eenheid) a location publishes and when it last did
-- so, but not the full AquoMetadata that distinguishes one physical stream from
-- another. `series` rows are created when observations are actually fetched and
-- their real metadata is known.
--
-- So: this table drives the map filters and the sidebar on a freshly migrated
-- system with no observations yet; `series` drives coverage and charting.
CREATE TABLE location_quantities (
  location_code text NOT NULL REFERENCES locations (code),
  compartiment  text NOT NULL,
  grootheid     text NOT NULL,
  eenheid       text,
  last_seen_at  timestamptz NOT NULL,
  latest_value  double precision,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_code, compartiment, grootheid)
);

-- "Which locations report WATHTE" backs the sidebar filter.
CREATE INDEX location_quantities_grootheid_idx
  ON location_quantities (grootheid, compartiment);
