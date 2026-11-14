# Runbook: the stats stack (Umami at stats.waterradar.io, #270, ADR-0024)

**Trigger:**
- first install of the `stats` compose project on the VM (sections 1 to 7);
- the [agent-prod] or owner checks of section 8, after an install, an update or a reboot;
- an update of the Umami, PostgreSQL or cloudflared image (section 9, D4);
- the stack is to be removed (section 10).

An [owner] task: it needs the owner's workstation (Cloudflare), the VM and a WireGuard peer. Agents have no production access and no peer. Design and reasons: `docs/adr/0024-self-hosted-statistics-umami.md`; threats: `docs/threat-model.md` v4.90; risks R-111 to R-117; gaps KG-508 to KG-512.

What it is: the compose project `stats` (`deploy/stats/compose.yaml`) with Umami, its own PostgreSQL 18 and its own cloudflared. The tunnel routes `^/api/send$` only (`deploy/stats/cloudflared.yml`); the dashboard and `/mcp` listen on `10.66.0.1:8444`, from a WireGuard peer only (D1). Its host files are installed by hand, not by `bootstrap.sh`: they live in `deploy/stats/` so that `rws-update` never sees them. The stack has no backup, no healthcheck ping and no tick (D2); the history stays until the owner deletes it (D3).

A shell on the VM cannot reach `10.66.0.1:8444`: the rws prerouting rules drop the replies. Every check of the dashboard runs from a WireGuard peer.

## 1. The tunnel (owner's workstation)

On the owner's workstation, logged in to the Cloudflare account (`cloudflared tunnel login`):

```bash
cloudflared tunnel create stats
cloudflared tunnel route dns stats stats.waterradar.io
cloudflared tunnel token stats    # put the output in the password manager; it becomes /etc/stats/secrets/cf_stats_tunnel
```

Never migrate this tunnel to the dashboard ("remotely managed"): its remote configuration would replace the repository's ingress and could route more than `/api/send`. The tunnel stays locally managed; the token only authenticates the connector. Whoever holds it can run a connector and receive the `/api/send` traffic (as R-105 for the rws token): if it leaks, delete the tunnel (`cloudflared tunnel delete stats`), repeat this section and replace the file of section 3.

## 2. Install the files from a reviewed commit

On the VM, from a checkout of the reviewed commit (a release directory, or `git archive`), as root:

```bash
install -d -m 0755 /etc/stats
install -m 0644 deploy/stats/compose.yaml /etc/stats/compose.yaml
install -m 0644 deploy/stats/cloudflared.yml /etc/stats/cloudflared.yml
install -m 0644 deploy/stats/nftables-stats.conf /etc/stats/nftables-stats.conf
install -m 0755 deploy/stats/stats-resolvers.sh /usr/local/bin/stats-resolvers
install -m 0644 deploy/stats/stats-firewall.service deploy/stats/stats-resolvers.service deploy/stats/stats-resolvers.path /etc/systemd/system/
systemctl daemon-reload
```

## 3. The secrets and the data directory

Each secret is a file, readable by its consumers' group only (nothing else is a secret; the compose file holds none). Use hex so the database password needs no URL encoding:

```bash
install -d -m 0700 /etc/stats/secrets
openssl rand -hex 32 | install -m 0440 -o root -g 63001 /dev/stdin /etc/stats/secrets/db_umami
openssl rand -hex 32 | install -m 0440 -o root -g 63002 /dev/stdin /etc/stats/secrets/umami_app_secret
# the tunnel token of section 1, pasted on stdin then Ctrl-D (never an argument, never in shell history):
install -m 0440 -o root -g 63003 /dev/stdin /etc/stats/secrets/cf_stats_tunnel
install -d -m 0700 -o 999 -g 999 /srv/stats/pgdata
stat -c '%n %a %u:%g' /etc/stats/secrets/* /srv/stats/pgdata
```

Only dockerd (root) opens the files, so the directory stays 0700; each container sees its own files with these owners and modes. Expected: `db_umami 440 0:63001`, `umami_app_secret 440 0:63002`, `cf_stats_tunnel 440 0:63003`, `/srv/stats/pgdata 700 999:999`.

## 4. The rws bootstrap re-run (the one rws line)

`deploy/host/nftables.conf` now lists `stats-publish` in its wg0 forward line, so a WireGuard peer can reach the published port (ADR-0024, R-117). It reaches the host only through the rws bootstrap, from the verified release directory, run twice (`docs/runbooks/bootstrap.md`, "a new release with changed host files"; the second run must say "0 change(s)"):

```bash
sudo /usr/local/lib/rws/deploy/host/bootstrap.sh
sudo /usr/local/lib/rws/deploy/host/bootstrap.sh
sudo nft list chain inet rws forward | grep wg0    # the line ends: oifname != { <owner bridge>, "stats-publish" } drop
```

Until it has run, `rws-update` pings `update` with `/fail` and `host_files_changed`; that is the rws file, not a stats one.

## 5. Enable the firewall and the resolver set

```bash
systemctl enable --now stats-firewall.service stats-resolvers.service stats-resolvers.path
nft list table inet stats
nft list set inet stats resolvers4
systemctl status stats-firewall.service --no-pager
```

Expected: one `table inet stats` with the sets `resolvers4` and `cftunnel4` and the chains `input`, `forward`, `from_stats` and `to_stats`; `resolvers4` holds the host's resolver addresses. `nft list tables` shows `inet rws` and `inet stats`, and rws-firewall.service is unchanged. Do this before section 6, so the containers never run unfiltered.

## 6. Start the stack

```bash
docker compose -f /etc/stats/compose.yaml up -d
docker compose -f /etc/stats/compose.yaml ps
docker compose -f /etc/stats/compose.yaml logs --no-log-prefix umami | tail -20
```

Expected: `db`, `umami` and `cloudflared` `running (healthy)`. The first start runs Umami's migrations (U1, KG-508); wait for `umami` to turn healthy.

## 7. First login, the website and the optional MCP key

From a WireGuard peer, open `http://10.66.0.1:8444`:

1. Log in as `admin` / `umami` and **replace the password at once** (Profile, Password). The default is created by the first migration; until it is changed, any peer can log in (R-113).
2. Settings, Websites, add `waterradar.io`. Its **website ID** goes to part B of #270 (the tracker); it is not a secret.
3. Optional, for MCP: Settings, API keys, create a key. Use it as the bearer token at `http://10.66.0.1:8444/mcp`. The key is a general Umami API credential (R-115): keep it in the password manager only, and delete it in the dashboard if it leaks.

## 8. Checks

[agent-prod], from outside, no login:

```bash
for p in / /login /mcp /api/auth/login /script.js; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "https://stats.waterradar.io$p"   # every one: 404
done
curl -s -o /dev/null -w "send GET %{http_code}\n" https://stats.waterradar.io/api/send                 # 405 from Umami: the path reaches it
curl -s -i -X OPTIONS https://stats.waterradar.io/api/send | grep -i '^access-control\|^HTTP'          # the CORS answer (U2)
```

[owner], on the VM, after every install, update and **every reboot** (R-116: the firewall fails open if its unit fails):

```bash
nft list table inet stats | head -3
systemctl is-active stats-firewall.service stats-resolvers.path
docker compose -f /etc/stats/compose.yaml logs --no-log-prefix cloudflared | grep -i 'protocol=http2\|Registered tunnel connection'
docker inspect $(docker compose -f /etc/stats/compose.yaml ps -q) --format '{{.Name}} user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} caps={{.HostConfig.CapDrop}} mem={{.HostConfig.Memory}} pids={{.HostConfig.PidsLimit}}'
docker port $(docker compose -f /etc/stats/compose.yaml ps -q umami)    # only 10.66.0.1:8444
```

Expected: the table exists; cloudflared's log shows http2 connections (U5); each container has a numeric user, a read-only root, `[ALL]` dropped and memory and PID limits.

[owner], from a WireGuard peer (U7, U8):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://10.66.0.1:8444/api/heartbeat    # 200
curl -s -o /dev/null -w "%{http_code}\n" http://10.66.0.1:8444/mcp               # 401 without a key
```

If `table inet stats` is missing after a boot, run `systemctl restart stats-firewall.service`, then `docker compose -f /etc/stats/compose.yaml up -d --force-recreate` so the containers restart behind the table (KG-510).

## 9. Update by digest (D4)

Nothing updates itself, and the stats images are outside the rws Grype gate (KG-509).

1. Choose a release at least 7 days old (the repository's release-age rule), and read its notes for a migration.
2. Open a repository PR that changes the pin in `deploy/stats/compose.yaml` and the BOM row in `CLAUDE.md` (digest of the index, not a tag). CI (`pnpm check`, the `stats` job) must be green.
3. Scan the new image by hand before installing, for example `grype <image>@sha256:<digest>` from the owner's workstation, and read the High and Critical findings. Record an accepted one in `docs/risk-register.md`.
4. There is no backup. Before a release that migrates, an optional dump by hand:

   ```bash
   docker compose -f /etc/stats/compose.yaml exec -T db pg_dump -U umami umami | gzip > ~/stats-$(date -u +%Y%m%d).sql.gz
   ```

5. Install the new compose file and recreate:

   ```bash
   install -m 0644 deploy/stats/compose.yaml /etc/stats/compose.yaml
   docker compose -f /etc/stats/compose.yaml pull
   docker compose -f /etc/stats/compose.yaml up -d
   docker compose -f /etc/stats/compose.yaml ps
   ```

6. Repeat the checks of section 8. Reinstall the other files of section 2 only if the PR changed them, then `systemctl reload stats-firewall.service`.

## 10. Removal

```bash
docker compose -f /etc/stats/compose.yaml down
systemctl disable --now stats-firewall.service stats-resolvers.service stats-resolvers.path
nft delete table inet stats
rm -f /etc/systemd/system/stats-firewall.service /etc/systemd/system/stats-resolvers.service /etc/systemd/system/stats-resolvers.path /usr/local/bin/stats-resolvers
systemctl daemon-reload
rm -rf /etc/stats /srv/stats    # this deletes the history for good (D3)
```

Then, on the owner's workstation, `cloudflared tunnel delete stats` and remove the DNS record `stats.waterradar.io` in the Cloudflare dashboard. Last, a repository PR reverts the rws line (`stats-publish` out of the wg0 forward line of `deploy/host/nftables.conf`, and the tests that pin it), followed by an rws bootstrap re-run as in section 4. Until then the rws table names a bridge that no longer exists, which is harmless (R-117).
