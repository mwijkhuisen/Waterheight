-- Negative fixture for scripts/dbmate-roundtrip.sh: this migration cannot apply,
-- so the round trip must fail (CI step "a broken migration fails the round trip").

-- migrate:up
create tabel p0b_broken (id int);

-- migrate:down
drop table if exists p0b_broken;
