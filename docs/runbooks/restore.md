# Runbook: restore from the off-site backup

The raw archive is the only copy of what nobody can refill (ADR-0003). restic sends it hourly to the Object Lock bucket (ADR-0011; RPO ≤ 1 h). The target for a rebuild is RTO ≤ 4 h (A§11.3).

**The restored archive holds owner-audience payloads** (BE-3, LU-2/3/4, DE-2/3). They go back only into `/srv/rws/raw` on a VPS you control, never anywhere public (invariant 11). A temporary rebuild VPS is deleted afterwards (E3).

## 1. A new VPS, or the same one

Follow `docs/runbooks/bootstrap.md` §0–§4 on the new host: the A3/A4 values, the secrets from your password manager, `RWS_BACKUP=off` for now. Then, **before anything else**, stop the timers that would back up, drill or redeploy during the restore: a backup of the half-empty archive would become the newest snapshot, and a deploy would start capture again. Then bring the stack up once and stop capture, so nothing writes into the directory you restore:

```bash
sudo systemctl disable --now rws-update.timer rws-backup.timer rws-restore-drill.timer
sudo rws-deploy <the latest tag>            # brings the stack up once
sudo docker compose -p rws stop capture
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
sudo find /srv/rws/backup/drill -mindepth 1 -delete
```

`/srv/rws/owner` is **not** restored. Capture rewrites its status every minute, and from P9 `publish-owner` regenerates the owner files.

## 3. Start again and check

```bash
sudo docker compose -p rws start capture
sudo systemctl enable --now rws-update.timer rws-backup.timer rws-restore-drill.timer
sudo rws-restore-drill --force        # sampled 100, matched 100
```

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
