#!/usr/bin/env bash
# CI only (P12a, issue #27; called by deploy/tests/e2e/run.sh before compose up, as root): a stand-in for the
# WireGuard interface of the owner site. GitHub runners have no WireGuard module to rely on, and what the
# firewall and compose care about is the interface's NAME and ADDRESS, so a veth pair stands in:
#   host end   wg0     10.66.0.1/24   (what compose.owner.yaml publishes on; the firewall's iifname "wg0" rules)
#   peer end   wgp0    10.66.0.2/24   in the network namespace `wgpeer`, default route via 10.66.0.1
# isolation.sh then proves the owner site answers from `wgpeer` (and the host) and from nowhere else.
# Idempotent: a second run changes nothing. Removing the namespace removes both ends.
set -euo pipefail

ip netns list | grep -qE '^wgpeer( |$)' || ip netns add wgpeer
if ! ip link show wg0 >/dev/null 2>&1; then
  ip link add wg0 type veth peer name wgp0 netns wgpeer
fi
ip addr replace 10.66.0.1/24 dev wg0
ip link set wg0 up
ip -n wgpeer addr replace 10.66.0.2/24 dev wgp0
ip -n wgpeer link set lo up
ip -n wgpeer link set wgp0 up
ip -n wgpeer route replace default via 10.66.0.1
echo "wg0 10.66.0.1/24 <-> wgpeer:wgp0 10.66.0.2/24"
