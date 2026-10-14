# Runbook: waterradar.io behind the Cloudflare Tunnel in one sitting (#109)

**Trigger:**
- the owner moves the public site from `rk.wijkhuisen.info` (direct, LAN Caddy proxy, router forwards) straight to `waterradar.io` behind the tunnel;
- it replaces rollout step 1 (`docs/runbooks/domain-change.md`) and step 2 (`docs/runbooks/edge-switch.md`) with one sitting, and skips the direct-mode stop on the new name: no `A`/`AAAA` records to the home line, no LAN proxy entry, no Let's Encrypt certificate for `waterradar.io`.

An [owner] task. The two runbooks stay the reference for every detail; this one only gives the order and what falls away.

**Why it can be combined:**
- In tunnel mode Caddy serves plain HTTP on `127.0.0.1:80` (`RWS_SITE_SCHEME=http`, `deploy/compose.tunnel.yaml`): it needs no certificate for the new name, so port 80, HTTP-01 and the LAN proxy entry of domain-change §2–3 do not apply.
- The deploy's smoke test in tunnel mode probes `http://$RWS_DOMAIN` over loopback (`smoke` in `deploy/bin/rws-lib.sh`), so the deploy passes before any DNS record exists.
- `waterradar.io` has no records yet, so there is no TTL to wait for (edge-switch §1.4 falls away). The old stack (the `rk.` DNS records, the LAN proxy, the forwards, `RWS_TRUSTED_PROXIES`) stays untouched until the end and **is** the rollback.

**What it costs:** without a direct-mode baseline on the new name, a failing `verify-prod` does not tell a domain fault from an edge fault (prelaunch: accepted). The healthchecks `watchdog` and `cert` go red from the deploy until the DNS switch, because they probe `https://$RWS_DOMAIN` through public DNS.

## 1. Beforehand (any day before)

1. edge-switch §1 item 2 (bootstrap twice, the token file exists empty) and item 5 (the Cloudflare account hardening).
2. DNSSEC for the zone, domain-change §1a. It does not touch the running `rk.` site.
3. The apex `waterradar.io` holds **no** record (delete any parking record) and **no CAA record yet**, so that Universal SSL issues freely. In SSL/TLS, Edge Certificates, the Universal certificate for `waterradar.io` and `*.waterradar.io` is Active.
4. The tunnel exists without a public hostname (edge-switch §2.1 and §2.3); the dashboard settings and the three cache rules are in place (edge-switch §3).
5. The owner has approved the NL and EN privacy text that names Cloudflare (E5).
6. Write down the current `RWS_DOMAIN` (`rk.wijkhuisen.info`): it is the rollback value.

## 2. The token and `rws.env` (one edit)

The token file as in edge-switch §4. Then:

```bash
sudoedit /etc/rws/rws.env
#   RWS_DOMAIN=waterradar.io
#   RWS_EDGE=tunnel
#   RWS_CDN_NAME=Cloudflare
#   RWS_WG_ENDPOINT=<a DNS-only name or the home address, never waterradar.io or owner.*; edge-switch §4>
# Leave RWS_TRUSTED_PROXIES as it is: the rollback (section 7) needs it.
```

## 3. Deploy and check (sections 3 to 5 in one sitting)

```bash
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
sudo docker ps --format '{{.Names}} {{.Status}}' | grep -E 'cloudflared|caddy'
curl -s --resolve waterradar.io:80:127.0.0.1 http://waterradar.io/healthz
curl -s --resolve waterradar.io:80:127.0.0.1 http://waterradar.io/runtime-config.json | jq -r .cdn   # Cloudflare
sudo docker port rws-caddy-1                                          # 80/tcp -> 127.0.0.1:80 only
sudo docker inspect rws-cloudflared-1 | grep -c 'TUNNEL_TOKEN='       # 0
sudo deploy/tests/hardening.sh --prod
```

Expected and what to do otherwise: edge-switch §5 and §6. The dashboard shows one healthy connector.

## 4. The DNS switch and the owner site

1. In the tunnel, add the one public hostname `waterradar.io`, HTTP, `caddy:80`. The dashboard creates the proxied `CNAME`. There are no old `A`/`AAAA` records to delete.
2. Check the headers and both privacy pages as in edge-switch §8:

   ```bash
   dig +short waterradar.io                  # Cloudflare addresses
   curl -sI https://waterradar.io/ | grep -i -E '^(HTTP|server|strict|content-security)'
   ```
3. The owner site is now `owner.waterradar.io`: change the hosts entry or the WireGuard DNS on each owner device and run `scripts/verify-owner.sh waterradar.io --cacert owner-root.crt` from one (domain-change §4). Still no public record for the owner name.

## 5. Verify

```bash
scripts/verify-prod.sh waterradar.io --edge cloudflare
```

Expected: edge-switch §9 (the whole `edge` group and `owner listener` PASS; only the known fresh-data FAILs). Read the account's audit log. The agent can run this command.

## 6. After green: close the old path

1. CAA `0 issue "letsencrypt.org"` on the apex (ADR-0020, a later direct rollback); `dig +short CAA waterradar.io` then also shows the records Cloudflare added for its own authorities (edge-switch §1.3).
2. Close the router, retire the LAN proxy, empty `RWS_TRUSTED_PROXIES`, the outside-in connect check and the KG-228 check: edge-switch §9 steps 1 to 5. UDP 51820 stays.
3. Retire `rk.wijkhuisen.info`: its DNS records and its proxy entry (prelaunch, noindex: no redirect).
4. The GitHub repository variable `RWS_DOMAIN` becomes `waterradar.io` (`docs/github-settings.md`).

## 7. Rollback

**Before section 6** (router and LAN proxy still in place): back to today's stack.

```bash
sudoedit /etc/rws/rws.env      # RWS_DOMAIN=rk.wijkhuisen.info, RWS_EDGE=direct, RWS_CDN_NAME=   (empty)
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
scripts/verify-prod.sh rk.wijkhuisen.info
```

`RWS_CDN_NAME` is emptied in the same deploy here (unlike edge-switch §10): the `rk.` name never went through Cloudflare, and with `cloudflared` gone no request reaches us through it. Remove the tunnel's public hostname, and point the owner devices back to `owner.rk.wijkhuisen.info`. Caddy still holds the `rk.` certificate in its data volume; if it has expired it takes a new one over the still-open port 80.

**After section 6**: edge-switch §10 (direct on `waterradar.io`), which then first needs the `A`/`AAAA` records and the LAN proxy entry of domain-change §1–2.
