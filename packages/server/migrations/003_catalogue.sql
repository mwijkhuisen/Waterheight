-- Aquo code lists from OphalenCatalogus (grootheden, compartimenten, eenheden,
-- parameters, ...). One table rather than one per domain: they all have the
-- same shape and are only ever read as lookups.
CREATE TABLE aquo_codes (
  domain      text NOT NULL,
  code        text NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, code)
);

-- Single-row bookkeeping for scheduled refreshes, so /api/health can report
-- cache age without guessing.
CREATE TABLE refresh_state (
  name          text PRIMARY KEY,
  refreshed_at  timestamptz,
  succeeded     boolean,
  detail        jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
