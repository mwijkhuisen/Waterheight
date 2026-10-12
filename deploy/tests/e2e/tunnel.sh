#!/usr/bin/env bash
# The tunnel edge on the CI stack (#109, ADR-0021). CI only, as root, after run.sh's normal run, verify-prod and
# hardening.sh (ci.yml job `deploy`): the stack is switched to RWS_EDGE=tunnel (deploy/compose.tunnel.yaml) with the
# server image idling in place of cloudflared (compose.tunnel-ci.yaml: cloudflared's own service definition, CI never
# dials Cloudflare), and it proves, one PROOF line each:
#   - the stack in tunnel mode: caddy publishes 127.0.0.1:80 alone, no public address answers, the deploy smoke test
#     of rws-lib.sh passes over plain HTTP on loopback;
#   - from cloudflared's address (tunnel-probe.mjs): the site over plain HTTP; the limiter keys the right-most address
#     of X-Forwarded-For (what Cloudflare appends), whatever a client puts before it; api, api-owner, caddy-owner, db,
#     caddy's other ports and the host are unreachable; only TCP 7844 to Cloudflare's ranges leaves the host;
#   - Caddy's masked log: the appended visitor, never a spoofed prefix; a host-side request to the loopback port is
#     never trusted with its X-Forwarded-For;
#   - the token never shows in `docker inspect` or the rendered compose config.
# The stack stays in tunnel mode for the hardening audit that follows (hardening.sh --ci).
set -euo pipefail

repo=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
e2e=$repo/deploy/tests/e2e
# shellcheck source=deploy/bin/rws-lib.sh
. "$repo/deploy/bin/rws-lib.sh"

readonly DOMAIN=rivierstanden.example IP4=203.0.114.10 CLIENT=203.0.114.11
readonly REL=$RWS_STATE_DIR/releases/prod-ci
# A Cloudflare tunnel address routed into the outside namespace for this run only: what passes the 7844 rule there
# meets a reset (nothing listens), what does not times out.
readonly CF_TEST=198.41.192.7
fail() {
  echo "::error::tunnel: $*"
  exit 1
}
proof() { echo "PROOF: $*"; }
# Only on run.sh's stack: root, its /ci directory, its rws.env (a production host has another domain).
[[ $EUID == 0 && -d /ci/pki ]] || fail "CI only, as root, after deploy/tests/e2e/run.sh"
[[ $(docker inspect -f '{{.State.Running}}' rws-caddy-1 2>/dev/null) == true ]] || fail "run.sh's stack is not running"
grep -qx "RWS_DOMAIN=$DOMAIN" /etc/rws/rws.env || fail "/etc/rws/rws.env is not run.sh's"

echo "::group::Switch the CI stack to RWS_EDGE=tunnel"
token="ci-not-a-token-$(openssl rand -hex 16)"
install -m 0440 -o 0 -g 61011 /dev/null /etc/rws/secrets/cf_tunnel_token
printf '%s\n' "$token" >/etc/rws/secrets/cf_tunnel_token
sed -i '/^RWS_EDGE=/d' /etc/rws/rws.env
echo 'RWS_EDGE=tunnel' >>/etc/rws/rws.env
# rws_compose takes the overlay from the release's deploy/ (as a staged release has it); the CI release is run.sh's.
mkdir -p "$REL/deploy"
cp "$repo/deploy/compose.tunnel.yaml" "$REL/deploy/"
ci_compose() {
  docker compose -p rws --project-directory "$REL" -f "$REL/compose.yaml" -f "$REL/deploy/compose.tunnel.yaml" \
    -f "$e2e/compose.tunnel-ci.yaml" --env-file /etc/rws/rws.env --env-file "$REL/images.env" "$@"
}
ci_compose up -d --remove-orphans --quiet-pull
for s in caddy cloudflared; do
  for _ in $(seq 1 60); do
    [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$s-1" 2>/dev/null) == healthy ]] && break
    sleep 3
  done
  [[ $(docker inspect -f '{{.State.Health.Status}}' "rws-$s-1") == healthy ]] || fail "$s is not healthy in tunnel mode"
done
docker ps --filter label=com.docker.compose.project=rws --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "::endgroup::"

echo "::group::Caddy publishes 127.0.0.1:80 alone; the deploy smoke test"
ports=$(docker inspect -f '{{json .NetworkSettings.Ports}}' rws-caddy-1 |
  jq -c '[to_entries[] | select(.value != null) | .key as $k | .value[] | "\(.HostIp):\(.HostPort)->\($k)"] | sort')
[[ $ports == '["127.0.0.1:80->80/tcp"]' ]] || fail "caddy publishes $ports in tunnel mode"
nets=$(docker inspect -f '{{json .NetworkSettings.Networks}}' rws-cloudflared-1 | jq -c 'keys')
[[ $nets == '["rws_tunnel","rws_tunnel_edge"]' ]] || fail "cloudflared is on $nets"
addr=$(docker inspect -f '{{(index .NetworkSettings.Networks "rws_tunnel_edge").IPAddress}}' rws-cloudflared-1)
[[ $addr == 172.30.41.10 ]] || fail "cloudflared has $addr on tunnel_edge, not 172.30.41.10"
for p in "https://$DOMAIN/healthz --resolve $DOMAIN:443:$IP4" "http://$DOMAIN/healthz --resolve $DOMAIN:80:$IP4"; do
  # shellcheck disable=SC2086 # the URL and its --resolve
  if ip netns exec ext curl -sS -o /dev/null --max-time 5 --insecure $p 2>/dev/null; then
    fail "the public address still answers in tunnel mode: $p"
  fi
done
load_env
[[ $(edge_mode) == tunnel ]] || fail "edge_mode does not read RWS_EDGE=tunnel"
RWS_SMOKE_TIMEOUT=120 smoke $(($(date -u +%s) - 3600)) || fail "the rws-deploy smoke test failed in tunnel mode"
proof "RWS_EDGE=tunnel: caddy publishes only 127.0.0.1:80/tcp ($ports), cloudflared's service sits on rws_tunnel and rws_tunnel_edge ($addr), the public address no longer answers HTTP or HTTPS, and the rws-deploy smoke test passes over plain HTTP on loopback"
echo "::endgroup::"

echo "::group::From cloudflared's address (tunnel-probe.mjs)"
ip netns exec ext ip addr add "$CF_TEST/32" dev vext1
ip route replace "$CF_TEST/32" via 10.99.0.2
ips() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1"; }
closed=() dropped=()
for ip in $(ips rws-api-1); do closed+=("$ip:8080"); done
for ip in $(ips rws-api-owner-1); do closed+=("$ip:8080"); done
for ip in $(ips rws-caddy-owner-1); do closed+=("$ip:8443" "$ip:443"); done
for ip in $(ips rws-db-1); do closed+=("$ip:5432"); done
caddy_tunnel=$(docker inspect -f '{{(index .NetworkSettings.Networks "rws_tunnel_edge").IPAddress}}' rws-caddy-1)
closed+=("$caddy_tunnel:443" "$caddy_tunnel:8081" "$caddy_tunnel:2019" "10.66.0.1:443")
gw=$(docker network inspect rws_tunnel -f '{{(index .IPAM.Config 0).Gateway}}')
dropped+=("$gw:22" "$CLIENT:443" "$CLIENT:7844" "$CF_TEST:443" "1.1.1.1:443")
docker exec -i -e "PROBE_DOMAIN=$DOMAIN" -e "PROBE_CLOSED=${closed[*]}" -e "PROBE_DROPPED=${dropped[*]}" \
  -e "PROBE_REFUSED=$CF_TEST:7844" rws-cloudflared-1 /nodejs/bin/node --input-type=module - <"$e2e/tunnel-probe.mjs" |
  tee /ci/tunnel-probe.out || fail "the tunnel probe failed (see the lines above)"
ip route del "$CF_TEST/32" via 10.99.0.2 || true
proof "from cloudflared's address 172.30.41.10: $(grep -c '^ok' /ci/tunnel-probe.out) checks, among them the site over plain HTTP to caddy:80, the limiter keyed by the right-most X-Forwarded-For address whatever comes before it ($(grep -F '300 GETs' /ci/tunnel-probe.out | sed 's/^ok *//')), and ${#closed[@]} internal targets (api, api-owner, caddy-owner, db, caddy's 443, 8081 and 2019, the owner address) never connected; the host and the outside dropped (${dropped[*]}), TCP 7844 to $CF_TEST let out"
echo "::endgroup::"

echo "::group::Caddy's masked log: the appended visitor, never a spoofed prefix or an untrusted peer's header"
curl -sS -o /dev/null --max-time 5 --resolve "$DOMAIN:80:127.0.0.1" -H 'X-Forwarded-For: 6.6.6.6' \
  "http://$DOMAIN/tunnel-probe-host" || true
sleep 2
seen=$(docker exec rws-caddy-1 cat /data/access/access.log |
  jq -r 'select((.request.uri // "") | startswith("/tunnel-probe-")) | "\(.request.uri) \(.request.remote_ip) \(.request.client_ip)"' |
  sort -u)
echo "$seen"
grep -qx '/tunnel-probe-xff 172.30.41.0 198.51.100.0' <<<"$seen" ||
  fail "the request through cloudflared was not logged as peer 172.30.41.0 with client 198.51.100.0"
host_line=$(grep -F '/tunnel-probe-host ' <<<"$seen" | head -n 1)
[[ -n $host_line ]] || fail "no log line for the host-side request"
[[ $host_line != *6.6.6.0* ]] || fail "a host-side request to 127.0.0.1:80 was trusted with its X-Forwarded-For: $host_line"
proof "Caddy's masked log: through cloudflared the client is the appended visitor (198.51.100.0, peer 172.30.41.0; the spoofed 6.6.6.6 ignored); a host-side request to 127.0.0.1:80 (which arrives from a bridge gateway, not from tunnel_edge) is logged as its own peer, not its X-Forwarded-For (${host_line#* }); that the trusted range is cloudflared's /32 and no wider is held by test/compose-tunnel.test.ts"
echo "::endgroup::"

echo "::group::The token never shows in docker inspect or the rendered compose config"
inspect=$(docker inspect rws-cloudflared-1)
config=$(ci_compose config)
if grep -qF -- "$token" <<<"$inspect" || grep -qF -- "$token" <<<"$config"; then
  fail "the tunnel token appears in docker inspect or the compose config"
fi
proof "the tunnel token is in neither docker inspect nor the rendered compose config (a file secret, --token-file)"
echo "::endgroup::"
