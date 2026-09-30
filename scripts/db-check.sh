#!/usr/bin/env bash
# Database checks of CI (issue #17), on a throw-away local PostgreSQL 18:
#   1. dbmate migrate → rollback of every migration → migrate, as rws_migrator
#      (the production path: roles.sql first, objects owned by rws_owner);
#   2. the committed db/schema.sql, the generated views migration and the
#      Kysely types equal what the migrations produce.
# DATABASE_URL is a superuser of that cluster. dbmate is on PATH. pg_dump 18 is
# on PATH, or DB_CHECK_PG_DUMP names a command that runs it (CI: inside the
# service container). `--write` rewrites the generated files instead of
# comparing them.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
if [[ ! $DATABASE_URL =~ ^postgres(ql)?://[^/]*@?(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/ ]]; then
  echo "db-check: refusing a non-local DATABASE_URL" >&2
  exit 2
fi
write=0
[[ ${1:-} == --write ]] && write=1
cd "$(dirname "$0")/.."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [[ -n ${DB_CHECK_PG_DUMP:-} ]]; then
  # dbmate calls `pg_dump` from PATH; the words of DB_CHECK_PG_DUMP come from the workflow, not from data.
  printf '#!/bin/sh\nexec %s "$@"\n' "$DB_CHECK_PG_DUMP" >"$work/pg_dump"
  chmod +x "$work/pg_dump"
  PATH=$work:$PATH
fi

admin_url=$DATABASE_URL
migrator_url=$(node apps/server/test/db/prepare.ts rws_check)
dbm() { DATABASE_URL=$migrator_url dbmate --migrations-dir db/migrations "$@"; }

count=$(find db/migrations -name '*.sql' | wc -l)
dbm --no-dump-schema migrate >/dev/null
for _ in $(seq "$count"); do dbm --no-dump-schema rollback >/dev/null; done
if dbm --no-dump-schema status --exit-code >/dev/null 2>&1; then
  echo "db-check: FAIL: migrations still applied after $count rollbacks" >&2
  exit 1
fi
dbm --no-dump-schema migrate >/dev/null
dbm --no-dump-schema status --exit-code >/dev/null
echo "db-check: migrate → $count × rollback → migrate: OK"

# pg_dump 17.6+ writes a random \restrict key: drop both lines so the file is reproducible.
dbm --schema-file "$work/schema.sql" dump >/dev/null
grep -v -E '^\\(un)?restrict ' "$work/schema.sql" >"$work/schema.clean.sql"

node scripts/gen-views.ts --check
checked_url=$(sed -E 's#/[^/?]+(\?|$)#/rws_check\1#' <<<"$admin_url")
DATABASE_URL=$checked_url apps/server/node_modules/.bin/kysely-codegen --dialect postgres --log-level error \
  --type-mapping '{"interval":"string"}' --exclude-pattern '{pub_*,own_*,series_eff,schema_migrations}' \
  --out-file "$work/generated.ts" >/dev/null

if ((write)); then
  cp "$work/schema.clean.sql" db/schema.sql
  cp "$work/generated.ts" apps/server/src/db/generated.ts
  echo "db-check: wrote db/schema.sql and apps/server/src/db/generated.ts"
  exit 0
fi
rc=0
diff -u db/schema.sql "$work/schema.clean.sql" >&2 || { echo "db-check: FAIL: db/schema.sql is stale (scripts/db-check.sh --write)" >&2; rc=1; }
diff -u apps/server/src/db/generated.ts "$work/generated.ts" >&2 || { echo "db-check: FAIL: generated.ts is stale (scripts/db-check.sh --write)" >&2; rc=1; }
((rc == 0)) && echo "db-check: schema.sql, the views migration and the generated types are current: OK"
exit "$rc"
