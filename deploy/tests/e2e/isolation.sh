#!/usr/bin/env bash
# CI only (called by deploy/tests/e2e/run.sh once the stack runs with the owner
# overlay; plan P9a §4.9): the owner channel is isolated from the public one by
# construction. Prints one PASS line per proof, exits 1 on the first failure.
#   1. docker inspect: publish mounts nothing of /srv/rws/owner, publish-owner of
#      /srv/rws/public only the river release directory, read-only (P11a, D-C), the public caddy no owner path and no secret,
#      caddy-owner only the owner v1, the tiles and the rivers directory (read-only), no published port;
#   2. write attempts across the roots fail from inside the containers;
#   3. the public listener never serves owner content for SNI owner.<domain>
#      (a failed handshake or the catch-all's 421, never a 200 or a 401 of the
#      owner site), 8443 is closed on the public addresses, and no public
#      static file carries the owner canary;
#   4. caddy-owner: owner-check.mjs (401 without credentials, both headers on
#      every response, the owner canary with them), on its own network;
#   5. P12a, the WireGuard-only listener: 10.66.0.1:443 (the veth stand-in wg0
#      of wg-veth.sh) answers 401 and then 200 from the namespace `wgpeer` and
#      from the host, and is unreachable from the outside namespace `ext`;
#      a peer reaches nothing else (no public site, no container address, no
#      other port of the host); caddy-owner is off the public caddy's network
#      and has no way out.
# Environment: DOMAIN, IP4, IP6, OWNER_PW (the throw-away password); the namespaces
# "ext" and "wgpeer" and /ci/pki/pebble-root.pem are run.sh's.
set -euo pipefail

: "${DOMAIN:?}" "${IP4:?}" "${IP6:?}" "${OWNER_PW:?}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pass() { printf 'PASS %s\n' "$*"; }
fail() {
  echo "::error::isolation: $*"
  exit 1
}
mounts() { docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' "$1"; }
canary_re='777777\.(777|75)'

# ---- 1. mounts
pub=$(mounts rws-publish-1)
own=$(mounts rws-publish-owner-1)
caddy=$(mounts rws-caddy-1)
cowner=$(mounts rws-caddy-owner-1)
! grep -q '/srv/rws/owner' <<<"$pub" || fail "publish mounts owner paths: $pub"
# publish-owner's one public path is the river release directory, read-only (P11a, D-C: the owner reaches variant is split from it).
[[ $(grep '/srv/rws/public' <<<"$own") == '/srv/rws/public/data/v1/rivers -> /srv/rivers rw=false' ]] ||
  fail "publish-owner mounts public paths other than the river directory (read-only): $own"
grep -qx '/srv/rws/public/www -> /srv/www rw=true' <<<"$pub" || fail "publish: not exactly public/www read-write: $pub"
grep -qx '/srv/rws/public/ops -> /srv/ops rw=false' <<<"$pub" || fail "publish: ops not read-only: $pub"
grep -qx '/srv/rws/owner/www -> /srv/www rw=true' <<<"$own" || fail "publish-owner: not exactly owner/www read-write: $own"
grep -qx '/srv/rws/owner/status -> /srv/capture rw=false' <<<"$own" || fail "publish-owner: status not read-only: $own"
! grep -q 'owner' <<<"$caddy" || fail "the public caddy mounts something of the owner channel: $caddy"
grep -qx '/srv/rws/public/www/v1 -> /srv/rws/public/www/v1 rw=false' <<<"$caddy" || fail "the public caddy does not mount www/v1 read-only: $caddy"
! grep -qE 'www/(\.tmp|\.state)|/srv/rws/public/www( |$)' <<<"$caddy" || fail "the public caddy sees the publisher's .tmp or .state: $caddy"
docker exec rws-caddy-1 test ! -e /run/secrets/owner_basic_auth || fail "the public caddy holds the owner secret"
# caddy-owner's host mounts are exactly these three, all read-only (P10a, KG-213: the owner map's tiles and river
# files); nothing else of /srv/rws/public, and no other host path but its read-only basic_auth secret (Docker's own
# named volumes, its /config and /data, are not host paths of ours).
want=$(printf '%s\n' \
  '/srv/rws/owner/www/v1 -> /srv/rws/owner/www/v1 rw=false' \
  '/srv/rws/public/data/v1/rivers -> /srv/rws/public/data/v1/rivers rw=false' \
  '/srv/rws/tiles -> /srv/rws/tiles rw=false')
[[ $(grep '^/srv/' <<<"$cowner" | sort) == "$want" ]] || fail "caddy-owner: /srv mounts are not exactly owner v1, tiles and the rivers directory, read-only: $cowner"
# Beside them only its basic_auth secret (read-only) and Docker's own named volumes (/config, /data).
[[ $(grep '^/' <<<"$cowner" | grep -v '^/srv/' | grep -v '^/var/lib/docker/volumes/') == '/etc/rws/secrets/owner_basic_auth -> /run/secrets/owner_basic_auth rw=false' ]] ||
  fail "caddy-owner: a host path beside /srv, its secret and its volumes: $cowner"
# P12a: its one published port is 10.66.0.1:443 (container 8443), never a public or a wildcard address; it sits on
# rws_owner_public (its own non-internal bridge, rws-owner-pub) and rws_owner_edge, not on the public caddy's edge.
jq -e '. == {"8443/tcp": [{"HostIp": "10.66.0.1", "HostPort": "443"}]}' <<<"$(docker inspect -f '{{json .HostConfig.PortBindings}}' rws-caddy-owner-1)" >/dev/null ||
  fail "caddy-owner's port bindings are not exactly 10.66.0.1:443 -> 8443: $(docker inspect -f '{{json .HostConfig.PortBindings}}' rws-caddy-owner-1)"
[[ $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' rws-caddy-owner-1) == 'rws_owner_edge rws_owner_public ' ]] ||
  fail "caddy-owner networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' rws-caddy-owner-1)"
[[ $(docker network inspect -f '{{.Internal}} {{index .Options "com.docker.network.bridge.name"}}' rws_owner_public) == 'false rws-owner-pub' ]] ||
  fail "rws_owner_public is not a non-internal bridge named rws-owner-pub"
[[ $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' rws_owner_public) == 'rws-caddy-owner-1 ' ]] ||
  fail "rws_owner_public members: $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' rws_owner_public)"
! docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' rws_edge | grep -q caddy-owner || fail "caddy-owner is on the public caddy's network"
# On the host: 10.66.0.1:443 is bound (docker-proxy), and no owner port is bound on any other address.
listen=$(ss -Hltn)
grep -qE '10\.66\.0\.1:443( |$)' <<<"$listen" || fail "nothing listens on 10.66.0.1:443: $listen"
! grep -qE ':8443[[:space:]]' <<<"$listen" || fail "something listens on 8443 on the host: $listen"
pass "docker inspect: publish mounts public/www (rw) and public/ops (ro) and nothing of the owner channel; publish-owner owner/www (rw), owner/status (ro) and, of the public tree, only the river release directory at /srv/rivers (ro); the public caddy mounts only www/v1 (ro) of the new trees, no owner path and no owner secret; caddy-owner mounts only owner/www/v1, tiles and the rivers directory (all ro) and publishes only 10.66.0.1:443 (the WireGuard address) from its own network rws_owner_public, off the public edge"

# ---- 2. write attempts across the roots
probe='const fs = require("fs"); const r = [];
for (const p of process.argv.slice(1)) { try { fs.writeFileSync(p, "x"); r.push("wrote"); } catch (e) { r.push(e.code); } }
console.log(r.join(" "));'
got=$(docker exec rws-publish-1 /nodejs/bin/node -e "$probe" /srv/rws/owner/www/v1/isolation-probe /srv/rws/owner/isolation-probe /srv/ops/isolation-probe)
[[ $got == 'ENOENT ENOENT EROFS' ]] || fail "writes from publish: $got"
got=$(docker exec rws-publish-owner-1 /nodejs/bin/node -e "$probe" /srv/rws/public/www/v1/isolation-probe /srv/rws/public/isolation-probe /srv/capture/isolation-probe /srv/rivers/isolation-probe)
[[ $got == 'ENOENT ENOENT EROFS EROFS' ]] || fail "writes from publish-owner: $got"
# The redirection runs in a subshell: a failed redirection of the special built-in `:` would end sh itself.
got=$(docker exec rws-caddy-owner-1 sh -c 'for p in /srv/rws/owner/www/v1/isolation-probe /srv/rws/public/isolation-probe; do if (: >"$p") 2>/dev/null; then echo wrote; else echo refused; fi; done' | tr '\n' ' ')
[[ $got == 'refused refused ' ]] || fail "writes from caddy-owner: $got"
[[ -z $(find /srv/rws/owner /srv/rws/public -name isolation-probe) ]] || fail "a probe file reached the host"
pass "write attempts across the roots fail from inside the containers: publish gets ENOENT for the owner paths and EROFS on its ops mount, publish-owner ENOENT for the public paths and EROFS on its capture and river release mounts (P11a), caddy-owner cannot write at all; no probe file on the host"

# ---- 3. the public listener and the public files
outside() { ip netns exec ext curl -sS --max-time 10 --cacert /ci/pki/pebble-root.pem "$@"; }
# P12a (criterion 10): over IPv4 and IPv6, SNI and Host owner.<domain> on the public address is a failed handshake or
# the catch-all's 421, never a 200 or a 401 of the owner site (no WWW-Authenticate, no owner header, no owner content).
for target in "$IP4" "[$IP6]"; do
  for path in / /runtime-config.json /data/v1/meta.json /data/v1/latest.json; do
    rc=0
    code=$(outside -k -D /ci/iso.head -o /ci/iso.body -w '%{http_code}' --resolve "owner.$DOMAIN:443:$target" "https://owner.$DOMAIN$path") || rc=$?
    if ((rc == 0)); then
      [[ $code != 200 && $code != 401 ]] || fail "the public listener $target answered $code for owner.$DOMAIN$path"
      [[ ! -s /ci/iso.body || $code == 421 ]] || fail "the public listener $target answered $code with a body for owner.$DOMAIN$path"
      ! grep -qiE '^www-authenticate:' /ci/iso.head || fail "the public listener $target asked for credentials for owner.$DOMAIN$path"
      ! grep -qE "$canary_re|\"audience\":\"owner\"|private_basis" /ci/iso.body || fail "owner content from the public listener for owner.$DOMAIN$path"
    fi
    echo "public listener $target, SNI and Host owner.$DOMAIN$path: ${code:-handshake failed (curl $rc)}"
  done
  # 8443 is closed on the public address (nothing listens; the firewall has no rule for it).
  rc=0
  outside -k --connect-timeout 4 -o /dev/null --resolve "owner.$DOMAIN:8443:$target" "https://owner.$DOMAIN:8443/" || rc=$?
  ((rc != 0)) || fail "port 8443 answered on the public address $target"
  echo "public address $target port 8443: closed (curl $rc)"
done
for path in /runtime-config.json /data/v1/meta.json /data/v1/latest.json /data/v1/stations.json /data/v1/sources.json /data/v1/status.json /data/v1/forecast/latest.json; do
  rc=0
  outside -o /ci/iso.body --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN$path" || rc=$?
  ((rc == 0)) || continue # a file the publisher has not written yet is a 404 (curl 22 only with -f): body checked below
  ! grep -qE "$canary_re|123456\.789|123456\.79|private_basis" /ci/iso.body || fail "a canary or private_basis in the public $path"
done
# P10b: the document also holds the contact, the operator and the CDN, so the audience and the four keys are compared, not the
# whole body (and the message never prints it: the operator's name is personal data).
config=$(outside --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/runtime-config.json")
jq -e '.audience == "public" and (keys | sort) == ["audience", "cdn", "contact", "operator"]' <<<"$config" >/dev/null ||
  fail "public /runtime-config.json is not audience public with exactly the keys audience, contact, operator and cdn"
pass "the public listener (IPv4 and IPv6) serves no owner content for SNI and Host owner.$DOMAIN (a failed handshake or the catch-all's 421: never a 200 or 401, no credentials challenge), port 8443 is closed on both public addresses; the public /runtime-config.json has audience public and exactly the keys audience, contact, operator and cdn, and no public static file carries a canary or private_basis"

# ---- 4. caddy-owner
# caddy-owner's `tls internal` root (its own local CA, in its data volume): the check verifies the certificate
# against it instead of switching verification off.
docker exec rws-caddy-owner-1 cat /data/caddy/pki/authorities/local/root.crt >/ci/owner-root.crt
docker run --rm --network rws_owner_public -e RWS_DOMAIN="$DOMAIN" -e OWNER_PW -e OWNER_CA=/owner-root.crt \
  -v "$here/owner-check.mjs:/check.mjs:ro" -v /ci/owner-root.crt:/owner-root.crt:ro \
  --entrypoint /nodejs/bin/node rws-server:ci /check.mjs | tee /ci/owner-check.out ||
  fail "owner-check.mjs exited non-zero (its FAIL lines are above)"
[[ $(grep -c '^FAIL' /ci/owner-check.out || true) == 0 ]] || fail "owner-check.mjs"
pass "caddy-owner (SNI owner.$DOMAIN over rws_owner_public): $(grep -c '^PASS' /ci/owner-check.out) checks: 401 with both owner headers and no content without or with wrong credentials on every path, 200 with them, audience owner in the runtime config, and the owner canary in the owner latest.json"

# ---- 5. P12a: the WireGuard-only listener (the veth stand-in wg0, 10.66.0.1; peer namespace wgpeer)
export OWNER_PW
ca=/ci/owner-root.crt
wgpeer() { ip netns exec wgpeer curl -sS --max-time 10 --cacert "$ca" --resolve "owner.$DOMAIN:443:10.66.0.1" "$@"; }
host_owner() { curl -sS --max-time 10 --cacert "$ca" --resolve "owner.$DOMAIN:443:10.66.0.1" "$@"; }
# The password reaches curl through a config on stdin, never argv.
with_auth() { printf 'user = "owner:%s"\n' "$OWNER_PW" | "$@" -K -; }
# Both owner headers in a curl -D file (CRLF line ends).
owner_headers() {
  local h
  h=$(tr -d '\r' <"$1")
  grep -qix 'cache-control: private, no-store' <<<"$h" || return 1
  grep -qix 'x-robots-tag: noindex, nofollow' <<<"$h"
}
for who in wgpeer host_owner; do
  code=$("$who" -o /dev/null -D /ci/iso.head -w '%{http_code}' "https://owner.$DOMAIN/") || fail "$who: no answer from 10.66.0.1:443"
  [[ $code == 401 ]] || fail "$who: 10.66.0.1:443 answered $code without credentials, expected 401"
  owner_headers /ci/iso.head || fail "$who: the 401 lacks the owner headers"
  code=$(with_auth "$who" -o /ci/iso.body -D /ci/iso.head -w '%{http_code}' "https://owner.$DOMAIN/data/v1/latest.json") ||
    fail "$who: no answer with credentials"
  [[ $code == 200 ]] || fail "$who: 10.66.0.1:443 answered $code with credentials, expected 200"
  grep -qE "$canary_re" /ci/iso.body || fail "$who: the owner canary is not in the owner latest.json"
  owner_headers /ci/iso.head || fail "$who: the 200 lacks the owner headers"
done
pass "the owner site answers on 10.66.0.1:443 (wg0) from the peer namespace and from the host: 401 with both owner headers without credentials, 200 with the owner canary in latest.json with them (TLS verified against caddy-owner's CA)"

# From outside (the namespace ext, which reaches the host's addresses): the WireGuard address, its port and 8443 are
# dropped before Docker's DNAT (the prerouting chain of nftables.conf), not answered, not even refused.
for target in 10.66.0.1:443 10.66.0.1:8443 10.66.0.1:80; do
  rc=0
  ip netns exec ext curl -sk --connect-timeout 4 -o /dev/null "https://$target/" || rc=$?
  ((rc == 28)) || fail "ext -> $target: curl exit $rc, expected 28 (dropped, no answer)"
done
pass "from the outside namespace, 10.66.0.1:443, :8443 and :80 time out (dropped by the prerouting rule, no RST, no handshake)"

# A peer reaches the owner site and nothing else: not the public site, not a container address, not the host's ports.
rc=0
ip netns exec wgpeer curl -sk --connect-timeout 4 -o /dev/null --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/healthz" || rc=$?
((rc == 28)) || fail "wgpeer -> the public site at $IP4: curl exit $rc, expected 28 (dropped)"
cowner_ip=$(docker inspect -f '{{(index .NetworkSettings.Networks "rws_owner_public").IPAddress}}' rws-caddy-owner-1)
[[ $cowner_ip =~ ^[0-9.]+$ ]] || fail "no rws_owner_public address for caddy-owner: $cowner_ip"
for target in "$cowner_ip:8443" 10.66.0.1:8443 10.66.0.1:80 10.66.0.1:22; do
  rc=0
  ip netns exec wgpeer curl -sk --connect-timeout 4 -o /dev/null "https://$target/" || rc=$?
  ((rc == 28 || rc == 7)) || fail "wgpeer -> $target: curl exit $rc, expected 28 or 7 (nothing answers)"
done
pass "from the peer namespace, only 10.66.0.1:443 answers: the public site at $IP4, caddy-owner's container address $cowner_ip:8443 and 10.66.0.1 ports 8443, 80 and 22 do not"

# caddy-owner is unreachable from the public caddy's network, and has no way out (from_containers drops it).
if docker exec rws-caddy-1 wget -q -T 3 -O /dev/null --no-check-certificate "https://$cowner_ip:8443/" 2>/dev/null; then
  fail "the public caddy reached caddy-owner at $cowner_ip:8443"
fi
if docker exec rws-caddy-owner-1 wget -q -T 6 -O /dev/null https://www.example.com 2>/dev/null; then
  fail "caddy-owner reached the internet (TCP 443)"
fi
if docker exec rws-caddy-owner-1 wget -q -T 6 -O /dev/null http://www.example.com 2>/dev/null; then
  fail "caddy-owner reached the internet (TCP 80)"
fi
pass "the public caddy cannot reach caddy-owner (different bridge), and caddy-owner reaches no outside address on 443 or 80 (rws-owner-pub is neither rws-public nor rws-egress in from_containers)"
