# Runbook: the disk fills up

**Trigger:** the `disk` check (`/srv/rws` ≥ 75%, from `/status/ops.json` `disk_pct`, refreshed every 10 min by `rws-tick`), or `ENOSPC` in a log. At 100% capture cannot write, and data is lost for good.

## 1. What grows

```bash
df -h /srv/rws /var/lib/docker
sudo du -xh --max-depth=2 /srv/rws | sort -h | tail -n 15
sudo du -sh /var/lib/docker/{containers,overlay2,volumes} 2>/dev/null
sudo docker system df
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "SELECT pg_size_pretty(pg_database_size('rws'))"   # the database (P2a), in the pgdata volume
```

## 2. Quick, safe space

| Where | Command | Safe because |
|---|---|---|
| Old images | `sudo docker image prune -a -f` | Deploys pull by digest again when needed (`rws-update` already removes images no kept release references) |
| Container logs | `sudo journalctl --vacuum-time=7d`; Docker's `local` driver keeps 5 × 20 MB per container | Logs only |
| Restic cache | `sudo find /srv/rws/backup/cache -mindepth 1 -delete` | Rebuilt on the next run |
| Drill scratch | `sudo find /srv/rws/backup/drill -mindepth 1 -delete` | Always temporary |
| Basemap staging (P3) | `sudo find /srv/rws/tiles/.staging -mindepth 1 -delete`, while no basemap refresh runs (`sudo docker ps --filter name=basemap`) | The leftovers of an interrupted fetch; the next refresh empties it first anyway (an extract that waits for a failed `promote` is lost with it: a fetch again). The rest of `/srv/rws/tiles` is not spare: the current and the previous extract take about 9 GB, so never delete a file that `manifest.json` names (`docs/runbooks/basemap.md`) |

**Never** delete anything under `/srv/rws/raw` by hand. Retention pruning of the obs window belongs to the pruner of the `load` role (§4), which is a dry run until you switch it on, and a forever class is never pruned. Never drop or detach database partitions to save space (`docs/runbooks/partition-maintenance.md`). Check first that the last backup is fresh (`/status/ops.json` `last_backup` < 1 h).

## 3. Lasting fixes

- Grow the volume at the provider (A3), then `resize2fs`.
- Compare with `docs/capacity.md` (the measured bytes per day and the year-1 projection). If one spec dominates (NRW `messwerte.zip`), switch it to a smaller delta source in a PR (PHASES §P1 risks).

## 4. The retention pruner (`load`, from P2a)

It frees space in the raw archive by deleting parsed observation objects that have left the 90-day hot window. It runs inside the nightly job of `load` (once a UTC day after 02:00; the day is kept in the database, so a restart does not run it again), and reads the manifest one day at a time.

**A dry run is the default: it only counts.** It deletes nothing unless the `load` container has `RWS_PRUNE_APPLY=1`. That is a change to the `load` service's `environment` in `deploy/compose.yaml`, made through a PR and a release after you have read about a week of dry-run output. `/etc/rws/rws.env` does not reach the container, so setting it there does nothing (`.env.example` lists the name for reference).

Read its output:

```bash
sudo docker logs rws-load-1 2>&1 | grep -E 'load started|retention pruner'
```

`load started` shows `"prune":"dry-run"` or `"apply"`. The nightly line is `{"applied":false,"candidates":N,"deleted":0,"refused":0,"msg":"retention pruner"}`:

| Field | Meaning |
|---|---|
| `applied` | `false` = dry run |
| `candidates` | objects the policy would delete |
| `deleted` | objects actually unlinked (always 0 in a dry run) |
| `refused` | candidates whose path is not a regular file inside `raw/` (a link out of it, or not a file). It should be 0: investigate any other value, and never delete such a path by hand |

An object is a candidate only if **all** of this holds: its manifest line says retention `obs`; the loader parsed it successfully and stored everything a registry change could still add (its batch is `ok` with `n_skipped` 0); its own line and every `dup_of` line that points at it are older than 90 days; its source is not CH-1 or CH-2 (kept whole until P7 parses their class and threshold fields); it is not the first object of its spec and UTC day for a mixed source; its key matches the archive key pattern and resolves to a regular file inside `raw/`.

It **never** deletes:

- a `forever` class (thresholds, forecasts, alert states, station lists, the DE-1 metadata `de-1-meta`);
- an object that was quarantined, skipped or never parsed;
- an object whose load left values a registry fix and a replay can still store (`n_skipped` > 0: a series the registry does not know, a unit mismatch, an unknown gauge-zero unit);
- anything newer than the hot window, or still referenced by a recent `dup_of` line;
- CH-1 and CH-2 payloads before P7;
- manifest files, state, reports, or anything outside `raw/`.

Nothing is old enough to be a candidate until 90 days after the first capture, so the first weeks of a dry run show `candidates: 0`.

**After it is switched on, deleted objects cannot be replayed** (`object_missing`); the observations stay in the database and in the dump. From then on, rebuild a database from the dump, not from the archive alone (`docs/runbooks/restore.md` §3). To stop it, remove the variable in a PR.
