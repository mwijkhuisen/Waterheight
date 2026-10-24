#!/usr/bin/env bash
# CI only (P20a, issue #68; .github/workflows/loadtest.yml, job drill, the step after the flood drill): the driver of the
# storm-surge drill, run as root on the stack that deploy/tests/e2e/run.sh left running in RWS_E2E_MODE=drill (the flood
# drill ran on it first; /ci/e2e-stack and /ci/loadtest.env are its). The k6 `storm` scenario (a static-only burst, no API
# and no health thresholds, because the api is stopped on purpose below) runs beside it, started by the workflow. This
# proves the storm-day criterion of the issue on the same stack, with PROOF lines:
#   1. scripts/flood-drill --phase storm replays the synthetic Den Helder storm (obs-sea, astro and hwlw-astro of
#      nl.rws.denhelder.marsdiep, shifted so that the 23:00Z high of 333 cm = astro 83 + surge 250 is the newest value AT
#      the drill clock) into the raw archive; from here a sampler records the publisher every 10 s until the end;
#   2. from the client namespace, like a visitor, latest.json holds Den Helder with tide.surge 250 and value = astro + 250
#      (never the state alone: the load test's seed already makes Den Helder "high", with no tide). latest.json is
#      rendered at the bucket of the clock, so the row shows after the next 10-minute boundary (STORM_WAIT_S, 900);
#   3. deploy/tests/e2e/storm-check.mjs in the server image (no network, read-only mounts, like flood-check.mjs): state
#      high, basis NL-4 "Stormvloed (> 260cm)", the tide, stations.json tidal (the hatch), the surge >= 50 (the up
#      triangle), the recent bucket file, and no public byte with any of the four canary renderings; prints
#      "PASS storm-check";
#   4. the public answers at the storm, fetched from outside with the api up (CR-5): /api/v1/snapshot at the storm bucket (it
#      holds Den Helder at surge 250), /api/v1/series/<Den Helder H> over the last day (raw), /api/v1/health and
#      /health/sources, /data/v1/status.json, /status/capture.json, /status/ops.json and /data/v1/rivers/manifest.json
#      (the last three may be absent on the drill stack): none holds any of the four canary renderings of expected.json;
#   5. degraded mode, under the burst: the api container stopped; /api/v1/snapshot answers 200 with X-Degraded: 1 and
#      Cache-Control: no-store and the body of /data/v1/latest.json (Den Helder's surge 250 included), the static files
#      keep answering 200; the api starts again and is healthy within 240 s (a trap starts it on any failure);
#   6. the publisher kept up for the whole window (replay to here): the largest status.json publisher.cycleSeconds is at
#      most 60 (CYCLE_MS, the cycle period, A§9.1), after the replay settled meta.json says degraded false and latest.json's
#      generatedAt is at most 120 s old at each sample. A sample whose fetch failed is counted, and more than one in five
#      fails the drill;
#   7. LAST, Playwright in the pinned image (apps/web/e2e/storm-drill.spec.ts): the popup says "Opzet: +250 cm (afgeleid)", the
#      panel the Stormvloed basis, with a visual baseline. It runs after steps 4 to 6 so that a missing baseline (the
#      project's rule for visual baselines: a missing storm-drill-*.png is written and its test FAILS; commit it from the
#      job's artifact after looking at it) cannot hide them, and it needs the api back and healthy (step 5), because the
#      panel reads it.
# Time: the wait of step 2 is the distance to the next 10-minute boundary (0 to 10 min, 5 on average) plus one publisher
# cycle and the loader; the rest is about 1 min of storm-check and Playwright (the image is cached by the flood drill)
# and 1 to 3 min of degraded mode. The k6 duration (STORM_DURATION in loadtest.yml) must outlast the typical run.
# Needs PLAYWRIGHT_IMAGE (sudo --preserve-env=PLAYWRIGHT_IMAGE). STORM_WAIT_S (default 900) is how long step 2 waits.
# Usage: sudo --preserve-env=PLAYWRIGHT_IMAGE deploy/tests/storm/run.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
storm=$repo/deploy/tests/storm
e2e=$repo/deploy/tests/e2e
# shellcheck source=deploy/bin/rws-lib.sh
. "$repo/deploy/bin/rws-lib.sh"
umask 022

fail() {
  echo "::error::storm drill: $*"
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
healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$1-1") == healthy ]]; }

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
wait_s=${STORM_WAIT_S:-900}
[[ $wait_s =~ ^[1-9][0-9]{0,5}$ ]] || fail "STORM_WAIT_S is not a number of seconds (1 to 999999, no leading zero)"
station=$(jq -r '.station.id' "$storm/expected.json")
samples=/ci/storm-samples.tsv

# From the client namespace, like a visitor: the host's own traffic would reach Caddy through the bridge.
outside() {
  ip netns exec "$RWS_E2E_CLIENT_NETNS" curl -fsS --max-time 20 --cacert "$RWS_E2E_CA" \
    --resolve "$domain:443:$RWS_E2E_CADDY_IP" "$@"
}

# den_helder_at_storm <latest.json> <stations.json>: Den Helder's H series holds tide.surge == expected and value == astro
# + surge. (jq's `and` short-circuits: a latest.json without the series, or without a tide, is "not yet", not an error.)
den_helder_at_storm() {
  jq -e --slurpfile st "$2" --slurpfile e "$storm/expected.json" '
    . as $l
    | first($st[0].stations[] | select(.id == $e[0].station.id) | .series[] | select(.quantity == $e[0].station.quantity) | .id) as $sid
    | ($l.series | index($sid)) as $i
    | $i != null
      and ($l.tide[$i].surge == $e[0].tide.surge)
      and ($l.value[$i] == ($l.tide[$i].astro + $e[0].tide.surge))' "$1"
}
surge_there() {
  outside "https://$domain/data/v1/stations.json" -o /ci/storm-stations.json &&
    outside "https://$domain/data/v1/latest.json" -o /ci/storm-latest.json &&
    den_helder_at_storm /ci/storm-latest.json /ci/storm-stations.json
}

# The publisher sampler (step 6): one line every 10 s, "epoch<TAB>cycleSeconds<TAB>degraded<TAB>age of generatedAt", or
# three dashes when a fetch failed. It runs in the background from the replay to the end (a trap stops it).
sampler_pid=''
sample_loop() {
  local ts cyc deg gen
  while :; do
    ts=$(date -u +%s)
    if cyc=$(outside "https://$domain/data/v1/status.json" | jq -r '.publisher.cycleSeconds') &&
      deg=$(outside "https://$domain/data/v1/meta.json" | jq -r '.degraded') &&
      gen=$(outside "https://$domain/data/v1/latest.json" | jq -r '.generatedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601') &&
      [[ $cyc =~ ^[0-9]+$ && $deg =~ ^(true|false)$ && $gen =~ ^[0-9]+$ ]]; then
      printf '%s\t%s\t%s\t%s\n' "$ts" "$cyc" "$deg" "$((ts - gen))" >>"$samples"
    else
      printf '%s\t-\t-\t-\n' "$ts" >>"$samples"
    fi
    sleep 10
  done
}

api_stopped=0
on_exit() {
  local rc=$?
  [[ -z $sampler_pid ]] || kill "$sampler_pid" 2>/dev/null || true
  # Always leave the stack as found: the api runs again, whatever failed after the stop.
  if ((api_stopped)); then rws_compose start api >/dev/null 2>&1 || true; fi
  if ((rc != 0)); then
    echo "::group::storm drill diagnostics"
    rws_compose ps -a || true
    tail -n 12 "$samples" 2>/dev/null || true
    for s in api load publish caddy; do docker logs --tail 30 "rws-$s-1" 2>&1 | sed "s/^/$s| /" || true; done
    echo "::endgroup::"
  fi
}
trap on_exit EXIT

step "The storm drill: the replay of the synthetic Den Helder storm"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$now" >/ci/storm-now
: >"$samples"
sample_loop &
sampler_pid=$!
"$repo/scripts/flood-drill" --phase storm --now "$now"
proof "scripts/flood-drill --phase storm --now $now: the obs-sea, astro and hwlw-astro lines of $station, shifted to the drill clock so that the storm high (333 cm = astro 83 + surge 250) is the newest value AT it, written through the recorder's Archive (refused outside the drill stack); the publisher sampler runs every 10 s from here"
endstep

step "The loader and the publishers have rendered it; Caddy serves it"
wait_for "tide.surge 250 and value = astro + 250 for $station in https://$domain/data/v1/latest.json" "$wait_s" surge_there
settled_at=$(date -u +%s)
proof "https://$domain/data/v1/latest.json, fetched from outside through Caddy, holds $station with tide.surge $(jq -r '.tide.surge' "$storm/expected.json") and value = astro + surge ($((settled_at - $(date -u -d "$now" +%s))) s after the replay)"
endstep

step "storm-check.mjs: Den Helder's state, basis and tide, the hatch and triangle inputs, the recent file, the canaries"
docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges \
  --user 0:0 \
  -v /srv/rws/public/www:/public:ro -v /srv/rws/owner/www:/owner:ro \
  -v "$storm/expected.json:/expected.json:ro" -v "$e2e/storm-check.mjs:/storm-check.mjs:ro" \
  --entrypoint /nodejs/bin/node "$server_image" /storm-check.mjs | tee /ci/storm-check.out ||
  fail "storm-check.mjs exited non-zero (its FAIL lines are above)"
[[ $(grep -c '^FAIL' /ci/storm-check.out || true) == 0 ]] || fail "storm-check.mjs"
grep -q '^PASS storm-check$' /ci/storm-check.out || fail "storm-check.mjs did not finish"
proof "storm-check.mjs: $(grep -c '^PASS' /ci/storm-check.out) PASS lines, no FAIL: $station is high on NL-4 'Stormvloed (> 260cm)' at 333 cm = astro 83 + surge 250 (derived surge), flagged tidal in stations.json, the surge is at least 50, the recent bucket file holds it, and none of the four canary renderings is in any file (compressed ones read) of the public tree while the owner canary is in the owner tree"
endstep

step "The public answers at the storm: no canary rendering in the snapshot, a series, health, status or the rivers manifest"
# A visitor's reads while the api is up and the storm is in latest.json (the static tree is scanned by storm-check.mjs; these are
# the answers it does not read). The snapshot and the series are the reads that carry Den Helder's tide; the status files and the
# rivers manifest may be absent on the drill stack (404 is accepted there, and its body is scanned too).
sweep=/ci/storm-sweep
rm -rf "$sweep"
mkdir -p "$sweep"
storm_t=$(date -u -d "$(jq -r '.t' /ci/storm-latest.json)" +%Y-%m-%dT%H:%MZ) || fail "latest.json has no usable t"
series_id=$(jq -r --slurpfile e "$storm/expected.json" \
  '.stations[] | select(.id == $e[0].station.id) | .series[] | select(.quantity == $e[0].station.quantity) | .id' \
  /ci/storm-stations.json | head -n 1)
[[ $series_id =~ ^[0-9]+$ ]] || fail "no $station series id in stations.json"
to_s=$(($(date -u +%s) / 600 * 600))
series_from=$(date -u -d "@$((to_s - 86400))" +%Y-%m-%dT%H:%MZ)
series_to=$(date -u -d "@$to_s" +%Y-%m-%dT%H:%MZ)
# sweep_get <name> <path> <200 | 200,404>: the status code must be one of the list; the body is kept for the scan.
sweep_get() {
  # (sweep_code keeps the status code for the caller)
  local code
  code=$(ip netns exec "$RWS_E2E_CLIENT_NETNS" curl -sS --max-time 20 --cacert "$RWS_E2E_CA" \
    --resolve "$domain:443:$RWS_E2E_CADDY_IP" -o "$sweep/$1" -w '%{http_code}' "https://$domain$2") ||
    fail "$2: the request failed"
  [[ ,$3, == *",$code,"* ]] || fail "$2 answered $code (expected $3)"
  sweep_code=$code
  swept+=("$2=$code")
}
swept=()
sweep_get snapshot "/api/v1/snapshot?t=$storm_t" 200
sweep_get series "/api/v1/series/$series_id?from=$series_from&to=$series_to&res=raw" 200,503
series_code=$sweep_code
sweep_get health /api/v1/health 200
sweep_get health-sources /api/v1/health/sources 200
sweep_get data-status /data/v1/status.json 200
sweep_get status-capture /status/capture.json 200,404
sweep_get status-ops /status/ops.json 200,404
sweep_get rivers-manifest /data/v1/rivers/manifest.json 200,404
# A body that is empty proves nothing about the canaries: every fetched answer must hold something.
for f in "$sweep"/*; do
  [[ -s $f ]] || fail "the public answer ${f##*/} is empty"
done
# The raw series answers 503 in a brownout (the api's brownout mode); its body is still scanned below.
if [[ $series_code == 200 ]]; then
  jq -e '(.points | length) > 0 and (.tide.surge | length) > 0' "$sweep/series" >/dev/null ||
    fail "the public answer series holds no points or no tide.surge"
  series_note="the 24 h series of $station holds points and a surge"
else
  series_note="the series answered 503 (brownout), its points and surge were not judged"
  proof "NOTE: /api/v1/series answered 503, the api was in brownout; its body was scanned for canaries only"
fi
# The snapshot at the storm bucket is the read that proves the sweep looked at the storm: Den Helder's surge is in it.
jq -e --argjson sid "$series_id" --slurpfile e "$storm/expected.json" \
  '[.values[] | select(.series == $sid)][0].tide.surge == $e[0].tide.surge' "$sweep/snapshot" >/dev/null ||
  fail "/api/v1/snapshot?t=$storm_t does not hold $station at surge 250"
i=0
while IFS= read -r rendering; do
  for f in "$sweep"/*; do
    if grep -qF -- "$rendering" "$f"; then fail "canary rendering #$i is in the public answer ${f##*/}"; fi
  done
  i=$((i + 1))
done < <(jq -r '.canary[]' "$storm/expected.json")
((i == 4)) || fail "expected.json lists $i canary renderings, not 4"
proof "public answers fetched from outside through Caddy at the storm (${swept[*]}): none holds any of the $i canary renderings of expected.json, and the snapshot at $storm_t holds $station at surge 250; $series_note"
endstep

step "Degraded mode under the burst: the api stopped, the map still answers from files"
snapshot_standin() {
  outside -D /ci/storm-snap.head -o /ci/storm-snap.body "https://$domain/api/v1/snapshot?t=$(date -u +%Y-%m-%dT%H:%M:%SZ)" &&
    outside -o /ci/storm-served.body "https://$domain/data/v1/latest.json" &&
    [[ $(jq -S 'del(.generatedAt)' /ci/storm-snap.body) == "$(jq -S 'del(.generatedAt)' /ci/storm-served.body)" ]]
}
api_stopped=1
rws_compose stop api
# (latest.json moves to the next bucket every 10 minutes: if the two reads straddle that, read both again)
same=0
for _ in 1 2 3; do
  if snapshot_standin; then
    same=1
    break
  fi
  sleep 2
done
((same)) || fail "with the api stopped, /api/v1/snapshot did not answer 200 with the body of /data/v1/latest.json"
standin=$(tr -d '\r' </ci/storm-snap.head)
grep -q '^HTTP/[0-9.]* 200' <<<"$standin" || fail "the snapshot stand-in did not answer 200"
grep -qix 'x-degraded: 1' <<<"$standin" || fail "the snapshot stand-in has no X-Degraded: 1"
grep -qix 'cache-control: no-store' <<<"$standin" || fail "the snapshot stand-in is not no-store"
den_helder_at_storm /ci/storm-snap.body /ci/storm-stations.json >/dev/null || fail "the snapshot stand-in does not hold $station at surge 250"
for f in meta latest; do
  [[ $(outside -o /dev/null -w '%{http_code}' "https://$domain/data/v1/$f.json") == 200 ]] ||
    fail "/data/v1/$f.json did not answer 200 with the api stopped"
done
proof "with the api stopped, /api/v1/snapshot?t=<now> answers 200 with X-Degraded: 1 and Cache-Control: no-store, its JSON equals /data/v1/latest.json except generatedAt and holds $station at surge 250; /data/v1/meta.json and /data/v1/latest.json still answer 200"
rws_compose start api
api_stopped=0
wait_for "api healthy again" 240 healthy api
proof "the api container started again and is healthy"
endstep

step "The publisher kept up for the whole window"
# The verdict needs at least 12 samples, 3 of them good ones after the replay settled (the minimums below, never lowered): with
# Playwright last the step comes soon after the replay, so wait (bounded) for the sampler to have taken them; it keeps running.
enough_samples() {
  awk -F'\t' -v s="$settled_at" '{ n++ } $2 != "-" && $1 >= s { j++ } END { exit !(n >= 12 && j >= 3) }' "$samples"
}
wait_for "12 publisher samples, 3 of them after the replay settled" 240 enough_samples
kill "$sampler_pid" 2>/dev/null || true
sampler_pid=''
n=0 missed=0 maxcyc=0 judged=0 degraded_n=0 old_n=0 oldest=0
while IFS=$'\t' read -r ts cyc deg age; do
  n=$((n + 1))
  if [[ $cyc == - ]]; then
    missed=$((missed + 1))
    continue
  fi
  if ((cyc > maxcyc)); then maxcyc=$cyc; fi
  if ((ts >= settled_at)); then
    judged=$((judged + 1))
    if [[ $deg != false ]]; then degraded_n=$((degraded_n + 1)); fi
    if ((age > 120)); then old_n=$((old_n + 1)); fi
    if ((age > oldest)); then oldest=$age; fi
  fi
done <"$samples"
echo "samples: $n, fetch failures: $missed, max cycleSeconds: $maxcyc, after the replay settled: $judged samples, degraded: $degraded_n, generatedAt older than 120 s: $old_n (oldest ${oldest} s)"
((n >= 12)) || fail "only $n publisher samples (the window was shorter than two minutes)"
((missed * 5 <= n)) || fail "$missed of $n publisher samples failed to fetch"
((judged >= 3)) || fail "only $judged publisher samples after the replay settled"
((maxcyc <= 60)) || fail "status.json publisher.cycleSeconds reached $maxcyc s (the cycle period of 60 s, CYCLE_MS)"
((degraded_n == 0)) || fail "meta.json said degraded in $degraded_n of $judged samples after the replay settled"
((old_n == 0)) || fail "latest.json's generatedAt was older than 120 s in $old_n of $judged samples (oldest ${oldest} s)"
proof "publisher kept up: $n samples every 10 s from the replay on ($missed fetch failures), the largest publisher.cycleSeconds in status.json was $maxcyc s (the cycle period of 60 s, CYCLE_MS); after the replay settled ($judged samples) meta.json never said degraded and latest.json's generatedAt was at most $oldest s old (limit 120 s)"
endstep

step "Playwright, last: the popup and the panel of Den Helder on the storm day, visual baseline (pinned image)"
shopt -s nullglob
before=("$repo"/apps/web/e2e/visual/__screenshots__/storm-drill-*.png)
ui_rc=0
docker run --rm --init --network host --ipc=host --add-host "$domain:$RWS_E2E_CADDY_IP" \
  -e CI=true -e E2E_COMPOSE=1 -e E2E_SPEC=storm-drill -e "E2E_COMPOSE_URL=https://$domain" -e DRILL_NOW="$now" \
  -v "$repo:/work" -w /work/apps/web \
  "$PLAYWRIGHT_IMAGE" xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24' \
  node_modules/.bin/playwright test -c e2e/playwright.config.ts --project=chromium 2>&1 | tee /ci/storm-pw.out || ui_rc=$?
after=("$repo"/apps/web/e2e/visual/__screenshots__/storm-drill-*.png)
if ((${#after[@]} > ${#before[@]})); then
  fail "storm-drill.spec.ts WROTE a missing baseline (now: ${after[*]##*/}); look at it in the job's artifact and commit it"
fi
((ui_rc == 0)) || fail "storm-drill.spec.ts failed (exit $ui_rc)"
# The scene ran: Playwright exits 0 when every test is skipped.
grep -qE '^ *1 passed' /ci/storm-pw.out || fail "storm-drill.spec.ts did not pass (skipped or filtered)"
((${#before[@]} >= 1)) || fail "storm-drill.spec.ts: no storm-drill-*.png baseline committed"
proof "(run last, after the public answers, the degraded mode and the publisher verdict) storm-drill.spec.ts in the pinned image (Chromium, host network, $domain -> $RWS_E2E_CADDY_IP): the popup of Den Helder, Marsdiep says 'Opzet: +250 cm (afgeleid)', the panel says high with the basis 'Stormvloed (> 260cm)', the popup equals its committed baseline (0.2 % of the pixels), no request left the origin and no CSP violation"
endstep

echo "storm drill done"
