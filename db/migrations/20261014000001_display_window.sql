-- migrate:up

-- The display window of decision D9 (A§7.5), read by the API and the
-- publishers through the meta view pair (next migration): `display_start` is
-- the earliest instant a visitor may pick (the seeded data from 2026-08-24),
-- `data_epoch` the first production capture, where the web shows a marker. The
-- owner set both on 2026-10-01 (PHASES §16); a change is a new migration.
-- Stored with an explicit offset, so reading them never depends on a session's
-- time zone.
INSERT INTO app_meta (key, value) VALUES
  ('display_start', '"2026-08-24T00:00:00Z"'),
  ('data_epoch', '"2026-10-02T00:00:00Z"');

-- migrate:down

DELETE FROM app_meta WHERE key IN ('display_start', 'data_epoch');
