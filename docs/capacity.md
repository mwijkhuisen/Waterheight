# Capacity

Two parts. The year-1 disk and bucket projection is written by `scripts/verify-prod.sh <domain> --capacity --out docs/capacity.md` from production capture data (issue #16) and is not committed until a run has two complete UTC days. The egress budget below belongs to P12a (issue #27); `--capacity` writes only its own block between the `capacity:begin` and `capacity:end` markers and keeps everything else, the egress block and the narrative sections below included. The narrative outside the generated blocks is edited by hand.

<!-- capacity:begin -->
## Capacity projection (year 1; `scripts/verify-prod.sh --capacity`, P20a)

Measured from 2 complete UTC days of production capture (2026-10-21 to 2026-10-22), from the `days[]` block of `/status/capture.json` (generated 2026-10-23T16:55:30.020Z): zstd bytes stored after sha256 deduplication, per spec (issue #16). The partial day is left out. A spec that runs less than daily (monthly, weekly) or once (a catch-up, `cron: null`) is not averaged over the window: its row is the bytes of the day it ran times its runs a year from its cron (a one-shot counts once, and its bytes are those of the window). **Not in the window, so not measured and left out: `ch-3-40d`, `de-7-pegeldaten`, `de-8-hydro`, `fr-3-obs`, `fr-5-stations`, `nl-1-astro`, `nl-1-hwlw-astro`, `nl-1-obs-sea-catchup`, `nl-1-obs-slow-catchup`, `nl-1-obs-wide-catchup`, `nl-4-page`, `nl-4-xlsx`.**
Owner-audience specs are not in the public status file and are **not included**; add them with `--owner-bytes-per-day` (docs/runbooks/owner-checks.md).

### Per spec

| Source | Spec | Retention | Basis | Runs a year | Bytes/run | Bytes/day | Year-1 raw on disk (GB) | A§7.3 alert at 2x the median (B/day) |
|---|---|---|---|---:|---:|---:|---:|---|
| CH-1 | ch-1-lindas | obs | daily or faster, mean of the days | – | – | 1525619 | 0.137 | 3051238 PASS |
| CH-2 | ch-2-pq | obs | daily or faster, mean of the days | – | – | 3275201 | 0.295 | 6550402 PASS |
| CH-3 | ch-3-40d | obs | one-shot, once | 1 | not in the window | 0 | 0.000 | – |
| CH-4 | ch-4-forecast | forever | daily or faster, mean of the days | – | – | 2530198 | 0.924 | 5060396 PASS |
| CH-4 | ch-4-forecast-lake | forever | daily or faster, mean of the days | – | – | 579623 | 0.212 | 1159246 PASS |
| CH-4 | ch-4-stations | forever | daily or faster, mean of the days | – | – | 4373 | 0.002 | 8746 PASS |
| CH-5 | ch-5-warn | forever | daily or faster, mean of the days | – | – | 144042 | 0.053 | 288084 PASS |
| DE-1 | de-1-basin | obs | daily or faster, mean of the days | – | – | 1381577 | 0.124 | 2763154 PASS |
| DE-1 | de-1-meta | forever | daily or faster, mean of the days | – | – | 66612 | 0.024 | 133224 PASS |
| DE-1 | de-1-series | obs | daily or faster, mean of the days | – | – | 299288 | 0.027 | 598575 PASS |
| DE-6 | de-6-alerts | forever | daily or faster, mean of the days | – | – | 56711 | 0.021 | 113421 PASS |
| DE-6 | de-6-stations | forever | daily or faster, mean of the days | – | – | 3841610 | 1.402 | 7683220 PASS |
| DE-7 | de-7-messwerte | obs | daily or faster, mean of the days | – | – | 6793593 | 0.611 | 13587186 PASS |
| DE-7 | de-7-pegeldaten | forever | per run x runs a year | 52 | not in the window | 0 | 0.000 | – |
| DE-8 | de-8-hydro | forever | per run x runs a year | 52 | not in the window | 0 | 0.000 | – |
| DE-8 | de-8-stations | forever | daily or faster, mean of the days | – | – | 0 | 0.000 | – |
| FR-1 | fr-1-obs | obs | daily or faster, mean of the days | – | – | 5362206 | 0.483 | 10724411 PASS |
| FR-1 | fr-1-ref | forever | daily or faster, mean of the days | – | – | 3627 | 0.001 | 7253 PASS |
| FR-3 | fr-3-obs | obs | one-shot, once | 1 | not in the window | 0 | 0.000 | – |
| FR-3 | fr-3-twin | obs | daily or faster, mean of the days | – | – | 104928 | 0.009 | 209855 PASS |
| FR-4 | fr-4 | forever | daily or faster, mean of the days | – | – | 46339 | 0.017 | 92677 PASS |
| FR-5 | fr-5-ref | forever | daily or faster, mean of the days | – | – | 59400 | 0.022 | 118799 PASS |
| FR-5 | fr-5-sections | forever | daily or faster, mean of the days | – | – | 40589 | 0.015 | 81178 PASS |
| FR-5 | fr-5-stations | forever | per run x runs a year | 52 | not in the window | 0 | 0.000 | – |
| FR-5 | fr-5-vigilance | forever | daily or faster, mean of the days | – | – | 2031296 | 0.741 | 4062592 PASS |
| LU-1 | lu-1-csv | obs | daily or faster, mean of the days | – | – | 1373220 | 0.124 | 2746440 PASS |
| LU-5 | lu-5-cap | forever | daily or faster, mean of the days | – | – | 9151 | 0.003 | 18301 PASS |
| LU-6 | lu-6-geo | forever | daily or faster, mean of the days | – | – | 3002 | 0.001 | 6004 PASS |
| NL-1 | nl-1-astro | forever | per run x runs a year | 12 | not in the window | 0 | 0.000 | – |
| NL-1 | nl-1-catalogue | forever | daily or faster, mean of the days | – | – | 267221 | 0.098 | 534441 PASS |
| NL-1 | nl-1-fc-1h | forever | daily or faster, mean of the days | – | – | 1129150 | 0.412 | 2258300 PASS |
| NL-1 | nl-1-fc-3h-0 | forever | daily or faster, mean of the days | – | – | 720580 | 0.263 | 1441160 PASS |
| NL-1 | nl-1-fc-3h-1 | forever | daily or faster, mean of the days | – | – | 780327 | 0.285 | 1560653 PASS |
| NL-1 | nl-1-fc-3h-2 | forever | daily or faster, mean of the days | – | – | 807331 | 0.295 | 1614662 PASS |
| NL-1 | nl-1-hwlw | obs | daily or faster, mean of the days | – | – | 0 | 0.000 | – |
| NL-1 | nl-1-hwlw-astro | forever | per run x runs a year | 12 | not in the window | 0 | 0.000 | – |
| NL-1 | nl-1-obs-key | obs | daily or faster, mean of the days | – | – | 2540754 | 0.229 | 5081507 PASS |
| NL-1 | nl-1-obs-other | obs | daily or faster, mean of the days | – | – | 2305385 | 0.207 | 4610769 PASS |
| NL-1 | nl-1-obs-sea | obs | daily or faster, mean of the days | – | – | 3034827 | 0.273 | 6069654 PASS |
| NL-1 | nl-1-obs-sea-catchup | obs | one-shot, once | 1 | not in the window | 0 | 0.000 | – |
| NL-1 | nl-1-obs-slow | obs | daily or faster, mean of the days | – | – | 3843948 | 0.346 | 7687895 PASS |
| NL-1 | nl-1-obs-slow-catchup | obs | one-shot, once | 1 | not in the window | 0 | 0.000 | – |
| NL-1 | nl-1-obs-twin | obs | daily or faster, mean of the days | – | – | 102562 | 0.009 | 205124 PASS |
| NL-1 | nl-1-obs-wide | obs | daily or faster, mean of the days | – | – | 3657313 | 0.329 | 7314626 PASS |
| NL-1 | nl-1-obs-wide-catchup | obs | one-shot, once | 1 | not in the window | 0 | 0.000 | – |
| NL-2 | nl-2-wfs | obs | daily or faster, mean of the days | – | – | 1762274 | 0.159 | 3524548 PASS |
| NL-4 | nl-4-page | forever | per run x runs a year | 52 | not in the window | 0 | 0.000 | – |
| NL-4 | nl-4-xlsx | forever | per run x runs a year | 52 | not in the window | 0 | 0.000 | – |

### Alert rules (A§7.3)

| Rule | Result |
|---|---|
| No spec above 2x its measured median on a complete day | PASS |
| The public total at most 1 GB a day (largest complete day: 54096349 B) | PASS |

### Year-1 projection

| Item | GB | Basis |
|---|---:|---|
| Raw archive, obs classes (90-day window at its steady state) | 3.4 | measured |
| Raw archive, forever classes (365 days) | 4.8 | measured |
| Database, observations (2108 public series rows, 317783 samples a day, 102.1 B a row, 365 days) | 11.8 | **computed** from the registry's expected steps: ops.json carries no database size, so no trend is measured; an upper bound, as not every row delivers. 102.1 B a row was measured in P14b |
| Database, rollups and forecasts | 5 | A§11.4 estimate |
| Database, backfill history (NL-1 12.35 and P14b 2.44) | 14.8 | A§11.4, computed upper bound, not measured |
| Static files, images, logs | 25.9 | `--static-gb-year`, the publisher bench figure |
| Basemap, current and previous (A§11.4) | 9 | constant |
| **Total on the ≥ 200 GB disk** | **74.7** | 37% of the disk; the disk alert fires at 75% (150 GB): PASS |
| Off-site bucket need: every raw object for 12 months (restic keeps 12 monthly snapshots) | 18.4 | against the bucket size **OWNER: A9** |

Measured now: settled/ and frames/ hold 0.92 GB (`/data/v1/status.json` publisher.settledBytes, a point reading, not a growth rate); /srv/rws is 4% full (`/status/ops.json` disk_pct).
<!-- capacity:end -->

<!-- egress:begin -->
## Egress budget (P12a, issue #27; decision D20)

Generated from `docs/capacity-egress.json` by `node scripts/lib/capacity-egress.ts`; edit the JSON and re-run it, not this block (`scripts/verify-prod.sh --capacity` keeps it).

Profile: one cold-cache map session (open the map, zoom, pan, 2 station panels, 5 timebar steps, 1 day of playback, a search for a lake gauge and a zoom onto the lake), measured by `apps/web/e2e/egress.spec.ts` as bytes on the wire (headers and body, compressed, as transferred), at 2026-10-10T20:14:11.902Z. Compose stack: the tiles are a Lobith fixture and the data a synthetic seed, so this is a regression guard, not a production forecast of the bytes.

| Class | Requests | Bytes (MB) |
|---|---:|---:|
| tiles | 43 | 2.92 |
| assets | 53 | 1.12 |
| data | 14 | 0.43 |
| api | 4 | 0.00 |
| html | 1 | 0.00 |
| other | 1 | 0.00 |
| **Session** | 116 | **4.47** |

CI fails when the session total grows by more than 20% over the baseline; a class above 20% is reported (WARN), because the classes move with the time of day between runs (`EGRESS_UPDATE=1` rewrites the baseline; the change is reviewed like any other). A cold cache is the worst case: a returning visitor re-fetches no hashed asset. The session has no dwell time, while an open live view re-polls its data every 60 s, so the figures below are a lower bound for long visits (review CR-7).

### Inputs

| Input | Value | Source |
|---|---:|---|
| VPS uplink (Mbit/s) | **OWNER: A3** | owner, from the plan ordered in A3 (order minimum: 1000) |
| Monthly traffic quota (TB) | **OWNER: A3** | owner, from the plan ordered in A3 (order minimum: 20) |
| Sessions per hour at the flood-day peak | 20,000 | ASSUMPTION, owner confirms |
| Hours of a flood day at that rate | 12 | ASSUMPTION |
| Flood days in the worst month | 3 | ASSUMPTION |
| Sessions on an ordinary day | 3,000 | ASSUMPTION |
| Burst factor (peak minute against the hourly mean) | 2 | ASSUMPTION |

### Result

| Item | Value | Against the plan |
|---|---:|---|
| Flood-day peak egress | 397.6 Mbit/s | **OWNER: fill in `inputs` of `docs/capacity-egress.json` (A3)** |
| Worst month | 3.62 TB (810,000 sessions) | **OWNER: fill in `inputs` of `docs/capacity-egress.json` (A3)** |

Verdict: not decided until the owner fills in A3.

### Rule (D20)

If the flood-day peak exceeds 50% of the uplink **or** the month exceeds 50% of the traffic quota, arm a CDN pull zone for `/tiles/*` and `/assets/*` only (static, licence-neutral) under the same hostname, following `docs/runbooks/cdn-break-glass.md`, and name the CDN on the privacy page before it goes live. **Never switch to OpenFreeMap or any other third-party tile host**: that adds third-party browser requests (invariant 7) and changes the CSP.
<!-- egress:end -->

## Publisher (P20a, issue #68)

P20a gave the publisher budgets at 4,000 or more series, measured by the publisher phase of `scripts/bench-q1.ts` (`--series 4000 --days 60`, 23,044,000 rows) and asserted in the CI jobs `bench` (a hard gate at 3,000 series) and `bench-4000` (B1 to B4 and Q1 asserted, the timing limits of the tide reads and the API phase reported; owner decision Q5):

| Budget | Limit | Local clean run | CI run 39970900430 |
|---|---|---:|---:|
| B1, per 10-minute bucket (render, validation and canary scan, `.zst`/`.gz`/plain write), p95 | 500 ms | recent 229, settled 238 ms | recent 275, settled 283 ms (max 661) |
| B2, `latest.json` gzip | 200,000 B | 83,246 B (464,229 plain, 73,433 zstd) | 85,580 B |
| B3, a recent or settled snapshot, gzip | 150,000 B | recent 53,345, settled 55,388 B | recent 55,581, settled 55,494 B |
| B4 (derived), one bucket's new values for every series published within one bucket period of 600 s, cycles counted at max(60 s, cycle) | 600 s | drain 300 s (5 cycles, steady cycle 35.1 s) | drain 360 s (6 cycles, steady cycle 35.2 s) |

B4 was derived by the lead from `CYCLE_MS` and `BUCKET_MS`; the owner chose B1 to B3. Machines: the local run is the owner's WSL box (AMD Ryzen 7 5800X, 8 cores, 16 threads, 31.3 GiB, PostgreSQL 18.6, alone, 2026-10-23); the CI run is a GitHub ubuntu-24.04 runner (AMD EPYC 7763, 4 cores, 15.6 GiB, PostgreSQL 18.6, head b40d099). The publisher's station files dominate a steady cycle (about 980 files a cycle at about 33 ms each locally). The A§11.4 static line is re-based on the measurement: 144 settled buckets a day of (392,001 plain + 55,388 gzip + 44,955 zstd) B, 365 days, is **25.9 GB a year at 4,000 series**, 5.18 times the 5 GB line of A§11.4 (and the 9 GB a year at 1,717 series of 2026-10-22); the plain files are about 80 % of the bytes. The production block above uses 25.9 through `--static-gb-year 25.9` (total 74.7 GB, 37 % of the disk, still PASS). KG-462 to KG-471 record what stays open.

## Tunnel mode (#109, ADR-0021)

The block above is measured against the origin's own uplink and is not regenerated for the tunnel. With `RWS_EDGE=tunnel` (`docs/runbooks/edge-switch.md`) Cloudflare carries the egress of the cached trees: `/assets/*` and `/data/*` are answered at its edge once cached, and the origin sees one request per object and edge location instead of one per visitor. The tiles bypass the cache (cache rule 1: `Range` on a cold miss of a cacheable object is dropped, and our tile routes answer 416 without one), so `/tiles/*`, the API and the pages still use the home line's uplink; in the egress table above the tiles row (43 of 116 requests, 2.92 of 4.47 MB per session) is the part the tunnel does not take off the line. Uncached tile ranges are also the part Cloudflare's Service-Specific Terms ("disproportionate large files", 2026-09-28) can be read against (R-103). The D20 rule above still decides when more is needed; in tunnel mode there is no pull zone to arm, and R2 or any other tile host stays out (invariant 7).

## RWS capture archive growth until P16b (P16a, #64)

The three P16a observation specs have no loader entry until P16b, so their payloads are archived and **not pruned** (the pruner deletes only payloads whose batch parsed `ok`, and such a line writes no batch). Sizes are measured on the committed fixtures, one request each; zstd -3 is per object.

| Spec | Requests a day | Raw (B) | zstd (B) | MB a day raw / zstd |
|---|---:|---:|---:|---:|
| `nl-1-obs-sea` | 3,888 | 6,275 | 894 | 24.4 / 3.5 |
| `nl-1-obs-wide` | 4,416 | 11,298 | 940 | 49.9 / 4.2 |
| `nl-1-obs-slow` | 4,968 | 11,604 | 916 | 57.7 / 4.6 |
| `nl-1-hwlw` | 83 | – | – | 0 while it answers 204 |
| **Total** | 13,355 | | | **131.9 / 12.2** |

That is about 4.0 GB a month raw and 365 MB a month in the archive (zstd), on top of `nl-1-astro` (about 35 MB a month, kept forever; KG-363). P16b's loader and the pruner end the growth of the observation payloads.
