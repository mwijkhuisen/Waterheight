# Runbook: the static publisher

**Trigger:**
- the healthchecks `publisher` or `owner-publisher` check is down (the watchdog pings `publisher` from the mtime of `/data/v1/meta.json`; `rws-tick` pings `owner-publisher` from the mtime of the owner `meta.json`);
- `scripts/verify-prod.sh <domain>` prints `FAIL static <class>` (`static meta`, `latest`, `stations`, `sources`, `recent`, `settled`, `frames`, `forecast`, `series`, `warnings`, `status`, `precompressed`, `lag`, `rerender`) or `FAIL runtime config`.

The publisher (`publish`, role `rws_publish`) writes the public files under `/srv/rws/public/www/v1` (`/data/v1/...`, served by Caddy read-only); `publish-owner` (role `rws_owner_api`) writes `/srv/rws/owner/www/v1`. Each cycle ends with `meta.json`, so a fresh `meta.json` means the cycle finished. Where a file is missing or `meta.dayVersions` says 0, the web reads the API instead, so a publisher outage degrades the site and does not stop it.

## 1. The publisher, the loader or Caddy?

```bash
curl -s https://<domain>/data/v1/status.json | jq '{publisher, loader}'   # publisher.cycleAt, cycleSeconds, pendingDays; loader.lastCommit
curl -s https://<domain>/data/v1/meta.json | jq '{generatedAt, latestFrom, degraded}'
curl -s https://<domain>/api/v1/health | jq '.loader.last_commit'
sudo docker compose -p rws logs --since 30m publish | tail -n 50    # fixed codes only, never provider text
```

| You see | Meaning | Do |
|---|---|---|
| `publisher.cycleAt` and `meta.generatedAt` older than about 10 minutes | The publisher does not finish cycles (stopped, crashed, or a step fails: the log names the step code) | `sudo docker compose -p rws ps publish`; restart it (`up -d publish`); a repeating code is a bug: keep the log |
| `cycleAt` fresh, `health.loader.last_commit` older than 15 minutes | The loader stalled, not the publisher | `docs/runbooks/recorder-down.md` and the `load` logs |
| `last_commit` fresh, `meta.latestFrom` more than 120 s behind it (`FAIL static lag`) | The publisher is behind: `meta.degraded` true, `pendingDays` above 0 or a slow cycle (`cycleSeconds`) | Wait one cycle; if it stays, check the host load and the database (`docs/runbooks/disk-full.md`) |
| Files fresh on disk (`ls -l /srv/rws/public/www/v1/meta.json`) but a wrong status, Cache-Control or type from the site | Caddy or its mount | `docker compose -p rws logs caddy`, `caddy validate`; `FAIL static precompressed` with a fresh file: the `.zst` or `.gz` beside it is missing or stale |
| `FAIL runtime config` | `deploy/web/site.caddy` (a hand edit, or a wrong release) | Redeploy the release (`docs/runbooks/deploy-rollback.md`) |

## 2. Re-render one settled day

A settled day (older than 48 h plus its own day) is written once per version. To render it again, delete its completion marker; the next cycle renders it and its frames file again (one day per cycle). The render is deterministic: the same version and the same bytes, so the web's caches stay valid.

```bash
sudo ls /srv/rws/public/www/.state | grep 2026-09-20          # settled-2026-09-20-v1.done
sudo rm /srv/rws/public/www/.state/settled-2026-09-20-v1.done
```

A new version appears by itself when the registry or a correction changes the day's data (`meta.dayVersions`; the old version's files stay, immutable). `FAIL static rerender` (the last day render took 60 s or more): look at `status.json` `publisher.lastDayRender` and the host load.

## 3. Full rebuild

Only when the tree is damaged or a contract change needs every file new.

```bash
sudo docker compose -p rws stop publish
sudo find /srv/rws/public/www/v1 /srv/rws/public/www/.state -mindepth 1 -delete
sudo docker compose -p rws up -d publish
```

`meta.json` is written last, so it is absent until the first cycle completes, and then lists 0 for a settled day with no complete file yet (the web uses the API meanwhile; `FAIL static ...` is expected). Recent files come first; then about one settled day per minute, so a year takes about 6 hours and `status.json` `publisher.pendingDays` counts down. The `publisher` healthcheck recovers with the first `meta.json`.

## 4. The owner publisher

`publish-owner` writes `/srv/rws/owner/www/v1` only: no settled, frames or dated warnings files, and `dayVersions` is its own sparse map. Its healthcheck `owner-publisher` reads only the mtime of that `meta.json`, so it needs the owner overlay (`deploy/compose.owner.yaml`) running. The owner site (`owner.<domain>`, `caddy-owner`) stays off in production until P12a (no `owner_basic_auth` secret; bootstrap does not create it). Everything above applies with the owner tree and `docker compose -p rws logs publish-owner`; `verify-prod.sh` never reads the owner tree, and nothing owner-side may be copied to the public tree.

## 5. Disk

The settled and frames files grow about 3 to 4 GB a year (plain files plus their `.zst` and `.gz` siblings are counted by `du`, `status.json` `publisher.settledBytes` counts the plain ones). The recent files are bounded (about 72 h).

```bash
curl -s https://<domain>/data/v1/status.json | jq '.publisher.settledBytes'
sudo du -sh /srv/rws/public/www/v1/{recent,settled,frames,series}
```

`/srv/rws/public/www` is rebuildable from the database (§3), so it is the first thing to empty in an emergency (`docs/runbooks/disk-full.md`); the web then uses the API.

## After this release

Run `deploy/host/bootstrap.sh` again once: it creates the `www`, `www/v1`, `www/.tmp` and `www/.state` trees (public and owner) and the two new healthchecks (`publisher`, `owner-publisher`).
