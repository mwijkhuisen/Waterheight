#!/usr/bin/env bash
# Offline tests of rws-rivers-refresh (issue #21 P6b) and of its units and bootstrap lines.
# curl and cosign are stubs on PATH serving a fake GitHub; jq, sha256sum, gzip and
# flock are real. Each case runs in a fresh temporary root.
# Usage: deploy/tests/rivers-refresh.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bin=$(cd "$here/../bin" && pwd)
systemd=$(cd "$here/../systemd" && pwd)
bootstrap=$here/../host/bootstrap.sh
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
readonly ORIG_PATH=$PATH
failures=0 labels=0

# ---------------------------------------------------------------- stubs
mkdir -p "$T/stubs"
cat >"$T/stubs/curl" <<'STUB'
#!/usr/bin/env bash
# Serves $FIX files for the releases URL and the API URL; honours --max-filesize
# (curl's exit 63) and records argv.
set -euo pipefail
printf 'curl %s\n' "$*" >>"$FIX/calls"
out='' url='' cap=''
while (($#)); do
  case $1 in
    -o) out=$2; shift ;;
    --max-filesize) cap=$2; shift ;;
    --max-time | --retry | --proto | --proto-redir | --tlsv1.2) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
case $url in
  "$RWS_GEO_API_URL") file=$FIX/releases.json ;;
  "$RWS_RELEASES_URL"/download/*) file=$FIX/rel/${url#"$RWS_RELEASES_URL"/download/} ;;
  *) exit 6 ;;
esac
[[ -f $file ]] || exit 22
[[ -z $cap ]] || (($(stat -c %s "$file") <= cap)) || exit 63
cp "$file" "$out"
STUB
cat >"$T/stubs/cosign" <<'STUB'
#!/usr/bin/env bash
# Accepts only the exact geo identity and issuer (never the release workflow's,
# never a regexp flag); a bundle that says "good" verifies.
set -euo pipefail
printf 'cosign %s\n' "$*" >>"$FIX/calls"
args=" $* "
[[ $args != *regexp* ]] || exit 97
[[ $args == *" --certificate-identity https://github.com/mwijkhuisen/Waterheight/.github/workflows/geo.yml@refs/heads/main "* ]] || exit 98
[[ $args == *" --certificate-oidc-issuer https://token.actions.githubusercontent.com "* ]] || exit 98
[[ $1 == verify-blob ]] || exit 2
while (($#)); do [[ $1 == --bundle ]] && bundle=$2; shift; done
[[ $(cat "$bundle") == good ]]
STUB
chmod +x "$T/stubs"/*

# ---------------------------------------------------------------- fixtures
# mkgeo <tag> <ver> [flags]: a release on the fake GitHub. Flags: badbundle (the
# reaches bundle), badsums (the PMTiles line of SHA256SUMS is wrong), badver=<text>
# (VERSION), badmagic, badgz, badreaches, bigtiles (over the 64 MiB cap), nosums.
mkgeo() {
  local tag=$1 ver=$2 flags=${3:-} d=$FIX/rel/$1 f verfile
  mkdir -p "$d"
  { printf 'PMTiles\003'; printf 'tiles %s %s\n' "$tag" "$ver"; } >"$d/rivers-$ver.pmtiles"
  [[ $flags != *badmagic* ]] || printf 'XXTiles\003' >"$d/rivers-$ver.pmtiles"
  [[ $flags != *bigtiles* ]] || truncate -s 70M "$d/rivers-$ver.pmtiles"
  printf '{"schema_version":1,"version":"%s","reaches":[]}\n' "$ver" >"$d/reaches-$ver.json"
  [[ $flags != *badreaches* ]] || printf '{"schema_version":2,"version":"%s"}\n' "$ver" >"$d/reaches-$ver.json"
  printf '{"attribution":"x","features":[]}\n' | gzip -n >"$d/rivers-$ver.geojson.gz"
  [[ $flags != *badgz* ]] || printf 'not gzip' >"$d/rivers-$ver.geojson.gz"
  echo '{"stations":[]}' >"$d/snap-report.json"
  verfile=$ver
  [[ $flags != *badver=* ]] || { verfile=${flags#*badver=}; verfile=${verfile%% *}; }
  printf '%b' "$verfile\n" >"$d/VERSION"
  (cd "$d" && sha256sum snap-report.json "rivers-$ver.pmtiles" "reaches-$ver.json" "rivers-$ver.geojson.gz" >SHA256SUMS)
  [[ $flags != *badsums* ]] || sed -i "s/^[0-9a-f]\{64\}  rivers-$ver.pmtiles/$(printf '0%.0s' {1..64})  rivers-$ver.pmtiles/" "$d/SHA256SUMS"
  for f in SHA256SUMS VERSION "rivers-$ver.pmtiles" "reaches-$ver.json" "rivers-$ver.geojson.gz"; do echo good >"$d/$f.sigstore.json"; done
  [[ $flags != *badbundle* ]] || echo bad >"$d/reaches-$ver.json.sigstore.json"
}
# listing <tag...>: the API's release list; tags with a "draft:" or "pre:" prefix are unpublished.
listing() {
  local t out='[' sep=''
  for t in "$@"; do
    case $t in
      draft:*) out+="$sep{\"tag_name\":\"${t#draft:}\",\"draft\":true,\"prerelease\":false}" ;;
      pre:*) out+="$sep{\"tag_name\":\"${t#pre:}\",\"draft\":false,\"prerelease\":true}" ;;
      *) out+="$sep{\"tag_name\":\"$t\",\"draft\":false,\"prerelease\":false}" ;;
    esac
    sep=,
  done
  printf '%s]\n' "$out" >"$FIX/releases.json"
}

setup() {
  C=$(mktemp -d "$T/case.XXXX")
  mkdir -p "$C"/{state/rivers,srv/tiles/.staging,srv/public/data/v1/rivers,srv/public/downloads,srv/owner,lock,fix/rel}
  export FIX=$C/fix RWS_STATE_DIR=$C/state RWS_SRV=$C/srv RWS_LOCK_DIR=$C/lock RWS_ETC=$C/etc
  export RWS_RELEASES_URL=https://releases.test/r RWS_GEO_API_URL=https://api.test/releases
  export PATH=$T/stubs:$ORIG_PATH
  : >"$FIX/calls"
  echo basemap-keep >"$C/srv/tiles/basemap-20261001.pmtiles"
  echo '{"basemap":1}' >"$C/srv/tiles/manifest.json"
  echo owner-keep >"$C/srv/owner/secret"
  data=$C/srv/public/data/v1/rivers dl=$C/srv/public/downloads tiles=$C/srv/tiles
}
run() {
  rc=0
  "$bin/rws-rivers-refresh" "$@" >"$C/out" 2>&1 || rc=$?
}
holder() {
  local file=$RWS_LOCK_DIR/$1.lock
  ( flock 9; exec sleep 60 ) 9>"$file" &
  holder_pid=$!
  for _ in $(seq 1 50); do flock -n "$file" true || return 0; sleep 0.1; done
  fail "the lock holder never took $1"
}
release() { kill "$holder_pid" 2>/dev/null || true; wait "$holder_pid" 2>/dev/null || true; }
# snap: the tree outside the work directory, with modes and hashes.
snap() { (cd "$C/srv" && find . -type f -exec sha256sum {} + | sort; find . -printf '%p %m\n' | sort); }

fail() {
  echo "  FAIL: $*" >&2
  if [[ -f $C/out ]]; then sed 's/^/  | /' "$C/out" >&2; fi
  failures=$((failures + 1))
}
expect_rc() { [[ $rc == "$1" ]] || fail "exit $rc, expected $1"; }
expect_grep() { grep -qE -- "$1" "$2" || fail "no line matching /$1/ in ${2##*/}"; }
case_() {
  labels=$((labels + 1))
  printf 'case %s\n' "$*"
}
# The manifest has exactly the RiversManifest shape (packages/contracts/src/api.ts).
valid_manifest() {
  jq -e '
    def entry($re): (keys == ["bytes","file","sha256"]) and (.file | test($re)) and (.sha256 | test("^[0-9a-f]{64}$")) and (.bytes | type == "number" and . > 0);
    def rel: (keys == ["download","installed_at","reaches","tag","tiles","version"])
      and (.version | test("^[0-9]{8}$")) and (.tag | test("^geo-[0-9]{4}-[0-9]{2}-[0-9]{2}$"))
      and (.installed_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$"))
      and (.tiles | entry("^rivers-[0-9]{8}\\.pmtiles$")) and (.reaches | entry("^reaches-[0-9]{8}\\.json$"))
      and (.download | entry("^rivers-[0-9]{8}\\.geojson\\.gz$"))
      and .tiles.file == "rivers-\(.version).pmtiles" and .reaches.file == "reaches-\(.version).json"
      and .download.file == "rivers-\(.version).geojson.gz";
    (keys == ["current","previous","schema_version"]) and .schema_version == 1 and (.current | rel) and (.previous == null or (.previous | rel))
  ' "$data/manifest.json" >/dev/null || fail "manifest.json is not a RiversManifest"
}
# installed <ver>: the three files exist, root-style 0644, with the release's bytes.
installed() {
  local ver=$1 f
  for f in "$data/rivers-$ver.pmtiles" "$data/reaches-$ver.json" "$dl/rivers-$ver.geojson.gz"; do
    [[ -f $f ]] || { fail "missing $f"; continue; }
    [[ $(stat -c %a "$f") == 644 ]] || fail "${f##*/} is not 0644"
  done
}
absent() { local f; for f in "$@"; do [[ ! -e $f ]] || fail "$f should not exist"; done; }
# Root never writes under tiles/: nothing but the three basemap entries exists there, whatever ran.
tiles_pristine() {
  [[ $(cd "$tiles" && find . -mindepth 1 | sort | tr '\n' ' ') == './.staging ./basemap-20261001.pmtiles ./manifest.json ' ]] ||
    fail "something was created under tiles/"
}
untouched_others() {
  tiles_pristine
  [[ $(cat "$tiles/basemap-20261001.pmtiles") == basemap-keep && $(cat "$tiles/manifest.json") == '{"basemap":1}' &&
    $(cat "$C/srv/owner/secret") == owner-keep && -d $tiles/.staging ]] || fail "basemap, tiles manifest, .staging or owner changed"
}
v1=20261101 t1=geo-2026-11-01 v2=20261201 t2=geo-2026-12-01 v3=20270101 t3=geo-2027-01-01

# ---------------------------------------------------------------- cases
case_ "usage errors exit 64 and fetch nothing"
setup
for args in '--bogus' 'now' '--tag' '--tag geo-2026-1-01' '--tag prod-20261101T000000Z' '--tag geo-2026-11-01x' \
  '--rollback --dry-run' '--rollback --tag geo-2026-11-01' '--dry-run --rollback'; do
  # shellcheck disable=SC2086
  run $args
  expect_rc 64
  expect_grep '^usage: rws-rivers-refresh' "$C/out"
done
[[ ! -s $FIX/calls ]] || fail "a usage error made calls"

case_ "happy path: newest published geo tag, verified, installed 0644, manifest valid, previous null, others untouched"
setup
mkgeo "$t1" "$v1"
mkgeo geo-2026-10-01 20261001 # an older release
mkgeo "$t2" "$v2" # a draft: never chosen
listing geo-2026-10-01 "$t1" "draft:$t2" "pre:geo-2026-12-15" prod-20261201T000000Z not-a-geo-tag
run
expect_rc 0
installed "$v1"
valid_manifest
[[ $(jq -r '.current.version, .current.tag, (.previous | tostring)' "$data/manifest.json" | tr '\n' ' ') == "$v1 $t1 null " ]] || fail "manifest content"
[[ $(jq -r .current.tiles.sha256 "$data/manifest.json") == "$(sha256sum "$data/rivers-$v1.pmtiles" | cut -d' ' -f1)" ]] || fail "tiles sha in the manifest"
[[ $(jq -r .current.download.bytes "$data/manifest.json") == "$(stat -c %s "$dl/rivers-$v1.geojson.gz")" ]] || fail "download bytes in the manifest"
untouched_others
absent "$C/state/rivers/work"
# Every cosign call named the geo identity: SHA256SUMS, VERSION and the three files, five in all.
[[ $(grep -c '^cosign verify-blob' "$FIX/calls") == 5 ]] || fail "expected 5 verify-blob calls"
grep -q 'workflows/geo.yml@refs/heads/main' "$FIX/calls" || fail "no geo identity in the calls"
# Per-asset caps on the downloads.
grep -qE 'max-filesize 67108864 .*rivers-'"$v1"'.pmtiles' "$FIX/calls" || fail "tiles cap"
grep -qE 'max-filesize 134217728 .*geojson.gz' "$FIX/calls" || fail "download cap"
grep -qE 'max-filesize 33554432 .*reaches-' "$FIX/calls" || fail "reaches cap"

case_ "second release: previous is the old current, both versions stay, a third prunes the first"
setup
mkgeo "$t1" "$v1"; mkgeo "$t2" "$v2"; mkgeo "$t3" "$v3"
listing "$t1"; run; expect_rc 0
listing "$t1" "$t2"; run; expect_rc 0
valid_manifest
[[ $(jq -r '.current.version + " " + .previous.version' "$data/manifest.json") == "$v2 $v1" ]] || fail "current/previous"
installed "$v1"; installed "$v2"
echo stray >"$data/reaches-notmine.json"; echo basemap >"$dl/readme.txt"
run --tag "$t3"; expect_rc 0
valid_manifest
[[ $(jq -r '.current.version + " " + .previous.version' "$data/manifest.json") == "$v3 $v2" ]] || fail "current/previous after the third"
installed "$v2"; installed "$v3"
absent "$data/rivers-$v1.pmtiles" "$data/reaches-$v1.json" "$dl/rivers-$v1.geojson.gz"
[[ -f $data/reaches-notmine.json && -f $dl/readme.txt ]] || fail "pruned a file that is not one of its names"
untouched_others

case_ "the same version again is a no-op that downloads no asset beyond the signed pair"
setup
mkgeo "$t1" "$v1"; listing "$t1"
run; expect_rc 0
before=$(snap); : >"$FIX/calls"
run; expect_rc 0
expect_grep 'already current' "$C/out"
[[ $before == "$(snap)" ]] || fail "the tree changed"
! grep -q "rivers-$v1" "$FIX/calls" || fail "downloaded an asset again"

case_ "a bad bundle (any asset) installs nothing"
setup
mkgeo "$t1" "$v1" badbundle; listing "$t1"
run; expect_rc 1
expect_grep 'not signed by' "$C/out"
absent "$data/rivers-$v1.pmtiles" "$data/reaches-$v1.json" "$dl/rivers-$v1.geojson.gz" "$data/manifest.json"
setup
mkgeo "$t1" "$v1"; echo bad >"$FIX/rel/$t1/VERSION.sigstore.json"; listing "$t1"
run; expect_rc 1
absent "$data/rivers-$v1.pmtiles" "$data/manifest.json"

case_ "a sha mismatch against SHA256SUMS installs nothing"
setup
mkgeo "$t1" "$v1" badsums; listing "$t1"
run; expect_rc 1
expect_grep 'does not match SHA256SUMS' "$C/out"
absent "$data/rivers-$v1.pmtiles" "$data/reaches-$v1.json" "$dl/rivers-$v1.geojson.gz" "$data/manifest.json"
setup
mkgeo "$t1" "$v1"; grep -v geojson "$FIX/rel/$t1/SHA256SUMS" >"$FIX/x" && mv "$FIX/x" "$FIX/rel/$t1/SHA256SUMS"; listing "$t1"
run; expect_rc 1
expect_grep 'not exactly one line' "$C/out"

case_ "VERSION other than 8 digits and a newline, or a path, is refused before any asset is fetched"
for bad in '2026110' '202611011' '2026110a' '../../etc' '20261101\nx' '20261101' ''; do
  setup
  mkgeo "$t1" "$v1" "badver=$bad"; listing "$t1"
  if [[ $bad == 20261101 ]]; then printf '20261101' >"$FIX/rel/$t1/VERSION"; fi # no newline
  run; expect_rc 1
  expect_grep 'VERSION is not 8 digits' "$C/out"
  ! grep -q 'pmtiles' "$FIX/calls" || fail "fetched an asset for VERSION '$bad'"
  absent "$data/rivers-$v1.pmtiles" "$data/manifest.json"
done
# The names come from VERSION, never from the listing or SHA256SUMS: a SHA256SUMS naming a path is ignored.
setup
mkgeo "$t1" "$v1"; echo "$(printf '0%.0s' {1..64})  ../../evil" >>"$FIX/rel/$t1/SHA256SUMS"; listing "$t1"
run; expect_rc 0
! grep -q evil "$FIX/calls" || fail "fetched a name from SHA256SUMS"

case_ "content checks: PMTiles magic, gzip, reaches schema and version"
for flag in badmagic badgz badreaches; do
  setup
  mkgeo "$t1" "$v1" "$flag"; listing "$t1"
  run; expect_rc 1
  expect_grep 'PMTiles v3|valid gzip|schema_version or version' "$C/out"
  absent "$data/rivers-$v1.pmtiles" "$data/manifest.json"
done

case_ "oversize: a file over its cap fails in curl and installs nothing"
setup
mkgeo "$t1" "$v1" bigtiles; listing "$t1"
run; expect_rc 1
expect_grep 'download of rivers-.*pmtiles failed' "$C/out"
absent "$data/rivers-$v1.pmtiles" "$data/manifest.json"

case_ "an immutable name that exists with other bytes stops the run before anything is installed"
setup
mkgeo "$t1" "$v1"; listing "$t1"
echo other >"$dl/rivers-$v1.geojson.gz"
run; expect_rc 1
expect_grep 'immutable name' "$C/out"
absent "$data/rivers-$v1.pmtiles" "$data/reaches-$v1.json" "$data/manifest.json"
[[ $(cat "$dl/rivers-$v1.geojson.gz") == other ]] || fail "replaced the immutable file"
# the same bytes already there (a run that died before the manifest) are accepted
setup
mkgeo "$t1" "$v1"; listing "$t1"
cp "$FIX/rel/$t1/rivers-$v1.geojson.gz" "$dl/"
run; expect_rc 0
valid_manifest

case_ "a symlink or a directory at a target name stops the run before anything is installed; tiles/ is never written"
for target in pmtiles reaches download; do
  setup
  mkgeo "$t1" "$v1"; listing "$t1"
  echo victim >"$C/victim"; chmod 0600 "$C/victim"
  case $target in
    pmtiles) ln -s "$C/victim" "$data/rivers-$v1.pmtiles" ;;
    reaches) ln -s "$C/victim" "$data/reaches-$v1.json" ;;
    download) mkdir "$dl/rivers-$v1.geojson.gz" ;;
  esac
  run; expect_rc 1
  expect_grep 'not a regular file' "$C/out"
  absent "$data/manifest.json"
  [[ $(stat -c %a "$C/victim") == 600 && $(cat "$C/victim") == victim ]] || fail "the symlink target was changed"
  tiles_pristine
done
# A symlink to identical bytes is still refused.
setup
mkgeo "$t1" "$v1"; listing "$t1"
ln -s "$FIX/rel/$t1/reaches-$v1.json" "$data/reaches-$v1.json"
run; expect_rc 1
absent "$data/manifest.json"

case_ "a corrupt manifest stops the run"
setup
mkgeo "$t1" "$v1"; listing "$t1"
echo '{"nope":1}' >"$data/manifest.json"
run; expect_rc 1
expect_grep 'not a valid rivers manifest' "$C/out"

case_ "rollback swaps current and previous; each file is re-checked; no previous, a missing or changed file fail"
setup
mkgeo "$t1" "$v1"; mkgeo "$t2" "$v2"
listing "$t1"; run; expect_rc 0
run --rollback; expect_rc 1
expect_grep 'no previous version' "$C/out"
listing "$t1" "$t2"; run; expect_rc 0
run --rollback; expect_rc 0
valid_manifest
[[ $(jq -r '.current.version + " " + .previous.version' "$data/manifest.json") == "$v1 $v2" ]] || fail "swap"
run --rollback; expect_rc 0
[[ $(jq -r .current.version "$data/manifest.json") == "$v2" ]] || fail "swap back"
absent "$C/state/rivers/work"
echo changed >"$data/rivers-$v1.pmtiles"
before=$(cat "$data/manifest.json")
run --rollback; expect_rc 1
expect_grep 'does not match its recorded sha256' "$C/out"
[[ $before == "$(cat "$data/manifest.json")" ]] || fail "the manifest changed on a failed rollback"
cp "$FIX/rel/$t1/rivers-$v1.pmtiles" "$data/"; rm "$dl/rivers-$v1.geojson.gz"
run --rollback; expect_rc 1
expect_grep 'is missing' "$C/out"
untouched_others
# a previous file replaced by a symlink to the same bytes is refused too
cp "$FIX/rel/$t1/rivers-$v1.geojson.gz" "$dl/"
mv "$data/reaches-$v1.json" "$C/moved.json"; ln -s "$C/moved.json" "$data/reaches-$v1.json"
run --rollback; expect_rc 1
expect_grep 'is a symlink' "$C/out"

case_ "--rollback refuses a previous file name other than its exact form, and a previous version that is not 8 digits"
for bad in '.previous.tiles.file = "../../tiles/manifest.json"' '.previous.reaches.file = "reaches-'"$v2"'.json"' \
  '.previous.download.file = "rivers-'"$v1"'.geojson.gz.x"' '.previous.version = "../x"' '.previous.version = 20261101'; do
  setup
  mkgeo "$t1" "$v1"; mkgeo "$t2" "$v2"
  listing "$t1"; run; listing "$t1" "$t2"; run; expect_rc 0
  jq "$bad" "$data/manifest.json" >"$C/m" && cp "$C/m" "$data/manifest.json"
  before=$(snap)
  run --rollback; expect_rc 1
  expect_grep 'previous version: (its (tiles|reaches|download) file is not|its version is not 8 digits)' "$C/out"
  [[ $before == "$(snap)" ]] || fail "a refused rollback changed the tree ($bad)"
done

case_ "after a rollback the automatic path leaves the rolled-back version alone; --tag installs it again"
setup
mkgeo "$t1" "$v1"; mkgeo "$t2" "$v2"
listing "$t1"; run; listing "$t1" "$t2"; run; expect_rc 0
run --rollback; expect_rc 0
before=$(snap); : >"$FIX/calls"
run; expect_rc 0
expect_grep "version $v2 is the previous version" "$C/out"
[[ $before == "$(snap)" ]] || fail "the automatic run changed the tree after a rollback"
! grep -q "rivers-$v2" "$FIX/calls" || fail "downloaded an asset of the previous version"
run --tag "$t2"; expect_rc 0
valid_manifest
[[ $(jq -r '.current.version + " " + .previous.version' "$data/manifest.json") == "$v2 $v1" ]] || fail "--tag did not reinstall"

case_ "the automatic path refuses a version older than current (a downgrade); --tag may install it"
setup
mkgeo "$t1" "$v1"; mkgeo "$t2" "$v2"; mkgeo "$t3" "$v3"
listing "$t2"; run; expect_rc 0
listing "$t1"
before=$(snap)
run; expect_rc 1
expect_grep "version $v1 is older than the current $v2: refusing a downgrade" "$C/out"
[[ $before == "$(snap)" ]] || fail "a refused downgrade changed the tree"
absent "$data/rivers-$v1.pmtiles" "$data/reaches-$v1.json" "$dl/rivers-$v1.geojson.gz"
run --dry-run; expect_rc 1
run --tag "$t1"; expect_rc 0
valid_manifest
[[ $(jq -r '.current.version + " " + .previous.version' "$data/manifest.json") == "$v1 $v2" ]] || fail "--tag downgrade"
# a newer version is still taken automatically after a --tag downgrade
listing "$t1" "$t3"; run; expect_rc 0
[[ $(jq -r '.current.version + " " + .previous.version' "$data/manifest.json") == "$v3 $v1" ]] || fail "newer after downgrade"

case_ "--dry-run fetches and verifies but writes nothing outside the work directory"
setup
mkgeo "$t1" "$v1"; listing "$t1"
before=$(snap)
run --dry-run; expect_rc 0
expect_grep 'dry run: .*verified; would install' "$C/out"
[[ $before == "$(snap)" ]] || fail "the tree changed"
absent "$data/manifest.json"
setup
mkgeo "$t1" "$v1" badsums; listing "$t1"
run --tag "$t1" --dry-run; expect_rc 1

case_ "a held lock logs and exits 0 without a request; the deploy lock is not the one it takes"
setup
mkgeo "$t1" "$v1"; listing "$t1"
holder rws-deploy
run; expect_rc 0
release
[[ -f $data/rivers-$v1.pmtiles ]] || fail "a held deploy lock stopped the refresh"
setup
mkgeo "$t1" "$v1"; listing "$t1"
holder rws-rivers
run; expect_rc 0
expect_grep 'another rivers refresh is still running' "$C/out"
[[ ! -s $FIX/calls ]] || fail "calls while the lock was held"
release

case_ "the environment cannot turn DRY_RUN on, and an API size problem or an empty release list fails closed"
setup
mkgeo "$t1" "$v1"; listing "$t1"
DRY_RUN=1 run; expect_rc 0
installed "$v1"
setup
listing; run; expect_rc 1
expect_grep 'no published geo' "$C/out"
setup
run; expect_rc 1
expect_grep 'release list could not be fetched' "$C/out"

case_ "the units: monthly, persistent, not on bootstrap's enable list; bootstrap makes the directories"
C=$(mktemp -d "$T/case.XXXX"); : >"$C/out"
timer=$systemd/rws-rivers-refresh.timer service=$systemd/rws-rivers-refresh.service
[[ -f $timer && -f $service ]] || fail "a unit file is missing"
grep -qE '^OnCalendar=\*-\*-05 05:40:00 UTC$' "$timer" || fail "OnCalendar"
grep -qxF 'Persistent=true' "$timer" || fail "not persistent"
grep -qE '^RandomizedDelaySec=' "$timer" || fail "no random delay"
grep -qxF 'WantedBy=timers.target' "$timer" || fail "no [Install]"
grep -qxF 'Type=oneshot' "$service" || fail "not a oneshot"
grep -qxF 'ExecStart=/usr/local/bin/rws-rivers-refresh' "$service" || fail "ExecStart"
grep -qxF 'NoNewPrivileges=yes' "$service" || fail "no hardening"
head -n 1 "$timer" | grep -q 'never enabled\|not on bootstrap' || fail "the timer's first line does not say bootstrap does not enable it"
enable=$(grep -E '^for unit in rws-status-copy\.path' "$bootstrap" || true)
[[ $enable == *rws-backup.timer* ]] || fail "could not find bootstrap.sh's enable list"
[[ $enable != *rivers* ]] || fail "bootstrap.sh enables the rivers refresh timer"
for line in 'ensure_dir /srv/rws/public/data 0755 0 0' 'ensure_dir /srv/rws/public/data/v1 0755 0 0' \
  'ensure_dir /srv/rws/public/data/v1/rivers 0755 0 0' 'ensure_dir /srv/rws/public/downloads 0755 0 0' \
  'ensure_dir /var/lib/rws/rivers 0700 0 0'; do
  grep -qxF "$line" "$bootstrap" || fail "bootstrap.sh lacks: $line"
done
if command -v systemd-analyze >/dev/null 2>&1; then
  TZ=UTC systemd-analyze calendar '*-*-05 05:40:00 UTC' >/dev/null 2>&1 || fail "OnCalendar does not parse"
fi

echo "$labels cases, $failures failures"
((failures == 0))
