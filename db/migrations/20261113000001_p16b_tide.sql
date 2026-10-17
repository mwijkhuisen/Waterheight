-- migrate:up

-- P16b: the astronomical tide and the high and low waters of NL-1 (ADR-lite, ARCHITECTURE §6). Not the P8 run model:
-- that caps a run at 2,000 points (an astronomical payload has 57,600), keeps every monthly re-fetch as an immutable
-- run and lets the earliest fetch win, while a published tide is one curve whose newest fetch wins. Values attach to
-- the registered primary measured H series of the location and datum (no new series rows), so audience and licence
-- follow that series; the readers see the table only through the family's tide view. `kind`: `astro` the
-- astronomical curve, `extreme` the measured high and low waters, `extreme_astro` the astronomical ones; `hilo` is
-- the adapter's high or low label, set exactly for the two extreme kinds. `value` in cm (canonical).
-- ponytail: unpartitioned, about 4 to 5 million rows a year; partition by year once it passes about 50 million.
CREATE TABLE tide (
  series_id int NOT NULL REFERENCES series,
  kind      text NOT NULL CHECK (kind IN ('astro', 'extreme', 'extreme_astro')),
  ts        timestamptz NOT NULL,
  value     real NOT NULL CHECK (value <> 'NaN'::real AND abs(value) <> 'infinity'::real),
  hilo      text CHECK (hilo IN ('high', 'low')),
  -- The ingest_batch that last wrote the row (no foreign key, as obs).
  batch_id  bigint NOT NULL,
  PRIMARY KEY (series_id, kind, ts),
  CHECK ((kind = 'astro') = (hilo IS NULL))
);
-- The loader may add and correct rows (newest fetch wins), never delete them; the API and publish roles read views only.
GRANT SELECT, INSERT, UPDATE ON tide TO rws_load;

-- migrate:down

DROP TABLE tide;
