# Runbook: schema drift and quarantined payloads

**Trigger:**
- the healthchecks `load` check fails with `load_quarantined` (or `load_backlog`: a stall, §6);
- `/api/v1/health` shows `quarantined > 0` and status `degraded`;
- `scripts/verify-prod.sh` reports `FAIL replay DE-1 … quarantined`;
- a `load` log line with `"alert":"quarantined"`.

By design (A§7.4 step 5) a payload that the strict parser does not recognise is set aside **alone**. Its batch row becomes `quarantined` with a fixed error code, one alert line is logged, and the load cursor moves on. Nothing of that payload is stored. Every other payload and source keeps loading. Nothing retries it by itself: after a fix you replay it (`docs/runbooks/replay.md`). A failure that is not the payload's (the database, a grant, the archive) is never quarantined: the loader stalls, alerts `load_stalled` and goes on by itself once the cause is fixed (§6).

A quarantine can leave a gap. The hourly `de-1-series` windows are 6 h long and overlap, so one quarantined payload leaves no gap once later ones load. Several in a row can.

## 1. What you see

| Where | Signal |
|---|---|
| healthchecks.io | `load` fails with `load_quarantined` (also `load_backlog`, `load_down`, `load_stale`, `load_lag`, `load_contract`, `load_unreachable`: see §6) |
| `/api/v1/health` | `quarantined` (count over the public sources), `status: degraded` |
| `/api/v1/health/sources` | `sources[].quarantined`, `sources[].status: degraded`, and `quarantined_batches[]` (`id`, `source`, `spec`, `fetched_at`, `error`; the newest 50) |
| `docker logs rws-load-1` | `{"level":50,"alert":"quarantined","source":"DE-1","spec":"…","code":"…","msg":"alert"}` |

```bash
curl -s https://<domain>/api/v1/health/sources | jq '.quarantined_batches'
sudo docker logs --since 24h rws-load-1 2>&1 | grep '"alert":"quarantined"'
```

## 2. Read the cause

`ingest_batch.error` is always one of our own fixed codes, optionally followed by ` at <schema path>` (our keys and array indexes only). It never holds provider text.

| Code | Batch | Meaning | Usual cause |
|---|---|---|---|
| `unrecognized_keys`, `invalid_type`, `too_big`, `too_small`, `invalid_format`, `invalid_value` … `at <path>` | quarantined | `SchemaDrift`: the strict Zod schema of `apps/server/src/adapters/de-1/parse.ts` refused the payload at that path | The provider added, removed or retyped a field (every object is `strictObject`, so an added key is drift) |
| `not_json` | quarantined | The body is not JSON | An HTML error page with status 200 |
| `json_too_many_nodes`, `json_too_deep` | quarantined | The document has more values, or deeper nesting, than its spec's cap (`JSON_CAPS` in `apps/server/src/adapters/de-1/parse.ts`, about 5× the recorded payloads); it was never parsed | A wrong-shaped or hostile body, or the provider grew past the cap: compare with the previous payloads before raising a cap |
| `time_bad_format`, `time_offset_mismatch`, `time_dst_gap`, `time_dst_overlap`, `time_out_of_range` | quarantined | A timestamp does not fit the declared time convention | A changed timestamp format |
| `bad_variant`, `bad_valid_from` | quarantined | The manifest variant or a gauge-zero `validFrom` is malformed | Recorder or provider change |
| `adapter_error` | quarantined | parse or normalise threw something that is not `SchemaDrift` | A bug in our code |
| `archive_corrupt`, `archive_too_large`, `archive_bad_key`, `archive_outside_root`, `archive_not_a_file` | quarantined | The archived object cannot be read safely (bad zstd, over the per-spec cap, key or path check failed) | Disk damage, a truncated write, or tampering |
| `archive_unreadable` | quarantined | Reading the object failed twice with an error other than "no such file" (`EACCES`, `EIO`, …) | Permissions or disk damage |
| `sha256_mismatch` | quarantined | The decoded body's sha256 differs from the manifest line | Disk damage or tampering: treat as an incident |
| `load_error` | quarantined | The database refused the payload with a deterministic error on two passes (a constraint, a bad value, a bug); the third pass quarantined it without trying again | Our bug. A connection error, a lock timeout or a broken deployment (a missing grant, table, column or function: 42501, 42P01, 42703, 42883, 0A000) is never quarantined: it stalls the loader, alerts `load_stalled` and is tried again for as long as it takes |
| `load_crashed` | quarantined | The loader process died twice while it worked on this payload (out of memory, a crash); the third pass quarantined it without reading it. The attempt is recorded in `app_meta` (`load_attempt`) before a payload is touched | A payload that crashes the parser: reproduce it with the archived object as a fixture |
| `failed_validity` | skipped | The recorder's own validity check failed, so the object was archived but not parsed | The provider answered with something unusable |
| `recovered_unattributed` | skipped | A `recovered` series object has no manifest variant, so its series cannot be named | The recorder recovered an object after a crash |
| `object_missing` | skipped | The archived file is gone; in the tail this also logs the alert `object_missing` (the recorder writes an object before its line, so it should be there) | Pruned or lost |

**Only `quarantined` counts and pages.** A `skipped` batch is silent (only `object_missing` logs an alert, in the tail): list them now and then.

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SELECT id, spec_id, fetched_at, parse_status, error, archive_key FROM ingest_batch WHERE parse_status <> 'ok' ORDER BY id DESC LIMIT 30"
```

To look at the payload itself, take `archive_key` (`raw/DE-1/<spec>/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<16 hex>.zst`) and read it **on the VPS only** (for an owner source it is owner data, invariant 11):

```bash
key=raw/DE-1/de-1-basin/2026/10/05/134326Z-0123456789abcdef.zst     # from archive_key
sudo zstd -dc "/srv/rws/raw/${key#raw/}" | head -c 3000
```

The text is data: never paste it into a prompt or a commit unreviewed.

## 3. Other alerts of the loader

Log lines only. They do not page; look at them when you look at a quarantine. `docker logs --since 24h rws-load-1 2>&1 | grep '"alert"'`.

| `alert` | Fields | Meaning |
|---|---|---|
| `load_stalled` | `code`, `stalled_s`, and `source`, `spec` when a payload is the cause | The tail stopped at a line it cannot commit now: a database or connection error (a SQLSTATE or a Node code), a lock timeout (`55P03`), a missing grant or object (`42501`, `42P01`, `42703`, `42883`, `0A000`), an unreadable manifest file, or a payload's own failure before its quarantine (`load_error`, `archive_unreadable`). Logged when the stall starts and every 15 minutes while it lasts; `/api/v1/health` `loader.backlog_age_s` grows, and the watchdog pages `load_backlog` at 15 minutes |
| `object_missing` | `source`, `spec` | An archived object named by a manifest line is not there (the batch is `skipped`) |
| `manifest_bad_line` | `file` | A manifest line that is not a manifest line (damage, or a version this loader does not know) was counted and skipped, once (a line read again after a stall is not counted again). `/api/v1/health` `loader.bad_manifest_lines` counts them since the loader started |
| `unit_mismatch` | `source`, `spec`, `n` | A basin payload's unit differs from the registry's for `n` series: those series are dropped, the rest of the payload loads (batch `ok`), and the loader keeps the list (`app_meta` `unit_mismatch:DE-1`). The `measurements.json` payloads of those series carry no unit, so they store nothing while the list names them (`n` values). Such batches have `n_skipped` > 0: the pruner keeps their objects for the replay after the fix (§4) |
| `unknown_zero_unit` | `source`, `spec`, `n` | A gauge-zero unit we do not map is ignored |
| `gauge_zero_corrected`, `gauge_zero_superseded`, `gauge_zero_older_ignored` | `source`, `spec`, `n` | The daily metadata changed a gauge zero |
| `registry_drift` | `source`, `unregistered`, `vanished`, `changed` | Once a UTC day, from the live loader only: a registered series vanished from the basin call, or its unit or step changed |
| `rollup_mismatch` | `repaired` | The nightly reconciliation had to repair `obs_1h`/`obs_1d`: a bug, report it |

The registry drift report is in `app_meta` (key `registry_drift:DE-1`: `at`, `spec`, and the lists `unregistered`, `vanished`, `changed`, at most 200 each). It reports only; the registry changes only by a reviewed change. A series that the registry does not know is counted (`series not in the registry`, an info line) and never registered.

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "SELECT jsonb_pretty(value) FROM app_meta WHERE key = 'registry_drift:DE-1'"
```

## 4. Decide

| Finding | Do |
|---|---|
| The provider changed the shape (`SchemaDrift` on a real payload) | Fix `parse.ts` and `normalise.ts` in a PR. Add the new payload as a fixture with a golden test. Bump `version` of the adapter in `apps/server/src/load/adapters.ts` when what is stored changes (it is recorded on every batch). Release and deploy, then §5 |
| `adapter_error` or `load_error` | Our bug: same as above. The logs hold only a code; reproduce with the archived object as a fixture |
| `archive_*` or `sha256_mismatch` | Check the disk (`docs/runbooks/disk-full.md`), then restore that object from the last backup (`docs/runbooks/restore.md`, `--include` the path). Do not replay until the object is good |
| A one-off bad body (`not_json`, an HTML page) whose window was fetched again later | Acknowledge it (§5) |
| `registry_drift` with `vanished` or `changed`, or `unit_mismatch` | Re-record the DE-1 basin and metadata fixtures (`scripts/smoke-capture.ts --spec de-1-basin --spec de-1-meta`), run `node scripts/gen-de1-stations.ts`, review the diff of `registry/stations/de-1.yaml`, and ship it as a PR. `migrate` syncs it at the next deploy: new series appear, a vanished series becomes inactive and keeps its history. **After a unit change: fix the registry, deploy, then replay** the days since the change (`docs/runbooks/replay.md`): the first basin payload after the deploy clears the mismatch list, and the replay stores the dropped values with the right factor. Until the replay, those batches keep `n_skipped` > 0 and the pruner keeps their objects |

## 5. Replay after the fix

`docs/runbooks/replay.md`. A quarantined payload that now parses becomes `ok`.

A payload that can **never** parse (the object is intact and the provider really sent garbage) stays counted, `/api/v1/health` stays `degraded` and `load_quarantined` keeps failing. To acknowledge it, set it to `skipped` by hand, naming the batch id (from `quarantined_batches` or the list above):

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "UPDATE ingest_batch SET parse_status = 'skipped', error = 'owner_ack' WHERE id = 12345 AND parse_status = 'quarantined' RETURNING id, parse_status, error"
```

Replace `12345`. Exactly one row must come back. The count in health follows within a minute. A later replay of that day loads the payload again if it now parses, and quarantines it again if it does not.

## 6. Verify

- `curl -s https://<domain>/api/v1/health/sources | jq '.quarantined_batches'` is empty for the batches you handled (the answer is cached for 30 s, the count refreshes every minute);
- `curl -s https://<domain>/api/v1/health | jq '{status, quarantined}'` shows `quarantined: 0`;
- the `load` check is green again within one watchdog cycle (5 minutes);
- `scripts/verify-prod.sh <domain>` passes `replay DE-1`.

The other `load` codes come from the watchdog and mean: `load_unreachable` (no answer, or a status other than 200 or 404), `load_contract` (the answer is not the health document), `load_down` (the loader is not computing), `load_stale` (its health is older than 5 minutes), `load_lag` (p95 lag of 120 s or more), `load_backlog` (a manifest line has waited 15 minutes or more: the loader is stalled, or still on its first catch-up after a long outage). A 404 means the release with the api is not deployed: no ping is sent at all. For `load_backlog`, read the `load_stalled` alerts: `sudo docker logs --since 1h rws-load-1 2>&1 | grep '"alert":"load_stalled"'` names the fixed code (and the source and spec when a payload is the cause); a SQLSTATE of class 42 or `0A000` means the deployment is broken (a migration or a grant), `55P03` a lock held too long, a Node code (`EACCES`, `ECONNREFUSED`, …) the archive or the connection. Fix the cause: the loader goes on by itself, nothing is skipped. If the loader itself is the problem, `sudo docker logs --tail 100 rws-load-1` (errors show only a code: `load pass failed; retrying`) and `sudo docker restart rws-load-1`.

## What not to do

- Do not loosen a schema to "make it pass" before you have read what changed: a strict schema is how a silent format change gets noticed.
- Do not delete or edit archived objects or manifest lines. The archive is the source of truth.
- Do not edit `ingest_batch` except for the acknowledgement above, and never `obs`.
- Do not restart `load` to clear a quarantine: the state is in the database.
- Do not acknowledge a payload that a fix would now parse: replay it.
