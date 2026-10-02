# Runbook: schema drift and quarantined payloads

**Trigger:**
- the healthchecks `load` check fails with `load_quarantined` (or `load_backlog`: a stall, §6);
- `/api/v1/health` shows `quarantined > 0` and status `degraded`;
- `scripts/verify-prod.sh` reports `FAIL replay DE-1 … quarantined` (or `FAIL replay NL-1 …`, from P2b);
- a `load` log line with `"alert":"quarantined"`;
- the `load` check fails with `load_twin`, or a log line with `"alert":"twin_breach"` or one of the NL-1 alerts `unregistered_method`, `unknown_quality`, `conflict`, `registered_dropped` (§3, §4), or, from P5a, `datum_mismatch` (CH-1 and CH-3) or `unknown_quality` (FR-1), or, from P5b, `gauge_zero_withheld` (DE-8), `label_offset_changed` or `label_offset_unknown` (LU-1: `docs/runbooks/label-offset.md`) or `dst_gate` (§3, §4);
- a GitHub issue "Contract drift: the nightly live check failed" (§7).

The owner-audience sources (BE-3, LU-2; later LU-3, LU-4) never page and never reach public health: their drift codes, quarantines and twin breaches are in `docs/runbooks/owner-drift.md` (P5c).

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
| `unrecognized_keys`, `invalid_type`, `too_big`, `too_small`, `invalid_format`, `invalid_value` … `at <path>` | quarantined | `SchemaDrift`: the strict Zod schema of `apps/server/src/adapters/de-1/parse.ts` (P2b: `nl-1/parse.ts` and `nl-2/parse.ts` likewise; P5a: `fr-1`, `fr-3`, `ch-2` and `ch-3`; P5b: `lu-6`) refused the payload at that path | The provider added, removed or retyped a field (every object is `strictObject`, so an added key is drift) |
| `not_json` | quarantined | The body is not JSON | An HTML error page with status 200 |
| `json_too_many_nodes`, `json_too_deep` | quarantined | The document has more values, or deeper nesting, than its spec's cap (`JSON_CAPS` in `apps/server/src/adapters/de-1/parse.ts`, and in `nl-1/parse.ts`, `nl-2/parse.ts` and, from P5a, the `parse.ts` of `fr-1`, `fr-3`, `ch-2` and `ch-3` and, from P5b, `lu-6`, about 1.5 to 5× the recorded payloads); it was never parsed | A wrong-shaped or hostile body, or the provider grew past the cap: compare with the previous payloads before raising a cap |
| `time_bad_format`, `time_offset_mismatch`, `time_dst_gap`, `time_dst_overlap`, `time_out_of_range` | quarantined | A timestamp does not fit the declared time convention | A changed timestamp format; for NL-1, a `Tijdstip` with an offset other than `+01:00` (`time_offset_mismatch`), and the same for CH-1, whose `measurementTime` must be at `+01:00` all year |
| `bad_variant`, `bad_valid_from` | quarantined | The manifest variant or a gauge-zero `validFrom` is malformed; P5a: FR-3, when the series named in the body is not the one the line asked for, and CH-3, when the variant is not a station id (1 to 6 digits) | Recorder or provider change |
| `csv_empty`, `csv_quote`, `csv_width`, `csv_rows`, `csv_columns`, `csv_field` | quarantined | P5a, CH-1: `scanCsv` refused the SPARQL CSV: no header, an unterminated quote, a row not as wide as the header (CH-1 refuses a wider one too, LU-1 does not), or a cap (2,000 rows, 1,000 columns, fields of 1 KB) | A truncated or wrongly shaped answer, or a cube that outgrew the cap: compare with the previous payloads before raising it |
| `csv_header` | quarantined | P5a, CH-1: the header is not exactly `id,name,water,time,q,w,t,dl,wkt`, the variables of the fixed query in `registry/capture.yaml` | LINDAS renamed or reordered a variable, or the query was edited |
| `bad_id`, `bad_name`, `bad_water`, `bad_wkt`, `bad_number`, `bad_danger_level` at `rows.<n>` | quarantined | P5a, CH-1: a field does not match its strict pattern (the station id 1 to 6 digits, a name of at most 200 characters, an https IRI, a WKT point, a plain number, a danger level 1 to 5 or `https://cube.link/Undefined`) | A changed value format at LINDAS |
| `zip_eocd`, `zip64`, `zip_multidisk`, `zip_members`, `zip_cd`, `zip_encrypted`, `zip_method`, `zip_symlink`, `zip_name`, `zip_ratio`, `zip_total`, `zip_local`, `zip_overlap`, `zip_size`, `zip_crc`, `zip_inflate` | quarantined | P5b, DE-7 and `de-8-hydro`: the loader's ZIP guard (§6.7) refused the archive, read from its central directory before any member is inflated. `zip_members`: more than 10 members. `zip_name`: a member that is not on the spec's allowlist (`messwerte.txt`; `pegel_messwerte.txt`, `pegel_tagesmittelwerte.txt`, `pegel_tagesmaxima.txt` and `pegel_stationen.txt`; `Hydrologische-Stationen-NRW_EPSG25832.csv`), a name twice, or a name with a `/`, a `..`, a backslash or a drive. `zip_ratio`: a member or the archive over 50:1. `zip_total`: more than 200 MB inflated. `zip_size`, `zip_crc`, `zip_local`, `zip_overlap`, `zip_cd`, `zip_eocd`: the directory is damaged or lies about a member. `zip_symlink`, `zip_encrypted`, `zip_method`, `zip64`, `zip_multidisk`: forms the guard never accepts | The provider changed the archive (a new or renamed member), a truncated download, or a hostile ZIP: compare the member list with the spec in `registry/capture.yaml` and the loader entry in `apps/server/src/load/adapters.ts`. The recorder's validity check runs the same guard, so a ZIP that fails it is `skipped` as `failed_validity` and normally never reaches the loader |
| `csv_header`, `csv_empty`, `csv_width`, `csv_rows`, `station_no`, `bad_value`, `time_bad_format`, `position`, `text`, `name`, `number`, `unit` | quarantined | P5b, the strict readers of DE-7, DE-8 and LU-1. DE-7: the first line is not exactly `station_no;time;value(cm)` (`csv_header`), a member with no line (`csv_empty`), a line that is neither three fields nor a terminator `<no>;` (`csv_width`), more than 400,000 data rows in `messwerte.txt` or 3,000,000 in `pegel_messwerte.txt` (`csv_rows`; measured 238,678 and about 2.1 million), a station number that is not 6 to 13 digits (`station_no`), a time or a value of another shape (`time_bad_format`, `bad_value`; `NA` is a gap). DE-8: the header of the OpenHygon file or of the hydro member is not the pinned one (`csv_header`), `position`, `text` (a name over 200 characters), `bad_value` (a `Nullpunkt` that is not a number, `NA` or empty). LU-6: `position` (a point outside 5–7°E and 49–51°N); its other failures are the schema codes of the row above. LU-1: the header does not start `Name,Number,Unit` or has no label (`csv_header`), a label that is not `dd.mm.yyyy HH:MM` (`time_bad_format` at `labels.<n>`), an empty or over-long `Name`, a non-empty `Number`, a unit other than `cm` or `m`, a value of another shape (`bad_value`), more than 100 rows (`csv_rows`) | The provider changed a file: compare with the previous payloads and the fixtures before raising a cap or relaxing a pattern |
| `line_length`, `encoding` | quarantined | P5b, DE-7: a line over 128 characters (the splitter itself cuts a line without end at 1,024) is `line_length`; `encoding` is bytes that are not UTF-8 or, in `messwerte.txt`, any character from U+0080 on (it is ASCII). Also `encoding` for the OpenHygon file and the LU-1 CSV when they are not UTF-8 | A corrupt download, or the provider changed the encoding (the NRW `pegeldaten.zip` members and the OpenHygon file are UTF-8, the hydro member is ISO-8859-1) |
| `time_axis` | quarantined | P5b, LU-1: the labels are not consecutive 15-minute steps on a Luxembourg clock (A§7.4 step 2): a missing, doubled or shuffled column, a label that does not exist (the spring-forward gap), the repeated hour of the fall-back night once or three times, or every label ambiguous. The loader never guesses | AGE changed the file (a column dropped, another step) or a DST case the axis does not read: §4 |
| `bad_value`, `unit_mismatch`, `duplicate_key` | quarantined | P5a, CH-2: a station's `sensor_*_last_value` is not a number and one of the four units (an empty string and `-` are gaps); its unit is not the one the registry declares for the series (`m ü.M.` a level in m, `m` a relative stage in m, `m³/s`, `l/s`); two features share a station key. **Here `unit_mismatch` is a drift code that quarantines the payload, not the retained drop of §3** | hydrodaten changed a format, a unit or a station's kind: re-record `ch-2-pq`, run `node scripts/gen-ch1-stations.ts` and review `registry/stations/ch-2.yaml` |
| `trace_order`, `length_mismatch`, `duplicate_time` | quarantined | P5a, CH-3: the `_de` plot does not have exactly the two traces `Wasserstand` (`m ü.M.`) then `Abfluss` (`m³/s`) (the other languages translate the names, so order and units are checked); a trace's x and y arrays differ in length; one instant occurs twice in a trace | BAFU changed the plot's structure |
| `value_out_of_range` | quarantined | P5a, any adapter: a raw value times its series' factor is not a finite number (a value near the edge of the double range), or (review SR-2) its magnitude is over 1e7 in canonical units (cm or m³/s: 100 km, ten million m³/s), so the payload is quarantined instead of storing an infinity or overflowing the `real` column | A corrupt or hostile payload |
| `adapter_error` | quarantined | parse or normalise threw something that is not `SchemaDrift` | A bug in our code |
| `archive_corrupt`, `archive_too_large`, `archive_bad_key`, `archive_outside_root`, `archive_not_a_file` | quarantined | The archived object cannot be read safely (bad zstd, over the per-spec cap, key or path check failed) | Disk damage, a truncated write, or tampering |
| `archive_unreadable` | quarantined | Reading the object failed twice with an error other than "no such file" (`EACCES`, `EIO`, …) | Permissions or disk damage |
| `sha256_mismatch` | quarantined | The decoded body's sha256 differs from the manifest line | Disk damage or tampering: treat as an incident |
| `load_error` | quarantined | The database refused the payload with a deterministic error on two passes (a constraint, a bad value, a bug); the third pass quarantined it without trying again | Our bug. A connection error, a lock timeout or a broken deployment (any SQLSTATE of class 42 or 0A: a missing grant, table, column or function, a type mismatch; with bound parameters no payload value causes one) is never quarantined: it stalls the loader, alerts `load_stalled` and is tried again for as long as it takes |
| `load_crashed` | quarantined | The loader process died twice while it worked on this payload (out of memory, a crash); the third pass quarantined it without reading it. The attempt is recorded in `app_meta` (`load_attempt`, by the line's place in the manifest) before a payload is touched and cleared when its pass ends | A payload that crashes the parser: reproduce it with the archived object as a fixture. Rarely a good payload: the process died twice while the database was going down (KG-073); a replay of its day loads it |
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
| `load_stalled` | `code`, `stalled_s`, and `source`, `spec` when a payload is the cause | The tail stopped at a line it cannot commit now: a database or connection error (a SQLSTATE or a Node code), a lock timeout (`55P03`), any class 42 or 0A error (our SQL or schema: a missing grant or object, a type mismatch), an unreadable manifest file, or a payload's own failure before its quarantine (`load_error`, `archive_unreadable`). Logged when the stall starts and every 15 minutes while it lasts; `/api/v1/health` `loader.backlog_age_s` grows, and the watchdog pages `load_backlog` at 15 minutes |
| `object_missing` | `source`, `spec` | An archived object named by a manifest line is not there (the batch is `skipped`) |
| `manifest_bad_line` | `file` | A manifest line that is not a manifest line (damage, or a version this loader does not know) was counted and skipped, once (a line read again after a stall is not counted again). `/api/v1/health` `loader.bad_manifest_lines` counts them since the loader started |
| `unit_mismatch` | `source`, `spec`, `n` | A basin payload's unit differs from the registry's for `n` series: those series are dropped, the rest of the payload loads (batch `ok`), and the loader keeps the list (`app_meta` `unit_mismatch:DE-1`). The `measurements.json` payloads of those series carry no unit, so they store nothing while the list names them (`n` values). Such batches have `n_skipped` > 0: the pruner keeps their objects for the replay after the fix (§4) |
| `unknown_zero_unit` | `source`, `spec`, `n` | A gauge-zero unit we do not map is ignored |
| `unregistered_method` | `source`, `spec`, `n` | NL-1 (P2b): a registered series (same location, quantity and datum) arrived under another `WaardeBepalingsMethode` code, so its key is not in the registry. Its `n` values are withheld, never stored under the old series; the batch is `ok` with `n_skipped` > 0, so the pruner keeps the object for the replay after the fix (§4) |
| `unknown_quality` | `source`, `spec`, `n` | NL-1 (P2b): `n` values carry a quality code other than 00, 10, 20, 25, 30, 40 and the gap code 99. FR-1 (P5a): a `code_statut` other than 0, 4, 8, 12 and 16, or a `code_qualification_obs` other than 12, 16 and 20. They are withheld (`n_skipped` > 0, object kept) |
| `conflict` | `source`, `spec`, `n` | NL-1 (P2b): one series states two different values for one instant (split lists of the payload). P5a: the same inside one FR-1 page or one FR-3 series, and in CH-1 for a station that comes twice with its latest time stated twice and different values. The `n` instants are withheld, nothing is chosen between the values (`n_skipped` > 0, object kept) |
| `registered_dropped` | `source`, `spec`, `n` | NL-1 (P2b): RWS changed the ProcesType, compartment or grouping of a series we store: a list under a registered key (location, quantity, datum and method) is no longer `meting`, compartment `OW` without a Groepering. Its `n` values are withheld (`n_skipped` > 0, object kept). The same rules on a key the registry does not hold (forecasts, tides and HW/LW extremes have methods of their own) are only counted as `process`, `compartment` or `grouping` |
| `datum_mismatch` | `source`, `spec`, `n` | P5a, CH-1 and CH-3: `n` values contradict the declaration of their series in the registry: a water level below 150 m at a series declared a level in m ü.M. (LN02), or 150 m or more at one declared a relative stage (the 9 relative gauges, for example 2283), or a CH-3 level for a CH-1 series that is a stage. They are withheld, never stored, and the declaration is never changed per row (`n_skipped` > 0, object kept). In CH-1 an exact 0 at a level series is not one of them: it is BAFU's missing value, dropped as `sentinel` and counted only, so a station frozen at 0.0 shows as stale on the map, not as an alert (#51; CH-2 and CH-3 have no such rule, KG-131) |
| `twin_breach` | `twin` | The twin check (P2b, A§7.4 step 7) of a pair turned failing: on timestamps that both series have, TAW − NAP at Eijsden-grens differs from 233 cm by more than 1 cm (P5b: or any of the seven pairs of `registry/twins.yaml` differs from its relation by more than the tolerance for more than `1 − min_share` of the points, or finds a lag other than 0: `docs/runbooks/twin-failure.md`), or **no timestamp is aligned at all** (a failing check with `n_aligned` 0: one side has no values in the 24 hours, while the pair was checked before). Logged when the pair turns failing (from ok, or from no check yet this hour) and again at each new hour while it fails; `/api/v1/health` shows `twins.failing` and status `degraded`, and the watchdog pages `load_twin` (§6). It is not a quarantine: nothing is set aside, both series keep loading |
| `gauge_zero_corrected`, `gauge_zero_superseded`, `gauge_zero_older_ignored` | `source`, `spec`, `n` | The daily metadata changed a gauge zero |
| `gauge_zero_withheld` | `source`, `spec`, `n` | P5b, every zero without a validity date (review CR-2): DE-8 `de-8-hydro` (the `Nullpunkt`; the file states no date) and FR-1 `fr-1-ref` (a zero without `date_debut_ref_alti_station`). The zero of `n` series differs from the zero already stored, and the stored zero has no validity date, so nothing says from when the new value holds. The new value is not written and the stored one stays; a dated zero would supersede it. The payload that holds the zero corrects it when it is replayed |
| `label_offset_changed` | `source`, `day`, `from`, `to` | P5b, LU-1: the nightly detector measured, for UTC day `day`, a label offset (minutes) other than the one the loads applied. The next payloads use the new one; the stored values move only by a replay: `docs/runbooks/label-offset.md` |
| `label_offset_unknown` | `source`, `day`; `measured` when the offset was out of range | P5b, LU-1: the day decided nothing (too few informative instants, no clear shift, or a series missing), or (review L1) its offset lies beyond ±15 minutes; the day is stored as undecided and the offset carried forward stays in force: `docs/runbooks/label-offset.md` |
| `dst_gate` | `spec` | P5b, once per spec when `load` starts: the spec is not loaded, because its source has an offset-less time convention (`naive-local`, `local-labelled-z`, `start-of-interval`) and `DST_PROOF` in `apps/server/src/load/adapters.ts` has no entry for it. Its payloads stay in the archive; see §4 |
| `registry_drift` | `source`, `unregistered`, `vanished`, `changed` | Once a UTC day, from the live loader only: a registered series vanished from the basin call, or its unit or step changed (P5b: the key is the payload's source, so `registry_drift:DE-8` holds the OpenHygon master against the DE-7 registry and `registry_drift:LU-6` the LU-6 points against the LU-1 registry, as `registry_drift:NL-2` does for NL-1) |
| `rollup_mismatch` | `repaired` | The nightly reconciliation had to repair `obs_1h`/`obs_1d`: a bug, report it |

The registry drift report is in `app_meta` (key `registry_drift:DE-1`: `at`, `spec`, and the lists `unregistered`, `vanished`, `changed`, at most 200 each). It reports only; the registry changes only by a reviewed change. A series that the registry does not know is counted (`series not in the registry`, an info line) and never registered.

`registry_drift:NL-2` (P2b) holds the report of the NL-2 WFS snapshot against the **NL-1** registry (NL-2 has no series of its own): `unregistered` (a snapshot key of a registered station that the registry lacks; on the recorded snapshot `driel.boven/Q/NVT/other:F103` and `epen.geul.cottessen/Q/NVT/other:F007`, both known: KG-086, KG-088), `vanished` (a registered NAP or NVT key with no value in the snapshot, that is none for 12 hours, the window of the capture's CQL filter) and `changed` (`field: position`, coordinates that differ by more than 1e-4°). `vanished` and `changed` raise `registry_drift`; `unregistered` alone is an info line. An NL-2 payload that quarantines with `invalid_value at numberReturned` is a paged or capped snapshot: `numberReturned`, `numberMatched` and `totalFeatures` must all equal the number of features, since a partial list would report every series it left out as `vanished`. Check the capture's request (`registry/capture.yaml`, spec `nl-2-wfs`) and whether the provider now pages.

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "SELECT jsonb_pretty(value) FROM app_meta WHERE key = 'registry_drift:DE-1'"   # or 'registry_drift:NL-2'
```

The drops that are only counted, never alerted, are in the batch's own counters: FR-1 `site_level` (a row without `code_station`, a duplicate of the station's own series), CH-1 `superseded` (an older observation of a station that comes twice), CH-3 `thinned` (the 5-minute samples off the 10-minute grid) and `fill_not_primary` (a fill row whose target series is a mirror, a twin or `off`). A fill row whose target key the CH-1 or FR-1 registry does not hold counts in `n_skipped`, so the pruner keeps the object, but is never a quarantine. P5b adds DE-7 `placeholder` (the station numbers `1234567`, `123456` and `1234512345`, which name no gauge), `sentinel` (`NA`), `duplicate`, `outside_window` and `too_old`, LU-1 `outside_window` and **`row_width`** (an old-format row with a value after the last label: the 5-day file's Esch-Sûre; the row is withheld, counted and neither alerted nor kept for the pruner, KG-135), and DE-8 `zero_missing` (a `Nullpunkt` of `NA`). `outside_window` is the load window of the spec (6 hours before the previous loaded payload), not a fault.

The recorder's own alert `walk_broken` (P5a) is not a loader alert: a Hub'Eau `next` that the recorder will not follow (another host or path, or not a string), or a walk-page URL it already asked, cuts the FR-1 walk the way the page cap does. The next run resumes below the oldest observation it fetched and the window never moves past a page that was not fetched. It is counted in the capture counters and the daily report and logged by `capture`; `docs/runbooks/recorder-down.md` §1 has the read-only look at the failed walk pages in the manifest.

## 4. Decide

| Finding | Do |
|---|---|
| The provider changed the shape (`SchemaDrift` on a real payload) | Fix `parse.ts` and `normalise.ts` in a PR. Add the new payload as a fixture with a golden test. Bump `version` of the adapter in `apps/server/src/load/adapters.ts` when what is stored changes (it is recorded on every batch). Release and deploy, then §5 |
| `adapter_error` or `load_error` | Our bug: same as above. The logs hold only a code; reproduce with the archived object as a fixture |
| `archive_*` or `sha256_mismatch` | Check the disk (`docs/runbooks/disk-full.md`), then restore that object from the last backup (`docs/runbooks/restore.md`, `--include` the path). Do not replay until the object is good |
| A one-off bad body (`not_json`, an HTML page) whose window was fetched again later | Acknowledge it (§5) |
| `registry_drift` with `vanished` or `changed`, or `unit_mismatch` | Re-record the DE-1 basin and metadata fixtures (`scripts/smoke-capture.ts --spec de-1-basin --spec de-1-meta`), run `node scripts/gen-de1-stations.ts`, review the diff of `registry/stations/de-1.yaml`, and ship it as a PR. `migrate` syncs it at the next deploy: new series appear, a vanished series becomes inactive and keeps its history. **After a unit change: fix the registry, deploy, record the change in KG-074, then replay** from an instant after the fetch time of the last basin payload that still showed the old unit (`replay --from <instant>`), never from an earlier time (`docs/runbooks/replay.md` §3 finds the instant: a replay reads every payload with today's factor, and a series payload carries no unit, so the magnitude of those fetched between the two basin calls decides). The first basin payload after the deploy clears the mismatch list; the replay stores the dropped values with the right factor and rewrites the rows stored mis-scaled between the change and its detection. Until the replay, those batches keep `n_skipped` > 0 and the pruner keeps their objects |

The NL-1 codes of §3 (P2b):

| Finding | Do |
|---|---|
| `unregistered_method` | RWS gave a registered series another method code. Re-record the WFS and catalogue fixtures (`scripts/smoke-capture.ts --spec nl-2-wfs --spec nl-1-catalogue`), run `node scripts/gen-nl1-stations.ts` (it takes the one method that is live in the WFS snapshot per series and fails when there is none or more than one), review the diff of `registry/stations/nl-1.yaml` and ship it as a PR. `migrate` syncs it at the next deploy: the new key is a new series, the old one becomes inactive and keeps its history. Then replay NL-1 from the day of the first alert (§5, `docs/runbooks/replay.md`): it stores the withheld values |
| `unknown_quality` | Read one payload (§2) to see the code, and ask RWS what it means (the meaning of code 25 is already open: catalogue C7). Extend the quality table in `adapters/nl-1/normalise.ts` in a PR with a fixture and a golden test, bump the adapter `version` in `apps/server/src/load/adapters.ts`, deploy, then replay from the day of the first alert |
| `conflict` | Read the payload (§2) for the series and instant: two different values for one instant. If RWS sends a correction twice, decide a rule in `normalise.ts` (a PR with a fixture), then replay; a one-off is loaded by a later payload that states one value for the instant. Never choose a value by hand in the database |
| `registered_dropped` | Read one payload (§2) to see which of ProcesType, `Compartiment` and `Groepering` changed for which series. If RWS now serves the series we store under the new metadata, a registry or `normalise.ts` change (a PR with a fixture and a golden test, adapter `version` bumped) is needed, then replay NL-1 from the day of the first alert: it stores the withheld values. If RWS serves both the old and the new list, record it in a known gap and ask RWS; do not widen the rules by hand |
| `datum_mismatch` | The alert carries only the source, the spec and `n`: read the cube (§2) to see which station's values contradict their declaration. BAFU may have turned a gauge into a relative one or the other way round, or the recorded fixture the declaration came from was wrong. Re-record the cubes (`node scripts/smoke-capture.ts --contact <e-mail> --info-url <url> --spec ch-1-lindas`, and `--row lake` for the lake cube; one request each, opt-in), run `node scripts/gen-ch1-stations.ts` (it declares a station `stage`/`LOCAL` when its recorded W is below 150 m and checks the CH-2 unit text against it, and fails when they disagree), review the diff of `registry/stations/ch-1.yaml` and `ch-2.yaml` and ship it as a PR. Then replay CH-1 (and CH-3) from the day of the first alert: it stores the withheld values (`docs/runbooks/replay.md`). Never change a declaration by hand |
| `twin_breach` | Look at `curl -s https://<domain>/api/v1/health/sources \| jq '.twins'` (`n_aligned`, `max_delta`, `ok`, `checks_7d`, `failed_7d`). **`n_aligned` 0 means no instant that both sides state in the window**: one side has no values (check that `nl-1-obs-twin` and `nl-1-obs-key` still succeed in `/status/capture.json`, and whether RWS still serves the series: a 204, or `unregistered_method` or `registered_dropped` alerts for it), or their instants no longer coincide (compare the latest timestamps of both series: a changed step or offset on one side). After a loader outage of more than 24 hours the first health pass can write one failing row with `n_aligned` 0 before the backlog loads; the same hour turns ok as it loads. A revision that one side has and the other not yet settles within 30 minutes (the newest 30 minutes are left out). If it lasts, look at the latest values of both series (`eijsden.grens/WATHTE/TAW/other:F007` and `…/NAP/other:F007`), at `unregistered_method` and `unknown_quality` alerts for them, and at whether `nl-1-obs-twin` and `nl-1-obs-key` still succeed (`/status/capture.json`). A real offset change (RWS changed a datum) is a registry and catalogue question for the owner: do not raise the tolerance to silence it. For the other pairs (P5b) and for a lag: `docs/runbooks/twin-failure.md` |
| `gauge_zero_withheld` | Read the stored and the published zero (`SELECT g.value_m, g.datum, s.provider_key FROM gauge_zero g JOIN series s ON s.id = g.series_id WHERE s.source_id = 'DE-7' AND upper_inf(g.valid)` on the VPS, `'FR-1'` for `fr-1-ref`, and the hydro member or referentiel page of the payload, §2). A re-levelled gauge is a real change that needs the history of zeros (P7, R-072): until then the stored zero stays and the owner decides in a reviewed change; a typo in the file corrects itself with the file. Nothing is lost: the hydro payload is archived (retention forever) |
| `label_offset_changed`, `label_offset_unknown` | `docs/runbooks/label-offset.md` |
| `dst_gate` | The release lacks the DST proof of the named spec (`DST_PROOF` has no entry, or the proof fixtures are missing); `apps/server/test/adapters/dst-gate.test.ts` fails in CI for that, so a release that logs it was built without that test passing. Restore the proof in a PR; the payloads are archived, and a replay loads them once the spec is listed (`docs/runbooks/replay.md`). Never add a spec to `DST_PROOF` without the two fixtures and their goldens |
| `time_axis` (LU-1) | Compare the labels of the payload (§2, on the VPS) with an earlier one. If AGE changed the file, change the axis rule in `apps/server/src/adapters/lu-1/normalise.ts` in a PR with a fixture and a golden (adapter `version` bumped), deploy, then replay LU-1 from the day of the first alert. Never relax the axis check to make a payload pass |
| A ZIP code (`zip_*`, DE-7 and `de-8-hydro`) | Read the member list of the archived object (decompress it with `zstd -dc` as in §2, on the VPS only, and list the ZIP). A new or renamed member is a reviewed change of `registry/capture.yaml` (the spec's `zip.members`) and of the loader entry in `apps/server/src/load/adapters.ts`, with a fixture; then replay. A ZIP that is truncated or hostile is not replayed |

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
- `scripts/verify-prod.sh <domain>` passes `replay DE-1` and `replay NL-1`.

The other `load` codes come from the watchdog and mean: `load_unreachable` (no answer, or a status other than 200 or 404), `load_contract` (the answer is not the health document), `load_down` (the loader is not computing), `load_stale` (its health is older than 5 minutes), `load_lag` (p95 lag of 120 s or more), `load_backlog` (a manifest line has waited 15 minutes or more: the loader is stalled, or still on its first catch-up after a long outage), `load_twin` (P2b: `/api/v1/health` shows `twins.failing` above 0, the twin check of §3 `twin_breach` is failing). A 404 means the release with the api is not deployed: no ping is sent at all. For `load_backlog`, read the `load_stalled` alerts: `sudo docker logs --since 1h rws-load-1 2>&1 | grep '"alert":"load_stalled"'` names the fixed code (and the source and spec when a payload is the cause); a SQLSTATE of class 42 or `0A000` means the deployment is broken (a migration or a grant), `55P03` a lock held too long, a Node code (`EACCES`, `ECONNREFUSED`, …) the archive or the connection. Fix the cause: the loader goes on by itself, nothing is skipped. If the loader itself is the problem, `sudo docker logs --tail 100 rws-load-1` (errors show only a code: `load pass failed; retrying`) and `sudo docker restart rws-load-1`.

## 7. A `contract-drift` issue was opened

The nightly workflow `contract-check.yml` (P2b; 03:23 UTC until P5a, 03:29 UTC since, midway between the recorder's CH-1 fetches for BAFU's rule of one download per 10 minutes; GitHub may start it late) sends one request each for `de-1-basin`, `nl-1-obs-key`, `nl-2-wfs`, `fr-1-obs` (the first page only, never `next`), `ch-1-lindas` (the river cube) and `ch-2-pq` (P5a added the last three) and, from P5b, `de-7-messwerte` (the ZIP, read through the same guard) and `lu-1-csv` (asked without a query string), and runs the answers through the loader's own validity, parse and normalise code. When one fails it opens the issue "Contract drift: the nightly live check failed" (label `contract-drift`) or comments on the one that is open; it never opens a second and never closes it. The issue lists one line per spec, `<spec> <code>`, and the run URL. The codes are fixed identifiers of ours, never provider text.

| Code | Meaning |
|---|---|
| `ok` | The spec passed |
| `fetch_<code>` | The request failed before an answer (`<code>` is the client's fixed code: `dns`, `network`, `timeout`, `too_large`, `not_allowlisted`, `redirect_cross_host`, …). The host is unreachable or blocked from the runner, or it moved |
| `http_<status>` | A status the spec does not accept (`http_404` a moved path, `http_403` or `http_451` a block, `http_5xx` a provider outage); `http_304` is an anomaly, because the check sends no validator |
| `invalid_<reason>` | The answer is not what the recorder's own validity check accepts (not JSON, a missing key, too few items, an HTML page) |
| a schema code, for example `unrecognized_keys at <path>` | `SchemaDrift`: the strict parser refuses the payload at that path. In production this payload would be quarantined (§1) |
| `unregistered_method`, `unit_mismatch`, `unknown_quality`, `conflict`, `registered_dropped`, `datum_mismatch` | The retained drop codes of §3: values that production would withhold (a renamed process type or compartment of Lobith is `registered_dropped`; `datum_mismatch` is CH-1's, and CH-2's `unit_mismatch` is a schema code of §2 that quarantines) |
| `unknown_series` | NL-1 only: it parsed, but the payload names a series that the registry does not have (the check fetches the first registry row, Lobith) |
| `no_rows` | Parsed, but a source with registered series produced no row and withheld nothing (for example every value a gap, stale or too old) |
| `too_large` | The body is over the loader's byte cap for the spec |
| `adapter_error` | `parse` or `normalise` threw something that is not `SchemaDrift`: a bug in our code |
| `no_spec`, `no_adapter`, `check_error`, `unreportable` | The check itself is out of step with `registry/capture.yaml` or `LOAD_ADAPTERS`, threw, or produced a code that did not match the line pattern: fix the check |

What to do:

1. Open the run from the issue and read the lines. `fetch_*` or `http_*` on all eight specs points at the runner, not the providers (GitHub's addresses are shared and a provider may block them: R-057): start the workflow again by hand (`workflow_dispatch`) the next day. On one spec, the provider is the cause.
2. **After the RWS CTD switch (2026-11-05),** `fetch_*` or `http_*` on `nl-1-obs-key` or `nl-2-wfs` most likely means that the host or path moved: edit the URL and the `hosts` allowlist in `registry/capture.yaml` in a reviewed PR (CODEOWNERS), record fresh fixtures, and check the recorder's own `cap-nl` check.
3. For a schema code, `no_rows`, `unknown_series` or a retained drop code the drift is real: **the same payload shape reaches the loader within minutes** (the recorder fetches `nl-1-obs-key` every 10 minutes), so also look for quarantined batches (§1) and the alerts of §3. Reproduce it offline with a fresh fixture, one request (opt-in, refuses under CI):

   ```bash
   node scripts/smoke-capture.ts --contact <e-mail> --info-url <url> --spec nl-1-obs-key
   ```

   Then fix the parser, the normaliser or the registry as in §4 (`node scripts/gen-nl1-stations.ts` for NL-1 registry changes), deploy, and replay (§5).
4. When the drift is fixed, the owner closes the issue. The next failing night opens a new one.

## What not to do

- Do not loosen a schema to "make it pass" before you have read what changed: a strict schema is how a silent format change gets noticed.
- Do not delete or edit archived objects or manifest lines. The archive is the source of truth.
- Do not edit `ingest_batch` except for the acknowledgement above, and never `obs`.
- Do not restart `load` to clear a quarantine: the state is in the database.
- Do not acknowledge a payload that a fix would now parse: replay it.
