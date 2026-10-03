-- migrate:up

-- P8a review SEC-3: a forecast run is immutable, and the grants say so, not only the loader's code. rws_load keeps
-- INSERT on both tables (it adds runs and the leading points of an extended run) and loses UPDATE on forecast_value
-- altogether; on forecast_run it may update only the four columns of its two updates (A§7.4 item 9): lowering
-- fetched_at and an inferred issued_at to an earlier capture of the same run, and, for a head-dropping source,
-- first_valid and content_hash of an extended run. The monthly partitions of forecast_value carry no grant of their
-- own (ensure_partitions creates them under rws_owner's defaults), so they are reached through the parent only.
REVOKE UPDATE ON forecast_value FROM rws_load;
REVOKE UPDATE ON forecast_run FROM rws_load;
GRANT UPDATE (fetched_at, issued_at, first_valid, content_hash) ON forecast_run TO rws_load;

-- migrate:down

REVOKE UPDATE (fetched_at, issued_at, first_valid, content_hash) ON forecast_run FROM rws_load;
GRANT UPDATE ON forecast_run TO rws_load;
GRANT UPDATE ON forecast_value TO rws_load;
