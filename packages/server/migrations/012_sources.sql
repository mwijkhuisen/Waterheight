-- Make the data source an explicit dimension.
--
-- Every location in this schema came from Rijkswaterstaat, so "which service
-- published this" was never worth recording. The moment a second service is
-- added it becomes the thing everything else hangs off: two services will use
-- the same station code for different stations (PEGELONLINE and Rijkswaterstaat
-- both publish a LOBITH), they carry different licences and attribution, and
-- they fail independently -- one being down must not deactivate another's
-- stations.
--
-- So `locations.code` stops being the upstream's code and becomes
-- `<source>:<upstream code>`, which is unique by construction. The alternative,
-- a composite (source_id, code) primary key, would push a second column through
-- four foreign keys, every query and every URL for no gain over a separator
-- that no source's own codes contain.

CREATE TABLE sources (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  -- ISO 3166-1 alpha-2. The publisher's country, not the stations' -- German
  -- PEGELONLINE publishes gauges in Switzerland and the Netherlands too.
  country     text NOT NULL,
  -- Rendered in the map's attribution control, which is built from this table
  -- rather than a hard-coded string so a source cannot ship without its credit.
  attribution text NOT NULL,
  licence     text NOT NULL,
  base_url    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seeded here so the foreign keys below have something to point at. The
-- registry in src/sources/registry.ts is the source of truth from then on:
-- `npm run migrate` projects it into this table afterwards, which is why
-- adding a source is a code change rather than another migration.
INSERT INTO sources (id, name, country, attribution, licence, base_url) VALUES (
  'rws',
  'Rijkswaterstaat',
  'NL',
  'Rijkswaterstaat',
  'Rijkswaterstaat open data — https://rijkswaterstaatdata.nl/waterdata/',
  'https://ddapi20-waterwebservices.rijkswaterstaat.nl'
);

-- `series.natural_key` is the join of every dimension that distinguishes one
-- physical stream from another, and its FIRST segment is the location code
-- (see buildNaturalKey and seriesIdentity). Re-keying locations therefore
-- re-keys it too -- and getting this wrong is silent: the next ingest would
-- fail to match the existing row, insert a duplicate series, and split one
-- station's history across two ids with no error anywhere.
--
-- Assert the invariant before relying on it rather than trusting the comment.
DO $$
DECLARE mismatched bigint;
BEGIN
  SELECT count(*) INTO mismatched
    FROM series WHERE split_part(natural_key, '|', 1) <> location_code;
  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'series.natural_key does not begin with location_code for % row(s), so '
      're-keying it by prefix is unsafe. Rebuild the keys from seriesIdentity '
      'before applying this migration.', mismatched;
  END IF;
END $$;

-- With the location code as the first segment, prefixing the whole key is
-- exactly prefixing that segment. Runs before the code itself changes, while
-- the assertion above still holds.
UPDATE series SET natural_key = 'rws:' || natural_key;

ALTER TABLE locations
  ADD COLUMN source_id   text REFERENCES sources (id),
  -- The code in the source's own namespace, kept verbatim so a request can be
  -- built for the upstream without having to strip a prefix back off.
  ADD COLUMN source_code text;

UPDATE locations SET source_id = 'rws', source_code = code;

ALTER TABLE locations
  ALTER COLUMN source_id   SET NOT NULL,
  ALTER COLUMN source_code SET NOT NULL,
  ADD CONSTRAINT locations_source_key UNIQUE (source_id, source_code);

-- The re-key below is one UPDATE on `locations`; these carry it to everything
-- that references it. Without ON UPDATE CASCADE each dependant would have to be
-- rewritten by hand in dependency order with the constraints dropped meanwhile,
-- which is the same operation with more ways to get it wrong.
ALTER TABLE location_events
  DROP CONSTRAINT location_events_location_code_fkey,
  ADD CONSTRAINT location_events_location_code_fkey
    FOREIGN KEY (location_code) REFERENCES locations (code) ON UPDATE CASCADE;

ALTER TABLE series
  DROP CONSTRAINT series_location_code_fkey,
  ADD CONSTRAINT series_location_code_fkey
    FOREIGN KEY (location_code) REFERENCES locations (code) ON UPDATE CASCADE;

ALTER TABLE location_quantities
  DROP CONSTRAINT location_quantities_location_code_fkey,
  ADD CONSTRAINT location_quantities_location_code_fkey
    FOREIGN KEY (location_code) REFERENCES locations (code) ON UPDATE CASCADE;

ALTER TABLE backfill_jobs
  DROP CONSTRAINT backfill_jobs_location_code_fkey,
  ADD CONSTRAINT backfill_jobs_location_code_fkey
    FOREIGN KEY (location_code) REFERENCES locations (code) ON UPDATE CASCADE;

UPDATE locations SET code = source_id || ':' || source_code;

-- Belt and braces: the application composes the code, and this makes it
-- impossible for a row to disagree with its own source columns regardless.
ALTER TABLE locations
  ADD CONSTRAINT locations_code_matches_source
    CHECK (code = source_id || ':' || source_code);

-- Refresh bookkeeping becomes per-source for the same reason as everything
-- else: `/api/health` reporting "locations refreshed 3 hours ago" has to mean
-- a particular source's locations once there is more than one, and a source
-- that has never been refreshed must be distinguishable from one that failed.
ALTER TABLE refresh_state ADD COLUMN source_id text REFERENCES sources (id);
UPDATE refresh_state SET source_id = 'rws';
ALTER TABLE refresh_state
  ALTER COLUMN source_id SET NOT NULL,
  DROP CONSTRAINT refresh_state_pkey,
  ADD PRIMARY KEY (source_id, name);
