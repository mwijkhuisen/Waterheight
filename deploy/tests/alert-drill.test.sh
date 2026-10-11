#!/usr/bin/env bash
# Offline tests of deploy/tests/alert-drill.sh (P12b, issue #27): a python3 stub on a loopback port stands in for
# hc-ping.com. Every slug of deploy/healthchecks.yaml gets exactly one /fail and then one success ping, the key
# reaches the stub (through curl -K -) and never the output, and the trap restores the checks when the drill is
# killed or a ping fails midway. No network beyond 127.0.0.1; jq, curl and python3 are real.
# Usage: deploy/tests/alert-drill.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
drill=$here/alert-drill.sh
list=$here/../healthchecks.yaml
T=$(mktemp -d)
stub_pid=''
cleanup() {
  [[ -z $stub_pid ]] || kill "$stub_pid" 2>/dev/null || true
  rm -rf -- "$T"
}
trap cleanup EXIT
failures=0 labels=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}
case_() {
  labels=$((labels + 1))
  echo "== $*"
}

KEY=fake_ping_key_aaaaaaaaaaaa
export RWS_ETC=$T/etc
mkdir -p "$RWS_ETC/secrets"
printf '%s\n' "$KEY" >"$RWS_ETC/secrets/hc_ping_key"

mapfile -t slugs < <(grep -v '^[[:space:]]*#' "$list" | jq -r '.checks[].slug')
n=${#slugs[@]}
((n >= 18)) || fail "healthchecks.yaml lists only $n slugs"

# The stub: logs "<path> <body>" per request; FAIL404 names a slug whose /fail answers 404 (curl -f; not retried).
cat >"$T/stub.py" <<'PY'
import http.server, os, sys

LOG, PORT_FILE, BAD = sys.argv[1], sys.argv[2], os.environ.get("FAIL404", "")

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        with open(LOG, "a") as f:
            f.write(f"{self.path} {body}\n")
        code = 404 if BAD and self.path.endswith(f"/{BAD}/fail") else 200
        self.send_response(code)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"OK")
    do_GET = do_POST
    def log_message(self, *a):
        pass

s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(PORT_FILE, "w") as f:
    f.write(str(s.server_address[1]))
s.serve_forever()
PY

LOG=$T/requests PORT='' OUT=$T/out ERR=$T/err
# start_stub [FAIL404 slug]: a fresh stub, log and port.
start_stub() {
  [[ -z $stub_pid ]] || kill "$stub_pid" 2>/dev/null || true
  : >"$LOG"
  rm -f "$T/port"
  FAIL404=${1:-} python3 -I "$T/stub.py" "$LOG" "$T/port" &
  stub_pid=$!
  for _ in $(seq 100); do
    [[ -s $T/port ]] && break
    sleep 0.05
  done
  PORT=$(<"$T/port")
}
# idx <path suffix>: the 1-based line numbers of the requests ending that way.
idx() { grep -n -F -- " " "$LOG" | awk -F'[: ]' -v s="$1" '{ p = $2; if (substr(p, length(p) - length(s) + 1) == s) print $1 }'; }
drill() { "$drill" --dry-run --hc-base "http://127.0.0.1:$PORT" "$@" >"$OUT" 2>"$ERR"; }
no_key_in_output() { ! grep -qF -- "$KEY" "$OUT" "$ERR" || fail "$1: the ping key is in the output"; }

case_ "every slug: one /fail, then one success; the key stays out of the output"
start_stub
rc=0
drill --hold 0 || rc=$?
((rc == 0)) || fail "exit $rc: $(cat "$ERR")"
[[ $(wc -l <"$LOG") == $((2 * n)) ]] || fail "expected $((2 * n)) requests, got $(wc -l <"$LOG")"
for s in "${slugs[@]}"; do
  f=$(idx "/$s/fail")
  o=$(idx "/$s")
  [[ $(wc -w <<<"$f") == 1 && $(wc -w <<<"$o") == 1 ]] || {
    fail "$s: not exactly one /fail and one success ($f | $o)"
    continue
  }
  ((f < o)) || fail "$s: the success came before the /fail"
  grep -qxF -- "/$KEY/$s/fail alert_drill_fail" "$LOG" || fail "$s: /fail path or body (key not passed through curl -K -?)"
  grep -qxF -- "/$KEY/$s alert_drill" "$LOG" || fail "$s: success path or body"
  grep -qF -- "| $s | 20" "$OUT" || fail "$s: no receipt row"
done
[[ $(grep -c '^| [a-z0-9-]* | 20.*Z | 20.*Z | \[ \] |$' "$OUT") == "$n" ]] || fail "receipt rows are not $n complete rows: $(cat "$OUT")"
grep -qF '| slug | /fail sent UTC | success sent UTC | alert received (owner) |' "$OUT" || fail "no receipt header"
no_key_in_output "all slugs"
# the /fail pings all come before the restore
last_fail=$(grep -n '/fail ' "$LOG" | tail -1 | cut -d: -f1)
first_ok=$(grep -n -v '/fail ' "$LOG" | head -1 | cut -d: -f1)
((last_fail < first_ok)) || fail "a success ping came before the last /fail"

case_ "--only sends one /fail and one success"
start_stub
rc=0
drill --hold 0 --only cap-lu || rc=$?
((rc == 0)) || fail "exit $rc"
[[ $(wc -l <"$LOG") == 2 ]] || fail "expected 2 requests: $(cat "$LOG")"
grep -qxF -- "/$KEY/cap-lu/fail alert_drill_fail" "$LOG" || fail "no cap-lu /fail"
rc=0
drill --hold 0 --only nope || rc=$?
((rc != 0)) || fail "an unknown slug was accepted"

case_ "a failed ping midway: non-zero exit, and the trap restores every check already failed"
bad=${slugs[4]}
start_stub "$bad"
rc=0
drill --hold 0 || rc=$?
((rc != 0)) || fail "a 404 on /fail exited 0"
for i in 0 1 2 3 4; do
  s=${slugs[$i]}
  [[ -n $(idx "/$s/fail") ]] || fail "$s: no /fail"
  [[ -n $(idx "/$s") ]] || fail "$s: not restored after the failure"
done
[[ -z $(idx "/${slugs[5]}/fail") && -z $(idx "/${slugs[5]}") ]] || fail "pinged beyond the failure"
no_key_in_output "failed ping"

case_ "killed during the hold: the trap restores every check at once"
start_stub
"$drill" --dry-run --hc-base "http://127.0.0.1:$PORT" --hold 60 >"$OUT" 2>"$ERR" &
pid=$!
for _ in $(seq 200); do
  [[ $(grep -c '/fail ' "$LOG") == "$n" ]] && break
  sleep 0.05
done
[[ $(grep -c '/fail ' "$LOG") == "$n" ]] || fail "the drill did not send all /fail pings"
start=$SECONDS
kill -TERM "$pid"
rc=0
wait "$pid" || rc=$?
((rc != 0)) || fail "killed drill exited 0"
((SECONDS - start < 20)) || fail "the trap waited for the hold"
for s in "${slugs[@]}"; do [[ -n $(idx "/$s") ]] || fail "$s: not restored after SIGTERM"; done
[[ $(wc -l <"$LOG") == $((2 * n)) ]] || fail "expected $((2 * n)) requests after SIGTERM, got $(wc -l <"$LOG")"
no_key_in_output "killed drill"

case_ "refusals: no real pings by mistake"
start_stub
rc=0
"$drill" --hc-base "http://127.0.0.1:$PORT" >"$OUT" 2>"$ERR" || rc=$?
((rc == 64)) || fail "--hc-base without --dry-run: exit $rc"
rc=0
"$drill" --dry-run --hc-base http://example.com >"$OUT" 2>"$ERR" || rc=$?
((rc != 0)) || fail "a non-loopback --hc-base was accepted"
rc=0
"$drill" --dry-run >"$OUT" 2>"$ERR" || rc=$?
((rc == 64)) || fail "--dry-run without --hc-base: exit $rc"
RWS_ETC=$T/empty "$drill" >"$OUT" 2>"$ERR" || rc=$?
grep -qF 'no usable hc_ping_key' "$ERR" || fail "a real run without a key did not stop: $(cat "$ERR")"
[[ ! -s $LOG ]] || fail "requests reached the stub in a refused run"

echo "$labels cases, $failures failures"
((failures == 0))
