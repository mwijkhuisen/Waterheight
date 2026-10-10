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
# Serves $FIX files; records argv in $FIX/calls, ping URLs in $FIX/pings and
# "<check path> <body code>" in $FIX/codes.
set -euo pipefail
printf 'curl %s\n' "$*" >>"$FIX/calls"
out='' url='' cfg=0 body=''
while (($#)); do
  case $1 in
    -o) out=$2; shift ;;
    -K) cfg=1; shift ;;
    --data-raw) body=$2; shift ;;
    --resolve | --max-time | --max-filesize | --retry | --proto | --proto-redir) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
if ((cfg)); then
  IFS= read -r line
  line=${line#url = \"}; line=${line%\"}
  printf '%s\n' "$line" >>"$FIX/pings"
  printf '%s %s\n' "${line#https://hc-ping.com/*/}" "$body" >>"$FIX/codes"
  exit 0
fi
case $url in
  "$RWS_RELEASES_URL"/latest/download/*) file=$FIX/rel/latest/${url##*/} ;;
  "$RWS_RELEASES_URL"/download/*) rest=${url#"$RWS_RELEASES_URL"/download/}; file=$FIX/rel/$rest ;;
  */healthz) [[ -e $FIX/healthz ]] && exit 0; exit 22 ;;
  */status/capture.json) file=$FIX/capture.json ;;
  */api/v1/health) file=$FIX/api-health ;;
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
# "broken" makes capture.json stale, so the smoke test fails; $FIX/up-fails
# makes the next `up` fail (once). `config --services` lists the fixture's
# services; `up --wait` (db), `exec` (psql; its stdin goes to $FIX/psql-stdin)
# and `run` (migrate) fail while $FIX/db-up-fails, psql-fails, migrate-fails exist.
set -euo pipefail
printf 'docker %s\n' "$*" >>"$FIX/calls"
[[ $1 == compose ]] || exit 0
file='' sub='' wait=0
while (($#)); do
  case $1 in
    -f) [[ -n $file ]] || file=$2; shift ;; # the first: the owner overlay (P12a) is a second -f
    --wait) wait=1 ;;
    pull | up | run | config | exec) [[ -n $sub ]] || sub=$1 ;;
  esac
  shift
done
case $sub in
  pull) [[ ! -e $FIX/pull-fails ]] ;;
  config) sed -n 's/^  \([a-z-]*\):.*/\1/p' "$file" ;;
  exec)
    cat >"$FIX/psql-stdin"
    [[ ! -e $FIX/psql-fails ]]
    ;;
  run) [[ ! -e $FIX/migrate-fails ]] ;;
  up)
    if ((wait)); then
      [[ ! -e $FIX/db-up-fails ]]
      exit
    fi
    head -n 1 "$file" >>"$FIX/ups"
    if [[ -e $FIX/up-fails ]]; then
      rm "$FIX/up-fails"
      exit 1
    fi
    # A healthy release's capture writes right after it starts; a broken one never does.
    if head -n 1 "$file" | grep -q broken; then
      echo '{"generated_at":"2020-01-01T00:00:00.000Z"}' >"$FIX/capture.json"
    else
      printf '{"generated_at":"%s"}\n' "$(date -u -d "@$(($(date +%s) + 2))" +%Y-%m-%dT%H:%M:%S.000Z)" >"$FIX/capture.json"
    fi
    ;;
esac
STUB
cat >"$T/stubs/ip" <<'STUB'
#!/usr/bin/env bash
# `ip -4 -o addr show dev wg0 up` (wg0_ready in rws-lib.sh): the WireGuard address while $FIX/wg0 exists.
[[ -e $FIX/wg0 ]] && echo '7: wg0    inet 10.66.0.1/24 scope global wg0\       valid_lft forever preferred_lft forever'
exit 0
STUB
cat >"$T/stubs/rws-status-copy" <<'STUB'
#!/usr/bin/env bash
echo status-copy >>"$FIX/calls"
STUB
chmod +x "$T/stubs"/*

# ---------------------------------------------------------------- fixtures
# mkrel <tag> [flags]: a release on the fake GitHub; flags: broken badsig badsha
# badtag, db (services db, load, migrate: a P2a release), api (service api),
# owner (deploy/compose.owner.yaml, the P12a overlay), host=<word> (the content of a host file, deploy/host/x.conf), build=<word>
# (the content of files that are not host files: image build inputs and CI-only
# tests). Without db and api it is a P1b release.
mkrel() {
  local tag=$1 flags=${2:-} d sha mtag word f
  d=$FIX/rel/$tag
  mkdir -p "$d" "$C/bundles/$tag/deploy/host"
  {
    printf '# release %s %s\nservices:\n  caddy: {}\n  capture: {}\n' "$tag" "$flags"
    [[ " $flags " != *" db "* ]] || printf '  db: {}\n  load: {}\n  migrate: {}\n'
    [[ " $flags " != *" api "* ]] || printf '  api: {}\n'
  } >"$C/bundles/$tag/deploy/compose.yaml"
  if [[ " $flags " == *" owner "* ]]; then
    printf '# overlay\nservices:\n  caddy-owner: {}\n' >"$C/bundles/$tag/deploy/compose.owner.yaml"
  fi
  if [[ $flags == *host=* ]]; then
    word=${flags#*host=}
    printf '%s\n' "${word%% *}" >"$C/bundles/$tag/deploy/host/x.conf"
  fi
  if [[ $flags == *build=* ]]; then
    word=${flags#*build=}
    for f in server/Dockerfile web/Caddyfile backup/Dockerfile tests/e2e/run.sh tests/x.test.sh; do
      mkdir -p "$(dirname "$C/bundles/$tag/deploy/$f")"
      printf '%s\n' "${word%% *}" >"$C/bundles/$tag/deploy/$f"
    done
  fi
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
# bootstrapped <tag>: bootstrap.sh of that release has run (its host-file list is recorded).
bootstrapped() {
  bash -c '. "$1" && host_files "$2"' _ "$bin/rws-lib.sh" "$RWS_STATE_DIR/releases/$1" >"$RWS_STATE_DIR/host-files.sha256"
}
server_ref() { jq -r .images.server "$FIX/rel/$1/release-manifest.json"; }
# The login roles' test passwords: 64 hex characters derived from the role name.
readonly DB_ROLES=(rws_migrator rws_load rws_publish rws_api rws_owner_api)
dbpw() { printf '%s' "test-pw-$1" | sha256sum | cut -c1-64; }
# The docker compose calls after the fixed prefix (-p ... --env-file images.env), without `config`
# (has_service asks for the services of the "jobs" profile too).
compose_calls() { grep '^docker compose ' "$FIX/calls" | sed -E 's/^.* --env-file [^ ]+ //' | grep -Ev '^(--profile jobs )?config --services$' || true; }

setup() {
  cases=$((cases + 1))
  C=$T/case$cases
  mkdir -p "$C"/{state,etc/secrets,srv/public/ops,lock,fix/rel}
  export FIX=$C/fix RWS_STATE_DIR=$C/state RWS_ETC=$C/etc RWS_SRV=$C/srv RWS_LOCK_DIR=$C/lock
  export RWS_RELEASES_URL=https://releases.test/r RWS_SMOKE_TIMEOUT=2 RWS_SMOKE_INTERVAL=0.2
  export RWS_STATUS_COPY=$T/stubs/rws-status-copy
  export PATH=$T/stubs:$ORIG_PATH
  cat >"$C/etc/rws.env" <<EOF
RWS_DOMAIN=rivierstanden.example
RWS_CONTACT_EMAIL=contact@rivierstanden.example
RWS_PUBLIC_IPV4=198.51.100.7
RWS_PUBLIC_IPV6=2001:db8::7
EOF
  printf '%s\n' "$KEY" >"$C/etc/secrets/hc_ping_key"
  for role in "${DB_ROLES[@]}"; do dbpw "$role" >"$C/etc/secrets/db_$role"; done
  echo '{"generated_at":"2020-01-01T00:00:00.000Z"}' >"$FIX/capture.json"
  touch "$FIX/healthz" "$FIX/calls" "$FIX/pings" "$FIX/codes" "$FIX/ups"
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
case_ "first deploy: verify, pull, up, smoke (which publishes capture.json itself), current set, update pinged"
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
[[ $(grep -v ' config --services$' "$FIX/calls" | grep -A 1 -E 'compose .* up -d' | tail -n 1) == status-copy ]] ||
  fail "smoke did not run rws-status-copy after up"
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
expect_grep "^update/fail latest_older$" "$FIX/codes"

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
expect_grep "^update/fail rolled_back$" "$FIX/codes"
run rws-update
expect_rc 0
expect_count "^# release" "$FIX/ups" 3

case_ "up fails: rolled back to the current release, active restored, /fail, never retried"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2
latest $T2
touch "$FIX/up-fails"
run rws-update
expect_rc 1
expect_state current $T1
expect_state skip_upto $T2
expect_active $T1
expect_grep "rolled back to $T1" "$C/out"
expect_grep "^update/fail rolled_back$" "$FIX/codes"

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

case_ "rws-deploy --inject-smoke-failure rolls back to the release before it, whose smoke test passes"
run rws-deploy --inject-smoke-failure $T2
expect_rc 1
expect_state current $T1
expect_active $T1
expect_grep "failure injected" "$C/out"
expect_count "failure injected" "$C/out" 1
expect_grep "rolled back to $T1" "$C/out"
[[ $(tail -n 1 "$FIX/codes") == "update/fail rolled_back" ]] || fail "last ping: $(tail -n 1 "$FIX/codes")"

case_ "rws-deploy of an older release holds automatic updates even when the latest manifest is unreachable"
setup
mkrel $T1
mkrel $T2
latest $T1
run rws-update
latest $T2
run rws-update
rm "$FIX/rel/latest"
run rws-deploy $T1
expect_rc 0
expect_state current $T1
expect_state skip_upto $T2
latest $T2
run rws-update
expect_rc 0
expect_state current $T1
expect_grep "marked to skip" "$C/out"

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

case_ "negative-deploy.sh ([owner]): four PASS lines; the rollback is proven by current, active and rws-deploy's report (R2-C6)"
setup
mkrel $T1
mkrel $T2
latest $T1
run rws-update
latest $T2
run rws-update
sed -n 's/^readonly \(UNSIGNED\|OTHER_IDENTITY\)=//p' "$here/negative-deploy.sh" >"$FIX/bad-images"
[[ $(wc -l <"$FIX/bad-images") == 2 ]] || fail "the two refused images of negative-deploy.sh not found"
RWS_DEPLOY=$bin/rws-deploy run ../tests/negative-deploy.sh
expect_rc 0
expect_count "^PASS " "$C/out" 4
expect_grep "^PASS an injected smoke failure of $T2 rolled back to $T1 \(current, active and rws-deploy's own report\)$" "$C/out"
expect_state current $T2
expect_active $T2

case_ "changed host files: /update/fail host_files_changed on every run until bootstrap.sh has run"
setup
mkrel $T1 host=one
latest $T1
run rws-update
bootstrapped $T1
run rws-update
expect_rc 0
expect_grep "^update ok$" "$FIX/codes"
expect_no_grep "host_files_changed" "$FIX/codes"
mkrel $T2 host=two
latest $T2
run rws-update
expect_rc 0
expect_state current $T2
expect_grep "release $T2 brings changed host files: run .*/releases/$T2/deploy/host/bootstrap\.sh" "$C/out"
[[ $(tail -n 1 "$FIX/codes") == "update/fail host_files_changed" ]] || fail "after the deploy: $(tail -n 1 "$FIX/codes")"
run rws-update
[[ $(tail -n 1 "$FIX/codes") == "update/fail host_files_changed" ]] || fail "a no-op run: $(tail -n 1 "$FIX/codes")"
bootstrapped $T2
run rws-update
[[ $(tail -n 1 "$FIX/codes") == "update ok" ]] || fail "after bootstrap: $(tail -n 1 "$FIX/codes")"
mkdir -p "$RWS_STATE_DIR/releases/$T2/deploy/bin"
echo new >"$RWS_STATE_DIR/releases/$T2/deploy/bin/rws-added"
run rws-update
[[ $(tail -n 1 "$FIX/codes") == "update/fail host_files_changed" ]] || fail "an added file: $(tail -n 1 "$FIX/codes")"

case_ "a release that changes only image build inputs, compose.yaml and CI-only tests: no host-file page (R2-C2)"
setup
mkrel $T1 "host=one build=a"
latest $T1
run rws-update
bootstrapped $T1
mkrel $T2 "host=one build=b"
latest $T2
run rws-update
expect_rc 0
expect_state current $T2
[[ $(tail -n 1 "$FIX/codes") == "update ok" ]] || fail "after the deploy: $(tail -n 1 "$FIX/codes")"
expect_no_grep "host_files_changed" "$FIX/codes"

case_ "a rollback to an older release with other host files never pages, nor advises its bootstrap (R2-S5, R2-C3)"
setup
mkrel $T1 host=one
mkrel $T2 host=two
latest $T1
run rws-update
bootstrapped $T1
latest $T2
run rws-update
bootstrapped $T2
run rws-update
[[ $(tail -n 1 "$FIX/codes") == "update ok" ]] || fail "after bootstrap: $(tail -n 1 "$FIX/codes")"
run rws-deploy $T1
expect_rc 0
expect_state current $T1
expect_state skip_upto $T2
[[ $(tail -n 1 "$FIX/codes") == "update ok" ]] || fail "after the rollback: $(tail -n 1 "$FIX/codes")"
expect_no_grep "brings changed host files" "$C/out"
run rws-update
expect_grep "marked to skip" "$C/out"
[[ $(tail -n 1 "$FIX/codes") == "update ok" ]] || fail "the next run: $(tail -n 1 "$FIX/codes")"
expect_count "host_files_changed" "$FIX/codes" 1
run rws-deploy $T2
[[ $(tail -n 1 "$FIX/codes") == "update ok" ]] || fail "back on the newest: $(tail -n 1 "$FIX/codes")"

case_ "redeploying the current release holds back no newer release (R2-S6)"
setup
mkrel $T1
mkrel $T2
latest $T1
run rws-update
latest $T2
run rws-deploy $T1
expect_rc 0
expect_state current $T1
expect_state skip_upto ''
expect_no_grep "automatic updates skip" "$C/out"
run rws-update
expect_rc 0
expect_state current $T2

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

case_ "a P1b release (no db, no api) deploys as before: no database step, no /api/v1/health"
setup
mkrel $T1
latest $T1
run rws-update
expect_rc 0
expect_state current $T1
[[ $(compose_calls | tr '\n' '|') == "--profile jobs pull --quiet|up -d --remove-orphans|" ]] ||
  fail "compose calls: $(compose_calls | tr '\n' '|')"
expect_no_grep "api/v1/health" "$FIX/calls"

case_ "a release with db and api: up --wait db, roles and passwords through psql's stdin, migrate, up; smoke needs /api/v1/health"
setup
mkrel $T1 "db api"
latest $T1
echo '{"status":"degraded","generated_at":"2026-09-30T00:00:00Z"}' >"$FIX/api-health"
run rws-update
expect_rc 0
expect_state current $T1
want="--profile jobs pull --quiet|up -d --wait --wait-timeout 180 db|exec -T db psql -X -q -v ON_ERROR_STOP=1 -1 -U postgres -d rws -f -|run --rm --no-deps -T migrate|up -d --remove-orphans|"
[[ $(compose_calls | tr '\n' '|') == "$want" ]] || fail "compose calls: $(compose_calls | tr '\n' '|')"
expect_grep "^curl .*https://rivierstanden\.example/api/v1/health$" "$FIX/calls"
[[ $(head -n 3 "$FIX/psql-stdin" | tr '\n' '|') == "SET log_statement = 'none';|SET log_min_error_statement = 'panic';|SET log_min_duration_statement = -1;|" ]] ||
  fail "psql stdin does not start by turning statement logging off"
n=$(wc -l <"$here/../postgres/roles.sql")
tail -n +4 "$FIX/psql-stdin" | head -n "$n" | cmp -s - "$here/../postgres/roles.sql" ||
  fail "psql stdin does not carry deploy/postgres/roles.sql right after the SET lines"
for role in "${DB_ROLES[@]}"; do
  expect_count "^ALTER ROLE $role PASSWORD '$(dbpw "$role")';$" "$FIX/psql-stdin" 1
  expect_no_grep "$(dbpw "$role")" "$FIX/calls"
  expect_no_grep "$(dbpw "$role")" "$C/out"
done
expect_no_grep "ALTER ROLE rws_backup PASSWORD" "$FIX/psql-stdin"
expect_no_grep "/fail" "$FIX/pings"

case_ "a release with an api whose /api/v1/health does not answer: rolled back to the P1b release, whose smoke needs no api"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2 "db api"
latest $T2
run rws-update
expect_rc 1
expect_state current $T1
expect_active $T1
expect_state skip_upto $T2
expect_grep "rolled back to $T1" "$C/out"
[[ $(tail -n 1 "$FIX/ups") == "# release $T1 " ]] || fail "the last up was not the P1b release: $(tail -n 1 "$FIX/ups")"
[[ $(tail -n 1 "$FIX/codes") == "update/fail rolled_back" ]] || fail "last ping: $(tail -n 1 "$FIX/codes")"

case_ "db_prepare fails: /fail db_prepare_failed, no migrate, no up of the new release, rolled back"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2 "db api"
latest $T2
touch "$FIX/psql-fails"
echo '{"status":"ok"}' >"$FIX/api-health"
run rws-update
expect_rc 1
expect_state current $T1
expect_active $T1
[[ $(grep -c "update/fail" "$FIX/codes") == 2 && $(grep "update/fail" "$FIX/codes" | tr '\n' '|') == "update/fail db_prepare_failed|update/fail rolled_back|" ]] ||
  fail "pings: $(tr '\n' '|' <"$FIX/codes")"
expect_no_grep "run --rm --no-deps -T migrate" "$FIX/calls"
expect_no_grep "^# release $T2" "$FIX/ups"
expect_grep "db_prepare: psql in the db container failed" "$C/out"

case_ "migrate fails: /fail migrate_failed, no up of the new release, rolled back"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2 "db api"
latest $T2
touch "$FIX/migrate-fails"
echo '{"status":"ok"}' >"$FIX/api-health"
run rws-update
expect_rc 1
expect_state current $T1
[[ $(grep "update/fail" "$FIX/codes" | tr '\n' '|') == "update/fail migrate_failed|update/fail rolled_back|" ]] ||
  fail "pings: $(tr '\n' '|' <"$FIX/codes")"
expect_no_grep "^# release $T2" "$FIX/ups"

case_ "db does not become healthy: /fail db_start_failed, nothing else of the new release, rolled back"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2 "db api"
latest $T2
touch "$FIX/db-up-fails"
run rws-update
expect_rc 1
expect_state current $T1
[[ $(grep "update/fail" "$FIX/codes" | tr '\n' '|') == "update/fail db_start_failed|update/fail rolled_back|" ]] ||
  fail "pings: $(tr '\n' '|' <"$FIX/codes")"
expect_no_grep "exec -T db psql" "$FIX/calls"

case_ "a malformed db secret is refused before any exec and never echoed; nothing in it is evaluated"
for bad in 'NotHex-secret-value-0123456789' "$(printf 'a%.0s' {1..63})" "\$(touch $T/pwned)" "x[\$(touch $T/pwned)]"; do
  setup
  mkrel $T1
  latest $T1
  run rws-update
  mkrel $T2 "db api"
  latest $T2
  printf '%s\n' "$bad" >"$C/etc/secrets/db_rws_load"
  echo '{"status":"ok"}' >"$FIX/api-health"
  run rws-update
  expect_rc 1
  expect_state current $T1
  expect_no_grep "exec -T db" "$FIX/calls"
  expect_grep "the secret db_rws_load is missing or not 64 lowercase hex characters" "$C/out"
  grep -qF -- "$bad" "$C/out" "$FIX/calls" && fail "the malformed secret was echoed"
  [[ ! -e $T/pwned ]] || fail "a command substitution in a secret ran"
  [[ $(grep "update/fail" "$FIX/codes" | head -n 1) == "update/fail db_prepare_failed" ]] ||
    fail "pings: $(tr '\n' '|' <"$FIX/codes")"
done

case_ "no installed roles.sql: db_prepare refuses, rolled back"
setup
mkrel $T1
latest $T1
run rws-update
mkrel $T2 "db api"
latest $T2
RWS_ROLES_SQL=$C/missing.sql run rws-update
expect_rc 1
expect_grep "no installed roles.sql" "$C/out"
expect_no_grep "exec -T db" "$FIX/calls"

# ---------------------------------------------------------------- the owner overlay (P12a)
# owner_calls: the compose calls that carried the overlay as a second -f.
owner_calls() { grep -cE '^docker compose .* -f [^ ]*/compose\.owner\.yaml ' "$FIX/calls" || true; }
owner_case() { # <label> <RWS_OWNER_SITE line or ''> <wg0 up: 1|0> <release flags>
  case_ "$1"
  setup
  [[ -z $2 ]] || echo "$2" >>"$C/etc/rws.env"
  if (($3)); then touch "$FIX/wg0"; fi
  mkrel $T1 "$4"
  latest $T1
  run rws-update
  expect_rc 0
  expect_state current $T1
}

owner_case "owner overlay: default (no RWS_OWNER_SITE), wg0 up: staged next to compose.yaml, never used" "" 1 owner
[[ -f $RWS_STATE_DIR/releases/$T1/compose.owner.yaml ]] || fail "stage_release did not copy compose.owner.yaml"
[[ $(owner_calls) == 0 ]] || fail "the overlay was used by default"

owner_case "owner overlay: RWS_OWNER_SITE=off, wg0 up: not used" "RWS_OWNER_SITE=off" 1 owner
[[ $(owner_calls) == 0 ]] || fail "the overlay was used with RWS_OWNER_SITE=off"

owner_case "owner overlay: RWS_OWNER_SITE=on and wg0 up with 10.66.0.1: pull, has_service and up carry it" "RWS_OWNER_SITE=on" 1 owner
[[ $(owner_calls) -ge 3 ]] || fail "the overlay was not used by pull, config and up: $(owner_calls) calls"
expect_grep "compose .* -f [^ ]*/compose\\.owner\\.yaml .*up -d --remove-orphans" "$FIX/calls"
expect_no_grep "wg0 is not up" "$C/out"

owner_case "owner overlay: RWS_OWNER_SITE=on but wg0 down: left out (fail closed), deploy still green, a log line says why" "RWS_OWNER_SITE=on" 0 owner
[[ $(owner_calls) == 0 ]] || fail "the overlay was used with wg0 down"
expect_grep "RWS_OWNER_SITE=on but wg0 is not up" "$C/out"

owner_case "owner overlay: RWS_OWNER_SITE=on, a release without the overlay (an older one): nothing to add, no failure" "RWS_OWNER_SITE=on" 1 ""
[[ $(owner_calls) == 0 ]] || fail "an overlay appeared from nowhere"

echo "$labels cases, $failures failures"
((failures == 0))
