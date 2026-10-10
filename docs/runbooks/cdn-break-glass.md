# CDN break-glass (D20)

Pre-written, **not enabled**. It is armed only by decision D20: `docs/capacity.md` shows a flood-day peak above 50 % of the VPS uplink or a month above 50 % of the traffic quota, or the owner decides during a flood that bandwidth, not CPU, is the bottleneck. A pull zone in front of the **same public hostname** takes over the two static, licence-neutral trees `/tiles/*` and `/assets/*` and nothing else.

Never, in any variant of this runbook:

- **OpenFreeMap or any other third-party tile host.** The browser would call a third party (invariant 7) and the CSP would have to change (ADR-0016). There is no automatic switch.
- A CDN for the owner site, its hostname or its data. The owner hostname has no public DNS record and never gets one (invariant 11, ADR-0017).
- A second hostname for the assets. The browser keeps talking to one origin, so `connect-src 'self'` and the Playwright egress test stay as they are.

Agents never do this; it needs the registrar, the CDN account and the VPS (owner only). The privacy page and the log settings are part of the change, not a follow-up.

## 0. Before the decision (do once, ahead of time)

- Pick the provider on privacy terms, not price: EU processing, a signed data-processing agreement, no analytics, no log shipping to third parties, no cookies, no JavaScript injected into pages, IP truncation or short log retention. Write the CDN's name down; it goes on the privacy page (step 3).
- Get the provider's **published list of edge address ranges** (CIDRs, IPv4 and IPv6) and where they announce changes. They are needed for `RWS_TRUSTED_PROXIES` (step 2).
- Check that the provider can: cache by path pattern with everything else bypassing the cache, forward `Range` and `If-Range` to the origin and serve byte ranges from its cache (PMTiles), honour the origin's `Cache-Control`, never cache `4xx`/`5xx`, forward `/.well-known/acme-challenge/*` to the origin, and connect to the origin over HTTPS with certificate verification on.
- Keep the DNS panel login and the CDN login in the owner's password manager only (`docs/security/secrets.md`).

## 1. Lower the TTL first (a day ahead if possible)

At the registrar or DNS host, lower the TTL of the `A` and `AAAA` records of the public hostname to 60 to 300 seconds, **at least one old TTL before the switch**. Without this a rollback takes as long as the old TTL (often an hour or more) while the origin is being drowned.

## 2. Origin side (VPS), before DNS changes

1. **Trusted proxies.** Put the CDN's edge ranges in `/etc/rws/rws.env`: `RWS_TRUSTED_PROXIES=<cidr> <cidr> …` (space separated, IPv4 and IPv6). Without it every visitor looks like one CDN address: the per-client limiter would throttle everybody together and the masked access log would be useless. With it the public site reads `X-Forwarded-For` from those peers only and takes the right-most address that is not trusted (`docs/runbooks/api.md` §6, KG-228). A malformed value stops `caddy` at start, so run this step in a quiet hour.
2. **Privacy page.** In the same file set `RWS_CDN_NAME=<name of the CDN>` (at most 80 characters; no `{`, `}`, `#`, `"` or `\`). The privacy page then names the CDN **first**, before anything else it says about processing, and states that the CDN sees visitors' IP addresses and request paths for `/tiles/*` and `/assets/*`. If the page still says "no CDN" the change does not go live. Have the owner approve the text (E5).
3. Redeploy the current release so Caddy reads both values: `sudo rws-deploy "$(sudo cat /var/lib/rws/current)"`.
4. Check: `curl -s https://<domain>/runtime-config.json` shows `"cdn":"<name>"`; the privacy page in NL and EN names the CDN; `sudo docker logs rws-caddy-1 2>&1 | tail` shows no start error.
5. **CAA and certificates.** The origin keeps its Let's Encrypt certificate (`CAA 0 issue "letsencrypt.org"`). If the CDN issues its own edge certificate, add a `CAA` `issue` record for **its** certificate authority before the cut-over, and keep the Let's Encrypt one: Caddy renews through the ACME HTTP-01 challenge on port 80 of the origin, so the pull zone must forward `/.well-known/acme-challenge/*` uncached to the origin, and port 80 must still reach the VPS. The CDN connects to the origin by its public name over HTTPS with verification on (never "flexible" or unverified origin TLS).
6. The VPS firewall does not change; the origin stays reachable directly, which is the rollback path.

## 3. Pull zone

Create one pull zone; origin = the public hostname's VPS address (or an origin hostname that resolves only to the VPS), HTTPS, port 443, verification on, host header = the public hostname.

| Setting | Value |
|---|---|
| Cache | **only** paths `/tiles/*` and `/assets/*` of the public hostname; every other path bypasses the cache and is proxied as is (`/`, `/data/*`, `/api/*`, `/status/*`, `/runtime-config.json`, the pages, `/.well-known/*`) |
| Range | forward `Range` and `If-Range`; allow `206` responses to be cached by byte range or slice (PMTiles needs ranges; without it each tile request fetches the whole file) |
| Errors | never cache `4xx` or `5xx`, **in particular `404`, `429` and `503`** (the brownout and the limiter answer `503`/`429` for a reason, and a cached `503` would keep a recovered site down). No "serve stale on error" |
| Origin headers | honour the origin's `Cache-Control`/`ETag`; no TTL override, no query-string handling beyond the origin's (there are no query strings on these trees) |
| Compression | pass through (`precompressed` files are served by Caddy) |
| Other | no cookies set, no script injection, no image or HTML rewriting, no WAF challenge page on these paths, access logs off or minimal and short-lived at the CDN, HTTP/3 as you like |
| Hostname | the CDN serves the **public** hostname only; the owner hostname is never added, aliased or given a certificate |

Test the zone before any DNS change if the provider allows a test hostname or a `Host` override: a `206` for a PMTiles range (`curl -sI -r 0-1023 …`), a second identical request showing a cache hit (`Age`/`X-Cache`), a `404` under `/tiles/` not cached, and a request to `/api/v1/health` not cached.

## 4. Cut over

1. In the DNS panel replace the `A` and `AAAA` records of the public hostname with the CDN's `CNAME` (or the provider's anycast records). Keep the old addresses at hand in the owner's notes: they are the rollback.
2. Watch for ten minutes: `scripts/verify-prod.sh <domain>` (all PASS except the checks that talk to the VPS's own address and are marked as such), the status page, `/status/capture.json`, healthchecks (the `cert` check keeps probing the origin through the watchdog), the Caddy log (`client_ip` shows visitors' masked prefixes, `remote_ip` shows CDN ranges), and the egress graph or the provider traffic counter dropping.
3. Confirm the negatives: `https://owner.<domain>` still has no DNS record; `dig +short owner.<domain>` is empty; a request to the VPS's address with `Host: owner.<domain>` still gets no owner content (catch-all 421 or a failed handshake).
4. Record the date, the CDN and the ranges in `docs/risk-register.md` and `docs/known-gaps.md` (agent task via a PR).

## 5. While armed

- Refresh `RWS_TRUSTED_PROXIES` whenever the provider announces new ranges (subscribe to its notices; check monthly). A range missing from the list degrades gracefully but wrongly: visitors behind it share one limiter key.
- Keep the privacy page truthful: the CDN stays named while it serves traffic.
- The brownout (P12a) still works: Caddy raises the TTLs of mutable paths, which the CDN does not cache anyway; `/tiles/*` and `/assets/*` are immutable.

## 6. Rollback (the same day the pressure is gone, or at any sign of trouble)

1. In the DNS panel **delete the CDN `CNAME` record** and restore the original `A` and `AAAA` records. Because the TTL was lowered (step 1), clients return within minutes.
2. When `dig +short <domain>` from two resolvers shows the VPS addresses again and the CDN traffic is nil, disable the pull zone (or delete it) and remove the CDN's `CAA` record.
3. Clear `RWS_CDN_NAME` (and `RWS_TRUSTED_PROXIES`, unless another proxy of yours is still in front) in `/etc/rws/rws.env` and `sudo rws-deploy "$(sudo cat /var/lib/rws/current)"`. Check that the privacy page again says that no CDN is used, **after** the DNS change has propagated and not before: the page must never be untrue in either direction.
4. Raise the TTL back to its normal value after a day of stable operation.
5. Ask the provider to delete the logs it kept, in writing, and note the date.
