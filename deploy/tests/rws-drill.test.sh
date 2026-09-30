#!/usr/bin/env bash
# Offline tests of rws-drill (issue #17 P2b; docs/runbooks/outage-drill.md).
# docker and sleep are stubs on PATH that record every call in $FIX/calls in
# order; jq and flock are real. Each case runs in a fresh temporary root.
# Usage: deploy/tests/rws-drill.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bin=$(cd "$here/../bin" && pwd)
runbook=$here/../../docs/runbooks/outage-drill.md
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
readonly ORIG_PATH=$PATH
REAL_SLEEP=$(command -v sleep)
export REAL_SLEEP
failures=0 cases=0 labels=0

# ---------------------------------------------------------------- stubs
mkdir -p "$T/stubs"
cat >"$T/stubs/docker" <<'STUB'
#!/usr/bin/env bash
# Records the call. `ps` answers a container id unless $FIX/capture-down exists;
# `stop` and `start` fail while $FIX/stop-fails or $FIX/start-fails exist.
set -euo pipefail
printf 'docker %s\n' "$*" >>"$FIX/calls"
[[ $1 == compose ]] || exit 0
case " $* " in
  *" ps "*) [[ -e $FIX/capture-down ]] || echo abc123def456 ;;
  *" stop "*) [[ ! -e $FIX/stop-fails ]] ;;
  *" start "*) [[ ! -e $FIX/start-fails ]] ;;
esac
STUB
cat >"$T/stubs/sleep" <<'STUB'
#!/usr/bin/env bash
# Records its argument and returns at once; $FIX/sleep-fails makes it fail;
# $FIX/sleep-block makes it really sleep (for the signal cases), after writing its pid to $FIX/sleeping.
printf 'sleep %s\n' "$*" >>"$FIX/calls"
[[ ! -e $FIX/sleep-fails ]] || exit 1
if [[ -e $FIX/sleep-block ]]; then
  echo $$ >"$FIX/sleeping"
  exec "$REAL_SLEEP" 30
fi
STUB
chmod +x "$T/stubs"/*

# ---------------------------------------------------------------- fixtures
setup() {
  cases=$((cases + 1))
  C=$T/case$cases
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
  : >"$FIX/calls"
}

# run <args>: sets $rc; output in $C/out.
run() {
  rc=0
  "$bin/rws-drill" "$@" >"$C/out" 2>&1 || rc=$?
}

# ---------------------------------------------------------------- assertions
fail() {
  echo "  FAIL: $*" >&2
  echo "  --- output:" >&2
  if [[ -f $C/out ]]; then sed 's/^/  | /' "$C/out" >&2; fi
  failures=$((failures + 1))
}
expect_rc() { [[ $rc == "$1" ]] || fail "exit $rc, expected $1"; }
expect_grep() { grep -qE -- "$1" "$2" || fail "no line matching /$1/ in ${2##*/}"; }
expect_no_grep() { ! grep -qE -- "$1" "$2" || fail "unexpected line matching /$1/ in ${2##*/}"; }
expect_count() {
  local n
  n=$(grep -cE -- "$1" "$2" || true)
  [[ $n == "$3" ]] || fail "$n lines matching /$1/ in ${2##*/}, expected $3"
}
# The calls, in order, as one line: "ps|stop|sleep 7200|start" (compose calls reduced to their verb).
calls() {
  sed -E 's/^docker compose .* (ps|stop|start) .*$/\1/' "$FIX/calls" | tr '\n' '|'
}
# No docker call at all, and no sleep.
expect_untouched() { [[ ! -s $FIX/calls ]] || fail "unexpected calls: $(calls)"; }
case_() {
  labels=$((labels + 1))
  printf 'case %s\n' "$*"
}

# ---------------------------------------------------------------- cases
case_ "usage errors exit 64 and touch nothing: no subcommand, another subcommand, no duration, extra arguments, unknown flags"
setup
for args in '' 'start-capture 2h' 'stop-capture' 'stop-capture 2h extra' 'stop-capture 2h 3h' 'stop-capture 2h db' \
  'stop-capture 2h --bogus' '--dry-run' '--dry-run stop-capture 2h' 'stop-capture --dry-run' 'stop 2h' 'capture'; do
  # shellcheck disable=SC2086 # the words of $args are the arguments
  run $args
  expect_rc 64
  expect_grep "^usage: rws-drill stop-capture" "$C/out"
  expect_untouched
done

case_ "invalid durations exit 64, touch nothing and evaluate nothing"
setup
# shellcheck disable=SC2016 # the command substitutions are meant to stay unexpanded
for d in 0h 0m 7h 361m 1000m 999h 2 2d 2s -1h '' '2h;id' '2h && id' 'a[$(touch '"$C"'/pwned)]h' '$(touch '"$C"'/pwned)h' \
  '1h 2h' ' 2h' '2h ' $'2h\n' $'\n2h' 02h 1.5h 2H h m 'x[0]=1h' '1h+1' '1e1h' '０h' '٢h'; do
  run stop-capture "$d"
  expect_rc 64
  expect_untouched
  [[ ! -e $C/pwned ]] || fail "a command substitution in the duration ran ('$d')"
done
for d in 0h 7h; do
  run stop-capture "$d" --dry-run
  expect_rc 64
done

case_ "a flag in either place: --dry-run before or after the duration"
setup
run stop-capture 2h --dry-run
expect_rc 0
run stop-capture --dry-run 2h
expect_rc 0

case_ "--dry-run: exit 0, says what it would do, no docker call, no sleep"
setup
run stop-capture 2h --dry-run
expect_rc 0
expect_grep "dry-run: would stop capture for 2h \(7200 s\)" "$C/out"
expect_untouched
expect_no_grep "^outage window" "$C/out"

case_ "DRY_RUN in the environment does not turn a real run into a dry one, and is never evaluated"
setup
DRY_RUN="a[\$(touch $C/pwned)]" run stop-capture 90m
expect_rc 0
[[ ! -e $C/pwned ]] || fail "DRY_RUN from the environment was evaluated"
expect_grep "^docker compose .* stop capture$" "$FIX/calls"

case_ "stop-capture 2h: ps, stop, sleep 7200, start, in that order; no other service; the window and the check are printed"
setup
run stop-capture 2h
expect_rc 0
[[ $(calls) == "ps|stop|sleep 7200|start|" ]] || fail "calls: $(calls)"
expect_count "^docker " "$FIX/calls" 3
expect_grep "^docker compose -p rws --project-directory $C/state/active -f $C/state/active/compose.yaml .* ps -q --status running capture$" "$FIX/calls"
expect_grep "^docker compose -p rws .* stop capture$" "$FIX/calls"
expect_grep "^docker compose -p rws .* start capture$" "$FIX/calls"
expect_no_grep "^docker .* (up|down|rm|restart|kill|run|exec|pull|create) " "$FIX/calls"
iso='20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
expect_grep "rws-drill: outage starts $iso$" "$C/out"
expect_grep "rws-drill: outage ends $iso: capture started$" "$C/out"
expect_grep "^outage window \(UTC\): $iso to $iso$" "$C/out"
expect_grep "^  curl -fsS https://rivierstanden\.example/api/v1/health/sources \| jq --arg from '$iso' --arg to '$iso' '" "$C/out"
from=$(sed -n 's/^outage window (UTC): \([^ ]*\) to .*/\1/p' "$C/out")
to=$(sed -n 's/^outage window (UTC): [^ ]* to \(.*\)$/\1/p' "$C/out")
[[ $from < $to || $from == "$to" ]] || fail "the window is backwards: $from to $to"
[[ $(sed -n "s/^.* --arg from '\([^']*\)' --arg to '\([^']*\)'.*/\1 \2/p" "$C/out") == "$from $to" ]] ||
  fail "the printed command does not carry the window"
[[ -e $RWS_LOCK_DIR/rws-deploy.lock ]] || fail "the deploy lock file was never created"

case_ "other durations: 90m sleeps 5400, 1m 60, 360m and 6h 21600, 45m 2700"
for pair in '90m 5400' '1m 60' '360m 21600' '6h 21600' '45m 2700' '1h 3600' '999m x'; do
  setup
  run stop-capture "${pair% *}"
  if [[ ${pair#* } == x ]]; then
    expect_rc 64
    expect_untouched
  else
    expect_rc 0
    [[ $(calls) == "ps|stop|sleep ${pair#* }|start|" ]] || fail "${pair% *}: calls: $(calls)"
  fi
done

case_ "the sleep fails: capture is started anyway, the exit status is not 0, the window is printed"
setup
touch "$FIX/sleep-fails"
run stop-capture 2h
[[ $rc != 0 ]] || fail "exit 0 after a failed sleep"
[[ $(calls) == "ps|stop|sleep 7200|start|" ]] || fail "calls: $(calls)"
expect_grep "^outage window \(UTC\):" "$C/out"

case_ "the stop fails: capture is still started (it may have stopped half-way), no sleep, not 0, no window"
setup
touch "$FIX/stop-fails"
run stop-capture 2h
[[ $rc != 0 ]] || fail "exit 0 after a failed stop"
[[ $(calls) == "ps|stop|start|" ]] || fail "calls: $(calls)"
expect_no_grep "^outage window" "$C/out"

case_ "the start fails: exit 1 and a loud error naming the container and the runbook"
setup
touch "$FIX/start-fails"
run stop-capture 2h
expect_rc 1
expect_grep "error: CAPTURE IS STILL STOPPED and the drill could not start it: run 'sudo docker start rws-capture-1' now \(docs/runbooks/recorder-down\.md\)" "$C/out"
expect_count "^docker compose .* start capture$" "$FIX/calls" 1
expect_no_grep "^outage window" "$C/out"

case_ "the start fails after a failed sleep: still exit 1 and the loud error"
setup
touch "$FIX/start-fails" "$FIX/sleep-fails"
run stop-capture 2h
expect_rc 1
expect_grep "error: CAPTURE IS STILL STOPPED" "$C/out"

case_ "a signal during the sleep (TERM, INT, HUP): capture is started once, the window is printed, exit 128 + signal, the sleep is gone"
# Job control, so the background job does not ignore SIGINT as a non-interactive shell's background jobs do.
for sig in TERM:143 INT:130 HUP:129; do
  setup
  touch "$FIX/sleep-block"
  set -m
  "$bin/rws-drill" stop-capture 2h >"$C/out" 2>&1 &
  pid=$!
  set +m
  for _ in $(seq 1 100); do
    [[ -e $FIX/sleeping ]] && break
    "$REAL_SLEEP" 0.1
  done
  [[ -e $FIX/sleeping ]] || fail "$sig: the drill never reached its sleep"
  kill -"${sig%:*}" "$pid"
  # Prompt: a signal must end the drill at once, not when a foreground sleep returns.
  for _ in $(seq 1 50); do
    grep -q ' start capture$' "$FIX/calls" && break
    "$REAL_SLEEP" 0.1
  done
  grep -q ' start capture$' "$FIX/calls" || { fail "${sig%:*}: capture not started within 5 s of the signal"; kill -KILL "$pid"; }
  rc=0
  { wait "$pid" || rc=$?; } 2>/dev/null
  expect_rc "${sig#*:}"
  [[ $(calls) == "ps|stop|sleep 7200|start|" ]] || fail "${sig%:*}: calls: $(calls)"
  expect_count "^docker compose .* start capture$" "$FIX/calls" 1
  expect_grep "^outage window \(UTC\):" "$C/out"
  gone=0
  for _ in $(seq 1 50); do
    kill -0 "$(<"$FIX/sleeping")" 2>/dev/null || { gone=1; break; }
    "$REAL_SLEEP" 0.1
  done
  ((gone)) || fail "${sig%:*}: the background sleep is still running"
done

case_ "the lock is held (a deploy or update): refuses with exit 1, no docker call, no sleep, no start"
setup
flock "$RWS_LOCK_DIR/rws-deploy.lock" "$REAL_SLEEP" 3 &
"$REAL_SLEEP" 0.5
run stop-capture 2h
expect_rc 1
expect_grep "a deploy or update is running \(rws-deploy lock\)" "$C/out"
expect_untouched
run stop-capture 2h --dry-run
expect_rc 1
expect_untouched
wait
run stop-capture 2h
expect_rc 0

case_ "the drill holds the deploy lock while it sleeps, and only the script does: a SIGKILLed drill leaves it free even though its sleep lives on"
setup
touch "$FIX/sleep-block"
set -m
"$bin/rws-drill" stop-capture 2h >"$C/out" 2>&1 &
pid=$!
set +m
for _ in $(seq 1 100); do
  [[ -e $FIX/sleeping ]] && break
  "$REAL_SLEEP" 0.1
done
[[ -e $FIX/sleeping ]] || fail "the drill never reached its sleep"
if flock -n "$RWS_LOCK_DIR/rws-deploy.lock" true; then fail "the lock was free during the drill"; fi
kill -KILL "$pid"
{ wait "$pid" || true; } 2>/dev/null
kill -0 "$(<"$FIX/sleeping")" 2>/dev/null || fail "the sleep did not outlive the killed script"
flock -n "$RWS_LOCK_DIR/rws-deploy.lock" true || fail "the sleep of a killed drill keeps the lock"
kill "$(<"$FIX/sleeping")" 2>/dev/null || true

case_ "capture is not running: refuses with exit 1, asks docker once, never stops or starts"
setup
touch "$FIX/capture-down"
run stop-capture 2h
expect_rc 1
expect_grep "capture is not running: nothing to drill" "$C/out"
[[ $(calls) == "ps|" ]] || fail "calls: $(calls)"

case_ "rws.env incomplete, or no release deployed: refuses, no docker call"
setup
echo 'RWS_DOMAIN=' >"$RWS_ETC/rws.env"
run stop-capture 2h
expect_rc 1
expect_grep "rws\.env is not complete" "$C/out"
expect_untouched
setup
rm "$RWS_STATE_DIR/active"
run stop-capture 2h
expect_rc 1
expect_grep "no release is deployed yet" "$C/out"
expect_untouched

case_ "the check command's jq program: pass only when the outage brackets the window and missing_buckets is 0"
setup
filter=$(sed -n "s/^readonly CHECK_JQ='\(.*\)'\$/\1/p" "$bin/rws-drill")
[[ -n $filter ]] || fail "no CHECK_JQ in rws-drill"
verdicts() { # <outage json of DE-1> <outage json of NL-1>
  jq -c --arg from 2026-10-05T07:10:00Z --arg to 2026-10-05T09:10:00Z "$filter" <<<"{\"sources\": [
    {\"id\": \"DE-1\", \"outage\": $1}, {\"id\": \"LU-1\", \"outage\": null}, {\"id\": \"NL-1\", \"outage\": $2}]}" |
    jq -r '"\(.id):\(.pass)"' | tr '\n' ' '
}
ok='{"from": "2026-10-05T07:00:00Z", "to": "2026-10-05T09:20:00Z", "missing_buckets": 0}'
[[ $(verdicts "$ok" "$ok") == "DE-1:true NL-1:true " ]] || fail "a bracketing outage with 0 missing: $(verdicts "$ok" "$ok")"
frac='{"from": "2026-10-05T07:09:59.500Z", "to": "2026-10-05T09:10:00.123Z", "missing_buckets": 0}'
[[ $(verdicts "$frac" "$frac") == "DE-1:true NL-1:true " ]] || fail "fractions of a second: $(verdicts "$frac" "$frac")"
miss='{"from": "2026-10-05T07:00:00Z", "to": "2026-10-05T09:20:00Z", "missing_buckets": 3}'
[[ $(verdicts "$ok" "$miss") == "DE-1:true NL-1:false " ]] || fail "missing buckets: $(verdicts "$ok" "$miss")"
late='{"from": "2026-10-05T07:10:01Z", "to": "2026-10-05T09:20:00Z", "missing_buckets": 0}'
early='{"from": "2026-10-05T07:00:00Z", "to": "2026-10-05T09:09:59Z", "missing_buckets": 0}'
[[ $(verdicts "$late" "$early") == "DE-1:false NL-1:false " ]] || fail "not bracketing: $(verdicts "$late" "$early")"
[[ $(verdicts null "$ok") == "DE-1:false NL-1:true " ]] || fail "no outage: $(verdicts null "$ok")"
[[ $(jq -c --arg from 2026-10-05T07:10:00Z --arg to 2026-10-05T09:10:00Z "$filter" <<<'{"sources": [{"id": "DE-1"}]}' |
  jq -r .pass) == false ]] || fail "a source without an outage field must not pass"

case_ "the runbook carries the jq program of rws-drill verbatim and shows the drill command"
grep -qF -- "'$filter'" "$runbook" || fail "docs/runbooks/outage-drill.md does not hold the jq program of rws-drill verbatim"
grep -qF -- 'rws-drill stop-capture 2h' "$runbook" || fail "the runbook does not show the drill command"

echo "$labels cases, $failures failures"
((failures == 0))
