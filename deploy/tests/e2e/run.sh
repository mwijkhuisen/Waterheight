#!/usr/bin/env bash
# End-to-end proof of the P1b platform on a GitHub ubuntu-24.04 runner (issue
# #16: the [U] items of the P1b PR). As root it installs Docker 29.8.1 and
# Compose 5.5.1 from Docker's repository, builds the three images, loads the
# real deploy/host/nftables.conf, starts the real deploy/compose.yaml with the
# CI overlay (Pebble for ACME, MinIO with Object Lock, capture cut off from the
# internet) and proves, printing one PROOF line each:
#   - Docker-published ports cannot bypass the firewall (an "outside" network
#     namespace reaches 80/443 but not another published port), and container
#     egress is TCP 443 plus DNS to the host's resolvers only;
#   - Caddy runs as uid 65533 with no capability, binds 80/443 and gets an
#     ACME certificate through HTTP-01 on the published port;
#   - file secrets keep their host owner, so only the service with the gid
#     can read them;
#   - capture in distroless is healthy, writes the contract files with the
#     contract modes, and generated_at advances; the rws-deploy smoke test passes;
#   - restic reads its keys from AWS_SHARED_CREDENTIALS_FILE and writes to an
#     Object Lock bucket; the restore drill matches 100 of 100; the VPS key
#     cannot remove a version (object-lock-prune.sh);
#   - the watchdog's probe through DNS and TLS passes.
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
    for s in caddy capture watchdog pebble minio; do docker logs --tail 60 "rws-$s-1" 2>&1 | sed "s/^/$s| /" || true; done
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
for g in rws-hc:61001 rws-rwskey:61002 rws-backup:61003; do
  getent group "${g%%:*}" >/dev/null || groupadd --system --gid "${g#*:}" "${g%%:*}"
done
# The runner's own disk is often over 75% full: a tmpfs keeps the watchdog's disk check about our layout.
install -d -m 0755 /srv/rws
mountpoint -q /srv/rws || mount -t tmpfs -o size=2g,mode=0755 tmpfs /srv/rws
install -d -m 0755 /srv/rws/public /srv/rws/public/ops /srv/rws/tiles /etc/rws
install -d -m 0700 /etc/rws/secrets "$RWS_STATE_DIR" "$RWS_STATE_DIR/releases"
install -d -m 0750 -o 65532 -g 65532 /srv/rws/raw /srv/rws/owner /srv/rws/owner/status
install -d -m 0755 -o 65532 -g 65532 /srv/rws/public/status
install -d -m 0700 -o 65532 -g 65532 /srv/rws/backup /srv/rws/backup/cache /srv/rws/backup/drill
put_secret() {
  install -m 0440 -o 0 -g "$2" /dev/null "/etc/rws/secrets/$1"
  printf '%b' "$3" >"/etc/rws/secrets/$1"
}
vps_secret=$(openssl rand -hex 20)
put_secret hc_ping_key 61001 ''
put_secret rws_x_api_key 61002 "$(cat /proc/sys/kernel/random/uuid)\n"
put_secret restic_password 61003 "ci-$(openssl rand -hex 16)\n"
put_secret s3_credentials 61003 "[default]\naws_access_key_id = rws-vps\naws_secret_access_key = $vps_secret\n"
cat >/etc/rws/rws.env <<EOF
RWS_DOMAIN=$DOMAIN
RWS_CONTACT_EMAIL=contact@$DOMAIN
RWS_PUBLIC_IPV4=$IP4
RWS_PUBLIC_IPV6=$IP6
RWS_RESTIC_REPOSITORY=s3:https://minio:9000/rws-raw/restic
RWS_S3_REGION=us-east-1
RWS_BACKUP=on
EOF
grep -q ' minio$' /etc/hosts || echo '172.30.99.10 minio' >>/etc/hosts
load_env
ops_update '.'
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
"$repo/deploy/bin/rws-resolvers"
proof "nft -c and a double load of deploy/host/nftables.conf succeed (idempotent); rws-resolvers filled the DNS allowlist: $(nft list set inet rws resolvers4 | grep -o 'elements = {[^}]*}' || echo none)"

# ------------------------------------------------------------------ release and stack
step "A release directory as rws-deploy stages it, then compose up"
mkdir -p "$REL"
printf 'RWS_SERVER_IMAGE=rws-server:ci\nRWS_WEB_IMAGE=rws-web:ci\nRWS_BACKUP_IMAGE=rws-backup:ci\n' >"$REL/images.env"
docker compose -p rws -f "$repo/deploy/compose.yaml" --env-file /etc/rws/rws.env --env-file "$REL/images.env" config -q
proof "docker compose config -q: deploy/compose.yaml valid with the host settings and image digests"
docker compose -p rws -f "$repo/deploy/compose.yaml" -f "$e2e/compose.ci.yaml" \
  --env-file /etc/rws/rws.env --env-file "$REL/images.env" config >"$REL/compose.yaml"
set_active prod-ci
rws_compose up -d --remove-orphans --quiet-pull
healthy() { [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$1-1") == healthy ]]; }
for s in caddy capture watchdog; do wait_for "$s healthy" 240 healthy "$s"; done
proof "caddy, capture and watchdog healthy; the capture and watchdog healthchecks run node in distroless (no shell): $(docker inspect -f '{{json .Config.Healthcheck.Test}}' rws-capture-1)"
docker ps -a --filter label=com.docker.compose.project=rws --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
for s in caddy capture watchdog; do
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
probe_on() {
  local net=$1
  shift
  docker run --rm --network "$net" --entrypoint timeout rws-web:ci 15 "$@"
}
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
CURL_CA_BUNDLE=/ci/pki/pebble-root.pem RWS_SMOKE_TIMEOUT=150 RWS_SMOKE_INTERVAL=5 smoke $(($(date -u +%s) - 1))
proof "the rws-deploy smoke test passes against the stack (/healthz 200 over real TLS, a capture.json newer than the deploy)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep '^rws-'

# ------------------------------------------------------------------ backups
step "restic to MinIO with Object Lock (COMPLIANCE), the VPS key's policy, the drill"
wait_for "minio" 60 curl -fsS --cacert /ci/pki/ca.pem https://minio:9000/minio/health/live
sed 's/RWS_BUCKET/rws-raw/g' "$repo/deploy/host/s3-vps-key-policy.json" >/ci/vps-policy.json
# CI-only administration of the throwaway MinIO (its own TLS, from our CI CA).
mc() {
  docker run --rm --network rws_ci-minio -e MC_CONFIG_DIR=/tmp/mc \
    -e MC_HOST_m=https://ci-root:ci-root-password-not-a-secret@minio:9000 \
    -v /ci/vps-policy.json:/policy.json:ro "$MC_IMAGE" --insecure "$@"
}
root_s3() {
  printf 'user = "ci-root:ci-root-password-not-a-secret"\naws-sigv4 = "aws:amz:us-east-1:s3"\n' |
    curl -K - -fsS --cacert /ci/pki/ca.pem "$@"
}
mc mb --with-lock m/rws-raw
lock='<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>1</Days></DefaultRetention></Rule></ObjectLockConfiguration>'
root_s3 -X PUT -H "Content-MD5: $(printf '%s' "$lock" | openssl dgst -md5 -binary | base64)" \
  -H 'Content-Type: application/xml' --data-raw "$lock" 'https://minio:9000/rws-raw?object-lock'
root_s3 'https://minio:9000/rws-raw?object-lock' | grep -q '<Mode>COMPLIANCE</Mode>' || fail "no COMPLIANCE default retention"
root_s3 'https://minio:9000/rws-raw?versioning' | grep -q '<Status>Enabled</Status>' || fail "versioning is off"
mc admin user add m rws-vps "$vps_secret"
mc admin policy create m rws-vps /policy.json
mc admin policy attach m rws-vps --user rws-vps
"$repo/deploy/bin/rws-backup" --init
"$repo/deploy/bin/rws-backup"
jq -e '.last_backup != null' /srv/rws/public/ops/ops.json >/dev/null || fail "last_backup not set"
proof "restic 0.19.1 in the backup job read its S3 keys from AWS_SHARED_CREDENTIALS_FILE (/run/secrets/s3_credentials, key rws-vps with deploy/host/s3-vps-key-policy.json) and its password from RESTIC_PASSWORD_FILE, and wrote the raw archive to a bucket with Object Lock COMPLIANCE; ops.json last_backup set"
drill=$("$repo/deploy/bin/rws-restore-drill" --force | tail -n 1)
[[ $drill == 'restore drill: sampled 100, matched 100' ]] || fail "drill: $drill"
jq -e '.drill.sampled == 100 and .drill.matched == 100' /srv/rws/public/ops/ops.json >/dev/null || fail "ops.json drill"
[[ -z $(find /srv/rws/backup/drill -mindepth 1) ]] || fail "the drill left files behind"
proof "forced restore drill: $drill (sha256 of zstd -dc against the manifest), written to ops.json, scratch emptied"
CURL_CA_BUNDLE=/ci/pki/ca.pem "$repo/deploy/tests/object-lock-prune.sh"
proof "object-lock-prune.sh with the VPS key: restic forget --prune removed no object version, a versioned DELETE and a shorter retention were refused"

# ------------------------------------------------------------------ watchdog
step "Watchdog: one cycle through DNS and TLS against the stack"
"$repo/deploy/bin/rws-tick"
jq -e '.disk_pct | type == "number"' /srv/rws/public/ops/ops.json >/dev/null || fail "disk_pct"
rws_compose run --rm --no-deps -T watchdog watchdog --once
proof "rws-tick wrote disk_pct; watchdog --once (the real role, from the egress network to the public address, TLS verified) found /healthz, capture.json, ops.json, the backup, the certificate and the disk green"
jq . /srv/rws/public/ops/ops.json
[[ $ipv6_result == ok ]] || fail "https over IPv6 from outside failed (diagnostics in the 'From outside' group)"
