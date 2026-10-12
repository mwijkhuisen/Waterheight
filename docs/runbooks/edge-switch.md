# Runbook: switch the public site between Caddy direct and a Cloudflare Tunnel (#109, ADR-0021)

**Trigger:**
- the owner moves the public site from the home router's 80/443 forwards to a Cloudflare Tunnel (direct → tunnel, sections 1 to 9);
- the tunnel must be left again, or a tunnel problem needs the direct stack back (tunnel → direct, section 10);
- the `edge` group of `scripts/verify-prod.sh <domain> --edge cloudflare` fails (section 11).

An [owner] task: it needs the Cloudflare dashboard, the router, the VPS and the DNS zone. Agents have no production access and never log in to Cloudflare, set `RWS_EDGE` or edit `rws.env` (CLAUDE.md, "Edge switch (#109)"). Design and reasons: `docs/adr/0021-home-hosting-behind-a-cloudflare-tunnel.md`; threats: T-EDGE-1 and T-CDN-1 in `docs/threat-model.md`.

What the switch does: with `RWS_EDGE=tunnel` in `/etc/rws/rws.env`, `rws_compose` (`deploy/bin/rws-lib.sh`) adds `deploy/compose.tunnel.yaml` to every compose call. `cloudflared` dials out to Cloudflare (TCP and UDP 7844) and hands each visitor's request to `caddy:80` over an internal network; Caddy serves plain HTTP there and publishes only `127.0.0.1:80`. The public host name then needs no inbound port at the router. `RWS_EDGE=direct` or no line is today's stack. Any other value stops every `rws-*` script before docker runs (`rws.env: RWS_EDGE must be direct or tunnel`).

The owner site never goes behind Cloudflare: `owner.<domain>` gets no public DNS record and no tunnel route, in either direction of this runbook.

## 1. Prerequisites

1. **Rollout step 1 is done:** the site runs in direct mode on `waterradar.io` and `scripts/verify-prod.sh waterradar.io` is as green as before (`docs/runbooks/domain-change.md`).
2. **This release is deployed** (`rws-update` has installed it) and its host files are installed. They changed: `deploy/host/nftables.conf` (the set `cftunnel4` and its one rule), `deploy/bin/rws-lib.sh`, `deploy/bin/rws-wg-peer` and `deploy/host/bootstrap.sh`. Until bootstrap has run, `rws-update` pings `update` with `/fail` and `host_files_changed`. Run it from the verified release directory, twice; the second run must say "0 change(s)" (`docs/runbooks/bootstrap.md`, "a new release with changed host files"):

   ```bash
   sudo /usr/local/lib/rws/deploy/host/bootstrap.sh
   sudo /usr/local/lib/rws/deploy/host/bootstrap.sh
   sudo stat -c '%n %a %U:%G' /etc/rws/secrets/cf_tunnel_token    # 440 root:rws-cftunnel (gid 61011), empty for now
   sudo nft list set inet rws cftunnel4                           # 198.41.192.0/24, 198.41.200.0/24
   ```
3. **The zone's CAA records allow both authorities.** Cloudflare's Universal SSL certificate is issued by authorities of its own. When a zone has CAA records, Cloudflare adds the records for those authorities itself; without them Universal SSL cannot issue. Check after the zone is proxied and again after the switch:

   ```bash
   dig +short CAA waterradar.io
   ```

   Expected: `0 issue "letsencrypt.org"` (ADR-0020, Caddy's certificate and a rollback) **beside** the records Cloudflare added for its own authorities. If only Let's Encrypt is listed, add no record by hand from memory: ask Cloudflare's dashboard (SSL/TLS, Edge Certificates) which authorities it will use, or remove the CAA records for the duration and put Let's Encrypt back afterwards.
4. **TTL.** A day ahead, lower the TTL of the `A` and `AAAA` records of the public name to 60 seconds (they are DNS-only, TTL 300 from the domain change). Clients that still hold the old record fail for a few minutes after section 8; that is acceptable before the launch flip (E4), which is why this runs first.
5. **The Cloudflare account is a root of trust** (T-EDGE-1, R-105): whoever controls it can repoint the apex, add an `owner.` record, rotate the tunnel token or add a connector, and inject scripts or poison the cache through Workers, Snippets or transform rules. Before the switch the owner has: two-factor sign-in with a hardware key (a TOTP app only if no key is available); the account's e-mail mailbox behind two-factor sign-in too (it resets everything else); one member of the account, the owner; **no API tokens**, or each one listed in the password manager and rotated together with the tunnel token (`docs/runbooks/secrets-rotation.md` §6); no Workers, Snippets, Page Rules or transform rules beyond the ones this runbook names. The account's **Global API Key** (every account has one; it cannot be deleted, only rolled; it carries full account rights and is readable in the dashboard after a password re-entry) is never used: roll it at setup, at every tunnel-token rotation and after any suspected session compromise. The account's **audit log** is read at every `verify-prod --edge cloudflare` run (section 9): any change the owner did not make is an incident.

## 2. The Cloudflare side

In the Cloudflare dashboard (Zero Trust, Networks, Tunnels), the owner:

1. Creates one **tunnel**, remotely managed ("Cloudflared"), named for the host. Do not add a public hostname yet (section 8 does, at the switch). Copy the **token** into the password manager only; it is shown once more on the tunnel's page.
2. Later adds exactly **one public hostname**: `waterradar.io` (no subdomain, no path), service type HTTP, URL `caddy:80`. Nothing else: no second route, no catch-all service, no `owner.` name.
3. Adds **no private-network (WARP) route** and **no Access application** to the tunnel.

Why `http://caddy:80`: `cloudflared` resolves `caddy` on the internal network, and its address is the only one Caddy trusts for `X-Forwarded-For`.

## 3. Dashboard settings and cache rules

The owner applies these for the zone before the switch. Cloudflare changes defaults and adds features without notice, so `scripts/verify-prod.sh <domain> --edge cloudflare` is the standing check (section 11).

| Area | Setting | Value | Why |
|---|---|---|---|
| SSL/TLS | Encryption mode | leave the zone's value | It does not apply to a tunnel: the origin is `http://caddy:80` inside the stack and the edge-to-origin leg never leaves the tunnel |
| SSL/TLS | Always Use HTTPS | on | Visitors on plain HTTP are redirected at the edge. If it were switched off by mistake, a plain-HTTP visit would be forwarded to Caddy, which in tunnel mode answers a request with `X-Forwarded-Proto: http` with a `no-store` 308 to `https://` (the origin guard of `edge_site` in `deploy/web/edge-http.caddy`) and never serves it |
| SSL/TLS | Minimum TLS version | 1.2 | |
| SSL/TLS | TLS 1.3 | on | |
| SSL/TLS | 0-RTT | off | Replay of early data |
| SSL/TLS | HTTP Strict Transport Security (Cloudflare's) | off | The origin sends `Strict-Transport-Security` itself (A§12.2); a second source would differ from the tested value |
| SSL/TLS | Automatic HTTPS Rewrites | off | No rewriting of our HTML |
| Scrape Shield | Email Obfuscation | off | It injects `/cdn-cgi/` links and a script |
| Scrape Shield | Hotlink Protection | off | |
| Speed | Rocket Loader | off | Injects a script (invariant 7, the CSP) |
| Speed | Speed Brain | off | Adds `Speculation-Rules` |
| Speed | Early Hints | off | |
| Speed | Cloudflare Fonts | off | Rewrites font requests |
| Speed | Crawler Hints | off | |
| Zaraz | Zaraz | off, nothing configured | A third-party tag manager |
| Analytics | Web Analytics | off (no automatic beacon, no `cloudflareinsights` script) | Invariant 7: no third-party request from the browser |
| Security | Bot Fight Mode | off | Injects JavaScript and sets a `__cf_bm` cookie |
| Security | Browser Integrity Check | off | |
| Security | Security level, "Under Attack" mode | never "Under Attack" (its challenge page breaks the API clients and the map) | |
| Caching | Always Online | off | |
| Network | IP Geolocation | off | Else Cloudflare adds `Cf-Ipcountry` to every request and it lands in the 14-day access log |
| Network | Pseudo IPv4 | off | Its "Overwrite headers" mode rewrites `Cf-Connecting-IP` and `X-Forwarded-For` to a Class E pseudo address (240.0.0.0/4): the limiter and the masked log would key on pseudo addresses, and the `client_ip` check of §9.5 (no Cloudflare range) would not notice. Its "Add header" mode adds `Cf-Connecting-IPv6` with the visitor's full IPv6 address, which the access-log filter (frozen by the byte-identical rule for direct mode) does not delete |
| Rules | Managed Transforms: "Remove visitor IP headers" | off | It strips `X-Forwarded-For`: every visitor would then look like cloudflared's address, collapse onto the limiter's `unknown-gw` key and make the masked log useless |
| Rules | Managed Transforms: "Add visitor location headers" and every other "Add ..." transform | off | Location headers would land in the access log |
| Caching | Browser Cache TTL | Respect Existing Headers | Else Cloudflare overrides the origin's `Cache-Control` for browsers |
| Tunnel | WARP and private-network routes, Access | none | Section 2 |

**Which Cloudflare request headers reach our access log in tunnel mode** (the log filter keeps no other client-address header, `test/privacy-policy.test.ts`): `CF-Ray`, `CF-Visitor`, `CDN-Loop` and `Cf-Warp-Tag-Id` carry no visitor data; `Cf-Connecting-Ip` and `True-Client-Ip` are deleted by the filter; `Cf-Ipcountry` and the location headers are in the log unless the settings above are off, and the log filter was not changed (it would change direct mode's adapted Caddy JSON, which stays byte for byte). That is why those settings are rows of this table and a residual in T-API-3 and T-WEB-4.

**Cache rules** (Rules, Cache Rules), **in this order** (Cloudflare applies them top to bottom and a later rule can override an earlier one):

| # | When the path matches | Setting | Why |
|---|---|---|---|
| 1 | `/tiles/*` | Bypass cache | On a cold miss of a cacheable object Cloudflare drops `Range`, and our tile routes answer 416 without one (CLAUDE.md, the Caddy gotchas). The tiles are served by Caddy as before |
| 2 | `/data/*` | Eligible for cache; Edge TTL "use cache-control header if present, bypass cache if not" | Our `/data/v1` files carry `Cache-Control`; our 404s carry none, so they are never cached |
| 3 | `/assets/*` | Eligible for cache; Edge TTL "use cache-control header if present, bypass cache if not" | The real assets carry `immutable`; our `/assets` 404 carries no `Cache-Control` and with "respect origin" would take Cloudflare's default TTL for a 404 status, so it must bypass |

Everything else keeps the default: HTML, JSON, `/api`, `/status` and `/runtime-config.json` are not cached. The cached trees are static and licence-neutral. Never add a rule for `/api`, `/status`, health or an error status (a cached `503` or `429` would keep a recovered site down). If Cloudflare adds `NEL` or `Report-To` to answers and a response-header transform rule on the free plan cannot remove it, **stop here and roll back (section 10)**: the browser would send reports to a third party (invariant 7). That is the owner's decision to take, not a setting to live with.

## 4. The token and the `rws.env` lines

```bash
sudoedit /etc/rws/secrets/cf_tunnel_token     # the token alone on one line, in place; bootstrap made the file root:61011 0440
sudo stat -c '%n %a %U:%G %s' /etc/rws/secrets/cf_tunnel_token
```

Expected: `440 root:rws-cftunnel`, a size above 100 bytes. The token goes into this file and nowhere else: not `rws.env`, not an environment variable, not a command line, a log, a ticket or a chat. `rws_compose` refuses tunnel mode while the file is empty.

Then the `rws.env` lines, all in one edit:

```bash
sudoedit /etc/rws/rws.env
#   RWS_EDGE=tunnel
#   RWS_CDN_NAME=Cloudflare
#   RWS_WG_ENDPOINT=<a DNS-only name or the address of the home line, never the public site's name>
```

`RWS_CDN_NAME` goes in **with** `RWS_EDGE=tunnel`, in the same deploy (section 5), never earlier: set while the site is still direct, the privacy page would say that every request passes through Cloudflare when none does. From that deploy on the site answers only through the tunnel, and Cloudflare sees no visitor's request before the DNS switch (section 8), so the page names Cloudflare first before Cloudflare sees anyone (A§12.2). The owner approves the NL and EN text (E5) beforehand, from the PR (the e2e test renders both); section 5 checks the runtime config over loopback, section 8 the pages themselves.

`RWS_WG_ENDPOINT` is where the owner devices dial WireGuard (UDP 51820). A name that Cloudflare proxies cannot carry UDP, so `rws-wg-peer` refuses a value equal to `RWS_DOMAIN` or starting with `owner.`; use a separate DNS-only name or the address. **Choose the name so that it does not re-publish the home address under the site's own zone:** a name at a dynamic-DNS provider, or a non-guessable label, never an obvious one (`home.`, `vpn.`, `wg.`) in the `waterradar.io` zone. The home address stays discoverable anyway (DNS history of the old records, the WireGuard port), and a flood aimed at the home line bypasses Cloudflare (R-101, T-HOST-3). Without it `rws-wg-peer` keeps using `RWS_PUBLIC_IPV4`. Existing owner devices keep the endpoint in their config: re-issue one (`docs/runbooks/owner-device.md`) if the address changes.

## 5. Deploy in tunnel mode

Do sections 5 to 8 in one sitting. From the deploy on, the site is answered only through the tunnel, so it stays unreachable for visitors until the DNS switch.

```bash
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
sudo docker ps --format '{{.Names}} {{.Status}}' | grep -E 'cloudflared|caddy'
curl -s --resolve waterradar.io:80:127.0.0.1 http://waterradar.io/healthz
curl -s --resolve waterradar.io:80:127.0.0.1 http://waterradar.io/runtime-config.json | jq -r .cdn
```

Expected: the second `curl` prints `Cloudflare` (if it prints nothing, `RWS_CDN_NAME` is missing: do not switch the DNS); `rws-cloudflared-1` is `healthy` (its healthcheck is `cloudflared tunnel ready`, which needs a live connection to Cloudflare; a start period of 30 s applies), `rws-caddy-1` healthy, `/healthz` answers over plain HTTP on loopback. A deploy runs `up -d` without `--wait`: a `cloudflared` that cannot connect never rolls a release back, and `rws-tick` restarts it while it is unhealthy. If it stays unhealthy: `sudo docker logs rws-cloudflared-1 2>&1 | tail`. A refused token, an expired tunnel or a blocked 7844 shows there (the log carries no request data at `--loglevel info`).

## 6. Checks before the switch

```bash
sudo docker port rws-caddy-1                           # 80/tcp -> 127.0.0.1:80 and nothing else
sudo docker inspect rws-cloudflared-1 | grep -c 'TUNNEL_TOKEN='    # 0: the token is not in the environment
sudo nft list chain inet rws from_containers | grep 7844           # the one rule, from the tunnel bridge
sudo deploy/tests/hardening.sh --prod                              # reads RWS_EDGE from rws.env: with tunnel, cloudflared must run and caddy may publish only 127.0.0.1:80/tcp
```

In the Cloudflare dashboard the tunnel shows **one connector, healthy** (its connections to two Cloudflare locations are normal) and no second, unknown connector.

## 7. Ready to cut over

Before section 8 all of these hold: the tunnel is healthy (section 6); the runtime config names Cloudflare (section 5) and the privacy text is approved (E5, section 4); the TTL of the old records has been 60 seconds for a day (section 1); the router page, the Cloudflare dashboard and the DNS zone are open together. The time between the deploy and the DNS switch is the outage; prelaunch has no visitors to speak of.

## 8. The DNS switch

In the Cloudflare dashboard, for the zone `waterradar.io`:

1. Delete the DNS-only `A` and `AAAA` records of the apex (note their values: they are the rollback).
2. In the tunnel, add the public hostname `waterradar.io`, HTTP, `caddy:80` (section 2). The dashboard creates the **proxied** `CNAME` to the tunnel.
3. `dig +short waterradar.io` now returns Cloudflare addresses, not the home address. Wait for the TTL-60 records to expire.

```bash
curl -sI https://waterradar.io/ | grep -i -E '^(HTTP|server|strict|content-security)'
```

Expected: `HTTP/2 200`, `server: cloudflare`, the HSTS and CSP headers of A§12.2. Then open `https://waterradar.io/privacy` and `https://waterradar.io/en/privacy`: the CDN paragraph is the **first** section after the title, names Cloudflare and says that every request passes through it, that it sees every request with the visitor's address, that it caches only `/assets` and `/data`, and that it is a US company with transfers under the EU-US Data Privacy Framework. If it does not, roll back (section 10).

## 9. Verify, then close the router

```bash
scripts/verify-prod.sh waterradar.io --edge cloudflare
```

Expected: every check PASS except the known fresh-data FAILs already recorded for production, including the whole `edge` group (`edge headers`, `edge html`, `edge tile range`, `edge not cached`, `edge runtime config cdn`) and `owner listener`. In `--edge cloudflare` mode the `Server` header may be `cloudflare` (absent also passes; anything else fails), and the owner listener check passes on a refused or failed connection and on any edge answer that is neither 200 nor 401 and carries no `WWW-Authenticate` and none of the owner site's exact headers (`Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`; a Cloudflare error page sends `Cache-Control: private, max-age=0, no-store, …`, which is no owner sign); DNS must still show no public record for `owner.<domain>`. `edge not cached` passes only an absent `cf-cache-status`, `DYNAMIC` or `BYPASS` (`HIT`, `MISS`, `EXPIRED`, `STALE`, `UPDATING`, `REVALIDATED` or anything else fails) and also probes a missing `/assets` file. `edge runtime config cdn` wants `/runtime-config.json` to say exactly `Cloudflare` (the name that selects the Cloudflare privacy text; `cloudflare`, `Cloudflare, Inc.` or another name FAIL). Read the Cloudflare account's audit log for changes you did not make (section 1, item 5). The agent can run this command; the owner reads the result.

When it is green, **close the router**:

1. Remove the forwards of TCP 80, TCP 443 and UDP 443. **UDP 51820 (WireGuard) stays.**
2. Retire the LAN Caddy proxy.
3. Empty the proxy line in `rws.env` and reload the firewall sets (in tunnel mode Caddy ignores `RWS_TRUSTED_PROXIES`, but `rws-trusted-proxies` still exempts it from the connection cap in `nftables.conf`):

   ```bash
   sudoedit /etc/rws/rws.env      # RWS_TRUSTED_PROXIES=   (empty)
   sudo rws-trusted-proxies
   sudo nft list set inet rws trusted4                  # empty
   ```
4. From a network that is not the home line (a phone on mobile data), both of these must fail to connect within five seconds: `curl --connect-timeout 5 -I http://<home address>/` and `curl --connect-timeout 5 -I https://<home address>/`. That is the check that no inbound path to the origin is left (R-097).
5. **The KG-228 check** (`docs/runbooks/api.md` §6): make one request from a phone on mobile data, then

   ```bash
   sudo docker exec rws-caddy-1 cat /data/access/access.log \
     | jq -r 'select(.request.uri | startswith("/api/v1/")) | "\(.request.client_ip) \(.request.remote_ip)"' | sort | uniq -c | sort -rn | head
   sudo docker compose -p rws logs --since 24h api | grep -c limiter_gateway_key
   ```

   Expected: `client_ip` shows visitors' masked prefixes (/24 and /48), `remote_ip` shows `172.30.41.0` (the masked address of `cloudflared`), and `limiter_gateway_key` stays 0. Also assert that **no `client_ip` is a Cloudflare range** (the list at `cloudflare.com/ips`): if one is, Cloudflare's own hop is the last in `X-Forwarded-For` and the visitors collapse onto a few public addresses (check the Managed Transforms rows of section 3 and that nothing else sits in front of Cloudflare).

Raise the TTL back to 300 after a day of stable operation. HSTS preload (ADR-0020) is considered only after the tunnel has been stable for the revisit period of that ADR.

## 10. Roll back: tunnel → direct

Use this when the tunnel cannot be repaired quickly, when `NEL`/`Report-To` cannot be removed (section 3) or when Cloudflare is the problem.

1. **Reopen the router first:** forward TCP 80, TCP 443 and UDP 443 to the LAN proxy again (or to the host). In tunnel mode Caddy's Let's Encrypt certificate is **not renewed**, so if it has expired Caddy takes a new one by the HTTP-01 challenge on port 80: port 80 must reach the host.
2. In `rws.env` set `RWS_EDGE=direct` (leave `RWS_CDN_NAME` for now) and restore `RWS_TRUSTED_PROXIES` to the LAN proxy if one is used, then deploy and re-run the firewall sets:

   ```bash
   sudoedit /etc/rws/rws.env
   sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
   sudo rws-trusted-proxies
   sudo docker ps --format '{{.Names}} {{.Status}}' | grep -E 'cloudflared|caddy'
   ```

   `cloudflared` is gone: the overlay is no longer added and the deploy's `up -d --remove-orphans` removes its container. The two networks stay; remove them when you want them gone: `sudo docker network rm rws_tunnel rws_tunnel_edge`.
3. Wait for Caddy's certificate: `curl -sI --resolve waterradar.io:443:<host LAN address> https://waterradar.io/` from the LAN, and `sudo docker logs rws-caddy-1 2>&1 | tail`.
4. In the Cloudflare dashboard remove the tunnel's public hostname and the proxied `CNAME`, and restore the DNS-only `A` and `AAAA` records from section 8 (TTL 60 until stable, then 300).
5. Clear `RWS_CDN_NAME` (the privacy page must never be untrue in either direction) and redeploy once `dig +short waterradar.io` from two resolvers shows the home address again and Cloudflare's traffic is nil. Check that the privacy page again says that no CDN is used.
6. `scripts/verify-prod.sh waterradar.io` (default `--edge direct`, `Server` must be absent, the owner listener probes closed).

The tunnel in the dashboard may stay (idle) or be deleted. The token file may stay or be emptied in place (`: > file` with `sudo sh -c`); an empty file only matters if `RWS_EDGE=tunnel` is set again.

## 11. When the `edge` group fails

`scripts/verify-prod.sh <domain> --edge cloudflare` is the only drift check of the dashboard.

| Failing check | Meaning | Action |
|---|---|---|
| `edge headers` | `NEL`, `Report-To`, `Set-Cookie` or `Speculation-Rules` on `/` or `/en/` | Find the setting in section 3 that was switched on; if it is `NEL` or `Report-To` and a response-header transform rule cannot remove it, roll back (section 10) |
| `edge html` | The HTML holds `/cdn-cgi/`, `cloudflareinsights`, `rocket-loader`, `email-decode`, `challenge-platform`, `__cf_bm` or `beacon.min.js` | Switch off Rocket Loader, Email Obfuscation, Web Analytics or Bot Fight Mode; purge the cache for the HTML (it is not cached by default) |
| `edge tile range` | A `Range` GET of the current tile file is not a 206 with the exact `Content-Range` and 1024 bytes (n/a before the first basemap refresh) | Check cache rule 1 (`/tiles/*` bypass) is first and on |
| `edge not cached` | `/api/v1/health`, `/api/v1/meta`, `/status/capture.json`, a missing `/data/v1` file or a missing `/assets` file shows a `cf-cache-status` other than absent, `DYNAMIC` or `BYPASS` (`HIT`, `MISS`, `EXPIRED`, `STALE`, `UPDATING`, `REVALIDATED`), or the 404 is no 404 | Fail-closed on `NONE` and `UNKNOWN` too (Cloudflare answered by itself: a rule, a block or a challenge): find which setting or rule answered. Otherwise remove the cache rule that matches; cache rules 2 and 3 must be "use cache-control header if present, bypass cache if not"; never cache `/api`, `/status` or an error |
| `edge runtime config cdn` | `/runtime-config.json` has an empty `cdn`, or one that is not exactly `Cloudflare` | `RWS_CDN_NAME` is unset or misspelt; it must be exactly `Cloudflare`; section 4 |
| `owner listener` | The owner name answers on the edge with `WWW-Authenticate` or the owner site's exact headers (`Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`); a plain Cloudflare error page (404, 502, 530) is the safe state | Stop; check that no DNS record or tunnel route names `owner.<domain>` (incident: `docs/runbooks/owner-exposure.md`) |

## 12. Token rotation and what agents never do

- **Rotating the tunnel token:** `docs/runbooks/secrets-rotation.md` §6. A leaked token is rotated at once.
- Agents never log in to Cloudflare, never set `RWS_EDGE`, `RWS_CDN_NAME` or `RWS_WG_ENDPOINT`, never read or write `/etc/rws/secrets/cf_tunnel_token`, and never put a token on a command line or in `--token`/`TUNNEL_TOKEN` form anywhere (the compose test and `hardening.sh` fail on it).
