# Runbook: history backfill (P14a)

**Trigger:**
- the owner wants older history for a source that has a spec in `registry/backfill.yaml` (today `nl-1-backfill-obs`, NL-1);
- a backfill job is `paused`, `failed` or `aborted` and must be looked at, resumed or stopped;
- the database grows faster than the projection of §7 says.

The `backfill` role is a one-shot job. It plans one job per series, fetches the older observations in P40D chunks into the raw archive and lets the loader store them. It never runs by itself: nothing starts it, and it is not in the default `up`. **The go-live data is the only copy**, so the backfill is built to change a live row only for a provider-validated value (§1). Agents have no production access: every command here is run by the owner.

## 1. What it does, and its rules

| Rule | Consequence |
|---|---|
| Fetch targets come only from `registry/` (invariant 1). The hosts of `registry/backfill.yaml` must be hosts of the same source in `registry/capture.yaml`; the body of every request is built from the registry row of the series, and the series is looked up in the registry again before **every** request | A job whose key the registry no longer selects fails as `unregistered`. No command line or database value reaches a URL |
| It works only inside the off-peak window **22:00–05:00 UTC** and exits when the window closes or the jobs are done | Start it at about 22:00 UTC. A run that is stopped by the window is a success (exit 0); start it again the next evening |
| Pacing: at least 1 s between two requests (probes included) and at most 3,600 an hour, on top of the live capture's 400 an hour for NL-1 (`registry/backfill.yaml`; the budget test asserts both) | About 4.2 hours for NL-1 (§7) |
| Each job has a **request budget** (planned chunks and probes plus 20 %) | A job that has used it is `paused` with `budget` (§5) |
| `backfill_guard` (a database function) answers whether the loader and the source are healthy; while it does not answer `ok` the runner sleeps 5 minutes and looks again | The backfill never competes with the live loader: it waits while the loader's health pass is older than 5 minutes (`loader_lag`), while the manifest backlog is over 3 files or 10 minutes (`backlog`), or while the source is not healthy (`stale`) |
| A chunk is committed in this order: (a) the object in the archive, (b) a manifest line (`retention: backfill`, spec `nl-1-backfill-obs`, an empty `variant`), (c) the job's cursor | A `kill -9` or a reboot at any point resumes at the old cursor; the chunk is fetched again and the second line loads as a no-op. No duplicates, no gaps |
| A chunk answered `204`, or with no value, moves the cursor and writes **no** manifest line | Fetch health does not see a `key: null` line |
| The probe asks `CheckWaarnemingenAanwezig` year by year from the start of the range until the first year that has data under the series' own method; **probes are not archived** | `data_from` is that year. A series without data in the range ends `done` |
| Truncation: a list at 90 % of the parser's cap (10,000 values), or 144,000 values in all, fails the job as `truncated` and commits nothing | P40D holds 5,760 values per 10-minute list, so a chunk stays far below it |
| Rows: every backfilled row gets qc bit 512; a live row is replaced **only** by a validated value (qc bit 2: RWS Gecontroleerd or Definitief) over an unvalidated one, and each such change writes one `obs_revision`; `obs_latest`, fetch health, outages and coverage never see a backfill (A§8 Q6) | A backfill cannot make a series look fresh or stale |
| Values under a method the registry does not know (RWS splits the answer into one list per method: F216, F009, F001, F029) are dropped as `unregistered_method`, counted and retained, never merged into the instantaneous series | Real growth is lower than the projection (§7, KG-341) |
| The runner logs in as `rws_backfill`: `backfill_job` and `backfill_guard` and nothing else, at most two connections (the running job and one status, pause or abort call beside it) | A budget cannot be raised by the runner itself (§5) |
| `last_error` and every line of output hold fixed codes, never provider text | |

Job states: `planned`, `running`, `paused`, `done`, `failed`, `aborted`. The fixed codes of `last_error`: `budget` (paused), `unregistered`, `truncated`, `unreconciled`, `invalid`, `schema_drift`, `archive`, `unexpected_status`, `client_error`, `upstream_error`, `throttled`, `network`, `timeout`, `dns`.

## 2. Run it

`backfill` runs as a one-off container of the `backfill` service (profile `jobs`; the only service on both `egress` and `db`; secrets `db_rws_backfill` and `rws_x_api_key`; the raw archive mounted read-write). It needs the compose files of the running release and the secret `db_rws_backfill`, which `bootstrap.sh` creates (re-run it after the release that brings P14a: `docs/runbooks/bootstrap.md`). Define this once per shell; it is the same command line as in `docs/runbooks/replay.md` §2:

```bash
rwsc() { sudo docker compose -p rws --project-directory /var/lib/rws/active -f /var/lib/rws/active/compose.yaml \
  --env-file /etc/rws/rws.env --env-file /var/lib/rws/active/images.env "$@"; }
```

`compose run` replaces the service's command, so the role name is given again: `backfill backfill <subcommand>`.

Exit codes of every subcommand: 0 done (also a run stopped by the window or `--until`), 64 bad arguments (the usage line says which), 78 no database settings or secret, or an invalid registry, 1 failed (a job failed, the breaker is open, the database failed with `backfill: failed (<code>)`; for `pause`, `resume` and `abort` also: nothing changed because the job is in another state).

## 3. Dry-run, then start

**Dry-run.** It needs neither the database nor the network, and writes nothing. It prints one line per series and a totals line:

```bash
rwsc run --rm --no-deps -T backfill backfill plan --spec nl-1-backfill-obs --from 1990-01-01 --dry-run
```

```json
{"totals":{"spec":"nl-1-backfill-obs","from":"1990-01-01T00:00:00.000Z","to":"2026-08-01T00:00:00.000Z","series":41,"chunks":13735,"requests":15252,"values":78900000,"bytes":22881000000,"db_bytes":7100000000,"archive_bytes":1525000000,"hours_at_pace":4.2}}
```

(The figures are the ones of §7, rounded.) `--from` defaults to the spec's floor (1990-01-01), `--to` to the data floor `2026-08-01`, so a default job does not overlap live rows. `--series key,key` limits it to some series (keys of the spec's selection only). Read §7 and check `pg_database_size` **before** you choose `--from`.

**Plan.** The same line without `--dry-run` creates one job per series. It is idempotent: a second `plan` of the same range creates nothing (`"created":false`).

```bash
rwsc run --rm --no-deps -T backfill backfill plan --spec nl-1-backfill-obs --from 1990-01-01
```

**Run.** Start it at about 22:00 UTC, inside a `tmux` or `screen` session. It works through the jobs in id order, one at a time, and prints one JSON line per job and a totals line at the end:

```bash
rwsc run --rm --no-deps -T backfill backfill run
rwsc run --rm --no-deps -T backfill backfill run --until 2026-10-14T03:00:00Z   # stop starting requests at this instant
```

It is safe to stop it with Ctrl-C, a `docker stop` or a reboot: the next `run` continues at each job's cursor (§1). The window closing between two chunks is the normal end of a night; `run` again the next evening until `status` shows every job `done`.

## 4. Status

```bash
rwsc run --rm --no-deps -T backfill backfill status
```

One JSON line per job (`job`, `series`, `status`, `range_from`, `range_to`, `data_from`, `cursor`, `chunks_done`, `requests`, `request_budget`, `attempts`, `provider_values`, `inserted`, `revised`, `skipped`, `dropped`, `unreconciled`, `error`) and a totals line (`jobs`, `by_status`, `chunks_done`, `requests`, `inserted`, `revised`, `unreconciled`). The counters are kept by the loader, so they follow the run with a delay of a loader pass. The same numbers, summed per source, are in `/api/v1/health/sources` as `backfill` (`jobs`, `active`, `chunks_done`, `inserted`, `revised`, `unreconciled`) for a source that has jobs.

## 5. Pause, resume, abort

```bash
rwsc run --rm --no-deps -T backfill backfill pause --job 7     # planned or running -> paused
rwsc run --rm --no-deps -T backfill backfill resume --job 7    # paused or failed -> planned (clears the error and the attempts)
rwsc run --rm --no-deps -T backfill backfill abort --job 7     # planned, running, paused or failed -> aborted (final)
```

A running `run` notices a pause or abort before its next request and goes on to the next job. Rows already stored stay: an abort stops the fetching, it removes nothing.

| `status` / `error` | What it means and what to do |
|---|---|
| `paused` / `budget` | The job used its request budget (retries, or far more chunks than planned). **Look first** (`attempts`, `requests` against `chunks_done`): a runaway is a bug. If the use is explained, the owner raises the budget in SQL (below) and resumes. The runner role cannot update `request_budget` |
| `failed` / `unreconciled` | A chunk's counts do not add up (`provider_values = kept + dropped` and `kept = inserted + revised + skipped`): a bug. Do not resume. Keep the output of `status` and the job number, and open an issue |
| `failed` / `truncated` | A list reached 90 % of the parser's cap, or 144,000 values: the chunk is too big for this series. Nothing was committed. Report it (KG-338) |
| `failed` / `unregistered` | The registry no longer selects the series. Restore the registry row or `abort` the job |
| `failed` / `upstream_error`, `throttled`, `network`, `timeout`, `dns` | Five failed attempts in a row. Wait, check `docs/runbooks/provider-outage.md`, then `resume` |
| `failed` / `schema_drift`, `invalid`, `unexpected_status`, `client_error` | The provider changed or refused. Look at `docs/runbooks/schema-drift.md`; the object is not archived. `resume` after a fix, or `abort` |
| `failed` / `archive` | The archive write failed (disk full? `docs/runbooks/disk-full.md`). `resume` after the cause is gone |

**Raising a budget** (owner only, after looking; one job, as the superuser through the `db` container's local socket):

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "UPDATE backfill_job SET request_budget = <old budget + the extra requests you accept>, updated_at = now()
   WHERE id = <job> AND status = 'paused' AND last_error = 'budget' RETURNING id, requests, request_budget"
rwsc run --rm --no-deps -T backfill backfill resume --job <job>
```

## 6. Verify

After a run (or each night), from the VPS:

1. **Status.** `backfill status` shows the jobs you expect: `done`, or `planned`/`running` with a cursor that moves; `unreconciled` is **0** in every job line and in the totals line. Any `unreconciled` above 0 is a bug (§5).
2. **Reconciliation.** For a done job, `inserted + revised + skipped` equals the rows kept, and `provider_values` equals kept plus `dropped`. The ledger has one row per chunk:

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
     "SELECT job_id, count(*) AS chunks, sum(provider_values) AS provider_values, sum(inserted) AS inserted, sum(revised) AS revised,
             bool_and(reconciled) AS reconciled FROM backfill_chunk GROUP BY 1 ORDER BY 1"
   ```

   `reconciled` is true everywhere.
3. **Health.** `curl -fsS https://<domain>/api/v1/health/sources | jq '.sources[] | select(.id == "NL-1") | {id, status, backfill}'` shows `backfill.unreconciled` 0 and `active` falling to 0 when the jobs are done. Owner-audience sources show their jobs only in the owner health.
4. **The second run is a no-op.** `backfill plan` with the same range prints `"created":false` for every series, and `backfill run` prints `"chunks":0,"requests":0` (done jobs are not picked up). A replay of the backfill days changes nothing: `docs/runbooks/replay.md` §2 with `--source NL-1 --spec nl-1-backfill-obs` prints `"n_new":0,"n_changed":0`.
5. **Live freshness during the run ([agent-prod]).** The criterion "live freshness stays within its limits while the backfill runs" is checked from outside, hourly, on the night of the run. From a workstation (no SSH needed), start this when the run starts and leave it until the window has closed and one hour more has passed:

   ```bash
   mkdir -p "$HOME/backfill-samples"
   while true; do
     at=$(date -u +%FT%TZ)
     curl -fsS https://<domain>/api/v1/health \
       | jq -c --arg at "$at" '{at: $at, status, lag_p95_s: .loader.lag_p95_s, backlog_age_s: .loader.backlog_age_s, last_commit: .loader.last_commit, sources}' \
       >> "$HOME/backfill-samples/health.jsonl"
     curl -fsS https://<domain>/api/v1/health/sources \
       | jq -c --arg at "$at" '.sources[] | select(.id == "NL-1") | {at: $at, id, status, last_new_data, newest_ts, lag_p95_s, tier1, backfill}' \
       >> "$HOME/backfill-samples/nl-1.jsonl"
     sleep 3600
   done
   ```

   The limits: `status` stays `ok` (no `degraded` or `down` that the backfill caused), `lag_p95_s` stays under 120, `backlog_age_s` under 600 (the guard holds the runner there), and NL-1's `tier1.fresh` equals its `total` (apart from a `provider_stale` the provider caused) with `last_new_data` moving. Paste the samples (they hold no secret and no owner value) into the PR or issue; an agent ticks the [agent-prod] criterion from them (KG-342).

## 7. How much database it will use (A§11.4)

The year-1 budget gives the observations **at most 23 GB** (`docs/plan/ARCHITECTURE.md` §11.4). The backfill adds to it for good: its raw objects are retention class `backfill`, which the pruner never deletes, and its rows are never dropped. The dry-run (§3) projects the size per provider; the figures below are **computed from constants measured on the fixtures (about 290 bytes of JSON and 90 bytes of database per value, a zstd ratio of 15), not measured in production** (KG-343).

| Provider | Series | Range | Chunks | Requests | Time at 1/s | Values (at most) | Database (at most) | Archive |
|---|---|---|---|---|---|---|---|---|
| NL-1 (28 H, 13 Q) | 41 | 1990-01-01 to 2026-08-01 | 13,735 | 15,252 | about 4.2 h | 78.9 M | about 7.1 GB (31 % of 23 GB) | about 1.5 GB |
| DE-8, BE-3, BE-1/2, FR-2, CH-8, CH-9, LU-7, others | – | – | – | – | – | – | – | later P14 PRs add their own row |

These are **upper bounds**:
- the dry-run counts duration divided by the native step (10 minutes), but the history is coarser: Lobith H in 1995 is hourly, in 1960 daily (KG-339);
- rows under another method than the registered one are dropped: for example, Q history at Lobith in 2010 is method F216, not the registered F230, so a Q series gets little or nothing for such years (KG-341);
- the figure is the sum over all series; a `--series` or `--from` that is later cuts it in proportion.

Per row, the database constant is 90 bytes; the kill -9 integration test measured about 102 bytes a row (95 for a clean insert), so the per-row part may be 10 to 15 % off. The two effects above are far larger, and they push the other way. So the real growth is far lower. The owner picks `--from` from the dry-run and checks the current size first:

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c "SELECT pg_size_pretty(pg_database_size('rws')) AS rws, pg_size_pretty(pg_total_relation_size('obs')) AS obs"
```

Run `backfill plan --dry-run` again with the `--from` you choose; if the total plus `pg_database_size` is not comfortably inside the 200 GB disk and the 23 GB obs line, take a later `--from` or fewer series. After the first night, compare `pg_database_size` with the dry-run and write the measured figure into `docs/capacity.md` (KG-343). Partitions: `obs` gets one yearly partition per year below 2026-01-01 (`docs/runbooks/partition-maintenance.md`); a restore drill (≤ 4 h) is the phase-close [owner] check.

## What not to do

- Do not run it outside the window or around the clock: a second `run` while one is running only waits on the pacer, but two processes would break the 1 request/s rule. One `run` at a time.
- Do not edit `backfill_job` or `backfill_chunk` by hand except the budget statement of §5. Never set `cursor_ts` back: re-fetching is safe, but a hand edit is not tested.
- Do not select backfill rows by bit 512 alone: fill rows carry it too. Use `ingest_batch.origin` (`backfill` or `live`) (`docs/runbooks/replay.md` §7).
- Do not delete backfilled rows or objects to save space: the pruner keeps class `backfill`, and a replay never removes a point. Free the disk as `docs/runbooks/disk-full.md` says.
- Do not give `rws_backfill` more rights, a third connection or a route from a visitor to the runner. Any change of the role is a reviewed migration.
- Do not restart `capture` (a deploy) during a run if you can avoid it: its start-up recovery can race with a backfill line on the shared day manifest (KG-340; the object is still loaded, only its ledger row is added by the next fetch).
- Do not resume a job that failed as `unreconciled`.
- Do not paste an owner-audience value into an issue. An owner source's backfill (later P14 PRs) shows only in the owner channel.
