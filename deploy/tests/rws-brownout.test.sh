#!/usr/bin/env bash
# Offline tests of rws-brownout (P12a, issue #27; A§9.2): the automatic arm and disarm on a fake clock (RWS_NOW) over
# synthetic Caddy JSON access-log lines, the manual override, log rotation and the units. No root, no network: every
# case runs in a fresh temporary root; jq, awk, flock and stat are real.
# Usage: deploy/tests/rws-brownout.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bin=$(cd "$here/../bin" && pwd)/rws-brownout
systemd=$(cd "$here/../systemd" && pwd)
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
failures=0 labels=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}
case_() {
  labels=$((labels + 1))
  echo "== $*"
}

T0=1800000000 # a multiple of 15
C='' DIR='' LOG='' OUT=''
setup() {
  C=$(mktemp -d "$T/case.XXXX")
  DIR=$C/flag LOG=$C/access.log OUT=$C/out
  mkdir -m 0755 "$DIR" "$C/lock"
  : >"$LOG"
  export RWS_BROWNOUT_DIR=$DIR RWS_BROWNOUT_LOG=$LOG RWS_BROWNOUT_STATE=$C/state RWS_LOCK_DIR=$C/lock RWS_STATE_DIR=$C/lib
  echo auto >"$DIR/mode"
}
# rb <now> <args...>: one run at a fake time; stderr (the journal line) goes to $OUT.
rb() {
  local now=$1
  shift
  RWS_NOW=$now "$bin" "$@" 2>"$OUT"
}
# gen <ts> <200s> <5xx> <brownout-503>: Caddy-shaped access-log lines for /api/v1/ appended to the log.
gen() {
  awk -v ts="$1" -v ok="$2" -v bad="$3" -v bo="$4" 'BEGIN {
    for (i = 0; i < ok; i++) printf "{\"level\":\"info\",\"ts\":%.3f,\"status\":200,\"request\":{\"method\":\"GET\",\"uri\":\"/api/v1/latest?i=%d\"},\"resp_headers\":{\"Cache-Control\":[\"no-cache\"]}}\n", ts + (i % 10) * 0.1, i
    for (i = 0; i < bad; i++) printf "{\"ts\":%.3f,\"status\":%d,\"request\":{\"uri\":\"/api/v1/series?i=%d\"},\"resp_headers\":{}}\n", ts + 2, 500 + (i % 4), i
    for (i = 0; i < bo; i++) printf "{\"ts\":%.3f,\"status\":503,\"request\":{\"uri\":\"/api/v1/series?res=raw\"},\"resp_headers\":{\"%s\":[\"1\"]}}\n", ts + 3, (i % 2 ? "X-Brownout" : "x-brownout")
  }' >>"$LOG"
}
# tick <k> <200s> <5xx> <brownout-503>: the traffic of 15 s bucket k, then an evaluation at the end of that bucket.
tick() {
  local ts=$((T0 + $1 * 15))
  gen "$ts" "$2" "$3" "$4"
  rb $((ts + 14)) evaluate
}
ticks() { # ticks <from> <to> <200s> <5xx> <brownout-503>
  local k
  for k in $(seq "$1" "$2"); do tick "$k" "$3" "$4" "$5"; done
}
active() { [[ -f $DIR/active ]]; }
expect_active() { active || fail "$1: not active"; }
expect_inactive() { ! active || fail "$1: active"; }
# has <now> <text>: the status at that time contains the text (captured first: no SIGPIPE through grep -q).
has() {
  local out
  out=$(rb "$1" status)
  [[ $out == *"$2"* ]] || fail "status lacks '$2': $out"
}

# ---------------------------------------------------------------------------------------------------------------
case_ "engages within 60 s of the 5-minute share crossing 2 %"
setup
ticks 0 19 100 0 0
expect_inactive "calm baseline"
tick 20 70 30 0 # 30 of the 2000 requests of the window: 1.5 %
expect_inactive "1.5 %"
tick 21 70 30 0 # 60 of 2000: 3 %, the evaluation that sees it arms (the limit is 4 ticks = 60 s)
expect_active "3 %"
[[ $(grep -c . "$OUT") == 1 ]] || fail "not exactly one journal line: $(cat "$OUT")"
grep -q 'brownout on: 5xx 60 of 2000' "$OUT" || fail "journal line: $(cat "$OUT")"
if grep -q '/api/v1\|uri\|GET' "$OUT"; then fail "request data in the journal"; fi
[[ $(stat -c %a "$DIR/active") == 644 && $(stat -c %a "$DIR/mode") == 644 ]] || fail "flag files are not 0644"

case_ "no arm below 200 requests, however bad the share"
setup
ticks 0 19 0 9 0 # 180 requests in the window, all 5xx
expect_inactive "180 requests"
has $((T0 + 20 * 15 - 1)) 'window 5 min: requests=180 5xx=180 share=100.00%'
tick 20 0 9 0
expect_inactive "180 requests after the slide"
setup
ticks 0 19 0 10 0 # exactly 200
expect_active "200 requests"

case_ "503s that carry X-Brownout, and non-API and non-5xx lines, never count"
setup
for k in $(seq 0 39); do
  tick "$k" 50 0 50 # 50 refusals of the brownout itself per tick, either header spelling
  printf '{"ts":%s,"status":502,"request":{"uri":"/data/v1/latest.json"}}\n' $((T0 + k * 15 + 1)) >>"$LOG"
done
expect_inactive "brownout refusals and non-API errors"
has $((T0 + 40 * 15 - 1)) 'window 5 min: requests=1000 5xx=0 '
setup
ticks 0 19 50 50 0 # plain 5xx without the header
expect_active "5xx without the header"

case_ "hysteresis: stays armed between 0.5 % and 2 %, disarms after 10 minutes in a row under 0.5 %"
setup
ticks 0 19 100 0 0
tick 20 40 60 0 # one terrible bucket
expect_active "armed by the burst"
ticks 21 80 99 1 0 # 1 % for 15 minutes: above 0.5 %, below 2 %
expect_active "steady 1 %"
[[ ! -e $C/state/calm ]] || fail "calm clock started during steady 1 %"
ticks 81 90 100 0 0 # the window still holds 10 or more of the 1 % buckets (>= 0.5 % of its 2000 requests)
[[ ! -e $C/state/calm ]] || fail "calm clock started too early"
tick 91 100 0 0 # 9 errors left in the window: under 0.5 %, calm begins
[[ -e $C/state/calm ]] || fail "calm clock not started"
expect_active "calm just began"
ticks 92 130 100 0 0 # 9.75 minutes of calm
expect_active "9.75 minutes calm"
tick 131 100 0 0
expect_inactive "10 minutes calm"
grep -q 'brownout off: calm for 600 s' "$OUT" || fail "no disarm journal line: $(cat "$OUT")"
tick 132 100 0 0
ticks 133 170 100 0 0
expect_inactive "stays off"
setup
ticks 0 19 0 10 0
expect_active "armed"
ticks 20 60 0 10 0
tick 61 98 2 0 # not calm: stays armed, the calm clock never runs
expect_active "a share inside the band"
ticks 62 100 98 2 0 # 2 % exactly is not above 2 %, and not calm either
expect_active "2 % exactly"
[[ ! -e $C/state/calm ]] || fail "calm clock started at 2 %"

case_ "a quiet site (no requests at all) counts as calm and disarms after 10 minutes"
setup
ticks 0 19 100 0 0
tick 20 0 100 0
expect_active "burst"
for k in $(seq 21 100); do rb $((T0 + k * 15 + 14)) evaluate; done # nobody calls the API any more
expect_inactive "quiet"

case_ "a calm spell is interrupted by a bad bucket: the clock restarts"
setup
ticks 0 19 0 10 0
expect_active "armed"
ticks 20 60 100 0 0 # window clean from tick 39 on
tick 61 80 20 0 # 20 of 2000: 1 %, not calm
expect_active "interrupted"
[[ ! -e $C/state/calm ]] || fail "calm clock survived the bad bucket"

case_ "the manual mode overrides auto, in both directions"
setup
ticks 0 19 0 10 0
expect_active "auto armed"
rb $((T0 + 400)) off
expect_inactive "off"
[[ $(cat "$DIR/mode") == off ]] || fail "mode file after off"
ticks 20 30 0 100 0
expect_inactive "off wins over terrible traffic"
rb $((T0 + 1000)) on
expect_active "on"
[[ $(cat "$DIR/mode") == on ]] || fail "mode file after on"
ticks 90 130 100 0 0
expect_active "on wins over a calm site"
rb $((T0 + 3000)) auto
[[ $(cat "$DIR/mode") == auto ]] || fail "mode file after auto"
expect_active "auto leaves the flag as it is"
rb $((T0 + 131 * 15 + 14)) evaluate
expect_active "the calm clock has just started"
rb $((T0 + 131 * 15 + 14 + 600)) evaluate
expect_inactive "10 minutes later a calm site is disarmed"
has $((T0 + 3100)) 'mode: auto'

case_ "idempotence: repeated runs change nothing and count nothing twice"
setup
ticks 0 19 0 10 0
expect_active "armed"
ino=$(stat -c %i "$DIR/active")
for _ in 1 2 3; do rb $((T0 + 19 * 15 + 14)) evaluate; done
[[ $(stat -c %i "$DIR/active") == "$ino" ]] || fail "active was rewritten"
[[ ! -s $OUT ]] || fail "a repeat run logged: $(cat "$OUT")"
has $((T0 + 300)) 'window 5 min: requests=200 5xx=200 '
rb $((T0 + 500)) on
rb $((T0 + 501)) on
[[ $(stat -c %i "$DIR/active") == "$ino" ]] || fail "on rewrote an existing flag"
rb $((T0 + 502)) off
rb $((T0 + 503)) off
expect_inactive "off twice"

case_ "log rotation, truncation, a half-written line, garbage"
setup
now=$((T0 + 100))
gen "$T0" 10 0 0
rb "$now" evaluate
printf '{"ts":%s,"status":200,"request":{"uri":"/api/v1/la' $((T0 + 5)) >>"$LOG" # no newline yet
rb "$now" evaluate
has "$now" 'requests=10 '
printf 'test"}}\n{garbage\n\n[1,2]\n"x"\n{"ts":"a","status":200,"request":{"uri":"/api/v1/x"}}\n' >>"$LOG"
rb "$now" evaluate
has "$now" 'requests=11 '
mv "$LOG" "$LOG.1" # Caddy rolls the file: a new inode
gen $((T0 + 20)) 7 0 0
rb "$now" evaluate
has "$now" 'requests=18 '
: >"$LOG" # truncated in place
gen $((T0 + 30)) 3 0 0
rb "$now" evaluate
has "$now" 'requests=21 '
rm -f "$LOG" # briefly missing
rb "$now" evaluate
has "$now" 'requests=21 '

case_ "old buckets are pruned and a huge old log is not re-read"
setup
gen "$T0" 50 0 0
rb $((T0 + 14)) evaluate
rb $((T0 + 14 + 700)) evaluate
sz=$(wc -c <"$C/state/buckets")
((sz == 0)) || fail "buckets not pruned: $sz bytes"
setup
head -c 6000000 /dev/zero | tr '\0' 'x' | sed 's/\(.\{100\}\)/\1\n/g' >"$LOG" # 6 MB of junk lines
gen "$T0" 30 0 0
rb $((T0 + 14)) evaluate
has $((T0 + 14)) 'requests=30 '
read -r _ off <"$C/state/pos"
[[ $off == "$(stat -c %s "$LOG")" ]] || fail "offset is not at the end"

case_ "refusals: usage, a symlinked flag directory, a malformed mode, a bad clock"
setup
rc=0
"$bin" 2>/dev/null || rc=$?
[[ $rc == 64 ]] || fail "no argument exits $rc"
rc=0
"$bin" bogus 2>/dev/null || rc=$?
[[ $rc == 64 ]] || fail "bogus exits $rc"
rc=0
"$bin" on off 2>/dev/null || rc=$?
[[ $rc == 64 ]] || fail "two arguments exit $rc"
echo maybe >"$DIR/mode"
rc=0
rb "$T0" evaluate || rc=$?
[[ $rc != 0 ]] || fail "malformed mode accepted"
echo auto >"$DIR/mode"
rc=0
RWS_NOW=yesterday "$bin" evaluate 2>/dev/null || rc=$?
[[ $rc != 0 ]] || fail "bad RWS_NOW accepted"
ln -s "$DIR" "$C/link"
rc=0
RWS_BROWNOUT_DIR=$C/link "$bin" on 2>/dev/null || rc=$?
[[ $rc != 0 ]] || fail "symlinked directory accepted"
[[ ! -e $DIR/active ]] || fail "wrote through the symlink"
rm -rf -- "$DIR"
rb "$T0" on
[[ -f $DIR/active && $(stat -c %a "$DIR") == 755 ]] || fail "the directory is created 0755 by on"

case_ "units"
service=$systemd/rws-brownout.service timer=$systemd/rws-brownout.timer
[[ -f $service && -f $timer ]] || fail "a unit file is missing"
grep -qxF 'Type=oneshot' "$service" || fail "not a oneshot"
grep -qxF 'ExecStart=/usr/local/bin/rws-brownout evaluate' "$service" || fail "ExecStart"
grep -qxF 'NoNewPrivileges=yes' "$service" || fail "no hardening"
grep -qxF 'OnUnitActiveSec=15s' "$timer" || fail "interval"
grep -qxF 'AccuracySec=1s' "$timer" || fail "accuracy"
grep -qxF 'Persistent=false' "$timer" || fail "persistent"
grep -qxF 'WantedBy=timers.target' "$timer" || fail "no [Install]"

echo "$labels cases, $failures failures"
((failures == 0))
