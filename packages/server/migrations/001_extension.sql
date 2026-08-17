-- TimescaleDB provides the hypertable, continuous aggregates and compression
-- that the observations table depends on. Everything else in this schema is
-- ordinary PostgreSQL.
CREATE EXTENSION IF NOT EXISTS timescaledb;
