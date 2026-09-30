# Runbook: replay archived payloads into the database

**Trigger:**
- after a fix, to load payloads that were quarantined (`docs/runbooks/schema-drift.md`);
- after a parse or normalise change that alters what is stored (values dropped by a wrong unit, a new rule);
- after a restore of the raw archive when a payload was skipped as `object_missing` (`docs/runbooks/restore.md`);
- to prove that the archive still reproduces the database (a second replay must change nothing).

`replay` re-parses archived objects through the loader's own code path. It **never fetches**, never moves the load cursor and never touches the fetch health. The raw archive is the source of truth; the database can always be rebuilt from it, as far as the retention pruner has not deleted objects (`docs/runbooks/disk-full.md` §4).

## 1. The rules it keeps

| Rule | Consequence |
|---|---|
| Same code path as `load` (`Loader.payload`): one payload = one transaction, under the advisory lock that `load`, the nightly reconciliation and the health pass share | It is safe to run while `load` runs; they take turns per payload |
| Newest fetch wins: a row last written by a payload fetched later is left alone | Replaying an old range never reverts a newer value |
| A changed value writes exactly one `obs_revision` row; an identical row writes nothing | A no-op replay writes no row, no revision, no new batch id |
| One batch row per archive key (`ingest_batch.archive_key` is unique) | A replay updates the batch, it never adds a second one |
| A quarantined or skipped payload that now loads becomes `ok` | This is how a fixed drift is cleared |
| A payload that loaded before is never downgraded (for instance its object was pruned since) | A missing object of an `ok` batch changes nothing |
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
| `n_new`, `n_changed` | observation rows inserted, and rows whose value or qc changed (one `obs_revision` each) |

Exit codes: 0 done, 64 bad arguments (the usage line says which), 78 no database settings or secret, 1 failed (`replay: failed (<code>)`, a fixed code only).

A large range is one transaction per payload; it can be stopped and started again, because each payload is all or nothing and a finished one changes nothing the second time.

## 3. Verify

```bash
curl -s https://<domain>/api/v1/health/sources | jq '.sources[] | select(.id == "DE-1") | {status, quarantined, partitions_at}, .quarantined_batches'
```

- `quarantined` falls by the number of payloads that loaded (the count is recomputed every minute, the answer cached for 30 s);
- for a **no-op proof**, run the same replay twice: the second run must print `"n_new":0,"n_changed":0`;
- the per-partition checksums in `sources[].partitions` (md5 over series key, timestamp, value and qc) are recomputed nightly (after 02:00 UTC) and once when the loader first catches up with the manifest. After a replay that changed data, compare them after the next nightly run, or restart `load` (`sudo docker restart rws-load-1`): it recomputes them as soon as it has caught up with the manifest (`docs/runbooks/partition-maintenance.md` §4).

## What not to do

- Do not replay to "fix" a value the provider itself corrected: a newer payload already wins, and the older revision is in `obs_revision`.
- Do not replay a range you have not counted with `--dry-run` first when it is large: every payload in it is read and decompressed.
- Do not run it against the raw archive while a restore is still copying files in: the loader would set an object that has not arrived yet to `skipped` (`object_missing`). Stop `load` first (`docs/runbooks/restore.md`).
- Do not move or edit `load_cursor`. Replay never needs to; `load` moves it by itself.
- Do not expect it to bring back what the pruner deleted: an object that is gone is `object_missing`.
