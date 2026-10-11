# Runbook: owner site exposure (switch on, switch off, and when verify-prod says it is exposed)

Invariant 11: owner-audience data never reaches a public output. The owner site (caddy-owner) is therefore reachable **only** over WireGuard (A§11.5, ADR-0017). Defence in depth, outermost first:

1. **No public DNS record** for `owner.<domain>`; devices use a hosts entry (owner-device.md).
2. **nftables** (`deploy/host/nftables.conf`): UDP 51820 in; a `prerouting` chain at priority -150 drops anything for `10.66.0.1` that does not arrive on `wg0` (or `lo`), before Docker's DNAT; the forward chain lets `wg0` reach only the owner bridge `rws-owner-pub`, and `to_containers` accepts only the DNATed `10.66.0.1:443`. Nothing else of the host answers a peer.
3. **Compose** (`deploy/compose.owner.yaml`): the only published port is `10.66.0.1:443 -> 8443`; caddy-owner is off the public caddy's network, on its own bridge `rws-owner-pub` that the egress rules do not accept (no way out).
4. **The public Caddy** answers 421 for an unknown Host and refuses the handshake for an unknown SNI.
5. **caddy-owner** itself: `basic_auth` on everything, `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow` on every response.

## Switch on (once, after bootstrap)

1. `sudo /usr/local/lib/rws/deploy/host/bootstrap.sh` from the verified release: the key, `wg-quick@wg0`, `/srv/rws/brownout`.
2. `ip -4 addr show wg0` shows `10.66.0.1/24`; `sudo wg show wg0` shows the interface.
3. Fill the secret (owner-password-rotation.md), set `RWS_OWNER_SITE=on` in `/etc/rws/rws.env` (`sudo sed -i 's/^RWS_OWNER_SITE=off$/RWS_OWNER_SITE=on/' /etc/rws/rws.env`; add the line if the file predates P12a).
4. `sudo rws-deploy <current tag>`: `rws_compose` adds `compose.owner.yaml` only while `RWS_OWNER_SITE=on` **and** `wg0` holds `10.66.0.1`; otherwise it logs why and the overlay is left out (a deploy never fails for the owner site, and the owner containers are removed, fail closed). `rws-update` does the same on every release.
5. Add a device (owner-device.md), run `scripts/verify-owner.sh` from it, and `scripts/verify-prod.sh <domain>` (group `owner listener`) from anywhere.

## Switch off

`sudo sed -i 's/^RWS_OWNER_SITE=on$/RWS_OWNER_SITE=off/' /etc/rws/rws.env && sudo rws-deploy <current tag>` removes caddy-owner, api-owner and the owner overlay (the owner publisher keeps writing `/srv/rws/owner`, which no public service mounts). Immediately, without a deploy: `sudo docker stop rws-caddy-owner-1 rws-api-owner-1`. To close the tunnel too: `sudo systemctl disable --now wg-quick@wg0`.

## verify-prod: `owner listener` FAILs

Treat any FAIL as an exposure until proven otherwise.

1. **Stop first:** `sudo docker stop rws-caddy-owner-1`.
2. Which check? `443 <address>` answered 200 or 401: the owner site is answering on a public address. `8443`: something listens there. `DNS`: a record for `owner.<domain>` exists (or a wildcard): delete it at the DNS provider. A document names an owner source: `docs/runbooks/publisher.md`, then purge the CDN if one is in front (cdn-break-glass.md).
3. On the VPS: `sudo docker port rws-caddy-owner-1` must show only `8443/tcp -> 10.66.0.1:443`; `sudo ss -ltn | grep -E ':(443|8443)\b'`; `sudo nft list chain inet rws prerouting` must hold the `10.66.0.1` drop; `grep OWNER /etc/rws/rws.env`.
4. Fix the cause (restore the firewall with `sudo systemctl reload rws-firewall`; `rws-tick` restores a deleted table within 10 minutes; re-run bootstrap), redeploy, run verify-prod again. Open an issue; if owner data may have been served, treat it as an incident (docs/threat-model.md).

## Not covered here

Only the owner has a device and a password; there is no second user and no screenshot or share of the owner view. Agents have no WireGuard peer.
