-- The database roles of A§12.2 and the database-level settings. No password is
-- ever written here: rws-lib.sh sets them from /etc/rws/secrets after this
-- file, and the tests set throw-away ones. Idempotent; run as the superuser
-- while connected to the application database (psql -f, or one simple query).
-- Grants on tables, views and functions live in db/migrations.

-- A login role may change its own defaults (ALTER ROLE <self> [IN DATABASE ...]
-- SET), and they would outlive a redeploy: every role-wide and per-database
-- setting of every application role is cleared here and set again below.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['rws_owner', 'rws_migrator', 'rws_load', 'rws_publish', 'rws_api', 'rws_owner_api', 'rws_backup']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I', r);
    END IF;
    EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL', r);
    EXECUTE pg_catalog.format('ALTER ROLE %I IN DATABASE %I RESET ALL', r, pg_catalog.current_database());
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

-- The readers: read-only sessions, 2 s per statement (A§6, A§9.2). Both are
-- session defaults, which a session can change: the grants (views only), the
-- connection limits, the revoked large-object, WAL-message and advisory-lock
-- functions and plpgsql below and temp_file_limit are what hold against a
-- hostile reader session.
ALTER ROLE rws_publish   SET default_transaction_read_only = on;
ALTER ROLE rws_publish   SET statement_timeout = '2s';
ALTER ROLE rws_api       SET default_transaction_read_only = on;
ALTER ROLE rws_api       SET statement_timeout = '2s';
ALTER ROLE rws_owner_api SET default_transaction_read_only = on;
ALTER ROLE rws_owner_api SET statement_timeout = '2s';
-- A superuser-only setting, set here by the superuser: a reader session cannot
-- raise it. Q1 (an index step per series) and the health queries write no
-- temporary file at all; a session that sorts a whole table cannot fill the disk.
ALTER ROLE rws_publish   SET temp_file_limit = '256MB';
ALTER ROLE rws_api       SET temp_file_limit = '256MB';
ALTER ROLE rws_owner_api SET temp_file_limit = '256MB';

-- Nothing of ours is a large object. No application role may create, open or
-- write one (a stray one would also fail the nightly dump). Function privileges
-- belong to each database: this file runs connected to the application database.
REVOKE EXECUTE ON FUNCTION
  pg_catalog.lo_create(oid), pg_catalog.lo_creat(integer), pg_catalog.lo_from_bytea(oid, bytea),
  pg_catalog.lo_put(oid, bigint, bytea), pg_catalog.lo_open(oid, integer), pg_catalog.lowrite(integer, bytea),
  pg_catalog.lo_truncate(integer, integer), pg_catalog.lo_truncate64(integer, bigint), pg_catalog.lo_unlink(oid),
  pg_catalog.lo_import(text), pg_catalog.lo_import(text, oid)
  FROM PUBLIC;
-- Nor may one write WAL through a logical-decoding message (a read-only
-- session still could). NOTIFY is bounded by the server's max_notify_queue_pages
-- (deploy/compose.yaml).
REVOKE EXECUTE ON FUNCTION
  pg_catalog.pg_logical_emit_message(boolean, text, text, boolean),
  pg_catalog.pg_logical_emit_message(boolean, text, bytea, boolean)
  FROM PUBLIC;
-- No DO block (review R3-3): one statement whose inner statements each take a
-- new snapshot while statement_timestamp() stands still. The migrations create
-- ensure_partitions as rws_owner; calling a function needs no language privilege.
REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC;
GRANT USAGE ON LANGUAGE plpgsql TO rws_owner;
-- Nor an advisory lock, of which nothing of ours takes any (review R3-4): a
-- session could fill the shared lock table. Every signature this server has.
DO $$
DECLARE
  f pg_catalog.regprocedure;
BEGIN
  FOR f IN SELECT p.oid FROM pg_catalog.pg_proc p
           WHERE p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
             AND (p.proname LIKE 'pg\_advisory\_%' OR p.proname LIKE 'pg\_try\_advisory\_%')
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;

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
