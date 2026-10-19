# ADR-0023: Storage review at the end of the history backfill: keep plain PostgreSQL, defer compression and Parquet

- **Status:** Proposed (P14f, 2026-10-18; issue #29); accepted when the owner merges P14f. It answers the revisit note of ADR-0004 ("revisit compression or Parquet export in P14 at about 50 GB"). The production measurement (O1) is **pending**: the decision rests on a local benchmark and on the computed projections of A§11.4 until the owner pastes it.
- **Date:** 2026-10-18
- **Revisit:** when any trigger of decision 2 fires, or when the owner's measurement (issue #29, comment 6251697447) is pasted back, whichever comes first; at the latest at the phase close of P14 (the restore drill, KG-322).

## Context

- **ADR-0004 chose plain PostgreSQL 18.6** (no TimescaleDB; monthly partitions, BRIN, incremental rollups) on the strength of 16 to 20 ms at-T queries and at most 23 GB a year of observations, and said to look again at about 50 GB.
- **The backfill adds history in bulk.** NL-1 alone projects 12.35 GB (71 series since P16b, 26,483 requests; the P14a figure of 7.1 GB was for 41 series), P14b adds 2.44 GB (DE-8, FR-2, CH-9). Both numbers are **computed** by `backfill plan --dry-run` at about 90 bytes a row; the kill -9 test measured 102.1 B a row. Nothing has been measured in production (KG-344, KG-391).
- **The backfill is not finished.** About 24 of the 41 first NL-1 jobs were done on 2026-10-18; the P16b series and the P14b specs have not run (`docs/runbooks/backfill.md` §7).
- **Backups and the drill have never run in production.** `/status/ops.json` of 2026-10-18 shows `last_backup: null`, `drill: null` and `disk_pct: 3`; the timed rebuild and the restore drill are open (KG-320, KG-322). The restore drill has a budget of 105 minutes (`BUDGET_S=6300` in `deploy/bin/rws-restore-drill`) inside the RTO of 4 hours (A§11.3).
- **History is now read.** The day-of-year climatology (P14f, catalogue §4.7) and the empirical travel times (catalogue §3.7) read years of raw observations. Backfilled history has **no rollups**: `obs_1h` and `obs_1d` exist only from `DATA_FLOOR` (2026-08-01), so these readers aggregate raw `obs`, one series at a time.
- **The disk is large.** The VPS has at least 200 GB; A§11.4 budgets about 60 GB in year 1; the alert is at 75 %.

## Decision

1. **Keep plain PostgreSQL 18.6, uncompressed, for now.** No TimescaleDB, no Parquet export, no new extension or dependency. The ADR-0004 reasons stand (TSL licence, upgrade friction, standard dumps), and nothing measured says the database is near a limit.
2. **Defer, with triggers.** Reopen this ADR when **any** of these holds:
   - the database (`pg_database_size`) reaches **40 GB**;
   - a **measured** dump restore (`rws-restore-drill`, or the benchmark below on the VPS) takes **more than 2 hours**, which leaves the 4-hour RTO too little margin for the rebuild around it;
   - growth outside a backfill exceeds **2 GB a month** (the months of live capture only; the backfill is excluded because it ends).
3. **When a trigger fires, the preferred option is Parquet export of closed yearly partitions** (`obs_yYYYY` below 2026, then closed months), kept next to the database as files the history readers (climatology, travel times, history export) can scan, with the partition detached and dropped after a verified export. It needs a writer and a reader dependency and its own ADR-lite line (invariant 5). TimescaleDB compression stays rejected unless that ADR finds Parquet unworkable.
4. **The measurement is an owner action (O1), early and read-only**: `pg_database_size`, the 20 largest relations, `obs` partition sizes by year and month, row counts by origin (`live`, `backfill`), `du -sh /srv/rws/raw`, and the time and size of one `pg_dump -Fc` (the invocation of `deploy/bin/rws-backup`). It was requested on issue #29 (comment 6251697447). Until it is pasted back this ADR says "measurement pending" and the pending item is KG-403.

## Alternatives rejected

- **TimescaleDB with compression now.** A compression ratio on real values is unmeasured, the extension is under the Timescale licence for the compression features (ADR-0004), it must be in the image and in every dump and upgrade, and the database is far from the size at which it pays. Rejected for now; reopened only through decision 3.
- **Parquet export now.** It adds a dependency and a second store before any pain: no history reader is slow, the disk has about 140 GB of headroom, and the readers (the climatology and the travel times) are one-shot commands run a few times a year. Rejected for now; it is the preferred option at a trigger.
- **Dropping or thinning old rows** (for example keeping hourly means before 2010). Rejected: the backfill exists to hold the history, and the 10-minute and hourly values are what the validated-over-raw rule (A§8 Q6) works on.
- **Rollups for the backfilled years.** Rejected here: `obs_1h` and `obs_1d` are maintained by the loader for live data; extending them to 36 years is a new storage cost to save two one-shot readers a scan.

## Consequences

- **No change to the schema, the images or the backups.** The ADR adds a decision and three triggers; nothing in P14f depends on a different store.
- **The triggers are not watched by anything.** `/status/ops.json` carries `disk_pct`, not the database size or a restore time; the owner (or an agent that reads the pasted measurement) has to notice. This is risk R-109 and gap KG-403.
- **The climatology and the travel times read raw `obs`.** Their cost grows with the history, not with the rollups. The travel-time command reads one series-year per query because `rws_publish` has a 2 s statement timeout (`docs/runbooks/travel-times.md`).
- **The restore time is the number that matters.** A restore of 50 GB inside the 105-minute drill budget is plausible on the benchmark below, but the VPS disk and CPU are unmeasured; the drill (KG-322) is the proof and is not ticked by this ADR.
- **The RTO stays 4 hours** (A§11.3) unless the drill shows otherwise; if it does, this ADR or A§11.3 is revised, whichever is smaller.

## Appendix: Measurement

### Local restore benchmark (2026-10-18)

Method: a scratch database on the local PostgreSQL 18.6 cluster (WSL2, 16 logical CPUs, local SSD), one table with the production `obs` shape: range-partitioned by `ts` into yearly partitions 1990 to 2026, `PRIMARY KEY (series_id, ts)`, the BRIN index on `ts` and both CHECKs. Synthetic rows: 60 series, hourly, 1990-01-01 to 2026-12-31. Then `pg_dump -Fc --no-large-objects` to a file and a single-job `pg_restore --exit-on-error` from stdin into an empty database, as `deploy/bin/rws-restore-drill` runs it (no `-j`). Sessions in UTC. No dependency was added; the script is the lead's and is not committed.

| Measure | Value |
|---|---|
| Rows | 19,460,160 |
| Database size | 1,798,223,551 B (1.80 GB; `obs` partitions 1.79 GB, about 92 B a row with the primary key) |
| Insert | 56 s |
| `pg_dump -Fc` | 14.5 s, 154,327,397 B (11.7 times smaller; synthetic data compresses better than real values) |
| `pg_restore` (single job, including the primary key and BRIN builds) | 22.3 s |
| Restored size | 1.81 GB, 19,460,160 rows |

Linear extrapolation to a 50 GB database (a factor of 27.8): dump about 6.7 minutes and restore about 10.3 minutes on this machine. The VPS has fewer cores and a slower disk; at 3 to 5 times slower, the restore of 50 GB is about 30 to 50 minutes, inside the drill's 105-minute budget and far inside the RTO of 4 hours.

**Not measured:** the replay part of the drill, real-value compression, the VPS disk, and any table other than `obs`. The O1 measurement gives the real database size and dump time; the drill gives the real restore time.
