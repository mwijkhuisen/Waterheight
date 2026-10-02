# Runbook: drift and breaches in the owner sources (SPW BE-3, AGE LU-2, LU-3, LU-4)

**Trigger:**
- `scripts/verify-prod.sh <domain>` fails `owner sources` (`owner_sources.healthy` is below `owner_sources.total` in `/api/v1/health/sources`), after the CI-only exception for old fixture data;
- a `load` log line with `"alert":"quarantined"`, `unit_mismatch`, `unknown_quality`, `conflict` or `twin_breach` whose `source` is `BE-3` or `LU-2`;
- the owner status file (`/srv/rws/owner/status/capture.json`) shows an owner spec with a `last_failure_status`, or the catch-up is not done when you expect it (§3);
- an SPW or AGE change that you know of: a new station, a new series, a renamed file.

Everything here concerns **owner-audience** sources (D22, ADR-0017): their payloads, rows, alerts and twin results exist only on the VPS and in the owner channel (invariant 11). Nothing about them reaches a public page: the public health document counts them in `owner_sources` and lists none, public `quarantined` and the loader's backlog count public sources only, and the watchdog reads the public document, so **an owner source never pages the phone**. You find a problem through `verify-prod.sh`, the loader's log and the owner status. This runbook is for the owner alone; the agents have no production access and never see a payload.

By design (A§7.4 step 5) a payload the strict parser does not recognise is set aside **alone**: its batch becomes `quarantined` with a fixed code, one alert is logged and the cursor moves on. The raw archive keeps it. LU-3 and LU-4 have no loader entry yet (P8a, P7a): their payloads are archived and checked by the recorder's validity check only, so their drift shows as a `failed_validity` batch and a failing spec in the owner status, never as a quarantine.

## 1. What you see

| Where | Signal |
|---|---|
| `verify-prod.sh` | `FAIL owner sources`: the detail says how many of the owner sources are healthy, never which |
| `docker logs rws-load-1` | `{"level":50,"alert":"quarantined","source":"BE-3","spec":"be-3-values","code":"…","msg":"alert"}`, and the retained drops (§2) with `n` |
| owner status | `/srv/rws/owner/status/capture.json`: `specs[]` for the owner specs (`last_success`, `last_failure_status`, `failed_items`) and, once the catch-up is done, a `seeds[]` entry; `reports/<date>.json` the daily report |
| the database, as the owner on the VPS | `own_source_health`, `own_ingest_batch` and `own_twin_check` (the owner family: the `psql` below runs as the cluster superuser on the `db` container's socket, which the owner has anyway) |

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SELECT source_id, status, last_fetch_ok, last_new_data, quarantine_count FROM own_source_health
   WHERE source_id IN ('BE-3','LU-2','LU-3','LU-4') ORDER BY 1"
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SELECT id, spec_id, fetched_at, parse_status, error FROM own_ingest_batch
   WHERE source_id IN ('BE-3','LU-2') AND parse_status <> 'ok' ORDER BY id DESC LIMIT 30"
sudo docker logs --since 24h rws-load-1 2>&1 | grep -E '"source":"(BE-3|LU-2)"' | grep '"alert"'
sudo jq '.specs[] | select(.source | test("^(BE-3|LU-[234])$"))' /srv/rws/owner/status/capture.json
```

To read a payload, take `archive_key` from the batch and read it **on the VPS only** (it is owner data):

```bash
key=raw/BE-3/be-3-values/2026/10/05/134326Z-0123456789abcdef.zst     # from archive_key
sudo zstd -dc "/srv/rws/raw/${key#raw/}" | head -c 2000
```

The text is data. Never paste it into a prompt, an issue, a commit or a PR: invariant 9 and 11. A real value of an owner source is never in the repository, not even to reproduce a bug; ask for a synthetic one (`pnpm fixtures:synth`, §6).

## 2. Read the cause

`ingest_batch.error` is always one of our own fixed codes, optionally followed by ` at <schema path>`. The codes shared with the other sources (`unrecognized_keys`, `invalid_type`, `too_big`, `json_too_many_nodes`, `json_too_deep`, `not_json`, the `archive_*` and `load_*` ones) are in `docs/runbooks/schema-drift.md` §2.

**Quarantined payloads (`SchemaDrift`):**

| Code | Source | Meaning | Usual cause |
|---|---|---|---|
| `kiwis_too_many_results` | BE-3 | A KiWIS call asked for more than 250,000 values and SPW answered with an error object, never a partial result | The call builder is bounded for one-minute steps (`adapters/_shared/kiwis/request.ts`), so a quarantine here means SPW lowered its limit, or a series reports a finer step than one minute. A reviewed change lowers `MAX_VALUES` and the replay of the catch-up (§3) fetches again |
| `kiwis_error` | BE-3 | Any other KiWIS error object (`InvalidParameterValue`, `DatasourceError`, …) in place of an answer | SPW changed a parameter name or its server failed. Read the archived body; the fixed capture URL is in `registry/capture.yaml` |
| `kiwis_no_header`, `kiwis_header`, `kiwis_row_width` | BE-3 | A list answer (`getStationList`, `getTimeseriesList`): no header row, a header that is not unique non-empty names, or a row not as wide as its header; also a row of a values item that is not as wide as its `columns` | SPW added, dropped or renamed a returnfield. `be-3-meta` payloads and the catch-up's list root; for a values item, a changed `columns` |
| `kiwis_columns` | BE-3 | A values item whose `columns` names a column twice, lacks `Timestamp` or `Value`, or a `getStationList` without the columns the gauge zeros need (`station_no`, `station_gauge_datum`, `station_gauge_datum_unit`) | SPW changed the returnfields. Values are read by column name, never by position, so this is drift, not a silent shift |
| `kiwis_no_metadata` | BE-3 | A values item without `station_no` or `stationparameter_no` | The `md_returnfields` of the catch-up request were not honoured |
| `bad_value` | BE-3 | A value that is neither a number nor null | A changed value format |
| `time_bad_format`, `time_offset_mismatch`, `time_out_of_range` | BE-3, LU-2 | A stamp does not read as ISO 8601 with its own offset | A changed timestamp format. A stamp with `+02:00` is fine (BE-3 asks `timezone=UTC` and still saw one): each stamp is read with the offset it states |
| `bad_variant` | BE-3 | A `be-3-meta` line whose variant is none of `stations`, `timeseries-1962373`, `timeseries-1962340` | A registry change to the capture spec without the loader |
| `array_length`, `invalid_value` at `0.columns` | LU-2 | The file is not exactly one station object, or `columns` is not `Timestamp,Value` | AGE changed the JSON. LU-2 reads rows by position only because `columns` says so |
| `encoding` | BE-3, LU-2 | The body is not UTF-8 | A corrupt download |
| `html_tag`, `html_tag_count`, `html_attr`, `html_json` | LU-4 | The page has no `<cmp-dashboard-station>` element, has two, has no or two `data-to-json` attributes (or an unterminated tag or quote, more than 64 attributes, a value over 256 KiB), or the attribute is not JSON | AGE redesigned the page, or served an error page with status 200. Seen first as a `failed_validity` batch, because the recorder's validity check uses the same extractor. A decoy inside a comment, a script or another attribute never causes one |

**Withheld and alerted (retained: the batch's `n_skipped` counts them, the pruner keeps the object, a replay after the fix loads them):**

| Code | Meaning | What to do |
|---|---|---|
| `unit_mismatch` | The payload's `ts_unitsymbol` is not the unit of the series' registry row (`m` and `m3/s` or `cumec` are the known spellings; LU-2: `cm`, and `m` for Esch-Sûre only). The values of that series are withheld, nothing is stored | SPW or AGE changed a unit. Do **not** edit the factor by hand: the registry rows are generated (§6). Read `docs/runbooks/schema-drift.md` §4 and KG-074 first, because a registry factor has no valid-from and a replay from before the change would rescale older rows |
| `unknown_quality` | A BE-3 quality code outside 200 (raw), 0 to 199 (validated), 205 and 210 (suspect), 253 (phantom) and -1 (missing) | SPW added a code. The values are withheld and kept; a reviewed mapping in `adapters/be-3/normalise.ts` and a replay load them. Quality codes are in catalogue §2.4 (`getQualityCodes`) |
| `conflict` | Two different values for one series at one instant, or a station twice in `getStationList` (no zero is stored) | DCENN L5860 (Theux) has two discharge series under one key, and they agreed on 2026-10-02: one value each instant is kept. A `conflict` there means SPW's two series now differ. Both values are withheld, never guessed |

**Counted in the batch, no alert (for `n_skipped` and the drop counters only):**

| Code | Meaning |
|---|---|
| `unknown` | The key (`<station_no>/<stationparameter_no>` for BE-3, the `ts_path` for LU-2) is not in the registry, counted once per series, nothing stored. **This is how new series show up**: SPW adds a station or a series, or AGE a file. See §6 |
| `phantom`, `sentinel` | Quality 253, or quality -1 or a Q or QADM value of exactly -1 (the QADM trailing step) |
| `future`, `too_old`, `duplicate`, `gap` | A stamp more than 15 minutes ahead, a value older than 120 days (BE-3) or 45 days (LU-2), a time stated twice with one value, a null or omitted value |
| `zero_unknown`, `zero_missing`, `bad_zero`, `unknown_zero_unit` | BE-3 gauge zeros: `9999.0` is SPW's unknown, a station without a datum, a datum that does not read or is outside the plausible range, or a unit that is not `DNG`. No zero is stored; the stage series stay in cm above an unknown zero |

A series SPW stopped long ago counts `too_old` on every layer (KG-148). It is not an alert and not a fault.

## 3. The BE-3 catch-up

SPW keeps decades, but the layers hold only the latest value per series, so the archive has no BE-3 value before 2026-09-29. The spec `be-3-catchup` fills the gap from the display start, 2026-08-24, once.

- **When it runs.** It has no cron: it is a seed. The recorder runs it after the deploy in the UTC hours 0 to 5 only (outside them a round writes "seed waits for its hours" and tries again within the hour), one request per 5 s, resumable per call. Its window is 2026-08-24 to the moment its first round started. About 7 calls a day in that window (4 batches for the level group and 3 for the discharge group): 300 to 420 calls, so 25 to 35 minutes. It needs no action.
- **See its status** (owner status only; the public `seed-report.json` never lists it):

  ```bash
  sudo jq '{done: (.done | length), files, coverage, started, done_at}' /srv/rws/raw/_state/seeds/be-3-catchup.json
  sudo jq '.seeds[] | select(.spec == "be-3-catchup")' /srv/rws/owner/status/capture.json
  sudo docker logs --since 24h rws-capture-1 2>&1 | grep be-3-catchup | tail
  ```

  `done` counts the two groups that finished (`row0`, `row1`: 2 is complete); `done_at` appears when both did and the `seeds[]` entry with it. A group that hit a transient failure or its cap stays unfinished and is tried again in the next round (within the hour while the hours last, else the next night); after 31 days from `started` the log says `seed incomplete after 31 days` and the daily report lists `seed_incomplete`. The payloads load through the normal tail (batches of `be-3-catchup` in `own_ingest_batch`), so a catch-up is loaded once its lines are archived and the loader has caught up.
- **A failing call** (a 5xx, `TooManyResults`) is named in `failed_items` of the owner status with its variant key (`values/<group>/<day>/<first ts_id>`); a body that is a KiWIS error object fails the recorder's validity check and is archived for diagnosis. A call that failed is fetched again in the next round, the calls before it are not.
- **Re-run it** (only after a registry regeneration that added series, §6, or after fixing a quarantine that dropped catch-up payloads: for the latter a replay is enough, §4). The seed asks again for every call, so move both state files aside before the capture restart; the loader then confirms what is stored and writes only what is new or changed:

  ```bash
  sudo mv /srv/rws/raw/_state/seeds/be-3-catchup.json /srv/rws/raw/_state/seeds/be-3-catchup.json.before-<n>
  sudo mv /srv/rws/raw/_state/be-3-catchup.json /srv/rws/raw/_state/be-3-catchup.json.before-<n>
  sudo docker compose -p rws --project-directory /var/lib/rws/active -f /var/lib/rws/active/compose.yaml \
    --env-file /etc/rws/rws.env --env-file /var/lib/rws/active/images.env restart capture
  ```

  The first file is the seed's progress, the second the seen ids of its calls (the last 5,000). The new window ends at the new start, and the round waits for UTC hour 0 if you restart outside the hours.
- **Never** widen `utc_hours`, shorten `pace_ms` or raise `max_expand` without the budget test (`apps/server/test/capture/budget.test.ts`) and the owner's review: `hydrometrie.wallonie.be` has no stated limit and no contact we have agreed anything with.

## 4. Replay owner payloads

The same command as every source (`docs/runbooks/replay.md` §2), with `--source BE-3` or `--source LU-2` (LU-3 and LU-4 are refused: no loader entry). **After the P5c deploy** the first replay is `replay.md` §9. Later, replay after:

- a parser, normaliser or registry fix that releases withheld values (`unknown_quality`, `unit_mismatch`, `unknown`, `conflict`): from the first day of the affected payloads, `--dry-run` first; a replay never removes a stored point;
- a regeneration of `registry/stations/be-3.yaml` or `lu-2.yaml` that added series (§6): `unknown` payloads load once the series exist.

A second pass must print `"n_new":0,"n_changed":0`. A replay of `be-3-values` loads each layer's latest values again, and of `lu-2-json` re-states the file's 7 days: with an unchanged parser both write nothing. LU-2 has no load window, so a replay does what the tail does.

## 5. Owner twin breaches

An owner pair compares an owner series with a public one: 38 BE-3 pairs (`constant` relation: the expected a − b is the median the window shows at shift 0) and 39 LU-1 ↔ LU-2 pairs (`offset` 0 ± 0.05 cm). The loader checks them with the others, every minute for the current UTC hour. For an owner pair:

- the result is in **`own_twin_check` only**, never in `/api/v1/health` (`twins`, `checks_7d` and `failed_7d` are the seven public pairs);
- the loader logs `"alert":"twin_breach"` with the pair's id in `twin`, when it turns failing and at each new hour while it fails;
- **nothing pages**: the watchdog reads the public document, and there is no owner status before P9. So read the owner view yourself, after the replays and then now and then (weekly is enough).

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SELECT * FROM (SELECT DISTINCT ON (twin_id) twin_id, window_end, n_aligned, median_delta, max_delta, lag_min, ok
                    FROM own_twin_check WHERE twin_id ~ '-(be3-[hq]|lu1-lu2-h)\$'
                    ORDER BY twin_id, window_end DESC) l
   WHERE NOT ok ORDER BY twin_id"
sudo docker logs --since 24h rws-load-1 2>&1 | grep '"alert":"twin_breach"'
```

The fields are those of `docs/runbooks/twin-failure.md` §1. For the owner pairs:

| You see | Meaning |
|---|---|
| A BE-3 pair, `median_delta` steady, `ok` true | Normal. The median is the detected difference of two gauge zeros of one gauge (SPW states the stage against its zero, the partner against its own), in cm or m³/s; it is reported, not declared |
| A BE-3 pair, `ok` false, `lag_min` 0 | Noise or a jump around the median: more than 5 % of the aligned points are further than 1 cm (0.01 m³/s) from it. One side's values differ: a unit or factor (`to_canonical` of the registry row), a provider revision, a re-levelled gauge (`be-3-meta`, or `fr-1-ref` for the partner), or a pair that was never the same gauge |
| `lag_min` not 0 | One side's stamps are shifted: a time-convention change at the provider. LU-1 ↔ LU-2 at ±15: the label offset in force (`docs/runbooks/label-offset.md`) |
| `n_aligned` 0, `ok` false | No instant both sides state in the window: one side stopped (the SPW layer, the AGE file or the public feed), or their instants no longer coincide |
| **`eijsden-grens-nl1-be3-q`** failing steadily | Expected possibility. Whether RWS's border discharge is SPW's own figure relayed is unverified (KG-144): if the pair never agrees, remove it from `SAME_GAUGE` in `scripts/gen-be3-stations.ts` in a PR and regenerate |

A breach corrects and sets aside nothing: both series keep loading. A pair that is wrong by registry (a mispaired gauge) is fixed by the generator's curated table and a regeneration, never by editing `registry/twins/*.yaml`, which CI regenerates and diffs. The rules of `twin-failure.md` §3 and §4 (find the cause, decide) apply, except that no check of `verify-prod.sh --soak` covers the owner pairs.

## 6. SPW or AGE adds or changes a series: regenerate with `--extract`

The registry holds **every** series of the two SPW groups (owner decision Q2) and the 39 LU-2 files. A series the registry lacks is `unknown`: counted in the batch's `n_skipped`, nothing stored, every layer or file object kept for a replay (R-074). It shows as `n_skipped` above 0 on every payload of that spec. Regenerating needs real structure from the archive, and real payloads stay outside the repository:

1. Run the read-only D2 export script (the one kept from P5c; it reads the manifest and objects with `sudo`, writes only to the owner's home and prints counts, never content) and copy the `.tgz` to the machine you build on. Never into the repository tree.
2. From a directory **outside the repository** (for example `/mnt/c/temp`), with the export unpacked:

   ```bash
   node scripts/gen-be3-stations.ts --extract <export dir>      # rewrites registry/seed/be-3-stations.csv
   node scripts/gen-lu2-stations.ts --extract <export dir>      # fills ts_path and unit of registry/seed/lu-2.csv
   node scripts/gen-be3-stations.ts && node scripts/gen-lu2-stations.ts
   ```

   The seed CSVs are identification only (station number, operator, parameter, unit, name as published, position, SPW reach name; the AGE file with its `ts_path` and unit). The generators fail on anything they do not know: an operator, parameter or unit outside their tables, a station whose rows disagree, a third series of one station and quantity, an AGE file that matches no LU-1 row or two. Each such failure is a reviewed decision in the generator's curated tables, in a PR.
3. Review the diff of `registry/stations/*.yaml`, `registry/twins/*.yaml` and the seed CSVs: new rows only for the series you expected, no value, datum or zero in any row (the strict schema refuses them). Commit those files and nothing from the export; `gitleaks dir` the paths as for every PR.
4. After the deploy (`migrate` syncs the registry), replay the source from the day SPW delivered the new series (§4); `n_skipped` falls to 0 for what the registry now holds. If the new series' history before the layers matters, re-run the catch-up (§3).
5. To make a fixture of a new case, `pnpm fixtures:synth --from <export dir> --spec <spec> --name <case>` writes a synthetic one into the adapter's `fixtures` folder: every value replaced, `synthetic: true`, never a real payload. `fixture-standard.test.ts` fails on anything else in an owner adapter's folder.
6. The owner deletes the export and the `.tgz` on both machines.

## 7. Verify

- `scripts/verify-prod.sh <domain>`: `owner sources` passes (every owner source healthy, none listed) and `owner stations` passes (no owner station in `/api/v1/stations`);
- `own_source_health` of BE-3 and LU-2 has `status` `ok` and a recent `last_new_data`;
- a second replay prints `"n_new":0,"n_changed":0`;
- `own_twin_check` has no failing owner pair you have not understood.

## What not to do

- Do not put a real owner payload, value, station value or log line in the repository, an issue, a PR comment or a prompt. The export directory lives outside the repository and is deleted afterwards.
- Do not hand-edit `registry/stations/be-3.yaml`, `lu-2.yaml`, `registry/twins/*.yaml`, `registry/seed/be-3-stations.csv` or the `ts_path` and `unit` columns of `registry/seed/lu-2.csv`: each has a generator (`gen-be3-stations.ts`, `gen-lu2-stations.ts`) and CI regenerates and diffs it.
- Do not change an audience or a channel flag to make an owner source visible: that is a reviewed change with a `registry/permissions/<ID>.md` record (P13), and the owner view is used by the owner alone.
- Do not run the catch-up by hand with a request tool, and do not point anything but the recorder at SPW or AGE: the recorder keeps the politeness rules, the allowlist and the archive.
- Do not wait for a page: an owner source never pages. Look.
