-- migrate:up

-- P14f: our own day-of-year climatology (P10_DOY and P90_DOY, written by the `climatology` command as rws_migrator,
-- 730 rows per series with a set). A request reads the rows of ONE day key through the family's reference view, with
-- a literal kind list, so this partial index (the key first, then the series) is what keeps that read small however
-- many series have a set. The CHECK pins the shape of the rows: a day key has one day (season_from_md equals
-- season_to_md, Feb 29 never stored) and the semantics are statistical.
CREATE INDEX reference_value_doy ON reference_value (season_from_md, series_id)
  WHERE kind IN ('P10_DOY', 'P90_DOY');

ALTER TABLE reference_value ADD CONSTRAINT reference_value_doy_shape CHECK (
  kind NOT IN ('P10_DOY', 'P90_DOY')
  OR (season_from_md = season_to_md AND season_from_md <> 229 AND semantics = 'statistical')
);

-- migrate:down

ALTER TABLE reference_value DROP CONSTRAINT reference_value_doy_shape;
DROP INDEX reference_value_doy;
