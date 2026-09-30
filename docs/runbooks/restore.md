# Runbook: restore from the off-site backup

The raw archive is the only copy of what nobody can refill (ADR-0003). restic sends it hourly to the Object Lock bucket (ADR-0011; RPO ≤ 1 h). From P2a the nightly database dump goes into the same repository (RPO ≤ 24 h for the database; the loader closes the gap from the archive). The target for a rebuild is RTO ≤ 4 h (A§11.3).

**The restored archive and the dump hold owner-audience data** (BE-3, LU-2/3/4, DE-2/3 payloads; their rows once those sources load). They go back only into `/srv/rws/raw` and into the database of a VPS you control, never anywhere public (invariant 11): the `pub_*` views exclude owner rows. A temporary rebuild VPS is deleted afterwards (E3).

## 1. A new VPS, or the same one

Follow `docs/runbooks/bootstrap.md` §0–§4 on the new host: the A3/A4 values, the secrets from your password manager, `RWS_BACKUP=off` for now. Then, **before anything else**, stop the timers that would back up, drill or redeploy during the restore: a backup of the half-empty archive would become the newest snapshot, and a deploy would start capture again. Then bring the stack up once and stop capture **and load**, so nothing writes into the directory you restore. `load` matters as much: if it reads a manifest file before the objects it lists have been copied in, it sets those payloads aside as `skipped` (`object_missing`) and moves on. From P2a the stack has a database (`db`, `load`, `api`), and `rws-deploy` creates it empty (roles, migrations, registry):

```bash
sudo systemctl disable --now rws-update.timer rws-backup.timer rws-restore-drill.timer
sudo rws-deploy <the latest tag>            # brings the stack up once
sudo docker compose -p rws stop capture load
```

## 2. Restore the raw archive

List the snapshots and pick the **newest one taken before the loss** (the `time` column; the host is `rws`). Restore it by its ID, never `latest`:

```bash
sudo sed -i 's/^RWS_BACKUP=off$/RWS_BACKUP=on/' /etc/rws/rws.env
sudo bash -c '. /usr/local/lib/rws/deploy/bin/rws-lib.sh; backup_ready; allow_bucket "$BUCKET_HOST";
  rws_compose run --rm --no-deps -T backup snapshots --host rws'
id=<the snapshot ID you picked>
```

The backup container mounts `/srv/rws/raw` **read-only**. So restore into the scratch directory, then copy it into place as root. That needs free space for a second copy; on a small disk, restore per path with `--include`:

```bash
sudo bash -c '. /usr/local/lib/rws/deploy/bin/rws-lib.sh; backup_ready; allow_bucket "$BUCKET_HOST";
  rws_compose run --rm --no-deps -T backup restore "$1" --target /restore' _ "$id"
sudo cp -a /srv/rws/backup/drill/data/raw/. /srv/rws/raw/
sudo chown -R 65532:65532 /srv/rws/raw && sudo find /srv/rws/raw -type d -exec chmod 0750 {} + && sudo find /srv/rws/raw -type f -exec chmod 0640 {} +
```

Keep the scratch directory until §4: from P2a the same restore also brings back the database dump (`data/db`). `/srv/rws/owner` is **not** restored. Capture rewrites its status every minute, and from P9 `publish-owner` regenerates the owner files.

## 3. The database (from P2a)

The archive is the source of truth, and the database can always be rebuilt from it, as far as the archive still holds the objects. Pick a route.

**Route A: rebuild by replay (the default).** `rws-deploy` left an empty database with the migrations and the registry in place, and `load` is stopped. With the raw archive restored (§2), start it:

```bash
sudo docker compose -p rws start load
```

The loader's cursor starts at the first manifest day, so it reads every manifest file and parses every payload, as it did at the first P2a deploy. Watch `loader.backlog_bytes` in `curl -s https://<domain>/api/v1/health` fall to 0, then check `docs/runbooks/schema-drift.md` for anything quarantined. Once `RWS_PRUNE_APPLY=1` is on, the archive no longer holds the observation objects older than the 90-day hot window (`docs/runbooks/disk-full.md` §4), so this route brings back only what the archive still has: use route B.

**Route B: restore the dump.** The snapshot you restored holds the nightly dump as `data/db/rws.dump` (a `pg_dump -Fc` of the whole database, taken as `rws_backup`) and `data/db/globals.sql` (the roles without passwords: a record only, `rws-deploy` recreates the roles from `deploy/postgres/roles.sql`). Restore it into an **empty** database, then deploy the current release again so that the roles' passwords, the database settings and any newer migration are applied:

```bash
sudo ls -l /srv/rws/backup/drill/data/db                  # rws.dump and globals.sql
sudo docker compose -p rws stop load api                  # nothing may write while the database is replaced
sudo docker exec -i rws-db-1 psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE rws WITH (FORCE)' \
  -c "CREATE DATABASE rws TEMPLATE template0 OWNER rws_owner LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' ENCODING 'UTF8'"
sudo cat /srv/rws/backup/drill/data/db/rws.dump | sudo docker exec -i rws-db-1 pg_restore -U postgres -d rws --exit-on-error
sudo rws-deploy "$(sudo cat /var/lib/rws/current)"        # db_prepare, migrate (newer migrations only), registry sync, up -d
```

The last command also starts capture and load again: the raw archive is complete by now.

The dump carries the tables, the grants and the loader's cursor (`load_cursor`), so `load` carries on from where the dump was taken and closes the gap from the restored archive by itself. Objects and privileges come back owned by `rws_owner`, as in production. Check `curl -s https://<domain>/api/v1/health/sources | jq '.sources[] | {id, status, partitions}'`. The checksums of the partitions are recomputed once the loader has caught up with the manifest.

The database commands (an empty database created like this one, `pg_restore` from a pipe, ownership and grants) were exercised against a throw-away PostgreSQL 18.6 cluster; the whole procedure has not run on a VPS. The monthly restore drill does not restore the dump yet (KG-054), and the Caddy certificates are not in the dump (KG-055): Caddy asks Let's Encrypt again.

In both routes, replay anything still skipped or quarantined (`docs/runbooks/replay.md`), then empty the scratch directory (below).

## 4. Start again and check

```bash
sudo docker compose -p rws start capture load api
sudo systemctl enable --now rws-update.timer rws-backup.timer rws-restore-drill.timer
sudo rws-restore-drill --force        # sampled 100, matched 100
sudo find /srv/rws/backup/drill -mindepth 1 -delete
```

The dump is in the scratch directory until the last command: it may hold owner rows, so do not skip it.

- Capture's start-up recovery records any object without a manifest line (`recovered`).
- Each spec's gap-stretch window then refetches what the providers still keep (5–40 days).
- Forecasts and class states from the gap are lost for good. Note the gap in the daily report.

## Pruning (owner, quarterly, from the workstation)

With the **workstation key** only, never the VPS key:

```bash
export RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/restic RESTIC_PASSWORD_FILE=~/secure/restic_password AWS_SHARED_CREDENTIALS_FILE=~/secure/workstation_credentials
restic forget --host rws --keep-daily 7 --keep-weekly 8 --keep-monthly 12 --prune
```

Object Lock keeps every version for at least 30 days whatever a prune does.
