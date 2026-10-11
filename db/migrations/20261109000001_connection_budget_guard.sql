-- P12a (issue #27): the connection budget guard. It changes nothing. deploy/postgres/roles.sql stays authoritative for
-- the per-role CONNECTION LIMITs (rws_migrator cannot ALTER ROLE); this fails the migration when the limits no longer
-- fit max_connections (db service, deploy/compose.yaml): the public api, the largest pool, must never be able to
-- starve the loader, the publishers and the owner api, and 5 connections stay free for superuser, backup and
-- migrator. A role with no limit (-1) or no row is a failure too.

-- migrate:up
DO $$
DECLARE
  max_conn int := current_setting('max_connections')::int;
  margin constant int := 5;
  lim jsonb;
  r text;
  reserved int := 0;
BEGIN
  SELECT coalesce(jsonb_object_agg(rolname, rolconnlimit), '{}')
    INTO lim
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('rws_api', 'rws_load', 'rws_publish', 'rws_owner_api');
  FOREACH r IN ARRAY ARRAY['rws_api', 'rws_load', 'rws_publish', 'rws_owner_api'] LOOP
    IF coalesce((lim ->> r)::int, -1) < 0 THEN
      RAISE EXCEPTION 'connection budget: role % has no CONNECTION LIMIT (deploy/postgres/roles.sql)', r;
    END IF;
  END LOOP;
  reserved := (lim ->> 'rws_load')::int + (lim ->> 'rws_publish')::int + (lim ->> 'rws_owner_api')::int;
  IF (lim ->> 'rws_api')::int > max_conn - reserved - margin THEN
    RAISE EXCEPTION 'connection budget: rws_api limit % > max_connections % - load/publish/owner_api % - margin %',
      lim ->> 'rws_api', max_conn, reserved, margin;
  END IF;
END
$$;

-- migrate:down
