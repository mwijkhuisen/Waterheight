# Runbook: day-of-year climatology (P14f)

**Trigger:**
- a backfill has completed and the owner wants the stations whose history now reaches 10 complete years to get their own seasonal statistics (the NL-1 backfill, then each later P14 source);
- the yearly refresh in January, when another complete year exists;
- a value of `registry/climatology.yaml` has changed (`min_years`, `window_days`, `min_day_hours`, `min_year_share`);
- the DOY rows must be taken back (§6).

The `climatology` role is a one-shot job. For every eligible series it reads the stored history through the audience's views, computes the P10 and P90 of the daily means for each of the 365 days of the year and writes them as the reference kinds `P10_DOY` and `P90_DOY`. The classifier uses them as a statistical basis, after the provider's own statistics (`docs/classification.md`, "Day-of-year climatology"; catalogue §4.9; `PHASES.md` §56). Nothing runs it by itself.

## 1. What it does, and its rules

| Rule | Consequence |
|---|---|
| Eligible: a primary series of quantity level or discharge (a stage relative to a gauge zero is not: KG-401), at a station that is neither tidal nor impounded, whose source has `history_export` on, with at least **10 complete UTC years** (`min_years`). A complete day has a sample in at least 20 of its 24 hours; a complete year has at least 90 % complete days | A series with fewer years gets no rows and keeps its other bases or `no_ref`. A series that was eligible and no longer is has its open DOY rows closed |
| It reads **only through the family's views**, one series at a time, in a `READ ONLY` transaction (hour buckets in UTC, the mean of the hours' means per UTC day); rows with a suspect `qc` bit (4, 16, 32, 64) are left out. It never reads a base table | `--family public` (the default family run) reads the public views; `--family owner` computes the owner-audience series that are not public. A public series is computed once, from its public view |
| It writes only `reference_value` (kinds `P10_DOY`, `P90_DOY`) and the dirty log, one transaction per series, under the loader lock, as `rws_migrator` | No new role, secret or grant. It never runs while a deploy or `migrate` does |
| Each row: `source_id` = the series' own source, `semantics statistical`, `non_exceedance`, `period` the first to the last complete year, `season_from_md` = `season_to_md` = the day key, `priority` 0, `batch_id` NULL, valid **from the start of the run** to open | Past states never change: a day before the run keeps the state it had (KG-398). The immutable settled files stay true |
| 365 day keys (`MMDD`, UTC); there is no 29 February row, and on 29 February the classifier uses 0228. A 29 February inside a window counts as data | A key whose P10 is not below its P90 has no rows |
| Re-run: an open row with the same value (compared as `real`), period and basis label is **not written**; a different value closes the open row at the run start and inserts the new one; a series no longer eligible has its open rows closed. A re-run that changes nothing writes nothing and marks nothing dirty | The same input gives the same rows. The run is safe to repeat |
| The loader never closes a DOY row: `applyReferences` leaves `P10_DOY` and `P90_DOY` out of the rows it compares (`load/refs.ts`), so a provider payload with a `refScope` (DE-1, DE-7, CH-2, LU-4) cannot remove them | |
| Output is **counts only** on stderr, never a value, an id of an owner series or provider text | Safe to paste |

## 2. Dry-run

The dry-run reads (so it needs the database) but writes nothing. Use the `rwsc` helper of `docs/runbooks/backfill.md` §2.

```bash
rwsc() { sudo bash -c 'cd / && . /usr/local/lib/rws/deploy/bin/rws-lib.sh && rws_compose "$@"' rwsc "$@"; }
rwsc run --rm --no-deps -T migrate climatology --dry-run
```

It prints one line per family, the counts it would write: `climatology: family public (dry run): series N, eligible E, with a set S, complete years <min>-<max>, rows new A, changed B, unchanged C, closed D` ("complete years" is the smallest and largest number of complete years behind a set; `none` when no series has one). Check that "eligible" is plausible against the backfill (the NL-1 series with at least 10 complete years: a series that started in 1990 has more than 30) and that "unchanged" is large on a re-run.

Options: `--family public|owner` (each at most once), `--series <id>,…` to restrict to named series (numeric series ids, at most 1,000; each flag at most once). Exit codes: 0 done, 1 a read or write failed, 64 bad arguments (the usage line says which), 78 no database settings or an unusable registry.

## 3. Run it

Run it when no deploy is running and not while the loader is catching up. It can run in the daytime: it takes the loader lock for one series at a time.

```bash
rwsc run --rm --no-deps -T migrate climatology
rwsc run --rm --no-deps -T migrate climatology --family owner   # the owner-audience series, if any are eligible
```

A run that stops half way is safe to start again: finished series are unchanged.

## 4. Verify

1. The counts of the run: "eligible" times 730 (2 kinds times 365 keys) is the most rows that exist; a key with P10 not below P90 has fewer.
2. The public status: `/data/v1/status.json` `classification` shows, per country, how many stations have a DOY set (`climatology`) and how many currently take their state from it (`by_climatology`). The counts rise after the dirty log has been re-rendered (a few minutes).
3. A spot check of a public `/snapshot` for an eligible station (for instance a long NL-1 series): its `basis.ref` contains `P10_DOY` or `P90_DOY` (alone or as `P10_DOY/P90_DOY`) and its `basis.label` starts with `DOY P10/P90` and a period such as `1991–2000`. A station with fewer than 10 years has no such basis.
4. Expect state changes at the NL-1 stations with at least 10 years: the DOY set ranks above the NL-4 display class (owner decision 2026-10-18). About 10 % of station-days are `elevated` by construction; that is "unusual for the date", never a warning (KG-397).

## 5. Re-run semantics

- **When:** after each backfill completes (a longer history changes the percentiles and the period), and once a year in January (another complete year exists). A change of a value in `registry/climatology.yaml` needs a run too: the stored rows keep the basis label and values of the old parameters until then (KG-406).
- **What changes:** only rows whose value changed; they close at the run start and a new range opens. Nothing before the run start is rewritten.
- **Series without enough years** (a live-only series since 2026-08) stay without rows until they have 10 complete years.

## 6. Rollback

The rows are derived, never the only copy. To take the climatology back, close the open DOY rows. As the superuser on the db container's socket (the only place it exists):

```bash
sudo docker exec -i rws-db-1 psql -X -U postgres -d rws <<'SQL'
BEGIN;
UPDATE reference_value
   SET valid = tstzrange(lower(valid), now(), '[)')
 WHERE kind IN ('P10_DOY', 'P90_DOY') AND upper_inf(valid);
SELECT count(*) AS closed FROM reference_value
 WHERE kind IN ('P10_DOY', 'P90_DOY') AND upper(valid) = now();
COMMIT;
SQL
```

Check the count against the dry-run's rows before `COMMIT` (change it to `ROLLBACK` if it is wrong). Afterwards the next `/snapshot` cache fill (within 60 s) no longer uses the DOY set; the files that were rendered while it was valid stay as they were. A later `climatology` run opens fresh ranges.

## 7. What to paste back

Counts only: the output of the dry-run and of the run (series considered, eligible, rows new, changed, unchanged and closed), the `climatology` and `by_climatology` figures of `status.json` for the public family, and the spot-check basis (`ref` and `label`) of one public station. Never a value, and never the id of an owner series.
