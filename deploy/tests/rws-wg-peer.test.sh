#!/usr/bin/env bash
# Offline test of rws-wg-peer (P12a, issue #27) and of deploy/host/wireguard/wg0.conf.template. `wg` is a stub on
# PATH (keys are derived from random bytes, a peer is "live" while $FIX/up exists); wg-quick is not run: the
# template is checked line by line against what wg-quick accepts (no `wg-quick strip` without wireguard-tools;
# the CI deploy job and the owner's host run the real one). Usage: deploy/tests/rws-wg-peer.test.sh
# shellcheck disable=SC2015 # `test && ok || fail`: ok never fails
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bin=$(cd "$here/../bin" && pwd)
tpl=$here/../host/wireguard/wg0.conf.template
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
failures=0
ok() { echo "  PASS $*"; }
fail() {
  echo "  FAIL $*" >&2
  failures=$((failures + 1))
}

# ---------------------------------------------------------------- the template
echo "template"
body=$(grep -Ev '^[[:space:]]*(#|$)' "$tpl")
[[ $(head -n 1 <<<"$body") == '[Interface]' ]] && ok "starts with [Interface]" || fail "no [Interface] first"
grep -qx 'Address = 10.66.0.1/24' <<<"$body" && ok "Address 10.66.0.1/24" || fail "Address"
grep -qx 'ListenPort = 51820' <<<"$body" && ok "ListenPort 51820" || fail "ListenPort"
grep -qx 'PostUp = wg set %i private-key /etc/wireguard/wg0.key' <<<"$body" && ok "the key is read from wg0.key at PostUp" || fail "private-key PostUp"
! grep -qiE '^(PrivateKey|PresharedKey|\[Peer\])' <<<"$body" && ok "no key, no peer in the template" || fail "a key or peer in the template"
# Every key is one wg-quick knows.
bad=$(grep -vE '^(\[Interface\]|(Address|ListenPort|PostUp|PostDown|PreUp|PreDown|MTU|Table|SaveConfig|DNS) = .+)$' <<<"$body" || true)
[[ -z $bad ]] && ok "only wg-quick [Interface] keys" || fail "unknown lines: $bad"

# ---------------------------------------------------------------- stubs
mkdir -p "$T/stubs"
cat >"$T/stubs/wg" <<'STUB'
#!/usr/bin/env bash
# genkey/genpsk: 32 random bytes in base64; pubkey: sha256 of stdin in base64 (stable per private key).
set -euo pipefail
printf 'wg %s\n' "$*" >>"$FIX/calls"
case $1 in
  genkey | genpsk) head -c 32 /dev/urandom | base64 ;;
  pubkey)
    if (($# > 1)); then in=$(cat "$2"); else in=$(cat); fi
    printf '%s' "$in" | openssl dgst -sha256 -binary | base64
    ;;
  show)
    [[ -e $FIX/up ]] || exit 1
    [[ ${3:-} != latest-handshakes ]] || cat "$FIX/handshakes" 2>/dev/null || true
    ;;
  addconf)
    [[ -e $FIX/up && ! -e $FIX/addconf-fails ]] || exit 1
    cat "$3" >>"$FIX/live-conf"
    ;;
  set) [[ -e $FIX/up ]] && printf '%s\n' "$*" >>"$FIX/set" ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$T/stubs/wg"
export PATH=$T/stubs:$PATH

setup() {
  C=$T/case$((++cases))
  mkdir -p "$C"/{etc,wg,lock,fix}
  export FIX=$C/fix RWS_ETC=$C/etc RWS_WG_DIR=$C/wg RWS_LOCK_DIR=$C/lock
  printf 'RWS_DOMAIN=rivierstanden.example\nRWS_PUBLIC_IPV4=198.51.100.7\n' >"$C/etc/rws.env"
  printf 'c2VydmVyLWtleS1ub3QtYS1yZWFsLWtleS0wMTIzNDU2Nzg=\n' >"$C/wg/wg0.key"
  touch "$FIX/calls"
}
cases=0
run() { # sets rc; stdout in $C/out, stderr in $C/err
  rc=0
  "$bin/rws-wg-peer" "$@" >"$C/out" 2>"$C/err" || rc=$?
}

# ---------------------------------------------------------------- add / list / revoke
echo "add"
setup
touch "$FIX/up"
run add laptop
[[ $rc == 0 ]] && ok "add exits 0" || fail "add exit $rc: $(cat "$C/err")"
conf=$C/out
grep -qx '\[Interface\]' "$conf" && grep -qx 'Address = 10.66.0.2/32' "$conf" && ok "client config: first free address 10.66.0.2/32" || fail "client address: $(cat "$conf")"
grep -qx 'Endpoint = 198.51.100.7:51820' "$conf" && grep -qx 'AllowedIPs = 10.66.0.1/32' "$conf" && grep -qx 'PersistentKeepalive = 25' "$conf" && ok "client config: endpoint, AllowedIPs only the owner site, keepalive" || fail "client peer lines"
cpriv=$(sed -n 's/^PrivateKey = //p' "$conf")
cpub=$(printf '%s\n' "$cpriv" | wg pubkey)
spub=$(wg pubkey <"$RWS_WG_DIR/wg0.key")
grep -qx "PublicKey = $spub" "$conf" && ok "client config carries the server's public key" || fail "server public key"
psk=$(sed -n 's/^PresharedKey = //p' "$conf")
peers=$RWS_WG_DIR/wg0.peers.conf
[[ $(stat -c %a "$peers") == 600 ]] && ok "wg0.peers.conf is 0600" || fail "peers mode"
grep -qx "PublicKey = $cpub" "$peers" && grep -qx "AllowedIPs = 10.66.0.2/32" "$peers" && grep -qx "PresharedKey = $psk" "$peers" && ok "the peer (public key, preshared key, /32) is in wg0.peers.conf" || fail "peer block: $(cat "$peers")"
! grep -qF "$cpriv" "$peers" "$C/err" "$FIX/calls" "$FIX/live-conf" && ok "the client's private key is in no file, no log and no wg argv" || fail "the private key leaked"
grep -qx "PublicKey = $cpub" "$FIX/live-conf" && ok "the running wg0 got the peer (wg addconf)" || fail "no live peer"
! grep -rqF "$cpriv" "$C/wg" "$C/etc" "$C/lock" && ok "the private key is nowhere under the server's directories" || fail "private key on disk"
grep -qE '^wg0\.conf$' <(ls "$C/wg") && fail "the script wrote wg0.conf" || ok "wg0.conf is bootstrap's: not touched"

run add phone
[[ $rc == 0 ]] && grep -qx 'Address = 10.66.0.3/32' "$C/out" && ok "second device gets 10.66.0.3" || fail "second add"
run add laptop
[[ $rc != 0 ]] && grep -q 'a device named laptop exists' "$C/err" && ok "a duplicate name is refused" || fail "duplicate"
for bad in 'Laptop' '-x' 'a b' 'a;b' '../x' '' 'a.b' "$(printf 'a%.0s' {1..40})"; do
  run add "$bad"
  [[ $rc != 0 ]] || fail "name '$bad' accepted"
done
ok "invalid names are refused (case, leading dash, space, ;, .., empty, dot, 40 chars)"

echo "list"
printf '%s 1780000000\n' "$cpub" >"$FIX/handshakes"
run list
[[ $rc == 0 ]] && grep -qE "^laptop +10\.66\.0\.2 +2026-.* $cpub$" "$C/out" && grep -qE '^phone +10\.66\.0\.3 +never ' "$C/out" && ok "list: name, address, handshake or never, public key" || fail "list: $(cat "$C/out")"

echo "revoke"
run revoke laptop
[[ $rc == 0 ]] && ok "revoke exits 0" || fail "revoke exit $rc"
! grep -q "$cpub" "$peers" && grep -q 'name=phone' "$peers" && ok "laptop is gone from the file, phone stays" || fail "peers after revoke: $(cat "$peers")"
grep -qx "set wg0 peer $cpub remove" "$FIX/set" && ok "wg set peer remove ran" || fail "no live remove"
run revoke laptop
[[ $rc != 0 ]] && grep -q 'no device named laptop' "$C/err" && ok "revoking an unknown device fails" || fail "revoke unknown"
run add tablet
grep -qx 'Address = 10.66.0.2/32' "$C/out" && ok "a revoked address is handed out again" || fail "address reuse"
run revoke phone
run revoke tablet
[[ $(grep -c . "$peers" || true) == 0 ]] && ok "an empty peer file after the last revoke" || fail "peers not empty"

echo "wg0 down, and a failing live add"
setup
run add laptop
[[ $rc == 0 ]] && grep -q 'wg0 is down' "$C/err" && grep -q 'name=laptop' "$RWS_WG_DIR/wg0.peers.conf" && ok "wg0 down: the file is updated, a note says it comes up with wg-quick" || fail "wg0 down: rc $rc"
run list
grep -qE '^laptop +10\.66\.0\.2 +never' "$C/out" && ok "list works with wg0 down" || fail "list down"
run revoke laptop
[[ $rc == 0 ]] && ok "revoke works with wg0 down" || fail "revoke down"
setup
touch "$FIX/up" "$FIX/addconf-fails"
run add laptop
[[ $rc != 0 && ! -s $RWS_WG_DIR/wg0.peers.conf ]] && ok "a failed wg addconf puts the file back and prints no config" || fail "addconf failure: rc $rc"
[[ ! -s $C/out ]] && ok "no client config on failure" || fail "config printed on failure"

echo "refusals"
setup
rm "$RWS_WG_DIR/wg0.key"
run add laptop
[[ $rc != 0 ]] && ok "no server key: refused" || fail "no key"
setup
: >"$C/etc/rws.env"
run add laptop
[[ $rc != 0 ]] && ok "no RWS_PUBLIC_IPV4: refused" || fail "no endpoint"
run
[[ $rc == 64 ]] && ok "no command: usage, 64" || fail "usage rc $rc"

echo "$cases cases, $failures failures"
((failures == 0))
