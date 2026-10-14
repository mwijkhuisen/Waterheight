#!/usr/bin/env bash
# `caddy adapt` of deploy/web in both edge modes (#109, ADR-0021). Direct mode (RWS_SITE_SCHEME unset, or https) must
# adapt to exactly what today's text adapts to: site.caddy with `{$RWS_DOMAIN} {` and the `:80, :443` catch-all
# inline. Tunnel mode (RWS_SITE_SCHEME=http, what deploy/compose.tunnel.yaml sets) must be one plain :80 server
# beside the container's loopback healthcheck: no :443 listener, no TLS connection policy, no certificate to manage,
# and the trusted proxy exactly as given. Any other scheme must stop Caddy.
# Caddy: $CADDY (a local binary), else the web image's pinned Caddy base through docker, without network (CI).
# Needs jq. Usage: deploy/tests/caddy-edge.test.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
web=$(cd "$here/../web" && pwd)
T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
image=$(sed -n 's/^FROM \(caddy:[^ ]*@sha256:[0-9a-f]\{64\}\).*/\1/p' "$web/Dockerfile")
if [[ -z ${CADDY:-} && -z $image ]]; then
  echo "FAIL: no CADDY and no pinned caddy image in deploy/web/Dockerfile"
  exit 1
fi
failures=0 cases=0
ok() { cases=$((cases + 1)); echo "ok   $1"; }
bad() { cases=$((cases + 1)) failures=$((failures + 1)); echo "FAIL $1"; }

# copy <name>: deploy/web's Caddy files in $T/<name>, the absolute /etc/caddy/ imports pointing there.
copy() {
  mkdir -p "$T/$1"
  cp "$web"/*.caddy "$web/Caddyfile" "$T/$1/"
  sed -i "s#/etc/caddy/#$T/$1/#g" "$T/$1"/Caddyfile "$T/$1"/*.caddy
}

# adapt <name> <out> [VAR=value]...: the adapted JSON, with the copy's path replaced by /etc/caddy/.
adapt() {
  local dir=$T/$1 out=$2 kv
  shift 2
  local -a vars=(RWS_DOMAIN=rk.example.org RWS_CONTACT_EMAIL=ops@example.org "$@") flags=()
  if [[ -n ${CADDY:-} ]]; then
    env -i HOME="$T" "${vars[@]}" "$CADDY" adapt --config "$dir/Caddyfile" --adapter caddyfile >"$out" 2>"$out.err" ||
      return 1
  else
    for kv in "${vars[@]}"; do flags+=(-e "$kv"); done
    docker run --rm --network none -v "$dir:$dir:ro" "${flags[@]}" "$image" \
      caddy adapt --config "$dir/Caddyfile" --adapter caddyfile >"$out" 2>"$out.err" || return 1
  fi
  sed -i "s#$dir/#/etc/caddy/#g" "$out"
}

copy now
# Today's text: the literal site address, no edge import and no edge_site snippet, and the catch-all inline at the end
# (where it was before #109).
copy literal
# shellcheck disable=SC2016 # Caddy placeholders, not shell expansions
sed -i -e 's#^{$RWS_SITE_SCHEME:https}://{$RWS_DOMAIN} {$#{$RWS_DOMAIN} {#' \
  -e '/^import edge-{$RWS_SITE_SCHEME:https}\.caddy$/d' -e '/^[[:space:]]*import edge_site$/d' "$T/literal/site.caddy"
sed -n '/^:80, :443 {$/,/^}$/p' "$web/edge-https.caddy" >>"$T/literal/site.caddy"
# shellcheck disable=SC2016 # Caddy placeholders, not shell expansions
if grep -v '^[[:space:]]*#' "$T/literal/site.caddy" | grep -qE 'RWS_SITE_SCHEME|edge_site|import edge-' ||
  ! grep -qx '{$RWS_DOMAIN} {' "$T/literal/site.caddy" || ! grep -qx ':80, :443 {' "$T/literal/site.caddy"; then
  bad "the literal copy could not be made: site.caddy's edge lines changed shape"
fi

adapt literal "$T/literal.json" || bad "today's text adapts"
for scheme in unset https; do
  vars=()
  [[ $scheme == unset ]] || vars=("RWS_SITE_SCHEME=$scheme")
  if adapt now "$T/direct-$scheme.json" "${vars[@]}" && cmp -s "$T/direct-$scheme.json" "$T/literal.json"; then
    ok "direct mode (RWS_SITE_SCHEME $scheme) adapts byte for byte to today's text"
  else
    bad "direct mode (RWS_SITE_SCHEME $scheme) differs from today's text"
  fi
done
if adapt now "$T/direct-proxy.json" RWS_TRUSTED_PROXIES=192.0.2.7/32 &&
  jq -e '[.apps.http.servers[].trusted_proxies.ranges] | all(. == ["192.0.2.7/32"])' "$T/direct-proxy.json" >/dev/null &&
  jq -e '[.apps.http.servers[].listen[]] | index(":443") != null' "$T/direct-proxy.json" >/dev/null; then
  ok "direct mode keeps :443 and reads RWS_TRUSTED_PROXIES"
else
  bad "direct mode: :443 or RWS_TRUSTED_PROXIES"
fi

tunnel=$T/tunnel.json
if adapt now "$tunnel" RWS_SITE_SCHEME=http RWS_TRUSTED_PROXIES=172.30.41.10/32; then
  ok "tunnel mode adapts"
  if jq -e '[.apps.http.servers[].listen] | sort == [["127.0.0.1:8081"], [":80"]]' "$tunnel" >/dev/null; then
    ok "tunnel mode: one :80 server beside the loopback healthcheck, no :443 listener"
  else
    bad "tunnel mode listeners: $(jq -c '[.apps.http.servers[].listen]' "$tunnel")"
  fi
  if jq -e '[.apps.http.servers[] | .tls_connection_policies // empty] | length == 0' "$tunnel" >/dev/null &&
    jq -e '[.. | .subjects? // empty] | length == 0' "$tunnel" >/dev/null; then
    ok "tunnel mode: no TLS connection policy and no certificate subject (no ACME order)"
  else
    bad "tunnel mode has TLS policies or certificate subjects"
  fi
  if jq -e '.apps.http.servers[] | select(.listen == [":80"]) | [.routes[].match[]?.host[]?] | index("rk.example.org") != null' \
    "$tunnel" >/dev/null; then
    ok "tunnel mode: the site answers on :80 for the domain"
  else
    bad "tunnel mode: the domain is not served on :80"
  fi
  # Review S6: a plain-HTTP visit Cloudflare forwards (X-Forwarded-Proto http) is a 308 to https, in tunnel mode only.
  if jq -e '[.. | objects | select(.match? // [] | any(.header?["X-Forwarded-Proto"]? == ["http"]))
      | .handle[] | select(.handler == "static_response" and .status_code == 308
      and .headers.Location == ["https://{http.request.host}{http.request.uri}"])] | length == 1' "$tunnel" >/dev/null &&
    ! grep -q 'X-Forwarded-Proto' "$T/direct-unset.json"; then
    ok "tunnel mode: X-Forwarded-Proto http is a 308 to https; direct mode has no such route"
  else
    bad "tunnel mode: no 308 for X-Forwarded-Proto http (or direct mode has one)"
  fi
  if jq -e '[.. | objects | select(.match? // [] | any(.header?["X-Forwarded-Proto"]? == ["http"]))
      | .handle[] | select(.handler == "headers" and .response.set["Cache-Control"] == ["no-store"])] | length == 1' \
    "$tunnel" >/dev/null; then
    ok "tunnel mode: the 308 carries Cache-Control: no-store"
  else
    bad "tunnel mode: the 308 has no Cache-Control: no-store"
  fi
  if jq -e '[.apps.http.servers[].trusted_proxies.ranges] | all(. == ["172.30.41.10/32"])' "$tunnel" >/dev/null &&
    jq -e '[.apps.http.servers[].trusted_proxies_strict] | all(. == 1)' "$tunnel" >/dev/null; then
    ok "tunnel mode: the trusted proxy is exactly cloudflared's address, strict"
  else
    bad "tunnel mode trusted proxies: $(jq -c '[.apps.http.servers[].trusted_proxies]' "$tunnel")"
  fi
else
  bad "tunnel mode adapts"
fi

for scheme in htp HTTP ftp https:; do
  if adapt now "$T/bad.json" "RWS_SITE_SCHEME=$scheme"; then
    bad "RWS_SITE_SCHEME=$scheme adapts: it must stop Caddy"
  else
    ok "RWS_SITE_SCHEME=$scheme stops Caddy"
  fi
done

echo "$cases cases, $failures failures"
((failures == 0))
