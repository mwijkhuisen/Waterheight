# Runbook: empirical travel times (P14f)

**Trigger:**
- the owner wants travel-time ranges measured on our own history, after the NL-1 backfill (or a later P14 backfill) has completed;
- a yearly refresh, when more history or a changed `travel` block in `registry/climatology.yaml` could move the ranges;
- a populated `registry/travel-empirical.yaml` has to be reviewed, replaced or emptied.

The `travel-times` role is a one-shot, read-only job. For every reach of `registry/rivernet.yaml` whose two end stations are public, with series in the public views, and which is neither tidal nor impounded, it cross-correlates the changes of the upstream and the downstream series (discharge where both ends have it, else level) in windows of 14 days, groups the windows by the upstream flow (terciles) and prints the lag range per class as YAML. It writes nothing to the database. The output is a **proposal**: it becomes a travel time on the map only through a reviewed data PR and the next geo release (catalogue §3.7, `PHASES.md` §56). It replaces nothing sourced: a pair of `registry/rivers.yaml` always wins.

## 1. What it does, and its rules

| Rule | Consequence |
|---|---|
| Runs as `rws_publish` and reads the **public views only**, one series-year per query (the role has a 2 s statement timeout and a 256 MB temp-file limit); there are no rollups before 2026-08-01, so it reads raw observations | An owner series cannot be read, so no owner travel time exists anywhere (KG-400). A long range takes minutes, one query per series-year |
| Parameters come from the `travel` block of `registry/climatology.yaml`: window 336 h stepped by 168 h, a 6 h centred mean, first differences, Pearson r of at least 0.5 at an **interior** lag from 1 h to the reach's maximum (`min(96, max(12, ceil(length_km)))`), at least 6 windows per flow class, a window needs 90 % of its hours in each series and 80 % paired | A maximum at an end of the lag range is a trend, not a lag, and counts nothing. A reach where no class has 6 windows has no entry |
| A class range is `[floor(P25), ceil(P75)]` of its windows' lags, widened to at least 1 h; the reach's `h` is the envelope over the qualifying classes | It is a spread, never a point or an ETA |
| Output: the YAML of `registry/travel-empirical.yaml` on **stdout**, counts on stderr (reaches, eligible, without public series, without a common quantity, queries, years, pairs); `--from YYYY` (default 1990, the NL-1 backfill floor) and `--to YYYY` (default the current year), each at most once; exit 0, 1 (a read failed), 64 (usage), 78 (no database settings or an unusable registry) | stdout must stay clean: see §2 |
| Public stations only; the geo build fails on an unknown or non-public station in the file | An owner station can never reach a public release |

## 2. Run it

Use the `rwsc` helper of `docs/runbooks/backfill.md` §2. **`-T` is required**: with a TTY, compose mixes terminal control characters into stdout and corrupts the YAML.

```bash
rwsc() { sudo bash -c 'cd / && . /usr/local/lib/rws/deploy/bin/rws-lib.sh && rws_compose "$@"' rwsc "$@"; }
rwsc run --rm --no-deps -T publish travel-times > travel.yaml
```

Check the file before sending it: it must start with `version: 1`, `generated:` and `pairs:`, and the stderr line must say how many pairs it holds. A run on a database without the backfill yields `pairs: []`, which is correct. Send the file to the agent (it holds public data only) and paste the counts line.

## 3. Review

A sane pair, by what the catalogue and the physics say:
- the two stations are on one river and adjacent in order, the reach is the real reach between them, and `h` is of the order of its length at a speed of a few kilometres an hour (compare the sourced anchors of catalogue §3.7, and the flow dependence: floodplain storage slows a wave at high flow);
- the classes are ordered as the physics says: the high-flow class is not slower than the low-flow class by a large factor, and a class with a very wide range (a spread above the lower bound) is thin evidence;
- `windows` is not just above 6, and `years` spans several years;
- `quantity` is `Q` where both ends have discharge.

Reject or drop a pair that is implausible (a weir-regulated reach, a pair whose lag is the lower limit of 1 h, a class that contradicts the others). Step 0 of the build (offline, on `registry/rivernet.yaml`) found **10** reaches with backfilled history at both ends that are neither tidal nor impounded, all NL-1 to NL-1 (ijssel.2, ijssel.7, ijssel.8, ijssel.11, meuse.37, vechte.6, vechte.7, waal.2, waal.3, waal.6); with the same quantity at both ends and an interior lag of at least 1 h, at most about 6 can qualify, and which of the 71 NL-1 series are backfilled in production is not known from the repository (KG-399). An empty or tiny result is a result.

## 4. The data PR

The agent replaces `registry/travel-empirical.yaml` with the reviewed file (`generated` set, `pairs` as reviewed), runs `node scripts/gen-rivernet.ts` and `node scripts/gen-rivernet.ts --check`, and opens a PR (`pnpm check` must be green). The geo build reads the file beside `registry/rivers.yaml`: where no sourced pair names a reach's two public stations and an empirical pair does, the reach gets `travel_time_h`, a `travel_time_source` that starts with `empirical:` and a derived pair in `travel_times`, shown on the site as "indicative: lo–hi h (derived)" (the web reads only `travel_times`, and a derived pair never drives the map time shift). The PR touches `registry/travel-empirical.yaml`, so `geo.yml` runs on it as evidence; the owner merges.

## 5. Release and install

After the merge, a new geo release makes the ranges live:

```bash
gh workflow run geo.yml --ref main
gh run list --workflow geo.yml --limit 3
```

Dispatch it once: a second run on the same UTC day with different content fails (`docs/runbooks/geo-refresh.md` §7), so never start two the same day. It publishes `geo-YYYY-MM-DD`. Then on the VPS, as in `docs/runbooks/geo-refresh.md` ("Serving the rivers (P6b)"):

```bash
sudo rws-rivers-refresh --dry-run
sudo rws-rivers-refresh
```

and `scripts/verify-prod.sh <domain>` (the `rivers` checks). The owner publisher splits the installed reaches file at the owner stations and keeps the public values; split parts get no travel time.

## 6. Take it back

Replace `registry/travel-empirical.yaml` with `version: 1`, `generated: null`, `pairs: []` in a PR, run `node scripts/gen-rivernet.ts`, merge, dispatch `geo.yml` and refresh. Or `sudo rws-rivers-refresh --rollback` to the previous release at once.

## 7. What to paste back

The stderr counts line of the run; the number of pairs the owner kept; nothing else (the file itself is public data and goes to the agent).
