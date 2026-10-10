#!/usr/bin/env bash
# CI only (P12a, issue #27; .github/workflows/loadtest.yml job `chaos`; as root, after `RWS_E2E_MODE=chaos
# deploy/tests/e2e/run.sh`, which leaves the stack running and writes /ci/e2e-stack and /ci/loadtest.env). Three
# failures, each proved by what a visitor or the owner would see, with PROOF lines:
#   (a) the api container stopped: Playwright's degraded.spec.ts (map from static files + the banner) in the pinned image;
#   (b) the database stopped for 10 minutes: capture keeps appending manifest lines; when the database is back the backlog
#       loads without loss: every stored payload named by a manifest line of the window has exactly one ingest_batch row
#       (no missing, no duplicate), and no gap between loaded payloads is longer than 30 minutes (Q7, below). No lag
#       threshold is judged right after the restart.
#   (c) one provider host blackholed at the fake upstream (/ci/fake/control/blackhole, held open until the client gives up),
#       overlapping (b) so the staleness rules (3 x cadence) fit the job: the host's hits turn to status 0; the host's
#       spec shows failed and stale in the public capture status; the source shows stale in the public status.json (the
#       stale styling of the status page and the map legend: source status degraded/down with a lastFetchOk before the
#       blackhole); and a /fail ping of the host's group, dated after the blackhole, reaches the fake healthchecks.
#       NOTE: a bare /fail is no proof: every capture group also holds specs the fake does not serve, so its check fails
#       from the first run. The /fail is only the last of four signals, and the pre-state (a fetch that worked, 200s at the
#       fake) and the status 0 hits after the blackhole are what tie it to the blackhole.
# Q7 (A§8 Q7, health outage): "expected buckets without data". The fake replays recorded payloads, so observation
# timestamps are not fresh and the bucket form of Q7 is not meaningful here; the payload form is: findOutages/findCoverage
# count a gap between payloads loaded ok (by fetched_at, which survives a database outage because the manifest keeps it)
# longer than max(3 x cadence, 30 min). The check below takes the 30-minute floor over the sources that had two or more
# loaded payloads in the window, except the blackholed source, whose gap is the point of (c).
# Environment: PLAYWRIGHT_IMAGE (required), CHAOS_DB_DOWN_S (600), CHAOS_SIGNAL_WAIT_S (2400, from the blackhole),
# CHAOS_SPEC/CHAOS_HOST/CHAOS_SOURCE/CHAOS_GROUP (ch-2-pq, www.hydrodaten.admin.ch, CH-2, cap-ch).
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
# shellcheck source=deploy/bin/rws-lib.sh
. "$repo/deploy/bin/rws-lib.sh"
umask 022
: "${PLAYWRIGHT_IMAGE:?set PLAYWRIGHT_IMAGE}"
DB_DOWN_S=${CHAOS_DB_DOWN_S:-600}
SIGNAL_WAIT_S=${CHAOS_SIGNAL_WAIT_S:-2400}
SPEC=${CHAOS_SPEC:-ch-2-pq} HOST=${CHAOS_HOST:-www.hydrodaten.admin.ch}
SOURCE=${CHAOS_SOURCE:-CH-2} GROUP=${CHAOS_GROUP:-cap-ch}
[[ $SPEC =~ ^[a-z0-9-]+$ && $HOST =~ ^[a-z0-9.-]+$ && $SOURCE =~ ^[A-Z]{2}-[0-9]+$ && $GROUP =~ ^cap-[a-z0-9-]+$ ]] ||
  { echo "chaos: bad CHAOS_* value" >&2; exit 64; }
HITS=/ci/fake/state/hits.jsonl
CONTROL=/ci/fake/control

proofs=()
proof() {
  proofs+=("$*")
  echo "PROOF: $*"
}
fail() {
  echo "::error::chaos: $*"
  exit 1
}
step() { echo "::group::$*"; }
endstep() { echo "::endgroup::"; }
wait_for() { # <what> <seconds> <command...>
  local what=$1 end=$((SECONDS + $2))
  shift 2
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < end)) || fail "timed out waiting for $what"
    sleep 5
  done
}

((EUID == 0)) || fail "run as root"
jq -e '.mode == "chaos"' /ci/e2e-stack >/dev/null 2>&1 || fail "/ci/e2e-stack is missing or not mode chaos (run.sh with RWS_E2E_MODE=chaos first)"
# shellcheck source=/dev/null
. /ci/loadtest.env
[[ -f $HITS ]] || fail "$HITS does not exist: the fake upstream is not running"

outside() { ip netns exec "$RWS_E2E_CLIENT_NETNS" curl -sS --max-time 15 --cacert "$RWS_E2E_CA" \
  --resolve "$RWS_E2E_DOMAIN:443:$RWS_E2E_CADDY_IP" "$@"; }
site() { outside "https://$RWS_E2E_DOMAIN$1"; }
healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$1-1") == healthy ]]; }
psql_su() { docker exec -i rws-db-1 psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d rws "$@"; }
manifest() { cat /srv/rws/raw/_manifest/*.jsonl; }
now_s() { date -u +%Y-%m-%dT%H:%M:%S; } # second resolution; hits.jsonl and the status files compare on their first 19 characters

restore() { # always leave the stack as found
  rm -f "$CONTROL/blackhole"
  rws_compose start db api >/dev/null 2>&1 || true
}
on_exit() {
  local rc=$?
  restore
  if ((rc != 0)); then
    echo "::group::chaos diagnostics"
    rws_compose ps -a || true
    tail -n 20 "$HITS" || true
    for s in api db load capture publish fake-upstream; do docker logs --tail 30 "rws-$s-1" 2>&1 | sed "s/^/$s| /" || true; done
    echo "::endgroup::"
  fi
  printf '\n%s\n' "== chaos evidence (${#proofs[@]} proofs, exit $rc) =="
  printf -- '- %s\n' "${proofs[@]}"
}
trap on_exit EXIT

# ------------------------------------------------------------------ (a) the api is down
step "(a) api stopped: the map from static files and the degraded banner"
rws_compose stop api
other=$(outside -o /dev/null -w '%{http_code}' "https://$RWS_E2E_DOMAIN/api/v1/meta" || true)
[[ $other =~ ^50[234]$ ]] || fail "/api/v1/meta answered $other with the api stopped (want 502, 503 or 504)"
standin=$(outside -D - -o /dev/null "https://$RWS_E2E_DOMAIN/api/v1/snapshot?t=$(date -u -d '-2 hours' +%Y-%m-%dT%H:00Z)" | tr -d '\r')
grep -q '^HTTP/[0-9.]* 200' <<<"$standin" || fail "the snapshot stand-in did not answer 200"
grep -qi '^x-degraded: 1' <<<"$standin" || fail "the snapshot stand-in has no X-Degraded: 1"
rc=0
"$repo/deploy/tests/loadtest/pw-spec.sh" degraded || rc=$?
rws_compose start api
wait_for "api healthy again" 240 healthy api
((rc == 0)) || fail "degraded.spec.ts failed with the api stopped (exit $rc)"
proof "api stopped: /api/v1/meta answered $other, /api/v1/snapshot the stand-in (200, X-Degraded: 1), and degraded.spec.ts (map canvas + degraded banner, pinned Playwright image) passed; the api started again and is healthy"
endstep

# ------------------------------------------------------------------ pre-state of (c)
step "(c) pre-state: a fetch of $SPEC that worked"
spec_ok() {
  site /status/capture.json | jq -e --arg s "$SPEC" '.specs[] | select(.spec == $s) | .last_success != null' >/dev/null
}
# The cron ticks every 10-15 min, so a first success can take that long after the stack came up.
wait_for "a successful $SPEC fetch in /status/capture.json" 1500 spec_ok
ok_hits=$(jq -s --arg h "$HOST" '[.[] | select(.host == $h and .status == 200)] | length' "$HITS")
((ok_hits > 0)) || fail "the fake saw no 200 for $HOST before the blackhole"
status_before=$(site /data/v1/status.json | jq -r --arg s "$SOURCE" '.sources[] | select(.id == $s) | .status')
echo "pre-state: $SPEC has a last_success, $ok_hits hits with status 200 for $HOST, $SOURCE status '$status_before'"
proof "before the blackhole $SPEC shows a successful fetch in /status/capture.json, the fake answered $ok_hits requests for $HOST with 200, $SOURCE is '$status_before' in /data/v1/status.json"
endstep

# ------------------------------------------------------------------ (c) blackhole + (b) database down
step "(b)+(c) blackhole $HOST and stop the database for $DB_DOWN_S s"
t_bh=$(now_s)
printf '%s\n' "$HOST" >"$CONTROL/blackhole"
lines_before=$(manifest | wc -l)
t_stop=$(now_s)
rws_compose stop db
echo "database stopped at ${t_stop}Z, $HOST blackholed since ${t_bh}Z, manifest lines: $lines_before"
sleep "$DB_DOWN_S"
lines_after=$(manifest | wc -l)
t_up=$(now_s)
rws_compose start db
wait_for "db healthy again" 240 healthy db
((lines_after > lines_before)) || fail "capture appended no manifest line in $DB_DOWN_S s with the database stopped ($lines_before -> $lines_after)"
proof "database stopped for ${DB_DOWN_S}s: capture kept appending to the manifest ($lines_before -> $lines_after lines)"

# The stored payloads of the window: key non-null, not a dup_of line.
keys=$(mktemp)
manifest | jq -r --arg a "$(date -u -d "@$(($(date -u -d "${t_stop}Z" +%s) - 300))" +%Y-%m-%dT%H:%M:%SZ)" --arg b "${t_up}Z" '
  select(.key != null and .dup_of == null and .fetched_at.start >= $a and .fetched_at.start <= $b) | .key' >"$keys"
nkeys=$(wc -l <"$keys")
((nkeys > 0)) || fail "no payload was stored in the window ($lines_before -> $lines_after lines were all errors or dup_of lines): nothing to load, nothing proved"

backlog_check() { # prints: missing manifest_dup db_dup table_dup gaps matched
  {
    printf 'create temp table k(key text);\ncopy k from stdin;\n'
    cat "$keys"
    printf '\\.\n'
    cat <<'SQL'
select count(*) from k where not exists (select 1 from ingest_batch b where b.archive_key = k.key);
select count(*) from (select key from k group by key having count(*) > 1) d;
select count(*) from (select b.archive_key from ingest_batch b join k on k.key = b.archive_key group by 1 having count(*) > 1) d;
select count(*) - count(distinct archive_key) from ingest_batch;
with b as (
  select source_id, fetched_at, lag(fetched_at) over (partition by source_id order by fetched_at) as prev
  from ingest_batch
  where parse_status = 'ok' and source_id <> :'src'
    and fetched_at >= :'a'::timestamptz - interval '10 minutes' and fetched_at <= :'b'::timestamptz + interval '5 minutes')
select count(*) from b where prev is not null and fetched_at - prev > interval '30 minutes';
select count(*) from k join ingest_batch b on b.archive_key = k.key;
SQL
  } | psql_su -v "src=$SOURCE" -v "a=${t_stop}Z" -v "b=${t_up}Z" | paste -sd' '
}
missing_zero() {
  local r
  r=$(backlog_check) || return 1
  echo "backlog check (missing manifest_dup db_dup table_dup gaps matched): $r"
  [[ $r == "0 "* ]]
}
wait_for "the backlog to load (every stored payload of the window in ingest_batch)" 900 missing_zero
read -r missing mdup ddup tdup gaps matched <<<"$(backlog_check)"
((missing == 0 && mdup == 0 && ddup == 0 && tdup == 0)) || fail "loss or duplicates: missing $missing, manifest duplicates $mdup, ingest_batch duplicates $ddup (table-wide $tdup)"
((gaps == 0)) || fail "$gaps gaps longer than 30 min between loaded payloads in the window (Q7)"
proof "database back: all $nkeys stored payloads of the window ($matched ingest_batch rows) loaded, 0 missing, 0 duplicates manifest <-> ingest_batch, 0 gaps over 30 min between loaded payloads (Q7); no lag threshold judged"
rm -f "$keys"
endstep

# ------------------------------------------------------------------ (c) the four signals
step "(c) wait for the stale and alert signals of $HOST (up to ${SIGNAL_WAIT_S}s after the blackhole)"
bh_epoch=$(date -u -d "${t_bh}Z" +%s)
sig_hits() { jq -s -e --arg h "$HOST" --arg t "$t_bh" '[.[] | select(.host == $h and .status == 0 and .t[0:19] >= $t)] | length > 0' "$HITS"; }
sig_spec() {
  site /status/capture.json | jq -e --arg s "$SPEC" --arg t "$t_bh" \
    '.specs[] | select(.spec == $s) | (.last_success != null and .last_success[0:19] <= $t) and .last_failure_status != null'
}
sig_source() {
  site /data/v1/status.json | jq -e --arg s "$SOURCE" --arg t "$t_bh" \
    '.sources[] | select(.id == $s) | (.lastFetchOk == null or .lastFetchOk[0:19] <= $t) and (.status == "degraded" or .status == "down")'
}
sig_fail() {
  jq -s -e --arg g "$GROUP" --arg t "$t_bh" \
    '[.[] | select(.host == "hc-ping.com" and (.path | endswith("/" + $g + "/fail")) and .t[0:19] >= $t)] | length > 0' "$HITS"
}
declare -A got=()
deadline=$((bh_epoch + SIGNAL_WAIT_S))
while (($(date -u +%s) < deadline)); do
  for sig in hits spec source fail; do
    [[ -n ${got[$sig]:-} ]] || if "sig_$sig" >/dev/null 2>&1; then
      got[$sig]=$(date -u +%T)
      echo "signal $sig at ${got[$sig]}Z ($(($(date -u +%s) - bh_epoch)) s after the blackhole)"
    fi
  done
  ((${#got[@]} == 4)) && break
  sleep 30
done
for sig in hits spec source fail; do
  [[ -n ${got[$sig]:-} ]] || fail "signal '$sig' did not appear within ${SIGNAL_WAIT_S}s of the blackhole (seen: ${!got[*]})"
done
proof "$HOST blackholed at ${t_bh}Z: the fake logged status-0 hits for it (${got[hits]}Z); $SPEC shows a failure and no success after the blackhole in /status/capture.json (${got[spec]}Z); $SOURCE is stale in /data/v1/status.json, status not ok with lastFetchOk before the blackhole (${got[source]}Z, was '$status_before'); and a /fail ping of $GROUP, dated after the blackhole, reached the fake healthchecks (${got[fail]}Z). The /fail alone is not causal: the group also holds specs the fake does not serve."
rm -f "$CONTROL/blackhole"
endstep
