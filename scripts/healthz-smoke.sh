#!/usr/bin/env bash
# Smoke test of the built server (issue #15 P0b; #16 P1a): the api role serves
# GET /healthz -> 200 without any version; `capture --dry-run` loads every spec
# offline and exits 0, and so does `watchdog --dry-run`; every other role exits
# non-zero here (capture and watchdog without RWS_DOMAIN/RWS_CONTACT_EMAIL
# exactly 78, healthcheck without a heartbeat 1).
# Usage: scripts/healthz-smoke.sh   (after `pnpm build`; uses a free local port)
set -euo pipefail

main=apps/server/dist/main.js
[[ -f $main ]] || { echo "healthz-smoke: $main missing; run pnpm build first" >&2; exit 1; }

port=${SMOKE_PORT:-18080}
log=$(mktemp)
HOST=127.0.0.1 PORT=$port node "$main" api >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -f "$log"' EXIT

body=
for _ in $(seq 1 50); do
  if body=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null); then break; fi
  sleep 0.1
done
[[ $body == '{"status":"ok"}' ]] || { echo "healthz-smoke: unexpected body: ${body:-<none>}" >&2; cat "$log" >&2; exit 1; }
echo "GET /healthz -> 200 $body"

headers=$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$port/healthz")
if grep -qiE 'server:|x-powered-by|version' <<<"$headers"; then
  echo "healthz-smoke: a response header leaks the server or a version:" >&2
  echo "$headers" >&2
  exit 1
fi

dry=$(env -u RWS_DOMAIN -u RWS_CONTACT_EMAIL node "$main" capture --dry-run)
grep -q 'RWS requests/hour' <<<"$dry" || { echo "healthz-smoke: capture --dry-run printed no budget" >&2; exit 1; }
echo "capture --dry-run -> exit 0 ($(tail -n 1 <<<"$dry"))"

checks=$(env -u RWS_DOMAIN -u RWS_CONTACT_EMAIL node "$main" watchdog --dry-run 2>&1)
grep -q '^cert: ' <<<"$checks" || { echo "healthz-smoke: watchdog --dry-run listed no checks" >&2; exit 1; }
echo "watchdog --dry-run -> exit 0 ($(wc -l <<<"$checks") checks)"

# Never a live recorder, watchdog or loader: without the contact variables (capture, watchdog) or the
# database settings (load, migrate) they exit 78; the timeout is a backstop.
for role in capture load migrate publish replay watchdog nope; do
  code=0
  env -u RWS_DOMAIN -u RWS_CONTACT_EMAIL -u DATABASE_URL -u RWS_DB_HOST timeout 10 node "$main" "$role" >/dev/null 2>&1 || code=$?
  [[ $code -ne 0 ]] || { echo "healthz-smoke: role $role exited 0" >&2; exit 1; }
  # These must refuse to start (78): any other code, the timeout's 124 included, may be a live role.
  if [[ $role == capture || $role == watchdog || $role == load || $role == migrate ]] && [[ $code -ne 78 ]]; then
    echo "healthz-smoke: role $role exited $code, not 78" >&2
    exit 1
  fi
  echo "role $role -> exit $code"
done
