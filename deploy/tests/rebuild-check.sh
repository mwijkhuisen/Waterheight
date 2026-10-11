#!/usr/bin/env bash
# rebuild-check.sh [owner]: the guard rails of a rebuild drill VPS, then the Q7 gap check (issue #27 P12b, E3;
# docs/runbooks/vps-rebuild.md). Run it ON the drill VPS, as root (sudo), after the rebuild:
#
#   sudo /usr/local/lib/rws/deploy/tests/rebuild-check.sh <drill hostname> [--production <domain>]
#
# The drill is a copy of production that must never act like production. A FAIL here means the drill
# can ping the production alerts, deploy, back up into the production bucket, answer to the owner's WireGuard
# address, be indexed, or spend the capture budget of CH-1 and NL-1 (the RWS and LINDAS limits are shared with
# production); or that the rebuild left a gap in a source whose provider window is 7 days or more.
#
#   domain        rws.env names the drill hostname the check was given (and not the --production one)
#   noindex       https://<host>/ answers X-Robots-Tag noindex (the prelaunch phase is forced on the drill)
#   timers        rws-backup, rws-update and rws-restore-drill timers are disabled or masked, and not active
#   pings         /etc/rws/secrets/hc_ping_key and hc_api_key are absent or empty (no healthchecks ping can go out)
#   owner port    nothing listens on 10.66.0.1:443 (TCP) or on UDP 51820 (WireGuard)
#   bucket key    a restic write with the host's bucket key is refused as S3 AccessDenied (SKIP when no key is
#                 configured, or unless the domain row passed and --production was given)
#   capture skip  RWS_CAPTURE_SKIP covers CH-1 and NL-1, and /status/capture.json lists no spec of theirs
#   q7 <ID>       the Q7 coverage gaps of /api/v1/health/sources: none for each source of Q7_SOURCES the drill captures
#
# It prints a table (check, result, detail) and exits 1 when any row is FAIL; SKIP rows do not fail but the owner
# reads their reason. It prints counts, instants and fixed words only: never a key, a URL with a key, or a payload.
# The bucket-key probe runs `restic init` against a sibling repository prefix; a key that CAN write leaves one small
# object there (Object Lock keeps it 30 days) and the row says FAIL: replace the key with a read-only one. Review SR-6:
# it runs only when this host is shown not to be production (the domain row passed AND --production <domain> was
# given), so it can never write into the bucket from production itself. Only S3's AccessDenied counts as a refusal
# (review CR-7: restic prints minio-go's "Access Denied." or the code AccessDenied); any other error, a local
# "permission denied" included (that is the host's cache or files, not the bucket), is FAIL: read-only not proved.
#
# Exit: 0 all PASS or SKIP, 1 a FAIL, 64 usage.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/bin/rws-lib.sh
. "$here/../bin/rws-lib.sh"

# The sources the Q7 criterion judges on the drill: public, captured by the drill, and with a provider window of
# 7 days or more (docs/drills/rebuild-timing-sheet.md says how this list is derived). CH-1 and NL-1 have such a
# window too but are skipped on the drill (RWS_CAPTURE_SKIP) and are not judged.
readonly Q7_SOURCES=(DE-1 DE-7 FR-1 LU-1)
readonly MUST_SKIP=(CH-1 NL-1)
readonly TIMERS=(rws-backup.timer rws-update.timer rws-restore-drill.timer)
readonly HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'

usage() {
  echo "usage: rebuild-check.sh <drill hostname> [--production <domain>]" >&2
  exit 64
}
host=${1:-} production=''
[[ $host =~ $HOST_RE ]] || usage
shift
while (($#)); do
  case $1 in
    --production)
      [[ ${2:-} =~ $HOST_RE ]] || usage
      production=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
for tool in curl jq ss systemctl awk; do
  command -v "$tool" >/dev/null || die "$tool is needed"
done
[[ $RWS_ETC != /etc/rws || $EUID == 0 ]] || die "run as root (sudo): the secrets directory is root-only"

rows=() failed=0 domain_ok=0
# row <check> <PASS|FAIL|SKIP> <detail>
row() {
  rows+=("$(printf '%-30s %-6s %s' "$1" "$2" "$3")")
  [[ $2 != FAIL ]] || failed=$((failed + 1))
}
# fetch <path>: the body of https://<host><path> on stdout; nothing is printed on failure.
fetch() { curl --proto '=https' --tlsv1.2 -fsS --max-time 30 "https://$host$1" 2>/dev/null; }

env_ok=0
if load_env 2>/dev/null; then env_ok=1; fi

# --- domain
if ((!env_ok)); then
  row domain FAIL "rws.env is missing, unreadable or malformed"
elif [[ -n $production && $host == "$production" ]]; then
  row domain FAIL "the hostname is production's (--production): this check is for the drill only"
elif [[ ${RWS_DOMAIN:-} != "$host" ]]; then
  row domain FAIL "rws.env RWS_DOMAIN is not the drill hostname"
else
  row domain PASS "RWS_DOMAIN is the drill hostname"
  domain_ok=1
fi

# --- noindex (and the prelaunch phase)
headers=$(curl --proto '=https' --tlsv1.2 -sS -I --max-time 15 "https://$host/" 2>/dev/null || true)
if [[ ${RWS_SITE_PHASE:-} != prelaunch ]]; then
  # Unset follows the compose default, which is launch after E4: the drill must pin it.
  row noindex FAIL "RWS_SITE_PHASE=prelaunch is not pinned in the drill's rws.env"
elif grep -qiE '^x-robots-tag:.*noindex' <<<"$headers"; then
  row noindex PASS "X-Robots-Tag noindex on /"
else
  row noindex FAIL "no X-Robots-Tag noindex on / (or the site does not answer)"
fi

# --- timers
for unit in "${TIMERS[@]}"; do
  state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  [[ $state =~ ^[a-z-]{1,24}$ ]] || state=unknown
  [[ $active =~ ^[a-z-]{1,24}$ ]] || active=unknown
  case $state in
    disabled | masked | masked-runtime | not-found)
      if [[ $active == active ]]; then
        row "timer $unit" FAIL "$state but active"
      else
        row "timer $unit" PASS "$state, $active"
      fi
      ;;
    *) row "timer $unit" FAIL "$state (must be disabled or masked)" ;;
  esac
done

# --- healthchecks secrets (their absence is what keeps every ping and the hc-sync off)
leaked=''
for name in hc_ping_key hc_api_key; do
  [[ ! -s $RWS_ETC/secrets/$name ]] || leaked+="$name "
done
if [[ -z $leaked ]]; then
  row pings PASS "hc_ping_key and hc_api_key are absent or empty"
else
  row pings FAIL "not empty: ${leaked% }"
fi

# --- no owner port
listeners=$(ss -H -tuln 2>/dev/null || true)
bad=$(awk '($1 ~ /^tcp/ && $5 == "10.66.0.1:443") { print "tcp 10.66.0.1:443" } ($1 ~ /^udp/ && $5 ~ /:51820$/) { print "udp 51820" }' <<<"$listeners")
if [[ -z $bad ]]; then
  row "owner port" PASS "nothing on 10.66.0.1:443 or UDP 51820"
else
  row "owner port" FAIL "listening: $(tr '\n' ',' <<<"$bad" | sed 's/,$//')"
fi

# --- bucket key is read-only
bucket=''
if ((env_ok)); then bucket=$(backup_ready 2>/dev/null && printf '%s' "$BUCKET_HOST") || bucket=''; fi
if [[ -z $bucket || ! -s $RWS_ETC/secrets/s3_credentials ]]; then
  row "bucket key" SKIP "no bucket key configured here (RWS_BACKUP off or s3_credentials empty): read-only not proved"
elif [[ -z $production ]]; then
  row "bucket key" SKIP "probe not run without --production <domain> (it must not write from production): read-only not proved"
elif ((!domain_ok)); then
  row "bucket key" SKIP "probe not run: the domain row did not pass, so this may be production: read-only not proved"
else
  rc=0
  (allow_bucket "$bucket") >/dev/null 2>&1 || rc=$?
  if ((rc != 0)); then
    row "bucket key" FAIL "the bucket address could not be allowed: probe not run"
  else
    out=$(rws_compose run --rm --no-deps -T -e "RESTIC_REPOSITORY=${RWS_RESTIC_REPOSITORY}-write-probe" backup init 2>&1) && rc=0 || rc=$?
    if ((rc == 0)); then
      row "bucket key" FAIL "the key CAN write (a probe repository was created): use a read-only key"
    elif grep -qE '(^|[^A-Za-z])(AccessDenied|Access Denied\.)' <<<"$out"; then
      row "bucket key" PASS "a restic write was refused (S3 AccessDenied)"
    else
      row "bucket key" FAIL "the write failed, but not as a refusal: read-only not proved"
    fi
  fi
fi

# --- capture skip: configured, and effective in the running capture
skip=''
if ((env_ok)); then skip=${RWS_CAPTURE_SKIP:-}; fi
missing=''
for id in "${MUST_SKIP[@]}"; do
  [[ ",$skip," == *",$id,"* ]] || missing+="$id "
done
if [[ -z $missing ]]; then
  row "capture skip (env)" PASS "RWS_CAPTURE_SKIP covers ${MUST_SKIP[*]}"
else
  row "capture skip (env)" FAIL "RWS_CAPTURE_SKIP does not cover ${missing% }"
fi
if specs=$(fetch /status/capture.json | jq -r '.specs[].spec' 2>/dev/null) && [[ -n $specs ]]; then
  running=''
  for id in "${MUST_SKIP[@]}"; do
    pat="^${id,,}-"
    ! grep -q "$pat" <<<"$specs" || running+="$id "
  done
  if [[ -z $running ]]; then
    row "capture skip (running)" PASS "capture.json lists no spec of ${MUST_SKIP[*]} ($(wc -l <<<"$specs") specs)"
  else
    row "capture skip (running)" FAIL "capture.json still lists specs of ${running% }"
  fi
else
  row "capture skip (running)" FAIL "no /status/capture.json specs (capture not running, or the site does not answer)"
fi

# --- Q7 gap check
doc=$(fetch /api/v1/health/sources || true)
for id in "${Q7_SOURCES[@]}"; do
  if [[ ",$skip," == *",$id,"* ]]; then
    row "q7 $id" SKIP "skipped on this drill (RWS_CAPTURE_SKIP): not judged"
    continue
  fi
  n=$(jq -r --arg id "$id" '[.sources[] | select(.id == $id)] | if length == 0 then "absent" else (.[0].coverage | if . == null then "null" else (.gaps | length | tostring) end) end' <<<"$doc" 2>/dev/null) || n=''
  if [[ -z $n ]]; then
    row "q7 $id" FAIL "/api/v1/health/sources unreadable"
  elif [[ $n == 0 ]]; then
    row "q7 $id" PASS "0 coverage gaps"
  elif [[ $n =~ ^[0-9]+$ ]]; then
    newest=$(jq -r --arg id "$id" '[.sources[] | select(.id == $id) | .coverage.gaps[]?] | max_by(.to) | "\(.from) to \(.to)"' <<<"$doc" 2>/dev/null || true)
    row "q7 $id" FAIL "$n coverage gaps, the newest from ${newest:-?}"
  else
    row "q7 $id" FAIL "no coverage yet ($n): the loader has not caught up"
  fi
done

printf '%-30s %-6s %s\n' CHECK RESULT DETAIL
printf '%s\n' "${rows[@]}"
if ((failed > 0)); then
  echo "rebuild-check: $failed FAIL"
  exit 1
fi
echo "rebuild-check: all rows PASS or SKIP (read the SKIP reasons)"
