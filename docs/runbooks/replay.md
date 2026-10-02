# Runbook: replay archived payloads into the database

**Trigger:**
- after a fix, to load payloads that were quarantined (`docs/runbooks/schema-drift.md`);
- after a parse, normalise or registry change that alters what is stored (values dropped by a wrong unit or stored with a wrong factor, a new rule; §3 after a provider's unit change), except over a range that reaches back before a unit or factor change of a series: it rescales that series' older rows (check `docs/known-gaps.md` KG-074 for the recorded changes first);
- after a restore of the raw archive when a payload was skipped as `object_missing` (`docs/runbooks/restore.md`);
- after the release that first brings an adapter (NL-1 in P2b, §5; FR-1, FR-3, CH-1, CH-2 and CH-3 in P5a, §6; DE-7, DE-8, LU-1 and LU-6 in P5b, §8; the owner sources BE-3 and LU-2 in P5c, §9): the loader without it moved its cursor past those lines and stored nothing (for NL-1 again in P5a: its 9 Belgian series were captured since P1 and counted as unknown until the registry knew them);
- to prove that the archive still reproduces the database (a second replay must change nothing), with the same exception: a range that reaches back before a unit or factor change of a series rescales that series' older rows (KG-074 first).

`replay` re-parses archived objects through the loader's own code path. It **never fetches**, never moves the load cursor and never touches the fetch health. The raw archive is the source of truth; the database can be rebuilt from it, as far as the retention pruner has not deleted objects (`docs/runbooks/disk-full.md` §4) and except across a unit or factor change of a series, which the registry does not date (KG-074).

## 1. The rules it keeps

| Rule | Consequence |
|---|---|
| Same code path as `load` (`Loader.payload`): one payload = one transaction, under the loader lock (a row lock on `app_meta` `loader_lock`) that `load`, the nightly reconciliation and the health pass share | It is safe to run while `load` runs; they take turns per payload (a wait over 30 s fails that payload's transaction: `replay: failed (55P03)`; run it again) |
| Newest fetch wins: the stored row of a point is what the newest fetch (`fetched_at`, then batch id) that stated it says; a newer fetch that states the same value takes the row over (a confirmation). Gauge zeros follow the same rule for the same `validFrom` (a newer `validFrom` supersedes in any order) | Replaying an old range never reverts a newer value, in whatever order the payloads are replayed |
| The payload that holds a row (the newest that stated it) rewrites it when it now yields another value or qc | A replay after a fix of the parser, the normaliser or a registry factor corrects what that payload stored (one `obs_revision` per changed row); with an unchanged parser it writes nothing. It never removes a stored point: a fix that drops values (a newly recognised sentinel, say) needs a data migration in a reviewed PR that deletes those rows and recomputes their `obs_latest` rows and hourly and daily buckets (`rws_load` may not delete), not a hand edit |
| It re-parses with **today's** registry: units, factors and datums are not versioned in time | After a provider's unit or factor change, replay only from an instant after the change (§3). A range that reaches back before it rescales that series' older rows (KG-074) |
| A changed value writes exactly one `obs_revision` row; an identical row, or one a newer fetch holds, writes nothing | A no-op replay writes no row, no revision, no new batch id |
| One batch row per archive key (`ingest_batch.archive_key` is unique) | A replay updates the batch, it never adds a second one |
| A quarantined or skipped payload that now loads becomes `ok` | This is how a fixed drift is cleared |
| A payload that loaded before is never downgraded (for instance its object was pruned since) | A missing object of an `ok` batch changes nothing |
| The batch's `n_skipped` (values a registry change could still load) is counted again | After a registry fix, a replay sets it to 0 and the pruner may keep the object no longer |
| **Gap-fill rows (P5a):** the FR-3 and CH-3 payloads also write fill rows into FR-1 and CH-1 series (qc bit 512). A fill row is written only where the target source states no value, a row of the target source replaces a fill row whatever the fetch times, and neither writes an `obs_revision` | The end state is the same in whatever order FR-1, FR-3, CH-1 and CH-3 are replayed (integration-tested); the `n_new` of a first replay depends on that order (a row of the target source that replaces a fill row counts as new), and a second replay of any of them prints `"n_new":0,"n_changed":0`. Removing fill rows is §7 |
| **Load windows (P5b):** `de-7-messwerte`, `de-7-pegeldaten` and `lu-1-csv` re-state days that earlier payloads stated, so each payload loads only the rows from 6 hours before the previous loaded (`ok`) payload of its spec, fetched within 8 days; a seed line loads whole, and rows before the window are dropped as `outside_window`. A replay applies the same rule | A replay writes what the tail did, not more: it does not load a provider revision older than the window, and a no-op replay stays a no-op. A replay of a range with no earlier `ok` batch (the first one after the deploy) loads each payload's rows from the first one on |
| **Label offsets (P5b):** an LU-1 payload is read with the label offsets measured so far (`app_meta` `label_offset:LU-1`, per UTC day), at the time of the replay | A replay after the detector measured another offset moves the values of that day, one `obs_revision` per moved value (`docs/runbooks/label-offset.md` §3) |
| It never touches the tail's attempt record (`app_meta` `load_attempt`) and stops at the first payload that fails for a reason of its own or cannot be read | Exit 1 with the code (`replay: failed (<code>)`); the payloads before it are committed. Fix the cause and run it again, or narrow the range |
| Lines with a fetch error, an HTTP status of 400 or more, no object (304, `dup_of`, a closed gate) or no adapter are skipped | Only archived payloads are replayed |
| The range is in **manifest days**: the UTC day of the file `raw/_manifest/<day>.jsonl` the line is filed under (the day its fetch started; the recorder's recovery appends to past days). `--from` may instead be a UTC **instant** (`2026-10-05T07:10:00Z`): a line whose fetch ended before it (the batch's `fetched_at`) is skipped, not counted and never read | Use a range that includes the day of the payload, `--to` inclusive; an instant after a unit change (§3) |
| Arguments are checked against fixed patterns **and** the adapter table: `--source` must have a load adapter, `--spec` must be one of its specs, `--from` a real UTC day or a real UTC instant to the second with `Z`, `--to` a real UTC day, not before the day of `--from` | No identifier reaches SQL from the command line |

Adapter table today: `DE-1` with the specs `de-1-basin`, `de-1-series` and `de-1-meta`; `NL-1` with `nl-1-obs-key`, `nl-1-obs-other` and `nl-1-obs-twin`; `NL-2` with `nl-2-wfs` (NL-2 stores no observation, so a replay of it never writes a row); from P5a `FR-1` with `fr-1-obs` (every walk page is its own line) and `fr-1-ref` (the daily gauge zeros), `FR-3` with `fr-3-obs` (the seed) and `fr-3-twin`, `CH-1` with `ch-1-lindas`, `CH-2` with `ch-2-pq` and `CH-3` with `ch-3-40d`; from P5b `DE-7` with `de-7-messwerte` and `de-7-pegeldaten`, `DE-8` with `de-8-stations` (it stores nothing: its lines only report drift against the DE-7 registry) and `de-8-hydro` (the gauge zeros of the DE-7 series), `LU-1` with `lu-1-csv` and `LU-6` with `lu-6-geo` (it stores nothing); from P5c, owner audience, `BE-3` with `be-3-values`, `be-3-catchup` and `be-3-meta` (the daily lists store nothing, the stations give gauge zeros) and `LU-2` with `lu-2-json`. NL-4 has no adapter: `--source NL-4` is refused, and so are `LU-3` and `LU-4` (parsed in P5c, loaded from P8a and P7a). The NL-1 forecast and catalogue specs have no loader entry yet (P8), so their lines are not counted.

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

The registry fix is deployed first (`docs/runbooks/schema-drift.md` §4), and the first basin payload after it clears the mismatch list. Record the change in KG-074 (`docs/known-gaps.md`: the series, the old and new unit or factor, the instant below), because every later replay and rebuild must know it. Then replay from a UTC **instant**: every payload replayed is read with today's factor, so the instant is never earlier than the change, and never at or before the fetch time of the **last basin payload that still showed the old unit**.

Find that basin payload and the instant:

1. The first `unit_mismatch` alert with `"spec":"de-1-basin"` is logged when the loader loads the basin payload that first showed the new unit; the basin payload before it is the last that showed the old one. They are normally the two newest basin batches fetched before the alert's `time` (the alert follows the load within seconds unless the loader was catching up); read both objects (`schema-drift.md` §2) to see the series' `unit` change between them:

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
     "SELECT fetched_at, archive_key FROM ingest_batch WHERE spec_id = 'de-1-basin' AND fetched_at <= '<alert time>' ORDER BY fetched_at DESC LIMIT 2"
   ```

2. A series payload fetched between those two basin calls carries no unit (`measurements.json` states none), so only the magnitude of its values says which unit it used. List those that hold rows of the series:

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
     "SELECT b.fetched_at, b.spec_id, count(*), min(o.value), max(o.value) FROM obs o JOIN ingest_batch b ON b.id = o.batch_id
      WHERE o.series_id = (SELECT id FROM series WHERE provider_key = '<uuid>/<W|Q>')
        AND b.fetched_at > '<last old-unit basin fetch>' AND b.fetched_at < '<first new-unit basin fetch>' GROUP BY 1, 2 ORDER BY 1"
   ```

   The instant is the `fetched_at` of the first of them whose values show the new unit, or of the first basin payload that showed it when none does, written `YYYY-MM-DDTHH:MM:SSZ` (the fraction dropped). Check the magnitude of each payload before you include it; one whose values could be either (a small factor, a level near the boundary) is your call. A payload that holds no row of the series changes nothing either way.

Count first, then run it (`--to` is today's UTC day):

```bash
rwsc run --rm --no-deps -T load replay --source DE-1 --from 2026-10-05T07:10:00Z --to 2026-10-06 --dry-run
rwsc run --rm --no-deps -T load replay --source DE-1 --from 2026-10-05T07:10:00Z --to 2026-10-06
```

It stores the values that were dropped as `unit_mismatch` while the list named the series, and rewrites the rows that were stored mis-scaled between the change and its detection (the payload that holds such a row rewrites it). The payloads fetched before the instant are not read: their rows and batches stay as they are.

**A replay that started too early** (from a day, or from an instant before a payload that still used the old unit) rescaled the rows those older payloads hold. Nothing is lost: the right values are the `old_value` of that replay's revisions.

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
  "SELECT r.ts, r.old_value, r.new_value, b.fetched_at FROM obs_revision r JOIN ingest_batch b ON b.id = r.batch_id
   WHERE r.series_id = (SELECT id FROM series WHERE provider_key = '<uuid>/<W|Q>')
     AND r.changed_at >= '<when that replay started>' AND b.fetched_at < '<the right instant>' ORDER BY r.ts"
```

A replay cannot put them back (it reads those payloads with today's factor again): that takes a data migration in a reviewed PR, as for a fix that drops values (§1). An old-unit basin payload it read raised `unit_mismatch` again and keeps `n_skipped` > 0, so the pruner keeps its object.

## 4. Verify

```bash
curl -s https://<domain>/api/v1/health/sources | jq '.sources[] | select(.id == "DE-1") | {status, quarantined, partitions_at}, .quarantined_batches'
```

- `quarantined` falls by the number of payloads that loaded (the count is recomputed every minute, the answer cached for 30 s);
- for a **no-op proof**, run the same replay twice: the second run must print `"n_new":0,"n_changed":0`;
- the per-partition checksums in `sources[].partitions` (md5 over series key, timestamp, value and qc) are recomputed nightly (after 02:00 UTC) and once when the loader first catches up with the manifest. After a replay that changed data, compare them after the next nightly run, or restart `load` (`sudo docker restart rws-load-1`): it recomputes them as soon as it has caught up with the manifest (`docs/runbooks/partition-maintenance.md` §4).

## 5. After the P2b deploy: load the NL payloads since P1

The loader of the P2a release had no NL-1 adapter, so it moved its cursor past every NL-1 line since P1 and stored nothing (fetch health only). After the release with P2b is deployed and `migrate` has synced the NL registry (`docs/runbooks/bootstrap.md`, the P2b release steps), load them once. The recorded lines are all still in the archive (the pruner is a dry run). NL-2 needs no replay (it stores nothing) and NL-4 is never replayed.

1. Find the first day of the archive: `sudo ls /srv/rws/raw/_manifest | head -n 1` (the file name is `<day>.jsonl`). Use that day as `<first day>` and today's UTC day as `<today>`.
2. Count first, with the `rwsc` function of §2. It reads the manifest and writes nothing:

   ```bash
   rwsc run --rm --no-deps -T load replay --source NL-1 --from <first day> --to <today> --dry-run
   ```

   `lines` counts the NL-1 lines of the three observation specs that have an object. A line without an object (the 204 "no data" answers), with a fetch error or with a status of 400 or more is not counted.
3. Run it, without `--spec`, so that all three specs load:

   ```bash
   rwsc run --rm --no-deps -T load replay --source NL-1 --from <first day> --to <today>
   ```

   It is one transaction per payload and can be stopped and started again (§2). NL-1 states its unit in every payload, so a range that starts on a day is safe across a unit change: a difference from the registry is dropped as `unit_mismatch`, never rescaled (§3 and KG-074 do not apply to NL-1).
4. Expect `"n_new"` greater than 0 the first time and `"quarantined":0`. Run the same command a second time: it must print `"n_new":0,"n_changed":0`.
5. Check `scripts/verify-prod.sh <domain>`: the checks `health NL-1`, `tier-1 NL-1` and `replay NL-1` pass once the loader has caught up (`.loader.backlog_age_s` small). A payload that quarantines is handled by `docs/runbooks/schema-drift.md`; the codes `unregistered_method`, `unknown_quality`, `conflict`, `registered_dropped` and `unit_mismatch` are alerts, and the values they withheld load in a replay after the fix (`n_skipped` of those batches is above 0 until then). These alerts fire **during the replay too**: one line per payload and code, so a replay over months of payloads that each withhold a value logs one alert per payload. Count them before you act on them, and do not read them as new drift. A batch's `n_skipped` adds two things: the values withheld under those codes and, for each list of a series the registry does not know (an info line, `series not in the registry`), one.

## 6. After the P5a deploy: load the FR and CH payloads since P1

The loader of the releases before P5a had no adapter for FR-1, FR-3, CH-1, CH-2 and CH-3, so it moved its cursor past every one of their lines since P1 and stored nothing (fetch health only). It also did not know the nine Belgian series that `nl-1-obs-other` has captured since P1 (the points on Belgian soil: `antwerpen`, `lixhebiefaval`, `maaseik`, `herenlaak`, `lanaken`, `kanne`, `smeermaas.zuidwillemsvaart`): their values were counted as unknown. After the release with P5a is deployed and `migrate` has synced the registry (it now holds `fr-1.yaml`, `fr-3.yaml`, `ch-1.yaml` and `ch-2.yaml`, and the Belgian NL-1 rows), load them once. The lines are all still in the archive (the pruner is a dry run, and the objects of CH-1 and CH-2 are kept whole until P7). The first production manifest day is 2026-09-30.

1. Find the first day of the archive and use today's UTC day as `<today>`, as in §5 step 1.
2. Count first, for each of `FR-1`, `FR-3`, `CH-1`, `CH-2`, `CH-3` and `NL-1`, with the `rwsc` function of §2 (`--dry-run` writes nothing):

   ```bash
   for s in FR-1 FR-3 CH-1 CH-2 CH-3 NL-1; do
     rwsc run --rm --no-deps -T load replay --source $s --from <first day> --to <today> --dry-run
   done
   ```

   An FR-1 `lines` counts every page of every walk, the seed walks included.
3. Run each of them, without `--spec` (every spec of the source loads):

   ```bash
   for s in FR-1 FR-3 CH-1 CH-2 CH-3 NL-1; do
     rwsc run --rm --no-deps -T load replay --source $s --from <first day> --to <today>
   done
   ```

   **The order does not matter.** FR-3 and CH-3 write gap-fill rows (qc bit 512) into FR-1 and CH-1 series, only where FR-1 and CH-1 state no value, and a row of FR-1 or CH-1 replaces a fill row whatever the fetch times: replaying FR-3 first or last gives the same `obs`, `obs_latest`, rollups and revisions (§1). A payload that still quarantines is counted in `quarantined` (§2); `docs/runbooks/schema-drift.md` §2 lists the codes of the five adapters.
4. Expect `"n_new"` above 0 the first time and `"quarantined":0`. Run each command a second time: it must print `"n_new":0,"n_changed":0`, whatever order the first runs had.
5. Check `scripts/verify-prod.sh <domain>`: `health FR-1`, `health CH-1`, `tier-1 FR-1`, `tier-1 CH-1`, `coverage FR-1` and `coverage CH-1` (at least 95 % of the expected buckets since the seed), `interval CH-1` (it may FAIL for up to 24 h after the deploy's recorder restart, `docs/runbooks/owner-checks.md` §5), `fresh FR-1`, `fresh CH-1` and `belgian set` pass once the loader has caught up (`.loader.backlog_age_s` small) and the first scheduled payloads after the deploy have loaded. The alerts of the retained drop codes (`unknown_quality`, `datum_mismatch`, `conflict`, …) fire **during a replay too**, one line per payload and code: count them before you act on them (§5 step 5). A batch's `n_skipped` above 0 means values a registry change could still load: for FR-1 a series that the registry does not hold yet (one that only delivers on days the registry's one-day derivation did not see; `docs/known-gaps.md` KG-123), for CH-3 a fill row whose CH-1 series does not exist.

## 7. Removing gap-fill rows (a licence withdrawn)

A replay never removes a stored point (§1), and `rws_load` may not delete. Gap-fill rows sit in FR-1 and CH-1 series under those sources' licence. If the use of FR-3 or CH-3 is withdrawn, the rows must go through a **reviewed data migration**, never by hand, and the loader must stop writing them in the same change:

1. In the PR, remove `fill` from the FR-3 and CH-3 entries of `apps/server/src/load/adapters.ts` (and, if the fetching stops too, the capture specs `fr-3-obs`, `fr-3-twin` and `ch-3-40d`), so that neither the loader nor a replay writes fill rows again. A fill row is recognised by the backfilled bit (512 in `obs.qc`) and by its batch: the batch of a fill row belongs to the withdrawn source (`ingest_batch.source_id`). A row that FR-1 or CH-1 stated itself has no bit 512 and is never touched.
2. Count what the migration will delete (read-only, on the VPS):

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -c \
     "SELECT b.source_id, count(*) FROM obs o JOIN ingest_batch b ON b.id = o.batch_id
      WHERE (o.qc & 512) <> 0 GROUP BY 1"
   ```

3. The migration deletes those `obs` rows (qc bit 512 and a batch of the withdrawn source) and recomputes the `obs_latest` rows and the hourly and daily buckets of the series it touched, as for a fix that drops values (§1). Fill rows never wrote an `obs_revision`, so there is none to remove. A new migration needs its sha256 in `test/migrations.test.ts`. The rows of the source's own twin series (the FR-3 twins, CH-2) are other series: they stay unless the withdrawal covers them too.

## 8. After the P5b deploy: load the NRW and Luxembourg payloads since P1

The loader of the releases before P5b had no adapter for DE-7, DE-8, LU-1 and LU-6, so it moved its cursor past every one of their lines since P1 and stored nothing (fetch health only). After the release with P5b is deployed and `migrate` has synced the registry (it now holds `de-7.yaml` with 251 rows and `lu-1.yaml` with 42, and the seven twin pairs), load them once. The lines are all still in the archive (the pruner is a dry run). The first production manifest day is 2026-09-30; the `pegeldaten.zip` seed (two months, about 10 MB) is on that day, and the first weekly `pegeldaten.zip` is Monday 2026-10-05.

1. Find the first day of the archive and use today's UTC day as `<today>`, as in §5 step 1.
2. Count first, for each of `DE-7`, `DE-8`, `LU-1` and `LU-6`, with the `rwsc` function of §2 (`--dry-run` writes nothing):

   ```bash
   for s in DE-7 DE-8 LU-1 LU-6; do
     rwsc run --rm --no-deps -T load replay --source $s --from <first day> --to <today> --dry-run
   done
   ```

   A DE-7 `lines` counts every hourly `messwerte.zip` (about 24 a day) and the seed; DE-8 the daily station master and the weekly hydro file; LU-1 every 15-minute CSV (about 96 a day).
3. Run each of them, without `--spec` (every spec of the source loads):

   ```bash
   for s in DE-7 DE-8 LU-1 LU-6; do
     rwsc run --rm --no-deps -T load replay --source $s --from <first day> --to <today>
   done
   ```

   The order does not matter for the values. **Expect one slow payload:** the `pegeldaten` seed holds more than a million rows of registered series within the 45-day age window (older rows are dropped as `too_old`), and it loads whole, in chunks of whole series of at most 50,000 rows, in one transaction under the loader lock. While it runs, the tail's health pass and the nightly jobs wait for the lock (a 30 s lock timeout each), so a long transaction can leave the loader's health older than 5 minutes (the watchdog's `load_stale`, `docs/runbooks/schema-drift.md` §6) until it commits; this passes by itself. Every later payload of DE-7 and LU-1 loads only the rows of its window (6 hours before the previous loaded payload), so the rest of the replay is fast and most of its rows are `outside_window` drops (counted, not alerts). A DE-8 hydro payload puts the gauge zeros onto the DE-7 series (a zero already stored with no validity date is never overwritten by another payload: the alert `gauge_zero_withheld` means the file changed, `docs/runbooks/schema-drift.md` §4). LU-1 is read with the label offsets measured so far; none has been measured yet, so every payload uses the default, 0, which is right for the 7-day file AGE has served since 2026-09-30. If the first nights measure another offset, `docs/runbooks/label-offset.md` §3.
4. Expect `"n_new"` above 0 the first time and `"quarantined":0`. Run each command a second time: it must print `"n_new":0,"n_changed":0`. A DE-8 or LU-6 replay prints `"n_new":0` the first time as well, because they store no observation.
5. Check `scripts/verify-prod.sh <domain>`: `health DE-7`, `health LU-1`, `tier-1 DE-7`, `tier-1 LU-1`, `coverage DE-7`, `coverage LU-1` (at least 95 % of the expected buckets since the seed), `interval DE-7` (3600 s while the spec is hourly, `docs/runbooks/owner-checks.md` §12), `bytes DE-7`, `fresh DE-7` and `fresh LU-1` pass once the loader has caught up (`.loader.backlog_age_s` small) and the first scheduled payloads after the deploy have loaded; `label offset LU-1` passes only after the first nightly job (after 02:00 UTC) has measured a day, which a replay does not do. A batch's `n_skipped` above 0 means values a registry change could still load: for DE-7 a station number the registry does not hold (`unknown`, once per series), for DE-8 a station that is not a DE-7 series. The ZIP and line codes of a quarantined payload are in `docs/runbooks/schema-drift.md` §2.

## 9. After the P5c deploy: load the owner payloads since P1

The loader of the releases before P5c had no adapter for the owner sources BE-3 and LU-2, so it moved its cursor past every one of their lines since P1 and stored nothing (fetch health only). After the release with P5c is deployed and `migrate` has synced the registry (it now holds `be-3.yaml` with 607 series, `lu-2.yaml` with 39 and the generated owner twins of `registry/twins/`: 1,688 stations, 2,630 series and 84 twins), load them once. The lines are all still in the archive (the pruner is a dry run). The first production manifest day for both is 2026-09-29. LU-3 and LU-4 have no loader entry (P8a and P7a): `--source LU-3` and `--source LU-4` are refused, and there is nothing to replay for them. This is owner data (invariant 11): run it on the VPS as the owner, read only the counts the command prints and paste nothing of a payload anywhere (`docs/runbooks/owner-drift.md`).

1. Find the first day of the archive and use today's UTC day as `<today>`, as in §5 step 1.
2. Count first, for each of `BE-3` and `LU-2`, with the `rwsc` function of §2 (`--dry-run` writes nothing):

   ```bash
   for s in BE-3 LU-2; do
     rwsc run --rm --no-deps -T load replay --source $s --from <first day> --to <today> --dry-run
   done
   ```

   A BE-3 `lines` counts the two layer requests every 10 minutes (about 288 a day), the three daily metadata lines (the stations and the two series lists) and, once the catch-up has run, its list roots and values calls; an LU-2 `lines` the 39 files every hour (about 936 a day).
3. Run each of them, without `--spec` (every spec of the source loads):

   ```bash
   for s in BE-3 LU-2; do
     rwsc run --rm --no-deps -T load replay --source $s --from <first day> --to <today>
   done
   ```

   **The order does not matter**, between the two sources and against the catch-up: the newest fetch wins for every point, whatever the order (§1). BE-3 stores the layers' latest values (one per series every 10 minutes) and the gauge zeros of `be-3-meta` (`9999.0` is unknown and stores nothing); LU-2 has no load window (`ARCHITECTURE.md` A§7.2: one run is 39 files), so each payload loads its whole 7 days and the first replay is slower than the tail, one transaction per payload under the loader lock. A payload that still quarantines is counted in `quarantined` (§2); the owner codes are in `docs/runbooks/owner-drift.md` §2.
4. Expect `"n_new"` above 0 the first time (a `be-3-meta` line adds no observation, so its own count is 0) and `"quarantined":0`. Run each command a second time: it must print `"n_new":0,"n_changed":0`.
5. Check `scripts/verify-prod.sh <domain>`: `owner sources` passes once the loader has caught up (`.loader.backlog_age_s` small) and the first scheduled payloads after the deploy have loaded (it fails on the CI fixture database by design), and `owner stations` passes. The alerts of the retained drop codes (`unit_mismatch`, `unknown_quality`, `conflict`) fire **during a replay too**, one line per payload and code: count them before you act on them (§5 step 5). A batch's `n_skipped` above 0 means values a registry change could still load: for BE-3 or LU-2 a series the registry does not hold (`unknown`), which `owner-drift.md` §6 regenerates; none is expected on the lists of 2026-10-02. The owner twin pairs appear in `own_twin_check` (`owner-drift.md` §5) from the first full hour after both sides have data.

**The catch-up arrives by itself.** BE-3's values before 2026-09-29 come from the new spec `be-3-catchup`, a seed that the recorder runs once after the deploy, in UTC hours 0 to 5, about 25 to 35 minutes of requests 5 s apart. Its payloads load through the tail like any line, so no replay is needed for them unless one quarantines (`owner-drift.md` §3). Do not start it by hand.

## What not to do

- Do not replay to "fix" a value the provider itself corrected: a newer payload already wins, and the older revision is in `obs_revision`.
- Do not replay from before a unit or factor change once the registry has the new one (a whole day of the change included): those payloads would be read with the new factor (§3, KG-074).
- Do not replay a range you have not counted with `--dry-run` first when it is large: every payload in it is read and decompressed.
- Do not run it against the raw archive while a restore is still copying files in: the loader would set an object that has not arrived yet to `skipped` (`object_missing`). Stop `load` first (`docs/runbooks/restore.md`).
- Do not move or edit `load_cursor`. Replay never needs to; `load` moves it by itself.
- Do not expect it to bring back what the pruner deleted: an object that is gone is `object_missing`.
- Do not delete gap-fill rows (qc bit 512) by hand, and do not expect a replay to remove them: §7.
