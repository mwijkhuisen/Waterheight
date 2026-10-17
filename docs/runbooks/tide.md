# Runbook: the Rijkswaterstaat tide and wide-network capture (capture side)

**Trigger:**
- the P16a `[agent-prod]` criterion of issue #64: after the deploy, `/status/capture.json` shows the six new NL-1 specs fresh (`docs/plan/PHASES.md` §54, P16a);
- a failing `interval NL-1 nl-1-obs-sea`, `… nl-1-obs-wide` or `… nl-1-obs-slow`, or a stale or failing spec among the six;
- a spec that fails with `invalid_too_large` or an `http_*` code;
- Rijkswaterstaat asks us to slow down or stop (§5).

Scope: capture (§1 to §5) and, since P16b, loading (§6). Since P16a the six specs below fetch and archive. Until the P16b release was deployed none had a loader entry, so nothing was parsed, stored or shown, and the archived payloads were never pruned (a line of a spec with no loader entry writes no `ingest_batch` row, and the pruner deletes only payloads whose batch parsed `ok` with `n_skipped` 0). With P16b they load (§6); the replay that loads the lines archived since the P16a deploy is `docs/runbooks/replay.md` §13.

All specs are source NL-1, host `ddapi20-waterwebservices.rijkswaterstaat.nl`, `OphalenWaarnemingen` POST, one location per request, targets only from the registry seeds `registry/seed/nl-1.csv` and `registry/seed/nl-1-tide.csv`.

## 1. What is fetched, and when (UTC)

| Spec | Rows | Cron | Does | `max_bytes` | Retention |
|---|---|---|---|---|---|
| `nl-1-obs-sea` | 27 | `7-59/10 * * * *` | measured H of the coast, Scheldt and delta gauges, window PT3H | 2 MiB | obs |
| `nl-1-obs-wide` | 92 | `13,43 * * * *` | the 30-minute tier: offshore H (`MSL`), delta, river H (`NAP`, one `TAW` at `elsloo.maas`) and Q (`NVT`), window PT6H | 2 MiB | obs |
| `nl-1-obs-slow` | 207 | `53 * * * *` | lakes and canals, H and Q, window PT6H | 2 MiB | obs |
| `nl-1-hwlw` | 83 | `30 0 0 * * *` (00:00:30 to 04:06:31) | measured high and low water, `Groepering` `GETETM2` (`GETETMSL2` offshore), window P3D | 2 MiB | obs |
| `nl-1-astro` | 79 | `30 0 20 1 * *` (20:00:30 to 23:54:30 on the 1st) | astronomical tide, `ProcesType` `astronomisch`, method `other:F012`, from now to now + P400D, `timeout: metadata` (120 s) | 25 MiB | forever |
| `nl-1-hwlw-astro` | 79 | `30 30 4 2 * *` (04:30:30 to 08:24:30 on the 2nd) | astronomical high and low water, `GETETBRKD2` (`GETETBRKDMSL2` offshore), P400D | 2 MiB | forever |

The three tide specs space their requests with `space_ms: 179000` (a 180 s period, at most 20 requests an hour each) and carry a seconds field in the cron, so that no spaced request meets the 10-minute NL-1 starts; they run at different times and never overlap each other. A first start, a catch-up or a retry can run all three at once; that worst case (the busiest hour of every other RWS spec, 926, plus 3 × 20) is 986 and is tested. Together all NL-1 specs peak at 946 requests in any 60 minutes (limit 1,000); roadmap 1's specs alone are 373 (limit 400). `node apps/server/dist/main.js capture --dry-run` prints the figure.

The seed files are data: `nl-1.csv` has the columns `code,quantity,tier,note,hoedanigheid` (tiers `sea`, `wide`, `slow` are the new ones; the 88 roadmap-1 rows are unchanged), `nl-1-tide.csv` has `code,series,hoedanigheid,groepering,method`. A change of either is a reviewed PR, regenerated against the inventory tests (`test/nl1-seed.test.ts`); structure-internal locations never appear in them.

## 2. The astro horizon

The astro window is P400D from the moment of the request (the nightly contract check asks 2 days only). On 2026-10-17 that reaches 2027-11-21 (57,600 values at Vlissingen, one list). Rijkswaterstaat has published the astronomical tide to the end of 2027 only; a longer window simply returns what exists, so 2028 is picked up by the monthly run once it is published (question 6 of C14). An answer that ends earlier than 60 days ahead is for P16b to alert on (`astro_horizon`, §6).

The 17 MB astro body runs under `timeout: metadata` (120 s), because all specs of the host share one politeness state: a failing or timing-out astro request counts towards the host's circuit breaker (5 consecutive failures) and can delay the tier-1 NL-1 fetches. The hourly retry after a transient failure re-runs only the variants that did not succeed.

Measured sizes (2026-10-17): astro Vlissingen 17,003,443 B raw, 445,693 B at zstd -3 (25 MiB `max_bytes` is 1.54 times the body); 79 locations are about 1.3 GB downloaded a month and about 35 MB a month in the archive, kept forever (about 420 MB a year). hwlw-astro 457,172 B per location.

## 3. Checking that it runs

```bash
curl -s https://<domain>/status/capture.json \
  | jq -r '.specs[] | select(.spec|test("^nl-1-(obs-(sea|wide|slow)|hwlw|astro|hwlw-astro)$")) | "\(.spec) \(.last_success) \(.last_failure_status)"'
scripts/verify-prod.sh <domain> --dry-run | grep 'interval NL-1'
scripts/verify-prod.sh <domain>
```

- A spec is fresh while its last success is at most 3 × its cadence old: 30 min, 90 min, 3 h, 3 days, and 84 days for the two monthly specs. Until the first monthly run (the 1st at 20:00 UTC and the 2nd at 04:30 UTC) `nl-1-astro` and `nl-1-hwlw-astro` show no success; that is not a failure.
- `interval NL-1 nl-1-obs-sea` (at least 595 s), `… nl-1-obs-wide` (1795 s) and `… nl-1-obs-slow` (3595 s) read `min_interval_s`, the shortest gap in the last 24 h. There is no such check for the daily and monthly specs; `freshness` covers them.
- `nl-1-hwlw` may log nothing but 204 answers: at Vlissingen `GETETM2` answered 204 on 2026-10-17 for a 3-day and a 31-day window. A 204 passes the validity check (it is an answer with no data); whether RWS publishes measured extremes through `OphalenWaarnemingen` is still to be established (KG-366; P16b probed September 2025 as well, with and without `other:F010`, and both answered 204).
- Health of NL-1 itself is unchanged: roadmap 1's series are judged as before.

## 4. `invalid_too_large`, `http_*` and other failures

- `invalid_too_large`: a body over the spec's `max_bytes`. Do not raise the limit on the VPS. Look at the failing variant in `/status/capture.json`, then open a registry PR (`registry/capture.yaml`) that raises it with the measured size, or shortens the window.
- `http_4xx` for one variant: the request is refused for that location or combination (for example an unknown `Groepering` or method). Remove or correct that seed row by PR. Never edit the seed, the spec or a container on the VPS (invariant 1: targets come only from `registry/`).
- `http_429` or `http_5xx`, or the circuit breaker open: capture slows down by itself (full jitter from 30 s up to 30 min, `Retry-After` honoured, a probe every 30 min). If it lasts for hours, treat it as RWS asking us to slow down and go to §5. See also `docs/runbooks/provider-outage.md`.
- A new RWS method code on a location (a series answering a method the seed row does not name) shows as `unregistered_method` only once P16b loads; the capture itself is unaffected.

## 5. If Rijkswaterstaat objects

The wider load is announced in C14 (`docs/legal/requests/c14-rws-roadmap-2.md`) and deploys only ≥ 10 working days after it and only without an objection. If RWS asks us to slow down or stop at any time:

1. Open a PR at once that removes or slows the new specs in `registry/capture.yaml`: the three observation tiers first, then the tide specs. Roadmap 1's specs (`nl-1-obs-key`, `nl-1-obs-other`, `nl-1-obs-twin`, `nl-1-catalogue` and the four `nl-1-fc-*` specs) are untouched.
2. In the same PR set `RWS_LIMIT` in `apps/server/src/main.ts` and the cap in `apps/server/test/capture/budget.test.ts` back to 400. The test keeps the roadmap-1 assertion at 400 or below and the two-request concurrency assertion; the PR is green only if the remaining registry fits the lower cap.
3. The owner merges and deploys it through the normal release; there is no hot edit on the VPS.
4. Answer RWS with the new figures (`capture --dry-run` prints them) and note it in `docs/permissions.md` under C14.

Payloads already archived stay (retention `forever` for the two monthly specs).

## 6. P16b: loading, the catch-up, the astro_horizon alert and the deploy rule

P16b registers the roadmap-2 stations (`registry/stations/nl-1.yaml`: 429 rows at 391 stations, 18 of them `audience: off` structure-internal rows), adds the loader entries and stores the astronomical tide and the high and low waters in the table `tide` (never `obs`; ADR-0022 decision 4, A§6). The numbers and codes are in CLAUDE.md, Gotcha "NL-1 tide and roadmap-2 loading (P16b)".

**What loads where.**

| Spec | Loader | Lands in |
|---|---|---|
| `nl-1-obs-sea`, `nl-1-obs-wide`, `nl-1-obs-slow` | the NL-1 observation loader | `obs`, with the roadmap-1 series |
| `nl-1-obs-sea-catchup`, `-wide-catchup`, `-slow-catchup` | `nl1Catchup`: no age limit, rows before the data epoch (2026-10-02) dropped as `before_epoch` | `obs` |
| `nl-1-astro` | tide loader, kind `astro`, 25 MiB | `tide` (`hilo` null) |
| `nl-1-hwlw-astro` | tide loader, kind `extreme_astro` | `tide` (`hilo` high or low) |
| `nl-1-hwlw` | tide loader, kind `extreme` | `tide`; the live answer is still 204, so nothing is stored (KG-366) |

The tide values attach to the registered primary measured H series of the same location and datum. Readers see them only through `pub_tide` and `own_tide`.

**The deploy rule (owner, 2026-10-17; KG-377, R-108).** The live NL-1 specs plus the catch-up seeds peak at 998 requests an hour (limit 1,000). A capture restart that fires the three tide specs while a seed runs reaches 1,038, which the owner accepted on these conditions:

1. Approve the P16b deploy between 06:00 and 22:00 UTC, never in the seed hours 00:00 to 05:00.
2. Check the P14a backfill first and pause it if it runs. It shares the RWS host and is not in the budget model (KG-365):

   ```bash
   rwsc run --rm --no-deps -T backfill backfill status
   ```

   (`rwsc` is the compose function of `replay.md` §2. `backfill pause --job <id>` pauses a running job; `resume` starts it again after the catch-up.)
3. Do not restart `capture` in 00:00 to 05:00 UTC until the catch-up seed report says done (below).

**Watching the catch-up.** Each of the three seeds fetches one window [2026-10-02, the seed's first start] per row, at 85 s a request in UTC hours 0 to 5: 42 requests an hour, 210 a night, so 326 requests take about two nights, one seed after another. A seed ends a night at 05:00 and resumes the next night through the rows it has seen.

```bash
curl -s https://<domain>/status/capture.json \
  | jq -r '.specs[] | select(.spec|test("^nl-1-obs-(sea|wide|slow)-catchup$")) | "\(.spec) \(.last_success) \(.last_failure_status)"'
scripts/verify-prod.sh <domain> --dry-run | grep -E 'catch-up NL-1|fresh NL-1|astro horizon'
scripts/verify-prod.sh <domain>
```

- A seed is done when it appears in `.seeds[]` of `/status/capture.json` (the file lists finished seeds only, each with its `done_at`) (`curl -s https://<domain>/status/capture.json | jq '.seeds[] | select(.spec|test("catchup"))'`; the state file is `/srv/rws/raw/_state/seeds/<spec>.json` on the host, `docs/runbooks/owner-drift.md` §3 describes the same fields). Until then a row that failed or was cut at 05:00 is fetched the next night.
- `catch-up NL-1` passes when every tier-1 tidal and lake series of tier `sea` has `dataSince` at most the data epoch + 1 h and the NL-1 `coverage.ratio` is at least 0.95. It needs the catch-up and the loader to have finished, so it fails before that (it is in the allow-fail list of the CI deploy job).
- `fresh NL-1 coast` and `fresh NL-1 lakes` pass when at least 90 % of the tier-1 gauges with `flags.tidal` and `flags.lake` hold a value no older than 45 minutes at `meta.now`.
- While the catch-up loads, a settled day's version is bumped at most once an hour (or after 15 quiet minutes): the loader holds the days in `app_meta` `bump_pending` and flushes them with one bump per family. A publisher that re-renders many settled days in the first morning after the catch-up is expected, once. In that deferral window (up to an hour) a settled day is revised under an unchanged version, so an immutable `v=N` answer cached then may hold either state; it heals at the flush, which bumps the day. A malformed `bump_pending` raises `bump_pending_bad` and is cleared (its days are lost; the next catch-up payload opens a new set); a failing flush raises `bump_flush_failed` with a fixed code, keeps the set and is tried again by the next tick, and never stalls the loader.
- Backoff, the circuit breaker and 429 apply to the seeds: they go through the same runner and the same HTTP client as the cron specs (`http/politeness.ts`, `http/client.ts`, the runner's transient set; tests `test/http/client.test.ts`, `test/http/politeness.test.ts`, `test/capture/seeds.test.ts`). A 429 or a run of failures slows every NL-1 spec, the seeds included. If RWS objects, go to §5.

**`astro_horizon`.** `/api/v1/health/sources` shows `astro_horizon` for NL-1: the earliest of the newest stored astronomical instants of its series (active primary series of NL-1's own audience that are displayed), so the series that runs out first sets it, or null when there is none. The alert `astro_horizon` (fields `source`, `days`) fires once per UTC day while the horizon is less than 60 days ahead. Causes and actions:

- The monthly `nl-1-astro` run failed or has not run yet (it runs on the 1st at 20:00:30 UTC). Check its status in `/status/capture.json`; a `invalid_too_large` is §4. The horizon is null until the first run has loaded or the replay (`replay.md` §13) has run.
- RWS has not published further: the P400D window then returns what exists (2027-12-31 now, KG-367). Nothing to fix; the alert stays until 2028 is published.

`verify-prod`'s `astro horizon` fails while the horizon is under `meta.now` + 60 days.

**`hwlw_unlabelled`.** The payload carries no high or low marker, so the loader derives it by strict alternation inside each list (CLAUDE.md, the P16b Gotcha; KG-369). A list that breaks the alternation (fewer than 2 values, equal neighbours, two highs or two lows in a row, as at the agger stations with a double low water), that lost a value between its first and last kept one (`gap`, `unknown_quality`, `conflict`, `out_of_range`: the rest could still alternate with every label after the hole flipped) or whose consecutive extremes lie more than 10 h apart (a missing extreme; the real spacing is 4.5 to 8 h) is the retained drop `hwlw_unlabelled`: an alert with `source`, `spec` and `n`, **nothing stored for that series from that payload**, and the object kept (the batch's `n_skipped` is above 0, so the pruner keeps it). It is not a parser fault. A single-value list is one too: acceptable now, because the measured extremes answer 204 and a P3D window holds about 12 values, so a lone value is a provider fault worth the alert. It is released by a replay after a change that labels such a list, or by capturing RWS's own type series (`Typering GETETTPE`, issue #174). Do not edit stored rows. KG-370 lists the stations.

**Drift.** A `tide_*` code (`tide_quantity`, `tide_unit`, `tide_compartment`, `tide_process`, `tide_grouping`, `tide_datum`) quarantines the payload: RWS answered something other than what the request asked for. Follow `schema-drift.md`.

**Replay.** After the deploy, `docs/runbooks/replay.md` §13 loads the archived astro and high and low water lines and the forecast runs of the newly registered locations.

Notes carried over from P16a: the Meuse TAW series at maastricht.sintpieter, maastricht.borgharen.maas.beneden and stevensweert (and the roadmap-1 twin eijsden.grens) are not new rows; `schaarvandenoord` H's live method is `RWSM-F232`, not `other:F007`; the hwlw-astro answer states `WaardeBepalingsMethode` `other:F012` although neither the seed row nor the request names a method (the series key needs it).
