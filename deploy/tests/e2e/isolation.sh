#!/usr/bin/env bash
# CI only (called by deploy/tests/e2e/run.sh once the stack runs with the owner
# overlay; plan P9a §4.9): the owner channel is isolated from the public one by
# construction. Prints one PASS line per proof, exits 1 on the first failure.
#   1. docker inspect: publish mounts nothing of /srv/rws/owner, publish-owner
#      nothing of /srv/rws/public, the public caddy no owner path and no secret,
#      caddy-owner only the owner v1, the tiles and the rivers directory (read-only), no published port;
#   2. write attempts across the roots fail from inside the containers;
#   3. the public listener never serves owner content for SNI owner.<domain>,
#      and no public static file carries the owner canary;
#   4. caddy-owner: owner-check.mjs (401 without credentials, both headers on
#      every response, the owner canary with them).
# Environment: DOMAIN, IP4, OWNER_PW (the throw-away password); the namespace
# "ext" and /ci/pki/pebble-root.pem are run.sh's.
set -euo pipefail

: "${DOMAIN:?}" "${IP4:?}" "${OWNER_PW:?}"
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
! grep -q '/srv/rws/public' <<<"$own" || fail "publish-owner mounts public paths: $own"
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
[[ $(docker inspect -f '{{json .HostConfig.PortBindings}}' rws-caddy-owner-1) == '{}' || $(docker inspect -f '{{json .HostConfig.PortBindings}}' rws-caddy-owner-1) == null ]] ||
  fail "caddy-owner publishes a port"
pass "docker inspect: publish mounts public/www (rw) and public/ops (ro) and nothing of the owner channel; publish-owner owner/www (rw) and owner/status (ro) and nothing public; the public caddy mounts only www/v1 (ro) of the new trees, no owner path and no owner secret; caddy-owner mounts only owner/www/v1, tiles and the rivers directory (all ro) and publishes no port"

# ---- 2. write attempts across the roots
probe='const fs = require("fs"); const r = [];
for (const p of process.argv.slice(1)) { try { fs.writeFileSync(p, "x"); r.push("wrote"); } catch (e) { r.push(e.code); } }
console.log(r.join(" "));'
got=$(docker exec rws-publish-1 /nodejs/bin/node -e "$probe" /srv/rws/owner/www/v1/isolation-probe /srv/rws/owner/isolation-probe /srv/ops/isolation-probe)
[[ $got == 'ENOENT ENOENT EROFS' ]] || fail "writes from publish: $got"
got=$(docker exec rws-publish-owner-1 /nodejs/bin/node -e "$probe" /srv/rws/public/www/v1/isolation-probe /srv/rws/public/isolation-probe /srv/capture/isolation-probe)
[[ $got == 'ENOENT ENOENT EROFS' ]] || fail "writes from publish-owner: $got"
# The redirection runs in a subshell: a failed redirection of the special built-in `:` would end sh itself.
got=$(docker exec rws-caddy-owner-1 sh -c 'for p in /srv/rws/owner/www/v1/isolation-probe /srv/rws/public/isolation-probe; do if (: >"$p") 2>/dev/null; then echo wrote; else echo refused; fi; done' | tr '\n' ' ')
[[ $got == 'refused refused ' ]] || fail "writes from caddy-owner: $got"
[[ -z $(find /srv/rws/owner /srv/rws/public -name isolation-probe) ]] || fail "a probe file reached the host"
pass "write attempts across the roots fail from inside the containers: publish gets ENOENT for the owner paths and EROFS on its ops mount, publish-owner ENOENT for the public paths and EROFS on its capture mount, caddy-owner cannot write at all; no probe file on the host"

# ---- 3. the public listener and the public files
outside() { ip netns exec ext curl -sS --max-time 10 --cacert /ci/pki/pebble-root.pem "$@"; }
for path in / /runtime-config.json /data/v1/meta.json /data/v1/latest.json; do
  rc=0
  code=$(outside -k -o /ci/iso.body -w '%{http_code}' --resolve "owner.$DOMAIN:443:$IP4" "https://owner.$DOMAIN$path") || rc=$?
  if ((rc == 0)); then
    # Anything but a refusal must be empty or a plain error, never owner content.
    [[ $code != 200 || ! -s /ci/iso.body ]] || fail "the public listener answered 200 with a body for owner.$DOMAIN$path"
    ! grep -qE "$canary_re|\"audience\":\"owner\"|private_basis" /ci/iso.body || fail "owner content from the public listener for owner.$DOMAIN$path"
  fi
  echo "public listener, SNI and Host owner.$DOMAIN$path: ${code:-handshake failed (curl $rc)}"
done
for path in /runtime-config.json /data/v1/meta.json /data/v1/latest.json /data/v1/stations.json /data/v1/sources.json /data/v1/status.json /data/v1/forecast/latest.json; do
  rc=0
  outside -o /ci/iso.body --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN$path" || rc=$?
  ((rc == 0)) || continue # a file the publisher has not written yet is a 404 (curl 22 only with -f): body checked below
  ! grep -qE "$canary_re|123456\.789|123456\.79|private_basis" /ci/iso.body || fail "a canary or private_basis in the public $path"
done
audience=$(outside --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/runtime-config.json")
[[ $audience == '{"audience":"public"}' ]] || fail "public /runtime-config.json: $audience"
pass "the public listener never serves owner content for SNI and Host owner.$DOMAIN (refused, or no body); the public /runtime-config.json is {\"audience\":\"public\"} and no public static file carries a canary or private_basis"

# ---- 4. caddy-owner
# caddy-owner's `tls internal` root (its own local CA, in its data volume): the check verifies the certificate
# against it instead of switching verification off.
docker exec rws-caddy-owner-1 cat /data/caddy/pki/authorities/local/root.crt >/ci/owner-root.crt
docker run --rm --network rws_edge -e RWS_DOMAIN="$DOMAIN" -e OWNER_PW -e OWNER_CA=/owner-root.crt \
  -v "$here/owner-check.mjs:/check.mjs:ro" -v /ci/owner-root.crt:/owner-root.crt:ro \
  --entrypoint /nodejs/bin/node rws-server:ci /check.mjs | tee /ci/owner-check.out ||
  fail "owner-check.mjs exited non-zero (its FAIL lines are above)"
[[ $(grep -c '^FAIL' /ci/owner-check.out || true) == 0 ]] || fail "owner-check.mjs"
pass "caddy-owner (SNI owner.$DOMAIN over rws_edge): $(grep -c '^PASS' /ci/owner-check.out) checks: 401 with both owner headers and no content without or with wrong credentials on every path, 200 with them, {\"audience\":\"owner\"}, and the owner canary in the owner latest.json"
