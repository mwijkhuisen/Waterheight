#!/usr/bin/env bash
# CI only (P12a, issue #27; .github/workflows/loadtest.yml, job drill): the driver of the flood drill, run as root after
# deploy/tests/e2e/run.sh in RWS_E2E_MODE=drill, with the stack running (that run.sh wrote /ci/e2e-stack and
# /ci/loadtest.env and left the stack up). The k6 flood scenario runs beside it, started by the workflow; this proves the
# flood-drill criterion of the issue on the same stack, with PROOF lines:
#   1. every public primary series has recent synthetic observations (scripts/seed-loadtest.ts, idempotent): a series
#      appears in latest.json only with a value, and a flood-day visitor sees the states of series that have one;
#   2. scripts/flood-drill replays the flood fixtures, shifted to the drill clock, into the raw archive (main phase);
#   3. the loader reads them, the publishers render them, Caddy serves them: the Vigicrues and AGE areas are in
#      warnings/latest.geojson, fetched from outside like a visitor's browser would;
#   4. deploy/tests/e2e/flood-check.mjs (open): every fixture station and area is at its level in latest.json and
#      warnings/latest.geojson, the northern AGE alert is still open, the CH-4 run is in the forecast band, DE-2 is in
#      the owner tree and in no public byte, the owner canary is in the owner tree only;
#   5. the cancel phase: the AGE Cancel and the TEST message; flood-check.mjs (closed): the alert is closed, the TEST
#      never appeared; it prints "PASS flood-check";
#   6. Playwright in the pinned image (apps/web/e2e/flood-drill.spec.ts): the flood scenes of the page, with a visual
#      baseline. While apps/web/e2e/visual/__screenshots__ holds no flood-drill-*.png the run WRITES them
#      (--update-snapshots) and says so: the first run of this job produces the baselines, to commit from the artifact.
# Needs PLAYWRIGHT_IMAGE (ci.yml's deploy job value; sudo --preserve-env=PLAYWRIGHT_IMAGE). FLOOD_WAIT_S (default 900)
# is how long flood-check.mjs waits for each phase to reach the files.
# Usage: sudo --preserve-env=PLAYWRIGHT_IMAGE deploy/tests/flood/run.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
flood=$repo/deploy/tests/flood
e2e=$repo/deploy/tests/e2e

fail() {
  echo "::error::flood drill: $*"
  exit 1
}
proof() { echo "PROOF: $*"; }
step() { echo "::group::$*"; }
endstep() { echo "::endgroup::"; }
# wait_for <what> <seconds> <command...>
wait_for() {
  local what=$1 end=$((SECONDS + $2))
  shift 2
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < end)) || fail "timed out waiting for $what"
    sleep 5
  done
}

[[ $(id -u) == 0 ]] || fail "run as root (sudo --preserve-env=PLAYWRIGHT_IMAGE)"
[[ -n ${PLAYWRIGHT_IMAGE:-} ]] || fail "PLAYWRIGHT_IMAGE is not set (ci.yml's deploy job value)"
[[ -f /ci/e2e-stack && -f /ci/loadtest.env ]] || fail "no stack: run deploy/tests/e2e/run.sh with RWS_E2E_MODE=drill first"
grep -q '"mode":"drill"' /ci/e2e-stack || fail "/ci/e2e-stack does not say mode drill"
set -a
# shellcheck source=/dev/null
. /ci/loadtest.env
set +a
[[ ${RWS_E2E_MODE:-} == drill && ${RWS_E2E_DOMAIN:-} == rivierstanden.example ]] || fail "/ci/loadtest.env is not the drill stack's"
[[ ${RWS_E2E_REPO:-} == "$repo" ]] || fail "this checkout is not the stack's repository"
export RWS_E2E=1
domain=$RWS_E2E_DOMAIN
server_image=${RWS_SERVER_IMAGE:-rws-server:ci}
wait_s=${FLOOD_WAIT_S:-900}

# From the client namespace, like a visitor: the host's own traffic would reach Caddy through the bridge.
outside() {
  ip netns exec "$RWS_E2E_CLIENT_NETNS" curl -fsS --max-time 20 --cacert "$RWS_E2E_CA" \
    --resolve "$domain:443:$RWS_E2E_CADDY_IP" "$@"
}

# flood-check.mjs in the server image: no network, the two publishers' trees and expected.json read-only. It runs as root
# in the container (the trees belong to 65532 and their directories may be closed to others); it writes nothing.
check() {
  docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges \
    --user 0:0 -e DRILL_NOW="$now" -e FLOOD_WAIT_S="$wait_s" \
    -v /srv/rws/public/www:/public:ro -v /srv/rws/owner/www:/owner:ro \
    -v "$flood/expected.json:/expected.json:ro" -v "$e2e/flood-check.mjs:/flood-check.mjs:ro" \
    --entrypoint /nodejs/bin/node "$server_image" /flood-check.mjs "$1"
}

step "Observations for the series the drill classifies (the load test's seed, idempotent)"
docker run --rm --network none -v "$repo:$repo:ro" -w "$repo" --entrypoint node "$RWS_E2E_NODE_IMAGE" \
  scripts/seed-loadtest.ts --print |
  docker exec -i rws-db-1 psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d rws -f - >/dev/null
proof "scripts/seed-loadtest.ts (3 days of synthetic observations for every public primary series, including the drill registry's station 2020) piped to psql in the db container, idempotent"
endstep

step "The flood drill, main phase"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$now" >/ci/flood-now
"$repo/scripts/flood-drill" --phase main --now "$now"
proof "scripts/flood-drill --phase main --now $now: the DE-6 test-server stations and alerts, the class-4 and class-less synthetic stations, the Vigicrues map with sections at levels 2, 3 and 4, the AGE red (Sud) and orange (Nord) alerts, the CH-4 storm-Ciaran run of station 2020 and the DE-2 owner run, every timestamp shifted to the drill clock, written through the recorder's Archive (refused outside the drill stack: RWS_E2E=1, /ci/e2e-stack mode drill)"
endstep

step "The loader and the publishers have rendered it; Caddy serves it"
# (a variable, not a pipe: grep -q would close it on the first match and pipefail would call that a failure of curl)
areas_there() {
  local body
  body=$(outside "https://$domain/data/v1/warnings/latest.geojson") || return 1
  grep -q 'Nord du Luxembourg' <<<"$body"
}
wait_for "the AGE alerts in https://$domain/data/v1/warnings/latest.geojson" "$wait_s" areas_there
served=$(outside "https://$domain/data/v1/warnings/latest.geojson" | grep -o '"area":"[^"]*"' | wc -l)
proof "https://$domain/data/v1/warnings/latest.geojson, fetched from outside through Caddy, holds the drill's areas ($served features)"
endstep

step "flood-check.mjs open: levels of every fixture station and area, the open alert, the forecast band, the owner side"
check open | tee /ci/flood-check-open.out || fail "flood-check.mjs open exited non-zero (its FAIL lines are above)"
[[ $(grep -c '^FAIL' /ci/flood-check-open.out || true) == 0 ]] || fail "flood-check.mjs open"
grep -q '^PASS flood-check-open$' /ci/flood-check-open.out || fail "flood-check.mjs open did not finish"
proof "flood-check.mjs open: $(grep -c '^PASS' /ci/flood-check-open.out) PASS lines, no FAIL: DE-6 classes (Kaub RP 4 extreme, Giessen and Greven elevated), the 40 LHP alert areas, the 56 Vigicrues sections (levels 2, 3, 4) and their stations, the AGE zones Sud (extreme) and Nord (high) and their stations, the CH-4 run of station 2020 (median peak 476.4, maximum 800.3, above the first threshold band of 700 m3/s) in the public forecast, the DE-2 run in the owner tree only, the owner canary in the owner tree only"
endstep

step "The flood drill, cancel phase: the AGE Cancel and the TEST message"
"$repo/scripts/flood-drill" --phase cancel --now "$now"
check closed | tee /ci/flood-check.out || fail "flood-check.mjs closed exited non-zero (its FAIL lines are above)"
[[ $(grep -c '^FAIL' /ci/flood-check.out || true) == 0 ]] || fail "flood-check.mjs closed"
grep -q '^PASS flood-check$' /ci/flood-check.out || fail "flood-check.mjs closed did not finish"
proof "flood-check.mjs closed: the AGE Cancel (its <references> naming the Nord alert's identifier and sent exactly) closed the Nord zone in warnings/latest.geojson and today.json, its stations lost the zone, the Sud zone stayed; the TEST message (sent after the Cancel) stored nothing, in no area, name or label"
endstep

step "Playwright: the flood scenes of the page, visual baseline (pinned image)"
shopt -s nullglob
baselines=("$repo"/apps/web/e2e/visual/__screenshots__/flood-drill-*.png)
update=()
if ((${#baselines[@]} < 2)); then
  update=(--update-snapshots)
  echo "::warning::no flood-drill baseline in apps/web/e2e/visual/__screenshots__: this run writes them (commit them from the job's artifact)"
fi
ui_rc=0
docker run --rm --init --network host --ipc=host --add-host "$domain:$RWS_E2E_CADDY_IP" \
  -e CI=true -e E2E_COMPOSE=1 -e E2E_SPEC=flood-drill -e "E2E_COMPOSE_URL=https://$domain" -e DRILL_NOW="$now" \
  -v "$repo:/work" -w /work/apps/web \
  "$PLAYWRIGHT_IMAGE" xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24' \
  node_modules/.bin/playwright test -c e2e/playwright.config.ts --project=chromium "${update[@]}" || ui_rc=$?
((ui_rc == 0)) || fail "flood-drill.spec.ts failed (exit $ui_rc)"
written=(
  "$repo"/apps/web/e2e/visual/__screenshots__/flood-drill-*.png
)
((${#written[@]} >= 2)) || fail "flood-drill.spec.ts left no flood-drill-*.png"
if ((${#update[@]} > 0)); then
  proof "flood-drill.spec.ts in the pinned image: the Kaub and Bellinzona scenes passed and their baselines were WRITTEN (${written[*]##*/}): commit apps/web/e2e/visual/__screenshots__/flood-drill-*.png from the artifact"
else
  proof "flood-drill.spec.ts in the pinned image (Chromium, host network, $domain -> $RWS_E2E_CADDY_IP): the panel of Kaub says extreem from the LHP class 4 and the panel of station 2020 shows the BAFU storm run at its peak, both equal to their baselines (0.2 % of the pixels), no request left the origin"
fi
endstep

echo "flood drill done"
