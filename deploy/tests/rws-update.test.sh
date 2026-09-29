#!/usr/bin/env bash
# Offline tests of rws-update and rws-deploy (issue #16 P1b). curl, cosign and
# docker are stubs on PATH that serve fixture releases and record every call;
# jq, tar, sha256sum and flock are real. Each case runs in a fresh temporary
# root. Usage: deploy/tests/rws-update.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bin=$(cd "$here/../bin" && pwd)
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
readonly KEY=testPingKey_0123456789ab
readonly IMG=ghcr.io/mwijkhuisen/waterheight
readonly ORIG_PATH=$PATH
failures=0 cases=0 labels=0

# ---------------------------------------------------------------- stubs
mkdir -p "$T/stubs"
cat >"$T/stubs/curl" <<'STUB'
#!/usr/bin/env bash
# Serves $FIX files; records argv in $FIX/calls and ping configs in $FIX/pings.
set -euo pipefail
printf 'curl %s\n' "$*" >>"$FIX/calls"
out='' url='' cfg=0
while (($#)); do
  case $1 in
    -o) out=$2; shift ;;
    -K) cfg=1; shift ;;
    --resolve | --max-time | --max-filesize | --retry | --proto | --proto-redir | --data-raw) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
if ((cfg)); then
  IFS= read -r line
  line=${line#url = \"}; line=${line%\"}
  printf '%s\n' "$line" >>"$FIX/pings"
  exit 0
fi
case $url in
  "$RWS_RELEASES_URL"/latest/download/*) file=$FIX/rel/latest/${url##*/} ;;
  "$RWS_RELEASES_URL"/download/*) rest=${url#"$RWS_RELEASES_URL"/download/}; file=$FIX/rel/$rest ;;
  */healthz) [[ -e $FIX/healthz ]] && exit 0; exit 22 ;;
  */status/capture.json) file=$FIX/capture.json ;;
  *) exit 6 ;;
esac
[[ -f $file ]] || exit 22
if [[ -n $out ]]; then cp "$file" "$out"; else cat "$file"; fi
STUB
cat >"$T/stubs/cosign" <<'STUB'
#!/usr/bin/env bash
# Accepts only the exact identity and issuer, never a regexp flag. A bundle
# that says "good" verifies; an image listed in $FIX/bad-images does not.
set -euo pipefail
printf 'cosign %s\n' "$*" >>"$FIX/calls"
args=" $* "
[[ $args != *regexp* ]] || exit 97
[[ $args == *" --certificate-identity https://github.com/mwijkhuisen/Waterheight/.github/workflows/release.yml@refs/heads/main "* ]] || exit 98
[[ $args == *" --certificate-oidc-issuer https://token.actions.githubusercontent.com "* ]] || exit 98
case $1 in
  verify-blob)
    while (($#)); do [[ $1 == --bundle ]] && bundle=$2; shift; done
    [[ $(cat "$bundle") == good ]]
    ;;
  verify) ! grep -qxF -- "${*: -1}" "$FIX/bad-images" 2>/dev/null ;;
  *) exit 2 ;;
esac
STUB
cat >"$T/stubs/docker" <<'STUB'
#!/usr/bin/env bash
# compose pull/up are recorded; `up` with a compose file whose first line says
# "broken" makes capture.json stale, so the smoke test fails.
set -euo pipefail
printf 'docker %s\n' "$*" >>"$FIX/calls"
[[ $1 == compose ]] || exit 0
file='' sub=''
while (($#)); do
  case $1 in
    -f) file=$2; shift ;;
    pull | up | run) [[ -n $sub ]] || sub=$1 ;;
  esac
  shift
done
case $sub in
  pull) [[ ! -e $FIX/pull-fails ]] ;;
  up)
    head -n 1 "$file" >>"$FIX/ups"
    # A healthy release's capture writes right after it starts; a broken one never does.
    if head -n 1 "$file" | grep -q broken; then
      echo '{"generated_at":"2020-01-01T00:00:00.000Z"}' >"$FIX/capture.json"
    else
      printf '{"generated_at":"%s"}\n' "$(date -u -d "@$(($(date +%s) + 2))" +%Y-%m-%dT%H:%M:%S.000Z)" >"$FIX/capture.json"
    fi
    ;;
esac
STUB
chmod +x "$T/stubs"/*

# ---------------------------------------------------------------- fixtures
# mkrel <tag> [flags]: a release on the fake GitHub; flags: broken badsig badsha badtag.
mkrel() {
  local tag=$1 flags=${2:-} d sha mtag
  d=$FIX/rel/$tag
  mkdir -p "$d" "$C/bundles/$tag/deploy"
  printf '# release %s %s\nservices: {}\n' "$tag" "$flags" >"$C/bundles/$tag/deploy/compose.yaml"
  tar -czf "$d/deploy-bundle.tar.gz" -C "$C/bundles/$tag" deploy
  sha=$(sha256sum "$d/deploy-bundle.tar.gz" | cut -d' ' -f1)
  [[ $flags != *badsha* ]] || sha=$(printf '0%.0s' {1..64})
  mtag=$tag
  [[ $flags != *badtag* ]] || mtag='prod-../../etc'
  jq -n --arg tag "$mtag" --arg sha "$sha" --arg img "$IMG" \
    --arg s "$(printf '%s-s' "$tag" | sha256sum | cut -c1-64)" \
    --arg w "$(printf '%s-w' "$tag" | sha256sum | cut -c1-64)" \
    --arg b "$(printf '%s-b' "$tag" | sha256sum | cut -c1-64)" \
    '{version: 1, tag: $tag, commit: ("a" * 40),
      images: {server: "\($img)/server@sha256:\($s)", web: "\($img)/web@sha256:\($w)", backup: "\($img)/backup@sha256:\($b)"},
      bundle: {name: "deploy-bundle.tar.gz", sha256: $sha}}' >"$d/release-manifest.json"
  if [[ $flags == *badsig* ]]; then echo bad; else echo good; fi >"$d/release-manifest.sigstore.json"
}
latest() { ln -sfn "$1" "$FIX/rel/latest"; }
server_ref() { jq -r .images.server "$FIX/rel/$1/release-manifest.json"; }

setup() {
  cases=$((cases + 1))
  C=$T/case$cases
  mkdir -p "$C"/{state,etc/secrets,srv/public/ops,lock,fix/rel}
  export FIX=$C/fix RWS_STATE_DIR=$C/state RWS_ETC=$C/etc RWS_SRV=$C/srv RWS_LOCK_DIR=$C/lock
  export RWS_RELEASES_URL=https://releases.test/r RWS_SMOKE_TIMEOUT=2 RWS_SMOKE_INTERVAL=0.2
  export PATH=$T/stubs:$ORIG_PATH
  cat >"$C/etc/rws.env" <<EOF
RWS_DOMAIN=rivierstanden.example
RWS_CONTACT_EMAIL=contact@rivierstanden.example
RWS_PUBLIC_IPV4=198.51.100.7
RWS_PUBLIC_IPV6=2001:db8::7
EOF
  printf '%s\n' "$KEY" >"$C/etc/secrets/hc_ping_key"
  echo '{"generated_at":"2020-01-01T00:00:00.000Z"}' >"$FIX/capture.json"
  touch "$FIX/healthz" "$FIX/calls" "$FIX/pings" "$FIX/ups"
}

# run <script> [args]: sets $rc; output in $C/out.
run() {
  rc=0
  "$bin/$1" "${@:2}" >"$C/out" 2>&1 || rc=$?
}

# ---------------------------------------------------------------- assertions
fail() {
  echo "  FAIL: $*" >&2
  echo "  --- output:" >&2
  sed 's/^/  | /' "$C/out" >&2
  failures=$((failures + 1))
}
expect_rc() { [[ $rc == "$1" ]] || fail "exit $rc, expected $1"; }
expect_state() {
  local got=''
  [[ -f $RWS_STATE_DIR/$1 ]] && got=$(<"$RWS_STATE_DIR/$1")
  [[ $got == "$2" ]] || fail "state $1 = '${got}', expected '$2'"
}
expect_active() {
  local got
  got=$(readlink "$RWS_STATE_DIR/active" 2>/dev/null || true)
  [[ $got == "${1:+releases/$1}" ]] || fail "active -> '$got', expected '${1:+releases/$1}'"
}
expect_grep() { grep -qE -- "$1" "$2" || fail "no line matching /$1/ in ${2##*/}"; }
expect_no_grep() { ! grep -qE -- "$1" "$2" || fail "unexpected line matching /$1/ in ${2##*/}"; }
expect_count() {
  local n
  n=$(grep -cE -- "$1" "$2" || true)
  [[ $n == "$3" ]] || fail "$n lines matching /$1/ in ${2##*/}, expected $3"
}
case_() {
  labels=$((labels + 1))
  printf 'case %s\n' "$*"
}

T1=prod-20260901T100000Z
T2=prod-20260902T100000Z

# ---------------------------------------------------------------- cases
case_ "first deploy: verify, pull, up, smoke, current set, update pinged"
setup
mkrel $T1
latest $T1
run rws-update
expect_rc 0
expect_state current $T1
expect_active $T1
expect_grep "cosign verify-blob --bundle" "$FIX/calls"
expect_count "cosign verify .*@sha256:" "$FIX/calls" 3
expect_grep "compose .* --profile jobs pull" "$FIX/calls"
expect_grep "compose .* up -d --remove-orphans" "$FIX/calls"
expect_grep "^https://hc-ping.com/$KEY/update$" "$FIX/pings"
expect_no_grep "/fail$" "$FIX/pings"
[[ $(stat -c %a "$RWS_STATE_DIR/current") == 600 ]] || fail "current is not mode 0600"
[[ $(<"$RWS_STATE_DIR/releases/$T1/images.env") == "RWS_SERVER_IMAGE=$(server_ref $T1)"* ]] || fail "images.env"

case_ "nothing new: no deploy, update still pinged; the ping key never in argv"
run rws-update
expect_rc 0
expect_count "^# release" "$FIX/ups" 1
expect_count "^https://hc-ping.com/$KEY/update$" "$FIX/pings" 2
expect_no_grep "$KEY" "$FIX/calls"

case_ "bad manifest signature: nothing touched, /fail, retried next run"
setup
mkrel $T1 badsig
latest $T1
run rws-update
expect_rc 1
expect_state current ''
expect_no_grep "^docker" "$FIX/calls"
expect_grep "/update/fail$" "$FIX/pings"
run rws-update
expect_rc 1
expect_count "cosign verify-blob" "$FIX/calls" 2

case_ "malformed tag in a signed manifest is refused"
setup
mkrel $T1 badtag
latest $T1
run rws-update
expect_rc 1
expect_no_grep "^docker" "$FIX/calls"
[[ ! -e $RWS_STATE_DIR/releases ]] || fail "a release directory was created"

case_ "future tag is refused"
setup
mkrel prod-20991231T000000Z
latest prod-20991231T000000Z
run rws-update
expect_rc 1
expect_grep "lies in the future" "$C/out"
expect_no_grep "^docker" "$FIX/calls"

case_ "bundle sha256 mismatch: nothing touched"
setup
mkrel $T1 badsha
latest $T1
run rws-update
expect_rc 1
expect_grep "bundle sha256 does not match" "$C/out"
expect_no_grep "^docker" "$FIX/calls"

case_ "image signed by another identity: nothing touched"
setup
mkrel $T1
latest $T1
server_ref $T1 >"$FIX/bad-images"
run rws-update
expect_rc 1
expect_no_grep "^docker compose" "$FIX/calls"
expect_state current ''
expect_grep "/update/fail$" "$FIX/pings"

case_ "pull failure: no up, current and active unchanged, retried next run"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2
latest $T2
touch "$FIX/pull-fails"
run rws-update
expect_rc 1
expect_state current $T1
expect_active $T1
expect_count "^# release" "$FIX/ups" 1
rm "$FIX/pull-fails"
run rws-update
expect_rc 0
expect_state current $T2

case_ "older manifest is refused by rws-update"
setup
mkrel $T1
mkrel $T2
latest $T2
run rws-update
latest $T1
run rws-update
expect_rc 0
expect_state current $T2
expect_grep "refused: release $T1 is older than the current $T2" "$C/out"
expect_count "^# release" "$FIX/ups" 1

case_ "smoke failure rolls back to the current release, /fail, never retried"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2 broken
latest $T2
run rws-update
expect_rc 1
expect_state current $T1
expect_state skip_upto $T2
expect_active $T1
expect_grep "rolled back to $T1" "$C/out"
[[ $(tail -n 2 "$FIX/ups" | tr '\n' ' ') == "# release $T2 broken # release $T1  " ]] || fail "up order: $(tr '\n' '|' <"$FIX/ups")"
expect_grep "/update/fail$" "$FIX/pings"
run rws-update
expect_rc 0
expect_count "^# release" "$FIX/ups" 3

case_ "first deploy with a failing smoke test: loud, containers left, never retried"
setup
mkrel $T1 broken
latest $T1
run rws-update
expect_rc 1
expect_grep "no previous release" "$C/out"
expect_state current ''
expect_state skip_upto $T1
expect_active $T1
expect_count "^# release" "$FIX/ups" 1
run rws-update
expect_rc 0
expect_count "^# release" "$FIX/ups" 1

case_ "rws-deploy deploys an older release on purpose and holds automatic updates"
setup
mkrel $T1
mkrel $T2
latest $T1
run rws-update
latest $T2
run rws-update
run rws-deploy $T1
expect_rc 0
expect_state current $T1
expect_state skip_upto $T2
run rws-update
expect_rc 0
expect_state current $T1
expect_grep "marked to skip" "$C/out"

case_ "rws-deploy --inject-smoke-failure rolls back to the release before it"
run rws-deploy --inject-smoke-failure $T2
expect_rc 1
expect_state current $T1
expect_active $T1
expect_grep "failure injected" "$C/out"

case_ "rws-deploy: bad tag argument, manifest tag mismatch"
run rws-deploy 'prod-2026;rm'
expect_rc 64
cp "$FIX/rel/$T1/release-manifest.json" "$FIX/rel/$T2/release-manifest.json"
run rws-deploy $T2
expect_rc 1
expect_grep "tag $T1, expected $T2" "$C/out"

case_ "rws-deploy --verify-image: signed passes, other identity refused"
run rws-deploy --verify-image "$(server_ref $T1)"
expect_rc 0
server_ref $T2 >"$FIX/bad-images"
run rws-deploy --verify-image "$(server_ref $T2)"
expect_rc 1
run rws-deploy --verify-image "docker.io/library/alpine:latest"
expect_rc 1

case_ "a held lock: rws-update exits quietly"
setup
mkrel $T1
latest $T1
flock "$RWS_LOCK_DIR/rws-deploy.lock" sleep 3 &
sleep 0.5
run rws-update
wait
expect_rc 0
expect_grep "another deploy is running" "$C/out"
expect_no_grep "." "$FIX/calls"

case_ "rws.env incomplete: rws-update does nothing"
setup
mkrel $T1
latest $T1
echo 'RWS_DOMAIN=' >"$RWS_ETC/rws.env"
run rws-update
expect_rc 0
expect_no_grep "." "$FIX/calls"

case_ "--dry-run: verifies, deploys nothing, pings nothing"
setup
mkrel $T1
latest $T1
run rws-update --dry-run
expect_rc 0
expect_grep "dry-run: would deploy $T1" "$C/out"
expect_no_grep "^docker" "$FIX/calls"
expect_no_grep "." "$FIX/pings"

echo "$labels cases, $failures failures"
((failures == 0))
