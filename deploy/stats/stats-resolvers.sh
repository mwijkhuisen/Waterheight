#!/usr/bin/env bash
# stats-resolvers (#270, ADR-0024), installed as /usr/local/bin/stats-resolvers: run by stats-firewall.service,
# stats-resolvers.service at boot and stats-resolvers.path. Loads the host's IPv4 resolvers into
# `inet stats resolvers4`, the only DNS servers cloudflared may ask. With the systemd-resolved stub, Docker forwards
# to resolved's upstream servers, so those are the ones allowed (the parsing of rws-resolvers). It touches no other
# set or table.
#
# Usage: stats-resolvers [--dry-run]
set -euo pipefail

# nameserver lines of a resolv.conf, without zone ids.
servers() { awk '$1 == "nameserver" { sub(/%.*/, "", $2); print $2 }' "$1" 2>/dev/null || true; }

# The set is IPv4 only, so resolved's own file is used unless resolv.conf names a non-loopback IPv4 server.
conf=/etc/resolv.conf
if ! servers "$conf" | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' | grep -qv '^127\.' && [[ -r /run/systemd/resolve/resolv.conf ]]; then
  conf=/run/systemd/resolve/resolv.conf
fi
v4=()
while IFS= read -r addr; do
  if [[ $addr =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ && $addr != 127.* ]]; then
    v4+=("$addr")
  fi
done < <(servers "$conf")

batch='flush set inet stats resolvers4'$'\n'
((${#v4[@]} == 0)) || batch+="add element inet stats resolvers4 { $(IFS=,; echo "${v4[*]}") }"$'\n'
if [[ ${1:-} == --dry-run ]]; then
  printf '%s' "$batch"
  exit 0
fi
printf '%s' "$batch" | nft -f -
echo "stats-resolvers: cloudflared's DNS allowed to ${#v4[@]} IPv4 resolvers (from $conf)"
((${#v4[@]} > 0)) || echo "stats-resolvers: warning: no IPv4 resolver; the tunnel has no DNS until resolv.conf changes" >&2
