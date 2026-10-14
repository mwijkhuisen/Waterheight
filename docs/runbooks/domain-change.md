# Runbook: change the public domain to waterradar.io (rollout step 1 of #109)

**Trigger:**
- the owner moves the public site from the old `rk.` host name to `waterradar.io`, still in direct mode (Caddy on the home line, the router's forwards);
- it comes **before** `docs/runbooks/edge-switch.md`, which puts the tunnel on the new name;
- or neither: `docs/runbooks/cutover-waterradar-tunnel.md` does both in one sitting, without this direct-mode stop on the new name.

An [owner] task: it needs the DNS zone, the router and the VPS. No code changes: every absolute URL of the site (robots, sitemap, `security.txt`, `og:image`) is built from `RWS_DOMAIN` when Caddy loads its config. The zone `waterradar.io` has been on Cloudflare since registration (owner, 2026-10-12, nameservers at Cloudflare); records there stay **DNS-only (grey cloud)** in this step.

## 1. DNS records

In the Cloudflare DNS panel of `waterradar.io`:

1. `A` and `AAAA` for the apex `waterradar.io` → the home line's public addresses (`RWS_PUBLIC_IPV4` and `RWS_PUBLIC_IPV6` of `/etc/rws/rws.env`, or the router's address if only IPv4), **DNS-only (grey)**, TTL 300.
2. `CAA 0 issue "letsencrypt.org"` on the apex (ADR-0020): Caddy takes its certificate from Let's Encrypt by the HTTP-01 challenge on port 80.
3. **No record for `owner.waterradar.io`** and no wildcard. The owner site resolves only through the WireGuard client config or a hosts entry (A§11.5, invariant 11).

```bash
dig +short A waterradar.io
dig +short AAAA waterradar.io
dig +short CAA waterradar.io
dig +short owner.waterradar.io          # empty
```

## 1a. DNSSEC (before the proxied switch)

A§12.2 asks for DNSSEC where the registrar supports it. Do it now, in direct mode, so that a problem is not mixed up with the tunnel switch: enable DNSSEC for the zone in the Cloudflare dashboard (DNS, Settings), add the DS record it shows at the registrar (unless Cloudflare is the registrar, in which case it does that itself), and check that the chain validates:

```bash
dig +dnssec +short DS waterradar.io @1.1.1.1
delv waterradar.io A @1.1.1.1            # "fully validated"
```

A wrong or missing DS record makes validating resolvers refuse the name: remove the DS record at the registrar to undo it.

## 2. The LAN proxy and the router

The site still reaches the host through the LAN Caddy proxy and the router's forwards (KG-228). Add the hostname `waterradar.io` to the proxy so that it forwards it to the host, and keep `RWS_TRUSTED_PROXIES` as it is (the proxy's address, `docs/runbooks/api.md` §6). The forwards of TCP 80 and 443 (and UDP 443) stay as they are; port 80 must reach Caddy for the certificate.

## 3. The host

```bash
sudoedit /etc/rws/rws.env      # RWS_DOMAIN=waterradar.io
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"
sudo docker logs rws-caddy-1 2>&1 | grep -i -E 'certificate obtained|error' | tail
```

Caddy obtains a certificate for `waterradar.io` as soon as it reloads and a request for the name arrives (the HTTP-01 challenge on port 80). The deploy's smoke test uses the new domain; it passes when the certificate is in place. If the deploy rolls back on the smoke test, the certificate is the usual cause: check the `A` record, the forward of port 80 and the CAA record, then deploy again.

The other consumers of `RWS_DOMAIN` follow by themselves after that deploy: the watchdog's probes (`healthchecks` `cert` and `watchdog`), the nightly contract check's variable `RWS_DOMAIN` in GitHub (`docs/github-settings.md`: update the repository variable too) and the User-Agent's information URL of the capture role. `scripts/record-frames.ts` now records from `https://waterradar.io` (a constant in the script; the recorded fixture metas keep their historical `rk.` URLs).

## 4. The owner site

The owner site becomes `owner.waterradar.io`: its Caddy site address and certificate follow `RWS_DOMAIN` (`tls internal`, the local CA; the root certificate on the owner's devices stays valid). On each owner device the name for `10.66.0.1` changes (the hosts entry or the WireGuard client config's DNS), `docs/runbooks/owner-device.md`:

```bash
sudo rws-wg-peer list
scripts/verify-owner.sh waterradar.io --cacert owner-root.crt
```

Run the second command from an owner device with the tunnel up. There is still no public record for the owner name.

## 5. Verify

```bash
scripts/verify-prod.sh waterradar.io
```

Expected: the same result as for the old name (prelaunch profile: `noindex` everywhere, no `robots.txt` or sitemap). `runtime config` still needs `RWS_OPERATOR_NAME`. The old name answers Caddy's catch-all 421 from now on (the site address no longer matches it); retire it: remove its DNS records and the proxy entry (prelaunch, noindex, no audience, so no redirect is kept).

## 6. Afterwards

- HSTS preload (ADR-0020) is **not** requested for the new name before the tunnel (`docs/runbooks/edge-switch.md`) has been stable for the revisit period of that ADR.
- The next step is `docs/runbooks/edge-switch.md`; its prerequisite is that this runbook is done and `scripts/verify-prod.sh waterradar.io` is green.
- Rollback: `RWS_DOMAIN` back to the old name, the proxy entry for it restored, deploy; the old DNS records are the ones you did not delete yet, so do not delete them before step 5 has passed.
