-- Locations enter the system only from the WFS locatiesmetlaatstewaarneming
-- layer. Rows are never deleted: a station that goes quiet for maintenance is
-- marked inactive and reappears when it resumes, keeping its history.
CREATE TABLE locations (
  code           text PRIMARY KEY,
  name           text NOT NULL,
  lat            double precision,
  lon            double precision,
  active         boolean NOT NULL DEFAULT false,
  last_seen_at   timestamptz,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The map query is "active locations, optionally within a bbox".
CREATE INDEX locations_active_idx ON locations (active) WHERE active;
CREATE INDEX locations_coords_idx ON locations (lat, lon) WHERE active;
-- Backs the ?q= name search.
CREATE INDEX locations_name_idx ON locations (lower(name) text_pattern_ops);

-- Every activation and deactivation is logged, so a shrinking map can be
-- explained rather than guessed at.
CREATE TABLE location_events (
  id            bigserial PRIMARY KEY,
  location_code text NOT NULL REFERENCES locations (code),
  event         text NOT NULL CHECK (event IN ('activated', 'deactivated', 'created')),
  last_seen_at  timestamptz,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX location_events_code_idx ON location_events (location_code, created_at DESC);
