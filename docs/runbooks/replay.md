# Runbook: replay archived payloads into the database

**Trigger:**
- after a fix, to load payloads that were quarantined (`docs/runbooks/schema-drift.md`);
- after a parse, normalise or registry change that alters what is stored (values dropped by a wrong unit or stored with a wrong factor, a new rule; §3 after a provider's unit change);
- after a restore of the raw archive when a payload was skipped as `object_missing` (`docs/runbooks/restore.md`);
- to prove that the archive still reproduces the database (a second replay must change nothing).

`replay` re-parses archived objects through the loader's own code path. It **never fetches**, never moves the load cursor and never touches the fetch health. The raw archive is the source of truth; the database can always be rebuilt from it, as far as the retention pruner has not deleted objects (`docs/runbooks/disk-full.md` §4).

## 1. The rules it keeps

| Rule | Consequence |
|---|---|
| Same code path as `load` (`Loader.payload`): one payload = one transaction, under the loader lock (a row lock on `app_meta` `loader_lock`) that `load`, the nightly reconciliation and the health pass share | It is safe to run while `load` runs; they take turns per payload (a wait over 30 s fails that payload's transaction: `replay: failed (55P03)`; run it again) |
| Newest fetch wins: the stored row of a point is what the newest fetch (`fetched_at`, then batch id) that stated it says; a newer fetch that states the same value takes the row over (a confirmation). Gauge zeros follow the same rule | Replaying an old range never reverts a newer value, in whatever order the payloads are replayed |
| The payload that holds a row (the newest that stated it) rewrites it when it now yields another value or qc | A replay after a fix of the parser, the normaliser or a registry factor corrects what that payload stored (one `obs_revision` per changed row); with an unchanged parser it writes nothing |
| It re-parses with **today's** registry: units, factors and datums are not versioned in time | After a provider's unit or factor change, replay only the payloads fetched since the change (§3); never an older day |
| A changed value writes exactly one `obs_revision` row; an identical row, or one a newer fetch holds, writes nothing | A no-op replay writes no row, no revision, no new batch id |
| One batch row per archive key (`ingest_batch.archive_key` is unique) | A replay updates the batch, it never adds a second one |
| A quarantined or skipped payload that now loads becomes `ok` | This is how a fixed drift is cleared |
| A payload that loaded before is never downgraded (for instance its object was pruned since) | A missing object of an `ok` batch changes nothing |
| The batch's `n_skipped` (values a registry change could still load) is counted again | After a registry fix, a replay sets it to 0 and the pruner may keep the object no longer |
| It never touches the tail's attempt record (`app_meta` `load_attempt`) and stops at the first payload that fails for a reason of its own or cannot be read | Exit 1 with the code (`replay: failed (<code>)`); the payloads before it are committed. Fix the cause and run it again, or narrow the range |
| Lines with a fetch error, an HTTP status of 400 or more, no object (304, `dup_of`, a closed gate) or no adapter are skipped | Only archived payloads are replayed |
| The range is in **manifest days**: the UTC day of the file `raw/_manifest/<day>.jsonl` the line is filed under (the day its fetch started; the recorder's recovery appends to past days) | Use a range that includes the day of the payload, `--to` inclusive |
| Arguments are checked against fixed patterns **and** the adapter table: `--source` must have a load adapter, `--spec` must be one of its specs, both days real UTC dates with `from ≤ to` | No identifier reaches SQL from the command line |

Adapter table today: `DE-1` with the specs `de-1-basin`, `de-1-series` and `de-1-meta`.

## 2. Run it

`replay` runs as a one-off container of the `load` service (role `rws_load`, the raw archive mounted, network `db`). It needs the compose files of the running release. Define this once per shell; it is the same command line as `rws_compose` in `rws-lib.sh`:

```bash
rwsc() { sudo docker compose -p rws --project-directory /var/lib/rws/active -f /var/lib/rws/active/compose.yaml \
  --env-file /etc/rws/rws.env --env-file /var/lib/rws/active/images.env "$@"; }
```

First count what it would touch (`--dry-run` reads the manifest and counts lines, and writes nothing):

```bash
rwsc run --rm --no-deps -T load replay --source DE-1 --from 2026-10-05 --to 2026-10-06 --dry-run
```

Then the real run. Leave out `--spec` for every spec of the source:

```bash
rwsc run --rm --no-deps -T load replay --source DE-1 --spec de-1-series --from 2026-10-05 --to 2026-10-06
```

It prints one JSON line at the end:

```json
{"source":"DE-1","spec":"de-1-series","from":"2026-10-05","to":"2026-10-06","dryRun":false,"lines":48,"loaded":48,"quarantined":0,"skipped":0,"n_new":0,"n_changed":0}
```

| Field | Meaning |
|---|---|
| `lines` | payload lines in range (all a dry run reports) |
| `loaded` | payloads that loaded (`ok`), including those that changed nothing |
| `quarantined` | payloads that still fail: the same `alert` line is logged again, and a batch that was quarantined stays so |
| `skipped` | `failed_validity`, `recovered_unattributed` or `object_missing` |
| `n_new`, `n_changed` | observation rows inserted, and rows whose value or qc changed (one `obs_revision` each), of the series that share their source's audience |

Exit codes: 0 done, 64 bad arguments (the usage line says which), 78 no database settings or secret, 1 failed (`replay: failed (<code>)`, a fixed code only).

A large range is one transaction per payload; it can be stopped and started again, because each payload is all or nothing and a finished one changes nothing the second time.

## 3. After a provider's unit or factor change

The registry fix is deployed first (`docs/runbooks/schema-drift.md` §4), and the first basin payload after it clears the mismatch list. Then replay from the **UTC day of the change**, the day of the last basin payload that still showed the old unit: normally the day of the first `unit_mismatch` alert, or the day before when that alert came in the first 15 minutes of a day (the basin call runs every 15 minutes; after an outage of the basin call, look up its last good fetch before the alert). Never start earlier: every payload replayed is read with today's factor, and a series payload fetched before the change carries the old unit (`measurements.json` states none).

```bash
rwsc run --rm --no-deps -T load replay --source DE-1 --from 2026-10-05 --to 2026-10-06 --dry-run
rwsc run --rm --no-deps -T load replay --source DE-1 --from 2026-10-05 --to 2026-10-06
```

It stores the values that were dropped as `unit_mismatch` while the list named the series, and rewrites the rows that were stored mis-scaled between the change and its detection (the payload that holds such a row rewrites it). The range is whole days, so on the first day the series payloads fetched before the change are read with the new factor too: the points that only they hold come out mis-scaled (KG-074). Check that day's values of the series by hand.

## 4. Verify

```bash
curl -s https://<domain>/api/v1/health/sources | jq '.sources[] | select(.id == "DE-1") | {status, quarantined, partitions_at}, .quarantined_batches'
```

- `quarantined` falls by the number of payloads that loaded (the count is recomputed every minute, the answer cached for 30 s);
- for a **no-op proof**, run the same replay twice: the second run must print `"n_new":0,"n_changed":0`;
- the per-partition checksums in `sources[].partitions` (md5 over series key, timestamp, value and qc) are recomputed nightly (after 02:00 UTC) and once when the loader first catches up with the manifest. After a replay that changed data, compare them after the next nightly run, or restart `load` (`sudo docker restart rws-load-1`): it recomputes them as soon as it has caught up with the manifest (`docs/runbooks/partition-maintenance.md` §4).

## What not to do

- Do not replay to "fix" a value the provider itself corrected: a newer payload already wins, and the older revision is in `obs_revision`.
- Do not replay days before a unit or factor change once the registry has the new one: their payloads would be read with the new factor (§3).
- Do not replay a range you have not counted with `--dry-run` first when it is large: every payload in it is read and decompressed.
- Do not run it against the raw archive while a restore is still copying files in: the loader would set an object that has not arrived yet to `skipped` (`object_missing`). Stop `load` first (`docs/runbooks/restore.md`).
- Do not move or edit `load_cursor`. Replay never needs to; `load` moves it by itself.
- Do not expect it to bring back what the pruner deleted: an object that is gone is `object_missing`.
