#!/usr/bin/env bash
# verify-owner.sh: the owner's check of the owner site over WireGuard (P12a, issue #27 criterion 11; ADR-0017,
# docs/runbooks/owner-exposure.md). Run it ON AN OWNER DEVICE with the tunnel up. Nobody else runs it; no agent has
# a tunnel. Prints one PASS/FAIL line per check, exits 1 on any FAIL; attach the output (without the password,
# which it never prints) to issue #27 together with `sudo wg show wg0` and `sudo rws-wg-peer list` from the VPS.
#
# Usage: scripts/verify-owner.sh <domain> [--cacert <caddy-owner root.crt>] [--password-file <file>]
#                                [--address 10.66.0.1] [--max-age-min 180] [--skip-tunnel-down]
#   The password is read from a prompt (no echo) or from the file you name; it never appears in argv, the
#   environment or the output (curl gets it on stdin). --cacert: the root CA exported from the VPS
#   (docs/runbooks/owner-device.md); without it the system store must already trust it.
#   --skip-tunnel-down skips the interactive "tunnel down" check (it then prints SKIP and exits 1: the criterion
#   needs that check once).
# Needs: bash, curl, jq.
set -euo pipefail
umask 077

usage() {
  sed -n '/^# Usage/,/^# Needs/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}

domain=${1:-}
[[ $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || usage
shift
cacert='' pwfile='' address=10.66.0.1 max_age=180 skip_down=0
while (($#)); do
  case $1 in
    --cacert) cacert=${2:?}; shift 2 ;;
    --password-file) pwfile=${2:?}; shift 2 ;;
    --address) address=${2:?}; shift 2 ;;
    --max-age-min) max_age=${2:?}; shift 2 ;;
    --skip-tunnel-down) skip_down=1; shift ;;
    *) usage ;;
  esac
done
[[ $address =~ ^[0-9.]{7,15}$ && $max_age =~ ^[0-9]{1,5}$ ]] || usage
host=owner.$domain
canary_re='777777\.(777|75)'

if [[ -n $pwfile ]]; then
  [[ -r $pwfile ]] || { echo "cannot read $pwfile" >&2; exit 64; }
  IFS= read -r password <"$pwfile"
else
  read -r -s -p "owner password for $host: " password
  echo >&2
fi
[[ -n $password && $password != *'"'* && $password != *\\* ]] || { echo "the password is empty or holds a quote or backslash" >&2; exit 64; }

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
fails=0
pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  fails=$((fails + 1))
}

# req <auth: yes|no> <path> [curl args]: body in $tmp/body, headers (lower-cased, CR removed) in $tmp/head, status in $code.
code=''
req() {
  local auth=$1 path=$2
  shift 2
  local -a args=(-sS --max-time 20 --resolve "$host:443:$address" -o "$tmp/body" -D "$tmp/head.raw" -w '%{http_code}')
  [[ -z $cacert ]] || args+=(--cacert "$cacert")
  if [[ $auth == yes ]]; then
    code=$(printf 'user = "owner:%s"\n' "$password" | curl "${args[@]}" -K - "$@" "https://$host$path") || code=000
  else
    code=$(curl "${args[@]}" "$@" "https://$host$path") || code=000
  fi
  tr -d '\r' <"$tmp/head.raw" 2>/dev/null | tr '[:upper:]' '[:lower:]' >"$tmp/head" || : >"$tmp/head"
}
owner_headers() { grep -qx 'cache-control: private, no-store' "$tmp/head" && grep -qx 'x-robots-tag: noindex, nofollow' "$tmp/head"; }

# 1. 401 without credentials, 200 with them, both owner headers on every response.
req no /
if [[ $code == 401 ]] && owner_headers; then pass "/ without credentials: 401 with Cache-Control private, no-store and X-Robots-Tag noindex, nofollow"; else fail "/ without credentials: $code (expected 401 with both owner headers)"; fi
req yes /
if [[ $code == 200 ]]; then pass "/ with credentials: 200"; else fail "/ with credentials: $code"; fi
for path in / /runtime-config.json /data/v1/meta.json /data/v1/latest.json /data/v1/stations.json /api/v1/meta /api/v1/health/sources /missing-page; do
  for auth in no yes; do
    req "$auth" "$path"
    if owner_headers; then pass "$path (credentials: $auth): $code, both owner headers"; else fail "$path (credentials: $auth): $code, an owner header is missing"; fi
  done
done

# 2. The audience says owner (which switches the banner on).
req yes /runtime-config.json
if [[ $code == 200 ]] && jq -e '.audience == "owner"' "$tmp/body" >/dev/null 2>&1; then pass "/runtime-config.json reads audience owner"; else fail "/runtime-config.json: $code, audience is not owner"; fi

# 3. The owner canary in the owner data files and in the owner API.
req yes /data/v1/latest.json
if [[ $code == 200 ]] && grep -qE "$canary_re" "$tmp/body"; then pass "the owner canary is in /data/v1/latest.json"; else fail "no owner canary in /data/v1/latest.json ($code)"; fi
req yes /api/v1/snapshot
if [[ $code == 200 ]] && grep -qE "$canary_re" "$tmp/body"; then pass "the owner canary is in the owner API (/api/v1/snapshot)"; else fail "no owner canary in /api/v1/snapshot ($code)"; fi

# 4. BE-3, LU-3 and LU-4 are fresh in the owner status.
req yes /api/v1/health/sources
now=$(date -u +%s)
if [[ $code == 200 ]] && jq -e . "$tmp/body" >/dev/null 2>&1; then
  for id in BE-3 LU-3 LU-4; do
    row=$(jq -c --arg id "$id" '[.sources[] | select(.id == $id)][0] // empty' "$tmp/body")
    if [[ -z $row ]]; then fail "$id is not in the owner status"; continue; fi
    status=$(jq -r .status <<<"$row")
    seen=$(jq -r '.last_new_data // empty' <<<"$row")
    age=''
    [[ -z $seen ]] || age=$((now - $(date -u -d "$seen" +%s)))
    if [[ $status == ok && -n $age ]] && ((age <= max_age * 60)); then
      pass "$id: status ok, new data $((age / 60)) min ago (limit $max_age min)"
    else
      fail "$id: status $status, new data ${age:+$((age / 60)) min ago}${age:-never} (limit $max_age min)"
    fi
  done
else
  fail "/api/v1/health/sources: $code, not a JSON answer"
fi

# 5. The device's own view, informational.
if command -v wg >/dev/null 2>&1; then echo "--- wg show (this device)"; wg show 2>&1 | sed 's/^\( *preshared key:\).*/\1 (hidden)/' || true; fi
echo "--- on the VPS, attach: sudo wg show wg0 && sudo rws-wg-peer list   (only your own devices may be listed)"

# 6. With the tunnel down the name is unreachable.
if ((skip_down)); then
  echo "SKIP the tunnel-down check (--skip-tunnel-down): the criterion needs it once"
  fails=$((fails + 1))
else
  read -r -p "Now bring the WireGuard tunnel DOWN on this device, then press Enter: " _
  rc=0
  curl -sS --max-time 8 --connect-timeout 6 -o /dev/null --resolve "$host:443:$address" ${cacert:+--cacert "$cacert"} "https://$host/" 2>/dev/null || rc=$?
  if ((rc == 28 || rc == 7)); then pass "with the tunnel down, $host (-> $address) is unreachable (curl exit $rc)"; else fail "with the tunnel down, $host answered or failed oddly (curl exit $rc)"; fi
  echo "Bring the tunnel up again."
fi

echo "verify-owner: $fails failure(s)"
((fails == 0))
