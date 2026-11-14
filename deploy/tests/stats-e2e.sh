#!/usr/bin/env bash
# CI only (#270 part A, ADR-0024; ci.yml job `stats`), as root on a GitHub runner, with the runner's own Docker (not
# production's 29.8.1: that is U7, an [agent-prod] check). The [CI] proofs of the stats stack (deploy/stats/):
#   1. the three pinned images, pulled before any firewall load;
#   2. the real rws table and the stats table side by side: nft -c, the stats table loaded twice, exactly one
#      table inet stats, the rws table byte-identical, no `flush ruleset` anywhere in deploy/stats;
#   3. systemd-analyze verify of the stats units (the script at its ExecStart path);
#   4. cloudflared's own ingress matcher (`tunnel ingress rule`) on every URL of the criteria;
#   5. the stack (umami and db; cloudflared needs a real token) behind wg-veth.sh's wg0 stand-in;
#   6. from the WireGuard peer: heartbeat, the first login under read_only (U1), a website, an event, the OPTIONS
#      answer (U2) and /mcp without a key; from docker0: nothing; from umami: no egress; the hardening flags; no
#      secret value in `docker inspect`, `docker top` or the logs.
# Usage: sudo deploy/tests/stats-e2e.sh
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
stats=$repo/deploy/stats
compose=(docker compose -f "$stats/compose.yaml")
peer=(ip netns exec wgpeer curl -sS --max-time 10)
base=http://10.66.0.1:8444
ua='Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
out=$(mktemp -d)
step() { printf '\n== %s\n' "$*"; }
proof() { printf 'PROOF: %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  "${compose[@]}" logs --no-color >&2 || true
  exit 1
}
(($(id -u) == 0)) || { echo "stats-e2e: run as root" >&2; exit 1; }

images=$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]]+).*$/\1/p' "$stats/compose.yaml")
(($(wc -l <<<"$images") == 3)) || fail "expected three images in deploy/stats/compose.yaml"
cf_image=$(grep '^cloudflare/cloudflared:' <<<"$images")
umami_image=$(grep '^ghcr.io/umami-software/umami:' <<<"$images")

step "1. The three pinned images, before any firewall load"
for image in $images; do docker pull -q "$image"; done
proof "pulled: $(tr '\n' ' ' <<<"$images")"

step "2. nftables: the rws table, then the stats table twice beside it"
if grep -rnE '^[^#]*flush ruleset' "$stats"; then fail "flush ruleset in deploy/stats"; fi
nft -c -f "$repo/deploy/host/nftables.conf"
nft -f "$repo/deploy/host/nftables.conf"
rws_before=$(nft list table inet rws)
nft -c -f "$stats/nftables-stats.conf"
nft -f "$stats/nftables-stats.conf"
"$stats/stats-resolvers.sh"
nft -f "$stats/nftables-stats.conf"
"$stats/stats-resolvers.sh"
(($(nft list tables | grep -cx 'table inet stats') == 1)) || fail "not exactly one table inet stats"
[[ $(nft list table inet rws) == "$rws_before" ]] || fail "loading the stats table changed table inet rws"
nft list chain inet rws forward | grep -qF 'iifname "wg0" oifname != { "rws-owner-pub", "stats-publish" } drop' ||
  fail "the rws wg0 exception is not loaded"
proof "no flush ruleset; nft -c and two loads of nftables-stats.conf beside the real rws table: one table inet stats, the rws table byte-identical, its wg0 line names stats-publish; resolvers4: $(nft list set inet stats resolvers4 | grep -o 'elements = {[^}]*}' || echo none)"

step "3. systemd-analyze verify on the stats units"
ln -sfn "$stats/stats-resolvers.sh" /usr/local/bin/stats-resolvers
systemd-analyze verify --man=no --recursive-errors=no "$stats"/*.service "$stats"/*.path
proof "systemd-analyze verify passed for $(cd "$stats" && echo ./*.service ./*.path)"

step "4. cloudflared's ingress matcher on every URL of the criteria"
cf_ingress() {
  docker run --rm --network none -v "$stats/cloudflared.yml:/etc/cloudflared/config.yml:ro" --entrypoint cloudflared \
    "$cf_image" --no-autoupdate tunnel --config /etc/cloudflared/config.yml ingress "$@" 2>&1
}
cf_ingress validate | tee "$out/validate.txt"
grep -qx OK "$out/validate.txt" || fail "cloudflared ingress validate"
expect_rule() {
  local url=$1 want=$2 got
  got=$(cf_ingress rule "$url")
  grep -qx "Matched rule #$want" <<<"$got" || fail "$url: expected rule #$want, got: $got"
  echo "$url -> rule #$want ($(grep -o 'service: .*' <<<"$got"))"
}
expect_rule https://stats.waterradar.io/api/send 0
grep -q 'service: http://umami:3000' <<<"$(cf_ingress rule https://stats.waterradar.io/api/send)" || fail "rule #0 is not umami"
for path in / /login /mcp /api/auth/login /api/websites /api/heartbeat /script.js /api/send/ /api/sendx /x/api/send; do
  expect_rule "https://stats.waterradar.io$path" 1
done
expect_rule https://other.waterradar.io/api/send 1
expect_rule https://example.com/api/send 1
grep -q 'service: http_status:404' <<<"$(cf_ingress rule https://stats.waterradar.io/)" || fail "rule #1 is not the 404"
proof "cloudflared ingress: only https://stats.waterradar.io/api/send reaches http://umami:3000; every other URL of the criteria gets http_status:404"

step "5. The stack behind the wg0 stand-in"
"$repo/deploy/tests/e2e/wg-veth.sh"
install -d -m 0755 /etc/stats
install -d -m 0700 /etc/stats/secrets
db_pw=$(openssl rand -hex 32)
app_secret=$(openssl rand -hex 32)
cf_token=$(openssl rand -hex 32)
put_secret() { printf '%s' "$2" >"/etc/stats/secrets/$1" && chown "root:$3" "/etc/stats/secrets/$1" && chmod 0440 "/etc/stats/secrets/$1"; }
put_secret db_umami "$db_pw" 63001
put_secret umami_app_secret "$app_secret" 63002
put_secret cf_stats_tunnel "$cf_token" 63003
install -m 0644 "$stats/cloudflared.yml" /etc/stats/cloudflared.yml
install -d -m 0700 -o 999 -g 999 /srv/stats/pgdata
"${compose[@]}" up -d --wait --wait-timeout 300 umami db || fail "compose up --wait"
"${compose[@]}" ps
proof "umami and db healthy under read_only, cap_drop ALL and no-new-privileges (the image's start script and first migrations included: U1)"

step "6a. From the WireGuard peer (wgpeer, through wg0, table inet rws and table inet stats)"
code=$("${peer[@]}" -o "$out/heartbeat.json" -w '%{http_code}' "$base/api/heartbeat") || fail "heartbeat from wgpeer"
[[ $code == 200 ]] || fail "heartbeat from wgpeer: HTTP $code"
token=$("${peer[@]}" -H 'Content-Type: application/json' -d '{"username":"admin","password":"umami"}' \
  "$base/api/auth/login" | jq -er .token) || fail "login as admin/umami"
website=$("${peer[@]}" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"name":"waterradar.io","domain":"waterradar.io"}' "$base/api/websites" | jq -er .id) || fail "create a website"
event=$(jq -nc --arg w "$website" \
  '{type:"event",payload:{website:$w,hostname:"waterradar.io",url:"/",title:"e2e",language:"nl",screen:"1920x1080",referrer:""}}')
code=$("${peer[@]}" -D "$out/send.headers" -o "$out/send.json" -w '%{http_code}' -A "$ua" \
  -H 'Content-Type: application/json' -H 'cf-connecting-ip: 198.51.100.7' -d "$event" "$base/api/send") ||
  fail "POST /api/send from wgpeer"
[[ $code == 200 ]] || fail "POST /api/send: HTTP $code $(cat "$out/send.json")"
if grep -qi '^set-cookie:' "$out/send.headers"; then fail "POST /api/send set a cookie"; fi
code=$("${peer[@]}" -X OPTIONS -D "$out/options.headers" -o /dev/null -w '%{http_code}' \
  -H 'Origin: https://waterradar.io' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' "$base/api/send") || fail "OPTIONS /api/send from wgpeer"
cat "$out/options.headers"
[[ $code == 2?? ]] || fail "OPTIONS /api/send: HTTP $code"
grep -qi '^access-control-allow-origin:' "$out/options.headers" || fail "OPTIONS /api/send: no Access-Control-Allow-Origin"
code=$("${peer[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' \
  "$base/mcp") || fail "/mcp from wgpeer"
[[ $code == 401 ]] || fail "/mcp without a key: HTTP $code"
sleep 2
views=$("${peer[@]}" -H "Authorization: Bearer $token" \
  "$base/api/websites/$website/stats?startAt=0&endAt=$(date +%s)000" |
  jq -er '.pageviews | if type == "object" then .value else . end') || fail "read the website's stats"
((views >= 1)) || fail "the event was not stored (pageviews $views)"
# Umami stores no IP (it hashes the address into the session id): the visitor address is nowhere in the database.
# shellcheck disable=SC2016 # expanded by the container's shell, so the password never leaves it
"${compose[@]}" exec -T db sh -c 'PGPASSWORD=$(cat /run/secrets/db_umami) exec pg_dump -U umami -h 127.0.0.1 umami' \
  >"$out/dump.sql" || fail "pg_dump"
if grep -qF 198.51.100.7 "$out/dump.sql"; then fail "the visitor's address is in the database"; fi
proof "from wgpeer: heartbeat 200 $(cat "$out/heartbeat.json"); admin/umami login gave a token; website $website; POST /api/send 200 with no Set-Cookie ($(head -c 200 "$out/send.json")); OPTIONS /api/send $(grep -i '^access-control-allow-origin:' "$out/options.headers" | tr -d '\r'); /mcp without a key 401; pageviews $views; the address 198.51.100.7 is in none of the $(wc -l <"$out/dump.sql") lines of pg_dump"

step "6b. Negatives and the hardening audit"
if docker run --rm --network bridge --entrypoint curl "$umami_image" -sS --max-time 5 -o /dev/null "$base/api/heartbeat"; then
  fail "a container on docker0 reached the dashboard"
fi
ports=$(for id in $("${compose[@]}" ps -q); do
  docker port "$id" | sed "s|^|$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id") |"
done)
[[ $ports == 'umami 3000/tcp -> 10.66.0.1:8444' ]] || fail "published ports: $ports"
if "${compose[@]}" exec -T umami curl -sS --max-time 5 -o /dev/null https://1.1.1.1/; then
  fail "umami reached the internet"
fi
if "${compose[@]}" exec -T umami curl -sS --max-time 5 -o /dev/null http://10.66.0.1:8444/api/heartbeat; then
  fail "umami reached the host's WireGuard address"
fi
for id in $("${compose[@]}" ps -aq); do
  docker inspect "$id" | jq -e '.[0] | (.Config.User | test("^[1-9][0-9]*:[1-9][0-9]*$"))
    and .HostConfig.ReadonlyRootfs and .HostConfig.CapDrop == ["ALL"]
    and (.HostConfig.SecurityOpt | any(. == "no-new-privileges:true"))
    and .HostConfig.Memory > 0 and .HostConfig.NanoCpus > 0 and .HostConfig.PidsLimit > 0
    and (.HostConfig.Privileged | not) and ((.HostConfig.CapAdd // []) | length == 0)' >/dev/null ||
    fail "hardening of $(docker inspect -f '{{.Name}}' "$id")"
done
{
  for id in $("${compose[@]}" ps -aq); do docker inspect "$id"; docker top "$id" -eo pid,args || true; done
  "${compose[@]}" logs --no-color
} >"$out/audit.txt" 2>&1
for value in "$db_pw" "$app_secret" "$cf_token"; do
  if grep -qF "$value" "$out/audit.txt"; then fail "a secret value is in docker inspect, docker top or the logs"; fi
done
if "${compose[@]}" logs --no-color umami | grep -E 'EROFS|EACCES|read-only file system'; then
  fail "umami tried to write outside its tmpfs"
fi
echo "-- umami's log (no secret in it, checked above):"
"${compose[@]}" logs --no-color --no-log-prefix umami | tail -n 25
proof "docker0 container: no answer from $base; only umami publishes, on 10.66.0.1:8444; umami has no egress (1.1.1.1:443) and no way to 10.66.0.1; every container non-root, read-only root, CapDrop ALL, no-new-privileges, memory, cpus and pids bounded; no secret value in docker inspect, docker top or $(wc -l <"$out/audit.txt") lines of audit output; no EROFS or EACCES in umami's log (U1)"

"${compose[@]}" down
echo "stats-e2e: all proofs passed"
