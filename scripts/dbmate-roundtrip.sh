#!/usr/bin/env bash
# dbmate up -> down -> up round trip on a throwaway fixture migration (issue #15
# P0b): proves dbmate against PostgreSQL 18 before P2 writes real migrations.
# It uses its own migrations table and --no-dump-schema (the runner's pg_dump
# may predate 18), and fails unless each step succeeds and leaves the expected
# state. It refuses a non-local database: the fixture must never touch a real one.
# Usage: DATABASE_URL=postgres://…@localhost…?sslmode=disable scripts/dbmate-roundtrip.sh [migrations-dir]
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
if [[ ! $DATABASE_URL =~ ^postgres(ql)?://[^/]*@?(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/ ]]; then
  echo "dbmate-roundtrip: refusing a non-local DATABASE_URL" >&2
  exit 2
fi
dir=${1:-$(dirname "$0")/fixtures/dbmate}

dbm() { dbmate --no-dump-schema --migrations-dir "$dir" --migrations-table p0b_roundtrip_migrations "$@"; }

# status --exit-code: 0 when every migration is applied, 1 when one is pending.
want_status() {
  local want=$1 got=0
  dbm status --exit-code >/dev/null || got=$?
  if [[ $got != "$want" ]]; then
    echo "dbmate-roundtrip: status exit $got, expected $want" >&2
    dbm status >&2 || true
    exit 1
  fi
}

# One statement per step: under set -e a failure on the left of && would not stop the script.
dbm up
want_status 0
dbm rollback
want_status 1
dbm up
want_status 0
dbm status
echo "dbmate-roundtrip: up/down/up OK"
