#!/usr/bin/env bash
# CI only (P12a, issue #27; loadtest.yml job `loadtest`; as root, on the stack of deploy/tests/e2e/run.sh in loadtest
# mode): the brownout engages by itself, on the real Caddy access log, through the real rws-brownout.timer.
#   1. rws-brownout (the host script) and its timer are installed as bootstrap.sh installs them; mode auto.
#   2. 400 healthy API requests: the flag stays off (no false arm).
#   3. The api container is stopped: /api/v1/meta answers 502 behind Caddy (the stand-in only covers /snapshot). The
#      moment the 5xx count crosses 2 % of the requests sent, T0 is taken; `active` must exist <= 60 s later.
#   4. The public publisher shows it: /data/v1/meta.json says brownout true. The api (started again) refuses an explicit
#      res=raw with 503 and X-Brownout: 1.
#   5. Back: `rws-brownout off`, meta.json loses the flag, the timer is disabled again.
# It must run when the 5-minute window holds little else (right after the stack is up: the other phases of the job send
# thousands of requests that would need hundreds of 5xx to cross 2 %).
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
# shellcheck source=deploy/bin/rws-lib.sh
. "$repo/deploy/bin/rws-lib.sh"
umask 022
# shellcheck source=/dev/null
. /ci/loadtest.env
flag=/srv/rws/brownout

proofs=()
proof() {
  proofs+=("$*")
  echo "PROOF: $*"
}
fail() {
  echo "::error::brownout-e2e: $*"
  exit 1
}
outside() { ip netns exec "$RWS_E2E_CLIENT_NETNS" curl -sS --max-time 10 --cacert "$RWS_E2E_CA" \
  --resolve "$RWS_E2E_DOMAIN:443:$RWS_E2E_CADDY_IP" "$@"; }
code() { outside -o /dev/null -w '%{http_code}' "https://$RWS_E2E_DOMAIN$1" || true; }
healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$1-1") == healthy ]]; }
wait_for() { # <what> <seconds> <command...>
  local what=$1 end=$((SECONDS + $2))
  shift 2
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < end)) || fail "timed out waiting for $what"
    sleep 2
  done
}
meta_brownout() { # prints true|false
  outside "https://$RWS_E2E_DOMAIN/data/v1/meta.json" | jq -r '.brownout == true'
}
meta_is() { [[ $(meta_brownout) == "$1" ]]; }

cleanup() {
  local rc=$?
  rws_compose start api >/dev/null 2>&1 || true
  rws-brownout off >/dev/null 2>&1 || true
  systemctl disable --now rws-brownout.timer >/dev/null 2>&1 || true
  if ((rc != 0)); then
    echo "::group::brownout diagnostics"
    rws-brownout status || true
    journalctl -u rws-brownout.service --no-pager -n 40 || true
    ls -la "$flag" || true
    echo "::endgroup::"
  fi
  printf '\n%s\n' "== brownout e2e evidence (${#proofs[@]} proofs, exit $rc) =="
  printf -- '- %s\n' "${proofs[@]}"
}
trap cleanup EXIT
((EUID == 0)) || fail "run as root"

# 1. As bootstrap.sh installs it: the script on PATH (a link, so rws-lib.sh resolves next to it), the two units.
ln -sfn "$repo/deploy/bin/rws-brownout" /usr/local/bin/rws-brownout
install -m 0644 "$repo/deploy/systemd/rws-brownout.service" "$repo/deploy/systemd/rws-brownout.timer" /etc/systemd/system/
systemctl daemon-reload
rws-brownout off # a known start: mode off, no flag
rws-brownout auto
systemctl enable --now rws-brownout.timer
[[ ! -e $flag/active ]] || fail "$flag/active exists in mode auto before any load"
[[ $(<"$flag/mode") == auto ]] || fail "mode is not auto"
proof "rws-brownout.timer enabled on the runner (every 15 s), mode auto, no active flag"

# 2. Healthy traffic: never armed.
ok=0
for _ in $(seq 1 400); do
  [[ $(code /api/v1/meta) == 200 ]] && ok=$((ok + 1))
  sleep 0.03
done
((ok >= 380)) || fail "only $ok of 400 healthy /api/v1/meta answers were 200 before the test"
sleep 35 # two or more evaluations after the last request
[[ ! -e $flag/active ]] || fail "the brownout armed on healthy traffic (rws-brownout status: $(rws-brownout status | tr '\n' ' '))"
proof "400 healthy API requests ($ok x 200): after >= 2 evaluations the flag is still off ($(rws-brownout status | grep window))"

# 3. The api stops; the share of 5xx crosses 2 %.
rws_compose stop api
total=$ok sent5xx=0 t0='' tactive=''
deadline=$((SECONDS + 150))
while ((SECONDS < deadline)); do
  c=$(code /api/v1/meta)
  total=$((total + 1))
  if [[ $c =~ ^5 ]]; then sent5xx=$((sent5xx + 1)); fi
  if [[ -z $t0 ]] && ((sent5xx * 50 > total)); then
    t0=$(date -u +%s)
    echo "T0: $sent5xx 5xx of $total requests sent crossed 2 % at $(date -u -d "@$t0" +%T)Z"
  fi
  if [[ -e $flag/active ]]; then
    tactive=$(date -u +%s)
    break
  fi
  sleep 0.1
done
[[ -n $t0 ]] || fail "the 5xx share never crossed 2 % ($sent5xx of $total): /api/v1/meta did not fail with the api stopped (last code $c)"
[[ -n $tactive ]] || fail "the flag did not appear within 150 s ($sent5xx 5xx of $total sent)"
delay=$((tactive - t0))
((delay <= 60)) || fail "the flag appeared ${delay} s after the 5xx share crossed 2 % (limit 60 s)"
proof "with the api stopped, /api/v1/meta answered 5xx ($sent5xx of $total requests sent); the share crossed 2 % at T0 and rws-brownout.timer set active ${delay} s later (<= 60 s): $(rws-brownout status | grep window)"

# 4. meta.json (the public publisher mounts the flag directory read-only) and the api's refusal.
wait_for "meta.json to say brownout true" 180 meta_is true
proof "/data/v1/meta.json says brownout true"
# Caddy's side: longer TTLs for the mutable files, meta.json (it carries the flag) unchanged.
cache_control() { outside -D - -o /dev/null "https://$RWS_E2E_DOMAIN$1" | tr -d '\r' | grep -i '^cache-control:' || true; }
st=$(cache_control /data/v1/stations.json)
me=$(cache_control /data/v1/meta.json)
grep -qE 'max-age=900([^0-9]|$)' <<<"$st" || fail "stations.json during the brownout: '$st' (want max-age=900)"
grep -qE 'max-age=60([^0-9]|$)' <<<"$me" || fail "meta.json during the brownout: '$me' (want max-age=60)"
proof "with the flag on Caddy serves stations.json with '${st#*: }' and meta.json with '${me#*: }'"
rws_compose start api
wait_for "api healthy again" 240 healthy api
series=$(outside "https://$RWS_E2E_DOMAIN/data/v1/stations.json" | jq -r '[.stations[].series[] | select(.api)][0].id')
[[ $series =~ ^[1-9][0-9]*$ ]] || fail "no series with the api flag in stations.json"
from=$(date -u -d '-2 hours' +%Y-%m-%dT%H:%MZ) to=$(date -u +%Y-%m-%dT%H:%MZ)
tmp=$(mktemp -d)
# brownoutActive() caches the flag for 2 s in the api: the first answers may still be the normal ones.
raw_refused() {
  outside -D "$tmp/head" -o "$tmp/body" "https://$RWS_E2E_DOMAIN/api/v1/series/$series?from=$from&to=$to&res=raw" || true
  grep -q '^HTTP/[0-9.]* 503' "$tmp/head"
}
wait_for "res=raw to be refused with 503" 30 raw_refused
tr -d '\r' <"$tmp/head" | grep -qi '^x-brownout: 1' || fail "the brownout refusal has no X-Brownout: 1"
[[ $(jq -r .error "$tmp/body") == brownout ]] || fail "the refusal body is not error brownout: $(head -c 200 "$tmp/body")"
proof "with the flag on, GET /api/v1/series/$series?res=raw answers 503, X-Brownout: 1, error brownout"
# A span over 30 days is span_too_long, reachable only when the display start allows it (from < displayStart is out_of_range first).
display_start=$(outside "https://$RWS_E2E_DOMAIN/data/v1/meta.json" | jq -r .displayStart)
if (($(date -u -d "$display_start" +%s) <= $(date -u -d '-32 days' +%s))); then
  long=$(date -u -d '-31 days' +%Y-%m-%dT%H:%MZ)
  c=$(outside -o "$tmp/long" -w '%{http_code}' "https://$RWS_E2E_DOMAIN/api/v1/series/$series?from=$long&to=$to&res=1h" || true)
  [[ $c == 400 && $(jq -r .error "$tmp/long") == span_too_long ]] || fail "a 31-day span during the brownout: $c $(head -c 200 "$tmp/long")"
  proof "with the flag on, a 31-day span answers 400 span_too_long"
else
  echo "note: display start $display_start is under 32 days back: the 30-day cap is covered by the api unit tests only"
fi
rm -rf "$tmp"

# 5. Off again.
rws-brownout off
[[ ! -e $flag/active ]] || fail "active survived rws-brownout off"
st=$(cache_control /data/v1/stations.json)
grep -qE 'max-age=300([^0-9]|$)' <<<"$st" || fail "stations.json after the brownout: '$st' (want max-age=300 at once: Caddy caches nothing)"
proof "without the flag stations.json is back to '${st#*: }' at once"
wait_for "meta.json to lose brownout" 180 meta_is false
systemctl disable --now rws-brownout.timer
proof "rws-brownout off removes the flag, meta.json drops brownout, the timer is disabled again"
