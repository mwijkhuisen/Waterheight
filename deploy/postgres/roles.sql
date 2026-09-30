-- The database roles of A§12.2 and the database-level settings. No password is
-- ever written here: rws-lib.sh sets them from /etc/rws/secrets after this
-- file, and the tests set throw-away ones. Idempotent; run as the superuser
-- while connected to the application database (psql -f, or one simple query).
-- Grants on tables, views and functions live in db/migrations.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['rws_owner', 'rws_migrator', 'rws_load', 'rws_publish', 'rws_api', 'rws_owner_api', 'rws_backup']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I', r);
    END IF;
  END LOOP;
END
$$;

-- rws_owner owns every object and never logs in. It is unrelated to rws_owner_api.
ALTER ROLE rws_owner     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE rws_migrator  LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
ALTER ROLE rws_load      LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 6;
ALTER ROLE rws_publish   LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 6;
ALTER ROLE rws_api       LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 12;
ALTER ROLE rws_owner_api LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 4;
ALTER ROLE rws_backup    LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;

-- The migrator acts as the object owner from its first statement, so dbmate's
-- own table and every migrated object belong to rws_owner.
GRANT rws_owner TO rws_migrator WITH INHERIT FALSE, SET TRUE;
ALTER ROLE rws_migrator SET role = 'rws_owner';

-- The readers: read-only sessions, 2 s per statement (A§6, A§9.2).
ALTER ROLE rws_publish   SET default_transaction_read_only = on;
ALTER ROLE rws_publish   SET statement_timeout = '2s';
ALTER ROLE rws_api       SET default_transaction_read_only = on;
ALTER ROLE rws_api       SET statement_timeout = '2s';
ALTER ROLE rws_owner_api SET default_transaction_read_only = on;
ALTER ROLE rws_owner_api SET statement_timeout = '2s';

-- pg_dump: reads everything, writes nothing.
-- rws_backup is NOINHERIT like every role here; this one membership is inherited on purpose.
GRANT pg_read_all_data TO rws_backup WITH INHERIT TRUE;
ALTER ROLE rws_backup SET default_transaction_read_only = on;

DO $$
DECLARE
  db text := pg_catalog.current_database();
BEGIN
  EXECUTE pg_catalog.format('ALTER DATABASE %I OWNER TO rws_owner', db);
  EXECUTE pg_catalog.format('ALTER DATABASE %I SET timezone = %L', db, 'UTC');
  -- No CONNECT and no temporary tables for PUBLIC (a temporary object could
  -- shadow a name inside a SECURITY DEFINER function).
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db);
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO rws_migrator, rws_load, rws_publish, rws_api, rws_owner_api, rws_backup', db);
END
$$;
