# Runbook: the Rijkswaterstaat tide and wide-network capture (capture side)

**Trigger:**
- the P16a `[agent-prod]` criterion of issue #64: after the deploy, `/status/capture.json` shows the six new NL-1 specs fresh (`docs/plan/PHASES.md` §54, P16a);
- a failing `interval NL-1 nl-1-obs-sea`, `… nl-1-obs-wide` or `… nl-1-obs-slow`, or a stale or failing spec among the six;
- a spec that fails with `invalid_too_large` or an `http_*` code;
- Rijkswaterstaat asks us to slow down or stop (§5).

Scope: capture only. Since P16a the six specs below fetch and archive; none has a loader entry, so nothing is parsed, stored in `obs` or shown until P16b (§6). The archived payloads are never pruned: a line of a spec with no loader entry writes no `ingest_batch` row, and the pruner deletes only payloads whose batch parsed `ok` with `n_skipped` 0.

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
- `nl-1-hwlw` may log nothing but 204 answers: at Vlissingen `GETETM2` answered 204 on 2026-10-17 for a 3-day and a 31-day window. A 204 passes the validity check (it is an answer with no data); whether RWS publishes measured extremes through `OphalenWaarnemingen` is still to be established (KG-366).
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

## 6. P16b: storage, the astro_horizon alert and replay (to be written)

P16b registers the 326 new rows, adds the loader entries, the astronomical-tide and high/low-water stores (never `obs`; ADR-0022 decision 4), the `astro_horizon` alert and the replay of the lines archived since the P16a deploy. This section is written then. Notes carried over: the Meuse TAW series at maastricht.sintpieter, maastricht.borgharen.maas.beneden and stevensweert (and the roadmap-1 twin eijsden.grens) are not new rows; `schaarvandenoord` H's live method is `RWSM-F232`, not `other:F007`; the hwlw-astro answer states `WaardeBepalingsMethode` `other:F012` although neither the seed row nor the request names a method (the series key needs it).
