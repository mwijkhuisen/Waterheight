# Runbook: the disk fills up

**Trigger:** the `disk` check (`/srv/rws` ≥ 75%, from `/status/ops.json` `disk_pct`, refreshed every 10 min by `rws-tick`), or `ENOSPC` in a log. At 100% capture cannot write, and data is lost for good.

## 1. What grows

```bash
df -h /srv/rws /var/lib/docker
sudo du -xh --max-depth=2 /srv/rws | sort -h | tail -n 15
sudo du -sh /var/lib/docker/{containers,overlay2,volumes} 2>/dev/null
sudo docker system df
```

## 2. Quick, safe space

| Where | Command | Safe because |
|---|---|---|
| Old images | `sudo docker image prune -a -f` | Deploys pull by digest again when needed (`rws-update` already removes images no kept release references) |
| Container logs | `sudo journalctl --vacuum-time=7d`; Docker's `local` driver keeps 5 × 20 MB per container | Logs only |
| Restic cache | `sudo find /srv/rws/backup/cache -mindepth 1 -delete` | Rebuilt on the next run |
| Drill scratch | `sudo find /srv/rws/backup/drill -mindepth 1 -delete` | Always temporary |

**Never** delete anything under `/srv/rws/raw` by hand. Retention pruning of the obs window belongs to the `load` role (P2), and a forever class is never pruned. Check first that the last backup is fresh (`/status/ops.json` `last_backup` < 1 h).

## 3. Lasting fixes

- Grow the volume at the provider (A3), then `resize2fs`.
- Compare with `docs/capacity.md` (the measured bytes per day and the year-1 projection). If one spec dominates (NRW `messwerte.zip`), switch it to a smaller delta source in a PR (PHASES §P1 risks).
