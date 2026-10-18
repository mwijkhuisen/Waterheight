-- migrate:up

-- #174: RWS's own high and low labels of the astronomical extremes of NL-1 (the GETETTPE type series of
-- `nl-1-hwlw-astro`; ADR-lite, ARCHITECTURE §6). A type payload and its heights payload are two archived lines and
-- either may load first, so the labels wait here and the loader applies them to `tide.hilo` (RWS's label first,
-- strict alternation as the fallback). No view and no reader role: nothing outside the loader reads a label, and
-- the public sees it only as `tide.hilo` through the family's tide view. The provider's word is mapped to the enum
-- by the adapter and never stored.
-- ponytail: unpartitioned, about 79 x 1,500 rows a year. The key has no `kind`: a measured type series (#174 item 4)
-- adds one with its own migration.
CREATE TABLE tide_label (
  series_id int NOT NULL REFERENCES series,
  ts        timestamptz NOT NULL,
  hilo      text NOT NULL CHECK (hilo IN ('high', 'low')),
  -- The ingest_batch that last wrote the row (no foreign key, as tide).
  batch_id  bigint NOT NULL,
  PRIMARY KEY (series_id, ts)
);
-- The loader may add and correct labels (newest fetch wins), never delete them; no other role reads them.
GRANT SELECT, INSERT, UPDATE ON tide_label TO rws_load;

-- migrate:down

DROP TABLE tide_label;
