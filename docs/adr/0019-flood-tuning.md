# ADR-0019: Flood tuning, brownout and the owner listener (P12a)

- **Status:** Accepted (2026-10-10; issue #27, PR #130)
- **Date:** 2026-10-10
- **Evidence:** the `loadtest.yml` jobs of PR #130 (k6 1.8.1 on the real compose stack, six client processes in the outside namespace; summaries in the `k6-summary-*` artifacts). CI runners are not the VPS: the numbers prove the shape (who starves whom), not production capacity. The production run (`loadtest.yml` mode `production`, static only, 1,000 r/s) is an [owner] step.

## Context

Issue #27 asks for the flood path to hold when the river is high: static files and tiles for visitors, the API for what files cannot answer, and above all capture and load, which must never be starved by visitors (catalogue gap item 9). P9b built the API's own limits (per-client token buckets, a DB semaphore, the LRU with single flight). P12a measures them with k6 and decides what to change. The rule of the plan: change only what k6 shows, and record the values kept.

## Decision

### 1. Connections (kept, now guarded)

| Role | `CONNECTION LIMIT` (`deploy/postgres/roles.sql`) | Pool in the service |
|---|---:|---:|
| `rws_api` | 12 | 10 |
| `rws_load` | 6 | – |
| `rws_publish` | 6 | 3 |
| `rws_owner_api` | 4 | 2 + 2 |
| `rws_migrator` | 3 | – |
| `rws_backup` | 2 | – |

`max_connections` stays 40 (`deploy/compose.yaml`, db). The rule `rws_api ≤ max_connections − (rws_load + rws_publish + rws_owner_api) − 5` (12 ≤ 40 − 16 − 5 = 19) is now checked by the read-only guard migration `20261109000001_connection_budget_guard.sql` and by `roles.int.test.ts`; `roles.sql` stays authoritative because `rws_migrator` cannot `ALTER ROLE` (PHASES §42, D-1). The API and the loader share no pool and no role. `rws_api`'s `statement_timeout` stays 2 s.

**Evidence.** In the saturation runs the API held at most its 10 pooled connections (`saturation-db.log`, `pg_stat_activity` every 10 s) while `rws_load` kept its own; no run saw a connection refused (53300).

### 2. CPU and memory (kept)

The `cpus` caps are unchanged: caddy 1.0 and api 1.0 (2.0 of the 4 vCPU), capture 2.0, db 2.0, load 1.0, publish 1.0, the owner services 0.5 each. The caps are maxima, not reservations: api and caddy together can never take more than half the host, so capture, load and db always keep two cores. `cpu_shares` were planned "if k6 shows a need"; it did not, so none are set. Memory limits are unchanged and sum to about 6.2 GB of the 8 GB host for the long-running services, plus one 512 MB job at a time.

**Evidence.**
- *Normal* (15 min, 6 × 50 r/s static + 6 × 5 r/s API): static p95 1.4 ms, API p95 5.9 ms, 0 failures, 0 dropped, 0 × 429; loader lag p95 12.4 s.
- *Abusive* (A/B/A/B and a header-rotating window, 2 min each; one client at 300 r/s of heavy routes): the others' p95 moved +1.3 ms (static) and −2.6 ms (API) against an allowance of max(10 %, 5 ms) (`compare-p95.mjs`, KG-304); the abuser got at least half 429.
- *Flood drill* (12 min of visitor sessions during the drill): p95 4.5 ms, 33,970 requests per client, 0 failed, lag p95 11.5 s.
- *Saturation* (a crowd of 126 addresses, 6 × 126 r/s of cache-missing heavy calls, each address inside its limiter buckets): see §5.

### 3. Brownout (new)

`/srv/rws/brownout/{mode,active}`, `rws-brownout on|off|auto|status|evaluate`, a timer every 15 s. In `auto` it arms when 5xx on `/api/v1/*` exceed 2 % over 5 minutes with at least 200 requests (its own `X-Brownout` refusals excluded) and disarms after 10 minutes under 0.5 % (PHASES §42, D-2, D-3; `docs/runbooks/brownout.md`). While on: `/series` spans over 30 days are a 400, `res=raw` a 503 `brownout`, auto-resolution skips raw, mutable API and static TTLs are longer (never immutable), `meta.json` says `brownout: true` and the web shows its banner. The owner side ignores it. **Evidence:** `brownout-e2e.sh` arms it from the real access log of a stopped api with the real timer, and sees meta.json and Caddy follow.

### 4. The owner listener and the public catch-all (new)

The owner site is published only on `10.66.0.1:443` from its own bridge `rws-owner-pub`, and only with `RWS_OWNER_SITE=on` and wg0 up. `nftables.conf` drops anything to 10.66.0.1 that arrives on neither wg0 nor lo, in a prerouting chain at priority −150, ahead of Docker's DNAT. The one exception is the reply direction of a tracked connection: a host connection to the site has 10.66.0.1 as its source, so caddy-owner's replies come back on its bridge (found by the deploy job's `isolation.sh`). The public Caddy answers every unknown host with a 421 (`:80, :443` catch-all), so SNI `owner.<domain>` on the public address gets no owner content. **Evidence:** `isolation.sh` (ci.yml deploy job): the site answers from the peer namespace and from the host, 10.66.0.1 times out from outside, and the public listener's answers for the owner name on IPv4 and IPv6.

### 5. Saturation, and what bounds the edge

A crowd saturates the API through the limiter (six honest addresses cannot: the first runs got 429s and 2 ms answers, PHASES §42, D-9). **Evidence** (loadtest run 38088598190, 3 minutes, at most 2 × the rate in flight): per process about 14,800 requests, 99 % of them answered after more than a second or with a 503 or 504 (heavy-route p95 about 5 s), none refused as 429, 0.2 to 0.3 % failed; api and caddy each ran at their 1.0 CPU cap (101 % and 99.9 %), db peaked at 81 %, the API held at most its 10 pooled connections, and load still reached 86 % CPU when it had work. Every health sample answered (18 of 18 per process) and the **loader lag p95 was 11.1 s**, under the 120 s of the criterion: ingestion is not starved while the API is. The first crowd run also showed the limit of the edge: k6's open model grew to about 7,600 concurrent TLS connections, Caddy sat at its 256 MiB, requests waited up to 60 s and the API fell idle, while the loader's lag stayed at 12.7 s. Caddy's memory, not the request rate, bounds a crowd that holds many connections. No production limit was changed for it in P12a (KG-313): raising `mem_limit` to 512m with `GOMEMLIMIT`, or a per-source connection limit in nftables, needs a run that proves it, and the CDN break-glass (`docs/runbooks/cdn-break-glass.md`) is the answer during a flood.

## Not changed, and why

- **nofile, somaxconn, sysctls, compose `ulimits`:** no run hit a file or backlog limit; nothing speculative was added.
- **Caddy limits (timeouts, `max_conns`):** see §5 and KG-313.
- **Publisher cadence:** one cycle a minute held during the drill and the normal run (lag p95 under 13 s everywhere); unchanged.
- **The API's own limits (P9b):** the abusive runs show the per-client buckets hold; unchanged.

## Consequences

- A change of a role's connection limit or of `max_connections` that breaks the budget fails CI (`roles.int.test.ts`, the standing guard). The guard migration checks the budget once, when a database first applies it: a later `roles.sql` edit is caught by CI, not by `migrate` (review CR-5). Its margin of 5 covers PostgreSQL's 3 `superuser_reserved_connections`. The owner re-runs `bootstrap.sh` after a release that changes `roles.sql`.
- **What the lag evidence does and does not show** (review CR-6). The loader lag in `/api/v1/health` is the p95 over the last hour of loaded lines, and the fake upstream feeds five specs, so the k6 runs prove that a saturated API and Caddy take no CPU or connections from the loader, not that the loader keeps up with a burst of payloads; the flood drill's replay of its fixtures during the k6 flood scenario is the nearest to that (lag p95 11.5 s).
- The brownout is a host file and a timer: bootstrap installs them (mode `auto`).
- The k6 jobs run on every PR that touches `apps/server/**`, `packages/contracts/**`, `deploy/**` or the workflow, so a regression of the shape above fails CI.
