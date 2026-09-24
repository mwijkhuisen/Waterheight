# Judgement: choosing the implementation plan

Judged 2026-09-23. Inputs:
- the three proposals `plan/proposals/{data-first,secure-ops,skeleton}.md`, each read in full;
- `plan/SOURCE-CATALOGUE.md` (final version, 278 KB);
- the raw reports in `research/`, used where the catalogue defers to them.

Catalogue sections are cited as §x.y and source IDs as NL-1, DE-7 and so on.

---

## 1. Verdict

**Winner: data-first**, with 55/70. It is the only proposal that starts with how perishable each source's data is (§0.1). It starts capturing every perishable feed on the earliest date, and its capture code does not depend on anything else. It is also the most carefully grounded in the provider research. Its weaknesses are fixable:
- a heavier stack than needed (TimescaleDB, Python, testcontainers, 15+ workspace packages);
- a few licence and sizing errors against the catalogue;
- a UI that only appears in mid-November.

**secure-ops (51)** has the best security and operations design. It is too heavy for one person running one VPS, and hardening work sits on the critical path to ingestion.

**skeleton (50)** has the simplest stack and the best integration-risk idea, a walking skeleton. Its production capture has gaps for perishable forecasts, and "see the water flow", the core promise, comes last, after the public launch.

The final plan should be data-first's structure and data discipline, running on skeleton's stack, with secure-ops's security invariants and operations gates added.

---

## 2. Scorecard (1–10)

| # | Criterion | data-first | secure-ops | skeleton |
|---|---|---|---|---|
| 1 | Fit to the requirements | **8** | **8** | 7 |
| 2 | Data-source realism (vs the catalogue) | **8** | **8** | 7 |
| 3 | Time to production ingestion | **9** | 7 | 6 |
| 4 | Simplicity for a solo owner on one VPS | 6 | 5 | **9** |
| 5 | Security and operations | 8 | **9** | 7 |
| 6 | Phase decomposition for Claude Code agents | **8** | 6 | 7 |
| 7 | Model and effort allocation | **8** | **8** | 7 |
| | **Total (of 70)** | **55** | **51** | **50** |

### Why each score

**1. Fit to the requirements**
- *data-first (8):* Every requirement is traced to a phase (§D table). Flow visualisation (P9) ships before launch. Weakness: public launch is mid-December, which is inside the Rhine/Meuse flood season. The UI only starts on 11-16.
- *secure-ops (8):* Everything is covered, and flow (P8) ships before launch on 12-07.
- *skeleton (7):* A visible product exists by 10-14, which is good. But the river network (P9) and "see the water flowing" (P10, 12-18) come after the public beta on 11-25, although the owner treats that feature as core to the first release.

**2. Data-source realism**
- *data-first (8):* This is the richest grounding. Examples:
  - twin checks: Perl, Chooz, Eijsden 233 cm, Maaseik 2.33 m;
  - daily detection of the 15-minute label shift in the LU CSV;
  - BfG `---` values above 640 cm;
  - the `WV` "estimate" segment after 48 h;
  - Vigicrues `+02:00` vs `+00:00` offsets;
  - AGE forecast floors;
  - KiWIS tidal series that return nulls;
  - exceedance vs non-exceedance percentile conventions.

  It has four errors against the catalogue, listed in §5.2.
- *secure-ops (8):* Equally careful. It pins the real `a4106b8` HEAD, uses `pegeldaten.zip` for the 2-month NRW refill, and correctly keeps NLWKN off until permission. Its one error is LHP polled every 15 min. It also refills 30 days of RWS, which is harmless but pointless because RWS keeps decades.
- *skeleton (7):* Accurate, and it gets the LHP 10-minute refresh rule right. But its "insurance capture" leaves out the forecasts that §0.1 marks as lost if not snapshotted:
  - RWS `verwachting` is not captured until P4 (10-15 → 10-22);
  - Vigicrues forecasts wait for P4;
  - 44 of the 55 BAFU `q_forecast` stations wait for P5 (up to 11-01).

  It also takes Konstanz and Basel from PEGELONLINE, but those are third-party mirrors; the DE-1 risks say to take them from the original source. And it builds NLWKN while that source is still unlicensed (§5.2).

**3. Time to production ingestion**
- *data-first (9):* A capture-only "flight recorder" with no database dependency is targeted for ≤ 10-02. It covers every perishable public feed: forecasts, classes, warnings and threshold snapshots. It also seeds each provider's rolling window on first start.
- *secure-ops (7):* P2a (also 10-02) captures nearly the same set, but:
  - capture writes provenance to the database in one transaction per batch, so capture stops when the database is down;
  - it must wait for P1, whose acceptance criteria include `lynis`, `testssl`, userns-remap and a timed rebuild on a second VPS;
  - every deployable phase waits for a 24 h soak.

  A realistic go-live is about 10-06 to 10-09.
- *skeleton (6):* The data epoch is 10-05, and it depends on a large Fable-built P2 (full spine plus framework plus PEGELONLINE plus insurance capture plus contract check). Perishable forecasts are missing for 2–4 weeks after that.

**4. Simplicity for a solo owner**
- *data-first (6):*
  - TypeScript plus Python (river network), with TimescaleDB and its TSL extension;
  - capture, load, publish, api, twin-check and backup containers;
  - more than 15 workspace packages;
  - testcontainers, which needs Docker (usually missing in agent sandboxes);
  - a raw archive kept forever.
- *secure-ops (5):*
  - two toolchains (Go and TypeScript);
  - userns-remap and per-subnet nftables egress rules;
  - Object Lock with pruning from a workstation;
  - VictoriaMetrics and Grafana;
  - a staging VPS for k6;
  - quarterly timed rebuilds, game days and a soak on every phase.

  This is a lot of machinery for one person.
- *skeleton (9):*
  - one language;
  - two packages;
  - plain PostgreSQL with no extensions;
  - four containers plus migrate;
  - no queue and no metrics stack.

**5. Security and operations**
- *data-first (8):*
  - an SSRF-hardened client;
  - capture holds no database credentials;
  - internal networks;
  - cosign verification;
  - a "dark data" canary leak test;
  - a CSP without `unsafe-inline`;
  - a monthly restore drill.

  Weakness: the forced-command SSH deploy key means GitHub holds a server credential.
- *secure-ops (9):*
  - threat model, security invariants and fuzzing;
  - pull-based, human-triggered deploys, so GitHub holds no server credential;
  - Object Lock backups;
  - two-layer egress control;
  - load shedding and a same-origin-only browser policy.

  It over-reaches in places.
- *skeleton (7):* Solid basics: signed pull-based CD with automatic rollback, an egress guard, a CSP test and `verify-prod.sh`. It is thinner on fuzzing, egress control and the threat model.

**6. Phase decomposition**
- *data-first (8):* The phases are coherent and the acceptance criteria are testable: replay checksums, golden fixtures, twins, the canary test, and a classification document generated from code. But P2 (spine plus Timescale plus registry plus loader plus two adapters) and P8 (the whole web app) are more than one reviewable PR each.
- *secure-ops (6):*
  - P3 ("normalise every captured source": seven parsers, a five-country registry, xref, QC, rollups, forecast runs and contract checks) is far too big for one PR.
  - P1 and P0 contain criteria only the owner can satisfy: screenshots, a second VPS, a test push.

  On the other hand, its review-focus bullets and PR evidence checklists are excellent.
- *skeleton (7):* The walking skeleton de-risks integration early. But P2 is large, P5 packs seven adapters into one Sonnet build, and P7 mixes domain logic with UI.

**7. Model and effort allocation**
- *data-first (8):*
  - Fable 5.1 on 7 of 39 steps, placed at the points where a mistake is irreversible: recorder code review, spine build, classification and forecast reviews, API and launch security reviews, and the backfill review.
  - Reviews always use a different model from the build, with the one exception explained.
  - Haiku 4.5 is deliberately unused.
- *secure-ops (8):* Also well argued, with Fable on 8 of 36 steps and two `max` security reviews on small diffs. Sonnet builds the gated-credential phase and the backfill, which is slightly risky.
- *skeleton (7):* Sensible overall. Sonnet builds P5 (the LU DST and offset traps) and P6 (OAuth and credit budgets), and cheaper builders are compensated by Opus reviews.

---

## 3. Per-proposal notes

### data-first (winner)

**Keep:**
- the P1 flight recorder: capture only, no database, content-addressed zstd, a manifest, shape fingerprints, and write-tmp-then-rename;
- the "raw archive is the source of truth, the database is a replayable projection" rule;
- seed captures of each provider's rolling window;
- twin checks as live integration tests;
- the `publication: public|dark|off` flag enforced by database views plus the canary leak test;
- the classification document generated from the same mapping table as the code;
- bi-temporal forecast runs keyed by (series, first valid time, content hash);
- static-first publishing with `recent`/`settled` cache classes;
- the blob-level check that nothing from `legacy-v0` returns;
- owner decisions D1–D7.

**Change:**
- the stack weight (§4);
- the licence and sizing errors (§5.2);
- the size of P2 and P8;
- the late UI.

### secure-ops

**Graft:** the security invariants, the gate model and the operations specifics (§4.2).

**Reject:**
- the Go backend: it adds a second toolchain, and the catalogue's stack recommendation (§7.8) makes TypeScript the default, with supply-chain risk handled by pnpm policy;
- per-phase 24 h soaks as a blocker for starting the next phase;
- the staging VPS;
- the P1 timed rebuild on a second VPS, which belongs in P10;
- quarterly game days, until after launch.

### skeleton

**Graft:**
- the stack minimalism;
- the thin end-to-end slice;
- the "data epoch plus 30-day clock" framing, which explains why most observation feeds tolerate some delay but forecasts do not;
- `data_version` cache-busting for immutable past buckets;
- the Caddy `handle_errors` fallback to the static latest snapshot;
- `verify-prod.sh`;
- the outage drill (stop ingest for 2 h, then check for 0 missing buckets).

**Reject:**
- deferring RWS, Vigicrues and most BAFU forecast capture;
- putting the river network after launch.

---

## 4. Grafts onto data-first (concrete)

### 4.1 From skeleton

1. **Plain PostgreSQL 18.6, no TimescaleDB, for the first release.**
   - Why (§6.1, §6.2, §8 C16): measured 16–20 ms for "all series at T"; about 23 GB/yr in the worst case; "compression is an optimisation, not a requirement, for the first 2–3 years".
   - Use native monthly partitions, BRIN on `ts`, and incremental `obs_1h`/`obs_1d` in the loader transaction (§6.4 query 3) plus a nightly reconciliation.
   - This removes the TSL licence, the `ALTER EXTENSION` step on every image bump, and the special restore procedure. It also makes the SessionStart hook trivial.
   - Revisit in the backfill phase at about 50 GB.
2. **One language.**
   - Build the river graph with `osmium export` plus TypeScript (skeleton P9); drop the Python/uv toolchain.
   - Collapse the workspace to `apps/server` (one image; roles `capture | load | publish | api | replay`) and `apps/web`, plus at most `packages/{core,contracts}`.
   - Adapters become folders under `apps/server/src/adapters/<id>/`, with the import-boundary check kept as a CI script.
3. **No testcontainers.** Tests use a real PostgreSQL 18 started by the SessionStart hook in agent sessions and a digest-pinned service container in CI.
4. **Walking-skeleton slice**, as a new web-lane phase right after P2:
   - minimal API (`/meta`, `/stations`, `/snapshot?t=`, `/series`);
   - MapLibre map, time slider, NL/EN;
   - deployed `noindex`.

   Target about 10-20. This brings forward the integration risks: LOCF semantics, cache headers, MapLibre 6 CSP, WebKit and the Temporal polyfill. It also gives the owner a product to look at while data accumulates.
5. **`data_version` in snapshot, frame and series URLs**, so past buckets can be `immutable`. Add Caddy `handle_errors 502 503 504` falling back to the static `latest.json` with a "degraded" banner.
6. **`scripts/verify-prod.sh <domain>`** so agents verify production from outside, without SSH. Add an outage-drill acceptance criterion to the loader phase.
7. **LHP refreshed at least every 10 minutes for display** (see §5.1).

### 4.2 From secure-ops

1. **Security invariants in CLAUDE.md**, quoted in every build and review prompt:
   - fetch targets come only from config;
   - the API is read-only;
   - provider strings are untrusted and never reach an HTML sink (ECharts `richText` tooltips);
   - UTC everywhere;
   - an ADR line for every new dependency;
   - no secrets in logs or archive metadata;
   - no third-party browser requests;
   - only displayable sources leave the database;
   - every parser has fixtures and a property or fuzz test.

   Also add `docs/threat-model.md`, updated whenever a phase changes the attack surface.
2. **Pull-based, human-approved deploys.**
   - The VPS pulls the release manifest, runs `cosign verify` with the identity pinned to `release.yml`, runs migrate, `up -d` and a smoke test, and rolls back automatically on failure.
   - GitHub holds no server credential.
   - This replaces data-first's forced-command SSH key.
3. **Off-site backups the VPS cannot delete**: an Object Lock bucket, with pruning keys only on the owner's workstation.
4. **Two-layer egress control.** The dialer allowlist plus nftables rules that limit each Docker subnet to TCP 443 and DNS. `api` and `publish` get no internet egress.
5. **API load shedding.**
   - A global DB-concurrency semaphore returns 503 with `Retry-After`.
   - `singleflight` collapses identical requests.
   - Unknown query parameters return 400, which keeps the cache-key space closed.
   - Static files are never rate-limited, so visitors behind carrier-grade NAT are not locked out.
6. **No third-party requests from the browser in production**, asserted by a Playwright same-origin test. OpenFreeMap is for development only; keep the previous PMTiles version for rollback instead. This replaces the runtime OpenFreeMap fallback that data-first and skeleton propose.
7. **Per-phase gate additions:**
   - an acceptance-evidence checklist in the PR;
   - phase-specific "review focus" bullets in both review prompts;
   - CODEOWNERS for the owner on `.github/`, `infra/`, `db/migrations/` and `registry/`;
   - an owner-run `gh api` settings script.
8. **Operations details:**
   - PostgreSQL initialised with the builtin `C.UTF-8` locale provider;
   - a watchdog probing the site's own public URL through real DNS and TLS;
   - a public `/status` (data-sources) page;
   - IP-masked access logs kept 14 days;
   - a brownout flag and a documented CDN break-glass runbook (not enabled).
9. **Raw-retention policy (§6.5):**
   - observation payloads are kept hot for 90 days after a successful parse;
   - forecast, threshold, class, warning and metadata payloads are kept forever.

---

## 5. Mistakes the final plan must fix

### 5.1 Common to all three

1. **Phases too big for one reviewable PR.** Each proposal has at least one:
   - data-first: P2 and P8;
   - secure-ops: P3 and P4;
   - skeleton: P2, P5 and P7.

   **Fix:** one issue may carry 2–3 PRs (a/b/c), each with its own build → review → security run. Cap a PR at one subsystem, or at most three provider adapters.
2. **Acceptance criteria mix CI-provable and owner-only checks.** Examples: 72 h production soaks, second-VPS rebuilds, screenshots, "the owner sent the emails". **Fix:** tag every criterion `[CI]`, `[agent-prod]` (checkable through `verify-prod.sh` or the public health endpoint) or `[owner]`. The build agent is only accountable for `[CI]` and `[agent-prod]`.
3. **Agent-sandbox limits are not planned for.**
   - Direct Geofabrik downloads and Overpass were unreachable from the research sandbox (research/map-rivers.md:342).
   - Docker is usually unavailable, which rules out testcontainers.

   **Fix:** run the river-graph and basemap builds as a GitHub Actions workflow or a VPS job, with the outputs released or committed. Agents develop against a small committed PBF fixture.
4. **Unverified map compatibility is left too late.** `@protomaps/basemaps` 5.7.2 with v4 tiles, and MapLibre 6's CSP after the CSP bundle was removed (§5.1, §8 C23), are both unverified, and each proposal only checks them inside a large late phase. **Fix:** make a one-day spike in the geo lane before any web phase: extract, style and render under the strict CSP, then record the result in an ADR.
5. **Source catalogue IDs are not used.** None of the proposals keys its registry, adapters or issues by the catalogue's source IDs (NL-1 … CH-11). **Fix:**
   - P0 copies `SOURCE-CATALOGUE.md` into `docs/sources/`;
   - the adapter IDs, `providers.yaml` and every build prompt cite those IDs;
   - tier-1 station lists come from §3.
6. **The forecast horizon is hard-coded.** data-first and skeleton set the slider to +48 h. Provider horizons are RWS ~34 h, `WV` 96 h (48–96 h labelled "estimate"), BAFU ~115 h, LU ~45 h, HIC 60 h / 10 days, and Vigicrues ~21 h, event-only (§9 Q6). **Fix:** make it an explicit owner decision. Recommended default: a per-station horizon, with the slider capped at +48 h and "estimate" styling beyond each provider's own forecast segment.
7. **RWS request budget.** `OphalenWaarnemingen` takes one location per request (§2.1). Polling 60–80 stations × {H, Q} every 10 min is 100–160 POSTs per 10 min, about 20k per day. The API is young, has no SLA and has had outages. RWS observations are recoverable for decades, so 10-minute REST polling is a freshness choice, not a data-loss one. **Fix:**
   - a config test that asserts requests per host per hour;
   - 10-minute REST for about 25 key gauges and 30-minute REST (6 h window) for the rest, with the one-call WFS snapshot (NL-2) providing freshness between polls;
   - notify the Servicedesk and send `X-API-KEY`.
8. **Launch date vs flood season.** The winter flood season usually runs December to March. Launches on 12-07 and mid-December are late. **Fix:**
   - a firm public-launch target of **≤ 2026-12-04**;
   - an explicit cut list for flow visualisation, in this order: Hovmöller panel → playback → segment colouring. The animated flow direction plus the upstream-chain panel are the minimum.
9. **The BfG Belegexemplar (free copy) obligation is not a launch gate.** It applies to `WV` (§0.2, DE-2). skeleton and secure-ops display `WV` without scheduling it. **Fix:** add a launch-checklist item: BfG credit shown and the site URL sent to vorhersage@bafg.de before `WV` is displayed.
10. **Pre-go-live seed data.** Seeds (data-first, secure-ops) put data from before go-live on the slider, which touches the "historical data later" requirement. **Fix:** capture the seeds (cheap insurance, same code path), but make displaying pre-go-live data an owner decision. Default: show them, labelled with the epoch.

### 5.2 Errors specific to the winner (data-first) vs the catalogue

1. **NLWKN "dark" capture (D3).** data-first argues that the terms "restrict redistribution and publication, not retrieval". That is wrong: the NLWKN Impressum forbids storing the data "in elektronische Systeme einzuspeichern" (§0.2, DE-9). **Fix:** NLWKN is off until written permission. The NRW Vechte/Dinkel gauges (DE-7) cover the upper reaches meanwhile. skeleton makes the same mistake: it builds and captures NLWKN with only display switched off.
2. **SPW "dark" capture is pointless and legally unclear.** SPW keeps history back to 1969 (§0.1), and whether SPW allows server-side polling is an open question (§9 Q23). **Fix:** SPW is off until permission; its history is recovered later.
3. **NL-3 waterinfo internal JSON is captured and used as `class_obs`.** The catalogue marks it "Not recommended (inspiration for colour classes only)" (§1b). **Fix:** drop it from capture. The NL classes come from the NL-4 threshold workbook.
4. **LHP is polled every 15 minutes.** The terms require a refresh at least every 10 minutes when republishing (DE-6). secure-ops has the same mistake.
5. **Raw-archive size is understated.** data-first says "hot raw archive about 5 GB" and keeps everything forever. In practice:
   - NRW `messwerte.zip` alone (909 KB × 96 per day, and a zip barely compresses further) is about 32 GB/yr;
   - Hub'Eau's 3 h window polled every 15 min re-captures each value about 12 times;
   - PEGELONLINE snapshots are about 6 GB/yr gzipped at a 5-minute cadence (§6.5).

   **Fix:**
   - apply the retention policy in §4.2 item 9;
   - capture NRW raw hourly, since its 7-day window heals any gap;
   - use delta windows for Hub'Eau;
   - measure bytes per day per source during the P1 soak and alert on a size budget.
6. **Payload validity is not checked at capture time.** Capture without parsers cannot notice a malformed or wrong query that returns empty-but-200, and the first shape fingerprint simply becomes the baseline. **Fix:** give each `CaptureSpec` a cheap validity assertion (the payload parses as JSON, CSV or ZIP; required top-level keys are present; the feature or row count is above a minimum), with an alert when it fails. Add a nightly live contract check once the parsers exist.

---

## 6. Recommended phase list for the final plan

All dates are indicative except P1. Three lanes run in parallel after P2: **data**, **geo** and **web**. The "Build · Code review · Security review" column gives model and effort for each prompt.

| # | Phase | Window | Build · Code review · Security review |
|---|---|---|---|
| P0 | Reset and foundation: `legacy-v0` tag plus a blob check; pnpm scaffold; CI/security workflows; CLAUDE.md with bill of materials and invariants; SessionStart hook with native PG 18; catalogue copied in; ADRs; permission e-mails drafted | 09-24→09-26 | Opus xhigh · Sonnet `/code-review high` · **Fable high** (CI root of trust, small diff) |
| P1 | **Flight recorder in production.** Capture only; polite SSRF-hardened client; archive, manifest and validity assertions; seeds; VPS bootstrap; pull-based signed deploy; Object Lock backups; per-provider dead-man switches. If needed, split into P1a (recorder live) and P1b (CD hardening). **Live ≤ 10-02.** | 09-26→10-02 | Opus xhigh · **Fable** `/code-review high` · **Fable xhigh** (both are small diffs guarding irreversible loss and the trust chain) |
| P2 | Data spine: plain PG 18; core time, unit and datum handling; registry; loader; replay. Split into P2a (spine + PEGELONLINE DE-1/DE-2 metadata) and P2b (RWS NL-1/NL-2/NL-4) | 10-03→10-16 | **Fable xhigh** `/plan` · Opus `/code-review max` · Sonnet xhigh |
| P3 | Walking skeleton: minimal API + map + slider, NL/EN, `noindex` (web lane) | 10-14→10-23 | Opus xhigh · Sonnet `/code-review xhigh` · Opus high (first public surface) |
| P4 | Open adapters, in two PRs: (a) FR-1/FR-3/FR-5 and CH-1..CH-5; (b) DE-7, LU-1, LU-5, DE-6. Plus twins and deduplication | 10-17→10-30 | Opus xhigh · Sonnet `/code-review xhigh` (Fable high for the LU/DST PR) · Sonnet xhigh |
| P5 | Geo spike, then river network and basemap: pipeline in Actions or on the VPS; ODbL download (geo lane) | spike ~10-08; 10-12→11-06 | Opus xhigh · Sonnet `/code-review high` · Sonnet medium |
| P6 | References, classes, warnings and honest classification (classification document generated from code) | 10-31→11-09 | Opus xhigh `/plan` · **Fable** `/code-review xhigh` · Sonnet high |
| P7 | Official forecasts (bi-temporal) plus the future part of the slider | 11-06→11-13 | Opus xhigh · **Fable** `/code-review high` · Sonnet high |
| P8 | Static publisher plus hardened read API: load shedding, `data_version`, dark-leak canary test | 11-02→11-16 | Opus xhigh · Sonnet `/code-review xhigh` · **Fable xhigh** |
| P9 | Web app MVP: modes, station detail, legend, table fallback, pages. Split into UI-core and pages PRs | 11-10→11-25 | Opus xhigh `/plan` · Sonnet `/code-review xhigh` · Sonnet xhigh |
| P10 | Follow the water, with the cut list from §5.1 item 8 | 11-20→11-30 | Opus xhigh · Sonnet `/code-review xhigh` · Sonnet medium |
| P11 | Flood hardening, operations and **public launch ≤ 12-04** | 11-26→12-04 | Opus xhigh · **Fable** `/code-review high` (cache and versioning) · **Fable max** |
| P12 | Gated sources, one PR per source as each permission arrives: VMM, HIC, SPW, AGE JSON/forecasts/thresholds, NLWKN, BfG CSV | on permission | Opus high · Sonnet `/code-review xhigh` · Opus xhigh (first third-party credentials) |
| P13 | **LATER:** historical backfill and climatology | 2027 | Opus xhigh · **Fable** `/code-review high` · Sonnet high |

The Fable steps (11 of 42) are the ones where a miss is irreversible or public-facing. Haiku 4.5 stays unused in phase prompts. Opus's default effort is medium, so every prompt must set `/effort` explicitly.

---

## 7. Owner decisions to carry forward

Carry forward data-first's D1–D7, with these changes:
- **D3 is revised:** no dark capture for NLWKN or SPW.
- **New decisions:**
  - forecast horizon per station vs global (§5.1 item 6);
  - whether seeded pre-go-live data is displayed (§5.1 item 10);
  - default map mode: class vs Δh (§9 Q7);
  - slider step: 10 vs 15 min (§9 Q9);
  - how tidal and impounded reaches are presented (§9 Q4–Q5);
  - the Object Lock bucket provider.
- **Day-1 owner actions (all proposals agree):**
  - order the VPS and domain;
  - create the contact mailbox;
  - create the healthchecks.io account;
  - create the off-site bucket;
  - send the permission e-mails: HIC, VMM, SPW, AGE, NLWKN, BfG (Belegexemplar), plus courtesy notices to the RWS Servicedesk, ITZBund and BAFU.
