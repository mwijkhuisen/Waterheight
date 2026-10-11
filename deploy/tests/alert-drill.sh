#!/usr/bin/env bash
# alert-drill.sh (owner-run on the VPS; P12b, issue #27; A§11.3): proves that every healthchecks.io alert reaches
# the owner. For each slug of deploy/healthchecks.yaml it sends a synthetic /fail ping, holds, then sends a
# success ping per slug to restore the check. It induces no real outage (stopping capture would leave data gaps)
# and touches no service: only pings. A trap restores every check it failed on any exit, an interrupted drill
# included. Prints a receipt table on stdout; the owner fills in the last column.
#
# Run it only when the healthchecks.io dashboard is all green: the restoring success ping turns a check up again,
# so a real outage of the same check would stay hidden until timeout + grace has passed (docs/ops/alert-tuning.md).
# The script does not read the dashboard.
#
# The ping key reaches curl through a config on stdin, never argv (as `ping` in deploy/bin/rws-lib.sh does) and is
# never printed. RWS_PING_SLUGS of `ping` cannot reach cap-* or load, so this script sends its own requests.
#
# Usage: sudo deploy/tests/alert-drill.sh [--hold SECONDS] [--only SLUG]
#        deploy/tests/alert-drill.sh --dry-run --hc-base http://127.0.0.1:PORT [--hold SECONDS] [--only SLUG]
#   --hold      seconds between the /fail pings and the restoring pings (default 60)
#   --only      one slug of the list
#   --dry-run   no real pings: needs --hc-base, a loopback http stub (the offline test); the key is the secret's
#               when there is one, else a fake
# Exit: 0 all pings sent; 1 a ping failed (the restore still ran); 64 usage.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/bin/rws-lib.sh
. "$here/../bin/rws-lib.sh"

list=$here/../healthchecks.yaml
base=https://hc-ping.com hold=60 only='' dry=0 custom_base=0
usage() {
  echo "usage: alert-drill.sh [--hold SECONDS] [--only SLUG] | --dry-run --hc-base http://127.0.0.1:PORT [...]" >&2
  exit 64
}
while (($#)); do
  case $1 in
    --dry-run) dry=1 ;;
    --hc-base)
      (($# >= 2)) || usage
      base=$2 custom_base=1
      shift
      ;;
    --hold)
      (($# >= 2)) && [[ $2 =~ ^[0-9]{1,4}$ ]] || usage
      hold=$2
      shift
      ;;
    --only)
      (($# >= 2)) && [[ $2 =~ ^[a-z0-9-]{1,40}$ ]] || usage
      only=$2
      shift
      ;;
    *) usage ;;
  esac
  shift
done
# A stub base only with --dry-run, and only on loopback: nothing else can be pinged by mistake.
if ((dry || custom_base)); then
  ((dry && custom_base)) || usage
  [[ $base =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]] || die "--hc-base must be http://127.0.0.1:PORT"
fi

# The slugs, validated like deploy/bin/rws-hc-sync does.
mapfile -t slugs < <(grep -v '^[[:space:]]*#' "$list" | jq -r '.checks[].slug | select(test("^[a-z0-9-]{1,40}$"))') ||
  die "$list does not parse"
((${#slugs[@]} > 0)) || die "no slugs in $list"
if [[ -n $only ]]; then
  printf '%s\n' "${slugs[@]}" | grep -qxF -- "$only" || die "--only: $only is not in healthchecks.yaml"
  slugs=("$only")
fi

if ! key=$(secret hc_ping_key) || ! [[ $key =~ ^[A-Za-z0-9_-]{16,64}$ ]]; then
  ((dry)) || die "no usable hc_ping_key in $RWS_ETC/secrets (run as root)"
  key=dryrun-fake-key-0123456789
fi

curl_proto=(--proto '=https')
((!dry)) || curl_proto=()

# send <slug> [fail]: one ping; the body is a fixed code, never tool output.
send() {
  printf 'url = "%s/%s/%s%s"\n' "$base" "$key" "$1" "${2:+/$2}" |
    curl -K - "${curl_proto[@]}" -fsS --max-time 10 --retry 2 -o /dev/null --data-raw "alert_drill${2:+_$2}"
}

declare -A fail_at ok_at
to_restore=() hold_pid='' rc=0 restored=0
restore() {
  local slug
  ((restored)) && return 0
  restored=1
  [[ -z $hold_pid ]] || kill "$hold_pid" 2>/dev/null || true
  for slug in "${to_restore[@]}"; do
    if send "$slug"; then ok_at[$slug]=$(now_iso); else
      log "restore ping for $slug failed: check its state in healthchecks.io"
      rc=1
    fi
  done
}
# shellcheck disable=SC2329 # called by finish, the EXIT trap
receipt() {
  local slug
  printf '| slug | /fail sent UTC | success sent UTC | alert received (owner) |\n|---|---|---|---|\n'
  for slug in "${slugs[@]}"; do
    printf '| %s | %s | %s | [ ] |\n' "$slug" "${fail_at[$slug]:--}" "${ok_at[$slug]:--}"
  done
}
# shellcheck disable=SC2329 # the EXIT trap
finish() {
  local status=$?
  trap - EXIT
  restore
  receipt
  ((status != 0)) || status=$rc
  exit "$status"
}
trap 'finish' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

for slug in "${slugs[@]}"; do
  to_restore+=("$slug") # before the request: a /fail that got through but whose answer was lost is restored too
  send "$slug" fail || die "/fail ping for $slug failed"
  fail_at[$slug]=$(now_iso)
  log "/fail sent: $slug"
done
log "all /fail pings sent; holding $hold s for the alerts, then restoring (Ctrl-C restores at once)"
# wait, not a foreground sleep: bash runs a trap only after a foreground command returns.
sleep "$hold" &
hold_pid=$!
wait "$hold_pid" || true
hold_pid=''
restore
exit "$rc"
