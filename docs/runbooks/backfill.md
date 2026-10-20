# Runbook: history backfill (P14a, P14b)

**Trigger:**
- the owner wants older history for a source that has a spec in `registry/backfill.yaml` (`nl-1-backfill-obs` for NL-1, and from P14b `de-8-backfill-w`, `fr-2-backfill-elab` and `ch-9-backfill-bs`, §8);
- a backfill job is `paused`, `failed` or `aborted` and must be looked at, resumed or stopped;
- the database grows faster than the projection of §7 says;
- the NL-1 history must be counted by method, or restored after the #184 fix (§9).

The `backfill` role is a one-shot job. It plans one job per unit (a series for NL-1; a decade file for DE-8, a daily-aggregate series for FR-2, a dataset for CH-9), fetches the older observations in chunks of the spec's size (P40D for NL-1) into the raw archive and lets the loader store them. It never runs by itself: nothing starts it, and it is not in the default `up`. **The go-live data is the only copy**, so the backfill is built to change a live row only for a provider-validated value (§1); the P14b specs write into the series of **another source** (their `target`) and stop at `DATA_FLOOR` (§8). Agents have no production access: every command here is run by the owner.

## 1. What it does, and its rules

| Rule | Consequence |
|---|---|
| Fetch targets come only from `registry/` (invariant 1). The hosts of `registry/backfill.yaml` must be hosts of the same source in `registry/capture.yaml`; the body of every request is built from the registry row of the series, and the series is looked up in the registry again before **every** request | A job whose key the registry no longer selects fails as `unregistered`. No command line or database value reaches a URL |
| **One runner per host.** At start a run takes the lease of every host its jobs use (a row of `backfill_lease`, owned by a random id per process), renews it to now + 2 minutes before every request, and gives it back at exit | A second `run` while one holds the lease exits 1 at once with `"stopped":"busy"` and sends nothing. After a `kill -9`, a reboot or a lost container the lease lapses **within 2 minutes**: a `run` started sooner is `busy`; wait 2 minutes and start it again |
| It works only inside the off-peak window **22:00–05:00 UTC** (every host) and exits when the window closes or the jobs are done | Start it at about 22:00 UTC. A run that is stopped by the window is a success (exit 0); start it again the next evening |
| Pacing: **per host**, `min_interval_ms` and `max_per_hour` of the host in `registry/backfill.yaml`: NL-1's host at least 1 s apart and at most 3,600 an hour, on top of the live capture's 1,000 an hour (P16a); P14b adds `www.opengeodata.nrw.de` (30 s, 20 an hour), `hubeau.eaufrance.fr` (2 s, 1,800 an hour, on top of FR-1's live 10) and `data.bs.ch` (1 s, 3,600 an hour). The budget test asserts every host | About 4.2 hours of requests for NL-1 (§7), counted at one request a second. Since the P14a queue fix the runner also waits for the loader after every chunk with data (`unloaded`, below: one loader tick, up to about 10 seconds), so at the usual 2-second load a night does some 300 to 400 chunks an hour and the NL-1 history takes several nights. In a slow hour (2026-10-15, 23h: 57 seconds a chunk) it is a minute or more a chunk, and a load over 60 seconds ages the live lines past the `backlog` limit, which pauses the runner 5 minutes; a night in which the loader lags for good ends at the window |
| Each job has a **request budget** (planned chunks and probes plus 20 %) | A job that has used it is `paused` with `budget` (§5) |
| **The job row is checked before any request** (review S2): its chunk must be the spec's, its range must lie in [the spec floor, the data epoch 2026-10-02], and its budget may not exceed what `plan` gives that range | A job row changed by hand or through the `rws_backfill` login fails as `invalid_job` before it sends anything |
| **A P14b spec (it has a `target`) ends at `DATA_FLOOR`, 2026-08-01T00:00:00Z, not at the epoch** (§8): `plan` caps `--to` there and refuses a later one, `invalid_job` re-checks it, and the loader drops a row at or after it | See §8: the days the site shows already belong to live rows |
| For NL-1: the upper end of every range is at most the **data epoch, 2026-10-02T00:00:00Z** (`DATA_EPOCH`, the first production capture, app_meta `data_epoch`): `plan` defaults `--to` to it and refuses a later one, and the loader drops a backfill row at or after it | The history meets the live rows at the epoch and never reaches the newest live point, so `obs_latest` never needs a backfill (KG-345) |
| **The loader's window** (review S3): a backfill row outside its manifest line's chunk `[from, to)`, below the spec floor (NL-1 1990-01-01; DE-8 and FR-2 1950-01-01; CH-9 2020-06-01) or at or after its ceiling (the data epoch, or `DATA_FLOOR` for a P14b spec) is dropped as `outside_backfill` and counted in `dropped` | A forged or misplaced line stores nothing outside its chunk, and the ledger identities still hold |
| `backfill_guard` (a database function) answers whether the loader and the source are healthy; while it does not answer `ok` the runner sleeps and looks again: 2 seconds after `unloaded`, 5 minutes after any other answer | The backfill never competes with the live loader: it waits while the loader's health pass is older than **150 seconds** or has no time at all (`loader_lag`; 5 minutes until the P14a health-scan fix: the pass rewrites it every 60 to 90 seconds, so an older one is a stalled load loop), while the manifest backlog is over 3 files or older than **60 seconds** (`backlog`; 600 seconds, five times the 120-second freshness limit, until the P14a health-scan fix: the runner now stops starting chunks once live data is a minute behind), or an active job of the source (`planned`, `running` or `paused`; an aborted, failed or done one is not counted) has **any** chunk with data (`chunks_with_data`) that the loader's ledger does not hold yet (`unloaded`), or while the source is not healthy (`stale`). **Why no unloaded chunk at all** (the P14a queue fix; it allowed 30 before): backfill lines go into the same daily manifest as the live lines, and the loader reads a manifest in order, so every unloaded chunk sits in front of the live lines written after it. On the night of 2026-10-15/16 a chunk took 2 seconds to load at the median but up to about a minute at times, and 30 of them held live data back by up to 34 minutes. Now at most one chunk waits in front of a live line. A chunk the loader sets aside (quarantined or skipped) gets a ledger row too, with no counts and `reconciled` false, so the guard never waits for it; the runner then fails that job `unreconciled` (§5) and goes on with the next. The ledger is counted by distinct chunk start, so a chunk fetched again after a `kill -9` counts once, and a job is `done` only once its last chunk is in the ledger. **A chunk that never reaches the ledger** (a damaged manifest line, a line capture's recovery re-adopted, KG-341, or one set aside before this fix) would hold the runner all night: after **10 minutes** of `unloaded` in a row the run stops with `"stopped":"stuck"` and exits 1 (§5) |
| A chunk is committed in this order: (a) the object in the archive, (b) a manifest line (`retention: backfill`, the spec's id, an empty `variant` for NL-1 and the unit's key for the others), (c) the job's cursor. A DE-8 slice reuses its file's object (§8) | A `kill -9` or a reboot at any point resumes at the old cursor; the chunk is fetched again and the second line loads as a no-op. No duplicates, no gaps |
| A chunk answered `204`, or with no value, moves the cursor and writes **no** manifest line | Fetch health does not see a `key: null` line |
| NL-1 only: the probe asks `CheckWaarnemingenAanwezig` year by year from the start of the range until the first year that has data under the series' own method; **probes are not archived** | `data_from` is that year. A series without data in the range ends `done` |
| Truncation: a list at 90 % of the parser's cap (10,000 values), 144,000 values in all, a parser cap error or the client's size cap commits nothing; the runner **halves the chunk at that cursor** and asks again (40, 20, 10, 5, 2.5, 1.25, 1 day), and fails the job as `truncated` only when a one-day chunk is still too big. Every request counts against the budget | P40D holds 5,760 values per 10-minute list, so a chunk stays far below it. The next cursor asks a whole chunk again |
| Throttling: a 403, 429, 451 or 5xx is retried after the client's backoff (`Retry-After` when the provider sends one), up to 5 attempts. When the backoff would end after the window, the run stops with `"stopped":"throttled"` and exits 1 | The backoff is kept in memory only: a restart forgets it. **Do not restart a throttled run at once**: wait for the `Retry-After` the provider sent, or for the next night |
| Rows: every backfilled row gets qc bit 512; a live row is replaced **only** by a validated value (qc bit 2: RWS Gecontroleerd or Definitief) over an unvalidated one, and each such change writes one `obs_revision`; `obs_latest`, fetch health, outages and coverage never see a backfill (A§8 Q6) | A backfill cannot make a series look fresh or stale |
| Values under a method the registry does not know (RWS splits the answer into one list per method: F216, F009, F001, F029) are dropped as `unregistered_method`, counted and retained, never merged into the instantaneous series. A **processed** list (`WaardeBewerkingsMethode` other than `NVT`, such as the daily mean GEM24H, which RWS sends as a second list under the same method) of a stored series is dropped as `processed` (#184): retained, counted, never merged (before #184 it merged and withheld the midnight values as `conflict`; §9) | Real growth is lower than the projection (§7, KG-342) |
| The runner logs in as `rws_backfill`: `backfill_job`, `backfill_lease` and `backfill_guard` and nothing else, at most two connections (the running job and one status, pause or abort call beside it), 5 s per statement and 30 s idle in a transaction | A budget cannot be raised by the runner itself (§5) |
| A request is counted once it went out: a backoff, an open breaker or a refused URL counts nothing; a request a `kill -9` interrupts is not counted either | `requests` may be one short after a crash |
| `last_error` and every line of output hold fixed codes, never provider text | |

**The order of the specs.** All jobs share one `run`, in job-id order; the P14b jobs get ids **after** the NL-1 ones. To run P14b first, `pause` the NL-1 jobs (§5) and `resume` them afterwards; there is no `run --spec`. A run takes the lease of every host its jobs use, so a job of another host never waits for an NL-1 job's host.

Job states: `planned`, `running`, `paused`, `done`, `failed`, `aborted`. The fixed codes of `last_error`: `budget` (paused), `unregistered`, `invalid_job`, `truncated`, `unreconciled`, `invalid`, `schema_drift`, `archive`, `unexpected_status`, `client_error`, `upstream_error`, `throttled`, `network`, `timeout`, `dns`.

## 2. Run it

`backfill` runs as a one-off container of the `backfill` service (profile `jobs`; the only service on both `egress` and `db`; secrets `db_rws_backfill` and `rws_x_api_key`; the raw archive mounted read-write). It needs the compose files of the running release and the secret `db_rws_backfill`, which `bootstrap.sh` creates. A release that adds a database role or a secret needs its bootstrap **before** its deploy (the migration grants to the new role, and `migrate` fails and rolls back without it): run the new bootstrap of the verified release, then deploy it (`docs/runbooks/bootstrap.md`). Define this once per shell (every new login needs it again); it is the same as in `docs/runbooks/replay.md` §2, `rws_compose` of the installed `rws-lib.sh`, the command line of every deploy:

```bash
rwsc() { sudo bash -c 'cd / && . /usr/local/lib/rws/deploy/bin/rws-lib.sh && rws_compose "$@"' rwsc "$@"; }
```

`rwsc` already holds `sudo`: never write `sudo rwsc`. It adds the tunnel and owner overlays as a deploy does, and it starts from `/`: from a directory a deploy has since removed (a shell left in `/var/lib/rws/releases/<old tag>`) compose fails with `getwd: no such file or directory` (2026-10-17). The plain `-f compose.yaml` line this runbook had until the P14a queue fix warns of an orphan `rws-cloudflared-1` on a tunnel host: **never** answer that warning with `--remove-orphans`, which removes the tunnel and takes the site off line.

`compose run` replaces the service's command, so the role name is given again: `backfill backfill <subcommand>`.

Exit codes of every subcommand: 0 done (also a run stopped by the window or `--until`), 64 bad arguments (the usage line says which), 78 no database settings or secret, or an invalid registry (also a backfill spec of a source that is not `public` or has `history_export` off, or one that selects a series narrowed to another audience), 1 failed (a job failed; the run stopped `busy`, `throttled`, `breaker_open` or `stuck`; the database failed with `backfill: failed (<code>)`; for `pause`, `resume` and `abort` also: nothing changed because the job is in another state).

## 3. Dry-run, then start

**Dry-run.** It needs neither the database nor the network, and writes nothing. It prints one line per series and a totals line:

```bash
rwsc run --rm --no-deps -T backfill backfill plan --spec nl-1-backfill-obs --from 1990-01-01 --dry-run   # NL-1; the other specs in §8
```

```json
{"totals":{"spec":"nl-1-backfill-obs","from":"1990-01-01T00:00:00.000Z","to":"2026-10-02T00:00:00.000Z","series":41,"chunks":13776,"requests":15293,"values":79249392,"bytes":22982323680,"db_bytes":7132445280,"archive_bytes":1532154912,"hours_at_pace":4.2}}
```

(The figures are the ones of §7; these are NL-1's of P14a, before P16b registered 71 series: today's dry-run says 12.35 GB.) `--from` defaults to the spec's floor (NL-1 1990-01-01), `--to` to the data epoch `2026-10-02` and may not be later (review C2): NL-1 has no seed, so the history runs up to the first production capture with no hole; where it overlaps live rows (August to October 2026) the row rules of §1 apply. `--series key,key` limits it to some series (keys of the spec's selection only). Read §7 and check `pg_database_size` **before** you choose `--from`.

**Plan.** The same line without `--dry-run` creates one job per series. It is idempotent: a second `plan` of the same range creates nothing (`"created":false`).

```bash
rwsc run --rm --no-deps -T backfill backfill plan --spec nl-1-backfill-obs --from 1990-01-01   # NL-1; the other specs in §8
```

**Run.** Start it at about 22:00 UTC, inside a `tmux` or `screen` session. It works through the jobs in id order, one at a time, and prints one JSON line per job and a totals line at the end:

```bash
rwsc run --rm --no-deps -T backfill backfill run
rwsc run --rm --no-deps -T backfill backfill run --until 2026-10-14T03:00:00Z   # stop starting requests at this instant
```

**Unattended start.** To start a run at 22:01 UTC without a terminal, give `systemd-run` a transient timer (one run, a unit name of your own; `<date>` is the evening, `YYYY-MM-DD`):

```bash
sudo systemd-run --unit=rws-backfill-nl1 --collect --on-calendar='<date> 22:01:00 UTC' --timer-property=AccuracySec=1s \
  /bin/bash -c '. /usr/local/lib/rws/deploy/bin/rws-lib.sh && rws_compose run --rm --no-deps -T backfill backfill run'
systemctl list-timers --all | grep rws-backfill   # the timer and the time it fires
```

It is not a function call, so `sudo` goes in front of `systemd-run` and the command is written out. To cancel it before it fires: `sudo systemctl stop rws-backfill-nl1.timer`. To read the run afterwards (or while it goes): `sudo journalctl -u rws-backfill-nl1` (add `-f` to follow). `--collect` lets the next evening reuse the unit name even after a run that exited 1. To stop a running night, stop its container (`sudo docker ps --filter name=backfill-run`, then `sudo docker stop <id>`: a SIGTERM, clean as below); stopping the unit alone may leave the container running. The window still closes the run at 05:00 UTC.

- **A reboot removes the timer.** A transient timer lives in `/run`: a reboot before it fires drops it, and nothing runs that night (2026-10-14: a reboot at 17:01Z, no entries in the journal). After any reboot or bootstrap before 22:00, run `systemctl list-timers --all | grep rws-backfill` again and schedule it anew if it is gone.
- **"Unit rws-backfill-nl1.service was already loaded".** A unit of an earlier night is left (one started without `--collect`, which ended failed): `sudo systemctl reset-failed rws-backfill-nl1.service`, then `systemd-run` again. "Unit … not loaded" from `stop` or `reset-failed` of a timer that is gone is harmless.

Ctrl-C and `docker stop` (SIGINT, SIGTERM) are safe and clean: the run ends between two chunks (never between the archive object, the manifest line and the cursor), gives the lease back and exits 0 with `"stopped":"interrupted"`, so the next `run` starts at once. A `kill -9`, a reboot or a lost container leaves the lease, which lapses within 2 minutes (a `run` before that exits `busy`). Either way the next `run` continues at each job's cursor (§1). The window closing between two chunks is the normal end of a night; `run` again the next evening until `status` shows every job `done`.

## 4. Status

```bash
rwsc run --rm --no-deps -T backfill backfill status
```

One JSON line per job (`job`, `series`, `status`, `range_from`, `range_to`, `data_from`, `cursor`, `chunks_done`, `chunks_with_data`, `requests`, `request_budget`, `attempts`, `provider_values`, `inserted`, `revised`, `skipped`, `dropped`, `unreconciled`, `error`) and a totals line (`jobs`, `by_status`, `chunks_done`, `requests`, `inserted`, `revised`, `unreconciled`). The counters are kept by the loader, so they follow the run with a delay of a loader pass. The same numbers, summed per source, are in `/api/v1/health/sources` as `backfill` (`jobs`, `active`, `chunks_done`, `chunks_with_data`, `inserted`, `revised`, `unreconciled`, and `quarantined`: the backfill payloads of the source the loader set aside) for a source that has jobs. `chunks_with_data` above the ledger's chunk count means archived history not loaded yet: one such chunk of an active job holds the runner (`unloaded`, a 2-second pause) until the loader has it. `quarantined` above 0 (it counts quarantined backfill payloads; a skipped one, such as a missing object, is not in it) means a chunk the loader set aside: it has a ledger row with no counts, and its job fails `unreconciled` (§5); look at the quarantined batches (`docs/runbooks/schema-drift.md`) before anything else.

## 5. Pause, resume, abort

```bash
rwsc run --rm --no-deps -T backfill backfill pause --job 7     # planned or running -> paused
rwsc run --rm --no-deps -T backfill backfill resume --job 7    # paused or failed -> planned (clears the error and the attempts)
rwsc run --rm --no-deps -T backfill backfill abort --job 7     # planned, running, paused or failed -> aborted (final)
```

A running `run` notices a pause or abort before its next request and goes on to the next job. Rows already stored stay: an abort stops the fetching, it removes nothing.

| `status` / `error` | What it means and what to do |
|---|---|
| `paused` / `budget` | The job used its request budget (for FR-2 also a 206 that halved the chunk down to a day: §8) (retries, halvings, or far more chunks than planned). **Look first** (`attempts`, `requests` against `chunks_done`): a runaway is a bug. If the use is explained, re-plan the rest (below). Raising `request_budget` by hand does not work: the runner refuses a budget above what `plan` gives the range (`invalid_job`) |
| `failed` / `unreconciled` | A chunk's counts do not add up (`provider_values = kept + dropped` and `kept = inserted + revised + skipped`): a bug; **or** the loader set a chunk aside (quarantined or skipped; since the P14a queue fix its ledger row has no counts and `reconciled` false, and the batch says why: `docs/runbooks/schema-drift.md`). Do not resume. Keep the output of `status` and the job number, and open an issue. For a set-aside chunk, once its cause is fixed: abort the job and re-plan it from that chunk's day (below). A `replay` of the day loads its rows but adds no counts to the job, which stays failed |
| run `"stopped":"stuck"` (exit 1) | The guard said `unloaded` for 10 minutes while nothing else held the runner: a chunk of an active job will never reach the ledger (§1). Find the job: `sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c "SELECT j.id, j.status, j.chunks_with_data - count(DISTINCT c.chunk_from) AS unloaded FROM backfill_job j LEFT JOIN backfill_chunk c ON c.job_id = j.id WHERE j.status IN ('planned', 'running', 'paused') GROUP BY j.id HAVING j.chunks_with_data - count(DISTINCT c.chunk_from) > 0"`, then abort it and re-plan it from its cursor's day (below) |
| `failed` / `truncated` | Even a one-day chunk reached 90 % of the parser's cap, or 144,000 values. Nothing was committed for it. Report it (KG-339) |
| `failed` / `invalid_job` | The job row is not one `plan` makes: another chunk, a range outside [floor, data epoch] or a budget above the plan's. Someone changed it by hand or through the runner's login: find out who, then `abort` it and plan again |
| `failed` / `unregistered` | The registry no longer selects the series. Restore the registry row or `abort` the job |
| `failed` / `schema_drift` with `drift` `zip_*`, `csv_header`, `csv_rows`, `backfill_window` (DE-8) | The ZIP is not what the spec's caps and header allow: see §8. The object is not archived. `zip_name` is a member name outside the anchored pattern or a station twice; `backfill_window` is a line with no `backfill` window (a forged or damaged line) |
| `failed` / `truncated` (DE-8) | Never for DE-8: a file is a file and is never halved (`halvable: false`); a `truncated` there is a bug, open an issue |
| `failed` / `schema_drift` with `drift` `unknown_variant` (CH-9) | The manifest line's variant is not one of the spec's dataset ids, or the record keys are not the dataset's. Look at the line (§8) |
| `failed` / `upstream_error`, `throttled`, `network`, `timeout`, `dns` | Five failed attempts in a row. Wait, check `docs/runbooks/provider-outage.md`, then `resume` |
| `failed` / `schema_drift`, `invalid`, `unexpected_status`, `client_error` | The provider changed or refused. Look at `docs/runbooks/schema-drift.md`; the object is not archived. Since the P14a queue fix the run's job line (the night's journal, `sudo journalctl -u rws-backfill-nl1`) carries `drift`, the parser's fixed code, for a `schema_drift`; `status` does not. `resume` after a fix, or `abort` (KG-355) |
| `failed` / `archive` | The archive write failed (disk full? `docs/runbooks/disk-full.md`). `resume` after the cause is gone |

**Re-planning the rest of a paused job** (owner only, after looking): abort it and plan its series again from the day of its cursor (`status` shows `cursor`), which makes a new job with a fresh budget. Re-fetching the cursor's day is safe (§1).

```bash
rwsc run --rm --no-deps -T backfill backfill abort --job <job>
rwsc run --rm --no-deps -T backfill backfill plan --spec <spec> --series <series> --from <cursor day, YYYY-MM-DD>   # <series>: the job's `series` in status
```

## 6. Verify

After a run (or each night), from the VPS:

1. **Status.** `backfill status` shows the jobs you expect: `done`, or `planned`/`running` with a cursor that moves; `unreconciled` is **0** in every job line and in the totals line. Any `unreconciled` above 0 is a bug or a chunk the loader set aside (§5).
2. **Reconciliation.** For a done job, `inserted + revised + skipped` equals the rows kept, and `provider_values` equals kept plus `dropped`. The ledger has one row per chunk:

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
     "SELECT job_id, count(*) AS chunks, sum(provider_values) AS provider_values, sum(inserted) AS inserted, sum(revised) AS revised,
             bool_and(reconciled) AS reconciled FROM backfill_chunk GROUP BY 1 ORDER BY 1"
   ```

   `reconciled` is true everywhere, apart from a chunk the loader set aside (its job failed `unreconciled`, §5).
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

   The limits: `status` stays `ok` (no `degraded` or `down` that the backfill caused), `lag_p95_s` stays under 120, `backlog_age_s` under 60 (the guard holds the runner there since the P14a health-scan fix), and NL-1's `tier1.fresh` equals its `total` (apart from a `provider_stale` the provider caused) with `last_new_data` moving. Paste the samples (they hold no secret and no owner value) into the PR or issue; an agent ticks the [agent-prod] criterion from them (KG-343).

**The per-hour live lag from the ledger.** The samples show the outside view. In the morning, the owner (or an agent given the output) reads `loaded_at - fetched_at` of the live batches per hour, beside the backfill batches of the same hour. It is the measure that failed on the nights of 2026-10-12 and 2026-10-15 (§ Incidents in `docs/plan/PHASES.md` §49). `took` is the time from a backfill batch to the next batch the loader started: its load time while chunks queue (as on 2026-10-15), but since the queue fix also the loader's wait for the next chunk (up to its 10-second tick and the next fetch), so read it as a cycle time; a `took` far above that cycle is a slow load (KG-356). Copy the block as it stands (the `SQL` line ends the heredoc and must start the line):

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws <<'SQL'
WITH b AS (
  SELECT origin, loaded_at, fetched_at,
         lead(loaded_at) OVER (ORDER BY loaded_at, id) - loaded_at AS took
  FROM ingest_batch WHERE loaded_at > now() - interval '36 hours')
SELECT to_char(date_trunc('hour', loaded_at), 'MM-DD HH24"h"') AS hour,
  count(*) FILTER (WHERE origin = 'backfill') AS bf,
  round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY took) FILTER (WHERE origin = 'backfill'))) AS bf_took_p50_s,
  round(extract(epoch FROM max(took) FILTER (WHERE origin = 'backfill'))) AS bf_took_max_s,
  count(*) FILTER (WHERE origin = 'live') AS live,
  round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY loaded_at - fetched_at) FILTER (WHERE origin = 'live'))) AS live_p50_s,
  round(extract(epoch FROM percentile_cont(0.95) WITHIN GROUP (ORDER BY loaded_at - fetched_at) FILTER (WHERE origin = 'live'))) AS live_p95_s,
  round(extract(epoch FROM max(loaded_at - fetched_at) FILTER (WHERE origin = 'live'))) AS live_max_s
FROM b GROUP BY 1 ORDER BY 1;
SQL
```

Before the backfill live p50 was about 5 s and p95 about 10 s. On the night of 2026-10-12/13 (the health scan) p95 was 743 to 3,598 s; on 2026-10-15/16 (30 chunks allowed in front of the live lines) 57 to 2,037 s, with `bf_took_p50_s` 2 s but 57 s in the worst hour. Paste the table beside the samples.

## 7. How much database it will use (A§11.4)

The year-1 budget gives the observations **at most 23 GB** (`docs/plan/ARCHITECTURE.md` §11.4). The backfill adds to it for good: its raw objects are retention class `backfill`, which the pruner never deletes, and its rows are never dropped. The dry-run (§3) projects the size per provider; the figures below are **computed from constants measured on the fixtures (about 290 bytes of JSON and 90 bytes of database per value, a zstd ratio of 15), not measured in production** (KG-344).

| Provider | Series | Range | Chunks | Requests | Time at 1/s | Values (at most) | Database (at most) | Archive |
|---|---|---|---|---|---|---|---|---|
| NL-1 (28 H, 13 Q; P14a) | 41 | 1990-01-01 to 2026-10-02 | 13,776 | 15,293 | about 4.2 h | 79.2 M | about 7.1 GB (31 % of 23 GB) | about 1.5 GB |
| NL-1 (**today**, 71 series since P16b) | 71 | 1990-01-01 to 2026-10-02 | – | 26,483 | about 7.4 h | – | **about 12.35 GB** (54 % of 23 GB) | – |
| DE-8 (`hydro/w`, 9 tier-1 gauges) | 32 units | 1950-01-01 to 2026-08-01 | 3,740 | 32 | 16 min of requests at 30 s, but every slice waits for its load: `hours_with_loads` says 8.6 h at 8 s a slice; the first night saw 26 s a slice even on an empty file, with the backlog defect present (§8.1). Plan two to four nights and re-measure | 24.2 M grid points | about 2.18 GB | about 157 MB (ZIPs do not compress) |
| FR-2 (QmnJ 31, HIXnJ 40) | 71 | 1950-01-01 to 2026-08-01 | 284 (with halvings) | 284 | about 10 min at 2 s | 1,985,941 daily values | about 0.18 GB | about 17 MB |
| CH-9 (2289 W and Q, 2106 W) | 2 datasets | 2020-06-01 to 2026-08-01 | 152 | 152 | about 3 min at 1 s | 2,594,304 values (1,297,152 records; half on the 10-minute grid) | about 0.09 GB | about 10 MB |
| BE-3, BE-1/2, CH-8, LU-7, others | – | – | – | – | – | – | – | later P14 PRs add their own row |

These are **upper bounds**:
- the dry-run counts duration divided by the native step (10 minutes), but the history is coarser: Lobith H in 1995 is hourly, in 1960 daily (KG-340);
- rows under another method than the registered one are dropped: for example, Q history at Lobith in 2010 is method F216, not the registered F230, so a Q series gets little or nothing for such years (KG-342);
- the figure is the sum over all series; a `--series` or `--from` that is later cuts it in proportion.

The three P14b rows are 2,441,317,410 B together, about 2.44 GB (a test holds the sum under 3 GB); the DE-8 count is grid points of the selected stations, the FR-2 and CH-9 counts are the dry-run's. Per row, the database constant is 90 bytes; the kill -9 integration test measured about 102 bytes a row (102.1 in the NL-1 resume test; 95 for a clean insert), so the per-row part may be 10 to 15 % off. The two effects above are far larger, and they push the other way. So the real growth is far lower. The owner picks `--from` from the dry-run and checks the current size first:

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c "SELECT pg_size_pretty(pg_database_size('rws')) AS rws, pg_size_pretty(pg_total_relation_size('obs')) AS obs"
```

Run `backfill plan --dry-run` again with the `--from` you choose; if the total plus `pg_database_size` is not comfortably inside the 200 GB disk and the 23 GB obs line, take a later `--from` or fewer series. After the first night, compare `pg_database_size` with the dry-run and write the measured figure into `docs/capacity.md` (KG-344). Partitions: `obs` gets one yearly partition per year below 2026-01-01 (`docs/runbooks/partition-maintenance.md`); a restore drill (≤ 4 h) is the phase-close [owner] check.

## 8. The P14b providers: DE-8, FR-2, CH-9

The three specs write into the series of **another source** (`target` in `registry/backfill.yaml`): DE-8 into the DE-7 `<no>/W` series, FR-2 into the FR-1 aggregate twin series `<code>/QmnJ` and `<code>/HIXnJ`, CH-9 into the CH-1 series `2289/W`, `2289/Q` and `2106/W`. They have no live capture, so `/api/v1/health/sources` shows DE-8's, FR-2's and CH-9's `status` as `unknown` (KG-388). Rules that hold for all three:

- **Ceiling.** A job ends at **`DATA_FLOOR` (2026-08-01T00:00Z)**, not at the data epoch; `plan` caps `--to` and refuses a later one; a manifest line that reaches past it stores nothing at or after it. The history therefore stops short of every day the site shows (A§8 Q6, KG-390).
- **Guard.** `backfill_guard` judges `stale` on the **target's** health (DE-7, FR-1 or CH-1 must be `ok`), and `loader_lag`, `backlog` and `unloaded` on the job's own source. A `stale` run sleeps 5 minutes and looks again.
- **Rows.** DE-8 and FR-2 statut 16 are validated (qc bit 2), FR-2 statut 4 is raw, CH-9 is raw. A validated archive value replaces a live raw row with one `obs_revision`; a raw value never replaces a live row (counted `skipped`). Aggregate series have no `obs_1h` or `obs_1d` rows.
- **Ledger.** Reconciled per line: `provider_values = kept + dropped` and `kept = inserted + revised + skipped`. The key is `(job_id, archive_key, chunk_from)`. The status output and the totals are the ones of §4.
- **Log line `backfill_raw_dropped`** (DE-8): the rows of members nobody selected (`unselected`), placeholders, WSV duplicates and unregistered stations that a file carried, by code. It is a count for review, not a drop to chase: the file holds 27 stations and the spec selects the tier-1 ones.
- **Order with NL-1.** See §3 ("The order of the specs").

### 8.1 DE-8 (`de-8-backfill-w`, host `www.opengeodata.nrw.de`)

32 decade files (1950 to 2020 of the Rur, Niers-u-Schwalm, Ems and Issel-Berkel-Vechte catchments), 20 requests an hour at most, 30 s apart. A job is one decade file: it is fetched **once** and cut into P30D slices of the stations' grid; the later slices send nothing (the lease is renewed before each commit). Dry-run, plan and run as in §3, with `--spec de-8-backfill-w`:

```bash
rwsc run --rm --no-deps -T backfill backfill plan --spec de-8-backfill-w --dry-run
rwsc run --rm --no-deps -T backfill backfill plan --spec de-8-backfill-w
rwsc run --rm --no-deps -T backfill backfill run
```

Expected dry-run totals: 32 series (units), 3,740 chunks, 32 requests, 24,166,944 values, 2.18 GB database, 157 MB archive. A 20 MB file (Rur 2020) holds 27 members and inflates to 292 MB; the loader needs about 311 MB resident for it (the container has 768 MB). The first slice of a file takes about 2.4 s to parse, the others read the memo (about 2 ms).

**The backlog age of a slice (the first night, 2026-10-18/19).** Every slice line of a file carries the file's one fetch time. Until the loader fix that followed P14b, the backlog aged a slice waiting for the loader's next tick by that time: minutes to hours. Public health showed that `backlog_age_s`, which the watchdog's `load_backlog` (15 minutes) could page on, and the guard said `backlog` and held the runner 5 minutes instead of 2 s. The night did 412 slices: the empty Rur 1950 file, Rur 1960 and 1970, and 46 slices of Rur 1980, from 26 s a slice on the first file to 154 s on the fourth. Since the fix a backfill line has no age of its own (`waitsFrom` in `load/pipeline.ts`): the backlog ages the live lines only, and reads 0 s, never "nothing to load", while only backfill lines wait. A slice still waits one loader cycle (its 10 s tick plus the tick's work); the next night measures it for the remaining 3,328 slices.

**The scan of every partition (2026-10-18 to 2026-10-20, #190).** From the first DE-8 rows (Rur 1960, 2026-10-18 at 23h) the loader's upsert and rollups read every `obs` partition for each payload, about 7 s a statement: slices took 35 to 57 s (median per hour) on the second night, which did 329 slices (the run's totals line in `journalctl -u rws-backfill`), and the live lag rose for good (CLAUDE.md Gotcha "A loader join of `obs` needs a constant time range"). Since #190 those joins carry the payload's range. Measure the slice time again on the first night after its deploy (`backfill_chunk.loaded_at` per hour; the `bf` column of the query in §6 counts one batch per DE-8 file, not per slice).

**Verify.** Besides §6: a done job's ledger has one row per slice of its file, all `reconciled`. The hold means a 1950s series has a grid point every 15 minutes while its last row is at most 24 h old, and none after longer silence (KG-385). The archive ends **2026-07-01**, so the last decade's final slices are empty grid points, not failures.

**Failure codes (all `schema_drift` with a `drift` code in the run's job line).** `zip_eocd`, `zip_cd`, `zip_members`, `zip_total`, `zip_ratio`, `zip_name`, `zip_method`, `zip_encrypted`, `zip_symlink`, `zip_multidisk` (the ZIP guard: more than 200 members, more than 640 MiB inflated, ratio above 50, a member name outside the anchored pattern `^\d{13}_…_Wasserstand_cm\.csv$`, a station twice); `encoding` (not UTF-8); `csv_header` (a member whose first line is not `station_name;station_no;dateTime;value[cm]`: NRW changed the layout, or this is a Q member); `csv_rows` (a member over 2,000,000 rows); `backfill_window` (a line with no `backfill` window); `truncated` never (not halvable). The object is **not** archived for a drift found in `validity`. Do not raise a cap by hand: it is a `caps` entry with a measured `justification`, reviewed.

**A DE-8 file fetched again after a kill.** A `kill -9` between the put, the append and the cursor makes the next run fetch the file once more (`reuse` memoises per run, not across runs). The second object is **a second archive object of the same file, never pruned** (class `backfill`, 20 MB); its slices load as no-ops (0 new, 0 revised) and the ledger counts each slice once (KG-391). Nothing to do; it is the price of the resume.

### 8.2 FR-2 (`fr-2-backfill-elab`, host `hubeau.eaufrance.fr`)

71 units (31 `QmnJ`, 40 `HIXnJ`), one request per series and up to P7300D (20 years, at most about 7,300 records of a page of 20,000). Pacing: 2 s apart, 1,800 an hour at most; FR-1's live capture keeps its own 10 an hour (the budget test asserts the sum stays under 3,600). Plan and run with `--spec fr-2-backfill-elab`; expected dry-run: 71 units, 284 requests, 0.18 GB database, 17 MB archive.

**A 206 halves the chunk.** A page with a `next` (or a `count` above the page) is `truncated`: the runner halves the chunk in **whole days** and asks again, down to one day (every halving counts against the budget). A job that exhausts its budget in halvings is `paused` / `budget` (KG-395): read `status` (`attempts` against `chunks_done`), then re-plan from the cursor's day (§5). The day rule of the dates is A§7.4 (Europe/Paris midnight before 2007-03-23, UTC from it: KG-383). A statut other than 0, 4, 8, 12 or 16, or a qualification other than 12, 16, 20, is a retained `unknown_quality`. A revised daily value is not re-synced (`date_debut_prod`, KG-389): re-plan the last months.

### 8.3 CH-9 (`ch-9-backfill-bs`, host `data.bs.ch`)

Two datasets, `100089` (Rhine at Basel, station 2289: W and Q) and `100236` (Birs at Münchenstein, 2106: W only), P30D chunks from 2020-06-01, 1 request a second (25,200 a night at most, under 10 % of the portal's 500,000 a day). The request is `…/<dataset>/exports/json` with a `where` on the chunk (never `/records`, which stops at offset + limit 10,000), and the manifest line's **variant is the dataset id** (`lineVariant`). Plan and run with `--spec ch-9-backfill-bs`; expected dry-run: 2 units, 152 requests, 0.09 GB database, 10 MB archive (the dry-run counts the 5-minute records, though only the 10-minute grid instants load). Raw only (KG-387); 2106 Q is not loaded (`q_not_twin`, KG-393).

**Failure codes.** `unknown_variant` (`schema_drift`): the line's variant is not `100089` or `100236`, or the record's keys are not the dataset's (a renamed field). Anything else is the generic list of §5.

## 9. The method census and the #184 replay (NL-1)

**Why.** Until #184 the NL-1 normaliser merged RWS's daily mean (`GEM24H`, a second list under the same method) into the 10-minute series: the midnight values were withheld as `conflict` or counted `duplicate`, and where the 10-minute value was missing the daily mean was stored as an instantaneous row (an **orphan**). The archive still holds every payload (class `backfill` is never pruned, §1), so a replay restores what was withheld. The census says first what that replay will write. It also counts, per method, the history the registry does not store (`unregistered_method`), which is the input of stage 2 (twin series per method, KG-342).

**What it is.** `backfill census --spec <id>` is read-only: it reads the raw archive and the registry, **opens no database, sends no request and writes no file**. It takes NL-1 backfill specs only (`nl-1-backfill-obs`); any other spec, or `--dry-run`, `--from` or another flag, exits 64. It parses every archived payload of the spec as the loader does, once as the code stands and once as the code before #184 read it, so the difference is exactly what a replay changes.

**Run it** outside the backfill window (22:00–05:00 UTC), with the runner idle (`backfill status` shows no job `running`) and the loader caught up (`.loader.backlog_age_s` small), and the replay (below) straight after it. A line the loader has not read yet, or a KG-355 job planned again after the census, moves the numbers:

```bash
rwsc run --rm --no-deps -T backfill backfill census --spec nl-1-backfill-obs > census-184.jsonl
```

It needs neither `DB_*` settings nor secrets; the raw archive is `RWS_RAW_DIR` (default `/data/raw`, where the service mounts it). Exit codes: 0 done, 64 bad arguments or not an NL-1 backfill spec, 78 the registry or `registry/backfill.yaml` is invalid, 1 the archive root cannot be read or the spec has no line in it (a wrong archive never prints a census of zeros), or the walk failed (`backfill census: failed (<code>)`: a file-system code such as `EACCES` or `EIO` is the archive, `unknown` the census itself). **A file without a final `totals` line is not a census**: orphan lines are printed as they are found, so a failed run leaves some behind; run it again.

**The output** is one JSON object per line, in this order. Every code in it passed a strict pattern or is `"?"`; there is no provider text (no `Omschrijving`, no name) and no error text.

| Line | Fields |
|---|---|
| `{"orphan":{…}}` (first, as found) | `series` (the registry's key), `ts`, `value`: a row the old code stored that the new code does not (a daily mean stored as an instantaneous row) |
| `{"group":{…}}` (sorted by key) | One per `code/quantity/hoedanigheid/method/bewerking/unit` of the lists: `role` and `audience` of the registry row of the list's key (`null` if none), `lists`, `values`, `ok_values` (known quality, not a gap, inside the line's window and the 1990 floor, not in the future), `gap`, `unknown_quality`, `statuses` (`Ongecontroleerd`, `Gecontroleerd`, `Definitief`), `first`, `last` (ISO of the `ok_values`), `step` (the most common gap between instants as an ISO duration, `P1D`, `PT1H`, `PT10M`) |
| `{"series":{…}}` | One per registered series with a non-zero count: `key`, `restorable`, `requalified`, `orphan` |
| `{"totals":{…}}` (last) | `spec`, `manifest_from`, `manifest_to` (first and last manifest day holding a counted line), `lines`, `objects`, `duplicate_lines`, `duplicate_lines_differing`, `failed_validity`, `missing`, `bad_object`, `unreadable`, `unparsed`, `excluded_lists` (lists that are not `meting`, `OW`, ungrouped), `withheld_lists` (lists of a registered series whose audience is not the source's, such as the NL-1 `off` rows: counted, never described, because the file goes to a public issue), `values`, `processed_values`, `restorable`, `requalified`, `orphan`, `groups`, and `expect` |

`restorable` counts rows only the new code stores (the withheld midnights), `requalified` rows both codes store with another value or quality, `orphan` rows only the old code stored. Only series of the source's own audience count (the loader stores none of an `off` series). A chunk is counted once: a line whose body has the sha256 of one counted before (a refetch of the same answer, or the recorder's `recovered` line beside the runner's own, KG-341) and a line of the same location, quantity and datum with the same chunk start (a `kill -9` between the put and the cursor, then a changed answer) are `duplicate_lines`; the second kind is also `duplicate_lines_differing` (a replay keeps the newest fetch, the census the first, so `n_new` then has that chunk's rows of slack). `unreadable` > 0 means an archive object could not be read: a replay **stops** at that object, so fix it first (`docs/runbooks/disk-full.md`, the restore runbook).

**Read the orphans** from the file, on any machine with `jq` (copy it off the VPS; it holds public NL-1 counts and codes only):

```bash
jq -c 'select(.orphan)' census-184.jsonl
jq -c '.totals' census-184.jsonl
jq -c 'select(.group) | .group | select(.bewerking != "NVT")' census-184.jsonl   # the processed lists
```

**The stage-1 replay.** Straight after the census, with the runner idle:

```bash
rwsc run --rm --no-deps -T load replay --source NL-1 --spec nl-1-backfill-obs --from <totals.manifest_from> --to <today> --dry-run
rwsc run --rm --no-deps -T load replay --source NL-1 --spec nl-1-backfill-obs --from <totals.manifest_from> --to <today>
```

The final JSON line of the real run (`docs/runbooks/replay.md` §2) matches `totals.expect`:

| Replay field | Expected |
|---|---|
| `lines` | `expect.lines` |
| `quarantined` | `expect.quarantined` = `bad_object` + `unparsed` (normally 0) |
| `skipped` | `expect.skipped` = `failed_validity` + `missing` |
| `n_new` | `expect.n_new` = `restorable` + `requalified` |
| `n_changed` | `expect.n_changed` = 0 |

**Why `n_new` holds the requalified rows too.** The store counts a changed row as `n_new` when it is new or when the stored row already carries the backfill bit 512 (`inserted = old_series IS NULL OR (old_qc & 512) <> 0`, `load/store.ts`). Every backfilled row carries it, so a backfill row whose value or quality the replay changes counts as an insert. `n_changed` is above 0 only when a backfill revises a live row, which cannot happen below the data epoch. `apps/server/test/load/census-replay.int.test.ts` proves the equality with the census.

**When `n_new` is higher than `expect`.** The census has no database, so it assumes the database holds every counted line as the code before #184 loaded it. A chunk the database never stored (a line first set aside as `object_missing` or quarantined, or a series registered after its chunk was loaded) loads whole in this replay, and raises `n_new` by that chunk's rows: whole-chunk amounts, often thousands. That is history arriving, not a fault. The second run (0/0) decides; a second run that still writes is a fault.

**Run it a second time:** it must print `"n_new":0,"n_changed":0`. A replay of a backfill payload does not alert for `processed` (a backfill payload counts it only; a live one alerts, `docs/runbooks/schema-drift.md`).

**The ledger keeps its first-load numbers.** A replay does not rewrite `backfill_chunk` or `backfill_job` (`recordChunk` adds a chunk once), so after this replay a job's `inserted` is lower than its stored rows by its `restorable`, and its `dropped` still holds the old `conflict` and `duplicate`. Each chunk still balances; do not compare job totals with `count(obs)`.

**Watch the live specs after the deploy.** The live and catch-up specs (`nl-1-obs-*`) run the same normaliser. No recorded live payload carries a processed list, but if RWS sends one, its series' midnights were withheld as `conflict` before and are `processed` now: the alert `processed` with an `nl-1-obs-*` spec in the hour after the deploy (and later) says so. Nothing is lost (the object is kept, its other lists load); open an issue for a census and replay of those specs.

**Orphans stay.** A replay never deletes a row, so the daily means stored as instantaneous rows before the fix (`orphan` in `totals`) are still in the primary series after it. Whether and how they are removed is decided after the census (O1 of #184, stage 2: a reviewed one-off cleanup of exactly the listed `(series, ts)` rows, run by the owner); with `orphan` 0 there is nothing to do. Attach `census-184.jsonl` to #184: it holds public NL-1 counts and codes only (no owner value).

**What it does not cover.** History before each job's `data_from` and everything before 1990 is not in the archive (KG-408); the census counts the archive only.

## What not to do

- Do not run it outside the window or around the clock. One `run` at a time: a second one is refused as `busy` (the lease), and after a crash the next one must wait the 2 minutes the lease takes to lapse. Never clear `backfill_lease` by hand while a runner may still be alive: two runners would break the 1 request/s rule.
- Do not restart a run that stopped `throttled` at once: the backoff (and any `Retry-After`) lived in the stopped process only.
- Do not edit `backfill_job`, `backfill_chunk` or `backfill_lease` by hand. Never set `cursor_ts` back: re-fetching is safe, but a hand edit is not tested; a changed chunk, range or budget fails the job as `invalid_job`.
- Do not select backfill rows by bit 512 alone: fill rows carry it too. Use `ingest_batch.origin` (`backfill` or `live`) (`docs/runbooks/replay.md` §7).
- Do not delete backfilled rows or objects to save space: the pruner keeps class `backfill`, and a replay never removes a point. Free the disk as `docs/runbooks/disk-full.md` says.
- Do not give `rws_backfill` more rights (no advisory locks: they stay revoked from PUBLIC), a third connection or a route from a visitor to the runner. Any change of the role is a reviewed migration.
- Do not restart `capture` (a deploy) during a run if you can avoid it: its start-up recovery can race with a backfill line on the shared day manifest (KG-341; the object is still loaded, only its ledger row is added by the next fetch).
- Do not resume a job that failed as `unreconciled`.
- Do not paste an owner-audience value into an issue. An owner source's backfill (later P14 PRs) shows only in the owner channel.
- Do not move a P14b ceiling or `display_start` without reading KG-390: `FILLED_BY` and `dataSince` do not know a cross-source spec yet.
