#!/usr/bin/env bash
# CI only (P12a; .github/workflows/loadtest.yml; as root): runs k6.js as one process per client address in the client
# namespace `ext` (the stack's coordinates come from /ci/loadtest.env, written by deploy/tests/e2e/run.sh), waits for all,
# prints the tail of every log and exits non-zero when any process failed (a breached threshold included).
#   run-k6.sh <k6 binary> <out dir> [NAME=value ...]
# The NAME=value pairs go to every k6 process (SCENARIO, DURATION, LENIENT, MAP_ASSETS, ...; see k6.js). ABUSER_INDEX=n
# makes process n run SCENARIO=abusive (with ABUSE_ROTATE if given) while the others run SCENARIO=normal; it is no k6
# variable. Why a namespace: a request from the host to a published port is masqueraded to the bridge gateway, which
# the limiter keys as one shared client; from `ext` every address is seen as itself.
set -euo pipefail

(($# >= 2)) || {
  echo "usage: run-k6.sh <k6 binary> <out dir> [NAME=value ...]" >&2
  exit 64
}
k6=$1 out=$2
shift 2
((EUID == 0)) || {
  echo "run-k6: run as root (ip netns)" >&2
  exit 1
}
[[ -x $k6 ]] || {
  echo "run-k6: $k6 is not executable" >&2
  exit 1
}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

kv=() abuser=''
for a in "$@"; do
  [[ $a =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9_.:/@,-]*$ ]] || {
    echo "run-k6: bad argument '$a'" >&2
    exit 64
  }
  case $a in
    ABUSER_INDEX=*) abuser=${a#*=} ;;
    *) kv+=("$a") ;;
  esac
done

set -a
# shellcheck source=/dev/null
. /ci/loadtest.env
set +a
IFS=, read -r -a ips <<<"$RWS_E2E_CLIENT_IPS"
((${#ips[@]} >= 1)) || {
  echo "run-k6: no client addresses" >&2
  exit 1
}
if [[ -n $abuser ]]; then
  [[ $abuser =~ ^[0-9]+$ ]] || {
    echo "run-k6: ABUSER_INDEX is not a number" >&2
    exit 64
  }
  ((abuser < ${#ips[@]})) || {
    echo "run-k6: ABUSER_INDEX out of range" >&2
    exit 64
  }
fi
install -d -m 0755 "$out"

pids=()
for i in "${!ips[@]}"; do
  role=()
  if [[ -n $abuser ]]; then
    if [[ $i == "$abuser" ]]; then role=(SCENARIO=abusive); else role=(SCENARIO=normal); fi
  fi
  ip netns exec "$RWS_E2E_CLIENT_NETNS" env SSL_CERT_FILE="$RWS_E2E_CA" BASE="https://$RWS_E2E_DOMAIN" \
    CADDY_IP="$RWS_E2E_CADDY_IP" CLIENT="$i" CLIENTS="${#ips[@]}" OUT_DIR="$out" "${kv[@]}" "${role[@]}" \
    "$k6" run --quiet --no-color --local-ips "${ips[$i]}" "$here/k6.js" >"$out/k6-$i.log" 2>&1 &
  pids+=($!)
done
rc=0
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || {
    echo "run-k6: client $i exited non-zero" >&2
    rc=1
  }
done
for i in "${!ips[@]}"; do
  echo "== client $i (${ips[$i]})"
  tail -n 25 "$out/k6-$i.log"
done
chmod -R a+rX "$out"
exit "$rc"
