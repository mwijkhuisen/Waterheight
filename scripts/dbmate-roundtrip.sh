#!/usr/bin/env bash
# dbmate up -> down -> up round trip on a throwaway fixture migration (issue #15
# P0b): proves dbmate against PostgreSQL 18 before P2 writes real migrations.
# It uses its own migrations table and --no-dump-schema (the runner's pg_dump
# may predate 18), and fails unless each step leaves the expected state.
# Usage: DATABASE_URL=postgres://…?sslmode=disable scripts/dbmate-roundtrip.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
dir=$(dirname "$0")/fixtures/dbmate

dbm() { dbmate --no-dump-schema --migrations-dir "$dir" --migrations-table p0b_roundtrip_migrations "$@"; }

# status --exit-code: 0 when every migration is applied, 1 when one is pending.
expect() {
  local want=$1 got=0
  dbm status --exit-code >/dev/null || got=$?
  [[ $got == "$want" ]] || { echo "dbmate-roundtrip: status exit $got, expected $want" >&2; dbm status >&2; exit 1; }
}

dbm up && expect 0
dbm rollback && expect 1
dbm up && expect 0
dbm status
echo "dbmate-roundtrip: up/down/up OK"
