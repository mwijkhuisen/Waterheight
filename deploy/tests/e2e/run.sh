#!/usr/bin/env bash
# End-to-end proof of the P1b platform on a GitHub ubuntu-24.04 runner (issue
# #16: the [U] items of the P1b PR). As root it installs Docker 29.8.1 and
# Compose 5.5.1 from Docker's repository, builds the three images, loads the
# real deploy/host/nftables.conf, starts the real deploy/compose.yaml with the
# CI overlay (Pebble for ACME, MinIO with Object Lock, capture cut off from the
# internet) and proves, printing one PROOF line each:
#   - Docker-published ports cannot bypass the firewall (an "outside" network
#     namespace reaches 80/443 but not another published port), container
#     egress is TCP 443 plus DNS to the host's resolvers only, and rws-tick
#     restores a deleted firewall table;
#   - Caddy runs as uid 65533 with no capability, binds 80/443 and gets an
#     ACME certificate through HTTP-01 on the published port;
#   - file secrets keep their host owner, so only the service with the gid
#     can read them; a file replaced by a rename reaches a running container
#     only after a restart, an in-place write at once;
#   - capture in distroless is healthy, writes the contract files with the
#     contract modes, and generated_at advances; the real rws-status-copy.path
#     unit publishes a checked copy that Caddy serves, a symlink planted as
#     capture's file and a file naming an owner source are refused and never
#     served, a burst of writes does not disarm the path unit and rws-tick
#     re-arms it; the rws-deploy smoke test passes;
#   - restic reads its keys from AWS_SHARED_CREDENTIALS_FILE and writes to an
#     Object Lock bucket; the restore drill matches 100 of 100; the VPS key
#     cannot remove a version (object-lock-prune.sh);
#   - the watchdog's probe through DNS and TLS passes;
#   - (P2a) the database path of rws-lib.sh (db_up: db healthy, roles and
#     passwords over its socket, migrate) runs twice without a change; db
#     publishes no port and sits only on the internal db and owner_db networks; pg_hba lets
#     rws_api in with its password and refuses a wrong one and the superuser
#     over TCP; rws_api can neither read a base table nor insert; load turns
#     the DE-1 fixture archive into observations; /api/v1/health and
#     /health/sources answer through Caddy over TLS, and (P4b) so do /api/v1/meta
#     and /stations; an unknown path under /api/v1/ is the api's JSON 404, a
#     wrong-case path Caddy's 404, an unknown parameter a 400, a POST a 405 and
#     a GET with a 2048-byte body a 413; a POST to a page, an unknown path or an
#     asset a 405 with the site headers and no Server; (P10b) /over and /en/about
#     are the pages of their language (200), a path that is no page the 404 shell of
#     its language (404, never a 200), both with no-cache, a missing asset or
#     /favicon.ico a bare 404; load and api have no route out; db,
#     load and api keep the hardening flags; each sees only its own secret;
#     the nightly dump is a valid custom-format dump readable only by root and
#     gid 61003, and restic backs it up;
#   - (P3) the basemap jobs: the networked basemap job sees the served directory
#     read-only and writes only .staging; basemap-promote has no network and moves
#     the recorded PMTiles fixtures from .staging into /srv/rws/tiles with a
#     manifest.json (no symlink to follow, T-WEB-1); Caddy serves them over TLS
#     with Range, immutable caching and no content encoding, and every other
#     request for a tile file is a 416; a leftover basemap container stops
#     rws-basemap-refresh;
#   - (P9a) the static publishers and the owner site: publish and publish-owner
#     healthy and each mounting only its own audience (docker inspect, write
#     attempts across the roots fail), the public listener never serving owner
#     content for SNI owner.<domain>, caddy-owner (deploy/compose.owner.yaml,
#     which this script adds with -f; production uses it only from P12a) refusing
#     every request without credentials, with both owner headers, and serving the
#     owner canary with them; and the degraded stand-in: with the api stopped the
#     map still loads for a future t and shows its banner;
#   - (P9b) the owner API: api-owner (the overlay) joins only owner_edge and owner_db, with
#     caddy-owner the only other member of owner_edge; static files are never rate
#     limited while the API is (429 with Retry-After); Caddy hands the API the real
#     peer address (the masked access log never shows a Docker bridge gateway for
#     the runner); and api-sweep.mjs, the owner canary sweep: every public route,
#     50 random snapshots, health, openapi, beacons and the static files, each in
#     identity, gzip and zstd, free of the canary's value, station, source, text and
#     clause (the owner side shows them), then the api, publish and caddy logs and
#     the public access log grepped for the same terms.
# The stack keeps running afterwards for scripts/verify-prod.ts.
# RWS_E2E_MODE=loadtest|drill|chaos (P9b, P12a; .github/workflows/loadtest.yml; sudo must preserve it): the same
# stack with the overlays deploy/tests/loadtest/compose.loadtest.yaml and deploy/tests/e2e/compose.fake.yaml added
# (the fake upstream on 203.0.115.0/24 that capture fetches from and the watchdog pings, with a throw-away ping key),
# drill also deploy/tests/flood/compose.drill.yaml (the drill registry), up to both publishers' first meta.json; no
# proof section runs. It writes /ci/e2e-stack (the marker scripts/flood-drill.ts insists on) and /ci/loadtest.env,
# prints "loadtest stack ready" and exits 0 with the stack running (nothing is torn down); the workflow job drives
# its mode from there.
# Usage: sudo deploy/tests/e2e/run.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
e2e=$repo/deploy/tests/e2e
# shellcheck source=deploy/bin/rws-lib.sh
. "$repo/deploy/bin/rws-lib.sh"
umask 022

readonly DOMAIN=rivierstanden.example IP4=203.0.114.10 IP6=2a0a:e5c0:ffff::10
# Extra client addresses in the outside namespace "ext" (P9b): distinct sources for the rate limit proof and the load test.
# Not private, so the API keys them as themselves (a private peer is the gateway key, a 100x bucket).
readonly CLIENT_IPS=(203.0.114.11 203.0.114.12 203.0.114.13 203.0.114.14 203.0.114.15 203.0.114.16)
readonly LOADTEST_OVERLAY=$repo/deploy/tests/loadtest/compose.loadtest.yaml
# P12a: the fake upstream (capture's providers and hc-ping.com) and the flood drill's registry; CI only.
readonly FAKE_OVERLAY=$e2e/compose.fake.yaml DRILL_OVERLAY=$repo/deploy/tests/flood/compose.drill.yaml
readonly FAKE_IP=203.0.115.10
readonly DOCKER_APT=5:29.8.1-1~ubuntu.24.04~noble CONTAINERD_APT=2.3.5-1~ubuntu.24.04~noble
readonly COMPOSE_APT=5.5.1-1~ubuntu.24.04~noble
# P9b, P12a: unset or empty is the normal run; loadtest, drill and chaos the stack of loadtest.yml's jobs (see the
# header); anything else is refused.
mode=${RWS_E2E_MODE:-}
[[ -z $mode || $mode == loadtest || $mode == drill || $mode == chaos ]] || {
  echo "::error::e2e: RWS_E2E_MODE must be empty, loadtest, drill or chaos"
  exit 1
}
# The Playwright image of the e2e job (ci.yml hands it in; test/e2e-pins.test.ts keeps both jobs on one value).
[[ -n $mode ]] || : "${PLAYWRIGHT_IMAGE:?set PLAYWRIGHT_IMAGE (ci.yml deploy job)}"
readonly MC_IMAGE=cgr.dev/chainguard/minio-client@sha256:be51ef820151a708a8e140037e3746862a8c1dd5e624f84b404a1d71bcefb167
# The build image's Node (the job's own node is not on sudo's PATH): runs scripts/fixture-archive.ts.
readonly NODE_IMAGE=node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
readonly REL=$RWS_STATE_DIR/releases/prod-ci

proofs=()
proof() {
  proofs+=("$*")
  echo "PROOF: $*"
}
group=0
step() {
  ((group == 0)) || echo "::endgroup::"
  group=1
  echo "::group::$*"
}
fail() {
  echo "::error::e2e: $*"
  exit 1
}
# wait_for <what> <seconds> <command...>
wait_for() {
  local what=$1 end=$((SECONDS + $2))
  shift 2
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < end)) || fail "timed out waiting for $what"
    sleep 3
  done
}
on_exit() {
  local rc=$?
  ((group == 0)) || echo "::endgroup::"
  if ((rc != 0)); then
    echo "::group::diagnostics"
    docker compose -p rws ps -a 2>/dev/null || true
    for s in caddy capture watchdog db load api api-owner publish publish-owner caddy-owner pebble minio fake-upstream; do docker logs --tail 60 "rws-$s-1" 2>&1 | sed "s/^/$s| /" || true; done
    find /srv/rws/tiles -maxdepth 2 -printf '%M %u:%g %s %p\n' 2>&1 | head -n 20 || true
    systemctl status --no-pager rws-status-copy.path rws-status-copy.service 2>&1 | tail -n 20 || true
    nft list ruleset 2>/dev/null | head -n 200 || true
    echo "::endgroup::"
  fi
  printf '\n%s\n' "== e2e evidence (${#proofs[@]} proofs, exit $rc) =="
  printf -- '- %s\n' "${proofs[@]}"
}
trap on_exit EXIT
((EUID == 0)) || fail "run as root"
[[ -z $mode ]] || [[ -f $LOADTEST_OVERLAY && -f $FAKE_OVERLAY ]] || fail "mode $mode needs $LOADTEST_OVERLAY and $FAKE_OVERLAY"
[[ $mode != drill ]] || [[ -f $DRILL_OVERLAY ]] || fail "drill mode needs $DRILL_OVERLAY"

# ------------------------------------------------------------------ Docker
step "Docker Engine 29.8.1 and Compose 5.5.1 from Docker's apt repository"
install -d -m 0755 /etc/apt/keyrings /etc/docker
curl --proto '=https' -fsSL -o /etc/apt/keyrings/docker.asc https://download.docker.com/linux/ubuntu/gpg
fpr=$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '/^fpr/ { print $10; exit }')
[[ $fpr == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || fail "Docker apt key fingerprint $fpr"
rm -f /etc/apt/sources.list.d/docker*.list /etc/apt/sources.list.d/docker*.sources
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  >/etc/apt/sources.list.d/docker.sources
# The runner's own Docker leaves its daemon.json and netfilter rules behind (a VPS starts
# clean): show them, then start from an empty ruleset, as a fresh Debian host does.
echo "runner daemon.json: $(cat /etc/docker/daemon.json 2>/dev/null || echo none)"
echo "iptables: $(readlink -f "$(command -v iptables)"); legacy FORWARD: $(iptables-legacy -S FORWARD 2>/dev/null | head -n 3 | tr '\n' ' ')"
systemctl stop docker.service docker.socket 2>/dev/null || true
for t in filter nat mangle raw; do
  iptables-legacy -t "$t" -F 2>/dev/null || true
  iptables-legacy -t "$t" -X 2>/dev/null || true
  ip6tables-legacy -t "$t" -F 2>/dev/null || true
  ip6tables-legacy -t "$t" -X 2>/dev/null || true
done
iptables-legacy -P FORWARD ACCEPT 2>/dev/null || true
nft flush ruleset 2>/dev/null || true
ip link delete docker0 2>/dev/null || true
install -m 0644 "$repo/deploy/host/daemon.json" /etc/docker/daemon.json
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --allow-downgrades --allow-change-held-packages \
  "docker-ce=$DOCKER_APT" "docker-ce-cli=$DOCKER_APT" "containerd.io=$CONTAINERD_APT" \
  "docker-compose-plugin=$COMPOSE_APT" docker-buildx-plugin nftables zstd >/dev/null
systemctl restart docker
nft list tables | tr '\n' ' '
echo
[[ $(docker version --format '{{.Server.Version}}') == 29.8.1 ]] || fail "Docker $(docker version --format '{{.Server.Version}}')"
[[ $(docker compose version --short) == 5.5.1 ]] || fail "Compose $(docker compose version --short)"
proof "Docker $(docker version --format '{{.Server.Version}}') and Compose $(docker compose version --short) from Docker's repository (key fingerprint 9DC8…CD88); deploy/host/daemon.json accepted: $(docker info --format 'live-restore={{.LiveRestoreEnabled}} logging={{.LoggingDriver}} firewall={{.FirewallBackend.Driver}}')"

# ------------------------------------------------------------------ images
step "Build the server, web and backup images"
# A container on the default bridge must reach the internet under deploy/host/daemon.json.
docker run --rm --entrypoint /bin/sh caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b \
  -c 'cat /etc/resolv.conf; wget -q -T 20 -O /dev/null https://deb.debian.org/ && echo "container egress ok"' ||
  echo "::warning::a container on the default bridge cannot reach deb.debian.org"
for image in server web backup; do
  if ! docker build --progress=plain -f "$repo/deploy/$image/Dockerfile" -t "rws-$image:ci" "$repo" >"/tmp/build-$image.log" 2>&1; then
    tail -n 60 "/tmp/build-$image.log"
    fail "docker build of $image"
  fi
  echo "rws-$image:ci $(docker image inspect -f '{{.Id}} {{.Size}}' "rws-$image:ci")"
done
docker run --rm -e RWS_DOMAIN=$DOMAIN -e RWS_CONTACT_EMAIL=contact@$DOMAIN rws-web:ci \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
proof "caddy validate: deploy/web/Caddyfile + site.caddy valid inside the web image"
docker run --rm --entrypoint /nodejs/bin/node rws-server:ci /app/apps/server/dist/main.js capture --dry-run | tail -n 1
proof "server image: capture --dry-run loads every spec from /app/registry next to /app/apps/server/dist (the P1a layout)"

# ------------------------------------------------------------------ PKI
step "A throwaway CA for Pebble's and MinIO's TLS"
install -d -m 0755 /ci /ci/pki /ci/pki/minio
cp "$e2e/Caddyfile.ci" "$e2e/pebble.json" "$e2e/basemap.yaml" /ci/
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=rws-ci-ca -keyout /ci/pki/ca.key -out /ci/pki/ca.pem \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign 2>/dev/null
for name in pebble minio; do
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$name" -keyout "/ci/pki/$name.key" -out "/ci/pki/$name.csr" 2>/dev/null
  openssl x509 -req -in "/ci/pki/$name.csr" -CA /ci/pki/ca.pem -CAkey /ci/pki/ca.key -CAcreateserial -days 2 \
    -extfile <(printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$name") -out "/ci/pki/$name.crt" 2>/dev/null
done
cp /ci/pki/minio.crt /ci/pki/minio/public.crt
cp /ci/pki/minio.key /ci/pki/minio/private.key
# P12a: the fake upstream's routes, bodies and certificate (one SAN per faked host, signed by this CA) in /ci/fake;
# /ci/fake/ca-bundle.pem is what capture and the watchdog trust on top of the system roots (NODE_EXTRA_CA_CERTS).
# Only public certificates and the fake's own throw-away key are there, never ca.key.
if [[ -n $mode ]]; then
  "$e2e/fake-upstream/setup.sh" /ci/fake "$repo" "$NODE_IMAGE" || fail "fake-upstream/setup.sh"
fi
# The drill's registry (scripts/flood-drill.ts's test-only station) in /ci/flood, before migrate syncs it.
if [[ $mode == drill ]]; then
  "$repo/deploy/tests/flood/setup.sh" /ci/flood "$repo" || fail "flood/setup.sh"
fi
chmod -R a+rX /ci
chmod 0644 /ci/pki/*.key /ci/pki/minio/private.key

# ------------------------------------------------------------------ host layout
step "Host layout, groups and secrets as bootstrap.sh makes them"
for g in rws-hc:61001 rws-rwskey:61002 rws-backup:61003 rws-dbpostgres:61004 rws-dbmigrator:61005 rws-dbload:61006 \
  rws-dbpublish:61007 rws-dbapi:61008 rws-dbownerapi:61009 rws-ownerauth:61010; do
  getent group "${g%%:*}" >/dev/null || groupadd --system --gid "${g#*:}" "${g%%:*}"
done
# The runner's own disk is often over 75% full: a tmpfs keeps the watchdog's disk check about our layout.
install -d -m 0755 /srv/rws
mountpoint -q /srv/rws || mount -t tmpfs -o size=2g,mode=0755 tmpfs /srv/rws
install -d -m 0755 /srv/rws/public /srv/rws/public/ops /etc/rws
# P12a: the brownout flag directory, root's (deploy/bin/rws-brownout); caddy, api and publish mount it read-only.
install -d -m 0755 -o 0 -g 0 /srv/rws/brownout
install -d -m 0700 /etc/rws/secrets "$RWS_STATE_DIR" "$RWS_STATE_DIR/releases"
install -d -m 0750 -o 65532 -g 65532 /srv/rws/raw /srv/rws/owner /srv/rws/owner/status
install -d -m 0755 -o 65532 -g 65532 /srv/rws/public/status
# The static publishers' trees (P9a), as bootstrap.sh makes them: Docker would create a missing bind source as
# root, and the publishers (uid 65532) could not write it. v1 is the served part; .tmp and .state are not.
for aud in public owner; do
  install -d -m 0755 -o 65532 -g 65532 "/srv/rws/$aud/www" "/srv/rws/$aud/www/v1"
  install -d -m 0700 -o 65532 -g 65532 "/srv/rws/$aud/www/.tmp" "/srv/rws/$aud/www/.state"
done
# The basemap (P3): the promote job's directory, Caddy serves it read-only; .staging is the fetch job's.
install -d -m 0755 -o 65532 -g 65532 /srv/rws/tiles
install -d -m 0700 -o 65532 -g 65532 /srv/rws/tiles/.staging
# The river files (P6b): root's, written only by rws-rivers-refresh; Caddy mounts exactly these two read-only.
install -d -m 0755 -o 0 -g 0 /srv/rws/public/data /srv/rws/public/data/v1 /srv/rws/public/data/v1/rivers /srv/rws/public/downloads
# P11a (issue #26): one river release installed as rws-rivers-refresh leaves it (root's, 0644, immutable names, then the
# manifest), from the committed fixtures: the reaches file of the fixture graph and its tiles (tools/geo/fixtures,
# test/reaches-fixture.test.ts), so the web has a graph to draw the upstream chain from and publish-owner a release
# to split. The download file is a valid gzip of an empty collection (the manifest names one; nothing here reads it).
rivers_ver=20261003
rivers_dir=/srv/rws/public/data/v1/rivers
install -m 0644 -o 0 -g 0 "$repo/test/fixtures/reaches-fixture.json" "$rivers_dir/reaches-$rivers_ver.json"
install -m 0644 -o 0 -g 0 "$repo/tools/geo/fixtures/rivers-fixture.pmtiles" "$rivers_dir/rivers-$rivers_ver.pmtiles"
printf '{"type":"FeatureCollection","features":[]}\n' | gzip -n >"/srv/rws/public/downloads/rivers-$rivers_ver.geojson.gz"
chmod 0644 "/srv/rws/public/downloads/rivers-$rivers_ver.geojson.gz"
jq -e --arg v "$rivers_ver" '.schema_version == 1 and .version == $v' "$rivers_dir/reaches-$rivers_ver.json" >/dev/null ||
  fail "test/fixtures/reaches-fixture.json is not version $rivers_ver"
rivers_entry() { # <file>: the manifest entry of an installed file
  jq -n --arg f "${1##*/}" --arg s "$(sha256sum "$1" | cut -d' ' -f1)" --argjson b "$(stat -c %s "$1")" \
    '{file: $f, sha256: $s, bytes: $b}'
}
jq -n --arg v "$rivers_ver" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson tiles "$(rivers_entry "$rivers_dir/rivers-$rivers_ver.pmtiles")" \
  --argjson reaches "$(rivers_entry "$rivers_dir/reaches-$rivers_ver.json")" \
  --argjson dl "$(rivers_entry "/srv/rws/public/downloads/rivers-$rivers_ver.geojson.gz")" \
  '{schema_version: 1, current: {version: $v, tag: "geo-2026-10-03", installed_at: $now, tiles: $tiles, reaches: $reaches, download: $dl}, previous: null}' \
  >"$rivers_dir/manifest.json"
chmod 0644 "$rivers_dir/manifest.json"
# The parent is root's: its subdirectories are bind-mounted one by one, and a uid-65532 owner could swap db/ for a link.
install -d -m 0700 -o 0 -g 0 /srv/rws/backup
install -d -m 0700 -o 65532 -g 65532 /srv/rws/backup/cache /srv/rws/backup/drill
install -d -m 0750 -o 0 -g 61003 /srv/rws/backup/db
install -d -m 0755 /etc/rws/postgres
install -m 0644 "$repo/deploy/postgres/pg_hba.conf" "$repo/deploy/postgres/pg_ident.conf" /etc/rws/postgres/
put_secret() {
  install -m 0440 -o 0 -g "$2" /dev/null "/etc/rws/secrets/$1"
  printf '%b' "$3" >"/etc/rws/secrets/$1"
}
vps_secret=$(openssl rand -hex 20)
# Empty: no ping leaves the runner. P12a's modes ping the fake healthchecks with a throw-away key (16+ characters).
if [[ -n $mode ]]; then put_secret hc_ping_key 61001 "ci$(openssl rand -hex 12)\n"; else put_secret hc_ping_key 61001 ''; fi
put_secret rws_x_api_key 61002 "$(cat /proc/sys/kernel/random/uuid)\n"
put_secret restic_password 61003 "ci-$(openssl rand -hex 16)\n"
put_secret s3_credentials 61003 "[default]\naws_access_key_id = rws-vps\naws_secret_access_key = $vps_secret\n"
# The database passwords: 64 hex characters, as bootstrap.sh generates them.
gid=61004
for name in db_postgres db_rws_migrator db_rws_load db_rws_publish db_rws_api db_rws_owner_api; do
  put_secret "$name" "$gid" "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')\n"
  gid=$((gid + 1))
done
# The owner site's credentials (P9a): a throw-away password for this run only, the bcrypt line `owner <hash>`
# that caddy-owner imports (made by Caddy itself, in the web image); the plaintext goes to isolation.sh through
# the environment and is never written to a file. Not generated by bootstrap.sh (owner action, P12a).
OWNER_PW=$(openssl rand -hex 16)
export OWNER_PW
# On stdin, never on a command line (review SEC-5): caddy reads one line when stdin is not a terminal.
owner_hash=$(printf '%s\n' "$OWNER_PW" | docker run -i --rm --entrypoint caddy rws-web:ci hash-password)
# shellcheck disable=SC2016 # the literal bcrypt prefix, not a variable
[[ $owner_hash == '$2a$'* ]] || fail "caddy hash-password did not return a bcrypt hash"
put_secret owner_basic_auth 61010 "owner $owner_hash\n"
docker run --rm --group-add 61010 -e RWS_DOMAIN=$DOMAIN -v /etc/rws/secrets/owner_basic_auth:/run/secrets/owner_basic_auth:ro rws-web:ci \
  caddy validate --config /etc/caddy/Caddyfile.owner --adapter caddyfile >/dev/null
proof "caddy validate: deploy/web/Caddyfile.owner + owner.caddy valid inside the web image with the throw-away owner_basic_auth secret (root:61010 0440)"
cat >/etc/rws/rws.env <<EOF
RWS_DOMAIN=$DOMAIN
RWS_CONTACT_EMAIL=contact@$DOMAIN
RWS_OPERATOR_NAME=E2E Operator
RWS_CDN_NAME=
RWS_PUBLIC_IPV4=$IP4
RWS_PUBLIC_IPV6=$IP6
RWS_RESTIC_REPOSITORY=s3:https://minio/rws-raw/restic
RWS_S3_REGION=us-east-1
RWS_BACKUP=on
RWS_OWNER_SITE=on
EOF
grep -q ' minio$' /etc/hosts || echo '172.30.99.10 minio' >>/etc/hosts
load_env
ops_update '.'
# The status copy as bootstrap.sh installs it: the real path unit publishes each capture.json.
ln -sfn "$repo/deploy/bin/rws-status-copy" /usr/local/bin/rws-status-copy
install -m 0644 "$repo/deploy/systemd/rws-status-copy.path" "$repo/deploy/systemd/rws-status-copy.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now --quiet rws-status-copy.path
# A synthetic raw archive (generated bytes) for the restore drill: 120 objects and their manifest lines.
# They are dated 15 min before now, in the newest manifest day (the one capture
# appends to), because the drill reads only the newest day and 2 random older
# ones: on an older day of their own they were skipped once the fixture archive
# had 2 days (too_few_objects in 1 run of 3). 15 min also puts them before the
# drill's cutoff (snapshot - 10 min).
manifest_dir=/srv/rws/raw/_manifest
mkdir -p "$manifest_dir"
drill_at=$(date -u -d '-15 min' +%s)
drill_day=$(date -u -d "@$drill_at" +%F)
drill_dir=$(date -u -d "@$drill_at" +%Y/%m/%d)
drill_start=$(date -u -d "@$drill_at" +%Y-%m-%dT%H:%M:%S.000Z)
drill_end=$(date -u -d "@$((drill_at + 1))" +%Y-%m-%dT%H:%M:%S.000Z)
for i in $(seq 1 120); do
  body="synthetic e2e object $i $RANDOM$RANDOM"
  sha=$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)
  key=$(printf 'raw/NL-1/nl-1-obs-key/%s/%06dZ-%s.zst' "$drill_dir" "$i" "${sha:0:16}")
  mkdir -p "$(dirname "/srv/rws/raw/${key#raw/}")"
  printf '%s' "$body" | zstd -q -c >"/srv/rws/raw/${key#raw/}"
  jq -cn --arg key "$key" --arg sha "$sha" --arg start "$drill_start" --arg end "$drill_end" \
    '{v: 1, source: "NL-1", spec: "nl-1-obs-key", key: $key, sha256: $sha, fetched_at: {start: $start, end: $end}}'
done >>"$manifest_dir/$drill_day.jsonl"
# The DE-1 fixture archive (recorded public payloads as zstd objects with their
# manifest lines) that load turns into observations; no network, root in the
# container, owner and modes set below as capture writes them.
docker run --rm --network none -v "$repo:$repo:ro" -v /srv/rws/raw:/srv/rws/raw -w "$repo" --entrypoint node \
  "$NODE_IMAGE" scripts/fixture-archive.ts /srv/rws/raw
chown -R 65532:65532 /srv/rws/raw
find /srv/rws/raw -type d -exec chmod 0750 {} +
find /srv/rws/raw -type f -exec chmod 0640 {} +

# ------------------------------------------------------------------ network
step "Public addresses on a dummy interface and an outside network namespace"
ip link add rwsext0 type dummy
ip addr add "$IP4/32" dev rwsext0
ip -6 addr add "$IP6/128" dev rwsext0 nodad
ip link set rwsext0 up
ip netns add ext
ip link add vext0 type veth peer name vext1
ip link set vext1 netns ext
ip addr add 10.99.0.1/30 dev vext0
ip -6 addr add fd99::1/64 dev vext0 nodad
ip link set vext0 up
ip -n ext addr add 10.99.0.2/30 dev vext1
ip -n ext -6 addr add fd99::2/64 dev vext1 nodad
ip -n ext link set lo up
ip -n ext link set vext1 up
ip -n ext route add default via 10.99.0.1
ip -n ext -6 route add default via fd99::1
# The extra client addresses live in the outside namespace, not on the host: a host-originated request to a published
# port is masqueraded to the bridge gateway (Docker's POSTROUTING for local sources), while a request that arrives
# from outside keeps its source, as a visitor's does. The host routes them back through the veth.
for a in "${CLIENT_IPS[@]}"; do
  ip -n ext addr add "$a/32" dev vext1
  ip route add "$a/32" via 10.99.0.2
done
sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
# P12a: a stand-in for the WireGuard interface (a veth named wg0 holding 10.66.0.1/24, its peer 10.66.0.2 in the
# namespace `wgpeer`), so compose can publish the owner site on 10.66.0.1:443 and the firewall's wg0 rules have an
# interface to match; isolation.sh proves the owner site answers there and nowhere else.
"$e2e/wg-veth.sh" || fail "wg-veth.sh"

step "Host firewall: deploy/host/nftables.conf next to Docker's own tables"
nft -c -f "$repo/deploy/host/nftables.conf"
nft -f "$repo/deploy/host/nftables.conf"
nft -f "$repo/deploy/host/nftables.conf"
install -m 0644 "$repo/deploy/host/nftables.conf" /etc/rws/nftables.conf
"$repo/deploy/bin/rws-resolvers"
proof "nft -c and a double load of deploy/host/nftables.conf succeed (idempotent); rws-resolvers filled the DNS allowlist: $(nft list set inet rws resolvers4 | grep -o 'elements = {[^}]*}' || echo none)"

# ------------------------------------------------------------------ release and stack
step "A release directory as rws-deploy stages it, then compose up"
mkdir -p "$REL"
printf 'RWS_SERVER_IMAGE=rws-server:ci\nRWS_WEB_IMAGE=rws-web:ci\nRWS_BACKUP_IMAGE=rws-backup:ci\n' >"$REL/images.env"
docker compose -p rws -f "$repo/deploy/compose.yaml" --env-file /etc/rws/rws.env --env-file "$REL/images.env" config -q
docker compose -p rws -f "$repo/deploy/compose.yaml" -f "$repo/deploy/compose.owner.yaml" \
  --env-file /etc/rws/rws.env --env-file "$REL/images.env" config -q
proof "docker compose config -q: deploy/compose.yaml alone (production until P12a) and with the owner overlay deploy/compose.owner.yaml valid with the host settings and image digests"
# --profile jobs: `config` leaves out services of inactive profiles (the backup job) otherwise.
extra_files=()
[[ -z $mode ]] || extra_files=(-f "$LOADTEST_OVERLAY" -f "$FAKE_OVERLAY")
[[ $mode != drill ]] || extra_files+=(-f "$DRILL_OVERLAY")
docker compose -p rws -f "$repo/deploy/compose.yaml" -f "$e2e/compose.ci.yaml" -f "$repo/deploy/compose.owner.yaml" "${extra_files[@]}" \
  --env-file /etc/rws/rws.env --env-file "$REL/images.env" --profile jobs config >"$REL/compose.yaml"
grep -q '^  backup:' "$REL/compose.yaml" || fail "the merged compose file has no backup service"
grep -q '^  migrate:' "$REL/compose.yaml" || fail "the merged compose file has no migrate job"
grep -q '^  basemap:' "$REL/compose.yaml" || fail "the merged compose file has no basemap job"
grep -q '^  basemap-promote:' "$REL/compose.yaml" || fail "the merged compose file has no basemap-promote job"
for s in publish publish-owner caddy-owner api-owner; do
  grep -q "^  $s:" "$REL/compose.yaml" || fail "the merged compose file has no $s service"
done
set_active prod-ci
# The production path (deploy_release): db healthy, roles and passwords through
# its socket (db_prepare), the migrate job; then up. Twice: a redeploy changes nothing.
db_up || fail "db_up (db start, db_prepare or migrate) failed"
db_up || fail "a second db_up failed"
psql_su() { rws_compose exec -T db psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d rws -c "$1"; }
obs_loaded() { [[ $(psql_su 'select count(*) from obs') =~ ^[1-9][0-9]*$ ]]; }
applied=$(psql_su 'select count(*) from schema_migrations')
files=$(find "$repo/db/migrations" -maxdepth 1 -name '*.sql' | wc -l)
[[ $applied == "$files" ]] || fail "schema_migrations has $applied rows, db/migrations $files files"
owner=$(psql_su "select string_agg(distinct tableowner, ',') from pg_tables where schemaname = 'public'")
[[ $owner == rws_owner ]] || fail "public tables owned by $owner"
# Review N2: a reader session cannot fill the data volume through the NOTIFY queue.
notify=$(psql_su 'show max_notify_queue_pages')
[[ $notify == 64 ]] || fail "max_notify_queue_pages is $notify, not 64"
proof "db_up of rws-lib.sh ran twice: db healthy, deploy/postgres/roles.sql and the five passwords over the local socket, the migrate job (dbmate 2.36.0 in the server image, as rws_migrator): $applied of $files migrations applied, every public table owned by rws_owner, max_notify_queue_pages $notify"
rws_compose up -d --remove-orphans --quiet-pull
healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$1-1") == healthy ]]; }
for s in caddy capture watchdog db load api api-owner publish publish-owner caddy-owner; do wait_for "$s healthy" 240 healthy "$s"; done
proof "caddy, capture, watchdog, db, load, api, api-owner, publish, publish-owner and caddy-owner healthy; the node healthchecks run in distroless (no shell): $(docker inspect -f '{{json .Config.Healthcheck.Test}}' rws-capture-1)"
docker ps -a --filter label=com.docker.compose.project=rws --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
for s in caddy capture watchdog db load api api-owner publish publish-owner caddy-owner; do
  docker inspect -f '{{.Name}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} secopt={{.HostConfig.SecurityOpt}} mem={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} restart={{.HostConfig.RestartPolicy.Name}}' "rws-$s-1"
done

# ------------------------------------------------------------------ Caddy and ACME
step "Caddy: uid 65533, no capability, 80/443, an ACME certificate from Pebble"
status=$(docker exec rws-caddy-1 cat /proc/1/status)
grep -qP '^Uid:\t65533\t' <<<"$status" || fail "caddy does not run as uid 65533"
grep -qP '^CapEff:\t0000000000000000$' <<<"$status" || fail "caddy has an effective capability"
grep -qP '^CapPrm:\t0000000000000000$' <<<"$status" || fail "caddy has a permitted capability"
fetch_root() {
  docker run --rm --network rws_ci-acme --entrypoint wget rws-web:ci -q -O - --no-check-certificate \
    https://pebble:15000/roots/0 >/ci/pki/pebble-root.pem && [[ -s /ci/pki/pebble-root.pem ]]
}
wait_for "Pebble's root" 60 fetch_root
# P12a: the watchdog probes the site (Pebble's chain) and pings the fake healthchecks (the CI CA): one bundle of both,
# read by Node at start, so the two that use it start again.
if [[ -n $mode ]]; then
  cat /ci/pki/ca.pem /ci/pki/pebble-root.pem >/ci/fake/ca-bundle.pem
  rws_compose restart capture watchdog
  for s in capture watchdog; do wait_for "$s healthy again" 120 healthy "$s"; done
fi
outside() { ip netns exec ext curl -fsS --max-time 10 --cacert /ci/pki/pebble-root.pem "$@"; }
wait_for "the ACME certificate" 240 outside --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/healthz"
issuer=$(ip netns exec ext openssl s_client -connect "$IP4:443" -servername "$DOMAIN" </dev/null 2>/dev/null |
  openssl x509 -noout -issuer 2>/dev/null)
proof "caddy runs as uid 65533 with CapEff=CapPrm=0 (cap_drop ALL, nothing added) and still binds 80/443; it obtained a certificate from Pebble over ACME HTTP-01 through the published port ($issuer)"

# ------------------------------------------------------------------ the load-test stack (P9b, P12a)
if [[ -n $mode ]]; then
  step "Load-test stack: data loaded, both publishers' first files, /ci/loadtest.env"
  wait_for "observations from the DE-1 fixture archive" 300 obs_loaded
  wait_for "/api/v1/health through Caddy" 120 outside --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/api/v1/health"
  wait_for "publish's first meta.json" 240 test -s /srv/rws/public/www/v1/meta.json
  wait_for "publish-owner's first meta.json" 240 test -s /srv/rws/owner/www/v1/meta.json
  # caddy-owner's own CA, as isolation.sh reads it (caddy-owner is on rws_owner_public and rws_owner_edge, and
  # published on 10.66.0.1:443 only; P12a).
  docker exec rws-caddy-owner-1 cat /data/caddy/pki/authorities/local/root.crt >/ci/owner-root.crt
  client_ips=$(
    IFS=,
    echo "${CLIENT_IPS[*]}"
  )
  {
    echo "RWS_E2E_DOMAIN=$DOMAIN"
    echo "RWS_E2E_CA=/ci/pki/pebble-root.pem"
    echo "RWS_E2E_CADDY_IP=$IP4"
    echo "RWS_E2E_CLIENT_IPS=$client_ips"
    echo "RWS_E2E_CLIENT_NETNS=ext"
    echo "RWS_E2E_OWNER_CA=/ci/owner-root.crt"
    echo "RWS_E2E_MODE=$mode"
    echo "RWS_E2E_FAKE_IP=$FAKE_IP"
    echo "RWS_E2E_REPO=$repo"
    echo "RWS_E2E_NODE_IMAGE=$NODE_IMAGE"
  } >/ci/loadtest.env
  cat /ci/loadtest.env
  # The marker scripts/flood-drill.ts and the chaos suite refuse to run without (outside /srv/rws: never in an archive).
  printf '{"mode":"%s","domain":"%s"}\n' "$mode" "$DOMAIN" >/ci/e2e-stack
  echo "loadtest stack ready"
  exit 0
fi

# ------------------------------------------------------------------ firewall from outside
step "From outside: 80/443 on IPv4 and IPv6 pass, another published port does not"
[[ $(outside -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/") == 200 ]] || fail "https IPv4"
ipv6_result=failed
if [[ $(outside -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:[$IP6]" "https://$DOMAIN/healthz") == 200 ]]; then
  ipv6_result=ok
else
  echo "::warning::https over IPv6 from outside failed; diagnostics follow"
  ip -n ext -6 addr
  ip -n ext -6 route
  ip -6 addr show dev rwsext0
  ip -6 route get "$IP6" from fd99::2 iif vext0 || true
  sysctl net.ipv6.conf.all.forwarding net.ipv6.conf.vext0.forwarding
  ip6tables -t nat -S 2>/dev/null | grep -Ei 'dnat|docker' | head -n 20 || true
  ip6tables -S 2>/dev/null | grep -Ei 'rws-public|docker-forward|drop|reject' | head -n 20 || true
  docker exec rws-caddy-1 ip -6 addr 2>/dev/null || true
  docker exec rws-caddy-1 ip -6 route 2>/dev/null || true
  curl -sS -o /dev/null -w 'from the host: %{http_code}\n' --max-time 10 --cacert /ci/pki/pebble-root.pem \
    --resolve "$DOMAIN:443:[$IP6]" "https://$DOMAIN/healthz" || true
  ip netns exec ext curl -v --max-time 10 --cacert /ci/pki/pebble-root.pem --resolve "$DOMAIN:443:[$IP6]" \
    "https://$DOMAIN/healthz" 2>&1 | tail -n 15 || true
  ss -ltnp | grep -E ':(80|443) ' || true
fi
[[ $(ip netns exec ext curl -sS -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:80:$IP4" "http://$DOMAIN/") == 308 ]] || fail "http redirect"
[[ $(curl -fsS --max-time 5 "http://$IP4:8081/") == probe ]] || fail "the probe port is not published on the host"
if ip netns exec ext curl -sS --max-time 5 -o /dev/null "http://$IP4:8081/" 2>/dev/null; then
  fail "a published port other than 80/443 is reachable from outside"
fi
proof "from an outside namespace: https on $IP4 answers 200 (IPv6 [$IP6]: $ipv6_result) and http redirects (308); port 8081, published by Docker on the same address and reachable from the host itself, is dropped by table inet rws (DNAT happens in nat PREROUTING, so INPUT never sees it; our forward chain does)"
nft list tables | tr '\n' ' '
echo
iptables -S FORWARD 2>/dev/null | head -n 5 || true
proof "Docker's own tables ($(nft list tables | grep -v 'inet rws' | awk '{print $2"/"$3}' | tr '\n' ' ')) and FORWARD -> DOCKER-FORWARD ($(iptables -S FORWARD 2>/dev/null | grep -c DOCKER) rules) stay in place beside table inet rws"

# ------------------------------------------------------------------ egress
step "Container egress: TCP 443 and DNS to the host's resolvers only; backup to the bucket only"
# --init: busybox timeout signals the program it ran, which as PID 1 would ignore it.
probe_on() {
  local net=$1
  shift
  docker run --rm --init --network "$net" --entrypoint timeout rws-web:ci 15 "$@"
}
# The backup network exists once the backup job has run (profile "jobs"): restic version is offline.
rws_compose run --rm --no-deps -T backup version
probe_on rws_egress wget -q -O /dev/null https://www.example.com || fail "egress: https blocked"
if probe_on rws_egress wget -q -O /dev/null http://www.example.com; then fail "egress: port 80 open"; fi
if probe_on rws_egress nslookup www.example.com 9.9.9.9; then fail "egress: DNS to a foreign resolver open"; fi
if probe_on rws_backup nc -z -w 5 1.1.1.1 443; then fail "backup network: an address outside the bucket set is reachable"; fi
nft add element inet rws backup4 '{ 1.1.1.1 }'
probe_on rws_backup nc -z -w 5 1.1.1.1 443 || fail "backup network: an address in the bucket set is blocked"
nft flush set inet rws backup4
proof "from rws-egress: https out works, http out and DNS to 9.9.9.9 are dropped; from rws-backup: 1.1.1.1:443 is dropped until it is in @backup4, then passes"

# ------------------------------------------------------------------ secrets
step "File secrets keep their host owner: only the service with the gid reads them"
stat -c '%n %a %u:%g' /etc/rws/secrets /etc/rws/secrets/*
docker exec rws-capture-1 /nodejs/bin/node -e \
  "for (const f of ['hc_ping_key', 'rws_x_api_key']) require('fs').readFileSync('/run/secrets/' + f)"
seen=$(docker exec rws-watchdog-1 /nodejs/bin/node -e "console.log(require('fs').readdirSync('/run/secrets').join(','))")
[[ $seen == hc_ping_key ]] || fail "watchdog sees secrets: $seen"
if docker run --rm --user 65532:65532 -v /etc/rws/secrets/rws_x_api_key:/s:ro --entrypoint /nodejs/bin/node rws-server:ci \
  -e "require('fs').readFileSync('/s')" 2>/dev/null; then
  fail "a uid-65532 container without the gid read a secret"
fi
proof "secrets are root:<gid> 0440 on the host and stay so in the container: capture (gids 61001, 61002) reads its two, watchdog mounts only hc_ping_key, and uid 65532 without the gid gets EACCES"
# How a changed secret reaches a running container (bootstrap.md §3), on a throwaway file bind mount.
printf 'one\n' >/ci/bind-probe
docker run -d --name rws-bind-probe --network none -v /ci/bind-probe:/probe:ro --entrypoint sleep rws-web:ci 300 >/dev/null
printf 'two\n' >/ci/bind-probe
[[ $(docker exec rws-bind-probe cat /probe) == two ]] || fail "an in-place write is not seen in a running container"
printf 'three\n' >/ci/bind-probe.new
mv -f /ci/bind-probe.new /ci/bind-probe
[[ $(docker exec rws-bind-probe cat /probe) == two ]] || fail "a file replaced by a rename reached a running container"
docker restart rws-bind-probe >/dev/null
[[ $(docker exec rws-bind-probe cat /probe) == three ]] || fail "docker restart did not mount the replaced file"
docker rm -f rws-bind-probe >/dev/null
proof "a file bind mount (as Compose mounts file secrets): an in-place write (sudoedit) is seen at once, a file replaced by a rename stays the old one in a running container, and docker restart mounts the new one"

# ------------------------------------------------------------------ database, load, api (P2a)
step "db: no port, internal network only; pg_hba and the rws_api grants from inside the api container"
[[ $(docker inspect -f '{{json .HostConfig.PortBindings}}' rws-db-1) =~ ^(\{\}|null)$ ]] || fail "db publishes a port"
nets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' rws-db-1)
# The owner overlay adds owner_db for api-owner alone (P9b review F1); both are internal.
[[ $nets == 'rws_db rws_owner_db ' ]] || fail "db networks: $nets"
[[ $(docker network inspect -f '{{.Internal}}' rws_db) == true ]] || fail "network rws_db is not internal"
# node-postgres from the api image itself; the password comes from the container's
# own secret file, never from this script's argv. Prints the SQLSTATE of each try.
pg_try='
const { Client } = require("/app/apps/server/node_modules/pg");
const pw = require("fs").readFileSync("/run/secrets/db_rws_api", "utf8").trim();
const tryq = async (user, password, sql) => {
  const c = new Client({ host: "db", port: 5432, database: "rws", user, password, connectionTimeoutMillis: 5000 });
  try { await c.connect(); } catch (e) { return "login:" + (e.code || "error"); }
  try { await c.query(sql); return "ok"; } catch (e) { return "sql:" + (e.code || "error"); } finally { await c.end(); }
};
(async () => console.log([
  await tryq("rws_api", pw, "select 1"),
  await tryq("rws_api", "wrong-" + pw, "select 1"),
  await tryq("postgres", pw, "select 1"),
  await tryq("rws_api", pw, "select * from obs limit 1"),
  await tryq("rws_api", pw, "insert into obs default values"),
  await tryq("rws_api", pw, "begin read write; insert into obs default values"),
].join(" ")))();'
got=$(docker exec rws-api-1 /nodejs/bin/node -e "$pg_try")
[[ $got == 'ok login:28P01 login:28000 sql:42501 sql:25006 sql:42501' ]] || fail "pg_hba and grants: $got"
proof "db publishes no port (PortBindings empty) and sits only on rws_db and rws_owner_db (both internal); from the api container: rws_api logs in with its secret, a wrong password is refused (28P01), postgres over TCP is rejected by pg_hba (28000); rws_api cannot read the base table obs (42501), its session is read-only (25006) and even a read-write transaction cannot insert (42501)"

step "load turns the DE-1 fixture archive into observations; the api and the pages answer through Caddy"
wait_for "observations from the DE-1 fixture archive" 300 obs_loaded
api_url() { printf 'https://%s%s' "$DOMAIN" "$1"; }
api_code() {
  ip netns exec ext curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --cacert /ci/pki/pebble-root.pem \
    --resolve "$DOMAIN:443:$IP4" "$(api_url "$1")"
}
wait_for "/api/v1/health through Caddy" 120 outside --resolve "$DOMAIN:443:$IP4" "$(api_url /api/v1/health)"
health=$(outside --resolve "$DOMAIN:443:$IP4" "$(api_url /api/v1/health)")
jq -e '.status | type == "string"' <<<"$health" >/dev/null || fail "/api/v1/health: no status"
sources=$(outside --resolve "$DOMAIN:443:$IP4" "$(api_url /api/v1/health/sources)")
grep -q '"DE-1"' <<<"$sources" || fail "/api/v1/health/sources does not list DE-1"
# One request through Caddy from outside: the status goes to api_status, the headers to /ci/api.hdr (CR stripped)
# and the body to /ci/api.body. Further arguments are curl options (a method, a body).
api_req() {
  local path=$1
  shift
  api_status=$(ip netns exec ext curl -sS -o /ci/api.body -D /ci/api.hdr.raw -w '%{http_code}' --max-time 10 \
    --cacert /ci/pki/pebble-root.pem --resolve "$DOMAIN:443:$IP4" "$@" "$(api_url "$path")")
  tr -d '\r' </ci/api.hdr.raw >/ci/api.hdr
}
# P4b: every GET and HEAD under /api/v1/ reaches the api, which answers from the fixture-loaded database.
api_req /api/v1/meta
[[ $api_status == 200 ]] || fail "/api/v1/meta: HTTP $api_status"
grep -qiFx 'cache-control: public, max-age=60' /ci/api.hdr || fail "/api/v1/meta: Cache-Control: $(grep -i '^cache-control:' /ci/api.hdr)"
jq -e '(.sources | map(.id)) as $ids | ($ids | index("DE-1")) != null and ($ids | index("NL-1")) != null' /ci/api.body >/dev/null ||
  fail "/api/v1/meta does not list DE-1 and NL-1"
api_req /api/v1/stations
[[ $api_status == 200 ]] || fail "/api/v1/stations: HTTP $api_status"
jq -e '.stations | length > 0' /ci/api.body >/dev/null || fail "/api/v1/stations lists no station"
# The api's own 404 is a fixed JSON body; Caddy's 404 for a wrong-case path has none.
api_req /api/v1/x
[[ $api_status == 404 && $(</ci/api.body) == '{"error":"not_found","attribution":[]}' ]] || fail "/api/v1/x: HTTP $api_status, not the api's 404"
[[ $(api_code /API/v1/health) == 404 ]] || fail "/API/v1/health is not a 404"
[[ $(api_code '/api/v1/health?rws-e2e-unknown=1') == 400 ]] || fail "an unknown parameter is not a 400"
# Only GET and HEAD, and no request body of any size: a 405 with Allow, a 413.
api_req /api/v1/meta -X POST
[[ $api_status == 405 ]] || fail "POST /api/v1/meta: HTTP $api_status, want 405"
grep -qiFx 'allow: GET, HEAD' /ci/api.hdr || fail "POST /api/v1/meta: no Allow: GET, HEAD"
grep -qi '^content-security-policy: default-src' /ci/api.hdr || fail "the 405 lacks the site headers"
# The same guard before every route (SR-3): never file_server's bare 405, which names Caddy.
for path in / /en/foo /assets/no-such-file.js; do
  api_req "$path" -X POST
  [[ $api_status == 405 ]] || fail "POST $path: HTTP $api_status, want 405"
  grep -qiFx 'allow: GET, HEAD' /ci/api.hdr || fail "POST $path: no Allow: GET, HEAD"
  grep -qi '^content-security-policy: default-src' /ci/api.hdr || fail "POST $path: the 405 lacks the site headers"
  ! grep -qi '^server:' /ci/api.hdr || fail "POST $path: the 405 names its server"
done
head -c 2048 /dev/zero | tr '\0' a >/ci/api.big
api_req /api/v1/meta -X GET -H 'Expect:' --data-binary @/ci/api.big
[[ $api_status == 413 ]] || fail "GET /api/v1/meta with a 2048-byte body: HTTP $api_status, want 413"
# The pages (P10b): the exact paths of the allowlist are the shell of their language (200); any other path (no file,
# no dot in its last segment, or another case) is the 404 shell of its language with status 404, never a 200; a missing
# file with an extension is a bare 404. page_is <path> <status> <lang>: the status, the shell's <html lang> and no-cache.
page_is() {
  api_req "$1"
  [[ $api_status == "$2" ]] || fail "$1: HTTP $api_status, want $2"
  grep -qF "<html lang=\"$3\"" /ci/api.body || fail "$1 is not the $3 shell"
  grep -qiFx 'cache-control: no-cache' /ci/api.hdr || fail "$1: Cache-Control: $(grep -i '^cache-control:' /ci/api.hdr)"
}
page_is /over 200 nl
page_is /en/about 200 en
page_is /en/no-such-page 404 en
page_is /no-such-page 404 nl
page_is /Over 404 nl
[[ $(api_code /assets/no-such-file) == 404 && $(api_code /favicon.ico) == 404 ]] ||
  fail "a missing asset or /favicon.ico is not a 404"
headers=$(ip netns exec ext curl -sS -D - -o /dev/null --max-time 10 --cacert /ci/pki/pebble-root.pem \
  --resolve "$DOMAIN:443:$IP4" "$(api_url /api/v1/health)" | tr -d '\r')
grep -qi '^content-security-policy: default-src' <<<"$headers" || fail "the api response lacks the site headers"
! grep -qiE '^(server|via|access-control-[a-z-]+):' <<<"$headers" || fail "the api response names its software or sends CORS"
proof "load wrote $(psql_su 'select count(*) from obs') observations from the fixture archive; over TLS through Caddy /api/v1/health answers $(jq -c '{status}' <<<"$health") and /api/v1/health/sources lists DE-1, with the site headers and no Server, Via or CORS header; /api/v1/meta (max-age=60, DE-1 and NL-1 listed) and /api/v1/stations are 200 from the real api; /api/v1/x is the api's {\"error\":\"not_found\",\"attribution\":[]} 404 and /API/v1/health a 404 from Caddy; an unknown parameter is a 400; a POST is a 405 with Allow: GET, HEAD (site headers kept), on /, /en/foo and /assets/no-such-file.js too (no Server), and a GET with a 2048-byte body a 413; /over and /en/about are the Dutch and the English page (200), /en/no-such-page, /no-such-page and /Over the 404 shell of their language (404), all with Cache-Control: no-cache, and /assets/no-such-file and /favicon.ico bare 404s"

step "load and api: no route out, the hardening flags, only their own secret"
no_route='const s = require("net").connect({ host: "1.1.1.1", port: 443, timeout: 5000 });
s.on("connect", () => { console.log("connected"); process.exit(1); });
s.on("timeout", () => { console.log("timeout"); process.exit(0); });
s.on("error", (e) => { console.log(e.code); process.exit(0); });'
routes=''
for s in load api; do
  r=$(docker exec "rws-$s-1" /nodejs/bin/node -e "$no_route") || fail "$s reached 1.1.1.1:443"
  routes+="$s $r; "
done
read_status='process.stdout.write(require("fs").readFileSync("/proc/1/status", "utf8"))'
for s in db load api; do
  if [[ $s == db ]]; then st=$(docker exec rws-db-1 cat /proc/1/status); uid=999; else
    st=$(docker exec "rws-$s-1" /nodejs/bin/node -e "$read_status")
    uid=65532
  fi
  grep -qP "^Uid:\t$uid\t" <<<"$st" || fail "$s does not run as uid $uid"
  grep -qP '^CapEff:\t0000000000000000$' <<<"$st" || fail "$s has an effective capability"
  grep -qP '^NoNewPrivs:\t1$' <<<"$st" || fail "$s may gain privileges"
  [[ $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' "rws-$s-1") == 'true [ALL]' ]] ||
    fail "$s: root file system writable or capabilities kept"
done
list_secrets="console.log(require('fs').readdirSync('/run/secrets').join(','))"
[[ $(docker exec rws-load-1 /nodejs/bin/node -e "$list_secrets") == db_rws_load ]] || fail "load sees other secrets"
[[ $(docker exec rws-api-1 /nodejs/bin/node -e "$list_secrets") == db_rws_api ]] || fail "api sees other secrets"
[[ $(docker exec rws-db-1 ls /run/secrets) == db_postgres ]] || fail "db sees other secrets"
if docker run --rm --network none --user 65532:65532 -v /etc/rws/secrets/db_rws_api:/s:ro \
  --entrypoint /nodejs/bin/node rws-server:ci -e "require('fs').readFileSync('/s')" 2>/dev/null; then
  fail "a uid-65532 container without gid 61008 read db_rws_api"
fi
proof "load and api have no route out (1.1.1.1:443: ${routes% })"
proof "db (uid 999), load and api (uid 65532): read-only root, cap_drop ALL, CapEff 0, NoNewPrivs 1; each mounts only its own secret (db_postgres, db_rws_load, db_rws_api), and uid 65532 without gid 61008 cannot read db_rws_api"

# ------------------------------------------------------------------ basemap (P3)
step "basemap: fetch cannot write what Caddy serves; promote (no network) moves the checked PMTiles in; Caddy serves them with Range"
tiles=/srv/rws/tiles build=20261001 fixtures=$repo/tools/geo/fixtures
# The shape T-WEB-1 rests on, from the merged compose file the stack runs: the job with the
# network sees the served directory read-only and writes only .staging, no file of it over
# 6.5 GB (fsize, T-MAP-1); the job that writes the served directory has no network (and
# neither has a secret); Caddy mounts it read-only.
# shellcheck disable=SC2016 # a jq program, not shell
shape='.services.basemap as $f | .services["basemap-promote"] as $p | .services.caddy as $c
  | ($f.networks | keys) == ["egress"] and $f.network_mode == null
  and $f.profiles == ["jobs"] and $p.profiles == ["jobs"]
  and $f.user == "65532:65532" and $p.user == "65532:65532"
  and $f.read_only == true and $p.read_only == true
  and $f.cap_drop == ["ALL"] and $p.cap_drop == ["ALL"]
  and ([$f.volumes[].target] | sort) == ["/staging", "/tiles"]
  and ([$f.volumes[] | select(.target == "/tiles")][0] | .source == "/srv/rws/tiles" and .read_only == true)
  and ([$f.volumes[] | select(.target == "/staging")][0] | .source == "/srv/rws/tiles/.staging" and .read_only != true)
  and $p.network_mode == "none" and $p.networks == null
  and ([$p.volumes[].target] | sort) == ["/ci/basemap.yaml", "/tiles"]
  and ([$p.volumes[] | select(.target == "/tiles")][0] | .source == "/srv/rws/tiles" and .read_only != true)
  and ([$c.volumes[] | select(.target == "/srv/rws/tiles")][0] | .source == "/srv/rws/tiles" and .read_only == true)
  and $f.secrets == null and $p.secrets == null
  and $f.ulimits.fsize == {soft: 6500000000, hard: 6500000000}
  and $p.environment.RWS_BASEMAP_REGISTRY == "/ci/basemap.yaml"'
rws_compose --profile jobs config --format json | jq -e "$shape" >/dev/null ||
  fail "the basemap jobs or caddy's tiles mount do not have the shape T-WEB-1 needs (deploy/compose.yaml)"
[[ $(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/srv/rws/tiles"}}{{.RW}}{{end}}{{end}}' rws-caddy-1) == false ]] ||
  fail "caddy mounts /srv/rws/tiles read-write, or not at all"
# P6b: the two river directories read-only, and never all of /srv/rws/public (capture's status lives there).
# shellcheck disable=SC2016 # a jq program, not shell
rivers_shape='[.services.caddy.volumes[] | select(.target | startswith("/srv/rws/public"))] as $v
  | ($v | map(.target) | sort) == ["/srv/rws/public/data/v1/rivers", "/srv/rws/public/downloads", "/srv/rws/public/ops", "/srv/rws/public/www/v1"]
  and ($v | all(.read_only == true and .source == .target))'
rws_compose config --format json | jq -e "$rivers_shape" >/dev/null ||
  fail "caddy's /srv/rws/public mounts are not exactly ops, data/v1/rivers, downloads and the publisher's www/v1, read-only (deploy/compose.yaml)"
for m in /srv/rws/public/data/v1/rivers /srv/rws/public/downloads; do
  [[ $(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$m\"}}{{.RW}}{{end}}{{end}}" rws-caddy-1) == false ]] ||
    fail "caddy mounts $m read-write, or not at all"
done
# The same from inside the real containers (distroless: node is the probe).
fs_probe='const fs = require("fs"); const r = [];
try { fs.writeFileSync("/tiles/e2e-probe", "x"); r.push("tiles:wrote"); } catch (e) { r.push("tiles:" + e.code); }
try { fs.writeFileSync("/staging/e2e-probe", "x"); fs.unlinkSync("/staging/e2e-probe"); r.push("staging:ok"); } catch (e) { r.push("staging:" + e.code); }
console.log(r.join(" "));'
got=$(rws_compose run --rm --no-deps -T --entrypoint /nodejs/bin/node basemap -e "$fs_probe")
[[ $got == 'tiles:EROFS staging:ok' ]] || fail "the basemap job's file systems: $got"
# Docker hands the fsize value to setrlimit as is: bytes (the kernel's unit for RLIMIT_FSIZE).
limits_probe='console.log(require("fs").readFileSync("/proc/self/limits", "utf8").split("\n").find((l) => l.startsWith("Max file size")).trim().split(/ {2,}/).slice(1).join(" "))'
fsize=$(rws_compose run --rm --no-deps -T --entrypoint /nodejs/bin/node basemap -e "$limits_probe")
[[ $fsize == '6500000000 6500000000 bytes' ]] || fail "the basemap job's file size limit: $fsize"
ifaces='console.log(Object.keys(require("os").networkInterfaces()).join(","))'
got=$(rws_compose run --rm --no-deps -T --entrypoint /nodejs/bin/node basemap-promote -e "$ifaces")
[[ $got == lo ]] || fail "basemap-promote has network interfaces: $got"
promote_route=$(rws_compose run --rm --no-deps -T --entrypoint /nodejs/bin/node basemap-promote -e "$no_route") ||
  fail "basemap-promote reached 1.1.1.1:443"
proof "from the merged compose file: basemap joins only rws_egress, mounts /srv/rws/tiles read-only and only .staging read-write, has no secret and a file size limit of 6.5 GB (/proc/self/limits: $fsize); basemap-promote has network_mode none, mounts /srv/rws/tiles read-write and no secret; caddy mounts /srv/rws/tiles read-only (docker inspect agrees); in the real containers basemap gets EROFS writing /tiles and can write /staging, and basemap-promote has only lo (1.1.1.1:443: $promote_route)"

# What fetch leaves behind (its real output is a file per extract under its final name and result.json), from the recorded fixtures.
sha() { sha256sum "$1" | cut -d' ' -f1; }
size() { stat -c %s "$1"; }
install -m 0644 -o 65532 -g 65532 "$fixtures/lobith-z14.pmtiles" "$tiles/.staging/basemap-$build.pmtiles"
install -m 0644 -o 65532 -g 65532 "$fixtures/planet-z2.pmtiles" "$tiles/.staging/planet-z6-$build.pmtiles"
jq -n --arg build "$build" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg bsum "$(sha "$fixtures/lobith-z14.pmtiles")" --argjson bsize "$(size "$fixtures/lobith-z14.pmtiles")" \
  --arg psum "$(sha "$fixtures/planet-z2.pmtiles")" --argjson psize "$(size "$fixtures/planet-z2.pmtiles")" \
  '{schema_version: 1, build: $build, version: "4.15.2", created_at: $at,
    basemap: {file: "basemap-\($build).pmtiles", sha256: $bsum, bytes: $bsize},
    planet: {file: "planet-z6-\($build).pmtiles", sha256: $psum, bytes: $psize}}' >/ci/result.json
install -m 0644 -o 65532 -g 65532 /ci/result.json "$tiles/.staging/result.json"
# The real promote job, through the same compose file as the rest, against the CI copy of the basemap registry.
promote_out=$(rws_compose run --rm --no-deps -T basemap-promote basemap promote 2>&1) || {
  echo "$promote_out"
  fail "basemap promote failed"
}
echo "$promote_out"
ls -la "$tiles" "$tiles/.staging"
# shellcheck disable=SC2016 # a jq program, not shell
manifest_shape='keys == ["current", "previous", "schema_version"] and .schema_version == 1 and .previous == null
  and (.current | keys == ["basemap", "build", "created_at", "planet", "version"])
  and .current.build == $build and .current.version == "4.15.2"
  and (.current.created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"))
  and .current.basemap == {file: "basemap-\($build).pmtiles", sha256: $bsum, bytes: $bsize}
  and .current.planet == {file: "planet-z6-\($build).pmtiles", sha256: $psum, bytes: $psize}'
jq -e --arg build "$build" \
  --arg bsum "$(sha "$fixtures/lobith-z14.pmtiles")" --argjson bsize "$(size "$fixtures/lobith-z14.pmtiles")" \
  --arg psum "$(sha "$fixtures/planet-z2.pmtiles")" --argjson psize "$(size "$fixtures/planet-z2.pmtiles")" \
  "$manifest_shape" "$tiles/manifest.json" >/dev/null || fail "manifest.json: $(cat "$tiles/manifest.json")"
[[ $(stat -c '%a %u:%g' "$tiles/manifest.json") =~ ^[0-7][0-7][4-7]\ 65532:65532$ ]] ||
  fail "manifest.json mode and owner: $(stat -c '%a %u:%g' "$tiles/manifest.json")"
for pair in "basemap-$build.pmtiles:lobith-z14.pmtiles" "planet-z6-$build.pmtiles:planet-z2.pmtiles"; do
  name=${pair%%:*} orig=$fixtures/${pair#*:}
  [[ $(stat -c '%F %a %u:%g' "$tiles/$name") == 'regular file 644 65532:65532' ]] ||
    fail "$name: $(stat -c '%F %a %u:%g' "$tiles/$name")"
  cmp -s "$orig" "$tiles/$name" || fail "$name differs from the staged fixture"
done
[[ -z $(find "$tiles/.staging" -mindepth 1) ]] || fail ".staging is not empty after promote: $(ls -A "$tiles/.staging")"
[[ $(stat -c '%a %u:%g' "$tiles/.staging") == '700 65532:65532' ]] || fail ".staging: $(stat -c '%a %u:%g' "$tiles/.staging")"
[[ $(find "$tiles" -mindepth 1 -maxdepth 1 -not -name '.*' -printf '%f\n' | sort | tr '\n' ' ') == "basemap-$build.pmtiles manifest.json planet-z6-$build.pmtiles " ]] ||
  fail "the served directory holds: $(ls -A "$tiles")"
# A run with nothing staged is a no-op that changes nothing (the quarterly timer may find nothing to do).
cp -p "$tiles/manifest.json" /ci/manifest.before
rws_compose run --rm --no-deps -T basemap-promote basemap promote >/dev/null 2>&1 || fail "a promote with nothing staged failed"
cmp -s /ci/manifest.before "$tiles/manifest.json" || fail "a promote with nothing staged changed manifest.json"
proof "basemap promote (the real job, no network, CI copy of registry/basemap.yaml with the fixtures' extracts) exited 0 on the staged Lobith z0-14 and planet z0-2 PMTiles: manifest.json names build $build with previous null and the staged sha256 and sizes; both files are regular, 0644, 65532:65532 and equal to the fixtures; .staging is empty and 0700; nothing else sits in the served directory; a second promote with nothing staged changed nothing"
tiles_url() { printf 'https://%s/tiles/%s' "$DOMAIN" "$1"; }
for pair in "basemap-$build.pmtiles:lobith-z14.pmtiles" "planet-z6-$build.pmtiles:planet-z2.pmtiles"; do
  name=${pair%%:*} orig=$fixtures/${pair#*:}
  code=$(outside -o /ci/range.body -D /ci/range.hdr -w '%{http_code}' -H 'Range: bytes=0-15' \
    --resolve "$DOMAIN:443:$IP4" "$(tiles_url "$name")") || fail "$(tiles_url "$name") did not answer (the Caddy routes of P2b)"
  hdr=$(tr -d '\r' </ci/range.hdr)
  [[ $code == 206 ]] || fail "Range request for $name: HTTP $code"
  grep -qiFx "content-range: bytes 0-15/$(size "$orig")" <<<"$hdr" || fail "$name: no Content-Range for its size: $hdr"
  grep -qiFx 'cache-control: public, max-age=31536000, immutable' <<<"$hdr" || fail "$name: Cache-Control: $hdr"
  ! grep -qi '^content-encoding:' <<<"$hdr" || fail "$name is served with a Content-Encoding"
  [[ $(size /ci/range.body) == 16 ]] || fail "$name: the body is not 16 bytes"
  cmp -s -n 16 /ci/range.body "$orig" || fail "$name: the 16 bytes served are not the file's first 16"
done
outside -o /ci/manifest.served --resolve "$DOMAIN:443:$IP4" "$(tiles_url manifest.json)" || fail "manifest.json is not served"
cmp -s /ci/manifest.served "$tiles/manifest.json" || fail "the served manifest.json differs from the file"
# Only one explicit range is served (SR-1), and only without If-Range or If-Match (SR2-1: an If-Range
# that does not match would send the whole file, a failed If-Match a 412 marked immutable): no Range,
# an open range, two ranges and one range with either header are a 416 that keeps the site headers
# and is never marked immutable. Each case is its request headers, separated by "|".
for ask in '' 'Range: bytes=0-' 'Range: bytes=0-0,2-2' 'Range: bytes=0-15|If-Range: "e2e"' 'Range: bytes=0-15|If-Match: "e2e"'; do
  ask_args=()
  IFS='|' read -ra fields <<<"$ask"
  for field in "${fields[@]}"; do ask_args+=(-H "$field"); done
  what=${ask:-no Range}
  code=$(ip netns exec ext curl -sS --max-time 10 --cacert /ci/pki/pebble-root.pem -o /ci/416.body -D /ci/416.hdr \
    -w '%{http_code}' "${ask_args[@]}" --resolve "$DOMAIN:443:$IP4" "$(tiles_url "basemap-$build.pmtiles")") ||
    fail "basemap-$build.pmtiles did not answer ($what)"
  hdr=$(tr -d '\r' </ci/416.hdr)
  [[ $code == 416 ]] || fail "basemap-$build.pmtiles with $what: HTTP $code, want 416"
  ! grep -qi '^cache-control:.*immutable' <<<"$hdr" || fail "the 416 for $what is marked immutable"
  grep -qiFx 'x-content-type-options: nosniff' <<<"$hdr" || fail "the 416 for $what lacks the site headers"
  [[ $(size /ci/416.body) == 0 ]] || fail "the 416 for $what has a body"
done
proof "https://$DOMAIN/tiles/basemap-$build.pmtiles and planet-z6-$build.pmtiles answer a Range request (bytes=0-15) with 206, a Content-Range for the file's size, Cache-Control public, max-age=31536000, immutable, no Content-Encoding and the file's own first 16 bytes; no Range, an open range, two ranges and bytes=0-15 with If-Range or If-Match are a 416 with the site headers, no immutable and no body; /tiles/manifest.json is served byte for byte"
# A container of the fetch job left over from an earlier run (CR2-4): a real one, started through the same
# compose file as the rest and still running, is what rws-basemap-refresh's own filter finds, and the script
# refuses before it runs any job. Named, so the test does not depend on what `compose run -d` prints.
rws_compose run -d --no-deps -T --name rws-e2e-leftover --entrypoint /nodejs/bin/node basemap \
  -e 'setTimeout(() => {}, 3e5)' >/dev/null || fail "could not start a leftover basemap container"
leftover=$(docker inspect -f '{{.Id}}' rws-e2e-leftover) || fail "the leftover basemap container is not there"
found=$(docker ps -aq --filter label=com.docker.compose.project=rws --filter label=com.docker.compose.service=basemap)
refused_rc=0
refused=$("$repo/deploy/bin/rws-basemap-refresh" --dry-run 2>&1) || refused_rc=$?
docker rm -f rws-e2e-leftover >/dev/null || fail "could not remove the leftover basemap container"
[[ $found == "${leftover:0:12}" ]] || fail "rws-basemap-refresh's filter found '${found//$'\n'/ }', want ${leftover:0:12}"
[[ $refused_rc == 1 ]] || fail "rws-basemap-refresh --dry-run beside a leftover container exited $refused_rc: $refused"
grep -qF "error: a basemap container is left over (${leftover:0:12})" <<<"$refused" ||
  fail "rws-basemap-refresh --dry-run beside a leftover container: $refused"
[[ -z $(docker ps -aq --filter label=com.docker.compose.project=rws --filter label=com.docker.compose.service=basemap) ]] ||
  fail "a basemap container is still there after docker rm -f"
proof "a basemap container started with compose run -d and left running is found by rws-basemap-refresh's filter (docker ps -aq, labels project rws and service basemap: ${leftover:0:12}); rws-basemap-refresh --dry-run beside it exits 1 with 'a basemap container is left over (${leftover:0:12})' before any job runs; after docker rm -f the filter finds nothing"

# ------------------------------------------------------------------ capture
step "Capture in distroless: contract files, modes, generated_at advances"
wait_for "capture.json" 120 test -s /srv/rws/public/status/capture.json
modes=$(stat -c '%n %a %u' /srv/rws/public/status/capture.json /srv/rws/owner/status/capture.json)
echo "$modes"
grep -q 'public/status/capture.json 644 65532' <<<"$modes" || fail "public capture.json mode"
grep -q 'owner/status/capture.json 640 65532' <<<"$modes" || fail "owner capture.json mode"
state_modes=$(find /srv/rws/raw/_state -type f -printf '%m %u\n' | sort -u)
[[ $state_modes == '640 65532' ]] || fail "raw/_state modes: $state_modes"
g1=$(jq -r .generated_at /srv/rws/public/status/capture.json)
sleep 65
g2=$(jq -r .generated_at /srv/rws/public/status/capture.json)
[[ $g2 > $g1 ]] || fail "generated_at did not advance ($g1 -> $g2)"
jq -e 'keys == ["days", "generated_at", "owner_specs", "seeds", "specs"]' /srv/rws/public/status/capture.json >/dev/null ||
  fail "public capture.json keys"
proof "capture (uid 65532) writes public capture.json 0644 and owner capture.json and raw/_state 0640; generated_at advanced $g1 -> $g2; the public file has exactly the contract keys"

step "The served capture.json: a checked root copy; a planted symlink is refused (S1)"
served() { outside --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/status/capture.json"; }
served_since() { [[ ! $(served | jq -r .generated_at) < $1 ]]; }
wait_for "the served capture.json at $g2 or later" 60 served_since "$g2"
[[ $(stat -c '%a %u' /srv/rws/public/ops/capture.json) == '644 0' ]] || fail "the served copy is not root 0644"
mounts=$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' rws-caddy-1)
[[ $mounts != */srv/rws/public/status* && $mounts == */srv/rws/public/ops* ]] || fail "caddy mounts: $mounts"
proof "the real rws-status-copy.path unit published capture.json as root 0644 into /srv/rws/public/ops, and https://$DOMAIN/status/capture.json serves generated_at $(served | jq -r .generated_at); caddy mounts only public/ops, never capture's public/status ($mounts)"
canary=/srv/rws/public/ops/s1-canary.json
printf '{"days":[],"generated_at":"s1-symlink-canary","owner_specs":{"fresh":0,"total":0},"seeds":[],"specs":[]}\n' >"$canary"
chmod 0644 "$canary"
rws_compose pause capture
ln -sfn "$canary" /srv/rws/public/status/capture.json
rc=0
out=$("$repo/deploy/bin/rws-status-copy" 2>&1) || rc=$?
echo "$out"
if ((rc == 0)) || ! grep -q 'not a regular file' <<<"$out"; then fail "rws-status-copy did not refuse a symlink"; fi
! grep -q s1-symlink-canary /srv/rws/public/ops/capture.json || fail "the symlink's target reached the served copy"
body=$(served)
jq -e '.generated_at | strings' <<<"$body" >/dev/null || fail "no served capture.json while the symlink is planted"
! grep -q s1-symlink-canary <<<"$body" || fail "the symlink's target was served"
rm -f /srv/rws/public/status/capture.json "$canary"
# A contract-shaped document that names an owner source (R2-S7).
jq -c '.days = [{"source": "LU-2"}]' /srv/rws/public/ops/capture.json >/srv/rws/public/status/capture.json
rc=0
out=$("$repo/deploy/bin/rws-status-copy" 2>&1) || rc=$?
echo "$out"
if ((rc == 0)) || ! grep -q 'invariant 11 tripwire' <<<"$out"; then fail "rws-status-copy did not refuse an owner source"; fi
! grep -q LU-2 /srv/rws/public/ops/capture.json || fail "an owner source reached the served copy"
! served | grep -q LU-2 || fail "an owner source was served"
rm -f /srv/rws/public/status/capture.json
rws_compose unpause capture
proof "a symlink planted as capture's capture.json (to a contract-shaped canary readable by root and by Caddy) is refused by rws-status-copy; neither the served copy nor https://$DOMAIN/status/capture.json ever carries the canary; a contract-shaped capture.json naming an owner source is refused by the invariant-11 tripwire and never served"

step "rws-status-copy.path outlives a burst of writes, and rws-tick re-arms it (R2-S2)"
put_status() {
  jq -c --arg g "$1" '.generated_at = $g' /srv/rws/public/ops/capture.json >/srv/rws/public/status/.e2e.tmp
  mv -f /srv/rws/public/status/.e2e.tmp /srv/rws/public/status/capture.json
}
rws_compose pause capture
# 12 renames in about 6 s: with the default start limit (5 in 10 s) the path unit failed for good.
for i in $(seq 1 12); do
  put_status "burst-$i"
  sleep 0.5
done
sleep 2
[[ $(systemctl is-active rws-status-copy.path) == active ]] ||
  fail "rws-status-copy.path died in a burst: $(systemctl show -p Result --value rws-status-copy.path)"
put_status burst-after
wait_for "the copy of a write after the burst" 30 grep -q burst-after /srv/rws/public/ops/capture.json
# Unpause first: a paused capture turns unhealthy, and rws-tick rightly restarts it.
rws_compose unpause capture
systemctl stop rws-status-copy.path
"$repo/deploy/bin/rws-tick"
[[ $(systemctl is-active rws-status-copy.path) == active ]] || fail "rws-tick did not re-arm rws-status-copy.path"
proof "12 capture.json renames in about 6 s leave rws-status-copy.path active (its service has no start limit), a later write is still published, and rws-tick re-arms a stopped path unit"
CURL_CA_BUNDLE=/ci/pki/pebble-root.pem RWS_SMOKE_TIMEOUT=150 RWS_SMOKE_INTERVAL=5 smoke $(($(date -u +%s) - 1))
proof "the rws-deploy smoke test passes against the stack (/healthz 200 over real TLS, a capture.json newer than the deploy, and, as the release has an api, /api/v1/health with a JSON status)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep '^rws-'

# ------------------------------------------------------------------ backups
step "restic to MinIO with Object Lock (COMPLIANCE), the VPS key's policy, the drill"
wait_for "minio" 60 curl -fsS --cacert /ci/pki/ca.pem https://minio/minio/health/live
sed 's/RWS_BUCKET/rws-raw/g' "$repo/deploy/host/s3-vps-key-policy.json" >/ci/vps-policy.json
# CI-only administration of the throwaway MinIO (its own TLS, from our CI CA).
mc() {
  docker run --rm --network rws_ci-minio -e MC_CONFIG_DIR=/tmp/mc \
    -e MC_HOST_m=https://ci-root:ci-root-password-not-a-secret@minio \
    -v /ci/vps-policy.json:/policy.json:ro "$MC_IMAGE" --insecure "$@"
}
root_s3() {
  printf 'user = "ci-root:ci-root-password-not-a-secret"\naws-sigv4 = "aws:amz:us-east-1:s3"\n' |
    curl -K - -fsS --cacert /ci/pki/ca.pem "$@"
}
mc mb --with-lock m/rws-raw
lock='<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>'
root_s3 -X PUT -H "Content-MD5: $(printf '%s' "$lock" | openssl dgst -md5 -binary | base64)" \
  -H 'Content-Type: application/xml' --data-raw "$lock" 'https://minio/rws-raw?object-lock'
root_s3 'https://minio/rws-raw?object-lock' | grep -q '<Mode>COMPLIANCE</Mode><Days>30</Days>' || fail "no COMPLIANCE default retention of 30 days"
root_s3 'https://minio/rws-raw?versioning' | grep -q '<Status>Enabled</Status>' || fail "versioning is off"
mc admin user add m rws-vps "$vps_secret"
mc admin policy create m rws-vps /policy.json
mc admin policy attach m rws-vps --user rws-vps
"$repo/deploy/bin/rws-backup" --init
"$repo/deploy/bin/rws-backup"
jq -e '.last_backup != null' /srv/rws/public/ops/ops.json >/dev/null || fail "last_backup not set"
proof "restic 0.19.1 in the backup job read its S3 keys from AWS_SHARED_CREDENTIALS_FILE (/run/secrets/s3_credentials, key rws-vps with deploy/host/s3-vps-key-policy.json) and its password from RESTIC_PASSWORD_FILE, and wrote the raw archive to a bucket with Object Lock COMPLIANCE; ops.json last_backup set"
# The nightly dump of that run (the first run of a release with db always dumps).
dumps=/srv/rws/backup/db
[[ $(stat -c '%a %u %g' "$dumps/rws.dump" "$dumps/globals.sql" | sort -u) == '440 0 61003' ]] ||
  fail "dump files: $(stat -c '%n %a %u %g' "$dumps"/* | tr '\n' ' ')"
[[ $(head -c 5 "$dumps/rws.dump") == PGDMP ]] || fail "rws.dump is not a custom-format dump"
tables=$(rws_compose exec -T db pg_restore -l <"$dumps/rws.dump" | grep -c ' TABLE DATA ' || true)
((tables > 0)) || fail "pg_restore -l lists no table data in rws.dump"
grep -q '^CREATE ROLE rws_api;' "$dumps/globals.sql" || fail "globals.sql lacks the roles"
! grep -q 'SCRAM-SHA-256' "$dumps/globals.sql" || fail "globals.sql carries a password hash"
read_dump() {
  docker run --rm --network none --user 65532:65532 "$@" -v "$dumps:/d:ro" --entrypoint /nodejs/bin/node rws-server:ci \
    -e "require('fs').readFileSync('/d/rws.dump')" 2>/dev/null
}
if read_dump; then fail "uid 65532 without gid 61003 read the dump"; fi
read_dump --group-add 61003 || fail "gid 61003 (the backup job's) cannot read the dump"
snapshot=$(rws_compose run --rm --no-deps -T backup ls latest /data/db)
for f in rws.dump globals.sql; do
  grep -qx "/data/db/$f" <<<"$snapshot" || fail "the latest snapshot has no /data/db/$f"
done
proof "the nightly dump: pg_dump -Fc --no-large-objects and pg_dumpall --globals-only --no-role-passwords as rws_backup (peer, no password) wrote rws.dump (custom format, $tables TABLE DATA entries by pg_restore -l) and globals.sql (the roles, no password hash), root:61003 0440 in root's /srv/rws/backup: uid 65532 cannot read them, the backup job's gid can, and restic's latest snapshot holds /data/db"
drill=$("$repo/deploy/bin/rws-restore-drill" --force | tail -n 1)
[[ $drill == 'restore drill: sampled 100, matched 100' ]] || fail "drill: $drill"
jq -e '.drill.sampled == 100 and .drill.matched == 100' /srv/rws/public/ops/ops.json >/dev/null || fail "ops.json drill"
[[ -z $(find /srv/rws/backup/drill -mindepth 1) ]] || fail "the drill left files behind"
proof "forced restore drill: $drill (sha256 of zstd -dc against the manifest), written to ops.json, scratch emptied"
prune=$(CURL_CA_BUNDLE=/ci/pki/ca.pem "$repo/deploy/tests/object-lock-prune.sh")
echo "$prune"
[[ $(grep -c '^PASS ' <<<"$prune") == 5 ]] || fail "object-lock-prune.sh: not 5 PASS lines"
proof "object-lock-prune.sh with the VPS key: the bucket's default retention is COMPLIANCE >= 30 days and a new version is retained >= 29 days; restic forget --prune removed no object version, a versioned DELETE and a shorter retention were refused (5 PASS)"

# ------------------------------------------------------------------ watchdog
step "rws-tick restores a deleted firewall table (R2-S4); the watchdog: one cycle through DNS and TLS"
resolvers=$(nft list set inet rws resolvers4 | grep -o 'elements = {[^}]*}' || true)
nft delete table inet rws
"$repo/deploy/bin/rws-tick"
nft list table inet rws >/dev/null || fail "rws-tick did not restore table inet rws"
[[ $(nft list set inet rws resolvers4 | grep -o 'elements = {[^}]*}' || true) == "$resolvers" ]] ||
  fail "the restored table lost its resolvers"
jq -e '.disk_pct | type == "number"' /srv/rws/public/ops/ops.json >/dev/null || fail "disk_pct"
rws_compose run --rm --no-deps -T watchdog watchdog --once
proof "rws-tick restored a deleted table inet rws from /etc/rws/nftables.conf with its resolvers (${resolvers:-none}) and wrote disk_pct; watchdog --once (the real role, from the egress network to the public address, TLS verified) found /healthz, capture.json, ops.json, the backup, the certificate and the disk green"
jq . /srv/rws/public/ops/ops.json
[[ $ipv6_result == ok ]] || fail "https over IPv6 from outside failed (diagnostics in the 'From outside' group)"

# ------------------------------------------------------------------ static publishers, owner site, degraded
step "The static publishers (P9a): first cycle, owner isolation, the owner site"
wait_for "publish's first meta.json" 240 test -s /srv/rws/public/www/v1/meta.json
wait_for "publish-owner's first meta.json" 240 test -s /srv/rws/owner/www/v1/meta.json
owner_latest_has_canary() { grep -qE '777777\.(777|75)' /srv/rws/owner/www/v1/latest.json; }
wait_for "the owner canary in the owner latest.json" 240 owner_latest_has_canary
! grep -rqE '777777\.(777|75)' /srv/rws/public/www/v1 || fail "the owner canary is in a public static file"
[[ $(stat -c '%a %u:%g' /srv/rws/public/www/v1/meta.json /srv/rws/owner/www/v1/meta.json | sort -u) == '644 65532:65532' ]] ||
  fail "meta.json modes: $(stat -c '%n %a %u:%g' /srv/rws/public/www/v1/meta.json /srv/rws/owner/www/v1/meta.json | tr '\n' ' ')"
env DOMAIN="$DOMAIN" IP4="$IP4" "$e2e/isolation.sh"
proof "isolation.sh: publish and publish-owner each mount only their own audience's tree, no write crosses the roots, the public listener serves no owner content for SNI owner.$DOMAIN, caddy-owner answers 401 with private no-store and noindex nofollow on every path without credentials and 200 with the owner canary with them; the owner canary is in no public static file"

# P11a (issue #26 C5): the river release the public site serves is the installed fixture, byte for byte, and neither it nor
# stations.json knows an owner station; the owner variant of the reaches file (caddy-owner) is owner-check.mjs's.
pub_rivers=$(outside --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/data/v1/rivers/manifest.json") ||
  fail "the public rivers manifest is not served"
[[ $(jq -r .current.version <<<"$pub_rivers") == "$rivers_ver" ]] || fail "the public rivers manifest is not version $rivers_ver"
outside -o /ci/public-reaches.json --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/data/v1/rivers/reaches-$rivers_ver.json" ||
  fail "the public reaches file is not served"
cmp -s /ci/public-reaches.json "$repo/test/fixtures/reaches-fixture.json" ||
  fail "the public reaches file differs from the installed release: the owner split must never touch the public bytes"
outside -o /ci/public-stations.json --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/data/v1/stations.json" ||
  fail "the public stations.json is not served"
for f in /ci/public-reaches.json /ci/public-stations.json; do
  # The station ids of the owner sources that have station rows (BE-3, LU-2), the owner and the withheld canary.
  ! grep -qE 'be\.spw\.|lu\.age-json\.|777777\.(777|75)|123456\.789' "$f" ||
    fail "an owner station or a canary in the public ${f##*/}"
done
# Positive controls: the files are the real ones (Eijsden is a public station of both).
for f in /ci/public-reaches.json /ci/public-stations.json; do
  grep -q 'nl\.rws\.eijsden\.grens' "$f" || fail "the public ${f##*/} does not hold nl.rws.eijsden.grens"
done
proof "public /data/v1/rivers/reaches-$rivers_ver.json is the installed fixture release byte for byte (cmp), and it and /data/v1/stations.json hold no owner station (be.spw., lu.age-json.) and no owner or withheld canary value (both hold nl.rws.eijsden.grens)"
rws_compose run --rm --no-deps -T watchdog watchdog --once
proof "watchdog --once with the publisher running: /data/v1/meta.json is fresh, so the publisher check is green too"

# ------------------------------------------------------------------ the owner API and the API limits (P9b)
step "The owner API (P9b): api-owner only on owner_edge and owner_db, the hardening flags, its own secret"
# Plan C15: owner_edge is joined by caddy-owner and api-owner alone, so neither the public caddy nor the public api
# can reach the owner API; the overlay repeats the hardening flags of compose.yaml (test/caddy-owner.test.ts).
[[ $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' rws-api-owner-1) == 'rws_owner_db rws_owner_edge ' ]] ||
  fail "api-owner networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' rws-api-owner-1)"
[[ $(docker inspect -f '{{json .HostConfig.PortBindings}}' rws-api-owner-1) =~ ^(\{\}|null)$ ]] || fail "api-owner publishes a port"
[[ $(docker network inspect -f '{{.Internal}}' rws_owner_edge) == true ]] || fail "network rws_owner_edge is not internal"
members=$(docker network inspect -f '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' rws_owner_edge | grep . | sort | tr '\n' ' ')
[[ $members == 'rws-api-owner-1 rws-caddy-owner-1 ' ]] || fail "rws_owner_edge members: $members"
# Review F1: the owner API reaches the database over owner_db, which only it and db join (never the shared rws_db).
[[ $(docker network inspect -f '{{.Internal}}' rws_owner_db) == true ]] || fail "network rws_owner_db is not internal"
members=$(docker network inspect -f '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' rws_owner_db | grep . | sort | tr '\n' ' ')
[[ $members == 'rws-api-owner-1 rws-db-1 ' ]] || fail "rws_owner_db members: $members"
st=$(docker exec rws-api-owner-1 /nodejs/bin/node -e "$read_status")
grep -qP '^Uid:\t65532\t' <<<"$st" || fail "api-owner does not run as uid 65532"
grep -qP '^CapEff:\t0000000000000000$' <<<"$st" || fail "api-owner has an effective capability"
grep -qP '^NoNewPrivs:\t1$' <<<"$st" || fail "api-owner may gain privileges"
[[ $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}' rws-api-owner-1) == 'true [ALL] 268435456 64 500000000' ]] ||
  fail "api-owner: read-only root, cap_drop ALL, 256m, 64 pids, 0.5 cpus"
[[ $(docker exec rws-api-owner-1 /nodejs/bin/node -e "$list_secrets") == db_rws_owner_api ]] || fail "api-owner sees other secrets"
if docker exec rws-api-1 /nodejs/bin/node -e 'const s = require("net").connect({ host: "api-owner", port: 8080, timeout: 3000 });
s.on("connect", () => process.exit(1)); s.on("timeout", () => process.exit(0)); s.on("error", () => process.exit(0));'; then :; else
  fail "the public api reached api-owner"
fi
if docker exec rws-caddy-1 wget -q -T 3 -O /dev/null http://api-owner:8080/healthz 2>/dev/null; then
  fail "the public caddy reached api-owner"
fi
docker exec rws-caddy-owner-1 wget -q -T 5 -O /dev/null http://api-owner:8080/healthz || fail "caddy-owner cannot reach api-owner"
proof "api-owner (the overlay's service) is on rws_owner_edge and rws_owner_db (both internal) only, publishes no port, runs as uid 65532 with CapEff 0, NoNewPrivs 1, a read-only root, 256m, 64 pids, 0.5 cpus and only db_rws_owner_api; rws_owner_edge holds exactly api-owner and caddy-owner, rws_owner_db exactly api-owner and db; the public api and the public caddy cannot reach it, caddy-owner can"

step "API limits (P9b): the API is rate limited per client, static files never are"
# 203.0.114.11 is a public-looking source address in the outside namespace: the API keys it as itself (a private
# peer such as the namespace's own 10.99.0.2 is the gateway key, a 100x bucket). One config file of 300 URLs, 30 in parallel.
burst() { # <path> <out file>: 300 GETs from 203.0.114.11 in a burst; one line "<status> <retry-after>" each
  local cfg=/ci/burst.cfg i
  : >"$cfg"
  # One `output` per URL: a single -o applies to the first URL only, and the other bodies would go to stdout.
  for i in $(seq 300); do printf 'url = "https://%s%s"\noutput = "/dev/null"\n' "$DOMAIN" "$1" >>"$cfg"; done
  ip netns exec ext curl -sS --parallel --parallel-max 30 --max-time 60 --cacert /ci/pki/pebble-root.pem \
    --interface "${CLIENT_IPS[0]}" --resolve "$DOMAIN:443:$IP4" -w '%{http_code} %header{retry-after}\n' -K "$cfg" >"$2"
}
burst /api/v1/meta /ci/burst-api.out
[[ $(wc -l </ci/burst-api.out) == 300 ]] || fail "the API burst answered $(wc -l </ci/burst-api.out) of 300 requests"
limited=$(grep -c '^429 ' /ci/burst-api.out || true)
ok_api=$(grep -c '^200 ' /ci/burst-api.out || true)
((limited >= 1)) || fail "300 GETs of /api/v1/meta in a burst from one client were never limited (general bucket 30/s, burst 120)"
((limited + ok_api == 300)) || fail "the API burst answered something but 200 and 429: $(cut -d' ' -f1 /ci/burst-api.out | sort | uniq -c | tr '\n' ' ')"
grep -qE '^429 [1-9][0-9]*$' /ci/burst-api.out || fail "a 429 of the API burst has no whole-seconds Retry-After"
! grep -E '^429 ' /ci/burst-api.out | grep -qvE '^429 [1-9][0-9]*$' || fail "a 429 of the API burst has a bad Retry-After"
# At once, from the same client, with its API bucket empty: static files answer every request.
burst /data/v1/meta.json /ci/burst-static.out
[[ $(wc -l </ci/burst-static.out) == 300 ]] || fail "the static burst answered $(wc -l </ci/burst-static.out) of 300 requests"
[[ $(grep -c '^200 $' /ci/burst-static.out || true) == 300 ]] ||
  fail "static files were limited or refused: $(cut -d' ' -f1 /ci/burst-static.out | sort | uniq -c | tr '\n' ' ')"
proof "from one client (203.0.114.11, in the outside namespace), 300 GETs of /api/v1/meta in a burst: $ok_api answered 200 and $limited were 429 with a whole-seconds Retry-After (general bucket 30/s, burst 120); at once after, 300 GETs of /data/v1/meta.json: all 300 answered 200, no 429 and no Retry-After (static files are served by Caddy and never meet the limiter)"

step "The client address behind Docker (P9b, C7): the masked access log shows the runner, never a bridge gateway"
# Requests from three sources, each to its own marker path (a path that is no page answers the 404 shell with status 404,
# which `outside` (curl -f) reports as a failure: the `|| true` is for that, and a request that never reached Caddy is
# caught below as a missing log line); Caddy's log masks addresses to /24 and /48, which still tells a client from a
# bridge gateway.
c7_expect=()
outside -o /dev/null --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/c7-probe-ns4" || true
c7_expect+=("/c7-probe-ns4 10.99.0.0")
outside -o /dev/null --interface "${CLIENT_IPS[1]}" --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/c7-probe-pub4" || true
c7_expect+=("/c7-probe-pub4 203.0.114.0")
# From the host itself (informational, not asserted: a local source is masqueraded to the gateway by Docker, which a
# visitor never is; it shows what a host-side client such as Playwright or k6 on the host would be to the limiter).
curl -fsS -o /dev/null --cacert /ci/pki/pebble-root.pem --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/c7-probe-host" || true
if [[ $ipv6_result == ok ]]; then
  outside -o /dev/null --resolve "$DOMAIN:443:[$IP6]" "https://$DOMAIN/c7-probe-ns6" || true
  c7_expect+=("/c7-probe-ns6 fd99::")
fi
# From a container on a Docker bridge (informational: its peer is whatever Docker shows Caddy; nothing fails here).
docker run --rm --network rws_public -e "C7_IP=$IP4" -e "C7_DOMAIN=$DOMAIN" -v /ci/pki/pebble-root.pem:/pebble-root.pem:ro \
  --entrypoint /nodejs/bin/node rws-server:ci -e 'require("https").get({ host: process.env.C7_IP, servername: process.env.C7_DOMAIN,
  headers: { host: process.env.C7_DOMAIN }, path: "/c7-probe-ctr", ca: require("fs").readFileSync("/pebble-root.pem"), timeout: 10000 },
  (r) => { r.resume(); r.on("end", () => console.log("container probe: HTTP " + r.statusCode)); }).on("error", (e) => console.log("container probe: " + e.code));' ||
  true
sleep 2
docker exec rws-caddy-1 cat /data/access/access.log >/ci/access-c7.log
seen=$(jq -r 'select((.request.uri // "") | startswith("/c7-probe-")) | "\(.request.uri) \(.request.remote_ip) \(.request.client_ip)"' /ci/access-c7.log | sort -u)
echo "masked peers Caddy logged (marker path, remote_ip, client_ip):"
echo "$seen"
bridge_re='^(172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|fd7a:7773:|fe80:|127\.|::1)'
for e in "${c7_expect[@]}"; do
  path=${e% *} want=${e#* }
  got=$(grep -F "$path " <<<"$seen" | head -n 1)
  [[ -n $got ]] || fail "no access log line for $path"
  read -r _ remote client <<<"$got"
  if [[ $remote =~ $bridge_re || $client =~ $bridge_re ]]; then
    fail "C7: public traffic from the runner ($path) reached Caddy as a Docker bridge gateway ($remote / $client masked): the per-client limiter would key every client as unknown-gw (see the lines above)"
  fi
  [[ $remote == "$want" && $client == "$want" ]] || fail "C7: $path was logged as $remote / $client, expected the runner's own prefix $want"
done
proof "Caddy's masked access log (IPv4 /24, IPv6 /48) shows the runner's own prefixes, never a Docker bridge gateway: $(for e in "${c7_expect[@]}"; do echo -n "${e% *}=${e#* } "; done); the host itself was logged as: $(grep -F '/c7-probe-host ' <<<"$seen" | cut -d' ' -f2 | head -n 1 || true), a container on rws_public as: $(grep -F '/c7-probe-ctr ' <<<"$seen" | cut -d' ' -f2 | head -n 1 || true)"

step "The owner canary sweep (P9b): every public output, every encoding; the owner outputs; the logs"
docker exec rws-caddy-owner-1 cat /data/caddy/pki/authorities/local/root.crt >/ci/owner-root.crt
# P12a: caddy-owner is no longer on rws_edge (the public caddy's network) but on rws_owner_public. The sweep needs the
# public caddy (rws_edge) and caddy-owner (rws_owner_public), so its container joins both: created on rws_edge,
# connected to rws_owner_public, then started (docker run takes one --network). Arguments as for `docker run`.
owner_net_run() {
  local id rc=0
  id=$(docker create --network rws_edge "$@") || return 1
  docker network connect rws_owner_public "$id" || {
    docker rm -f "$id" >/dev/null
    return 1
  }
  docker start -a "$id" || rc=$?
  docker rm -f "$id" >/dev/null
  return "$rc"
}
sweep_run=(owner_net_run -e RWS_DOMAIN="$DOMAIN" -e OWNER_PW -e PUBLIC_CA=/pebble-root.pem -e OWNER_CA=/owner-root.crt
  -v "$e2e/api-sweep.mjs:/sweep.mjs:ro" -v /ci/pki/pebble-root.pem:/pebble-root.pem:ro -v /ci/owner-root.crt:/owner-root.crt:ro)
"${sweep_run[@]}" --entrypoint /nodejs/bin/node rws-server:ci /sweep.mjs | tee /ci/api-sweep.out ||
  fail "api-sweep.mjs exited non-zero (its FAIL lines are above)"
[[ $(grep -c '^FAIL' /ci/api-sweep.out || true) == 0 ]] || fail "api-sweep.mjs"
grep -q '^PASS api-sweep$' /ci/api-sweep.out || fail "api-sweep.mjs did not finish"
# The logs of the run: api, publish and caddy (the compose logs) and the public access log, for the same terms.
install -d -m 0755 /ci/logs
for s in api publish caddy; do rws_compose logs --no-color --no-log-prefix "$s" >"/ci/logs/$s.log" 2>&1; done
docker exec rws-caddy-1 cat /data/access/access.log >/ci/logs/access.log
[[ -s /ci/logs/access.log && -s /ci/logs/api.log && -s /ci/logs/publish.log && -s /ci/logs/caddy.log ]] || fail "an empty log in /ci/logs"
"${sweep_run[@]}" -v /ci/logs:/logs:ro --entrypoint /nodejs/bin/node rws-server:ci /sweep.mjs --logs /logs/api.log /logs/publish.log /logs/caddy.log /logs/access.log |
  tee /ci/api-sweep-logs.out || fail "the owner canary is in a log of the run (path and term index above)"
proof "api-sweep.mjs: $(grep '^public:' /ci/api-sweep.out); $(grep '^owner:' /ci/api-sweep.out); the owner canary's value (both renderings), station, source id, key, attribution text, private_basis clause and name (read from /app/registry at run time) are in no public byte, in identity, gzip or zstd, attribution arrays included, and the owner API shows the canary in /snapshot, /series/{id} and /series/{id}/forecast with its source in the attribution; $(grep '^logs:' /ci/api-sweep-logs.out)"

step "Owner frames (P11b, issue #26 OV): synthetic SPW hours, and none of them in a public frames output"
# The compose archive holds no BE-3 observation, so the owner playback would play nothing: two SPW gauges get 31 made-up
# hourly values (321, the 30 hours before the current one and the current one), with their hourly rollup, which the
# frames read. batch 0 marks them. Never a provider value (invariant 9, 11).
psql_su "select ensure_partitions(now() - interval '3 days', now() + interval '1 day')" >/dev/null
spw_obs=$(psql_su "with ins as (insert into obs (series_id, ts, value, qc, batch_id)
  select s.id, g, 321, 1, 0 from series s,
    lateral generate_series(date_trunc('hour', now(), 'UTC') - interval '30 hours', date_trunc('hour', now(), 'UTC'), interval '1 hour') g
  where s.station_id in ('be.spw.5447', 'be.spw.5451') and s.role = 'primary' on conflict do nothing returning 1)
  select count(*) from ins")
[[ $spw_obs == 62 ]] || fail "the synthetic SPW hours: $spw_obs rows, expected 62"
psql_su "insert into obs_1h (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
  select series_id, ts, value, value, value, value, 1, qc from obs where batch_id = 0 on conflict do nothing" >/dev/null
"${sweep_run[@]}" -v "$e2e/frames-check.mjs:/frames-check.mjs:ro" --entrypoint /nodejs/bin/node rws-server:ci /frames-check.mjs |
  tee /ci/frames-check.out || fail "frames-check.mjs exited non-zero (its FAIL lines are above)"
[[ $(grep -c '^FAIL' /ci/frames-check.out || true) == 0 ]] || fail "frames-check.mjs"
grep -q '^PASS frames-check$' /ci/frames-check.out || fail "frames-check.mjs did not finish"
proof "frames-check.mjs: $(grep '^frames:' /ci/frames-check.out | tail -n 1); the owner /api/v1/frames answer names the SPW series, and no SPW series id and no owner canary rendering is in any public frames output (recent.json, every day file, /api/v1/frames), in identity, gzip or zstd"

step "Degraded: the api stopped, a future t still shows the map and the banner (P9a)"
rws_compose stop api
# A past t with the api down (review CR-6): Caddy's dead-upstream stand-in answers /api/v1/snapshot with the newest
# snapshot file itself, 200, X-Degraded: 1 and no-store; the web shows it under its own t.
past=$(date -u -d '-2 hours' +%Y-%m-%dT%H:00Z)
outside -D /ci/standin.head -o /ci/standin.body --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/api/v1/snapshot?t=$past" ||
  fail "the snapshot stand-in did not answer 200 with the api stopped"
standin=$(tr -d '\r' </ci/standin.head)
grep -qix 'x-degraded: 1' <<<"$standin" || fail "the snapshot stand-in has no X-Degraded: 1"
grep -qix 'cache-control: no-store' <<<"$standin" || fail "the snapshot stand-in is not no-store"
grep -q '"seriesHash"' /ci/standin.body || fail "the snapshot stand-in is not latest.json"
proof "with the api stopped, /api/v1/snapshot?t=$past answers 200 with latest.json, X-Degraded: 1 and Cache-Control: no-store (Caddy's dead-upstream stand-in)"
degraded_rc=0
docker run --rm --init --network host --ipc=host --add-host "$DOMAIN:$IP4" \
  -e CI=true -e E2E_COMPOSE=1 -e "E2E_COMPOSE_URL=https://$DOMAIN" \
  -v "$repo:/work" -w /work/apps/web \
  "$PLAYWRIGHT_IMAGE" xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24' \
  node_modules/.bin/playwright test -c e2e/playwright.config.ts degraded.spec.ts || degraded_rc=$?
rws_compose start api
wait_for "api healthy again" 240 healthy api
((degraded_rc == 0)) || fail "degraded.spec.ts failed with the api stopped (exit $degraded_rc)"
proof "with the api container stopped, Playwright in the pinned image (host network, $DOMAIN -> $IP4) opened /?t=<now + 1 h>: the map canvas drew and the degraded banner showed (degraded.spec.ts); the api started again and is healthy"

step "Owner smoke (P10a): the production build behind caddy-owner, one browser"
# P12a: caddy-owner is published on the WireGuard address only (10.66.0.1:443, the veth stand-in of wg-veth.sh); the
# browser stays on the host network and resolves owner.$DOMAIN to 10.66.0.1, the way the owner's device does through
# its hosts file, and uses the standard port. The password is passed
# by name; the spec (owner-smoke.spec.ts, selected by E2E_OWNER_SMOKE=1) checks runtime-config and the banner.
owner_ip=10.66.0.1
E2E_OWNER_PW=$OWNER_PW docker run --rm --init --network host --ipc=host --add-host "owner.$DOMAIN:$owner_ip" --add-host "$DOMAIN:$IP4" \
  -e CI=true -e E2E_COMPOSE=1 -e E2E_OWNER_SMOKE=1 -e "E2E_OWNER_URL=https://owner.$DOMAIN" -e "E2E_COMPOSE_URL=https://$DOMAIN" -e E2E_OWNER_PW \
  -v "$repo:/work" -w /work/apps/web \
  "$PLAYWRIGHT_IMAGE" xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24' \
  node_modules/.bin/playwright test -c e2e/playwright.config.ts --project=chromium ||
  fail "the owner smoke (owner-smoke.spec.ts) failed"
proof "owner smoke: Playwright (Chromium, host network, https://owner.$DOMAIN, hosts entry -> $owner_ip: the WireGuard address, port 443) signed in to caddy-owner on the production build: /runtime-config.json says owner and the owner banner shows (owner-smoke.spec.ts)"
