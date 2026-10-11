#!/usr/bin/env bash
# CI only (loadtest.yml): waits (bounded) until /api/v1/health has a non-null loader.lag_p95_s and a generated_at younger
# than 5 minutes, as k6.js requires of every sample. Capture fetches on cron ticks (10-15 min), so the first fetched
# manifest line, and with it a lag, can take ~15 min after the stack is up. As root (the client namespace).
#   wait-health.sh [max seconds, default 1500]
set -euo pipefail
max=${1:-1500}
set -a
# shellcheck source=/dev/null
. /ci/loadtest.env
set +a
end=$((SECONDS + max))
last=''
while ((SECONDS < end)); do
  if body=$(ip netns exec "$RWS_E2E_CLIENT_NETNS" curl -fsS --max-time 15 --cacert "$RWS_E2E_CA" \
    --resolve "$RWS_E2E_DOMAIN:443:$RWS_E2E_CADDY_IP" "https://$RWS_E2E_DOMAIN/api/v1/health"); then
    last=$(jq -c '{status, generated_at, lag: .loader.lag_p95_s, backlog: .loader.backlog_files}' <<<"$body")
    if jq -e '(.loader.lag_p95_s != null) and (.generated_at != null) and ((now - (.generated_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) < 300)' \
      <<<"$body" >/dev/null; then
      echo "health ready: $last"
      exit 0
    fi
  fi
  echo "waiting for a loader lag: ${last:-no answer}"
  sleep 20
done
echo "::error::/api/v1/health has no non-null loader lag with a fresh generated_at after ${max}s (last: ${last:-none}); capture fetched nothing the loader could count"
exit 1
