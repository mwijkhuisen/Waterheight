# Runbook: a reference, class, warning or gauge zero changed

**Trigger:** one of the loader alerts `reference_changed`, `reference_removed`, `reference_corrected`, `class_changed`, `warning_changed`, `gauge_zero_changed`, `unmapped_class`, `geometry_too_big`, `texts_too_big` or `cap_closes_full` (log lines, `docker logs --since 24h rws-load-1 2>&1 | grep '"alert"'`; they do not page). Or a decision that changes what the loader stores: a signed D18 crosswalk, a new NL-4 workbook, an owner threshold change, a BAFU objection (C13).

P7a (`PHASES.md` §23, A§6 "P7a reality") stores thresholds, provider classes and warnings with validity ranges and classifies nothing: P7b reads the rows. Every alert carries `source`, `spec` and a count `n` only. **It never carries a value, a threshold or provider text** (invariant 11), so the alert alone does not say what changed: the rows do.

Nothing here is edited by hand in the database. A wrong row is corrected by a fix in a PR and a replay (`replay.md`), never by SQL.

## 1. Read the alert

| Alert | What happened | Normal when | Look at |
|---|---|---|---|
| `reference_changed` | A payload stated a different value (or unit, period, basis) for a stored key; the old range was closed at the later of the provider's `valid_from` and the fetch time, and a new one opened | WSV or LANUK published new characteristic values; BAFU moved a `wl_*` bound; AGE changed an LU-4 level; a new BE-3 period of record | §2 |
| `reference_removed` | A payload that states a series in full (`refScope`: DE-1 metadata, CH-2, FR-5 `CruesHistoriques`, DE-7 `pegel_stationen.txt`, LU-4) no longer states a stored kind; its range was closed at the fetch time | The provider dropped a value (LU-4 set a level to 0 = undefined; WSV removed a Marke) | §2; a provider fault if many series at once |
| `reference_corrected` | A replay of the payload that holds a row, after a parser or normaliser fix, changed the row in place (its opener stays `batch_id`), or re-opened a key that the same payload had closed | You just replayed after a fix (§6) | §2 |
| `class_changed` | A station's class code, label or level differs from its latest stored one (CH-1 `dangerLevel`, DE-6 `lhpClass`, BE-3 `NIVCRU`), or a newer payload states another class for the same instant (it replaces the stored one in place; an older payload changes nothing) | A flood, or the day after one; a state that re-classifies a gauge without a new reading | §3 |
| `warning_changed` | A new, changed or ended warning area (DE-6 alert, FR-5 section, CH-5 section, LU-5 message). A changed name, geometry or text at the same level is no change: it is refreshed in place | A warning was issued, raised or ended | §3 |
| `gauge_zero_changed` | A newer payload states another zero for a validity that already has one (dated or not); the stored zero ends at the fetch time and a new one opens (R-072 closed), at most one a day: while the open range began that UTC day, a newer value corrects it in place (alerted all the same) | A gauge was re-levelled, or a typo was corrected; several a day is a flap (§4) | §4 |
| `geometry_too_big`, `texts_too_big` | Retained: `n` warning rows were stored without their geometry (over 2 MiB) or their texts (over 60,000 bytes of JSON); the level is stored. The object is kept (`n_skipped`) | Never so far: the largest real CAP file is 38 KB | §3 |
| `bad_text`, `reference_out_of_range` | Retained: `n` rows carried a text PostgreSQL cannot store (U+0000, a lone surrogate), or a reference value beyond ±1e9, and were withheld; nothing else of the payload is affected. Report the provider bug; replay once the data is clean (`replay.md` §10) |
| `cap_closes_full` | The LU-5 map of held closings (`app_meta` `cap_closes:LU-5`, 2,000 identifiers within 60 days of the message being loaded) could not take this payload's closings; they were applied to the rows already stored but not held for a target that arrives later | A replay of a very long stretch, or a hostile feed | §3 |
| `unmapped_class` | `n` provider classes or levels are not in `packages/core/src/crosswalk.ts` (DE-6 station or alert, CH-1, CH-5, FR-5, LU-5, BE-3). They are counted in `n_skipped`, kept in the archive (the pruner keeps the object) and not stored | The provider added a class | §5 |

`reference_changed` on a `source_id` of an owner source (LU-4, BE-3) is read on the owner view only (§8).

## 2. A reference changed

On the VPS, read the history of one station's key (public sources; for LU-4 and BE-3 use §8). The closed range keeps the old value and the open one the new:

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "
SELECT r.kind, r.value, r.unit, r.semantics, lower(r.valid), upper(r.valid), r.seen_at
FROM reference_value r JOIN series s ON s.id = r.series_id
WHERE s.source_id = 'DE-1' AND s.provider_key = '<provider key>' AND r.source_id = 'DE-1' AND r.kind = '<KIND>'
ORDER BY lower(r.valid)"
```

Then decide:

| Finding | Do |
|---|---|
| A real publication (the provider's page or the new payload says so) | Nothing. The old range is history, the new one is current |
| Many series change at once, or a value with a wrong factor (cm against m, l/s against m³/s) | A parser or normaliser bug. Read one archived payload (`schema-drift.md` §2), fix in a PR with a fixture and a golden, bump the adapter `version` in `load/adapters.ts`, deploy, then replay the spec (§6). The replay corrects the rows that the replayed payloads hold in place (`reference_corrected`) |
| A kind removed by one source on many series | Check the payload (a truncated list?). A truncated payload would have been a quarantine (`schema-drift.md`); if it parsed, ask the provider |
| BE-3 withdrew a kind (a percentile) | BE-3 has no `refScope` (KG-180), so nothing is closed and the old range stays open. Judge it in the owner view (§8) |

A parser-fix replay by a payload that is not the key's newest statement opens a new range instead of editing (KG-183). A range is never deleted.

## 3. A class or warning changed

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "
SELECT subject_id, ts, provider_code, provider_label, level_norm FROM class_obs
WHERE source_id = 'CH-1' ORDER BY ts DESC LIMIT 20"
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "
SELECT area_key, level_raw, level_norm, lower(valid), upper(valid) FROM warning_area
WHERE source_id = 'DE-6' ORDER BY lower(valid) DESC LIMIT 20"
```

A new class during a flood is the system working. Two things are not normal: a class that flaps every payload (a parser reading a changing field: compare two archived payloads), and a source with no change for weeks in a flood (the spec stopped: `scripts/verify-prod.sh <domain> --interval` checks `interval DE-6`, which needs about 30 minutes). A station whose every series is `off` takes no class (the off-station rule); a class for an unknown station id is counted in `n_skipped`.

For LU-5 a Cancel closes the rows of the messages it references at its `sent` time; a Cancel that arrives before its target waits in `app_meta` `cap_closes:LU-5` (2,000 identifiers at most, an identifier over 200 characters skipped, a closing sent more than 60 days before or after the message being loaded forgotten, KG-184). After `cap_closes_full`, replay `lu-5-cap` in shorter stretches (`replay.md`): the map holds what one stretch needs.

A snapshot payload (DE-6 alerts, FR-5, CH-5) closes an area it no longer lists. An area it lists but whose row was withheld (`conflict`, `unmapped_class`) stays as stored. A changed CH-5 level at an unchanged `valid_from` (the bulletin's) ends the old level at the payload's `produced_at` and opens the new one there, so both stay in the history. An FR-5 map that lists fewer than 75 % of our sections, or a CH-5 map of fewer than 80, is `too_few_areas` drift (`schema-drift.md`): a cut answer closes nothing.

At one instant the newest payload wins: a DE-6 or CH-1 class that a newer payload states for the same `ts` replaces the stored one in place (`class_changed`), and that payload holds the row (`batch_id`). DE-6 stamps a class with the feature's `timestamp` (the reading the state classified), not with the collection's `updated`.

`geometry_too_big` and `texts_too_big` keep the warning's level and leave the field out; LU-5 rows over 48 KiB of texts lose their descriptions, then their instructions, already in the adapter (`texts_trimmed`, counted only). Read the archived payload (`schema-drift.md` §2); a real flood alert that large is news for the issue tracker, never a reason to edit the row.

## 4. A gauge zero changed

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "
SELECT s.provider_key, g.value_m, g.datum, lower(g.valid), upper(g.valid)
FROM gauge_zero g JOIN series s ON s.id = g.series_id
WHERE s.source_id = 'DE-7' AND s.provider_key = '<provider key>' ORDER BY lower(g.valid)"
```

A re-levelled gauge is a real change. The history keeps both zeros; the station detail (P10) derives a height above a datum only from the zero in force. A zero that changes back and forth, or by about a metre or a factor, is a typo or a wrong unit: read the payload. A flapping zero adds at most one range a day (the day's range is corrected in place by the later statements), so the table stays small while you look. `gauge_zero_withheld` and `gauge_zero_older_ignored` do not exist any more.

## 5. `unmapped_class`: a provider class the crosswalk lacks

1. Read the archived payload (`schema-drift.md` §2) to find the code (DE-6 station `lhpClass`, DE-6 alert `lhpClass`, CH-1 `dl`, CH-5 `level`, FR-5 `NivInfViCr`, LU-5 `cb-eu-level`, BE-3 `NIVCRU`). The raw code is never stored while it is unmapped.
2. In a PR: add a row to `CROSSWALK` in `packages/core/src/crosswalk.ts` (source, scale, code, level, basis, flag) and a label (NL and EN) to `registry/labels/<SOURCE-ID>.yaml`, keyed by **our code** and never by provider prose. A display class is never called a warning unless the provider issues it as one. Add a fixture and a golden; `test/labels.test.ts` fails on a code without both texts. Do not read a number into a code the provider has not defined (DE-6 alert "3" does not exist).
3. Deploy, then replay the spec from the first day of the alert (§6): the withheld rows load.

## 6. Changing the crosswalk (D18) or a label, and the replays

D18 was signed on 2026-10-03, as P7a built it (PHASES §6.1): `level_norm` is the signed table. When the owner changes a row:

1. Edit `packages/core/src/crosswalk.ts` (the one table, P7b) and the labels; run `node scripts/gen-classification.ts` (it rewrites `docs/classification.md`; CI fails on a difference); review the golden-state diff (`UPDATE_GOLDEN=1 vitest run apps/server/test/classification`, then read every changed station in `golden-states.golden.json`) and say it in the PR; update the other goldens (`UPDATE_GOLDEN=1`, review each) and bump the adapter `version` of the changed sources in `apps/server/src/load/adapters.ts`.
2. Deploy. `migrate` changes nothing.
3. Replay the class and warning specs from the first day of the archive (use `rwsc` from `replay.md` §2; count first with `--dry-run`). References are stored without a level, so only these change:

   ```bash
   for a in "DE-6 de-6-stations" "DE-6 de-6-alerts" "FR-5 fr-5-vigilance" "CH-5 ch-5-warn" "LU-5 lu-5-cap" "CH-1 ch-1-lindas"; do
     set -- $a
     rwsc run --rm --no-deps -T load replay --source $1 --spec $2 --from <first day> --to <today>
   done
   ```

   `BE-3` (`NIVCRU` has no level) and `LU-4` need no replay for a level change. For a change of a **label** only the label file changes and no replay is needed.
4. Run each command a second time: `"n_new":0,"n_changed":0` and no new batch. A replay corrects the rows that the replayed payloads hold; a row that a newer payload has superseded keeps the level it was stored with (KG-183). Check:

   ```bash
   sudo docker exec -i rws-db-1 psql -X -U postgres -d rws -Atc "SELECT source_id, level_norm, count(*) FROM warning_area GROUP BY 1, 2 ORDER BY 1, 2"
   ```

   List any stale rows in the PR and do not edit them by hand.

**A user reports a wrong colour or state (P7b).** Ask the snapshot for the station at the instant they saw, `GET /api/v1/snapshot?t=<instant>` (the `t` as `…Z`), and read its value: `state` is the level, `basis` says which candidate decided (`source`, `kind` operational, statistical, provider_class or area, `ref`, `label`, for example "WSV MNW 2010–2020" or "LHP RP:0"), `section: true` means the state is the area's because the gauge had none, and `area` is an area class returned beside a gauge state. A `null` basis is `no_ref`: no candidate decided (a reference of another unit, a tidal or impounded series that skips a source, a class the crosswalk calls `no_ref`, a stale class past its freshness window, or a threshold set that cannot place the value). Then compare `basis.ref` with the row in `docs/classification.md`, and the stored reference or class with the `pub_*` views as `rws_api`; a wrong level in the table is §6, a wrong stored row is §2 or §3, and a stale class is the source's `last_fetch_ok` in `/api/v1/health/sources`. The owner's own states are not served before P9.

**Retention.** A CH-1 or CH-2 payload that opened a class row or a reference range is promoted to forever, but of one spec and UTC day only the first 24 such payloads (`PROMOTE_PER_DAY` in `load/prune.ts`) beside the daily copy: a flapping class or threshold cannot keep every payload (T-REF-7). The pruner is a dry run until the owner enables it.

Replays of the **reference** specs after a parser fix: `--source DE-1 --spec de-1-meta`, `--source DE-7 --spec de-7-pegeldaten` (slow: it holds the two-million-row seed), `--source CH-2 --spec ch-2-pq`, `--source FR-5 --spec fr-5-stations`, `--source LU-4 --spec lu-4-pages`, `--source BE-3 --spec be-3-refs`, each from the day of the first wrong payload. A no-op replay changes nothing.

## 7. A new NL-4 workbook

The NL-4 rows are written by `migrate`, not by the loader: `node scripts/convert-nl4.ts` (a reviewed change of the pin: sha256, edition, member list) rewrites `registry/thresholds/nl-4.csv`, `registry/thresholds/nl-4-map.yaml` maps NL-4 codes to NL-1 locations (identity plus reviewed `none` rows with a reason), and `test/registry-nl4-map.test.ts` and `test/labels.test.ts` fail on a stem or a station without a label or a map row. Merge, deploy; `migrate` deletes and inserts the rows again, so the new bounds take over as the new range of the registry sync. Nothing is replayed (`nl-4-xlsx` has no loader entry). A new stem needs a crosswalk row and NL and EN labels that do not say "waarschuwing" or "warning" (the Waterinfo classes are display classes).

## 8. LU-4 and BE-3 (owner references)

These are rows of `source_id` LU-4 and BE-3: the owner views show them, the public views never do. Read them on `owner.<domain>` over WireGuard, or with `rws_owner_api`; **never paste a value, a threshold, a percentile or a `NIVCRU` text into an issue, a PR, a chat, a log or a commit message**. The alerts name only the source, the spec and `n`.

- LU-4: AGE changed a level or a flood return period, or set a level to 0 (no row, `reference_removed`). A change is a new range; nothing else to do. `bad_variant` (a page path that `registry/seed/lu-4.csv` does not map) is a registry change (`owner-drift.md`).
- BE-3: `be-3-refs` runs weekly (Tuesday 05:20 UTC). A new period of record changes every percentile (`reference_changed` with a large `n`) and is normal after SPW recomputes. A kind SPW withdraws is never closed (KG-180).
- Neither source stores a gauge zero from these payloads (KG-181).

## 9. A BAFU objection (C13)

C13 is unanswered; silence by 2026-10-31 keeps CH-2 and CH-5 public. If BAFU objects to public use, the owner decides in a follow-up PR: CH-2 and CH-5 move to `audience: owner` (a `registry/permissions/<ID>.md` record, CODEOWNERS applies), CH-6 (the open geo.admin.ch class layers; `data.geo.admin.ch` is a catalogue §6.7 host) gets a capture spec, an adapter and an allowlist entry, and a replay loads what CH-6 states. Only a request to stop fetching ends the capture. Until then nothing changes (KG-173).
