# Runbook: partition maintenance

**Trigger:**
- `load` logs the alert `load_stalled` or `load pass failed; retrying` with `"code":"23514"` (a row has no partition), `"22023"` (`ensure_partitions` refused its range) or `"42501"` (no permission on it; a stall, and the watchdog's `load_backlog` after 15 minutes);
- a payload is quarantined as `load_error` (`docs/runbooks/schema-drift.md`);
- a month boundary is close and you want to check the next partitions exist;
- you need older data for a backfill (P14a): before 2026 `obs` has one partition per year (§1, §3).

Nothing pages on a missing partition by itself: the loader creates them, and a failure shows as the loader lines above and as a quarantined payload.

## 1. How partitions work

| | |
|---|---|
| Tables | `obs` (on `ts`) and `forecast_value` (on `valid_ts`). From 2026-01-01 (UTC) on, one partition per UTC month: `obs_2026_10`, `forecast_value_2026_10`. Before it, **`obs` only**, one partition per UTC year: `obs_y1995` = [1995-01-01, 1996-01-01). `forecast_value` has no partition before 2026-01-01 |
| Default partition | **None.** A row outside every partition fails loudly (SQLSTATE 23514), never lands somewhere unnoticed |
| Who creates them | only `ensure_partitions(from, to)`, a `SECURITY DEFINER` function owned by `rws_owner`. Each partition is built beside its parent (`CREATE TABLE … LIKE … INCLUDING DEFAULTS, CONSTRAINTS, INDEXES`) and then attached, so readers of `obs` are not blocked |
| When it runs | (1) the loader, for the time range of **every payload**, in the payload's own transaction; (2) the nightly job of `load`, once a UTC day after 02:00: from now to three months ahead; (3) `migrate`, at every deploy: from 2026-08-01 to three months ahead |
| Bounds | `from` not before 1900-01-01, `to` not later than now plus 400 days; the monthly part (from 2026-01-01 on) at most 3,700 days wide, the yearly part has no span limit. Anything else raises 22023 |
| Yearly guard | before it creates any yearly partition, `ensure_partitions` reads `pg_partition_tree('obs')` and raises `55000` if a **monthly** `obs` partition lies below 2026-01-01 (the layout would be mixed). A call that starts at or after 2026-01-01 never reads it |
| Who may call it | `rws_load` and `rws_migrator` (EXECUTE is revoked from PUBLIC), and the superuser |
| Retention | None for the database. Only the raw archive is pruned (`docs/runbooks/disk-full.md` §4). Never drop or detach a partition |

## 2. Look

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c "
  SELECT b.relname AS parent, p.relname AS partition, pg_get_expr(p.relpartbound, p.oid) AS bounds,
         pg_get_userbyid(p.relowner) AS owner, pg_size_pretty(pg_total_relation_size(p.oid)) AS size
  FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhrelid JOIN pg_class b ON b.oid = i.inhparent
  WHERE b.relname IN ('obs', 'forecast_value') ORDER BY b.relname, p.relname"
```

Expected: every month from `2026_08` to three months ahead for both parents, plus the `obs_yYYYY` years that a backfill has made, all owned by `rws_owner`. The yearlies must tile: each one starts where the previous ends, the last ends at `2026-01-01`. `/api/v1/health/sources` `partitions[]` is keyed by calendar month, not by table, so it is unaffected by the yearly layout. `/api/v1/health/sources` `partitions[]` lists the months that hold observations, with their checksums; it does not list empty ones.

```bash
sudo docker logs --since 24h rws-load-1 2>&1 | grep -E '"code":"(23514|22023|42501)"|load_stalled|retention pruner'
```

The nightly job logs `retention pruner` once it has run. No such line after 02:00 UTC means it did not run or failed (see §4).

## 3. Create partitions by hand

As the superuser, through the local socket. The function runs as `rws_owner`, so the partitions get the right owner:

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SELECT ensure_partitions(now(), now() + interval '3 months') AS created"
```

`created` is the number of partitions made (obs and forecast_value together); 0 means all were there. For older data (a backfill) the range goes below 2026-01-01 and `obs` gets whole years, however short the range. The backfill runner (`docs/runbooks/backfill.md`) does this itself, one call per chunk; by hand it is:

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SELECT ensure_partitions('1995-01-01T00:00:00Z', '2025-12-31T23:59:59Z') AS created"
```

That makes `obs_y1995` to `obs_y2025` (31, no `forecast_value`). A range that crosses 2026-01-01 also makes the months from there on.

If it answers `22023`, the range is outside the bounds above. If it answers `55000`, a monthly `obs` partition exists below 2026-01-01: someone created it by hand. Do not detach it; stop and ask the owner (it needs a reviewed migration). If `load` had quarantined payloads as `load_error` because of a missing partition, replay them afterwards (`docs/runbooks/replay.md`).

## 4. The nightly job

`load` runs, once per UTC day after 02:00 and only when it has no manifest backlog: partitions three months ahead, the rollup reconciliation of the last 40 days (repairs `obs_1h`/`obs_1d` and logs `rollup_mismatch` if it had to), the per-source per-partition checksums, and the retention pruner (a dry run unless `RWS_PRUNE_APPLY=1`).

The day is marked done when the job starts, in the database (`app_meta` key `nightly`), so a restart does not run it again. If a step fails, the rest of that day's job waits for the next day. To run it again today, clear the mark (as the superuser; the loader itself cannot delete) and restart the loader after 02:00 UTC:

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c "DELETE FROM app_meta WHERE key = 'nightly' RETURNING value"
sudo docker restart rws-load-1
```

A restart recomputes the checksums as soon as the loader has caught up with the manifest; with the mark cleared, it runs the whole nightly job at once when it is past 02:00 UTC. Never delete the row `loader_lock`: without it the loader refuses to write (`load_stalled`, code `loader_lock_missing`).

## 5. Verify

- the query of §2 shows the months and years you expect, and the yearlies tile up to 2026-01-01;
- `load` is healthy: `sudo docker compose -p rws ps load`;
- `/api/v1/health` is `ok` or `degraded` for another reason, `loader.backlog_bytes` falls to 0;
- after a fix for quarantined payloads, `quarantined` returns to 0 (`docs/runbooks/schema-drift.md` §6).

## What not to do

- Do not `CREATE TABLE … PARTITION OF` by hand as the superuser: the partition would belong to `postgres`, and the privileges of the role model (the committed privilege matrix) would drift. Use `ensure_partitions`.
- Do not add a default partition to "make inserts work": it would hide a missing month.
- Do not drop or detach partitions to save space: the observations are kept for good. Free the disk as `docs/runbooks/disk-full.md` says.
- Do not create a monthly `obs` partition below 2026-01-01, and do not move the 2026-01-01 boundary: the function refuses (`55000`) while one exists, and a second layout would overlap the yearlies.
- Do not create `forecast_value` partitions below 2026-01-01 by hand.
- Do not widen the bounds of `ensure_partitions` in place. A change to the function is a migration (a release).
