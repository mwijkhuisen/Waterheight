#!/usr/bin/env bash
# Smoke test of the built server (issue #15 P0b): the api role serves
# GET /healthz -> 200 without any version, and every other role exits non-zero.
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

for role in capture load publish replay watchdog nope; do
  code=0
  node "$main" "$role" >/dev/null 2>&1 || code=$?
  [[ $code -ne 0 ]] || { echo "healthz-smoke: role $role exited 0" >&2; exit 1; }
  echo "role $role -> exit $code"
done
