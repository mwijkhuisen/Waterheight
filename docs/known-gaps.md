# Known gaps

This document lists, in one place, what each PR says is not done, not verified or left open. Rated risks stay in `docs/risk-register.md` (R-xxx) and threats in `docs/threat-model.md` (T-xxx); a row here points to them instead of repeating them. When a gap closes, set its status to "closed in #N" (or give the date and link) and keep the row.

Status is one of: **open**, **closed in #N**, or **accepted**, meaning a residual we keep on purpose, with the reason.

## P1a Recorder (PR #34, issue #16)

### Needs the owner or the VPS (P1b)

| ID | Area | Gap | What closes it / who | Status |
|---|---|---|---|---|
| KG-001 | deploy | `capture` refuses to start (exit 78) until `RWS_DOMAIN` and `RWS_CONTACT_EMAIL` are set, so nothing is recorded until then. The first perishable data is due by 2026-10-02. | The owner sets both on the VPS (A2); P1b deploys | open |
| KG-002 | deploy | Every provider host has not been checked as reachable from the VPS over IPv4 and IPv6 (Cloudflare at AGE). | P1b `rws-reachability` | open |
| KG-003 | deploy | Not yet verified inside the image: the heartbeat and healthcheck in distroless, uid-65532 file modes on the mounts, and the layout (`registry/` next to `apps/server/dist`, posted in #16). | P1b image and deploy | open |
| KG-004 | CI / prod | The [agent-prod] criteria have no `verify-prod.sh` output yet. | P1b owns `verify-prod.sh`; run after deploy | open |
| KG-005 | alerting | The phone-alert check needs `deploy/healthchecks.yaml` with the 9 `cap-*` group timeouts (#16 comment). | P1b | open |

### Never called live, or only partly

| ID | Area | Gap | What closes it / who | Status |
|---|---|---|---|---|
| KG-006 | data source | The RWS `X-API-KEY` header (secret `rws_x_api_key`) was never sent live. | The first production run of NL-1 | open |
| KG-007 | alerting | `hc-ping.com` pings were never sent live. | The first production run, with `hc_ping_key` set | open |
| KG-008 | data source | The full §0.1b harvest never ran: the volume and duration of the LU-5 and FR-1 seeds are unknown. | The first production start (see `seed-report.json`) | open |
| KG-009 | data source | Only the first variant of each spec was fetched live. Not fetched: the FR-4 Q list, the CH-1 lake query, the BE-3 discharge group and its time-series lists, the 6-week BfG files (one checked), and the other 38 LU-2 files (names taken from the 40 LU-4 pages). | The first production run; watch the daily report for `invalid` | open |
| KG-010 | data source | `fr-5-ref`: only `TerEntVigiCru.json` was recorded. `StaEntVigiCru.json` is assumed to share the root key `ListEntVigiCru`; if it doesn't, a daily `invalid` alert is raised and the body is still archived. | The next smoke recording or the first daily report | open |

### Known behaviour limits

| ID | Area | Gap | What closes it / who | Status |
|---|---|---|---|---|
| KG-011 | capture | LU-5 after a long outage: a catch-up that hits `max_expand` (40) can leave older dumps unfetched, behind list pages already seen. The run is marked `capped` and logged, but nothing re-fetches them (review C6, one case left). | A persisted pending walk for LU-5 | open |
| KG-012 | capture | The FR-1 seed and the scheduled FR-1 run share the variant `default`: a concurrent seed persist can reset a gap walk's progress. The effect is re-fetching, never lost data. | Separate state for seed and schedule | accepted: re-fetch only |
| KG-013 | status | A stalled FR-1 gap walk (capped with no progress) leaves the spec stale and pages, but sets no `last_failure_status`, so the status shows "stale" without a reason. | A `walk_stalled` code in the existing field | open |
| KG-014 | alerting | Only staleness and the NL-4 file alerts page. Shape changes, invalid payloads, LU-4 threshold changes and seeds incomplete after 31 days reach only the daily report and the log; `seed_incomplete` is raised again on every start after that. | R-026 | accepted |
| KG-015 | security | After an unexpected error, capture keeps running and so does the heartbeat, so a wedged recorder shows only through healthchecks staleness. | T-CAP-8; consider exiting on `uncaughtException` later | accepted |
| KG-016 | security | A network-specific NAT64 prefix inside `2000::/3` (under DNS64) is not refused by the client. | T-CAP-1; P1b nftables egress rules | accepted: relies on P1b |
| KG-017 | security | Validity parsing of a large valid JSON or CSV body runs synchronously, bounded only by `max_bytes`. The optional S3 extras were not built: a streaming DOCTYPE scan per chunk, and a smaller ZIP total for XLSX. | R-023, T-CAP-8 | accepted |
| KG-018 | http | A request's hops share 2 × the timeout of wire time. This bound is not clamped to the caller's deadline, and each DNS check keeps its own per-hop deadline (review N6). | A one-line clamp with a floor of one timeout, if needed | accepted |
| KG-019 | security | The owner canary (777777.777) cannot be checked yet, because nothing publishes. | P9 (publisher) | open |

### Decided

| ID | Area | Gap | What closes it / who | Status |
|---|---|---|---|---|
| KG-020 | data source | The DE-6 alerts list may be empty (`min: 0`); the checklist allowed that for FR-4 only (review C10). | Owner OK, 2026-09-29: https://github.com/mwijkhuisen/Waterheight/issues/16#issuecomment-5894422289 | closed |

## P0b Foundation (PR #32, issue #15)

These come from the PR's "[U] items not verified" list.

| ID | Area | Gap | What closes it / who | Status |
|---|---|---|---|---|
| KG-021 | dev env | A real claude.ai/code session has never run the SessionStart hook; it was proven only on an ubuntu-24.04 runner (CI `hook` job). | The owner opens a claude.ai/code session | open |
| KG-022 | security | The force-push deny patterns in `.claude/settings.json` are unverified: they refused live, but the harness may refuse on its own. | The B1 ruleset is the real control | open |
| KG-023 | CI | Dependabot support for the pnpm 12 lockfile, and its first run (R-010). | #33 (2026-09-29): Dependabot updated `pnpm-lock.yaml`, the install worked and `integration` passed | closed in #33 |
| KG-024 | CI | TypeScript 7 cannot be adopted: `check-boundaries` uses the compiler API (`createSourceFile`), which TS 7 lacks, so `tsc -b` failed on #33. The owner told Dependabot to ignore 7.x. | Move `check-boundaries` off the TS compiler API before any TS 7 upgrade | open |
| KG-025 | security | The applied GitHub settings (rulesets B1/B2) are unverified. | The owner runs `scripts/gh-settings.sh` and checks | open |
| KG-026 | data | The station names in the sample are not confirmed to match exactly how each agency publishes them (R-014). | The owner checks against the agencies' catalogues | open |
| KG-027 | build | Arm64: the hook and `install-pnpm.sh` pin arm64 checksums, but only x64 was exercised. | A run on an arm64 machine or runner | open |

## Planning docs (PR #30)

| ID | Area | Gap | What closes it / who | Status |
|---|---|---|---|---|
| KG-028 | CI | The GitHub Actions minutes had run out, so the legacy `build-and-test` check never got a runner. | CI runs again: the checks on #31–#34 ran | closed |

## Legacy app, before the reset (PRs #1–#12)

P0a (#31, ADR-0001) removed all legacy code; it is archived as the tag `legacy-v0`. The gaps these PRs recorded concern code that no longer exists, so they are listed only for the record. Per `CLAUDE.md`, legacy files are never opened or restored.

| ID | PR | Gap | Status |
|---|---|---|---|
| KG-029 | #1 | The Docker image and docker-compose were never run. | closed: superseded by #31 |
| KG-030 | #1 | The full backfill (~190 million rows) was never run at scale. | closed: superseded by #31 |
| KG-031 | #3 | A real `docker build` of the trimmed context was never run. | closed in #4 |
| KG-032 | #4 | A real `docker build` was left to CI. | closed: superseded by #31 |
| KG-033 | #6, #7 | The PGDG PostgreSQL install was verified on Ubuntu 24.04 only, not 22.04 or 25.04. | closed: superseded by #31 |
| KG-034 | #9 | The errno match for AF_NETLINK was not proven with an `LD_PRELOAD` interposition test. | closed: superseded by #31 |
| KG-035 | #12 | The Docker image and docker-compose with the OpenStreetMap basemap were never run. | closed: superseded by #31 |

PRs with no recorded gaps: #2, #5, #8, #10, #11, #31 and #33 (Dependabot, not merged).
