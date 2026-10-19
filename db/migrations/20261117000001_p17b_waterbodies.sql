-- migrate:up

-- P17b: water bodies (lakes, closed estuaries, estuaries, sea), written by the registry sync in `migrate` from
-- registry/waterbodies.yaml. A station's body is the generated registry/rivernet.yaml's, never a station row's.
-- The reference gauge of a body is not stored (it would be a circular reference): the yaml and the reaches file hold it.
CREATE TABLE waterbody (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]*$'),
  kind          text NOT NULL CHECK (kind IN ('lake', 'closed_estuary', 'estuary', 'sea')),
  name_nl       text NOT NULL,
  name_en       text NOT NULL,
  names         jsonb NOT NULL DEFAULT '{}',
  wikidata      text NOT NULL,
  managed_level boolean NOT NULL
);

ALTER TABLE station ADD COLUMN waterbody_id text REFERENCES waterbody;

-- migrate:down

ALTER TABLE station DROP COLUMN waterbody_id;
DROP TABLE waterbody;
