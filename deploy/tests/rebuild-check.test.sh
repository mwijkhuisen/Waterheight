#!/usr/bin/env bash
# Offline test of rebuild-check.sh (issue #27 P12b, E3): one passing drill VPS and one case for each way a
# row can FAIL or SKIP. curl, systemctl, ss, docker, nft and getent are stubs driven by files in $FIX (the
# state of the drill VPS: headers, unit states, listeners, restic's answer, the two JSON documents);
# jq is real. No network, no root, no provider.
# Usage: deploy/tests/rebuild-check.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
readonly ORIG_PATH=$PATH
readonly DRILL=drill.example.org
readonly SECRET=testSecretValue_0123456789
failures=0 labels=0

# ---------------------------------------------------------------- stubs
mkdir -p "$T/stubs"
cat >"$T/stubs/curl" <<'STUB'
#!/usr/bin/env bash
# -I: the headers of $FIX/headers. Otherwise the body of the path: $FIX/capture.json or $FIX/sources.json.
printf 'curl %s\n' "$*" >>"$FIX/calls"
[[ ! -e $FIX/curl-down ]] || exit 7
headers=0 url=''
for a in "$@"; do
  case $a in
    -I) headers=1 ;;
    https://*) url=$a ;;
  esac
done
if ((headers)); then cat "$FIX/headers"; exit 0; fi
case $url in
  */status/capture.json) cat "$FIX/capture.json" ;;
  */api/v1/health/sources) cat "$FIX/sources.json" ;;
  *) exit 22 ;;
esac
STUB
cat >"$T/stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$FIX/calls"
case $1 in
  is-enabled) cat "$FIX/enabled.$2" 2>/dev/null || echo disabled ;;
  is-active) cat "$FIX/active.$2" 2>/dev/null || echo inactive ;;
esac
STUB
cat >"$T/stubs/ss" <<'STUB'
#!/usr/bin/env bash
cat "$FIX/ss"
STUB
cat >"$T/stubs/nft" <<'STUB'
#!/usr/bin/env bash
printf 'nft %s\n' "$*" >>"$FIX/calls"
cat >/dev/null
STUB
cat >"$T/stubs/getent" <<'STUB'
#!/usr/bin/env bash
case $1 in
  ahostsv4) printf '192.0.2.10 STREAM %s\n' "$2" ;;
  ahostsv6) ;;
esac
STUB
cat >"$T/stubs/docker" <<'STUB'
#!/usr/bin/env bash
# `compose ... run ... backup init`: restic's answer is $FIX/restic (denied | denied-code | allowed | forbidden |
# local-denied | other).
printf 'docker %s\n' "$*" >>"$FIX/calls"
case " $* " in
  *" backup init "*)
    case $(cat "$FIX/restic") in
      denied) echo "Fatal: create repository failed: Access Denied. (secret $SECRET_FOR_TEST must never be printed)" >&2; exit 1 ;;
      denied-code) echo "Fatal: create repository failed: client.PutObject: AccessDenied" >&2; exit 1 ;;
      allowed) echo "created restic repository"; exit 0 ;;
      forbidden) echo "Fatal: create repository failed: 403 Forbidden (a proxy page)" >&2; exit 1 ;;
      local-denied) echo "Fatal: unable to create cache dir: mkdir /cache/restic: permission denied" >&2; exit 1 ;;
      *) echo "Fatal: dial tcp: lookup failed" >&2; exit 1 ;;
    esac
    ;;
esac
STUB
chmod +x "$T/stubs"/*

# ---------------------------------------------------------------- fixtures
sources_doc() {
  jq -cn '{generated_at: "2026-10-12T12:00:00Z", sources: [
    {id: "DE-1", coverage: {from: "2026-08-01T00:00:00Z", ratio: 1, series: 3, series_below_95: 0, gaps: []}},
    {id: "DE-7", coverage: {from: "2026-08-01T00:00:00Z", ratio: 1, series: 3, series_below_95: 0, gaps: []}},
    {id: "FR-1", coverage: {from: "2026-08-01T00:00:00Z", ratio: 1, series: 3, series_below_95: 0, gaps: []}},
    {id: "LU-1", coverage: {from: "2026-08-01T00:00:00Z", ratio: 1, series: 3, series_below_95: 0, gaps: []}},
    {id: "NL-2", coverage: null}]}'
}
setup() {
  C=$(mktemp -d "$T/case.XXXX")
  mkdir -p "$C"/{state/releases/r,etc/secrets,fix,lock}
  ln -s releases/r "$C/state/active"
  export FIX=$C/fix RWS_STATE_DIR=$C/state RWS_ETC=$C/etc RWS_SRV=$C/srv RWS_LOCK_DIR=$C/lock SECRET_FOR_TEST=$SECRET
  export PATH=$T/stubs:$ORIG_PATH
  cat >"$C/etc/rws.env" <<EOF
RWS_DOMAIN=$DRILL
RWS_BACKUP=on
RWS_RESTIC_REPOSITORY=s3:https://s3.bucket.example/rws-raw/restic
RWS_CAPTURE_SKIP=CH-1,NL-1
EOF
  : >"$C/etc/secrets/hc_ping_key"
  printf '[default]\naws_access_key_id = %s\n' "$SECRET" >"$C/etc/secrets/s3_credentials"
  printf 'HTTP/2 200\r\nserver: Caddy\r\nx-robots-tag: noindex\r\n\r\n' >"$FIX/headers"
  printf 'tcp LISTEN 0 4096 192.0.2.1:443 0.0.0.0:*\nudp UNCONN 0 0 192.0.2.1:443 0.0.0.0:*\n' >"$FIX/ss"
  echo denied >"$FIX/restic"
  echo '{"specs":[{"spec":"de-1-series"},{"spec":"nl-2-wfs"},{"spec":"ch-2-pq"}]}' >"$FIX/capture.json"
  sources_doc >"$FIX/sources.json"
  touch "$FIX/calls"
}
run() {
  rc=0
  "$here/rebuild-check.sh" "$@" >"$C/out" 2>&1 || rc=$?
}
fail() {
  echo "  FAIL: $*" >&2
  sed 's/^/  | /' "$C/out" >&2
  failures=$((failures + 1))
}
expect_rc() { [[ $rc == "$1" ]] || fail "exit $rc, expected $1"; }
expect_row() { grep -qE -- "^$1 +$2 " "$C/out" || fail "no row '$1' with result $2"; }
expect_grep() { grep -qE -- "$1" "$C/out" || fail "no line matching /$1/"; }
expect_no_grep() { ! grep -qE -- "$1" "$C/out" || fail "unexpected /$1/"; }
case_() {
  labels=$((labels + 1))
  printf 'case %s\n' "$*"
}
# fails_only <check>: exit 1, and that row is the only FAIL.
fails_only() {
  expect_rc 1
  expect_row "$1" FAIL
  [[ $(grep -cE ' FAIL ' "$C/out") == 1 ]] || fail "expected exactly one FAIL row"
}

# ---------------------------------------------------------------- cases
case_ "a drill VPS as the runbook leaves it: every row PASS, exit 0"
setup
run "$DRILL" --production prod.example.org
expect_rc 0
for c in domain noindex "timer rws-backup.timer" "timer rws-update.timer" "timer rws-restore-drill.timer" pings \
  "owner port" "bucket key" "capture skip \(env\)" "capture skip \(running\)" "q7 DE-1" "q7 DE-7" "q7 FR-1" "q7 LU-1"; do
  expect_row "$c" PASS
done
expect_grep "all rows PASS or SKIP"
grep -q -- "-write-probe backup init" "$FIX/calls" || fail "the restic write probe did not run"
expect_no_grep "$SECRET"

case_ "no secret value, key or probe output reaches the table (the restic error carried one)"
setup
echo "$SECRET" >"$C/etc/secrets/hc_api_key"
run "$DRILL"
expect_no_grep "$SECRET"
expect_no_grep "aws_access_key_id"
expect_row pings FAIL

case_ "usage: no hostname, a bad hostname, an unknown flag, --production without a value: exit 64"
setup
run
expect_rc 64
run "not a host"
expect_rc 64
run "$DRILL" --nope
expect_rc 64
run "$DRILL" --production
expect_rc 64

case_ "domain: the hostname is production's, or rws.env names another domain"
setup
run "$DRILL" --production "$DRILL"
fails_only domain
setup
run other.example.org
expect_rc 1
expect_row domain FAIL

case_ "domain: no rws.env at all"
setup
rm "$RWS_ETC/rws.env"
run "$DRILL"
expect_rc 1
expect_row domain FAIL
expect_row "bucket key" SKIP
expect_row "capture skip \\(env\\)" FAIL

case_ "noindex: the header is missing, or the site does not answer"
setup
printf 'HTTP/2 200\r\nserver: Caddy\r\n\r\n' >"$FIX/headers"
run "$DRILL"
fails_only noindex
setup
touch "$FIX/curl-down"
run "$DRILL"
expect_rc 1
expect_row noindex FAIL
expect_row "capture skip \\(running\\)" FAIL
expect_row "q7 DE-1" FAIL

case_ "noindex: the launch phase on a drill fails even with the header"
setup
echo RWS_SITE_PHASE=launch >>"$RWS_ETC/rws.env"
run "$DRILL"
fails_only noindex

case_ "timers: enabled fails, masked and disabled pass, an active disabled timer fails"
for unit in rws-backup.timer rws-update.timer rws-restore-drill.timer; do
  setup
  echo enabled >"$FIX/enabled.$unit"
  run "$DRILL"
  fails_only "timer $unit"
  setup
  echo masked >"$FIX/enabled.$unit"
  run "$DRILL"
  expect_rc 0
  expect_row "timer $unit" PASS
  setup
  echo active >"$FIX/active.$unit"
  run "$DRILL"
  fails_only "timer $unit"
done

case_ "pings: a filled hc_ping_key, or a hc_api_key, fails; an absent hc_ping_key passes"
setup
echo "$SECRET" >"$C/etc/secrets/hc_ping_key"
run "$DRILL"
fails_only pings
expect_grep "hc_ping_key"
setup
rm "$C/etc/secrets/hc_ping_key"
run "$DRILL"
expect_rc 0

case_ "owner port: TCP on 10.66.0.1:443, or UDP 51820 (v4 or v6), fails; TCP 51820 and UDP 443 do not"
setup
echo 'tcp LISTEN 0 4096 10.66.0.1:443 0.0.0.0:*' >>"$FIX/ss"
run "$DRILL"
fails_only "owner port"
setup
echo 'udp UNCONN 0 0 0.0.0.0:51820 0.0.0.0:*' >>"$FIX/ss"
run "$DRILL"
fails_only "owner port"
setup
echo 'udp UNCONN 0 0 [::]:51820 [::]:*' >>"$FIX/ss"
run "$DRILL"
fails_only "owner port"
setup
printf 'tcp LISTEN 0 1 192.0.2.1:51820 0.0.0.0:*\nudp UNCONN 0 0 10.66.0.1:443 0.0.0.0:*\n' >>"$FIX/ss"
run "$DRILL"
expect_rc 0

case_ "bucket key: a key that can write fails; a failure that is no refusal is not proof; no key is a SKIP"
setup
echo allowed >"$FIX/restic"
run "$DRILL" --production prod.example.org
fails_only "bucket key"
expect_grep "CAN write"
# CR-7: only S3's AccessDenied is a refusal; a 403 from something else, a local permission error or any other error is not
for answer in other forbidden local-denied; do
  setup
  echo "$answer" >"$FIX/restic"
  run "$DRILL" --production prod.example.org
  fails_only "bucket key"
  expect_grep "not proved"
done
setup
echo denied-code >"$FIX/restic"
run "$DRILL" --production prod.example.org
expect_rc 0
expect_row "bucket key" PASS
# SR-6: no probe without --production, or when the domain row did not pass (this may be production)
setup
run "$DRILL"
expect_rc 0
expect_row "bucket key" SKIP
expect_grep "without --production"
! grep -q "backup init" "$FIX/calls" || fail "the probe ran without --production"
setup
sed -i "s/^RWS_DOMAIN=.*/RWS_DOMAIN=prod.example.org/" "$RWS_ETC/rws.env"
run "$DRILL" --production prod.example.org
expect_rc 1
expect_row domain FAIL
expect_row "bucket key" SKIP
expect_grep "domain row did not pass"
! grep -q "backup init" "$FIX/calls" || fail "the probe ran although the domain row failed"
setup
run "$DRILL" --production "$DRILL"
expect_row "bucket key" SKIP
! grep -q "backup init" "$FIX/calls" || fail "the probe ran on the production hostname"
setup
: >"$C/etc/secrets/s3_credentials"
run "$DRILL" --production prod.example.org
expect_rc 0
expect_row "bucket key" SKIP
! grep -q "backup init" "$FIX/calls" || fail "restic ran without a key"
setup
sed -i 's/RWS_BACKUP=on/RWS_BACKUP=off/' "$RWS_ETC/rws.env"
run "$DRILL"
expect_rc 0
expect_row "bucket key" SKIP

case_ "capture skip: missing NL-1 or CH-1 in the env fails; unset fails; a spec of a skipped source in capture.json fails"
setup
sed -i 's/^RWS_CAPTURE_SKIP=.*/RWS_CAPTURE_SKIP=CH-1/' "$RWS_ETC/rws.env"
run "$DRILL"
fails_only "capture skip \\(env\\)"
expect_grep "does not cover NL-1"
setup
sed -i '/^RWS_CAPTURE_SKIP=/d' "$RWS_ETC/rws.env"
run "$DRILL"
fails_only "capture skip \\(env\\)"
setup
echo '{"specs":[{"spec":"de-1-series"},{"spec":"ch-1-lindas"},{"spec":"nl-1-fc-1h"}]}' >"$FIX/capture.json"
run "$DRILL"
fails_only "capture skip \\(running\\)"
expect_grep "specs of CH-1 NL-1"
setup
echo '{"specs":[]}' >"$FIX/capture.json"
run "$DRILL"
fails_only "capture skip \\(running\\)"

case_ "q7: a gap in a judged source fails with its count and newest instants; no coverage, an absent source or a bad document fail"
setup
jq -c '(.sources[] | select(.id == "FR-1") | .coverage.gaps) = [{from: "2026-10-12T01:00:00Z", to: "2026-10-12T02:00:00Z"}, {from: "2026-10-12T07:00:00Z", to: "2026-10-12T08:30:00Z"}]' "$FIX/sources.json" >"$FIX/s2" && mv "$FIX/s2" "$FIX/sources.json"
run "$DRILL"
fails_only "q7 FR-1"
expect_grep "2 coverage gaps, the newest from 2026-10-12T07:00:00Z to 2026-10-12T08:30:00Z"
setup
jq -c '(.sources[] | select(.id == "DE-7") | .coverage) = null' "$FIX/sources.json" >"$FIX/s2" && mv "$FIX/s2" "$FIX/sources.json"
run "$DRILL"
fails_only "q7 DE-7"
expect_grep "no coverage yet"
setup
jq -c '.sources |= map(select(.id != "LU-1"))' "$FIX/sources.json" >"$FIX/s2" && mv "$FIX/s2" "$FIX/sources.json"
run "$DRILL"
fails_only "q7 LU-1"
setup
echo 'not json' >"$FIX/sources.json"
run "$DRILL"
expect_rc 1
expect_row "q7 DE-1" FAIL

case_ "q7: a judged source skipped on this drill is a SKIP, not a pass and not a fail"
setup
sed -i 's/^RWS_CAPTURE_SKIP=.*/RWS_CAPTURE_SKIP=CH-1,NL-1,FR-1/' "$RWS_ETC/rws.env"
jq -c '(.sources[] | select(.id == "FR-1") | .coverage.gaps) = [{from: "2026-10-12T01:00:00Z", to: "2026-10-12T02:00:00Z"}]' "$FIX/sources.json" >"$FIX/s2" && mv "$FIX/s2" "$FIX/sources.json"
run "$DRILL"
expect_rc 0
expect_row "q7 FR-1" SKIP

case_ "the judged list of the script is the list of the timing sheet, and never holds CH-1 or NL-1"
sheet=$here/../../docs/drills/rebuild-timing-sheet.md
want=$(sed -n 's/^readonly Q7_SOURCES=(\(.*\))$/\1/p' "$here/rebuild-check.sh")
[[ -n $want ]] || { C=$T; : >"$T/out"; fail "no Q7_SOURCES in rebuild-check.sh"; }
if [[ -f $sheet ]]; then
  have=$(sed -n 's/^\*\*Judged sources:\*\* \([A-Z0-9, -]*\)\.$/\1/p' "$sheet" | tr -d ',' )
  [[ $have == "$want" ]] || { C=$T; : >"$T/out"; fail "timing sheet judges '$have', script '$want'"; }
fi
[[ " $want " != *" CH-1 "* && " $want " != *" NL-1 "* ]] || { C=$T; : >"$T/out"; fail "CH-1 or NL-1 is judged"; }

case_ "the runbook names rws-lib.sh's cosign identity and issuer, and every runbook, doc and script it names exists"
C=$T
: >"$T/out"
book=$here/../../docs/runbooks/vps-rebuild.md
lib=$here/../bin/rws-lib.sh
for var in RWS_IDENTITY RWS_ISSUER; do
  value=$(sed -n "s/^readonly $var='\\(.*\\)'$/\\1/p" "$lib")
  [[ -n $value ]] || fail "no $var in rws-lib.sh"
  grep -qF -- "$value" "$book" || fail "vps-rebuild.md does not name $var ($value)"
done
while IFS= read -r path; do
  [[ -e $here/../../$path ]] || fail "vps-rebuild.md names $path, which does not exist"
done < <(grep -oE '(deploy|scripts|docs)/[A-Za-z0-9_./-]*[A-Za-z0-9_]\.(sh|md|ts)' "$book" | sort -u)
while IFS= read -r name; do
  [[ -e $here/../../docs/runbooks/$name ]] || fail "vps-rebuild.md names the runbook $name, which does not exist"
done < <(grep -oP '(?<![/\w-])[a-z-]+\.md' "$book" | sort -u)
while IFS= read -r name; do
  [[ -e $here/../bin/$name ]] || fail "vps-rebuild.md names the script $name, which is not in deploy/bin"
done < <(grep -oE 'sudo (rws-[a-z-]+)' "$book" | cut -d' ' -f2 | sort -u)

if ((failures > 0)); then
  echo "rebuild-check.test: $failures failure(s) in $labels cases" >&2
  exit 1
fi
echo "rebuild-check.test: $labels cases passed"
