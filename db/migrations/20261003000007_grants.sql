-- migrate:up

-- Privileges (A§12.2). Roles are created by deploy/postgres/roles.sql; every
-- object belongs to rws_owner (NOLOGIN). No login role reads a base table
-- except the loader (its own tables) and rws_backup (pg_read_all_data). The
-- view grants to the readers are in the views migration.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rws_load, rws_publish, rws_api, rws_owner_api;

-- Nothing created later is open by default: functions lose PUBLIC's EXECUTE
-- (a per-schema default cannot revoke it, so this is the global default of
-- rws_owner), tables and sequences never had one.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;

REVOKE ALL ON FUNCTION ensure_partitions(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_partitions(timestamptz, timestamptz) TO rws_load, rws_migrator;

-- The loader. It parses hostile payloads, so it may only READ the registry
-- tables: it can never change an audience, a channel flag or a private_basis.
GRANT SELECT ON provider, source, attribution, river, reach, station, station_alias, series, twin TO rws_load;

-- Its own data: no DELETE anywhere, no TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON
  obs, obs_latest, obs_1h, obs_1d, gauge_zero,
  reference_value, class_obs, forecast_run, forecast_value, warning_area,
  ingest_batch, load_cursor, source_health, twin_check, app_meta
  TO rws_load;
-- The revision log is append-only.
GRANT SELECT, INSERT ON obs_revision TO rws_load;
GRANT USAGE ON SEQUENCE ingest_batch_id_seq, forecast_run_id_seq, warning_area_id_seq TO rws_load;

-- migrate:down

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rws_load;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rws_load;
REVOKE ALL ON FUNCTION ensure_partitions(timestamptz, timestamptz) FROM rws_load, rws_migrator;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
REVOKE USAGE ON SCHEMA public FROM rws_load, rws_publish, rws_api, rws_owner_api;
GRANT USAGE ON SCHEMA public TO PUBLIC;
