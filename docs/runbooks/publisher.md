# Runbook: the static publisher

**Trigger:**
- the healthchecks `publisher` or `owner-publisher` check is down (the watchdog pings `publisher` from the mtime of `/data/v1/meta.json`; `rws-tick` pings `owner-publisher` from the mtime of the owner `meta.json`);
- `scripts/verify-prod.sh <domain>` prints `FAIL static <class>` (`static meta`, `latest`, `stations`, `sources`, `recent`, `settled`, `frames`, `forecast`, `series`, `warnings`, `status`, `precompressed`, `lag`, `rerender`) or `FAIL runtime config`.

The publisher (`publish`, role `rws_publish`) writes the public files under `/srv/rws/public/www/v1` (`/data/v1/...`, served by Caddy read-only); `publish-owner` (role `rws_owner_api`) writes `/srv/rws/owner/www/v1`. Each cycle ends with `meta.json`, so a fresh `meta.json` means the cycle finished. Where a file is missing or `meta.dayVersions` says 0, the web reads the API instead, so a publisher outage degrades the site and does not stop it.

The API that answers where no file exists (its limits, 429 and 503 answers, saturation and the owner API) has its own runbook: `docs/runbooks/api.md`.

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
| `FAIL runtime config` | The detail names the field and never its value (the operator's name is personal data). `operator is empty`: `RWS_OPERATOR_NAME` is not set in `/etc/rws/rws.env` (P10b). `contact is not an e-mail address`, `cdn is longer than 80 characters`, `operator holds one of { } # " \ < > or a control character`, `no <key>` or `1 unexpected key`: a value in `rws.env` that breaks the JSON Caddy builds from it, or `deploy/web/site.caddy` (a hand edit, or a wrong release) | Fix the line in `/etc/rws/rws.env` (`docs/runbooks/bootstrap.md` §4: none of the three values holds `{ } # " \`), then `sudo rws-deploy "$(sudo cat /var/lib/rws/current)"`; for the file itself, redeploy the release (`docs/runbooks/deploy-rollback.md`) |

## 2. Re-render one settled day

A settled day (older than 48 h plus its own day) is written once per version. To render it again, delete its completion marker; the next cycle renders it and its frames file again (one day per cycle). The render is deterministic: the same version and the same bytes, so the web's caches stay valid.

```bash
sudo ls /srv/rws/public/www/.state | grep 2026-09-20          # settled-2026-09-20-v1.done
sudo rm /srv/rws/public/www/.state/settled-2026-09-20-v1.done
```

A new version appears by itself when a correction older than 48 h or a registry change reaches the day (`meta.dayVersions`). Each version's files are immutable; a superseded version is deleted one hour after its successor completed (`meta.json` meanwhile names the newest complete one), or at once when the registry *narrowed* the day (a series gone or its history export off): then `meta.dayVersions` says 0 for each such day until it is re-rendered, one day per cycle, and the web reads those days from the API. A deploy that narrows a series therefore shifts settled-day traffic to `/api/v1/snapshot` for about one minute per settled day (about 45 minutes; `status.json` `publisher.pendingDays` counts down). A series that becomes visible with data older than 48 h bumps every settled day too (reason `registry`). **After the release of #112 (frames schema 2, a state code per hour):** `migrate` bumps the public days of the last 16 once (reason `schema`, meta key `frames_schema:public`; its log line says `frames schema bump N day(s)`, and a database that was never migrated before bumps nothing). Expect `pendingDays` about 14 and counting down by one a cycle (about 14 cycles; each day also re-renders its 144 snapshot files, so a cycle is slower than usual), with `meta.dayVersions` moving up one day at a time. This is normal: the old complete version of a day stays named and served until its successor completes, so the web never falls back to the API for it; meanwhile that day's frames are version 1 and the State mode shows no data for its hours (Δh and Q play as before). Days older than the 16 stay version 1. A second `migrate` bumps nothing. A browser tab still running the bundle of before the release cannot parse the new frames (schema 2) and plays no hours until it is reloaded; snapshots are unaffected. `FAIL static rerender` (the last day render took 60 s or more): look at `status.json` `publisher.lastDayRender` and the host load.

## 3. Full rebuild

Only when the tree is damaged or a contract change needs every file new.

```bash
sudo docker compose -p rws stop publish
sudo find /srv/rws/public/www/v1 /srv/rws/public/www/.state -mindepth 1 -delete
sudo docker compose -p rws up -d publish
```

`meta.json` is written last, so it is absent until the first cycle completes, and then lists 0 for a settled day with no complete file yet (the web uses the API meanwhile; `FAIL static ...` is expected). Recent files come first; then about one settled day per minute, so a year takes about 6 hours and `status.json` `publisher.pendingDays` counts down. The `publisher` healthcheck recovers with the first `meta.json`.

## 4. The owner publisher

`publish-owner` writes `/srv/rws/owner/www/v1` only (its one public mount, `/srv/rws/public/data/v1/rivers` at `/srv/rivers`, is read-only: P11a): no settled, frames or dated warnings files, and `dayVersions` is its own sparse map. Its healthcheck `owner-publisher` reads only the mtime of that `meta.json`, so it needs the owner overlay (`deploy/compose.owner.yaml`) running. The owner site (`owner.<domain>`, `caddy-owner`) stays off in production until P12a (no `owner_basic_auth` secret; bootstrap does not create it). Everything above applies with the owner tree and `docker compose -p rws logs publish-owner`; `verify-prod.sh` never reads the owner tree, and nothing owner-side may be copied to the public tree.

### The owner variant of the reaches file (P11a)

Besides the hot-path files, `publish-owner` writes `/srv/rws/owner/www/v1/rivers/reaches-<ver>.json` (with `.zst` and `.gz`): the installed river release split at the owner stations, so that the "Stroomopwaarts / Upstream" chain of the owner view shows the SPW (BE-3) gauges (A§9.3, `docs/plan/PHASES.md` §35). It reads `manifest.json` and the reaches file of `current` and `previous` from `/srv/rivers` (the public rivers directory, read-only, `RWS_RIVERS_DIR`), checks them against the manifest, and rewrites the variant only when the release or the owner station set changed. Nothing here is a cycle failure: the step logs a fixed code **once per process** (per release for a reaches-file code, with its `version`) and leaves the files as they are, and `owner.caddy` serves the public `reaches-<ver>.json` when the variant is absent, so the owner chain then shows the public stations only. Look with:

```bash
sudo docker compose -p rws logs publish-owner | grep -E 'rivernet_|rivers_(manifest|reaches)_|owner_reaches_invalid'
sudo ls -l /srv/rws/owner/www/v1/rivers/        # reaches-<ver>.json for current and previous, nothing else
```

| Log code | Meaning | What the owner does |
|---|---|---|
| `rivernet_missing` | `registry/rivernet.yaml` is not in the server image | Wrong image: `rws-update` to the current release; a rebuild of the image if it persists (the file is generated, `node scripts/gen-rivernet.ts`) |
| `rivernet_invalid` | `rivernet.yaml` does not parse or fails its schema | Same; never edit the file by hand (KG-164: it is generated from the committed fixture) |
| `rivers_manifest_missing` | `/srv/rivers/manifest.json` does not exist | No river release is installed yet or the mount is wrong: `sudo ls /srv/rws/public/data/v1/rivers`; install with `deploy/bin/rws-rivers-refresh` (`docs/runbooks/geo-refresh.md`); check `docker inspect` shows `/srv/rws/public/data/v1/rivers -> /srv/rivers rw=false` |
| `rivers_manifest_unreadable` | The manifest cannot be opened as a regular file within its size cap (a link, a directory, over 64 KiB, a permission error) | Look at the file's type, mode and owner on the host; the host script writes it, a plain root-owned file; re-run `rws-rivers-refresh --dry-run` |
| `rivers_manifest_invalid` | The manifest is not valid JSON of the `RiversManifest` schema | Re-run `rws-rivers-refresh` (it rewrites the manifest) or `--rollback`; do not edit the file |
| `rivers_reaches_missing` | The manifest names a reaches file that is not there | The directory and manifest disagree: re-run `rws-rivers-refresh`; a missing `previous` after `--rollback` is the same |
| `rivers_reaches_unreadable` | The reaches file is not a regular file, is over 32 MiB or its size differs from the manifest | Same as the manifest case; the sizes are in the manifest (`bytes`) |
| `rivers_reaches_mismatch` | The file's sha256 differs from the manifest | A partial write or a swapped file: treat as a security event (T-GEO-6, T-PUB-4); do not copy it; re-run `rws-rivers-refresh` with its cosign verification, and look at who wrote the directory |
| `rivers_reaches_invalid` | The file hashes right but fails the strict `ReachesFile` schema, `checkReaches` or the manifest's version | A geo release the web and server disagree on: open an issue with the version; `rws-rivers-refresh --rollback` to the previous release meanwhile |
| `owner_reaches_invalid` | The split result fails the owner contract (`checkOwnerReaches`): a bug in `splitReaches`, not data | Open an issue with the release version and the log line; the public file keeps being served |

When the manifest disappears or no release verifies, the last variant written stays served until a release verifies again (stale but owner-only); when one of two releases fails, only the failed one's variant is removed, and the owner site serves the public file of that name. The variant is retried every cycle after a failure, and a log code appears once per process (per code and release), so restart the service (`sudo docker compose -p rws restart publish-owner`) to see a repeated failure again. A skipped station (`owner_reach_ambiguous`, `owner_reach_unplaced`) is not logged: it only has no chain row (KG-267). The mount is read-only: `publish-owner` cannot change the public rivers directory, and the public site never serves the variant.

## 5. Disk

The settled and frames files grow about 3 to 4 GB a year (not yet measured in production); `status.json` `publisher.settledBytes` counts every file under `settled/` and `frames/`, the `.zst` and `.gz` siblings included, as `du` does. The recent files are bounded (about 72 h).

```bash
curl -s https://<domain>/data/v1/status.json | jq '.publisher.settledBytes'
sudo du -sh /srv/rws/public/www/v1/{recent,settled,frames,series}
```

`/srv/rws/public/www` is rebuildable from the database (§3), so it is the first thing to empty in an emergency (`docs/runbooks/disk-full.md`); the web then uses the API.

## 6. A link in a tree

The publishers never make a link (their temp files are `O_EXCL|O_NOFOLLOW`, then renamed). `rws-tick` removes any link it finds under `/srv/rws/public/www` or `/srv/rws/owner/www` every ten minutes, logs `removed N link(s) under …` and fails `publisher` or `owner-publisher` with `links`. Treat it as code running in that publisher: stop the service (`docker compose stop publish`), keep the container's logs, rebuild the tree (§3) from a fresh release, and look at what changed (`docs/threat-model.md` T-PUB-1).

## After this release

Run `deploy/host/bootstrap.sh` again once: it creates the `www`, `www/v1`, `www/.tmp` and `www/.state` trees (public and owner) and the two new healthchecks (`publisher`, `owner-publisher`).
