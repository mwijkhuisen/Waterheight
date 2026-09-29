-- Throwaway fixture for scripts/dbmate-roundtrip.sh. It is not a schema
-- migration: db/migrations/ stays empty until P2.

-- migrate:up
create table p0b_roundtrip (id int primary key, valid tstzrange not null);

-- migrate:down
drop table p0b_roundtrip;
