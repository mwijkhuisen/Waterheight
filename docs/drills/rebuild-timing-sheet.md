# Rebuild timing sheet (E3)

The record of one timed run of `docs/runbooks/vps-rebuild.md`: the **owner** fills it in, on the day, from the clock and the pasted command output. **It ships empty.** Nothing in it is an estimate, a plan or a past result; a blank cell means not measured. Copy this file to `docs/drills/rebuild-<YYYY-MM-DD>.md` for each run and keep the template as it is.

| | |
|---|---|
| Mode | drill / real rebuild |
| Date (UTC) and operator | |
| Release tag deployed (`/var/lib/rws/current`) | |
| Drill hostname (never production's) | |
| Snapshot restored (ID, time) and age of `rws.dump` | |
| `RWS_CAPTURE_SKIP` | |

## Pass criteria

1. **Total ≤ 240 minutes**: from the first login to the new, empty VPS (T0) to the end of step 14. Rows that overlap in time count once, wall clock (the basemap of step 10 runs beside steps 6 to 9). Target RTO: A§11.3.
2. **0 Q7 gaps** in `/api/v1/health/sources` (`coverage.gaps`) for each source whose provider window is 7 days or more and that the run captures. These are the **judged sources**:

**Judged sources:** DE-1, DE-7, FR-1, LU-1.

   How the list is derived (a test pins it to the registry: `apps/server/test/capture/skip.test.ts`): Q7 coverage exists only for sources that have tier-1 series, and `registry/stations/` has tier-1 stations for DE-1, DE-7, FR-1, LU-1 and CH-1 and NL-1 among the public sources (BE-3's are owner-audience and are not in the public document). Their provider windows:

   | Source | Fill window in the registry (`registry/capture.yaml`) | Provider window (catalogue §0.1) | Judged |
   |---|---|---|---|
   | DE-1 | `de-1-series` `window.max` P30D; seed P31D | 31 days | yes |
   | DE-7 | none (each ZIP is read whole; `seed: once`) | `messwerte.zip` 7 days, `pegeldaten.zip` 2 months | yes |
   | FR-1 | `fr-1-obs` `window.max` P29DT23H; seed 30 days | 1 month | yes |
   | LU-1 | none (`seed: once`) | 7 days since 2026-09-30 | yes |
   | NL-1 | `nl-1-obs-*` `window.max` P31D | decades by API | no: **skipped on the drill** |
   | CH-1 | none (latest only; gap-filled from CH-3, 40 days) | 40 days by CH-3 | no: **skipped on the drill** |

   **CH-1 and NL-1 are skipped on the drill** (`RWS_CAPTURE_SKIP=CH-1,NL-1`: the production budget at Rijkswaterstaat is about 375 of 400 requests an hour, and LINDAS wants one request per 10 minutes, never faster; whether RWS counts per key or per IP is unknown). The drill therefore does **not** judge them. A **real rebuild** skips nothing and judges all six.
3. Every row below has its check output pasted and `pass` ticked. The drill's guard rails (`deploy/tests/rebuild-check.sh`) are all PASS (a SKIP is read and explained in the notes). Run it with `--production <production domain>`: without it the `bucket key` row is a SKIP, and that row must be PASS.

## Timings

Times in UTC (`date -u +%H:%M`). Minutes = end − start; for the total, the wall-clock span.

| Step | Start UTC | End UTC | Minutes | Check output pasted | Pass |
|---|---|---|---|---|---|
| 1 Verify the release, `bootstrap.sh` | | | | | |
| 2 Secrets (A7), bootstrap again | | | | | |
| 3 Quiet the host (timers, WireGuard on the drill) | | | | | |
| 4 `rws.env` | | | | | |
| 5 `rws-deploy`, stop `capture` and `load` | | | | | |
| 6 Restore the snapshot (raw, dump) | | | | | |
| 7 Restore the database (route B) | | | | | |
| 8 Replay since the dump | | | | | |
| 9 Start capture, load, api | | | | | |
| 10 Basemap and river files | | | | | |
| 11 WireGuard and owner site (real rebuild only) | | | | | |
| 12 DNS cut-over (real rebuild only) | | | | | |
| 13 `verify-prod.sh <domain> --profile …` | | | | | |
| 14 Q7 gap check, `rebuild-check.sh` | | | | | |
| **Total (wall clock, T0 to end of 14)** | | | | | |

## Results

| | |
|---|---|
| Q7 gaps: DE-1 / DE-7 / FR-1 / LU-1 (each a count) | |
| `rebuild-check.sh` table pasted (drill) | |
| `verify-prod.sh` profile and result | |
| D19 window: last snapshot time to first successful capture (UTC) | |
| Step that took longest, and why | |
| Anything the runbook got wrong (each becomes a KG with the step number) | |
| Total ≤ 240 min? 0 judged Q7 gaps? **Drill passed?** | |
| Drill VPS, DNS records and read-only key deleted (date) | |
