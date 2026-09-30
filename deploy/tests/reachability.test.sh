#!/usr/bin/env bash
# Offline test of deploy/bin/rws-reachability (issue #16 P1b; R7): curl and
# getent are stubs; the signature decides, never the status; -4 and -6 are
# forced; a missing AAAA is n/a; only required targets fail the run; bodies
# never reach the report. Usage: deploy/tests/reachability.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script=$(cd "$here/../bin" && pwd)/rws-reachability
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
readonly ORIG_PATH=$PATH
failures=0 labels=0

mkdir -p "$T/stubs"
cat >"$T/stubs/curl" <<'STUB'
#!/usr/bin/env bash
# Serves $FIX/<host>.<family>.body with status $FIX/<host>.<family>.status (default 200)
# or exits with $FIX/<host>.<family>.rc; -w output goes to stderr like %{stderr}.
printf 'curl %s\n' "$*" >>"$FIX/calls"
family='' url=''
for a in "$@"; do
  case $a in
    -4) family=4 ;;
    -6) family=6 ;;
    https://*) url=$a ;;
  esac
done
host=${url#https://}
host=${host%%/*}
base=$FIX/$host.$family
if [[ -f $base.rc ]]; then
  printf '\n000 0' >&2
  exit "$(cat "$base.rc")"
fi
cat "$base.body" 2>/dev/null || true
printf '\n%s %s' "$(cat "$base.status" 2>/dev/null || echo 200)" "$(wc -c <"$base.body" 2>/dev/null || echo 0)" >&2
STUB
cat >"$T/stubs/getent" <<'STUB'
#!/usr/bin/env bash
# ahostsv6: an AAAA only for hosts listed in $FIX/aaaa; otherwise a v4-mapped answer.
if [[ $1 == ahostsv6 ]] && grep -qxF "$2" "$FIX/aaaa" 2>/dev/null; then
  echo "2001:db8::1 STREAM $2"
else
  echo "::ffff:192.0.2.1 STREAM $2"
fi
STUB
chmod +x "$T/stubs"/*

cat >"$T/targets.yaml" <<'EOF'
# test targets
{
  "targets": [
    { "id": "json-api", "source": "DE-6", "required": true, "method": "GET",
      "url": "https://api.example/data", "sig": "\"status\":\"success\"" },
    { "id": "zip-file", "source": "DE-7", "required": true, "method": "GET",
      "url": "https://files.example/x.zip", "sig": "magic:504b0304" },
    { "id": "post-api", "source": "NL-1", "required": true, "method": "POST",
      "url": "https://post.example/q", "headers": ["Content-Type: application/json"], "body": "{\"a\":1}",
      "sig": "\"Succesvol\":true" },
    { "id": "retest", "source": "R7", "required": false, "method": "GET",
      "url": "https://optional.example/", "sig": "Pegel" }
  ]
}
EOF

setup() {
  C=$(mktemp -d "$T/case.XXXX")
  mkdir -p "$C/etc" "$C/fix"
  export FIX=$C/fix RWS_ETC=$C/etc PATH=$T/stubs:$ORIG_PATH
  printf 'RWS_DOMAIN=rivierstanden.example\nRWS_CONTACT_EMAIL=contact@rivierstanden.example\n' >"$C/etc/rws.env"
  for fam in 4 6; do
    printf '{"status":"success","secret-body-marker":1}' >"$FIX/api.example.$fam.body"
    printf 'PK\003\004rest-of-zip' >"$FIX/files.example.$fam.body"
    printf '{"Succesvol":true}' >"$FIX/post.example.$fam.body"
    printf '<html>Pegel</html>' >"$FIX/optional.example.$fam.body"
  done
  echo api.example >"$FIX/aaaa"
  touch "$FIX/calls"
}
run() {
  rc=0
  "$script" --targets "$T/targets.yaml" "$@" >"$C/out" 2>&1 || rc=$?
}
fail() {
  echo "  FAIL: $*" >&2
  sed 's/^/  | /' "$C/out" >&2
  failures=$((failures + 1))
}
expect_rc() { [[ $rc == "$1" ]] || fail "exit $rc, expected $1"; }
expect_grep() { grep -qE -- "$1" "$2" || fail "no line matching /$1/ in ${2##*/}"; }
expect_no_grep() { ! grep -qE -- "$1" "$2" || fail "unexpected /$1/ in ${2##*/}"; }
case_() {
  labels=$((labels + 1))
  printf 'case %s\n' "$*"
}

case_ "all reachable: PASS on the signature, IPv6 n/a without an AAAA, exit 0"
setup
run
expect_rc 0
expect_grep '^\| json-api \| DE-6 \| IPv4 \| 200 \| [0-9]+ \| PASS \|$' "$C/out"
expect_grep '^\| json-api \| DE-6 \| IPv6 \| 200 \| [0-9]+ \| PASS \|$' "$C/out"
expect_grep '^\| zip-file \| DE-7 \| IPv4 \| 200 \| [0-9]+ \| PASS \|$' "$C/out"
expect_grep '^\| zip-file \| DE-7 \| IPv6 \| – \| – \| n/a \(no AAAA\) \|$' "$C/out"
expect_grep 'Required targets failing: 0\.' "$C/out"
expect_no_grep 'secret-body-marker|Succesvol' "$C/out"
# The report goes into the public repository: no host name.
expect_grep '^.deploy/bin/rws-reachability. on the production VPS, [0-9]{4}-' "$C/out"

case_ "each request: -4 or -6 forced, https only, verified TLS, no redirect, the contact User-Agent, no key"
expect_grep '^curl -4 --proto =https --tlsv1\.2 .* -A rivierstanden/0\.1\.0 \(\+https://rivierstanden\.example/over; contact@rivierstanden\.example\) -X GET ' "$FIX/calls"
expect_grep '^curl -6 .*https://api\.example/data$' "$FIX/calls"
expect_grep '^curl -4 .* -X POST .* -H Content-Type: application/json --data-raw \{"a":1\} https://post\.example/q$' "$FIX/calls"
expect_no_grep ' (-L|--location|-k|--insecure) |[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]' "$FIX/calls"

case_ "a 200 'blocked' PNG fails its signature and the run"
setup
printf '\211PNG\r\n\032\nblocked' >"$FIX/api.example.4.body"
run
expect_rc 1
expect_grep '^\| json-api \| DE-6 \| IPv4 \| 200 \| [0-9]+ \| FAIL \(signature\) \|$' "$C/out"

case_ "a Cloudflare challenge served with 200 instead of the zip fails"
setup
printf '<!DOCTYPE html><title>Just a moment...</title>' >"$FIX/files.example.4.body"
run
expect_rc 1
expect_grep '^\| zip-file \| DE-7 \| IPv4 \| 200 .* FAIL \(signature\) \|$' "$C/out"

case_ "IPv6 fails where the host has an AAAA: the run fails"
setup
echo 28 >"$FIX/api.example.6.rc"
run
expect_rc 1
expect_grep '^\| json-api \| DE-6 \| IPv6 \| 000 \| 0 \| FAIL \(timeout\) \|$' "$C/out"

case_ "an optional re-test failing is reported, the run still passes"
setup
echo 7 >"$FIX/optional.example.4.rc"
run
expect_rc 0
expect_grep '^\| retest \| R7 \| IPv4 \| 000 \| 0 \| FAIL \(connect\), optional \|$' "$C/out"

case_ "--out writes the same report; --only picks one target"
setup
run --only post-api --out "$C/report.md"
expect_rc 0
expect_grep '^\| post-api \| NL-1 \| IPv4 ' "$C/report.md"
expect_no_grep 'json-api' "$C/report.md"

case_ "without the contact settings it refuses to send anything"
setup
: >"$C/etc/rws.env"
run
expect_rc 1
expect_no_grep . "$FIX/calls"

case_ "a malformed target is refused before any request"
setup
sed 's#https://api.example/data#http://api.example/data#' "$T/targets.yaml" >"$C/bad.yaml"
rc=0
"$script" --targets "$C/bad.yaml" >"$C/out" 2>&1 || rc=$?
expect_rc 1
expect_no_grep . "$FIX/calls"

echo "$labels cases, $failures failures"
((failures == 0))
