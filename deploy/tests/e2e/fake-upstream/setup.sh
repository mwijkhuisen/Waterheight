#!/usr/bin/env bash
# CI only (P12a, issue #27; called by deploy/tests/e2e/run.sh in the loadtest, drill and chaos modes, as root, once
# its throw-away CA /ci/pki/ca.{pem,key} exists): lays out what compose.fake.yaml mounts.
#
#   setup.sh <out dir> <repo> <node image>        (run.sh passes /ci/fake)
#
#   <out>/www              server.mjs, routes.json, bodies/ (prepare.ts, run in the node image with no network and
#                          the repository read-only, as run.sh runs scripts/fixture-archive.ts), server.crt and
#                          server.key: a leaf of the CI CA with one SAN per faked host and hc-ping.com
#   <out>/state            owner 65532, 0755: the fake appends hits.jsonl here
#   <out>/control          root, 0755, empty: a test writes `blackhole` (one hostname per line) here
#   <out>/ca-bundle.pem    a copy of /ci/pki/ca.pem (run.sh later adds Pebble's root); ca.key is never copied
# Environment for a run outside CI (all optional): RWS_CI_PKI (the CA's directory, default /ci/pki), FAKE_UID (the
# owner of the state directory and the key, default 65532).
set -euo pipefail

(($# == 3)) || {
  echo "usage: setup.sh <out dir> <repo> <node image>" >&2
  exit 64
}
out=$1 repo=$2 image=$3
pki=${RWS_CI_PKI:-/ci/pki}
uid=${FAKE_UID:-65532}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
www=$out/www

install -d -m 0755 "$out" "$www" "$out/state" "$out/control"
chown "$uid:$uid" "$out/state"

# routes.json and bodies/ from the recorded payloads. root in the container, so the files come out root-owned.
docker run --rm --network none -v "$repo:$repo:ro" -v "$www:/out" -w "$repo" --entrypoint node "$image" \
  deploy/tests/e2e/fake-upstream/prepare.ts /out
install -m 0644 "$here/server.mjs" "$www/server.mjs"
find "$www/bodies" -type f -exec chmod 0644 {} +
chmod 0755 "$www/bodies"
chmod 0644 "$www/routes.json"

# The leaf: every faked host plus hc-ping.com (the fake healthchecks).
hosts=$(jq -r '[.[].host] | unique | join(",")' "$www/routes.json")
[[ -n $hosts ]] || {
  echo "setup.sh: routes.json names no host" >&2
  exit 1
}
san=DNS:hc-ping.com,DNS:${hosts//,/,DNS:}
openssl req -newkey rsa:2048 -nodes -subj /CN=rws-fake-upstream -keyout "$www/server.key" -out "$out/server.csr" 2>/dev/null
openssl x509 -req -in "$out/server.csr" -CA "$pki/ca.pem" -CAkey "$pki/ca.key" -CAcreateserial -days 2 \
  -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san") -out "$www/server.crt" 2>/dev/null
rm -f "$out/server.csr"
chown "$uid:$uid" "$www/server.key"
chmod 0400 "$www/server.key"
chmod 0644 "$www/server.crt"

install -m 0644 "$pki/ca.pem" "$out/ca-bundle.pem"
echo "fake upstream ready in $out: $san"
