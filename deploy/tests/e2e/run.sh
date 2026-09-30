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
#     publishes no port and sits only on the internal db network; pg_hba lets
#     rws_api in with its password and refuses a wrong one and the superuser
#     over TCP; rws_api can neither read a base table nor insert; load turns
#     the DE-1 fixture archive into observations; /api/v1/health and
#     /health/sources answer through Caddy over TLS, any other /api/ path is a
#     404 and an unknown parameter a 400; load and api have no route out; db,
#     load and api keep the hardening flags; each sees only its own secret;
#     the nightly dump is a valid custom-format dump readable only by root and
#     gid 61003, and restic backs it up.
# The stack keeps running afterwards for scripts/verify-prod.ts.
# Usage: sudo deploy/tests/e2e/run.sh
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
e2e=$repo/deploy/tests/e2e
# shellcheck source=deploy/bin/rws-lib.sh
. "$repo/deploy/bin/rws-lib.sh"
umask 022

readonly DOMAIN=rivierstanden.example IP4=203.0.114.10 IP6=2a0a:e5c0:ffff::10
readonly DOCKER_APT=5:29.8.1-1~ubuntu.24.04~noble CONTAINERD_APT=2.3.5-1~ubuntu.24.04~noble
readonly COMPOSE_APT=5.5.1-1~ubuntu.24.04~noble
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
    for s in caddy capture watchdog db load api pebble minio; do docker logs --tail 60 "rws-$s-1" 2>&1 | sed "s/^/$s| /" || true; done
    systemctl status --no-pager rws-status-copy.path rws-status-copy.service 2>&1 | tail -n 20 || true
    nft list ruleset 2>/dev/null | head -n 200 || true
    echo "::endgroup::"
  fi
  printf '\n%s\n' "== e2e evidence (${#proofs[@]} proofs, exit $rc) =="
  printf -- '- %s\n' "${proofs[@]}"
}
trap on_exit EXIT
((EUID == 0)) || fail "run as root"

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
cp "$e2e/Caddyfile.ci" "$e2e/pebble.json" /ci/
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=rws-ci-ca -keyout /ci/pki/ca.key -out /ci/pki/ca.pem \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign 2>/dev/null
for name in pebble minio; do
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$name" -keyout "/ci/pki/$name.key" -out "/ci/pki/$name.csr" 2>/dev/null
  openssl x509 -req -in "/ci/pki/$name.csr" -CA /ci/pki/ca.pem -CAkey /ci/pki/ca.key -CAcreateserial -days 2 \
    -extfile <(printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$name") -out "/ci/pki/$name.crt" 2>/dev/null
done
cp /ci/pki/minio.crt /ci/pki/minio/public.crt
cp /ci/pki/minio.key /ci/pki/minio/private.key
chmod -R a+rX /ci
chmod 0644 /ci/pki/*.key /ci/pki/minio/private.key

# ------------------------------------------------------------------ host layout
step "Host layout, groups and secrets as bootstrap.sh makes them"
for g in rws-hc:61001 rws-rwskey:61002 rws-backup:61003 rws-dbpostgres:61004 rws-dbmigrator:61005 rws-dbload:61006 \
  rws-dbpublish:61007 rws-dbapi:61008 rws-dbownerapi:61009; do
  getent group "${g%%:*}" >/dev/null || groupadd --system --gid "${g#*:}" "${g%%:*}"
done
# The runner's own disk is often over 75% full: a tmpfs keeps the watchdog's disk check about our layout.
install -d -m 0755 /srv/rws
mountpoint -q /srv/rws || mount -t tmpfs -o size=2g,mode=0755 tmpfs /srv/rws
install -d -m 0755 /srv/rws/public /srv/rws/public/ops /srv/rws/tiles /etc/rws
install -d -m 0700 /etc/rws/secrets "$RWS_STATE_DIR" "$RWS_STATE_DIR/releases"
install -d -m 0750 -o 65532 -g 65532 /srv/rws/raw /srv/rws/owner /srv/rws/owner/status
install -d -m 0755 -o 65532 -g 65532 /srv/rws/public/status
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
put_secret hc_ping_key 61001 ''
put_secret rws_x_api_key 61002 "$(cat /proc/sys/kernel/random/uuid)\n"
put_secret restic_password 61003 "ci-$(openssl rand -hex 16)\n"
put_secret s3_credentials 61003 "[default]\naws_access_key_id = rws-vps\naws_secret_access_key = $vps_secret\n"
# The database passwords: 64 hex characters, as bootstrap.sh generates them.
gid=61004
for name in db_postgres db_rws_migrator db_rws_load db_rws_publish db_rws_api db_rws_owner_api; do
  put_secret "$name" "$gid" "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')\n"
  gid=$((gid + 1))
done
cat >/etc/rws/rws.env <<EOF
RWS_DOMAIN=$DOMAIN
RWS_CONTACT_EMAIL=contact@$DOMAIN
RWS_PUBLIC_IPV4=$IP4
RWS_PUBLIC_IPV6=$IP6
RWS_RESTIC_REPOSITORY=s3:https://minio/rws-raw/restic
RWS_S3_REGION=us-east-1
RWS_BACKUP=on
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
manifest_dir=/srv/rws/raw/_manifest
mkdir -p "$manifest_dir"
for i in $(seq 1 120); do
  body="synthetic e2e object $i $RANDOM$RANDOM"
  sha=$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)
  key=$(printf 'raw/NL-1/nl-1-obs-key/2026/09/01/%06dZ-%s.zst' "$i" "${sha:0:16}")
  mkdir -p "$(dirname "/srv/rws/raw/${key#raw/}")"
  printf '%s' "$body" | zstd -q -c >"/srv/rws/raw/${key#raw/}"
  jq -cn --arg key "$key" --arg sha "$sha" \
    '{v: 1, source: "NL-1", spec: "nl-1-obs-key", key: $key, sha256: $sha, fetched_at: {start: "2026-09-01T12:00:00.000Z", end: "2026-09-01T12:00:01.000Z"}}'
done >"$manifest_dir/2026-09-01.jsonl"
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
sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1

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
proof "docker compose config -q: deploy/compose.yaml valid with the host settings and image digests"
# --profile jobs: `config` leaves out services of inactive profiles (the backup job) otherwise.
docker compose -p rws -f "$repo/deploy/compose.yaml" -f "$e2e/compose.ci.yaml" \
  --env-file /etc/rws/rws.env --env-file "$REL/images.env" --profile jobs config >"$REL/compose.yaml"
grep -q '^  backup:' "$REL/compose.yaml" || fail "the merged compose file has no backup service"
grep -q '^  migrate:' "$REL/compose.yaml" || fail "the merged compose file has no migrate job"
set_active prod-ci
# The production path (deploy_release): db healthy, roles and passwords through
# its socket (db_prepare), the migrate job; then up. Twice: a redeploy changes nothing.
db_up || fail "db_up (db start, db_prepare or migrate) failed"
db_up || fail "a second db_up failed"
psql_su() { rws_compose exec -T db psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d rws -c "$1"; }
applied=$(psql_su 'select count(*) from schema_migrations')
files=$(find "$repo/db/migrations" -maxdepth 1 -name '*.sql' | wc -l)
[[ $applied == "$files" ]] || fail "schema_migrations has $applied rows, db/migrations $files files"
owner=$(psql_su "select string_agg(distinct tableowner, ',') from pg_tables where schemaname = 'public'")
[[ $owner == rws_owner ]] || fail "public tables owned by $owner"
proof "db_up of rws-lib.sh ran twice: db healthy, deploy/postgres/roles.sql and the five passwords over the local socket, the migrate job (dbmate 2.36.0 in the server image, as rws_migrator): $applied of $files migrations applied, every public table owned by rws_owner"
rws_compose up -d --remove-orphans --quiet-pull
healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$1-1") == healthy ]]; }
for s in caddy capture watchdog db load api; do wait_for "$s healthy" 240 healthy "$s"; done
proof "caddy, capture, watchdog, db, load and api healthy; the node healthchecks run in distroless (no shell): $(docker inspect -f '{{json .Config.Healthcheck.Test}}' rws-capture-1)"
docker ps -a --filter label=com.docker.compose.project=rws --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
for s in caddy capture watchdog db load api; do
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
outside() { ip netns exec ext curl -fsS --max-time 10 --cacert /ci/pki/pebble-root.pem "$@"; }
wait_for "the ACME certificate" 240 outside --resolve "$DOMAIN:443:$IP4" "https://$DOMAIN/healthz"
issuer=$(ip netns exec ext openssl s_client -connect "$IP4:443" -servername "$DOMAIN" </dev/null 2>/dev/null |
  openssl x509 -noout -issuer 2>/dev/null)
proof "caddy runs as uid 65533 with CapEff=CapPrm=0 (cap_drop ALL, nothing added) and still binds 80/443; it obtained a certificate from Pebble over ACME HTTP-01 through the published port ($issuer)"

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
[[ $nets == 'rws_db ' ]] || fail "db networks: $nets"
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
proof "db publishes no port (PortBindings empty) and sits only on rws_db (internal); from the api container: rws_api logs in with its secret, a wrong password is refused (28P01), postgres over TCP is rejected by pg_hba (28000); rws_api cannot read the base table obs (42501), its session is read-only (25006) and even a read-write transaction cannot insert (42501)"

step "load turns the DE-1 fixture archive into observations; the api answers through Caddy"
obs_loaded() { [[ $(psql_su 'select count(*) from obs') =~ ^[1-9][0-9]*$ ]]; }
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
[[ $(api_code /api/v1/x) == 404 && $(api_code /api/v1/health/x) == 404 && $(api_code /API/v1/health) == 404 ]] ||
  fail "a non-health /api/ path is not a 404"
[[ $(api_code '/api/v1/health?rws-e2e-unknown=1') == 400 ]] || fail "an unknown parameter is not a 400"
headers=$(ip netns exec ext curl -sS -D - -o /dev/null --max-time 10 --cacert /ci/pki/pebble-root.pem \
  --resolve "$DOMAIN:443:$IP4" "$(api_url /api/v1/health)" | tr -d '\r')
grep -qi '^content-security-policy: default-src' <<<"$headers" || fail "the api response lacks the site headers"
! grep -qiE '^(server|via|access-control-[a-z-]+):' <<<"$headers" || fail "the api response names its software or sends CORS"
proof "load wrote $(psql_su 'select count(*) from obs') observations from the fixture archive; over TLS through Caddy /api/v1/health answers $(jq -c '{status}' <<<"$health") and /api/v1/health/sources lists DE-1, with the site headers and no Server, Via or CORS header; /api/v1/x, /api/v1/health/x and /API/v1/health are 404s from Caddy, an unknown parameter a 400"

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
