#!/usr/bin/env bash
# Offline tests of rws-basemap-refresh (issue #18 P3) and of the units and the
# bootstrap lines around it. docker and curl are stubs on PATH that record every
# call; `config --services` answers the jobs only with --profile jobs, as docker
# does; flock is real. Each case runs in a fresh temporary root.
# Usage: deploy/tests/basemap-refresh.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bin=$(cd "$here/../bin" && pwd)
systemd=$(cd "$here/../systemd" && pwd)
bootstrap=$(cd "$here/../host" && pwd)/bootstrap.sh
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
readonly ORIG_PATH=$PATH
failures=0 labels=0

# ---------------------------------------------------------------- stubs
mkdir -p "$T/stubs"
cat >"$T/stubs/docker" <<'STUB'
#!/usr/bin/env bash
# Records every call in $FIX/calls. `compose ... config --services`: the lines of
# $FIX/services, and those of $FIX/jobs-services only when --profile jobs is given.
# `compose ... run --rm --no-deps -T <service> <args>`: recorded as
# "<service>|<args>" in $FIX/runs; exits with the number in $FIX/rc-<verb>-<n>
# (the n-th call of that verb) or else $FIX/rc-<verb> (the role's verb: fetch,
# promote or rollback; default 0).
# `ps ... --filter label=com.docker.compose.service=<s>`: the lines of $FIX/ps-<s>
# (container ids); exits with $FIX/rc-ps (default 0).
set -euo pipefail
printf 'docker %s\n' "$*" >>"$FIX/calls"
if [[ $1 == ps ]]; then
  for a in "$@"; do
    if [[ $a == label=com.docker.compose.service=* ]]; then cat "$FIX/ps-${a##*=}" 2>/dev/null || true; fi
  done
  exit "$(cat "$FIX/rc-ps" 2>/dev/null || echo 0)"
fi
[[ $1 == compose ]] || exit 0
profile=0
prev=''
for a in "$@"; do
  [[ $prev == --profile && $a == jobs ]] && profile=1
  prev=$a
done
case " $* " in
  *" config --services "*)
    cat "$FIX/services" 2>/dev/null || true
    if ((profile)); then cat "$FIX/jobs-services" 2>/dev/null || true; fi
    ;;
  *" run --rm --no-deps -T "*)
    all=$*
    rest=${all#* run --rm --no-deps -T }
    printf '%s\n' "${rest/ /|}" >>"$FIX/runs"
    read -r _ _ verb _ <<<"$rest"
    n=$(grep -c "|basemap $verb" "$FIX/runs" || true)
    if [[ -f $FIX/rc-$verb-$n ]]; then exit "$(cat "$FIX/rc-$verb-$n")"; fi
    exit "$(cat "$FIX/rc-$verb" 2>/dev/null || echo 0)"
    ;;
esac
STUB
cat >"$T/stubs/curl" <<'STUB'
#!/usr/bin/env bash
# A ping or any other request: recorded; the script must make none.
printf 'curl %s\n' "$*" >>"$FIX/calls"
STUB
chmod +x "$T/stubs"/*

# ---------------------------------------------------------------- fixtures
setup() {
  C=$(mktemp -d "$T/case.XXXX")
  mkdir -p "$C"/{state/releases/r,etc/secrets,lock,fix}
  ln -s releases/r "$C/state/active"
  export FIX=$C/fix RWS_STATE_DIR=$C/state RWS_ETC=$C/etc RWS_LOCK_DIR=$C/lock
  export PATH=$T/stubs:$ORIG_PATH
  cat >"$C/etc/rws.env" <<EOF
RWS_DOMAIN=rivierstanden.example
RWS_CONTACT_EMAIL=contact@rivierstanden.example
RWS_PUBLIC_IPV4=198.51.100.7
RWS_PUBLIC_IPV6=2001:db8::7
EOF
  # A P3 release: the jobs are in the services of profile "jobs" only.
  printf 'caddy\ncapture\n' >"$FIX/services"
  printf 'backup\nmigrate\nbasemap\nbasemap-promote\n' >"$FIX/jobs-services"
  : >"$FIX/calls"
  : >"$FIX/runs"
}

# run [args]: sets $rc; output in $C/out.
run() {
  rc=0
  "$bin/rws-basemap-refresh" "$@" >"$C/out" 2>&1 || rc=$?
}
# runs: the compose runs in order, as one line: "basemap|basemap fetch;basemap-promote|basemap promote;"
runs() { tr '\n' ';' <"$FIX/runs"; }
# holder <lock name>: holds that lock until $holder_pid is killed.
holder() {
  local file=$RWS_LOCK_DIR/$1.lock
  (
    flock 9
    exec sleep 60
  ) 9>"$file" &
  holder_pid=$!
  for _ in $(seq 1 50); do
    flock -n "$file" true || return 0
    sleep 0.1
  done
  echo "  FAIL: the lock holder never took $1" >&2
  failures=$((failures + 1))
}
release() {
  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
}

# ---------------------------------------------------------------- assertions
fail() {
  echo "  FAIL: $*" >&2
  if [[ -f $C/out ]]; then sed 's/^/  | /' "$C/out" >&2; fi
  failures=$((failures + 1))
}
expect_rc() { [[ $rc == "$1" ]] || fail "exit $rc, expected $1"; }
expect_runs() { [[ $(runs) == "$1" ]] || fail "runs: '$(runs)', expected '$1'"; }
expect_grep() { grep -qE -- "$1" "$2" || fail "no line matching /$1/ in ${2##*/}"; }
expect_no_grep() { ! grep -qE -- "$1" "$2" || fail "unexpected line matching /$1/ in ${2##*/}"; }
# No docker call and no request at all.
expect_untouched() { [[ ! -s $FIX/calls ]] || fail "unexpected calls: $(tr '\n' '|' <"$FIX/calls")"; }
case_() {
  labels=$((labels + 1))
  printf 'case %s\n' "$*"
}

# ---------------------------------------------------------------- cases
case_ "usage errors exit 64 and touch nothing: unknown flag or word, a bad or missing --build, --rollback with another flag"
setup
# shellcheck disable=SC2016 # the command substitution is meant to stay unexpanded
for args in '--bogus' 'now' '-h' '--build' '--build 2026-10-01' '--build 2026100' '--build 202610011' '--build 2026100a' \
  '--build 20261001 extra' '--build ２０２６１００１' '--build $(touch '"$C"'/pwned)' '--rollback --build 20261001' \
  '--rollback --dry-run' '--dry-run --rollback' '--build 20261001 --rollback' '--dry-run now'; do
  # shellcheck disable=SC2086 # the words of $args are the arguments
  run $args
  expect_rc 64
  expect_grep "^usage: rws-basemap-refresh \[--dry-run \| --rollback \| --build YYYYMMDD" "$C/out"
  expect_untouched
  [[ ! -e $C/pwned ]] || fail "a command substitution in --build ran ('$args')"
done

case_ "no release deployed yet: exit 1, nothing runs"
setup
rm "$C/state/active"
run
expect_rc 1
expect_grep "no release is deployed yet" "$C/out"
expect_untouched

case_ "an incomplete rws.env: exit 1 with the owner step, nothing runs"
setup
printf 'RWS_DOMAIN=rivierstanden.example\n' >"$C/etc/rws.env"
run
expect_rc 1
expect_grep "rws.env is not complete" "$C/out"
expect_untouched

case_ "a release without the basemap job: exit 1; the jobs are looked up with --profile jobs"
setup
printf 'backup\nmigrate\n' >"$FIX/jobs-services"
run
expect_rc 1
expect_grep "the active release has no basemap job" "$C/out"
expect_grep "^docker compose .* --profile jobs config --services$" "$FIX/calls"
expect_runs ""
case_ "a release whose basemap job is only in the profile: it is found (has_service sees profiled services)"
setup
run --dry-run
expect_rc 0
expect_runs "basemap|basemap fetch --dry-run;"
# The older callers: db and api are plain services and are still found.
bash -c '. "$1" && has_service caddy && ! has_service nothing' _ "$bin/rws-lib.sh" ||
  fail "has_service: a plain service is not found, or an unknown one is"

case_ "a basemap refresh already running (its own lock): logs it, exits 0, runs nothing"
setup
holder rws-basemap
run
release
expect_rc 0
expect_grep "another basemap refresh is still running" "$C/out"
expect_runs ""
expect_no_grep "run --rm" "$FIX/calls"
# The leftover check runs only with the lock: a running refresh's own containers are not leftovers.
expect_no_grep "^docker ps" "$FIX/calls"

case_ "a leftover container of either job (running or exited) stops every mode before any job: exit 1, its ids and the cure"
for service in basemap basemap-promote; do
  for args in '' '--dry-run' '--rollback' '--build 20261001'; do
    setup
    printf 'c0ffee000001\nc0ffee000002\n' >"$FIX/ps-$service"
    # shellcheck disable=SC2086 # the words of $args are the arguments
    run $args
    expect_rc 1
    expect_runs ""
    expect_grep "error: a $service container is left over \(c0ffee000001 c0ffee000002\): look at it with docker ps -a --filter label=com\.docker\.compose\.service=$service, remove it with docker rm -f <id>, then run again" "$C/out"
  done
done
# Exactly the rws project's containers of that service, running or not (-a); ids only (-q).
setup
run --dry-run
expect_grep "^docker ps -aq --filter label=com\.docker\.compose\.project=rws --filter label=com\.docker\.compose\.service=basemap$" "$FIX/calls"
expect_grep "^docker ps -aq --filter label=com\.docker\.compose\.project=rws --filter label=com\.docker\.compose\.service=basemap-promote$" "$FIX/calls"
# A docker ps that fails is no proof that nothing is left: exit 1, nothing runs.
setup
echo 1 >"$FIX/rc-ps"
run
expect_rc 1
expect_runs ""
expect_grep "docker ps failed: cannot tell whether a basemap container is left over" "$C/out"

case_ "the rws-deploy lock is never taken: a held one does not hold up the refresh"
setup
holder rws-deploy
run
release
expect_rc 0
expect_runs "basemap-promote|basemap promote;basemap|basemap fetch;basemap-promote|basemap promote;"
expect_no_grep "another" "$C/out"

case_ "a run: promote what an earlier run staged, fetch, then promote, in that order, with the compose job services; no ping, no request"
setup
run
expect_rc 0
expect_runs "basemap-promote|basemap promote;basemap|basemap fetch;basemap-promote|basemap promote;"
expect_grep "^docker compose -p rws --project-directory $C/state/active -f $C/state/active/compose\.yaml --env-file $C/etc/rws\.env --env-file $C/state/active/images\.env run --rm --no-deps -T basemap basemap fetch$" "$FIX/calls"
expect_grep "^docker compose -p rws .* run --rm --no-deps -T basemap-promote basemap promote$" "$FIX/calls"
expect_no_grep "^curl" "$FIX/calls"
expect_grep "rws-basemap-refresh: basemap fetch: this can take hours" "$C/out"
expect_grep "rws-basemap-refresh: basemap fetch done: promoting" "$C/out"
expect_grep "rws-basemap-refresh: basemap refresh done \(the role's lines above say whether a build was promoted\)$" "$C/out"

case_ "--dry-run: only the fetch job, with --dry-run; nothing is promoted"
setup
run --dry-run
expect_rc 0
expect_runs "basemap|basemap fetch --dry-run;"
expect_grep "dry run done: fetch only, nothing promoted" "$C/out"

case_ "DRY_RUN in the environment does not make a real run a dry one, and is never evaluated"
setup
DRY_RUN="a[\$(touch $C/pwned)]" run
expect_rc 0
[[ ! -e $C/pwned ]] || fail "DRY_RUN from the environment was evaluated"
expect_runs "basemap-promote|basemap promote;basemap|basemap fetch;basemap-promote|basemap promote;"

case_ "--build YYYYMMDD: passed on to fetch only, also with --dry-run"
setup
run --build 20261001
expect_rc 0
expect_runs "basemap-promote|basemap promote;basemap|basemap fetch --build 20261001;basemap-promote|basemap promote;"
setup
run --dry-run --build 20261001
expect_rc 0
expect_runs "basemap|basemap fetch --build 20261001 --dry-run;"
setup
run --build 20261001 --dry-run
expect_runs "basemap|basemap fetch --build 20261001 --dry-run;"

case_ "fetch fails (exit 1 or 78): exit 1, nothing is promoted, the code is logged"
for code in 1 78; do
  setup
  echo "$code" >"$FIX/rc-fetch"
  run
  expect_rc 1
  expect_runs "basemap-promote|basemap promote;basemap|basemap fetch;"
  expect_grep "basemap fetch failed \(exit $code\): nothing was promoted" "$C/out"
  expect_no_grep "basemap refresh done" "$C/out"
done
setup
echo 1 >"$FIX/rc-fetch"
run --dry-run
expect_rc 1
expect_runs "basemap|basemap fetch --dry-run;"

case_ "the final promote fails: exit 1 and the code is logged"
setup
echo 1 >"$FIX/rc-promote-2"
run
expect_rc 1
expect_runs "basemap-promote|basemap promote;basemap|basemap fetch;basemap-promote|basemap promote;"
expect_grep "basemap promote failed \(exit 1\)" "$C/out"
expect_no_grep "basemap refresh done" "$C/out"

case_ "the promote of an earlier run's staged build fails: exit 1, nothing is fetched, so the staging is kept"
setup
echo 1 >"$FIX/rc-promote-1"
run
expect_rc 1
expect_runs "basemap-promote|basemap promote;"
expect_grep "basemap promote of the build an earlier run staged failed \(exit 1\): nothing was fetched" "$C/out"
# The cure, after the code: empty .staging, never the served directory.
expect_grep "Read the role's code above .*empty \.staging \(sudo find /srv/rws/tiles/\.staging -mindepth 1 -delete\) and run again$" "$C/out"
expect_no_grep "basemap refresh done" "$C/out"

case_ "--rollback: only the promote job with the rollback role, no fetch; a failure exits 1"
setup
run --rollback
expect_rc 0
expect_runs "basemap-promote|basemap rollback;"
expect_grep "^docker compose -p rws .* run --rm --no-deps -T basemap-promote basemap rollback$" "$FIX/calls"
expect_grep "basemap rolled back" "$C/out"
setup
echo 1 >"$FIX/rc-rollback"
run --rollback
expect_rc 1
expect_runs "basemap-promote|basemap rollback;"
expect_grep "basemap rollback failed \(exit 1\)" "$C/out"

case_ "the units: a quarterly timer on the 15th of January, April, July and October, never enabled by bootstrap.sh"
C=$(mktemp -d "$T/case.XXXX")
: >"$C/out"
timer=$systemd/rws-basemap-refresh.timer service=$systemd/rws-basemap-refresh.service
[[ -f $timer && -f $service ]] || fail "a unit file is missing"
# 05:10 UTC plus up to an hour: clear of the 03:40 UTC unattended-upgrades reboot (deploy/host/apt-unattended-rws.conf).
grep -qE '^OnCalendar=\*-01,04,07,10-15 05:10:00$' "$timer" || fail "OnCalendar is not the quarterly one"
grep -qF '"03:40"' "$here/../host/apt-unattended-rws.conf" || fail "the reboot time moved: check the timer against it"
grep -qxF 'Persistent=true' "$timer" || fail "the timer is not persistent"
grep -qE '^RandomizedDelaySec=1h$' "$timer" || fail "the timer has no 1 h random delay"
grep -qxF 'WantedBy=timers.target' "$timer" || fail "the timer has no [Install]"
grep -qxF 'Type=oneshot' "$service" || fail "the service is not a oneshot"
grep -qxF 'ExecStart=/usr/local/bin/rws-basemap-refresh' "$service" || fail "ExecStart is not the installed script"
grep -qxF 'TimeoutStartSec=4h' "$service" || fail "the service has no 4 h timeout"
grep -qxF 'Requires=docker.service' "$service" || fail "the service does not require docker"
# Month 10 and day 15 are one date, not a range: the next four runs are the 15th of the quarter months.
if command -v systemd-analyze >/dev/null 2>&1; then
  next=$(TZ=UTC systemd-analyze calendar --iterations=4 '*-01,04,07,10-15 03:40:00' | grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2}' | sort -u | cut -c6- | tr '\n' ' ')
  [[ $next =~ ^(0[147]|10)-15\ ((0[147]|10)-15\ )*$ ]] || fail "the OnCalendar does not mean the 15th of a quarter month: $next"
fi
enable=$(grep -E '^for unit in rws-status-copy\.path' "$bootstrap" || true)
[[ $enable == *rws-backup.timer* ]] || fail "could not find bootstrap.sh's enable list"
[[ $enable != *basemap* ]] || fail "bootstrap.sh enables the basemap refresh timer"
# shellcheck disable=SC2016 # the literal line of bootstrap.sh
grep -qF 'for unit in "$bundle"/deploy/systemd/*; do' "$bootstrap" || fail "bootstrap.sh no longer installs every unit by glob"

case_ "bootstrap.sh: /srv/rws/tiles for the promote job (uid 65532), .staging private to it"
C=$(mktemp -d "$T/case.XXXX")
: >"$C/out"
grep -qxF 'ensure_dir /srv/rws/tiles 0755 65532 65532' "$bootstrap" || fail "tiles directory line"
grep -qxF 'ensure_dir /srv/rws/tiles/.staging 0700 65532 65532' "$bootstrap" || fail ".staging directory line"

case_ "the CI copy of the basemap registry (e2e) equals registry/basemap.yaml but for its extracts and comments"
C=$(mktemp -d "$T/case.XXXX")
registry=$here/../../registry/basemap.yaml ci_copy=$here/e2e/basemap.yaml
# Comment lines and the extracts block (a top-level key up to the next one) left out.
strip() { grep -vE '^[[:space:]]*#' "$1" | awk '/^extracts:/ { skip = 1; next } /^[A-Za-z_]/ { skip = 0 } !skip'; }
diff <(strip "$registry") <(strip "$ci_copy") >"$C/out" 2>&1 || fail "the CI copy differs from registry/basemap.yaml outside its extracts"
grep -qF 'basemap: { bbox: [6.04, 51.82, 6.16, 51.88], minzoom: 0, maxzoom: 14,' "$ci_copy" || fail "the CI copy's basemap extract is not the Lobith fixture's"
grep -qF 'planet: { minzoom: 0, maxzoom: 2,' "$ci_copy" || fail "the CI copy's planet extract is not the z0-2 fixture's"

echo "$labels cases, $failures failures"
((failures == 0))
