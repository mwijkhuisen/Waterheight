# Phases: implementation plan

**Status:** final plan, 2026-09-23. It goes with `ARCHITECTURE.md`, which is cited as A§x. Catalogue sections are cited as §x.y, and source IDs (NL-1 … CH-11) are the catalogue's. **Amended 2026-09-23 after the catalogue gap check**; §9 lists every change per gap item and the affected phases. **Amended 2026-09-24 for the owner audience** (decision D22, ADR-0017, catalogue §0.8); §10 lists every change with the affected phases and sections. **Build amendments** (what each build found or settled against this plan): §11 (P1a), §12 (P1b), §13 (P2a), §14 (P2b).

**How the plan is executed:**
- Each phase becomes **one GitHub issue** containing three Claude Code prompts: Build, Code review and Security review.
- A **roadmap issue** links all the phase issues.
- A phase may ship as **2–3 PRs** (a/b/c). Each PR gets its own build → code review → security review cycle.
- **Cap per PR:** one subsystem, or at most three provider adapters.

**Hard dates:**
- **Production ingestion live ≤ 2026-10-02 (P1).**
- **Public launch ≤ 2026-12-04 (P12).**

Every other date is indicative.

---

## 1. Timeline, lanes and dependencies

| # | Phase | Lane | Window (2026) | PRs | Depends on | Build · Code review · Security review |
|---|---|---|---|---|---|---|
| P0 | Reset and foundation | – | 09-24 → 09-26 | a reset · b foundation | – | Opus xhigh · Sonnet `high` · **Fable high** |
| P1 | **Flight recorder in production** | data | 09-26 → **10-02** | a recorder · b platform | P0 | Opus xhigh · **Fable** `high` · **Fable xhigh** |
| P2 | Data spine | data | 10-03 → 10-16 | a spine + DE-1 · b NL-1/NL-2/NL-4 | P1 | **Fable xhigh** · Opus `max` · Sonnet xhigh |
| P3 | Map spike and self-hosted basemap | geo | 10-05 → 10-09 | one PR | P0 (P1b for the VPS) | Opus xhigh · Sonnet `high` · Sonnet xhigh |
| P4 | Walking skeleton (noindex) | web | 10-14 → 10-23 | a API · b web + deploy | P2 (P4a can start on P2a), P3 | Opus xhigh · Sonnet `xhigh` · Opus high |
| P5 | Open observation adapters | data | 10-17 → 10-30 | a FR + CH · b DE-7 + LU + twins · c owner-audience BE-3 + LU-2/3/4 | P2 | Opus xhigh · Sonnet `xhigh` (**Fable** `high` for P5b) · Sonnet xhigh |
| P6 | River network, snapping, chainage | geo | 10-12 → 11-06 | a graph · b snapping + tiles | P2 (P6b: P5) | Opus xhigh · Sonnet `high` · Sonnet medium |
| P7 | References, classes, warnings, honest classification | data | 10-31 → 11-09 | a parsers · b engine | P5 | Opus xhigh · **Fable** `xhigh` · Sonnet high |
| P8 | Official forecasts (bi-temporal) and the future slider | data | 11-06 → 11-13 | a run model + NL/DE (+ LU-3 owner) · b CH/FR + slider | P5 (P7 for display) | Opus xhigh · **Fable** `high` · Sonnet high |
| P9 | Static publisher and hardened read API | serve | 11-02 → 11-16 | a publisher · b API hardening | P7 (P8 contracts can be stubbed) | Opus xhigh · Sonnet `xhigh` · **Fable xhigh** |
| P10 | Web app MVP | web | 11-10 → 11-25 | a UI core · b pages | P9 contracts, P6, P7 | Opus xhigh · Sonnet `xhigh` · Sonnet xhigh |
| P11 | Follow the water | web | 11-20 → 11-30 | a minimum · b colouring + playback · c Hovmöller | P6, P10, P9 frames | Opus xhigh · Sonnet `xhigh` · Sonnet medium |
| P12 | Flood hardening, operations, **public launch** | ops | 11-26 → **12-04** | a hardening · b ops + launch | P9, P10, P11a | Opus xhigh · **Fable** `high` · **Fable max** |
| P13 | Gated sources, one PR per source as each permission arrives | data | on permission | per source | P5/P7/P8 patterns + owner permission | Opus high · Sonnet `xhigh` · Opus xhigh |
| P14 | **LATER:** historical backfill and climatology | data | 2027 | per provider group | launch + 4 weeks stable | Opus xhigh · **Fable** `high` · Sonnet high |

```mermaid
gantt
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Foundation
  P0 Reset and foundation          :p0, 2026-09-24, 2026-09-26
  section Data lane
  P1 Flight recorder live by 10-02 :crit, p1, 2026-09-26, 2026-10-02
  P2 Data spine                    :p2, 2026-10-03, 2026-10-16
  P5 Open adapters                 :p5, 2026-10-17, 2026-10-30
  P7 References and classification :p7, 2026-10-31, 2026-11-09
  P8 Forecasts                     :p8, 2026-11-06, 2026-11-13
  section Geo lane
  P3 Map spike and basemap         :p3, 2026-10-05, 2026-10-09
  P6 River network                 :p6, 2026-10-12, 2026-11-06
  section Web and serve lane
  P4 Walking skeleton              :p4, 2026-10-14, 2026-10-23
  P9 Publisher and hardened API    :p9, 2026-11-02, 2026-11-16
  P10 Web app MVP                  :p10, 2026-11-10, 2026-11-25
  P11 Follow the water             :p11, 2026-11-20, 2026-11-30
  section Launch
  P12 Hardening and launch by 12-04 :crit, p12, 2026-11-26, 2026-12-04
```

```mermaid
flowchart LR
  P0 --> P1 --> P2
  P0 --> P3
  P2 --> P4
  P3 --> P4
  P2 --> P5 --> P7 --> P9
  P5 --> P8 --> P9
  P2 --> P6
  P5 --> P6
  P9 --> P10
  P6 --> P10
  P7 --> P10
  P10 --> P11
  P6 --> P11
  P9 --> P12
  P10 --> P12
  P11 --> P12
  P7 -.->|"patterns + permission"| P13
  P12 --> P14
```

**Dated events:**

| Date | Event | What it means for the plan |
|---|---|---|
| 2026-10-02 | Recorder live (hard target) | Every day after this is data lost |
| 2026-10-25 | DST fall-back; the hour 01:00–02:00Z repeats in local time | Captured raw by P1. Real payloads become regression fixtures in P5. **Every parser of offset-less local times needs synthetic fall-back and spring-forward fixtures before its first production run** (catalogue §0.3; the DST gate of A§7.4) |
| 2026-10-28 | Node 26 becomes LTS | Bump from 26.10.x to the first LTS patch via Dependabot |
| 2026-11-05 | RWS documentation moves to the CTD | URLs live in config. Watch the nightly contract check. The NL-4 xlsx path under `rijkswaterstaatdata.nl/publish/…` is at risk (§2.1); API hosts unconfirmed (§10 R4; owner action D6) |
| December–March | Rhine and Meuse flood season | This is why launch is ≤ 12-04 |

---

## 2. Gates, criterion tags and workflow

### 2.1 Criterion tags

Every acceptance criterion carries exactly one tag.

| Tag | Meaning | Who is accountable |
|---|---|---|
| **[CI]** | Provable offline: in GitHub Actions, or reproducibly in the build agent's session (SessionStart hook + native PostgreSQL 18). | Build agent |
| **[agent-prod]** | Checkable from outside, without SSH, through `scripts/verify-prod.sh <domain>`, `/status/capture.json`, `/data/v1/status.json` or `/api/v1/health*`. If the agent sandbox cannot reach the domain, the owner runs the script and pastes the output. | Build agent |
| **[owner]** | Needs the owner's access or judgement: VPS console, bucket keys, a phone alert, e-mails, a signed checklist. | Owner (the agent supplies the script or checklist) |

**Soak criteria** (for example "72 h ≥ 99%") are `[agent-prod]` checks made after deploy. They **block closing the issue, not starting the next phase**.

### 2.2 Per-PR workflow

1. **Build.** A fresh session with the phase's build model and effort runs `/plan`. The owner approves the plan. The agent implements it on `claude/p<N><a>-<slug>` and opens the PR with the evidence checklist filled in.
2. **Code review.** A fresh session with the review model runs `/code-review <level> --comment <PR#>`.
3. **Security review.** A fresh session with the security model checks out the PR branch and runs `/security-review`.
4. **Fix.** A fresh session with the build model at the build effort addresses the findings. If a High or Critical finding was fixed, the relevant review re-runs on the fix diff only.
5. **Gate.**
   - CI is green.
   - No High or Critical security finding is open.
   - Medium findings are fixed or accepted in `docs/risk-register.md`.
   - Every `[CI]` item is ticked with evidence.
6. **Merge and deploy.** The owner merges and approves the `production` environment. `rws-update` pulls, verifies and deploys. The agent runs `verify-prod.sh` and ticks the `[agent-prod]` items.

### 2.3 PR evidence checklist (`.github/pull_request_template.md`)

```
## Evidence
- [ ] Every [CI] criterion → test name or CI job link
- [ ] Every [agent-prod] criterion → verify-prod.sh output (after deploy)
- [ ] [owner] items → script/checklist provided: <path>
- [ ] CLAUDE.md / runbooks / docs/threat-model.md updated where this PR changes them
- [ ] Audience: sources touched and their audience (public / owner / off), and the owner canary result, or "no audience change"
- [ ] New runtime dependencies: ADR-lite lines (why · licence · maintainer health · transitive count) or "none"
- [ ] Source IDs touched (catalogue): …
- [ ] [U] items not verified: …
```

---

## 3. Model and effort rubric

Models: `/model fable` (Fable 5.1, $10/$50 per MTok), `/model opus` (Opus 5.5, $4/$20), `/model sonnet` (Sonnet 5, $2/$10) and `/model haiku` (Haiku 4.5, $1/$5). Effort: `/effort low|medium|high|xhigh|max`.

### 3.1 Always

1. **Set effort explicitly** in every prompt. Opus 5.5 defaults to medium, which is too low for any step here.
2. **Reviews run in fresh sessions** with a mandate different from the build.
3. **Code review uses a different model from the build, always.** A security review may reuse the builder's model (P4, P13), because a fresh session with a security-only mandate already gives independence.

### 3.2 Builds

**Default builder: Opus 5.5 at xhigh**, the agentic sweet spot:
- The work is multi-file and mostly unattended.
- The provider traps are well documented in the catalogue.
- Several 2026 majors (MapLibre 6, Vite 8, Vitest 5, the PG18 image layout, Node 26) are newer than most model knowledge.

Exceptions:
- **Fable 5.1 builds only P2**, the data spine. It fixes the canonical model, the time, unit and datum semantics, idempotency and revisions, and every later adapter copies it. An error there silently corrupts the only copy of the go-live data.
- **Opus at high builds P13.** By then P5, P7 and P8 have established the adapter template, and each gated source is a small PR.
- **Sonnet 5 builds nothing before launch.** The volume of patterned work is not large enough to justify the extra review load a cheaper builder needs.
- **Haiku 4.5 is not used.** Every step either writes code that runs unattended against irreplaceable data or reviews such code. The savings are small next to the cost of one missed bug.

### 3.3 Code reviews

| Model and level | Used for | Phases |
|---|---|---|
| **Fable** | A miss would be irreversible, or would mislead the public during a flood | P1 recorder (atomicity, silent gaps); P5b LU DST and offset; P7 classification semantics; P8 forecast bi-temporality; P12 cache and versioning at launch; P14 backfill precedence |
| **Opus at `max`** | The strongest independent reviewer for the one Fable-built phase; correctness outweighs cost, and the diff is bounded | P2 |
| **Sonnet at `xhigh`** | Conformance against established patterns and the catalogue pitfall lists | P4, P5a, P9, P10, P11, P13 |
| **Sonnet at `high`** | Configuration, docs and geo work whose correctness is asserted by strong tests | P0, P3, P6 |

### 3.4 Security reviews

| Model and effort | Used for | Phases |
|---|---|---|
| **Fable** | The change is a root of trust or the public attack surface | P0 CI (high: small diff); P1 trust chain and SSRF fetcher (xhigh); P9 public API (xhigh); P12 whole-system launch gate (**max**) |
| **Opus at high/xhigh** | First exposure of a new kind | P4, the first public endpoint (high); P13, the first third-party credentials (xhigh) |
| **Sonnet at xhigh** | New untrusted-input parsers or client surface, checked against a checklist | P2, P3, P5, P10 |
| **Sonnet at high** | Parsers behind established guards | P7, P8, P14 |
| **Sonnet at medium** | Offline tools or UI-only diffs | P6, P11 |

### 3.5 Effort

- **max** only where correctness beats cost and the diff is bounded: the P2 code review and the P12 security review.
- **low** is never used.

### 3.6 Totals

- Fable: **11 of 45 steps** (P0 security, P1 review and security, P2 build, P5b review, P7 review, P8 review, P9 security, P12 review and security, P14 review).
- Opus: 14 builds, 1 review and 2 security reviews.
- Sonnet: the rest.
- Haiku: 0.

---

## 4. Issue template: the three prompts

Each phase issue contains this block. The placeholders come from the phase section. `<INVARIANTS>` is the verbatim list in A§12.1 / `CLAUDE.md`.

````markdown
### 1 · Build — `/model <build-model>` · `/effort <build-effort>`
```
/model <build-model>
/effort <build-effort>
/plan
You are implementing Phase <N>, PR <N><x> "<pr-name>" of mwijkhuisen/Waterheight.
Read first: CLAUDE.md (bill of materials, gotchas, security invariants), docs/plan/ARCHITECTURE.md,
docs/plan/PHASES.md §P<N>, docs/adr/, docs/threat-model.md, and these catalogue sections:
<§refs> in docs/sources/SOURCE-CATALOGUE.md. Source IDs in scope: <IDs>.
Security invariants (must hold for every line you write): <INVARIANTS>
Plan first: map every [CI] and [agent-prod] acceptance criterion of this PR to a test, command or
evidence item; list the [owner] items and the script/checklist you will provide; wait for approval.
Then implement on branch claude/p<N><x>-<slug>, strictly inside "Scope in" for this PR. Tests run
offline (msw onUnhandledRequest:'error'; fixtures come from the raw archive, never live calls).
No new runtime dependency without an ADR-lite line. Update CLAUDE.md, runbooks and
docs/threat-model.md where this PR changes them. Open PR "P<N><x>: <pr-name>" with the evidence
checklist filled in. Do not merge. List every [U] item you could not verify.
```
### 2 · Code review — `/model <review-model>` · `/code-review <level>`
```
/model <review-model>
/code-review <level> --comment <PR#>
Focus for this phase: <code-review focus bullets>.
Also check: each [CI] criterion has a test that fails without the change; source IDs and catalogue
pitfalls (<§refs>) are honoured; scope did not creep beyond "Scope in".
```
### 3 · Security review — `/model <sec-model>` · `/effort <sec-effort>`
```
/model <sec-model>
/effort <sec-effort>
git fetch origin && git checkout claude/p<N><x>-<slug>
/security-review
Focus for this phase: <security focus bullets>.
Verify the CLAUDE.md security invariants hold for this diff: <INVARIANTS>.
Report any threat-model delta for docs/threat-model.md. Classify findings Critical/High/Medium/Low.
```
````

---

## 5. Phases

### P0 · Reset and foundation

**Window:** 09-24 → 09-26 · **Lane:** – · **Depends on:** – · **PRs:** P0a reset, P0b foundation

**Goal.** Archive the legacy code where `main` can no longer reach it. Give every later agent the same guardrails: a buildable monorepo, hardened CI, a supply-chain policy, `CLAUDE.md`, the plan and the catalogue in the repository, and a registry keyed by catalogue source IDs.

**Scope in**
- **P0a reset**
  - Create the annotated tag `legacy-v0` on `a4106b8` (the legacy `main`; if PR #30 was merged first, `main` is `a4106b8` plus only `docs/plan/` and `docs/sources/`) and push it.
  - In one commit, `git rm -r` every legacy path: `packages/`, `spike/`, `fixtures/`, `deploy/`, `docs/INSTALL-UBUNTU.md`, `docs/INTERNATIONAL-DATA.md`, `docs/PROMPT-PHASE3-GERMANY.md` (the only legacy files under `docs/`; never `docs/plan/` or `docs/sources/`), `.github/workflows/ci.yml`, `PROMPT.md`, `README.md`, `Dockerfile`, `docker-compose.yml`, `package.json`, `package-lock.json`, `tsconfig*.json`, `.env.example`, `.dockerignore` and `.gitignore`. Add a new stub `README.md` and a rewritten `.gitignore`.
  - Write `scripts/verify-fresh-start.sh`. It fails if any blob in `main`'s tree is byte-identical to a blob in `legacy-v0`. The allowlist starts empty. The planning-bundle files are new blobs, never legacy.
- **P0b foundation**
  - **pnpm workspace** (A§5):
    - `apps/server` with a Hono `/healthz` and a role dispatcher stub (`capture | load | publish | api | replay | watchdog`);
    - `apps/web` with Vite + React and a Paraglide "Hallo / Hello" page, NL at `/` and EN at `/en/`;
    - `packages/core` and `packages/contracts`;
    - empty `db/migrations/`, plus `registry/`, `tools/geo/`, `deploy/` and `scripts/`.
  - **TypeScript configuration**: `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` and `verbatimModuleSyntax`, plus project references built with `tsc -b`.
  - **Tooling**: Biome; Vitest 5 with a global msw setup using `onUnhandledRequest: 'error'`. `pnpm check` runs Biome, `tsc -b` and Vitest.
  - **pnpm policy**: `minimumReleaseAge: 10080`, `strictDepBuilds`, an explicit `allowBuilds`, `blockExoticSubdeps`, `--frozen-lockfile`. The override procedure for urgent security fixes is documented in `CLAUDE.md`.
  - **CI workflows**, with every action SHA-pinned, `permissions: {}` at top level and `persist-credentials: false`:
    - `ci.yml`: install, `pnpm check`, integration tests against a digest-pinned `postgres:18.6` service container, web build, a dbmate up/down/up round trip, `check-bom`, `check-boundaries`, `verify-fresh-start`;
    - `security.yml`: zizmor, gitleaks over the full history, a grep that every `uses:` has a 40-hex SHA, a grep for top-level `permissions: {}`, and CodeQL if the repository is public (decision D7);
    - `dependabot.yml`: npm, github-actions and docker; `cooldown` 7 days; grouped; no automerge.
  - **`CLAUDE.md`**:
    - the mission and the fresh-start rule (never read or restore `legacy-v0` content);
    - the bill of materials with exact pins (A§3);
    - gotchas: MapLibre 6 is ESM-only and WebGL2-only, with `map.transform` removed; the PG18 image moved `PGDATA` to `/var/lib/postgresql/18/docker` and the volume to `/var/lib/postgresql`; TS 7 is forbidden; Vitest 5's `clearMocks` default and failing unawaited assertions; Node 26 Temporal and type-stripping rules; corepack is not bundled; Protomaps builds are kept for 1 week; Hub'Eau v1 returns 403; RWS docs move to the CTD on 2026-11-05;
    - the security invariants (A§12.1), verbatim, including invariant 11 (owner-audience isolation);
    - the audience rules (A§6, ADR-0017): what `public`, `owner` and `off` mean, that the owner view is used by the owner alone and never shared, and that fixtures of owner-audience sources are synthetic;
    - the adapter contract, and the rule that adapters are keyed by source ID;
    - criterion tags, the definition of done, and the PR and review workflow (§2);
    - the ADR-lite rule for new dependencies.
  - **Agent set-up**:
    - `.claude/settings.json`: deny reads of `**/.env*` and `deploy/secrets/**`; deny `git push --force*`; allow `pnpm`, `psql` and read-only `git` commands;
    - `.claude/hooks/session-start.sh`, written with the `session-start-hook` skill. It is idempotent and installs Node 26.10.x, pnpm 12.6.0 (P0b pinned 12.5.1: 12.6.0 was under the 7-day release age) and native PostgreSQL 18 (a cluster on port 5433 with the builtin C.UTF-8 locale), then runs `pnpm install --frozen-lockfile`.
  - **Docs**:
    - `docs/plan/`: ARCHITECTURE.md, PHASES.md, JUDGEMENT.md and `proposals/` from the planning bundle (branch `claude/river-water-level-map-hf7bcz`, PR #30);
    - `docs/sources/SOURCE-CATALOGUE.md` and `docs/sources/research/*.md`, copied verbatim;
    - the import is conditional: if `main` already holds `docs/plan/` and `docs/sources/` (PR #30 merged), they are not re-imported but verified identical to `origin/claude/river-water-level-map-hf7bcz` if that branch still exists, else to the PR #30 merge commit, and the PR body records which case applied; otherwise they are imported with `git checkout` from that branch (explicit refspec);
    - `docs/adr/0001…0015` and `0017` (from A§13), `docs/threat-model.md` v1 (including the owner channel), `SECURITY.md`, `docs/risk-register.md`;
    - `docs/permissions.md` (tracker) and `docs/legal/requests/*.md`: ready-to-send e-mails for every row in §6.2 C (C1–C13). The tracker records per source: date sent, date answered, conditions, the **audience** (`public`, `owner` or `off`) and its `private_basis`, the licence channels granted (`display`, `api`, `bulk_export`, `history_export`; catalogue §0.7) and a **go/no-go date** after which the fallback ships (§0.2). **Every e-mail asks explicitly** whether (a) machine-readable redistribution through our public API and exports is allowed and (b) we may keep and republish a history archive (§0.2, §0.7). C1 (HIC) and C2 (VMM) request credentials for a **personal, non-commercial, private viewer** and optionally ask about public display; C3 (SPW) and C4 (AGE) ask **only for public display** (optional; nothing waits on them);
    - `docs/github-settings.md` and `scripts/gh-settings.sh` (with a `--check` mode).
  - **Registry**: `registry/providers.yaml` and `registry/sources.yaml`, listing **every catalogue source ID** with its licence, exact attribution text (§1b), **`audience`** (`public | owner | off`; it replaces `publication`, A§6) and `capture_enabled`, plus the schema and a validator test. Initial values (catalogue §0.8; ADR-0017):
    - `public`: the §0.2 "safe" sources, plus CH-2, CH-4 and CH-5 (they move to `owner` if BAFU objects in C13);
    - `owner`, each with a **`private_basis`** (`clause` verbatim from catalogue §0.8, `url`, `retrieved` date): BE-3, LU-2, LU-3, LU-4, DE-3, and DE-2 until the Belegexemplar is sent (then `public`, P12);
    - `off`: NL-3, DE-9, **DE-10 (LfU RLP) and DE-12 (LUBW)** until C11/C12 are granted (their Impressum forbids copying without consent), DE-13 and the other backlog sources, and BE-1 and BE-2 until their credentials arrive (C1, C2; then `owner`);
    - a series may narrow its source's audience, never widen it; the RLP-operated gauges inside LU-1 are narrowed to `off` (withheld), and so are the LfU RLP-origin series on the AGE site (LU-2 Bollendorf and Gemünd; the LU-3 Moselle runs at Perl, Stadtbredimus and Wasserbillig), which are not captured at all until C4 or C11;
    - one **owner canary** source (`audience: owner`, `canary: true`) and one withheld canary series, used by the tests of P2 and P9 and hidden from every UI.
  - **Licence channel flags** (catalogue §0.7) in `registry/sources.yaml` for every source: `display`, `api`, `bulk_export`, `history_export`, `attribution_text`, `attribution_url`, `needs_last_updated`, `needs_retrieval_date`. Defaults: all four channels on for CC0 / DL-DE Zero / Etalab / CC BY / Modellicentie sources (with attribution); `api`, `bulk_export` and `history_export` **off** for any source used under a written permission until its permission record says otherwise; for an `owner` source, `display`, `api` and `history_export` on (they apply to the owner channel only) and `bulk_export` off. The channels apply inside each audience. A series may narrow its source's flags, never widen them.
  - **Station registry schema** (`registry/stations/*.yaml`, one row per physical gauge and quantity; catalogue gap item 17): canonical source and provider IDs, coordinates, datum and gauge zero with validity, river and km system, tidal/weir flags, expected threshold source and forecast source, licence-gate status, `audience` and `first_release`. The rows are filled from catalogue §3 in P2 and P5; the schema and validator land here. Rows of owner-audience stations may hold identification only (provider number, name, coordinates, river and km); the validator rejects values, thresholds or forecasts in them.
  - **GitHub files**: `.github/CODEOWNERS` (the owner on `.github/`, `deploy/`, `db/migrations/` and `registry/`), `.github/ISSUE_TEMPLATE/phase.md` (§4) and `.github/pull_request_template.md` (§2.3).

**Scope out:** product code, service Dockerfiles (P1), the VPS.

**Deliverables:** the tag; a clean `main`; the scaffold, CI and Dependabot configuration; `CLAUDE.md`; the hook; the docs, ADRs, registry and e-mail drafts; the GitHub settings script.

**Acceptance criteria**
- [ ] [CI] `git rev-parse legacy-v0^{commit}` equals `a4106b8…`, and `git ls-remote --tags origin 'legacy-v0*'` returns it on the peeled `refs/tags/legacy-v0^{}` line.
- [ ] [CI] `verify-fresh-start.sh` passes: `main` contains 0 legacy blobs and none of the legacy top-level paths.
- [ ] [CI] After the P0a removal commit, the tree holds only `README.md`, `.gitignore`, `scripts/*` and, only if PR #30 was merged first, `docs/plan/**` and `docs/sources/**`.
- [ ] [CI] P0b: `docs/plan/` and `docs/sources/` equal the planning bundle (branch `claude/river-water-level-map-hf7bcz`, or the PR #30 merge commit if the branch is gone); the PR body says whether they were imported or already on `main`.
- [ ] [CI] On a clean checkout, `pnpm install --frozen-lockfile && pnpm check && pnpm -F web build` is green, and `node apps/server/dist/main.js api` serves `GET /healthz` → 200.
- [ ] [CI] zizmor reports 0 findings at medium or above. Every `uses:` is pinned to a 40-hex SHA, and every workflow has top-level `permissions: {}`.
- [ ] [CI] gitleaks passes on the full history of `main`.
- [ ] [CI] `check-bom` passes: the `CLAUDE.md` bill of materials equals the pins in `package.json` and the lockfile. A deliberately wrong pin makes it fail (test).
- [ ] [CI] `check-boundaries` fails on committed violation fixtures (web → server, adapter → adapter) and passes on the tree.
- [ ] [CI] The registry validates. Every source ID from §1a appears exactly once with an `audience`. NL-3, DE-9, DE-10, DE-12, BE-1 and BE-2 are `off`; BE-3, LU-2, LU-3, LU-4, DE-2 and DE-3 are `owner`; CH-2, CH-4 and CH-5 are `public`. No `publication` or `dark` value remains.
- [ ] [CI] **`private_basis` validation:** an `owner` source without a `private_basis`, or with an empty `clause`, a `url` that is not https, or a missing `retrieved` date, fails; a `private_basis` on a `public` or `off` source fails; each owner source's `clause` matches its catalogue §0.8 row verbatim (test against the committed catalogue).
- [ ] [CI] Every source carries the four §0.7 channel flags and its attribution fields. A test fails if a source marked as permission-based has `api`, `bulk_export` or `history_export` on, if an `owner` source has `bulk_export` on, or if a series widens its source's flags or its audience.
- [ ] [CI] A doc test asserts that `CLAUDE.md` quotes the A§12.1 invariants 1–11 verbatim, including invariant 11 (owner-audience isolation).
- [ ] [CI] The station-registry schema (gap item 17 fields) validates a committed sample of 5 rows, and a row missing `first_release` or the licence-gate status fails.
- [ ] [CI] The dbmate up/down/up round trip is green on PG 18.6.
- [ ] [CI] A fresh claude.ai/code session runs the SessionStart hook, then `pnpm check` and `pnpm test:integration` pass with no manual steps. The session log is attached to the PR.
- [ ] [owner] `scripts/gh-settings.sh` is applied, and `scripts/gh-settings.sh --check` passes (§6.2 B1–B3).
- [ ] [owner] The permission e-mails C1, C2, C5–C9 and C11–C13 are sent (C10 waits until after launch; C3 and C4 are optional public-display requests, sent or marked "deferred"), and their dates are recorded in `docs/permissions.md`, including C1 and C2 as personal-viewer requests, C11 LfU RLP, C12 LUBW and C13 BAFU hydrodaten, each with a go/no-go date.

**Providers / rivers:** none for data. The registry covers every source ID.

**Risks**
- *Losing legacy history.* Tag first, verify the tag on the remote, and only then delete, in a separate PR.
- *Losing the plan.* P0a removes only the three legacy `docs/*.md` files, never `docs/plan/` or `docs/sources/`; P0b imports the bundle only if PR #30 was not merged, and verifies it either way. Branch `claude/river-water-level-map-hf7bcz` stays until P0b merges, unless PR #30 was merged; then it may be deleted.
- *Legacy assumptions creeping back.* The blob check and the fresh-start rule prevent this.
- *The 7-day release age blocking an urgent fix.* A documented override procedure.
- *Hook drift.* The hook is idempotent and CI runs the same commands.
- *A wrong audience* (an owner-only source marked public, or a no-consent source marked owner). Values come from catalogue §0.8, the validator checks each `private_basis` against it, and CODEOWNERS covers `registry/`.

**Review focus**
- *Code review:* hook idempotency; that `check-bom` and `check-boundaries` really fail on violations; the registry against catalogue §1a/§1b (IDs, attribution text, flags), the §0.7 channel-flag defaults and the §0.8 audiences and `private_basis` clauses; that every e-mail draft asks the §0.2 redistribution and history-archive questions, and that C1/C2 ask for a personal, non-commercial, private viewer.
- *Security review:* `${{ }}` injection in `run:`; token permissions; `pull_request_target` absent; `persist-credentials: false`; the cache-poisoning surface; the Dependabot and pnpm policy; the `.claude/settings.json` deny rules; whether the `CLAUDE.md` invariants are specific enough to enforce, invariant 11 in particular; the settings script, which must not weaken anything.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Patterned scaffolding, but it writes the operating manual and policy every later agent inherits, on 2026-current versions |
| Code review | `sonnet` | `/code-review high` | Configuration and docs conformance against this plan; mechanical, and a different model |
| Security review | `fable` | high | The CI root of trust (permissions, pinning, hook, settings). A small diff where a miss becomes a repository-compromise vector |

---

### P1 · Flight recorder in production

**Window:** 09-26 → **live ≤ 10-02** · **Lane:** data + ops · **Depends on:** P0; owner actions A1–A7 · **PRs:** P1a recorder and P1b platform, built in parallel sessions

**Goal.** Stop losing data. Every perishable, legally capturable endpoint is fetched on schedule and archived raw, synced off-site and monitored, before any parser or database exists. The signed pull-based deploy and the Object Lock backups work from day one.

**Scope in**
- **P1a recorder** (`apps/server`: `http/`, `archive/`, `capture/`, `adapters/<id>/capture.ts`)
  - **Polite client** (A§7.3, A§12.2):
    - the allowlist per source ID comes from the registry and is checked in DNS `lookup`, after resolution and on each redirect hop. It includes the gap-check hosts of catalogue §6.7: `pegelonline.wsv.de` (without `www`), `rijkswaterstaatdata.nl` (NL-4 file and page), **`download.data.public.lu`** (the LU-5 CAP files are served there, not from `data.public.lu`) and `vorhersage.bafg.de` (DE-3, owner audience from P1 under D3). The owner-audience hosts are added for their own source IDs: **`hydrometrie.wallonie.be`** (BE-3) and `inondations.public.lu` for LU-2, LU-3 and LU-4 (already allowed for LU-1). The hosts of gated sources (`www.hochwasser.rlp.de`, `www.hvz.baden-wuerttemberg.de`, later `www.hlnug.de`) are added only in the PR that follows a permission (P13, or the backlog for HLNUG);
    - private, loopback, link-local, CGNAT, ULA and multicast addresses are refused;
    - same-host redirects only, at most 3. **Canonical URLs** are configured so that no cross-host redirect is needed (§6.7): `hicws.vlaanderen.be` (not the legacy `www.waterinfo.be/tsmhic/…`), `inondations.public.lu`, and each data.public.lu resource's own `url` (not the `latest` redirect link);
    - timeouts: connect 10 s, total 60 s, metadata 120 s;
    - body cap 25 MB, decompressed cap 100 MB for HTTP content encoding (ZIP members follow the ZIP rule below);
    - **per-format input guards** (§6.7; first-release inputs are JSON/GeoJSON, CSV, ZIP of CSV, CAP XML, SPARQL CSV and XLSX, not JSON only): ZIP read from the central directory, ≤ 10 members with allowlisted names (no `/`, `..` or absolute paths), ≤ 200 MB uncompressed in total, ratio ≤ 50:1, streamed, never extracted to disk by name; XML with DTDs, external entities and entity expansion off, any `<!DOCTYPE` rejected, CAP ≤ 1 MB; XLSX gets both the ZIP and XML rules; CSV ≤ 100,000 rows, ≤ 1,000 columns, fields ≤ 1 KB, encoding declared per source;
    - the User-Agent with the contact address, and the RWS `X-API-KEY`;
    - at most 2 connections per host;
    - ETag, `If-None-Match` and `If-Modified-Since`;
    - backoff and breaker as in A§7.3;
    - staggered offsets.
  - **Archive writer**: key layout, tmp + fsync + rename, the daily JSONL manifest, `dup_of`, shape fingerprints (alert on change) and byte counters.
  - **Capture specs for every row of A§7.2**, in `registry/capture.yaml`, each with:
    - a validity assertion (the payload parses; required keys are present; count ≥ minimum);
    - a retention class;
    - a gap-stretch window rule, so the window covers the time since the last success, up to the provider's maximum.
  - **The unrecoverable streams come first** (catalogue §0.1, §0.1a). A§7.2 covers every §0.1a row with its change gate: forecast runs (NL-1 `verwachting`, DE-2 `WV` (owner audience), FR-4, CH-4), alert and class states (DE-6 LHP stations of **all 16 states** plus `/data/alerts` with `If-None-Match`; FR-5 `InfoVigiCru` stored only when `DtHrInfoVigiCru` changes; LU-5 CAP; CH-1 `dangerLevel`; CH-5), and threshold versions (NL-4 xlsx plus the rijkswaterstaatdata.nl link list with an alert on a new file name; DE-1 metadata with characteristic values and PNP `validFrom`; CH-2 `wl_1..wl_4`). These specs are enabled first; observation specs follow in the same PR. DE-10 RLP is added only in P13, on the day C11 is granted.
  - **Owner-audience capture from day one** (D22; A§7.2; catalogue §0.8), with the same politeness, allowlist and attribution as every other spec:
    - **BE-3 SPW**: KiWIS `getTimeseriesValueLayer` for groups **1962373** (levels) and **1962340** (discharge) every 10 min, 2 requests, `timezone=UTC`; the station and time-series metadata daily;
    - **LU-2**: the 39 per-station JSON files of AGE-published gauges hourly, never with a query string; the LfU RLP-operated Bollendorf and Gemünd files are not fetched until C4 or C11 answers (DE-10 terms; catalogue §0.8);
    - **LU-3**: the 55 percentile files of the 11 AGE-computed forecast stations hourly, deduplicated by content hash (forecast runs nobody can refill, so they are enabled first among the owner specs, with LU-4); the LfU RLP-computed Moselle runs (Perl, Stadtbredimus, Wasserbillig) are not fetched until C4 or C11 answers;
    - **LU-4**: the station pages weekly, reading only the `data-to-json` attribute, with an alert on a threshold change;
    - **DE-2** and **DE-3**: already in the §0.1a/A§7.2 set, now `owner` instead of `dark`;
    - each of these sources has its `private_basis`. Nothing parses them yet: P5c, P7 and P8 do.
  - **RWS tiers**: `registry/seed/nl-1.csv` lists about 25 key gauges (10 min) and about 45 others (30 min), taken from §3.1 and §3.3. The forecast locations are listed separately: **all 183 H and 13 Q forecast locations** (§0.1a), about 40 curated ones hourly and the rest every 3 h, inside the ≤ 400 requests/hour budget.
  - **Ungated Belgium from day one** (catalogue §0.6): the NL-1 specs include the RWS points on Belgian soil (`antwerpen`, `lixhebiefaval`, `maaseik`, `herenlaak`, `lanaken`, `kanne`, `smeermaas.zuidwillemsvaart`), and the FR-1 `code_entite` prefixes must cover the codes of the 18 NL-bound Hub'Eau partner stations (add explicit codes where a prefix misses one).
  - **Seeds = the day-0 harvest of catalogue §0.1b**: one-off, idempotent, and recorded in `seed-report.json`. DE-1 P31D for about 60 tier-1 series; FR-1 30 days, paced at 1 request per 2 s; FR-3 about 2 months for about 15 key stations; CH-3 40 days for 11 key stations; DE-7 `pegeldaten.zip`; LU-1 (the first CSV holds 5 days); **LU-5 every CAP dump since 2025-06 (833 files, about 30 MB; it contains real AGE flood alerts, §0.4)**; LU-2 (the first capture holds 7 days; owner audience, so it is reported in the owner status, never in the public `seed-report.json`). NLWKN is not seeded (off). SPW is not seeded here: KiWIS keeps decades, and P5c catches up.
  - **Status and alerts**: `capture-status.json`, written each cycle to `public/status/capture.json` with public-audience specs only plus the aggregate `owner_specs: {fresh, total}` (no IDs, hosts or values); owner-audience specs go to `owner/status/capture.json` (A§7.1), which nothing serves until the owner site exists; a healthchecks ping per provider group, including the **owner** group (start, success and fail; grace 3× cadence); a daily capture report, whose owner part goes only to the owner status file.
- **P1b platform** (`deploy/`, `.github/workflows/release.yml`, `scripts/verify-prod.sh`)
  - **`deploy/host/bootstrap.sh`** (Debian 13; idempotent; shellcheck-clean):
    - the `ops` user; SSH keys only; no root login;
    - nftables inbound: 22 (rate-limited), 80 and 443/tcp, 443/udp;
    - nftables egress for the `egress` and `public` subnets: TCP 443 plus DNS only;
    - unattended-upgrades + needrestart, chrony and a sysctl baseline;
    - Docker 29.8.1 + Compose v5.5.1 from Docker's signed apt repository;
    - `daemon.json`: `no-new-privileges`, `live-restore`, the `local` log driver with rotation, `icc: false`;
    - `/srv/rws/{raw,public,owner,tiles,backup}` and `/etc/rws/secrets` (0700); `owner` is mounted only into `capture` (status), and later `publish-owner` and `caddy` (A§11.1).
  - **`deploy/compose.yaml`**, with the networks of A§11.1:
    - services `caddy` (NL/EN placeholder page, `/healthz`, `/status/capture.json`), `capture`, `watchdog` and `backup` (job);
    - the full hardening flags and Compose secrets.
  - **Dockerfiles**: server (built on `node:26-trixie-slim`, run on distroless `nodejs26-debian13:nonroot`) and web (`caddy:2.11.4-alpine` plus static files), with digest-pinned bases.
  - **`release.yml`**: build, SBOM + provenance, push to GHCR by digest, cosign keyless signing and attestation. Then the `promote` job in the `production` environment publishes the Release `prod-<ts>` with a signed `release-manifest.json` (A§11.2).
  - **Deploy**: `deploy/bin/rws-update` plus a systemd timer (every 5 min), and `rws-deploy <release>`. Both verify the manifest and images with the pinned identity and issuer, then pull, `up -d`, smoke-test and roll back automatically on failure.
  - **Backups**:
    - `rws-backup.timer` runs restic of `raw` hourly to the Object Lock bucket;
    - `rws-restore-drill.timer` runs monthly and can be forced once. It restores a 100-object sample, compares sha256 and writes the result to `/status/ops.json` (coarse values only).
  - **Watchdog role**: probes `https://<domain>/healthz` and `/status/capture.json` through public DNS and TLS, and checks that the certificate is valid ≥ 14 days, the disk is < 75% full and the last backup is < 2 h old.
  - **Healthchecks set-up**: `deploy/healthchecks.yaml` and `rws-hc-sync`, which creates the checks using the owner's healthchecks API key.
  - **`scripts/verify-prod.sh <domain>`**: TLS validity, the exact headers of A§12.2, `/healthz`, capture freshness per spec, and `X-Robots-Tag: noindex`.
  - **`deploy/bin/rws-reachability`** (catalogue gap item 11, §10 R7): a one-shot owner-run check **on the VPS, over IPv4 and IPv6**, against every §1a endpoint and the sandbox failures to re-test (waterstandlimburg.nl, Saarland, `server.wver.de`, `waterdata.wrij.nl`, `evrs.bkg.bund.de`, Overpass, Geofabrik). It asserts on a **body signature**, not only the HTTP status (e.g. the OSM tile server answers 200 with a "blocked" PNG). The output goes to `docs/reachability-<date>.md`.
  - **`docs/capacity.md`** (gap item 16): after 48 h of production capture, the compressed bytes per day per spec after sha256 deduplication, the projected year-1 archive (hot obs window plus forever classes) against the disk and the bucket, and the retention class per source derived from it.
  - **Runbooks**: bootstrap, recorder down, deploy/rollback, restore, disk full, lost SSH access.

**Scope out:** parsing, the database (Compose placeholders only), any public API, the map.

**Deliverables:** the recorder running on the VPS; the off-site archive; the alerts; the seed report; the signed pull-deploy pipeline; the backups and restore drill; `verify-prod.sh`; the runbooks.

**Acceptance criteria**
- [ ] [CI] Client tests (msw) refuse or abort each of these:
  - a non-allowlisted host;
  - DNS answers of `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `100.64.0.1`, `::1` and `fc00::1`, including on a redirect hop;
  - a cross-host redirect;
  - a 30 MB body;
  - a gzip bomb (1 KB → 1 GB, aborted at 100 MB);
  - a ZIP with too many entries or `../` paths;
  - a slowloris upstream.
- [ ] [CI] Per-format guards (§6.7): a ZIP with a compression ratio > 50:1 or > 200 MB uncompressed is refused, while a synthetic ZIP of 128 MB uncompressed (the real `pegeldaten.zip` size) passes; an XML body with `<!DOCTYPE`, an external entity or entity expansion is refused; a CSV with > 1,000 columns or a field > 1 KB is refused; an XLSX with an XML bomb inside is refused.
- [ ] [CI] Allowlist and redirects: `download.data.public.lu`, `rijkswaterstaatdata.nl`, `pegelonline.wsv.de`, `vorhersage.bafg.de`, `hydrometrie.wallonie.be` (BE-3) and `inondations.public.lu` (LU-1 to LU-4) are allowlisted for their source IDs, and no host of an `off` source (DE-9, DE-10, DE-12, BE-1, BE-2) is; a `data.public.lu` → `download.data.public.lu` redirect is refused, and the LU-5 spec fetches each resource's own `url` directly.
- [ ] [CI] A test enumerates catalogue §0.1a: every row (NL-1 forecasts; DE-2; DE-6 all states + alerts with `If-None-Match`; FR-4; FR-5 gated on `DtHrInfoVigiCru`; LU-5; CH-1; CH-2; CH-4; CH-5; NL-4 xlsx + link page; DE-1 metadata; LU-1) has an enabled CaptureSpec with the listed interval and change gate, and a retention class that keeps forecast, class and threshold payloads forever. DE-10 (a note under the table, gated) has no spec until P13. The one deliberate interval deviation is NL-1 forecasts: all 183 H + 13 Q locations, the ~40 curated ones hourly and the rest every 3 h, so that the RWS budget of ≤ 400 requests/hour holds (A§7.2); the test asserts that tiering.
- [ ] [CI] A registry test shows that the NL-1 specs include the 7 RWS Belgian points and that the FR-1 request covers all 18 NL-bound Belgian partner-station codes of §0.6.
- [ ] [CI] Backoff and the circuit breaker behave correctly under fake timers, and `Retry-After` is honoured.
- [ ] [CI] A `kill -9` of a capture child process during a write leaves no object under a final key and no manifest line for it. The next cycle resumes and fills the window.
- [ ] [CI] The manifest round-trips its Zod schema. An identical body produces `dup_of` and no new object.
- [ ] [CI] Every CaptureSpec has a validity assertion with one passing fixture and three failing fixtures: empty-but-200, an HTML error page, and truncated JSON. The fixtures of owner-audience specs (BE-3, LU-2, LU-3, LU-4, DE-2, DE-3) are synthetic (real structure, generated values, `synthetic: true`; invariant 9).
- [ ] [CI] The budget config test holds:
  - `ddapi20-waterwebservices.rijkswaterstaat.nl` ≤ 400 requests/hour;
  - the CH-1 interval is ≥ 10 min;
  - the DE-6 interval is ≤ 10 min;
  - FR-1 seed pages are ≥ 2 s apart;
  - BE-3 ≤ 2 value requests per 10 min plus the daily metadata; LU-2 ≤ 39 and LU-3 ≤ 55 requests/hour; LU-4 weekly; no LU request carries a query string, and none fetches an LfU RLP-origin file (LU-2 Bollendorf and Gemünd; LU-3 Perl, Stadtbredimus and Wasserbillig);
  - no spec exists for NL-3, DE-9, DE-10, DE-12, BE-1 or BE-2 (every `off` source).
- [ ] [CI] Owner-audience capture: BE-3 (2 group requests per 10 min + daily metadata), LU-2 (hourly), LU-3 (hourly, content hash), LU-4 (weekly, `data-to-json` only), DE-2 and DE-3 have enabled specs; each of their sources has a `private_basis`; LU-3 and LU-4 are in the first-enabled group. A test writes a status cycle and shows that their state lands only in `owner/status/capture.json`, while `public/status/capture.json` contains no owner source ID or host (grep) and only the `owner_specs` count.
- [ ] [CI] The release workflow produces signed images with an attached SBOM and provenance (run link).
- [ ] [agent-prod] `verify-prod.sh` passes: valid certificate, headers, `/healthz` 200, noindex.
- [ ] [agent-prod] In `/status/capture.json`, every enabled public spec has a success within 3× its cadence, and `owner_specs.fresh` equals `owner_specs.total`, sampled 3 times over 1 h.
- [ ] [agent-prod] The seed report shows DE-1 ≥ 28 days, FR-1 ≥ 28 days, CH-3 ≥ 38 days and DE-7 about 60 days for the listed series. It also shows LU-5 with every CAP dump since 2025-06 (≥ 833 files) and LU-1 with ≥ 4 days (the §0.1b day-0 harvest).
- [ ] [agent-prod, soak 72 h] ≥ 99% of scheduled captures succeed per source ID, with upstream 5xx and timeouts listed separately. The daily byte totals per spec are recorded as the size-budget baseline.
- [ ] [agent-prod] `docs/capacity.md` is committed from the first 48 h of production capture: compressed bytes/day per spec after deduplication, the projected year-1 raw archive and database size vs the ≥ 200 GB disk and the bucket, and a retention class per source.
- [ ] [owner] `rws-reachability` ran on the VPS over IPv4 and IPv6; its output is attached. Every first-release endpoint passes its body-signature check, or it is listed in `docs/risk-register.md` with its fallback.
- [ ] [agent-prod] `/status/ops.json` shows a successful forced restore drill: 100 of 100 sha256 match.
- [ ] [owner] `deploy/tests/negative-deploy.sh` shows that `rws-update` refuses an unsigned image and an image signed by another identity, and that an injected smoke-test failure rolls back to the previous manifest.
- [ ] [owner] Stopping `capture` for more than 3× cadence fires the healthchecks alert on the owner's phone (one provider group).
- [ ] [owner] `restic forget --prune` run with the VPS key fails to remove object versions.
- [ ] [owner] After a VPS reboot, `/status/capture.json` is fresh again within 20 min with no manual step.

**Providers / rivers:** NL-1, NL-2, NL-4, DE-1, DE-2 (owner), DE-3 (owner), DE-6, DE-7, DE-8, FR-1, FR-3 (seed), FR-4, FR-5, LU-1, LU-5, LU-6, CH-1, CH-2, CH-3 (seed), CH-4 and CH-5, plus the owner-audience BE-3 (the Walloon Meuse from Chooz to Lixhe, Sambre, Ourthe, Vesdre, Amblève, Semois and Walloon Escaut) and LU-2, LU-3 and LU-4 (Luxembourg observations, forecasts and thresholds). Together they cover:
- the Alpine Rhine and Bodensee, the High Rhine with the Thur, Aare, Reuss and Limmat, and the Birs;
- the Upper and Lower Rhine to the NL branches;
- the Moselle, Saar, Sauer/Sûre, Our and Alzette;
- the Main, Neckar, Lahn, Sieg, Ruhr, Lippe and Erft;
- the French Meuse, Chiers, Semoy and Sambre, and the Rur, Niers and Schwalm;
- the Escaut, Scarpe and Lys (French side);
- the Ems, Vechte, Dinkel, Berkel, Issel and Bocholter Aa;
- Belgium without permissions (§0.6): the RWS points on Belgian soil and the NL-bound Hub'Eau partner stations (Semois, Chiers, Viroin, Houille, upper Sambre tributaries, Lys at Menen).

**Risks**
- *Silent gaps.* Validity assertions, fingerprints, dead-man switches and the daily report.
- *Missing an unrecoverable stream.* Forecasts, alert/class states and threshold versions cannot be refilled (§0.1); the §0.1a enumeration test and first-enabled order.
- *Disk filling up.* NRW is captured hourly, the size baseline is measured, and an alert fires at 75%. Raw volume is 0.5–1 GB/day uncompressed before deduplication (gap item 16): body-hash and `DtHrInfoVigiCru` gates, zstd, and `docs/capacity.md` from the first 48 h.
- *Sandbox ≠ production reachability* (§10 R7). `rws-reachability` from the VPS; datacentre IP blocks (Cloudflare at AGE, Azure APIM at NLWKN, Hub'Eau "usage abusif") show up as body-signature failures, not as silent 200s.
- *Over-polling.* Budget tests and a contact User-Agent.
- *Clock skew.* chrony.
- *The RWS CTD move (11-05).* URLs live in config; the NL-4 file path is the most exposed (link-page watch, local copy, alert on 404).
- *The owner's VPS steps slipping.* The scripts are idempotent, and each step has a check command.
- *Seeds stressing providers.* Pacing and off-peak runs.
- *Owner-audience capture read as redistribution.* It is personal use only (catalogue §0.8): polite rates, attribution kept, status and data only in the owner channel, and nothing public until a provider consents.
- *AGE behind Cloudflare blocking the VPS* (§10 R7). `rws-reachability` covers `inondations.public.lu`; LU-1 and LU-5 do not depend on LU-2/3/4.

**Review focus**
- *Code review:* write atomicity (tmp → fsync → rename, and the manifest line only after rename); scheduler drift and overlap (`protect`); gap-stretch windows; `dup_of` correctness; validity assertions that cannot pass on garbage; seed idempotency; `rws-update` rollback correctness; `set -euo pipefail` and quoting; that the capture set covers every §0.1a stream with its change gate and forever retention, the §0.1b day-0 harvest, and the owner-audience specs at their polite rates.
- *Security review:* the dialer allowlist per hop and the IP classes; size caps applied before decompression; the §6.7 per-format guards (ZIP, XML/CAP, XLSX, CSV) and the canonical-URL redirect exceptions; redaction of secrets in the manifest and logs; raw-volume permissions; the cosign identity and issuer pinning (exact string, no regex wildcards); secret file modes; the bucket key's scope; nftables default-drop and egress rules; Caddy headers; that `/status/*.json` leaks nothing sensitive, and that owner-audience spec state never reaches the public status file.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Code that runs unattended 24/7, where every bug means unrecoverable data loss, plus the first infrastructure and deploy chain |
| Code review | `fable` | `/code-review high` | A small diff with the highest cost of failure. The most capable independent model hunts atomicity, scheduling and silent-gap bugs |
| Security review | `fable` | xhigh | The trust anchor: the SSRF-capable fetcher, the deploy signature chain, backups and the firewall. Everything later relies on it |

---

### P2 · Data spine

**Window:** 10-03 → 10-16 · **Lane:** data · **Depends on:** P1 · **PRs:** P2a spine + DE-1 (10-03 → 10-10); P2b NL-1/NL-2/NL-4 (10-08 → 10-16)

**Goal.** Turn the archive into a correct, provenance-tracked time-series store, and prove the design on two dissimilar providers:
- **DE-1**: GET with ETag, local offsets, a 31-day window, mixed units and mirrors.
- **NL-1**: one POST per location, fixed `+01:00` timestamps, and an NL-2 WFS whose local times are labelled `Z`.

**Scope in**
- **P2a**
  - **`packages/core`**:
    - canonical Zod types;
    - Temporal time-convention parsers for every convention in A§7.4;
    - the unit table (§4.5);
    - the datum enum with offsets, sources and uncertainty (§4.1). **IGN69 and NGF-1884 carry no usable NAP offset**: the conversion function returns "not converted" for them (catalogue C40; D16);
    - the QC bitmask and the sentinel registry.
  - **`db/migrations`**:
    - the **complete** schema of A§6, including the forecast, reference, class, warning and health tables, so later phases only add data. This includes the §0.7 licence channel columns on `source` and `series`, the recurring season and `priority` columns on `reference_value` (for NL-4), and the **audience columns**: `source.audience` with `private_basis` (a CHECK makes it NOT NULL when `audience = 'owner'`), `series.audience` (narrow only) and `reference_value.source_id`;
    - `ensure_partitions()` (`SECURITY DEFINER`, fixed `search_path`, 3 months ahead, no default partition), BRIN and `btree_gist`;
    - the roles and `pg_hba` of A§12.2, including **`rws_owner_api`** (LOGIN, read-only, `SELECT` on `own_*` only, `CONNECTION LIMIT 4`);
    - the `pub_*` and **`own_*`** security-barrier view families of A§6, with the audience filter applied at every join (station, series, reference, class, forecast, warning, attribution), and `apps/server/src/db/audience.ts` as the only place that names them (A§5);
    - a `db` service initialised with the builtin C.UTF-8 locale.
  - **Registry sync**: YAML → `provider`, `source` (with `audience` and `private_basis`), `attribution`, `station`, `station_alias` and `series`. A drift report compares the registry with the harvested DE-1 `stations.json`.
  - **`load` role** (A§7.4 steps 1–6):
    - tails the manifest from `load_cursor`;
    - QC, the idempotent upsert with `obs_revision`, `obs_latest`, and incremental `obs_1h`/`obs_1d` in the same transaction;
    - a nightly rollup reconciliation;
    - `source_health` and quarantine;
    - the retention pruner, run with `--dry-run` for the first week.
  - **`replay` CLI** (`--source --spec --from --to`).
  - **Adapter DE-1**:
    - W and Q; units `cm`, `m+NN` and `m+PNP`; sentinel `99999`; negative W is valid;
    - mirrors (RWS, BAFU Basel, RP Freiburg Konstanz, Ruhrverband) get role `mirror`;
    - 1-minute series are downsampled to 15 min;
    - station metadata and `gauge_zero` with `validFrom`.
  - **Tier-1 DE registry** from §3.1 and §3.2, with every station-registry field of P0b (expected threshold and forecast source, licence-gate status, `first_release`), so the P7/P8 coverage metrics have a denominator.
  - **Minimal `api` role**: only `/api/v1/health` and `/api/v1/health/sources`, reading `rws_api` views. Health lists public-audience sources only, plus an aggregate `owner_sources: {healthy, total}` from the count-only view `pub_owner_health` (no IDs; A§6). Caddy proxies `/api/v1/health*` only.
  - **Deploy**: `db`, `migrate`, `load` and `api`, then replay everything since P1.
- **P2b**
  - **Adapter NL-1 observations**:
    - WATHTE/NAP/meting with method F007, and Q with per-station method codes;
    - `+01:00` timestamps; quality code 99 is a gap;
    - TAW, MSL and PLAATSLR duplicates are dropped, except the Eijsden-grens TAW series, which is kept as a twin;
    - a stale-series filter (Arnhem, Driel Q, Westervoort IJsselkop Q, §2.1).
  - **Adapter NL-2**: discovery and coordinates only; `local-labelled-Z`; REST wins.
  - **NL-4**: a pinned offline converter (fflate + fast-xml-parser, under the §6.7 XLSX guards) writes `registry/thresholds/nl-4.csv` with the source sha256. The rows load into `reference_value` with semantics `provider_class`; P7 uses them. The converter follows the **catalogue §2.1 parser specification** (NL-4 holds Waterinfo *display* classes, not alert levels):
    - sheet `ParameterLimits`; `'NULL'` is a string;
    - the effective legend for a date is the union of the `Gehele jaar` rows and the rows whose `FromMonth/FromDay`–`ToMonth/ToDay` window contains the date (stored as a recurring season, not a date range);
    - a **lower `Priority` number wins**;
    - slug variants are deduplicated on (Code, Description, Period, Label, From, To): 6,245 rows → 1,542;
    - bounds come from `From`/`To`, never from the label text;
    - the curated series without classes (H: `millingenaanderijn.pannerdensekop`, `holtheme.vecht`, `lith.beneden`, `lixhebiefaval`, `antwerpen`; Q: `millingenaanderijn`, `hagestein.boven`, `maastricht.sintpieter.zuid`, `roermond.hambeek`) stay without NL-4 rows.
  - **Tier-1 NL registry** from §3.1 and §3.3:
    - Lobith `tolkamer`, Pannerdense Kop, Nijmegen, Tiel, Zaltbommel, Driel, Amerongen, Hagestein;
    - Westervoort IJsselkop / `westervoort.1` Q, Doesburg, Zutphen, Deventer, Olst, Zwolle, Kampen;
    - Eijsden-grens, Sint Pieter, Borgharen, Stevensweert, Roermond, Venlo, Grave, Megen, Lith;
    - the Vecht stations and Epen (Geul);
    - tidal stations flagged.
  - **Eijsden twin**: TAW − NAP.
  - **`contract-check.yml`** (nightly): live fetch and parse for DE-1, NL-1 and NL-2. It opens or updates a `contract-drift` issue on failure.

**Scope out:** other adapters; parsing references, classes or forecasts (their tables exist but stay empty, except NL-4 rows); the public data API; the UI.

**Deliverables:** core, migrations, registry sync, loader, replay and pruner; adapters DE-1, NL-1, NL-2 and NL-4; a production database filled since P1; the contract check; the runbooks "schema drift", "replay" and "partition maintenance" (P2b adds "outage drill").

**Acceptance criteria**
- [ ] [CI] Each adapter has ≥ 3 real fixtures from the P1 archive: a normal case, an edge case (sentinel, gap or DST) and an empty or error case. Parse + normalise equals the committed `.golden.json`, with ≥ 90% line coverage of parse and normalise.
- [ ] [CI] fast-check property tests: time parsers round-trip; the DST gap and overlap are handled explicitly for Europe/Amsterdam, Berlin, Luxembourg and Zurich; unit conversions are invertible.
- [ ] [CI] At least 30 known-instant cases pass, including:
  - RWS `2026-09-23T20:50:00.000+01:00` → `19:50Z`;
  - WFS `…T21:30:00.000Z` (local) → `19:30Z` in summer and `20:30Z` in winter;
  - PEGELONLINE `+02:00` and `+01:00`;
  - the repeated local hour on 2026-10-25 (01:00Z–02:00Z).
- [ ] [CI] Replaying the fixture archive twice gives an identical per-partition `md5(string_agg(…))` checksum, 0 new rows and 0 revisions. A changed value produces exactly one `obs_revision` row.
- [ ] [CI] A batch crossing a month boundary creates the partition. An insert beyond the partition horizon fails loudly (there is no default partition).
- [ ] [CI] Incremental `obs_1h`/`obs_1d` equal a from-scratch aggregate over the same data.
- [ ] [CI] Roles: `rws_api` and `rws_publish` cannot INSERT, UPDATE or DELETE, cannot SELECT base tables or any `own_*` view (permission denied), and see no row of the seeded withheld canary or the owner canary (`777777.777`). `rws_owner_api` is read-only, cannot SELECT base tables or `pub_*`, sees the owner canary through `own_*` and never the withheld canary.
- [ ] [CI] Audience filter at every join: an owner-audience reference (LU-4-style, `source_id` owner) and an owner forecast run attached to a public series are visible in `own_reference` / `own_forecast_run` and absent from `pub_reference` / `pub_forecast_run`; a station whose only series is owner-audience is absent from `pub_station`; a series that narrows a public source to `owner` or `off` disappears from `pub_*`. The DB rejects an `owner` source without `private_basis`.
- [ ] [CI] RWS `99`/`0.0` and PEGELONLINE `99999` never appear as values.
- [ ] [CI] The NL-4 converter on the 15-4-2026 workbook yields 1,542 rows after deduplication (from 6,245), with 237 H and 27 Q location codes. Lobith Q's Normaal/Verlaagd bound is 1,400 m³/s on 15 May and 1,000 m³/s on 15 September, while the `Gehele jaar` bounds (4,450 / 5,400 / 8,100 / 11,800 m³/s) apply on both dates. An overlap fixture resolves to the row with the lower `Priority` number. Coverage of the curated list is reported as 49/54 H and 14/18 Q (amended in §14: 61/69 H and 15/18 Q against the series P1 captures).
- [ ] [CI] The datum function returns "not converted" for IGN69 and NGF-1884 series.
- [ ] [CI] Drift simulation: a mutated payload is quarantined and raises an alert, other payloads still load, and a replay after the fix loads it.
- [ ] [CI] On the synthetic seed (3,000 series × 60 days), Q1 "all series at T" runs in < 50 ms.
- [ ] [agent-prod] `/api/v1/health/sources` is green for DE-1 and NL-1. ≥ 95% of tier-1 series have an `obs_latest` age < 45 min (DE-1) or < 60 min (NL-1) (amended in §14: each NL-1 series against its own `staleness_limit`).
- [ ] [agent-prod] Loader lag p95 < 2 min, as reported by health.
- [ ] [agent-prod] The Eijsden-grens twin TAW − NAP = 233 ± 1 cm for every aligned timestamp over 7 days (twin status in health).
- [ ] [agent-prod] The production replay since P1 is complete: health lists a checksum per partition and 0 unexplained quarantined payloads.
- [ ] [owner] **Outage drill:** `rws-drill stop-capture 2h`, then restart. Q7 (in health) reports **0 missing buckets** for tier-1 DE-1 and NL-1 series over the window.

**Providers / rivers**
- DE-1: the Rhine from Rheinweiler/Kehl to Emmerich; the federal Moselle, Saar, Main, Neckar, Lahn and Ruhr; the Ems.
- NL-1, NL-2 and NL-4: Bovenrijn, Waal, Pannerdensch Kanaal, Nederrijn-Lek and IJssel; the Maas from Eijsden to Lith; the Overijsselse Vecht and Geul; tidal stations (flagged).

**Risks**
- *Model mistakes propagate everywhere.* Fable builds from `/plan`, Opus reviews at `max`, and replay makes fixes possible.
- *Late DST coverage.* DST fixtures are synthetic now, and the real 10-25 payloads are added in P5.
- *NL-1 stalls or limit changes.* Health alerts and the contract check.
- *Retention pruning deletes too much.* Dry-run for a week, and the "forever" classes are covered by tests.
- *An owner row leaking through a join* (a public station classed by an owner threshold, an owner run in a public forecast). The audience filter at every join, the per-join tests and the canaries.

**Review focus**
- *Code review:* transaction boundaries; `IS DISTINCT FROM` with the revision CTE; rollup correctness under late revisions; the manifest cursor under a crash; parser disambiguation for the DST hour; the unit and datum declarations for every DE-1 and NL-1 series; mirror handling; the NL-4 converter against the §2.1 specification (season union, priority direction, slug deduplication, bounds from `From`/`To`).
- *Security review:* parameterised SQL only; the `SECURITY DEFINER` `search_path`; role grants against the views, including that no public role can reach `own_*` and that `rws_owner_api` (unrelated to the object owner `rws_owner`) is read-only; that every `pub_*` view applies the audience filter at every join; `pg_hba`; parser resource limits; replay CLI input handling; retention deletion constrained to the `raw/` root.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `fable` (start in `/plan`) | xhigh | The hardest and most consequential design: canonical model, time, unit and datum semantics, idempotency and revisions. Errors silently corrupt the only archive, and every adapter copies the pattern |
| Code review | `opus` | `/code-review max` | An independent strong model at maximum effort. Correct normalisation outweighs cost, and the diff is bounded |
| Security review | `sonnet` | xhigh | Mostly internal surface (DB roles, SQL, parser limits) with well-known checks |

---

### P3 · Map spike and self-hosted basemap

**Window:** 10-05 → 10-09 · **Lane:** geo · **Depends on:** P0 (P1b for the VPS job) · **PRs:** one

**Goal.** Settle the unverified map facts before any web phase:
- the Protomaps style package `@protomaps/basemaps` 5.7.2 with v4 tiles;
- MapLibre 6 under the strict CSP, after the CSP bundle was removed (§8 C23);
- WebKit with `temporal-polyfill`.

It also ships the basemap extract job and the style assets.

**Scope in**
- **`tools/geo/basemap/` and `deploy/bin/rws-basemap-refresh`**: a one-shot `basemap` job on the VPS, with egress to `build.protomaps.com` only (amended in §15: two hosts, `build-metadata.protomaps.dev` for the build list and `build.protomaps.com` for the files; the job is a role of the server image, run as two Compose jobs, `basemap` for the fetch and `basemap-promote`, without network, for the checks and the swap). It:
  - picks the newest build from `builds.json`;
  - extracts bbox `1.5,45.8,12.5,54.0` at z0–14, plus planet z0–6;
  - verifies the result and writes its sha256;
  - writes versioned files `tiles/basemap-<date>.pmtiles` and `tiles/planet-z6-<date>.pmtiles`;
  - swaps `tiles/manifest.json` atomically and **keeps the previous version**.

  A quarterly timer is installed but disabled until the owner enables it.
- **Style build** (in `geo.yml`): `@protomaps/basemaps` 5.7.2, muted light flavour, labels from `name:nl`/`name:en`, self-hosted glyphs and sprites under `/assets/map/` (amended in §15: flavour `white`, since 5.7.2 has no "muted"; the styles are generated offline and committed, and `geo.yml` only checks them).
- **Map module**: `apps/web/src/features/map/` with the `useMapLibre` hook, the `pmtiles` protocol and the worker URL set-up. A dev-only `/_spike` route renders the basemap with 200 fixture stations as `circle` + `feature-state` (amended in §15: the spike pages exist only in the e2e build).
- **Fixture**: a committed tile fixture of ≤ 5 MB (a small bbox around Lobith) for agents and CI.
- **ADR-0016**: the worker set-up (a same-origin worker URL vs `blob:`), the final CSP string, style compatibility, and the fallback if 5.7.2 is incompatible (pin an older compatible style, or our own style JSON).
- **Caddy**: `/tiles/*` with range requests and immutable caching; `/assets/map/*`.

**Scope out:** stations from the API, the time slider (P4), river lines (P6).

**Acceptance criteria**
- [ ] [CI] Playwright (Chromium, WebKit, Firefox) on the fixture tiles under the **exact production CSP**: the map renders (the canvas is not blank), there are **0 `securitypolicyviolation` events**, and **every request is same-origin**.
- [ ] [CI] The style validates against MapLibre 6.11.1's style specification and renders z4–14 of the fixture with no missing-source or missing-layer errors, or ADR-0016 records the alternative that does.
- [ ] [CI] MapLibre loads as a lazy chunk, and the worker file is served same-origin.
- [ ] [CI] WebKit with `Temporal` absent loads the polyfill, and a date-formatting smoke test passes.
- [ ] [agent-prod] `/tiles/basemap-<date>.pmtiles` answers `Range` requests with 206 and `Cache-Control: public, max-age=31536000, immutable`. `tiles/manifest.json` lists the current and previous versions.
- [ ] [owner] The extract job ran on the VPS; the log is attached and the sha256 matches the manifest.

**Providers / rivers:** OSM via Protomaps (ODbL; credit "© OpenStreetMap contributors · Protomaps").

**Risks**
- *Style incompatibility.* The ADR fallback.
- *Protomaps retention (1 week).* We keep our own extract and the previous version.
- *The 4.3 GB download.* The job resumes and is checksum-verified (amended in §15: go-pmtiles `extract` cannot resume, so every run starts clean; the sha256 is computed after the extraction, because Protomaps publishes checksums only for the full planet file, and `promote` re-checks it before a file is served).

**Review focus**
- *Code review:* job idempotency and atomic swap; manifest handling; that the hook cleans up the map on unmount; that the Playwright assertions are real (pixel check, request log).
- *Security review:* whether the CSP is minimal (`worker-src`, `img-src blob:`); no third-party origins anywhere, including glyphs, sprites and fonts; the egress scope of the basemap job; download integrity.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | New major versions (MapLibre 6, the Protomaps v4 schema) where agent knowledge is thin; a decision under uncertainty |
| Code review | `sonnet` | `/code-review high` | Small, strongly tested diff |
| Security review | `sonnet` | xhigh | The CSP becomes site-wide policy; a checklist-driven header and origin review |

---

### P4 · Walking skeleton

**Window:** 10-14 → 10-23 · **Lane:** web · **Depends on:** P2 (P4a can start once P2a is merged), P3 · **PRs:** P4a API, P4b web + deploy

**Goal.** A visitor picks a date and time and sees the DE-1 and NL-1 levels at that moment, on the production domain, in NL or EN, behind `noindex`. This brings forward the integration risks: LOCF semantics, cache headers, the CSP, WebKit and URL state. It also gives the owner a product to look at while data accumulates.

**Scope in**
- **P4a API** (Hono + zod-openapi, `packages/contracts`):
  - endpoints `/api/v1/meta`, `/api/v1/stations`, `/api/v1/snapshot?t=`, `/api/v1/series/{id}` and `/api/v1/openapi.json`;
  - the validation and limits of A§9.2: `t` needs an offset, ≤ 32 characters, quantised to 10 min, within [`displayStart`, now]; unknown parameters → 400;
  - `Cache-Control` per age class;
  - LOCF within `staleness_limit` (Q1);
  - the LRU and singleflight;
  - the `rws_api` role.
- **P4b web**:
  - MapLibre on the self-hosted basemap, with stations as `circle` + `feature-state`;
  - the time selector: a date picker, a time input and a scrubber in 10-min steps with play and step controls, a CET/CEST label and UTC `?t=` in the URL (D11);
  - `displayStart` from `meta` (D9), with the epoch marker;
  - a station panel with a lazy ECharts H/Q chart;
  - NL at `/` and EN at `/en/`;
  - the table view as the no-WebGL2 fallback;
  - a beta banner, footer attribution from `meta` sources, and the disclaimer "Geen officiële waarschuwingsdienst / Not an official warning service".
- **Caddy**: `/api/v1/*` proxy and `X-Robots-Tag: noindex`.
- `scripts/verify-prod.sh` extended to cover the API and cache headers.

**Scope out:** other providers (P5), classes (P7), forecasts (P8), the static publisher (P9), rivers (P6).

**Acceptance criteria**
- [ ] [CI] `/snapshot?t=<now−1d>` equals a direct SQL LOCF computation for 50 random series (seeded database).
- [ ] [CI] Each of these returns **400 without any DB query** (spy): `t` without an offset, longer than 32 characters, before `displayStart`, in the future, or with an unknown parameter.
- [ ] [CI] `Cache-Control` is asserted for each age class.
- [ ] [CI] On the synthetic seed, `/snapshot` p95 is < 50 ms warm and < 150 ms cold; `/series` over 14 days raw is < 50 ms.
- [ ] [CI] Playwright (Chromium, WebKit, Firefox):
  - NL is the default, and switching to EN keeps `t` and `s`;
  - the slider updates `?t=` and the marker states;
  - a deep link restores the view;
  - the slider is keyboard-operable;
  - **02:30 CEST and 02:30 CET on 2026-10-25 are distinct selectable instants**;
  - the table fallback renders with WebGL2 disabled;
  - 0 CSP violations; only same-origin requests; axe finds 0 serious or critical issues.
- [ ] [CI] A fixture station named `<img src=x onerror=alert(1)>` renders inert, in the popup, the panel and the chart tooltip.
- [ ] [CI] Initial JS ≤ 250 KB gzip, excluding the lazy MapLibre and ECharts chunks.
- [ ] [agent-prod] `verify-prod.sh` passes, with noindex present. `/` shows DE-1 and NL-1 stations whose latest value is ≤ 45 min old. `/api/v1/openapi.json` is served.

**Providers / rivers:** DE-1 and NL-1 (the German Rhine chain, its federal tributaries, the Dutch branches and the Maas).

**Risks**
- *MapLibre's weekly releases.* Exact pin and WebKit e2e.
- *LOCF misunderstandings.* SQL-equivalence tests.
- *The public surface arriving early.* Opus security review, noindex, strict validation.

**Review focus**
- *Code review:* LOCF and staleness semantics; quantisation and the cache-key space; typed search-parameter validation; DST display; lazy-chunk boundaries.
- *Security review:* input validation before any DB access; cache-key and poisoning risks; DoS through spans; CSP and header regressions; no HTML sinks; the error bodies leak no stack traces.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | A full-stack slice on new majors (MapLibre 6, Vite 8, TanStack Router) |
| Code review | `sonnet` | `/code-review xhigh` | Independent. The LOCF, cache-header and URL-state checks are concrete and testable |
| Security review | `opus` | high | The first public attack surface. A stronger model in a fresh security-only session |

---

### P5 · Open observation adapters

**Window:** 10-17 → 10-30 · **Lane:** data · **Depends on:** P2 · **PRs:** P5a FR-1/FR-3 + CH-1/CH-2/CH-3; P5b DE-7/DE-8 + LU-1/LU-6 + twins, deduplication and the DST regression set; **P5c owner-audience adapters: SPW BE-3 and AGE LU-2/LU-3/LU-4** (moved out of P13; D22)

**Goal.** Parse every remaining open observation source from the archive, starting at the seeds, and publish each physical gauge exactly once. Parse the owner-audience sources captured since P1 for the owner view, without any of their rows reaching a public output.

**Scope in**
- **P5a**
  - **FR-1**:
    - H mm → cm and Q l/s → m³/s;
    - `Link: next` pagination and HTTP 206;
    - rows with `code_station: null` (site-level Q) are dropped;
    - foreign-station mirrors become `mirror` **only where the operating agency's own feed is ingested and public**. The Belgian partner stations of §0.6 are `primary` until BE-1/BE-2/BE-3 go public in P13 (their operators are all gated), in both audiences; in the owner view the SPW series of the same gauges are twins (P5c);
    - negative Q is flagged, not dropped;
    - gauge-zero metadata is stored but not trusted.
  - **FR-3**: the ~2-month seed loaded as twin and gap-fill.
  - **Ungated Belgian set** (catalogue §0.6; registry rows with the P0b fields):
    - NL-1 (the P2b adapter; registry rows only): `antwerpen` (tidal, H forecast), `lixhebiefaval`, `maaseik` (H, Q F006, H and Q forecasts), `herenlaak`, `lanaken` (H forecast), `kanne` (Q; water body unverified, §10 R9) and `smeermaas.zuidwillemsvaart` (canal intake, H and Q). `sasvangent` is in NL, not Belgium;
    - FR-1: the **18 NL-bound Hub'Eau partner stations** with commune 99131 (Chiers at Athus and Torgny, Ton at Harnoncourt; Semois at Membre, Tintigny, Chiny, Bouillon, Sainte-Marie, Straimont; Viroin at Treignes, Couvin, Nismes; Houille at Felenne; Thure at Bersillies-l'Abbaye; Hante at Beaumont and Wiheries; Trouille at Givry; Lys at Menen-Ropswalle). Excluded: `E240041201` Escaut at Tournai and `D021000101` Sambre at Solre-Erquelinnes (registered, no data) and the Yser at Roesbrugge (not NL-bound).
  - **CH-1**:
    - SPARQL results with fixed `+01:00`;
    - W in m ü. M. LN02 with `value_kind=level`;
    - relative gauges flagged;
    - duplicate observations per station resolved to the latest;
    - `cube.link/Undefined` means no danger level.
  - **CH-2**: live values as a twin, with strings like `"2500 m³/s"` parsed.
  - **CH-3**: the 40-day seed.
  - **Tier-1 FR and CH registry** from §3.1–§3.4.
- **P5b**
  - **DE-7**:
    - ZIP with count, size and path caps (§6.7: ≤ 10 allowlisted members, ≤ 200 MB uncompressed, ratio ≤ 50:1, streamed; `pegeldaten.zip` is 10.1 MB → 128 MB; UTF-8 for `pegeldaten.zip`, Latin-1 for NRW metadata);
    - fixed `+01:00`;
    - placeholder IDs (`1234567`, …) ignored;
    - WSV duplicates (`site_no` 102) deduplicated against DE-1;
    - W only;
    - the cadence rises to 15 min once the pruner is live.
  - **DE-8**: station master data (PNP, DHHN2016).
  - **Tier-1 LU registry** from §3.2, and the DE-7 stations not already in the P2 DE registry, with every P0b station-registry field.
  - **LU-1**:
    - the wide table with naive `Europe/Luxembourg` times and DST disambiguation by column order;
    - the **15-minute label offset detected daily against the DE-1 Perl twin**;
    - Esch-Sûre in m → cm;
    - stations matched by name to the **LU-6** geometry;
    - **third-party gauges inside the CSV** (LfU RLP Bollendorf and Gemünd; WSV Perl; Service de la navigation) are narrowed per series: Perl comes from DE-1 (precedence), and the RLP-operated gauges are narrowed to `off` (withheld in both audiences) until C4 confirms that the AGE CC0 covers them (§0.2, §0.8) or RLP consents (C11).
  - **DST gate** (A§7.4; catalogue §0.3): LU-1 is enabled in `load` only after its synthetic fall-back (repeated 02:00–02:59 local) and spring-forward fixtures pass. The same gate applies to every later offset-less parser (DE-6 in P7, DE-3 in P8, DE-10/DE-12/DE-13 in P13).
  - **Twin-check job**, covering the twins of A§7.4 item 7.
  - **Precedence rules** of A§7.4 item 6, with a registry test.
  - **Real 2026-10-25 payloads** from the archive for DE-1, NL-1, NL-2, FR-1, CH-1, DE-7 and LU-1, added as regression fixtures.
- **P5c owner-audience adapters** (D22; ADR-0017; catalogue §0.8, §2.4 BE-3, §2.6). Every row these adapters write has effective audience `owner`, and none reaches a `pub_*` view.
  - **Shared KiWIS client** `adapters/_shared/kiwis/` (moved from P13): value layers; `getTimeseriesValues` in batches of ≤ 100 `ts_id`s with `timezone=UTC` and ≤ 250,000 values per call; timeouts of 60–120 s; metadata daily; no wildcard listing on the hot path; `ts_path` resolved at start-up. P13 adds the OAuth2 token and credit budget for HIC and VMM.
  - **BE-3 SPW**:
    - groups 1962373 (`H`, `H_sonde`, `Habs`, `Habs_sonde`) and 1962340 (`Q`, `QADM`); `H` in m relative to the gauge zero → cm; `station_gauge_datum` in m DNG (= TAW) with `9999.0` as unknown (no conversion); `Habs` absolute m DNG;
    - `QADM` is hourly and its trailing future step (`null`/`-1`) is dropped;
    - quality codes: 200 → raw, below 200 → validated, 205/210 → provider-suspect, 253 dropped;
    - keyed on `station_no`/`site_no`, never on names (HASTIERE on the Hermeton vs Hastière; DCENN "Dinant" on the Fonds de Leffe);
    - the navigable Meuse and Sambre are weir-controlled: flagged `impounded`, Q preferred for the flow signal;
    - attribution "Sources des données : Service public de Wallonie (SPW)", linked to hydrometrie.wallonie.be;
    - **catch-up** from 2026-08-24 (the seed start of the public sources) within ≤ 250,000 values per call, paced at 1 request per 5 s, off-peak;
    - station registry rows (identification only) for the tier-1 Walloon gauges of catalogue §3.3–§3.4, with `audience: owner`.
  - **LU-2 AGE**: per-station JSON with offset timestamps; `ts_path` as the ID; Esch-Sûre in m; omitted values are gaps, not zeros; a **twin of LU-1** in both audiences, never primary. The LU-1 label-offset detector keeps using the public DE-1 Perl twin; the LU-1 ↔ LU-2 comparison is reported in the owner status only.
  - **LU-3 AGE** parse and normalise: the slug rules of §2.6 (`Ettelbrück-/-Alzette` → `ettelbruck-alzette`, Gemünd → `gemund-our`); p10/p30/p50/p70/p90; no issue time, so the run key is (series, first step, content hash); the Moselle floors (Perl 250, Stadtbredimus 260, Wasserbillig 220 cm) flagged `below_floor` (tested on synthetic fixtures; those three runs are LfU RLP's and are captured only after C4 or C11); `forecastsLimit` (h24/h48) kept as the display limit. Loading into `forecast_run` is enabled in P8a.
  - **LU-4 AGE** parse and normalise under the §6.7 HTML rule (only the `data-to-json` attribute; scripts never run): `levelsMax` yellow/orange/red in cm (0 = undefined), `newVigilanceList` HQ2…HQ100 as levels in cm, `zeroScale` (m NN) with its `serviceDate`, `pk`, `forecastsLimit`; invalid coordinates (Hesperange) fall back to LU-6 geometry. Loading into `reference_value` (with `source_id` LU-4) is enabled in P7a.
  - **Synthetic fixtures.** The repository is public by default (D7), so committed fixtures of BE-3, LU-2, LU-3 and LU-4 keep the real structure but carry generated values, and each carries a `synthetic: true` marker. `pnpm fixtures:synth` derives them from archived payloads, and the real payloads stay in the raw archive.
  - **Health**: public health shows only the aggregate `owner_sources` count; per-source owner health is written to the owner status from P9a.

**Scope out:** references, classes and warnings (P7); forecasts (P8); gated sources (P13); the owner publisher, API and UI (P9, P10).

**Acceptance criteria**
- [ ] [CI] Each P5a and P5b adapter has ≥ 3 real fixtures with golden outputs and ≥ 90% coverage of parse and normalise.
- [ ] [CI] FR-1: 491 mm → 49.1 cm and 17,300 l/s → 17.3 m³/s; pagination across 2 pages plus a 206 response works; null-station Q rows are dropped; negative Q gets a flag.
- [ ] [CI] CH-1: `2026-09-23T20:40:00+01:00` → `19:40Z`; duplicate observations resolved; relative-gauge flag set.
- [ ] [CI] DE-7 zip-bomb and zip-slip fixtures are rejected, and placeholder IDs are ignored.
- [ ] [CI] An LU-1 fixture containing the 2026-10-25 repeated hour parses to monotonic UTC with no duplicates, and the offset detector finds +15 min on a fixture.
- [ ] [CI] Every real 2026-10-25 payload listed above passes as a regression fixture.
- [ ] [CI] DST gate: a registry test enumerates every adapter whose time convention is `naive-local`, `local-labelled-Z` or `start-of-interval` and fails unless it has both a synthetic fall-back fixture (the repeated local hour) and a spring-forward fixture (the missing hour) with golden output, **before** `load` enables it.
- [ ] [CI] A registry test shows no physical gauge published twice, and the precedence rules hold: Basel from CH-1; Konstanz and FR-1 foreign copies unpublished where the operator's own feed is public (the §0.6 Belgian partner stations stay published until P13); Perl from DE-1. The RLP gauges inside LU-1 are `off` (withheld) until C4 or C11 is answered.
- [ ] [agent-prod] The §0.6 ungated Belgian set is published: the 7 RWS Belgian points and the 18 NL-bound Hub'Eau partner stations appear in `/api/v1/stations` as `primary`, and ≥ 90% of them have a value younger than 3 h.
- [ ] [agent-prod] Twins in health:
  - Chooz FR-1 vs FR-3 |ΔH| ≤ 1 cm;
  - Uckange Q equal after unit conversion;
  - Basel CH-1 vs the DE-1 mirror (240.00 m + W/100) ≤ 1 cm;
  - Perl LU-1 (offset-corrected) equals DE-1 for ≥ 99% of timestamps, with the detected offset reported.
- [ ] [agent-prod] Health is green for FR-1, CH-1, DE-7 and LU-1. Coverage from seed or epoch to now is ≥ 95% of expected buckets on tier-1 series, with provider gaps listed from `ingest_batch`.
- [ ] [agent-prod] The CH-1 interval is never below 10 min (from manifest timestamps). DE-7 runs at 15 min, and the bytes per day are within budget.
- [ ] [CI] (P5c) BE-3, LU-2, LU-3 and LU-4 meet the fixture standard above (≥ 3 fixtures with golden outputs, ≥ 90% coverage of parse and normalise), and a test fails if any committed fixture of an `owner`-audience source (these four, plus DE-2 and DE-3 from P8 and every later `owner` source) lacks the `synthetic: true` marker or is byte-identical to an archived payload.
- [ ] [CI] (P5c) BE-3: `timezone=UTC` stamps parse to UTC; H m → cm; `9999.0` datum → unknown and no conversion; the trailing `QADM` `null`/`-1` is dropped; quality 200 → raw and 205/210 → suspect; the HASTIERE/Hastière and two "Dinant" fixtures resolve by `station_no`; KiWIS batches never exceed 100 `ts_id`s or 250,000 values.
- [ ] [CI] (P5c) LU-2: a fixture spanning the 2026-10-25 repeated hour parses to monotonic UTC; LU-2 equals LU-1 after the detected label offset (twin), and LU-2 is never `primary`. LU-3: the slug fixtures resolve; p10 ≤ p30 ≤ p50 ≤ p70 ≤ p90 or a QC flag; the Perl floor is flagged `below_floor`. LU-4: only `data-to-json` is read (a page with a script and a decoy attribute yields the same records), `levelsMax` 0 → undefined, and Hesperange takes the LU-6 geometry.
- [ ] [CI] (P5c) Audience: every BE-3, LU-2, LU-3 and LU-4 row has effective audience `owner` and none is visible through a `pub_*` view; a registry test shows no physical gauge published twice in either audience, with the SPW-operated §0.6 partner stations and LU-2 as twins.
- [ ] [agent-prod] (P5c) Public `/api/v1/health/sources` reports `owner_sources.healthy` = `owner_sources.total` and lists no owner source ID; `/api/v1/stations` contains no BE-3 or LU-2 station.

**Providers / rivers**
- FR-1/FR-3: Rhine and Ill, Moselle, Meurthe, Sarre and Nied, Meuse, Chiers, Semoy, Sambre, Escaut, Scarpe, Lys.
- CH-1/2/3: Alpine Rhine, Bodensee, High Rhine, Thur, Aare, Reuss, Limmat, Birs; Basel 2289.
- DE-7/8: Rur, Wurm, Niers, Schwalm, Issel, Bocholter Aa, Berkel, Dinkel, upper Vechte, upper Ems, Lippe, Sieg, Erft.
- LU-1/6: Moselle, Sûre/Sauer, Our, Alzette.
- BE without permissions (§0.6), about 25 points: the Zeeschelde at Antwerp, the Meuse at Lixhe, the Grensmaas (Maaseik, Herenlaak, Lanaken), Kanne and the Zuid-Willemsvaart intake (NL-1); the Chiers, Ton, Semois, Viroin, Houille, Thure, Hante, Trouille and the Lys at Menen (FR-1). On the public site the Walloon Meuse between Chooz and Lixhe, the Scheldt between Maulde and Antwerp, the Dender and the Kempen rivers stay empty until P13.
- Owner view only (P5c): BE-3 on the Walloon Meuse (Chooz → Lixhe), Sambre, Ourthe, Vesdre, Amblève, Semois and Walloon Escaut; LU-2 as the LU-1 twin; LU-3 and LU-4 on the Sûre, Alzette, Our and Moselle.

**Risks**
- *Naive local time at DST, and a silent fix to the LU offset.* Daily detection, twins and the DST gate.
- *Undocumented hydrodaten (CH-2) and the LINDAS "Draft" status.* LINDAS stays primary, CH-2 is a twin, and the contract check watches both. Whether BAFU accepts polling of the hydrodaten files is asked in C13 (§10 R5); if BAFU objects to public use, CH-2 moves to the owner audience and CH-1 alone remains public (D22, catalogue §0.8), and only a request to stop fetching stops its capture.
- *ZIP and CSV brittleness.* Fingerprints and quarantine.
- *Unclear RWS `kanne` series* (Jeker/Geer or canal; §10 R9). Published with its RWS name only, no river assignment until C7 answers; snapped by override in P6.
- *Real SPW or AGE values in the public repository* (P5c). Synthetic fixtures with a marker and a byte-identity check against the archive.
- *SPW group contents and KiWIS IDs changing without notice.* `ts_path` resolved at start-up, daily metadata, and quarantine on an unknown series.
- *An owner-audience row reaching a public view through a new join.* The P2 audience tests plus the P5c audience criterion.

**Review focus**
- *Code review:* unit factors per series; DST disambiguation and the DST gate; the offset detector's statistics (window, robustness, alert on change); precedence and alias correctness; mirror exclusion, and the §0.6 exception for Belgian partner stations; pagination termination; for P5c, the KiWIS quirks (UTC, `QADM`, datum `9999.0`, quality codes, same-name stations), the LU-3 slug and floor rules, and that owner twins never become primary.
- *Security review:* ZIP extraction limits; SPARQL response handling, and that no query is built from data; CSV injection that could reach any output; resource exhaustion in wide CSVs; for P5c, the HTML rule for LU-4 (`data-to-json` only, no script execution), KiWIS response size limits, that no committed fixture holds real owner-audience values, and that every owner row stays out of `pub_*`.

P5c uses the P5 build model and the default P5 reviewers (as P5a): `opus` xhigh, Sonnet `/code-review xhigh`, Sonnet xhigh security review.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Four dissimilar formats (paged JSON, SPARQL, zipped CSV, wide local-time CSV), each with a silent-corruption trap |
| Code review | `sonnet` for P5a; **`fable` for P5b** | `/code-review xhigh` (P5a); `/code-review high` (P5b) | P5a is conformance against the P2 pattern and the pitfall lists. P5b carries the LU DST and offset logic and deduplication, where a miss silently shifts data |
| Security review | `sonnet` | xhigh | New untrusted-input parsers (ZIP, SPARQL, CSV), checked against a checklist |

---

### P6 · River network, snapping and chainage

**Window:** 10-12 → 11-06 · **Lane:** geo · **Depends on:** P2 (P6b also needs the P5 station registry) · **PRs:** P6a graph pipeline (10-12 → 10-24); P6b snapping, chainage and tiles (10-26 → 11-06)

**Goal.** A directed river graph with the Rhine-delta bifurcations for every river that feeds the Netherlands, with stations snapped to it and given chainage, and a river overlay tileset. This is the basis for "see the water flow".

**Scope in**
- **P6a**
  - `registry/rivers.yaml`: the curated OSM relation IDs from §5.3, including Rhein 123924, Meuse 1075197, Escaut 324288, Moselle 390416, Ems 370068, Main 412876, Neckar 123881, Sambre 1600647, Ourthe 2246211, Rur 384594, Lahn 412935, Saar 390393, Sieg 409090, Ruhr 364754 and Lippe 379691. It adds the Dutch branches, Aare, Reuss, Limmat, Thur, Sauer, Our, Alzette, Leie/Lys, Dender, Niers, Vecht/Vechte, Dinkel and Berkel. The Nahe and Lys are resolved by hand. It also adds the rivers that carry the §0.6 ungated Belgian points (Semois/Semoy, Chiers, Ton, Viroin, Houille, Thure, Hante, Trouille) and, for P13 and D21, the Kempen rivers that enter NL directly (Mark, Dommel, Aa/Weerijs, Warmbeek/Tongelreep, Keersop, Merkske) and the Voer, plus the RLP tributaries (Ahr, Kyll, Prüm).
  - **River names** (catalogue gap item 19): each river in `rivers.yaml` has a reviewed `name_nl` and `name_en` (Maas/Meuse, Moezel/Moselle, Sûre/Sauer, Schelde/Scheldt, Leie/Lys …), seeded from OSM `name:nl`/`name:en` and Wikidata. Provider-published names stay in `names` as published.
  - **`geo.yml`** (manual and monthly), because Geofabrik and Overpass are unreachable from agent sandboxes:
    - download the Geofabrik PBFs (NL, BE, LU, CH, DE states in the basin, FR Grand-Est and Hauts-de-France) and verify their md5;
    - `osmium tags-filter` → `osmium export -f geojsonseq`;
    - run the TypeScript graph builder (`tools/geo/rivernet/`).
  - **Graph builder**:
    - nodes are shared OSM nodes, and edges are ways as drawn;
    - keep `main_stream` ways, and empty-role ways that connect;
    - check for cycles;
    - allow **several downstream edges** (Pannerdensche Kop, IJsselkop);
    - EU-Hydro `NEXTDOWNID` QA through its REST API, with a buffer of about 200 m;
    - write a QA report.
  - **Outputs**: `river_graph.json`, `reaches.geojson` and the QA report, published as release assets `geo-<date>`. A committed fixture PBF is used for agent and CI tests.
- **P6b**
  - **Snapping**: water-body name or Wikidata match plus ≤ 500 m, **never distance alone**, with a manual override table (`registry/snap-overrides.yaml`). The canal points of §0.6 (`smeermaas.zuidwillemsvaart`; `kanne` until §10 R9 is answered) are placed only through the override table and never on the Meuse.
  - **Chainage**: official km first (DE-1 `km`, RWS rkm); otherwise the graph distance to an NL entry node (Lobith, Eijsden, the Scheldt border, the Dollard, the Vecht border). Stored as `(river_id, km_official, km_system, km_to_nl_entry)`.
  - **Reaches**: segmented at snapped stations, with `tidal` and `impounded` flags and indicative travel-time ranges from §3.7. Owner-audience stations (P5c) are snapped and get chainage like any other, but the public `reaches-<ver>.json` and `rivers.pmtiles` are segmented at public stations only; the owner view's extra split points are applied by the owner publisher (P11).
  - **Tiles and downloads**: `rivers.pmtiles` via tippecanoe (< 30 MB), `/data/v1/rivers/reaches-<ver>.json`, the ODbL download `/downloads/rivers-<ver>.geojson.gz`, and the attribution and licence page text.
  - **Registry**: river fields synced into `registry/stations/*.yaml`.

**Scope out:** rendering and animation (P11); empirical travel-time calibration (P14).

**Acceptance criteria**
- [ ] [CI] On the fixture PBF, the graph is acyclic, the Pannerdensche Kop has 2 downstream edges, and two runs on the same input produce byte-identical outputs.
- [ ] [CI] Canal-trap fixtures (Julianakanaal, Albertkanaal, Bijlandsch Kanaal, Grand Canal d'Alsace) produce 0 name-mismatched snaps. A golden list of 50 hand-checked stations snaps 100% correctly.
- [ ] [CI] The §0.6 Belgian points snap to their own rivers (Semois, Chiers, Viroin, Lys at Menen, Grensmaas); `smeermaas.zuidwillemsvaart` and `kanne` never snap to the Meuse. Every river in `rivers.yaml` has a non-empty reviewed `name_nl` and `name_en`.
- [ ] [CI] km values are monotone from upstream to downstream along the Rhine (Basel → Lobith), the Meuse (Chooz → Lith) and the Moselle (Uckange → Koblenz).
- [ ] [CI] Paths exist from Basel 2289, Trier, Raunheim (Main), Chooz and the Escaut FR-1 gauges to the NL entry nodes, and Basel → Lobith → {Waal, Nederrijn-Lek, IJssel} is traversable.
- [ ] [CI] The SPW Meuse gauges (P5c registry rows) snap to the Meuse in km order between Chooz and Lixhe, and neither `reaches-<ver>.json` nor `rivers.pmtiles` references any owner-audience station.
- [ ] [agent-prod] A `geo.yml` run on the full PBFs succeeds: ≥ 98% of edge directions agree with EU-Hydro, every disagreement is listed, and `rivers.pmtiles` is < 30 MB.
- [ ] [agent-prod] `/tiles/rivers-<ver>.pmtiles` and the ODbL download are served, with the attribution text present.

**Providers / rivers:** OSM (ODbL) and EU-Hydro (QA only); official km from DE-1 and NL-1. All rivers in scope.

**Risks**
- *Inconsistent OSM relation roles* (Moselle, Escaut). Clean-up rules plus overrides.
- *ODbL share-alike.* The graph is published under ODbL, and station data stays a separate collective database.
- *PBF size in Actions.* Regional extracts and a cache.

**Review focus**
- *Code review:* bifurcation handling; snapping rules and overrides; km direction per river; determinism.
- *Security review:* workflow permissions and download integrity (md5); the tool image's supply chain; ODbL and attribution compliance.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Subtle topology work: bifurcations and canal-aware snapping |
| Code review | `sonnet` | `/code-review high` | Golden lists and graph invariants make the review concrete |
| Security review | `sonnet` | medium | An offline tool with no runtime surface |

---

### P7 · References, classes, warnings and honest classification

**Window:** 10-31 → 11-09 · **Lane:** data · **Depends on:** P5; P7b also on owner decision D18 (crosswalk sign-off) · **PRs:** P7a reference, class and warning parsers; P7b classification engine

**Goal.** Every published value carries an honestly derived state and a visible `basis`. Operational thresholds, statistical references, provider classes and warnings from every open source are stored with validity ranges.

**Scope in**
- **P7a**
  - **DE-1** characteristic values (MNW, MW, MHW, NNW, HHW, HSW, GlW, Marke I–III, with periods) and gauge-zero changes. Resolve §8 C22 live before use.
  - **NL-4** mapping to stations. NL-4 rows are **Waterinfo display classes, not alert levels** (catalogue §2.1, C39): their basis label says so ("RWS Waterinfo-legenda, geen officiële waarschuwing / RWS Waterinfo legend, not an official warning").
  - **CH-2** `wl_1…wl_4`, which are **discharge-based** (m³/s); **CH-1** `dangerLevel`; **CH-5** warning sections. They are public under the BAFU conditions (catalogue §0.8) unless BAFU objects in its C13 answer; silence by the go/no-go date (10-31) keeps them public. If BAFU objects to public use, CH-2 and CH-5 move to `audience: owner` (the owner view keeps them) and the public fallback is CH-1 `dangerLevel` plus **CH-6**, the open geo.admin.ch class layers and national warning map (opendata.swiss "Open use", no permission needed). CH-6 then gets a capture spec, an adapter and a per-source allowlist entry for `data.geo.admin.ch` (a catalogue §6.7 host) in this phase; it is not a P13 source. Only if BAFU asks us to stop fetching the files does their capture stop.
  - **FR-5** tronçon vigilance, mapped to stations through the **downward link `TronEntVigiCru` `aNMoinsUn`** (catalogue §2.5, C38; the upward `StaEntVigiCru` link is a placeholder, `"A renseigner"`): 56 sections and 331 stations in territories 2, 3 and 29, each station in exactly one section. A spatial join to the `InfoVigiCru` MultiLineStrings is a cross-check only, with a manual override table. The parser accepts both the current lowercase property names and the older casing (`LbEntCru`, `AcroEntCru`, `TypEnSup_1`). No Vigicrues section covers the French Escaut, Scarpe or Deûle, so those stations get no FR-5 class. `CruesHistoriques` are stored as historical references.
  - **DE-7** `LANUV_MNW/MW/MHW`, `LANUV_Info_1..3` and `alarmlevel`.
  - **DE-6** LHP classes and alerts: stored on change, refreshed at least every 10 min, with LHP colours kept. Per catalogue §0.4 and §4.9:
    - the station `lhpClass` is an integer −1…4; **a feature without an `lhpClass` key** (216 live, "Ohne Hochwasser-Einstufung") is `no_ref` (the catalogue writes `no-ref`), not an error;
    - the **alert** `lhpClass` is a **string** on a different scale (1 Entwarnung, 2 Vorwarnung, 4 Hochwasser, 5 Großes, 6 Sehr großes Hochwasser; no 3); alert geometry is Polygon or LineString; alerts carry no issue or validity time, so validity starts at the collection's `updated`;
    - **duplicates across states** (Worms, Perl, Kaub, Mainz, Kleinheubach, Obernau, Havelberg): group by the numeric part of the id and position (< 500 m); take the class from the state that operates the gauge (RP for Worms, Mainz, Kaub and Perl); if it reports −1 or nothing, use the worst other class and record its provenance ("class from LHP/HE");
    - the feature `timestamp` is offset-less local time, so the DST gate of P5 applies.
  - **LU-5** CAP: filter on `[AGE]`/`FLOOD`; drop `TEST` by `cb-eu-level` and headline, **not** by `<status>` (a TEST message carries `Actual`); resolve `Cancel` messages, which have no `<info>`, through `<references>` (`[AGE],<identifier>,<sent>`); map `ALERT_LVL_1…4` (inverted: 1 is red); keep all three language blocks (fr-FR, de, en-US) and `expires`; parse XML with entities off; store zone polygons.
  - **Provider label table** (catalogue gap item 19): `registry/labels/<SOURCE-ID>.yaml` maps every provider class and alert label (FR, DE, NL; CH de/en) to a reviewed NL and EN text. The raw label is always stored and shown beside our translation.
  - **Flood fixtures** (catalogue §0.4) for every class and warning parser: the LHP test server (`…/public/v1/test/data/{stations,alerts}`: the 2024-01-25 flood, station classes 1–3, alert classes 1/2/4/5) plus hand-edited class-4 stations, class-6 alerts and class-less features; the real AGE LU-Alert flood alerts from the archive (red Sud 2025-09-08/09, Moselle 2026-02-13/14) with a Cancel and a TEST; the Wayback `InfoVigiCru` capture of 2023-12-11 (levels 2 and 3, old casing; the capture is truncated at 1 MiB, so the committed fixture keeps only the complete features and closes the collection, a hand edit documented next to the fixture); a hand-built CH-5 flood section (no archived capture, §10 R2).
  - **Owner-audience references** (D22; parsers from P5c), stored with `source_id` and effective audience `owner`, so they never reach `pub_reference`:
    - **LU-4**: yellow/orange/red vigilance levels (0 = undefined, so most stations start at orange), the HQ2…HQ100 levels and the status-class bounds, attached to the LU-1 (public) and LU-2 series of each station; a change raises an alert and opens a new validity range;
    - **BE-3**: the long-term non-exceedance percentiles (`P05…P95`, `Moyen`; catalogue §4.6) as `statistical` and `CrueDeReference.Top3` as `historical`; SPW publishes no numeric alert thresholds, and `NIVCRU` is stored raw if present.
  - **Raw retention of mixed payloads**: from this phase the loader promotes every CH-1 and CH-2 payload whose class or threshold fields changed (`dangerLevel`, `wl_1..wl_4`) to the forever class, in addition to the daily copy (A§7.2).
  - Every row is stored with a validity range (`WITHOUT OVERLAPS`). A change raises an alert.
- **P7b**
  - **Pure classifier** in `packages/core` (A ADR-0009):
    - the ordinal scale plus the flags stale, suspect, tidal and impounded;
    - priority: operational > statistical > provider class;
    - **the mapping table is the catalogue §4.9 crosswalk** as signed off by the owner (D18), one row per provider class with its target level and its basis (stage, discharge or area);
    - **gauge vs area classes** (§4.9): an area class (FR-5 section, LHP alert, RLP region, LU-Alert zone, CH-5 section) colours a station only with an explicit "section" badge; where a station has both, the gauge class wins and the area class is shown alongside;
    - **per audience** (A§7.4 item 11): the classifier runs once on `pub_*` rows for the public outputs and once on `own_*` rows for the owner view. The §4.9 LU-4 rows (marked "gated") and a BE-3 percentile row apply only in the owner view. The BE-3 row is a D18 addendum; the proposal is `low` at or below P05 and `normal` otherwise, never an alert level from percentiles alone;
    - a `basis_label` on every state;
    - Δh since the window start, and the trend;
    - the "≈ m NAP ±" conversion for the detail view, **except for French stations (IGN69/NGF), which get no converted height in the first release**, nor does any station whose gauge zero comes only from Hub'Eau metadata (the §0.6 Belgian partner stations) (D16; catalogue §4.7(5), C40).
  - **Generated documentation**: the mapping table generates `docs/classification.md`.
  - **Coverage report** per country and **per audience**: the share of tier-1 stations with a class other than `no_ref`, and separately the share of `first_release` stations that get a non-grey class **from sources that need no permission** (catalogue gap item 17). The public report is published through `/api/v1/health/sources` until the P9a publisher exists, then in `status.json`, and it drives D10; the owner report goes to the owner status only (written from P9a).
  - **API**: the snapshot gains `state` and `basis`, and the P4 popup shows the basis (the full legend comes in P10).

**Scope out:** percentile climatology (P14); gated thresholds such as HIC and the DE-10 RLP alert regions (P13). (SPW and AGE LU-4 thresholds are in scope for the owner view.)

**Acceptance criteria**
- [ ] [CI] CI fails if `docs/classification.md` differs from the code's table.
- [ ] [CI] Boundary tests sit exactly at each threshold per provider. For example, Kaub at 9 cm with MNW 65 → `low`, basis "WSV MNW 2010–2020". A station without references → `no_ref`, never a guess.
- [ ] [CI] Exceedance (HIC-style) and non-exceedance (SPW-style) percentile conventions are represented and tested with synthetic fixtures.
- [ ] [CI] A changed threshold or gauge zero creates a new validity range and raises an alert. Nothing is overwritten.
- [ ] [CI] LU-5 `TEST` fixtures are excluded. XXE and entity-expansion fixtures are refused. A Vigicrues section level reaches every station in that section.
- [ ] [CI] A golden-state test covers about 30 real stations across the public providers (owner-audience references appear only in the synthetic per-audience fixtures below). Any change needs an explicit golden update.
- [ ] [CI] Every row of the catalogue §4.9 crosswalk (as signed off in D18) has a boundary test, and `docs/classification.md` lists exactly those rows with their basis (stage, discharge or area).
- [ ] [CI] Flood fixtures (§0.4) reach the expected §4.9 levels: LHP test-server stations of class 1, 2 and 3 → elevated, high, extreme; a hand-edited class 4 → extreme; alert `"4"` (string) → high, `"5"`/`"6"` → extreme, `"1"` → normal; a feature without an `lhpClass` key → `no_ref`; the Wayback `InfoVigiCru` (old casing) and a current payload with the same levels give identical classes; the real AGE red alert → extreme on zone Sud, its Cancel (no `<info>`) closes it via `<references>`, and a TEST with `<status>Actual</status>` is dropped.
- [ ] [CI] LHP duplicates: fixtures for Worms (RP 0, HE −1) and Perl (SL 0, RP −1, SL −1) resolve per the §4.9 rule, with provenance recorded.
- [ ] [CI] The FR-5 station → section table built from `TronEntVigiCru` `aNMoinsUn` has every station in exactly one section; the French Escaut/Scarpe/Deûle stations get no FR-5 class.
- [ ] [CI] Every provider class or alert label present in the fixtures has an NL and an EN entry in `registry/labels/`; an unmapped label fails CI.
- [ ] [CI] A French station and a §0.6 Belgian partner station from FR-1 (zero from Hub'Eau metadata) return no converted absolute height; an NL, DE, LU, CH or BE (TAW, fixture until BE-1 arrives in P13) station does.
- [ ] [CI] The DE-6 parser passes the DST gate of P5 (fall-back and spring-forward fixtures for the offset-less feature `timestamp`).
- [ ] [CI] **Per-audience classification:** a public LU-1 fixture station (Diekirch) with synthetic LU-4 thresholds is classed from LU-4 with basis "AGE" in the owner run, and gets its public state without them (`no_ref` or its public basis) in the public run; no public output contains an LU-4 or BE-3 basis label. A BE-3 fixture station exists only in the owner run.
- [ ] [CI] Every LU-4 crosswalk row (yellow/orange/red → elevated/high/extreme, 0 = undefined, the status classes) and the BE-3 percentile addendum row (as signed off in D18) has a boundary test run in the owner audience, and `docs/classification.md` marks them "owner view only".
- [ ] [CI] A changed LU-4 level creates a new validity range with `source_id` LU-4 and raises an alert whose text names no value (the details are in the owner status from P9a).
- [ ] [agent-prod] The coverage report is published per country (`/api/v1/health/sources`, or `status.json` once P9a is live), and 100% of displayed markers carry a basis or `no_ref`.
- [ ] [agent-prod] The DE-6 refresh interval is ≤ 10 min (manifest).

**Providers / rivers:** DE-1, NL-4, CH-1, CH-2, CH-5, FR-5, DE-7, DE-6 and LU-5 (plus CH-6 only as the C13 fallback), across every river from P2 and P5; in the owner view also LU-4 (Sûre, Alzette, Our, Moselle) and BE-3 (Walloon Meuse, Sambre, Ourthe, Vesdre, Amblève, Semois, Escaut).

**Risks**
- *Semantic misreadings*: percentile direction, "Marke", discharge-based CH thresholds. A Fable review.
- *An unsigned crosswalk.* Each agent would invent its own mapping; P7b does not start before D18 is answered (the §4.9 proposal is the default).
- *Flood code paths never seen live* (all research ran at extreme low water; §0.4). Flood fixtures now; the first real NL-bound FR-4 and CH-5 flood payloads become fixtures when they occur (owner action D7; §10 R2).
- *Marketing display classes as warnings.* NL-4 basis label and the Method page (P10).
- *NL-4 workbook changes.* Weekly hash watch.
- *An owner-audience threshold colouring a public marker.* The per-audience classifier, `reference_value.source_id` gated in the views, and the per-audience classification test.
- *Reading SPW percentiles as alert levels.* They are `statistical`, non-exceedance, and map to `low`/`normal` only (D18 addendum).

**Review focus**
- *Code review:* every mapping row against §4.6, §4.7 and the signed-off §4.9 crosswalk; the LHP station vs alert scales (never mixed) and the duplicate rule; gauge vs area precedence; unit and quantity mismatches (a Q threshold applied to H); validity-range logic; the priority order; that `no_ref` is never replaced by a guess; that the generated doc matches the code; that the classifier never mixes audiences (LU-4 and BE-3 rows only in the owner run) and that the SPW percentile direction is non-exceedance.
- *Security review:* XML parsing (XXE, billion laughs, `<!DOCTYPE` rejection per §6.7); GeoJSON size limits; that provider label strings, including the translation table, stay inert downstream; that no owner-audience reference, basis label or coverage number reaches a public output.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` (start in `/plan`, write the matrix first) | xhigh | Careful semantic mapping across seven providers |
| Code review | `fable` | `/code-review xhigh` | Honest cross-country comparison is the product's credibility. The strongest independent model challenges every mapping |
| Security review | `sonnet` | high | Little new surface: CAP XML and GeoJSON parsing behind the existing guards |

---

### P8 · Official forecasts (bi-temporal) and the future slider

**Window:** 11-06 → 11-13 · **Lane:** data · **Depends on:** P5 (P7 for display) · **PRs:** P8a run model + NL-1 + DE-2 + LU-3 loading (owner; parser from P5c); P8b CH-4 + FR-4 + DE-3 (owner) + future snapshot and slider

**Goal.** Every forecast run captured since P1 loads as an immutable bi-temporal run. The slider reaches into the near future using the latest run per series, with an honest horizon per station (decision D8).

**Scope in**
- **P8a**
  - **Run identity** of A§7.4 item 9, with `forecast/latest.json` groundwork.
  - **NL-1 `verwachting`**: no run ID, so the run is (series, first valid time, content hash).
  - **DE-2 `WV`** (owner audience until the P12 BfG gate, then public): `initialized`; values beyond 48 h are flagged `estimate`; `provider_segment_end` is set. The run-age alert is **schedule-aware**: `WV` runs on working days, and at weekends and on holidays only when Ruhrort is below 4 m [D]. How `WV` behaves above HSW / Marke II is unknown (catalogue §0.4, §10 R1; asked in C6): a missing, capped or stale run is shown as "no forecast", never extended.
  - **Fixtures of owner-audience forecasts** (DE-2, DE-3, LU-3) are synthetic, with the `synthetic: true` marker of P5c, while their sources are `owner`; the real payloads stay in the raw archive.
  - **LU-3** (owner audience; parser from P5c): runs keyed by (series, first step, content hash) with `issued_inferred`; `below_floor` values shown as "below forecastable range"; the per-station display limit `forecastsLimit` (h24/h48) respected. Only the 11 AGE-computed stations are captured and loaded; the Moselle runs at Perl, Stadtbredimus and Wasserbillig are computed by LfU RLP (catalogue §2.6) and wait for C4 or C11, like the RLP gauges inside LU-1 (DE-10 terms; catalogue §0.8).
  - **Forecast coverage** (catalogue §0.5; gap item 17), **per audience**: `/api/v1/health/sources` (and `status.json` once the P9a publisher is live) reports, per river reach of the §0.5 matrix and per country, the share of `first_release` stations with a current official forecast from public sources. First-release public forecast sources are NL-1, DE-2 (public after the P12 BfG gate), CH-4 and FR-4 (event-only); RLP (66 gauges), HIC and LUBW arrive through P13. The owner coverage matrix, written to the owner status only, adds DE-2 before the gate, DE-3 and LU-3 (Sauer/Sûre, Our and Alzette; the Mosel LU/DE runs are LfU RLP's and wait for C4 or C11).
- **P8b**
  - **CH-4**: median, 25–75% band, min/max; the run is inferred from the run start and `Last-Modified`. Only the `_de` files are fetched; traces are matched **by position and by name**, because names are language-specific ("Mediana", "Min / Max" vs "Min. / Max."). Flood fixture: the Wayback capture of 2023-11-02 (storm Ciarán; gzip-encoded; median rising to 476 m³/s, max 800 m³/s, threshold bands 700/1100/1450/1800). That capture is the **`_it` file** of station 2020, Ticino at Bellinzona (the only archived flood run; Po basin, not NL-bound), so its trace names are Italian ("Mediana", "Misurato", "Min / Max"): the trace-name table carries the `it` names for this fixture, while production still fetches `_de` only.
  - **FR-4**:
    - P10/P50/P90 with `DtProdSimul`;
    - HTTP 200 bodies that carry an error are detected;
    - the v1.1 route uses `+02:00` and the legacy route `+00:00`;
    - the only sample is a Loire station (K490003010): it is a schema fixture only; the first NL-bound forecast is promoted to a fixture when an event occurs (owner action D7; §10 R2).
  - **DE-3** (owner audience; shown in the owner view, public display in P13 once D4 is settled):
    - daily-mean quantiles stamped at the start of the interval, "GMT+1";
    - `---` is censored above 640 cm and stored as censored, not zero;
    - the "GMT+1" CSV is on the catalogue §0.3 list, so the DST gate of P5 applies.
  - **Future snapshot**: Q2 for future `t`, and `/api/v1/series/{id}/forecast?asof=`.
  - **Web**: the slider range extends to now + the station horizon, capped at 48 h. Forecast styling uses hollow markers, labelled with the agency and the issue time (or "opgehaald / fetched" when inferred). "Estimate" styling applies beyond the provider segment, and stations without a forecast show "no forecast".
  - **Display rules** in `contracts`: providers are never blended; provider display limits are respected.
  - **Owner view**: the future snapshot, `/series/{id}/forecast?asof=` and the coverage computation take their view family from `audience.ts` (A§5), so the owner API and owner publisher (P9) return DE-2 (before the gate), DE-3 and LU-3 runs and the owner coverage matrix, while the public ones never do. The owner UI renders them in P10.

**Scope out:** forecast verification statistics; our own forecasts (never); DE-2 public display, which stays owner-audience until the P12 BfG gate; **EFAS** (real-time restricted to authorised users) and **GloFAS** (open but modelled, not official), neither used in the first release (catalogue §0.5); the gated forecasts of DE-10 RLP, DE-12 LUBW and BE-1 HIC (P13).

**Acceptance criteria**
- [ ] [CI] Replay rebuilds the run history since P1 without duplicates: the run count equals the number of unique (series, first valid time, content hash) keys.
- [ ] [CI] DE-2 values beyond 48 h are flagged `estimate`. DE-3 `---` is stored as censored, never as 0. DE-3 start-of-interval GMT+1 stamps convert to UTC correctly.
- [ ] [CI] FR-4 v1.1 (`+02:00`) and legacy (`+00:00`) payloads of the same run give identical UTC values, and an HTTP-200 error body is quarantined.
- [ ] [CI] Quantiles must satisfy p10 ≤ p50 ≤ p90, and otherwise get a QC flag.
- [ ] [CI] "Latest run as of T" (Q2) takes < 50 ms on the synthetic seed.
- [ ] [CI] API: `t` in (now, now + horizon(station)] returns values from the latest run issued at or before now; `t` beyond 48 h → 400.
- [ ] [CI] Playwright:
  - moving past now switches to forecast styling;
  - the label shows the agency and issue time;
  - stations without a forecast are greyed;
  - the slider clamps at each station's horizon;
  - an owner-audience forecast (DE-2 before the gate, DE-3, LU-3) never appears on the public site or in a public API response (canary), while the same query over the owner family returns it.
- [ ] [CI] LU-3: replaying the archive gives one run per (series, first step, content hash); the Perl floor fixture is shown as "below forecastable range", never as a level; values beyond `forecastsLimit` are not displayed; LU-3 runs exist only in `own_forecast_run`.
- [ ] [CI] The CH-4 storm-Ciarán fixture (`_it`) parses to the documented median, max and threshold bands; a `_de` fixture with reordered or renamed traces is quarantined, never mislabelled.
- [ ] [CI] The DE-2 run-age alert does not fire on a weekend fixture with Ruhrort ≥ 4 m and does fire on a working day without a new `initialized`. A `WV` payload missing or truncated above HSW yields "no forecast", not a held value.
- [ ] [CI] DE-3 passes the DST gate of P5.
- [ ] [agent-prod] Health shows the latest run age per forecast source. NL-1 has had a new run within the last 7 h. CH-4 covers 55 stations.
- [ ] [agent-prod] The public forecast coverage per §0.5 reach and per country is published (`/api/v1/health/sources`, or `status.json` once P9a is live); every reach whose first-release column in §0.5 is empty shows "no official forecast" and names the agency that would provide it after a permission, or says that no agency publishes one (e.g. SPW for the Walloon Meuse). It names no owner-audience source.
- [ ] [CI] The coverage computation over the owner family fills the Sauer/Sûre and Our reaches from LU-3 (the Mosel LU/DE reach stays empty until C4 or C11) and the Rhine Maxau → Emmerich reach from DE-2 and DE-3, while the public matrix is unchanged by them (the owner matrix is written to the owner status from P9a).

**Providers / rivers**
- NL-1: Lobith, the NL branches, Eijsden and the Maas, plus the Belgian RWS points `antwerpen`, `maaseik` (H and Q) and `lanaken` (§0.6).
- DE-2 and DE-3 (owner audience; DE-2 public after the P12 gate): 7 Rhine gauges.
- LU-3 (owner audience): the 11 AGE-computed stations on the Sûre, Alzette, Wark and Our (the Moselle runs are LfU RLP's and wait for C4 or C11).
- CH-4: 55 stations on the Rhine and Aare.
- FR-4: French stations, during events only.

**Risks**
- *Inferred run identity merging or splitting runs.* Hash plus first-valid key, and fixtures.
- *Event-only forecasts.* Shown honestly as "no forecast".
- *Thin upstream coverage* (§0.5): the Meuse above Eijsden and the Moselle, Saar, Main, Neckar, Lahn and Ems have no official forecast outside French events until RLP (C11) and the other P13 permissions arrive. The coverage report makes this visible.
- *`WV` behaviour in floods unknown* (§10 R1). Treated as "no forecast" when absent; C6 asks BfG.
- *CH-4 is an undocumented hydrodaten file* (§10 R5; C13). It is public under the BAFU conditions (§8: forecasts may be used freely) unless BAFU objects in C13; silence by the go/no-go date (11-06) keeps it public. If BAFU objects to public use, CH-4 moves to the owner audience and the public Swiss reaches show "no forecast"; only if BAFU asks us to stop fetching does its capture stop.
- *An owner-audience run leaking into a public forecast band or coverage number.* Per-audience Q2 and coverage, and the forecast canary.
- *Unclear NL-1 cadence* ("elke 6 uur", UNVERIFIED). The ~40 curated locations are polled hourly and the rest every 3 h (the RWS budget), with deduplication. If the P1 soak shows runs more often than every 3 h, the tiers are rebalanced within the ≤ 400 requests/hour budget.

**Review focus**
- *Code review:* bi-temporal semantics (issue vs valid time); the time conventions per route; horizon and estimate boundaries; that no interpolation happens across providers; the `asof` logic; CH-4 trace matching by position and name; the schedule-aware `WV` freshness; the §0.5 coverage report per audience; LU-3 run identity, floors and display limit.
- *Security review:* the added parsers, and error-body handling; the new API parameters (`asof`) and their bounds; that owner-audience runs stay out of every public forecast output.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Four formats with implicit run identity and mixed time conventions |
| Code review | `fable` | `/code-review high` | A shifted or mislabelled forecast misleads the public exactly during a flood |
| Security review | `sonnet` | high | New parsers and one parameter behind established guards |

---

### P9 · Static publisher and hardened read API

**Window:** 11-02 → 11-16 · **Lane:** serve · **Depends on:** P7 (P8 contracts may be stubbed) · **PRs:** P9a publisher; P9b API hardening

**Goal.** A flood-time spike costs almost no application CPU. Precomputed static files serve the hot paths, and the API is bounded, sheds load and can never leak withheld or owner-audience data. The owner channel (A§9.3) gets its own publisher output and API, isolated from the public ones by construction.

**Scope in**
- **P9a**
  - **`publish` role**:
    - every file of A§9.1, precompressed (zstd and gzip) and written atomically;
    - dirty-bucket tracking fed by the loader;
    - the recent and settled classes, with per-day versions in `meta.dayVersions`;
    - frames, per-station `recent.json`, `forecast/latest.json`, warnings, `sources.json` with dynamic dates, and `status.json`.
  - **Caddy**: cache classes per path, and `handle_errors 502 503 504` on `/api/v1/snapshot*` → static `latest.json` with `X-Degraded: 1`.
  - **Web**: switches to static-first fetching (meta → latest/recent/settled → API fallback) and shows the degraded banner.
  - **Owner publisher** (`publish-owner`; A§9.3, A§11.1): the same code with `--audience owner` and DB role `rws_owner_api`, writing the hot-path files (meta, latest, stations, sources with `private_basis`, recent, forecast/latest, series/*/recent, warnings/latest, status with the owner capture, health, twin and coverage results) into `/srv/rws/owner/data/v1/`. Owner split points for reaches are added in P11. The public `publish` service has no mount of `/srv/rws/owner`, and `publish-owner` has none of `/srv/rws/public`.
  - **Owner Caddy site** in the Caddyfile (A§11.5): `owner.<domain>` on container port 8443, `basic_auth`, `tls internal`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `/runtime-config.json` = `{"audience":"owner"}`, files from `/srv/rws/owner`, `/api/v1/*` → `api-owner`. **Its port is not published in production until P12a** (WireGuard); until then it is reached only inside the compose network by the e2e tests.
  - **Production owner canary**: the registry canary source (`audience: owner`, value `777777.777`) is loaded in production, so every production output can be checked for it.
- **P9b**
  - A global DB-concurrency semaphore returning 503 with `Retry-After`.
  - `singleflight`, and an LRU of precompressed bodies.
  - Per-client token buckets for the API only, keyed on the Caddy-set IP header with IPv6 /64. **Static files are never limited.**
  - Unknown parameters → 400.
  - `v` handling for immutable responses.
  - A **withheld canary leak test** and an **owner canary leak test** across every public file and public API response.
  - **Owner API** (`api-owner`; A§9.3): the same routes, validation, limits and caches with `--audience owner`, DB role `rws_owner_api`, pool 2, no export route, `audience: "owner"` and the attribution array in every response; reachable only through the owner site.
  - **Licence channels** (catalogue §0.7; A§9.2): our API and any export are redistribution. Static files and `/snapshot` are the `display` channel; `/series`, `/series/{id}/forecast` and `/frames` are the `api` channel; any CSV or bulk download needs `bulk_export` (the first release has no such route, but the guard and its test exist); values older than the provider's own public window need `history_export`. The filters live in the `pub_*` view layer, not only in route code. A second canary, a **`display`-only series**, proves the channel filter.
  - **Per-response attribution**: every API response carries an `attribution` array covering exactly the sources in its body, with the text, the link and the date each licence requires (Etalab/Vigicrues last update, LHP "Stand" with a link, HIC retrieval date, BAFU "Bezugsdatum", BfG credit, "LU-Alert"). The same block is in every published data file.
  - An OpenAPI snapshot test.
  - `.github/workflows/loadtest.yml`: k6 against the compose stack on a CI runner, with the synthetic seed.
  - `POST /api/v1/beacon` (≤ 8 KB, rate-limited, logged only).

**Scope out:** the UI beyond the data-layer switch.

**Acceptance criteria**
- [ ] [CI] Every published file validates against its `contracts` JSON Schema, and the OpenAPI document is snapshot-tested.
- [ ] [CI] **Withheld canary**: a series narrowed to `off` with the value `123456.789` never appears in any file or API response, public or owner. The test greps every output.
- [ ] [CI] **Owner canary** (compose e2e): the owner canary series (`777777.777`), its station, reference, forecast run and `private_basis` text appear in the owner publisher's files and the owner API's responses, and never in any public static file, public API response (every route, including `/snapshot` for 50 random `t`, `/frames`, `/series/{id}/forecast` and `/api/v1/health*`), any public `attribution` array, `status.json`, `/status/capture.json`, `sources.json`, the sitemap and `robots.txt` (once they exist), or a line of the public Caddy access log or the `api`/`publish` logs of the run. The test greps every public output for the value, the station ID, the canary source ID, its attribution text and the clause.
- [ ] [CI] **Isolation by construction:** as `rws_publish` or `rws_api`, a query on any `own_*` view fails with permission denied; the `publish` container cannot write `/srv/rws/owner` and `publish-owner` cannot write `/srv/rws/public` (compose e2e); a request for the owner hostname on the public listener returns no owner content; every owner-site response carries `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow` and answers 401 without credentials.
- [ ] [CI] **Channel canary**: a `display`-only series with the value `654321.987` appears in the static files and `/snapshot` but never in `/series`, `/series/{id}/forecast` or `/frames`; a series without `history_export` is never served older than its provider window on any channel. The test greps every output.
- [ ] [CI] Every API response and published data file validates an `attribution` array that lists exactly the sources present in the body, including the required date for each source whose licence needs one (fixture: a mixed Vigicrues + LHP + BAFU response).
- [ ] [CI] Property test: for 200 random values of T, the published snapshot equals the reference SQL (Q1/Q2) result.
- [ ] [CI] A revision older than 48 h bumps that day's version. The old URL's content is unchanged, the new URL reflects the revision, and `meta.dayVersions` is updated.
- [ ] [CI] Malformed or oversized input → 400 without a DB query. Over-rate → 429 with `Retry-After`. A saturated semaphore → 503 with `Retry-After`. 50 identical concurrent requests → 1 DB query.
- [ ] [CI] k6: 300 req/s static + 30 req/s API for 2 min gives p95 < 200 ms and 0 errors.
- [ ] [CI] Compose e2e: with `api` killed, the map still loads from static files and shows the degraded banner.
- [ ] [agent-prod] `latest.json` is < 2 min behind the last loader commit (`meta` vs health), and re-rendering one day takes < 60 s (`status.json`).
- [ ] [agent-prod] `verify-prod.sh` asserts `Cache-Control` for every path class of A§9.1.
- [ ] [agent-prod] `verify-prod.sh` fetches every public path class of A§9.1, a sample of 20 settled snapshots and frames, and every public API route, and finds neither `777777.777` nor the owner canary's station ID; `sources.json` and `status.json` list no owner-audience source.

**Providers / rivers:** all public sources; in the owner channel also BE-3, LU-2, LU-3, LU-4, DE-2 (until the P12 gate) and DE-3.

**Risks**
- *Stale caches after revisions.* Per-day versions.
- *Cache-key explosion.* Quantisation and unknown-parameter 400s.
- *Withheld or owner-audience leakage* (a publisher writing to the wrong directory, a cache or LRU key without the audience, a derived state, a log line). Separate processes, roles, volumes and view families; the LRU and singleflight live per process; the withheld and owner canaries in CI and production.
- *Breaching a "display only" permission through the API.* Channel flags in the views, plus the channel canary.
- *Locking out CGNAT crowds.* Static files are never limited.

**Review focus**
- *Code review:* dirty-bucket completeness (a revision at `ts` affects buckets up to `ts + staleness_limit`); atomic writes; version bumping; the fallback path; the load-test realism; that the owner publisher and API reuse the public code paths with only the audience switched (`audience.ts`).
- *Security review:* input validation; DoS through expensive queries; cache poisoning; trusting client-IP headers; the canary coverage, including the channel canary, the `history_export` window and the owner canary over every public output; the owner site's `basic_auth`, headers and unpublished port; that no public process can read `own_*` or write `/srv/rws/owner`; header and CSP regressions; the beacon endpoint as an abuse vector.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Performance-critical publishing with cache semantics and strict contracts |
| Code review | `sonnet` | `/code-review xhigh` | HTTP and caching patterns are well known, and the tests are concrete |
| Security review | `fable` | xhigh | The internet-facing surface that takes the flood spike, where leakage or DoS does the most damage |

---

### P10 · Web app MVP

**Window:** 11-10 → 11-25 · **Lane:** web · **Depends on:** P9 contracts, P6 tiles, P7 · **PRs:** P10a UI core; P10b pages

**Goal.** A public-grade, bilingual SPA with a classified map, rivers, warnings, a time selector from `displayStart` to the near future, and a station panel showing thresholds, forecast and provenance.

**Scope in**
- **P10a**
  - **Modes**: State, Δh and Q. The default follows D10.
  - **Legend**, with the honesty note: "Klassen volgen de referenties van elke instantie; niet strikt vergelijkbaar / Classes follow each agency's own references; not strictly equivalent".
  - **Palette**: BrBG/PuOr, no red–green pairing, with redundant ▲/▼ and size cues.
  - **Styling** for stale, suspect, tidal (hatched) and impounded stations.
  - **River lines** from P6 under the stations.
  - **Warnings layer**, time-aware at `t`. Area classes (§4.9) are drawn as areas or sections; a station coloured by an area class carries a "section" badge.
  - **Station panel**:
    - the raw value as published, with unit and datum;
    - state and basis, Δh and trend;
    - an ECharts hydrograph with thresholds (`markLine` with basis), alert bands and a forecast band with agency and issue time;
    - "≈ m NAP ±" in the detail view only (D16). **French stations (and the §0.6 Belgian partner stations, whose zeros also come from Hub'Eau) show no converted height**, only "nulpunt / gauge zero: x m IGN69 (Hub'Eau-metadata, niet geverifieerd / unverified)", with the datum as Hub'Eau publishes it (IGN69, NGF-1884 or TAW).
  - **Multilingual labels** (catalogue gap item 19): station names as published in the canonical source's primary language; river names from the reviewed `name_nl`/`name_en` in `rivers.yaml` (P6); provider class and alert labels shown raw with our reviewed NL/EN translation from `registry/labels/` (P7).
  - **Live mode**, refreshing every 60 s.
  - **Table view** and keyboard operation.
  - **Map attribution control**.
  - **Owner mode** (A§10; ADR-0017): `lib/config` reads `/runtime-config.json` once at start-up; data paths stay relative, so on the owner site the same build reads the owner publisher's files and the owner API. In owner mode:
    - a persistent banner on every view, **"Persoonlijk gebruik — niet delen / Personal use only — do not share"**, links each owner-audience source's `private_basis` (clause, URL, retrieval date);
    - an "alleen eigenaar / owner only" badge on every station, series, forecast band and threshold from an owner-audience source; the sources page lists them with their clause and attribution;
    - AGE values shown as published (value and unit);
    - TanStack Query keys include the audience; the owner canary is hidden;
    - in public mode none of this renders, and the public build contains no owner data, hostname or `private_basis` text.
- **P10b**
  - **Bronnen & licenties / Sources & licences**, generated from `sources.json`, with every required attribution string and its dynamic date.
  - **Over / About**: the disclaimer and links to the official services: waterinfo.rws.nl, vigicrues.gouv.fr, naturgefahren.ch, inondations.lu, hochwasserzentralen.de, waterinfo.be and hydrometrie.wallonie.be.
  - **Disclaimer — "Geen officiële waarschuwingsdienst / Not an official warning service"** (catalogue gap item 18): one consolidated page, linked from the footer of every page and from the beta banner, naming the official channel per country: NL RWS/WMCN (waterberichtgeving.rws.nl and waterinfo.rws.nl), DE LHP (hochwasserzentralen.de) and the state flood centres, BE waterinfo.be and SPW (hydrometrie.wallonie.be), FR Vigicrues, LU inondations.lu, CH naturgefahren.ch. It states that real-time data are raw and unvalidated (§0.3) and that NL-4 classes are Waterinfo display classes, not warnings.
  - **Colofon / Colophon (legal)**: operator and contact (D2 mailbox; the owner approves the text, E5), the licence of our own code and of the ODbL river graph, and a link to the sources page.
  - **Methode / Method**: `docs/classification.md` rendered (the signed-off §4.9 crosswalk), datums (and why French stations have no converted height), indicative travel times, the §0.5 forecast coverage, and the **rivers that are not covered** and why (D21: the Kempen rivers until VMM, the RLP tributaries until RLP, Austria and Liechtenstein, the Dutch water-board stretches).
  - **Privacy**: no cookies, no trackers, no analytics, no third-party requests; access logs IP-masked (IPv4 /24, IPv6 /48) and kept 14 days; rate-limiter state held in memory only; if the CDN break-glass (D20) is ever armed, the CDN is named here before it goes live.
  - **Status**: per-source freshness from `status.json`.
  - An **accessibility statement** and a 404 page, all in NL and EN.

**Scope out:** flow animation, playback and Hovmöller (P11); accounts; notifications.

**Acceptance criteria**
- [ ] [CI] Playwright (3 browsers):
  - mode switching works;
  - forecasts appear only where published and are labelled;
  - warnings are time-aware;
  - the legend and honesty note appear in NL and EN;
  - a deep link reproduces the view.
- [ ] [CI] A missing `nl` or `en` key, or a hard-coded UI string (`check-i18n`), fails CI.
- [ ] [CI] axe finds 0 serious or critical issues on every view. The slider, the mode control and station selection work by keyboard alone. A CVD-simulation screenshot set is attached to the PR.
- [ ] [CI] Initial JS ≤ 250 KB gzip, excluding the lazy chunks. Lighthouse CI on mobile gives performance ≥ 80 and accessibility ≥ 95, with LCP < 2.5 s on throttled 4G.
- [ ] [CI] The attribution e2e enumerates the public sources and asserts that each required string appears, including the VIGICRUES date, LHP "Stand" and BAFU "Bezugsdatum".
- [ ] [CI] The XSS fixture stays inert, every request is same-origin, and there are 0 CSP violations.
- [ ] [CI] The disclaimer, colophon and privacy pages exist in NL and EN and are linked from the footer of every page; the disclaimer links one official service for each of the six countries (Playwright).
- [ ] [CI] A French fixture station shows the gauge-zero note and no "≈ m NAP" value; a station coloured by an area class shows the "section" badge; a German section name and a French alert label render raw beside their NL/EN translation, and a missing translation fails `check-i18n`.
- [ ] [CI] **Owner mode** (Playwright, 3 browsers, against the compose e2e owner site with test credentials): the banner "Persoonlijk gebruik — niet delen / Personal use only — do not share" is visible on every view in NL and EN and links the `private_basis` of every owner-audience source except the hidden canary; BE-3 and LU-3/LU-4 fixture data render with the "alleen eigenaar / owner only" badge; every request is same-origin to the owner host; 0 CSP violations. In public mode the banner, the badges and every owner-audience station are absent, and `runtime-config.json` reads `public`.
- [ ] [CI] The public build output (`dist/`) contains no owner canary value, no `private_basis` clause and no owner hostname (grep).
- [ ] [agent-prod] Every page is reachable in NL and EN, and `verify-prod.sh` passes.

**Providers / rivers:** all public sources; in owner mode also BE-3, LU-2, LU-3, LU-4, DE-2 (until the P12 gate) and DE-3.

**Risks**
- *New majors.* Pins and gotchas.
- *Bundle growth.* Lazy chunks and a budget test.
- *Legend clutter.* The mode-specific legend.
- *Owner mode mistaken for the public site, or shared.* The persistent banner, the badges, and the owner site's WireGuard-only access (P12a).
- *A client cache mixing audiences.* Audience in every query key; the two hosts are different origins anyway.

**Review focus**
- *Code review:* URL state and deep links; i18n completeness, including river names, the provider-label table and the banner text; that nothing implies precision (units, ≈, basis, no French absolute heights); that NL-4 display classes are never called warnings; accessibility; performance budgets; that owner mode is driven only by the runtime config and changes presentation, not data access.
- *Security review:* DOM XSS from provider strings in every sink, including the `private_basis` clause; URL-parameter injection; that the CSP is intact; no third-party links that auto-load resources; that the public build and public mode expose no owner data.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` (start in `/plan`) | xhigh | The largest UI surface, on new major versions |
| Code review | `sonnet` | `/code-review xhigh` | React, i18n and accessibility patterns are well known; an independent, cheaper reviewer |
| Security review | `sonnet` | xhigh | Client-side surface (XSS, URL injection, CSP), checked against a checklist |

---

### P11 · Follow the water

**Window:** 11-20 → 11-30 · **Lane:** web · **Depends on:** P6, P10, P9 frames · **PRs:** P11a minimum; P11b reach colouring + playback; P11c Hovmöller

**Goal.** The visitor **sees** water flowing from the rivers that feed the Netherlands into the country. This is part of the first release.

**Cut list** (applied in this order if 11-30 slips; **P11a is the launch minimum**):
1. Drop the Hovmöller panel (P11c).
2. Drop playback (the second half of P11b).
3. Drop reach colouring (the first half of P11b).

**Scope in**
- **P11a**
  - **Animated flow direction** on the river lines (`line-dasharray`, downstream-oriented geometry): 20–30 fps cap; paused when the tab is hidden; off under `prefers-reduced-motion`, with step buttons kept.
  - **"Stroomopwaarts / Upstream" chain panel** per station: the upstream stations in graph order, each with its state at `t` and a typical travel-time **range** from §3.7, labelled "indicatief / indicative". **There is never a numeric ETA.**
- **P11b**
  - **Reach colouring** between snapped stations, by interpolated state or Δh. It may be time-shifted by an indicative travel time, and is then labelled as such. Tidal reaches are hatched and never interpolated. Impounded reaches use Q or state.
  - **Playback** of hourly frames (`frames/…`, ≤ 1 file per UTC day), with play, pause, step and speed controls, reflected in the URL.
- **P11c**
  - **Hovmöller panel** for the Rhine (Basel → Lobith → branches) and the Meuse (Chooz → Lith): x = km to the NL entry, y = time, colour = state or Δh. It is linked both ways with the slider and the station selection.
- **Owner view** (all three PRs; D22): the upstream chain, reach colouring, playback frames and Hovmöller read `own_*` data through the owner publisher and owner API, so **the Walloon Meuse between Chooz and Lixhe is filled from BE-3** (Chooz DGH 8702 → Waulsort → Anseremme → Dinant → Namur → Grands-Malades → Huy → Amay → … → Lixhe, in graph order; catalogue §3.3) and the Sambre, Ourthe, Vesdre and Amblève join the chain. The owner publisher adds the owner-audience stations as extra reach split points on the P6 graph (the public `reaches-<ver>.json` is unchanged), and owner frames come from the owner API. Owner-only chain entries carry the "owner only" badge.

**Scope out:** deck.gl, WebGL shaders, crest tracking, empirical calibration (P14/backlog).

**Acceptance criteria**
- [ ] [CI] A text scan finds no numeric ETA anywhere, and every travel-time text contains "indicatief" or "indicative".
- [ ] [CI] Under reduced motion, the flow animation's `requestAnimationFrame` count is 0. In a hidden tab the animation is paused.
- [ ] [CI] The upstream chain for Lobith lists Emmerich, Rees, Wesel, Duisburg-Ruhrort, Düsseldorf, Köln… in graph order. For Eijsden it lists the Meuse chain.
- [ ] [CI] (P11b) Tidal fixtures (Scheldt, Ems) never receive interpolated colours. Playing 7 days back fetches ≤ 1 frames file per UTC day.
- [ ] [CI] (P11b) Visual regression passes for 3 scenes: the Aug–Sep 2026 low water from the archive, a synthetic flood, and the DST night.
- [ ] [CI] Performance traces show ≥ 30 fps scrubbing on a desktop profile and ≥ 20 fps on a throttled mobile profile.
- [ ] [CI] (P11c) The Hovmöller km axis runs from upstream to downstream, as in the registry.
- [ ] [CI] **Owner view** (compose e2e): in owner mode the upstream chain for Eijsden lists the SPW Meuse gauges between Chooz and Lixhe in graph order and the Meuse Hovmöller has values on that stretch; in public mode the chain goes from Chooz straight to Lixhe, and no public frames file or reach file contains an SPW series or station.

**Providers / rivers:**
- the Rhine with the Aare, Neckar, Main, Moselle/Saar/Sauer, Lahn, Sieg, Ruhr and Lippe;
- the NL branches;
- the Meuse with the Chiers, Semoy, Sambre, Ourthe, Rur and Niers (on the public site, Belgian reaches are drawn with values only at the §0.6 ungated points (Lixhe, the Grensmaas, the Semois, Chiers and Viroin gauges) until P13, and the Walloon Meuse between Chooz and Lixhe has no station values; in the owner view that stretch and the Sambre, Ourthe, Vesdre and Amblève are filled from BE-3);
- the Scheldt and Lys (tidal rules);
- the Ems and Vecht.

**Risks**
- *Visuals implying precision.* Ranges and "indicatief".
- *Weir reaches.* Q or state basis.
- *Mobile battery.* Throttling and pausing.

**Review focus**
- *Code review:* interpolation against the registry and reaches; performance guards; the honesty labels; URL state; that the owner split points and chain entries come only from the owner channel.
- *Security review:* the new endpoint parameters (frames); that the CSP is intact; that no owner-audience station or value reaches a public reach, frames or chain output.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | New visual and geo logic on MapLibre 6 under performance constraints |
| Code review | `sonnet` | `/code-review xhigh` | Concrete performance and honesty criteria |
| Security review | `sonnet` | medium | Client-side rendering of already-public data; minimal new surface |

---

### P12 · Flood hardening, operations and public launch

**Window:** 11-26 → **12-04** · **Lane:** ops · **Depends on:** P9, P10, P11a; owner action A8 (WireGuard) · **PRs:** P12a hardening (including WireGuard and the owner site); P12b operations and launch

**Goal.** The site survives a flood-day spike, data keeps flowing under load, failures reach the owner, and the site launches publicly before the flood season. The owner view goes live over WireGuard only.

**Scope in**
- **P12a**
  - **k6 scenarios**: normal, flood and abusive client.
  - **Flood drill** (catalogue §0.4; gap item 2): `scripts/flood-drill` replays the flood fixtures, time-shifted to the drill clock, in the compose e2e stack (never against production data) through replay → load → publish → UI: the LHP test-server stations and alerts, a synthetic class-4 LHP station, the Wayback Vigicrues levels 2–3 plus a synthetic level-4 section, the real AGE red alert with its Cancel, a CAP TEST, and the CH-4 storm-Ciarán run (station 2020, Ticino, is outside the basin, so the drill registry adds it as a test-only station). The k6 flood scenario runs while the drill plays.
  - **Tuning**: the PostgreSQL pool and memory, the statement timeout, publisher cadence, OS limits (`nofile`, `somaxconn`) and Caddy. **Ingestion keeps priority under a spike** (gap item 9): Compose `cpus` limits per service, a connection limit on `rws_api` below `max_connections` minus the `rws_load`/`rws_publish` reservation, and `capture` and `load` never share a pool with `api`.
  - **Brownout flag** (A§9.2).
  - **Chaos tests** in compose e2e.
  - **WireGuard and the owner site** (A§11.5; ADR-0017; owner action A8). This PR may be pulled forward as soon as P9 and P10a are merged; the owner site is never served before WireGuard is up.
    - `deploy/host/wireguard/` and `rws-wg-peer add|list|revoke`: `wg0` at `10.66.0.1/24`, UDP 51820 open in nftables, peers only the owner's devices, server key root-only (0600);
    - compose publishes the owner site only as `10.66.0.1:443:8443/tcp`, and the public ports only on the explicit public IPv4 and IPv6 addresses (never a wildcard bind, which would also claim `10.66.0.1:443`); `docker.service` is ordered after `wg-quick@wg0`; nftables drops anything for `10.66.0.1` that does not arrive on `wg0`; a public catch-all site answers 421 for unknown hosts;
    - `basic_auth` with one user and a bcrypt hash of a random password of at least 32 characters (`/etc/rws/secrets/owner_basic_auth`); `tls internal`, with the Caddy root CA exported for the owner's devices; no public DNS record for the owner hostname;
    - the owner-site access log in its own file (14 days), and the owner publisher's healthchecks check;
    - `scripts/verify-owner.sh` (owner-run over WireGuard) and the negative checks in `verify-prod.sh`;
    - runbooks: adding or revoking a device, rotating the `basic_auth` password, and what to do if the owner view was exposed (revoke peers, rotate, check the access log).
  - **Egress budget** (gap item 10): a Playwright session profile measures the bytes per typical map session (tiles, JS/CSS, data, API); `docs/capacity.md` multiplies it by the expected flood-day sessions per hour and compares the peak with the VPS uplink and the month with the traffic quota. The fallback is decided in advance (D20).
  - **CDN break-glass runbook**: pre-written cache rules for a pull zone in front of the same hostname. It is documented, not enabled, unless D20 arms it for `/tiles/*` and `/assets/*`.
  - **Final security pass**: headers and CSP on both sites; `deploy/tests/hardening.sh` (`docker inspect` assertions, including that the owner port is published only on the WireGuard address); a secrets-rotation drill (including the `basic_auth` password and a WireGuard peer); `/.well-known/security.txt`; threat model v2 with the owner channel and the public ↔ owner boundary; the HSTS preload decision (D17).
- **P12b**
  - **Runbooks**: provider outage, schema drift, disk full, **VPS rebuild (RTO ≤ 4 h)**, token rotation, PMTiles refresh, DST check, flood mode.
  - **Restore drill** extended to include the database dump and a one-day replay-rebuild comparison.
  - **Launch checklist** (`docs/launch-checklist.md`):
    - the licence and attribution of each source verified, **including its four §0.7 channel flags against its licence or permission record**;
    - the permission tracker reviewed: every source past its go/no-go date runs its fallback (§0.2);
    - **the BfG Belegexemplar sent and recorded in `registry/permissions/DE-2.md`, and then DE-2 flipped from `owner` to `public`**;
    - **the owner channel**: every source's audience matches catalogue §0.8 and each `owner` source's `private_basis` is current; the owner site answers only over WireGuard; the WireGuard peer list holds only the owner's devices; `basic_auth` has one user; the owner canary is absent from every public output; no owner-audience source appears in the sitemap, `sources.json`, `status.json` or the privacy and sources pages;
    - disclaimers, privacy and accessibility statements; the disclaimer, colophon and privacy texts approved by the owner (E5), and the privacy notice matching the real logging configuration;
    - the flood drill and the egress budget passed;
    - providers notified.
  - **Going public**: remove `noindex` on the public site only (the owner site keeps `noindex, nofollow`); add `robots.txt`, a sitemap of public paths and an OpenGraph image; keep a "beta" label.

**Scope out:** new features.

**Acceptance criteria**
- [ ] [CI] k6 in CI (API with the synthetic seed): 50 req/s API + 300 req/s static for 15 min gives p95 < 300 ms, errors < 0.1%, loader lag p95 < 2 min, and no OOM or restart.
- [ ] [owner] k6 static burst against production during a quiet hour (owner triggers `loadtest.yml`): 1,000 req/s including PMTiles range requests for 15 min, p95 < 300 ms, errors < 0.1%, with health staying green throughout.
- [ ] [CI] An abusive client is throttled with 429 without moving other clients' p95 by more than 10%. Brownout engages within 60 s of the trigger.
- [ ] [CI] Chaos (compose e2e):
  - with `api` killed, the map works from static files with the degraded banner;
  - with the DB stopped for 10 min, capture continues and the backlog loads without loss;
  - with a provider blackholed (fake upstream), the stale styling and the alert both fire.
- [ ] [CI] **Flood drill** (compose e2e): every fixture station and area reaches its expected §4.9 level in `latest.json` and `warnings/latest.geojson`; the AGE Cancel closes its alert and the TEST never appears; the CH-4 flood run shows in the forecast band; the Playwright flood scene passes visual regression; and the concurrent k6 flood scenario keeps p95 < 300 ms with loader lag p95 < 2 min.
- [ ] [CI] The egress session profile is measured and committed to `docs/capacity.md`; CI fails if bytes per session grow by more than 20% without an update.
- [ ] [owner] `docs/capacity.md` shows the flood-day peak egress ≤ 50% of the VPS uplink and the month ≤ 50% of the traffic quota, or the D20 fallback is armed before launch.
- [ ] [CI] `security.txt` is present. The CSP has no `'unsafe-inline'`. Grype reports 0 fixable High or Critical findings.
- [ ] [owner] `deploy/tests/hardening.sh` output shows every container non-root, `ReadonlyRootfs`, `CapDrop: ALL` (Caddy adds only `NET_BIND_SERVICE`), `no-new-privileges`, limits set, published ports only on Caddy and never on a wildcard address, and the owner site's port published only on `10.66.0.1` (the WireGuard address).
- [ ] [agent-prod] **WireGuard-only listener, from outside:** TCP 443 and 8443 on every public IPv4 and IPv6 address with SNI and `Host` `owner.<domain>` return no owner content (a failed handshake or the catch-all 421; never a 200 or 401 from the owner site); TCP 8443 is closed on the public addresses; no public DNS record exists for the owner hostname; the public `robots.txt`, sitemap, `sources.json` and `status.json` name no owner-audience source.
- [ ] [owner] `scripts/verify-owner.sh` over WireGuard: 401 without credentials and 200 with them; every response has `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`; `/runtime-config.json` reads `owner` (which switches on the banner) and the owner canary is present in the owner data files and API; BE-3, LU-3 and LU-4 data are fresh in the owner status; with the WireGuard tunnel down the owner hostname is unreachable. The output is attached, and `wg show` lists only the owner's devices.
- [ ] [owner] Timed rebuild on a temporary second VPS, from the repository plus backups: ≤ 4 h, with 0 post-restore gaps for sources whose windows are ≥ 7 days.
- [ ] [owner] Every healthchecks alert is tested end-to-end and reaches the owner.
- [ ] [owner] The BfG notice is sent, and CI confirms that `registry/permissions/DE-2.md` exists before DE-2's audience changes from `owner` to `public`.
- [ ] [owner] The launch checklist is signed.
- [ ] [agent-prod] Public by **2026-12-04**: `noindex` removed, `robots.txt` and sitemap served, and `verify-prod.sh` passes the launch profile.

**Providers / rivers:** all public sources, plus any P13 source already permitted; the owner channel with BE-3, LU-2, LU-3, LU-4 and DE-3.

**Risks**
- *The owner site exposed or shared* (a bind on `0.0.0.0`, a public DNS record, a shared password or device). WireGuard-only publishing checked from outside and by `hardening.sh`, `basic_auth`, no public DNS or CT entry, the banner, and the revoke-and-rotate runbook.
- *Bandwidth rather than CPU becomes the flood bottleneck.* A traffic quota of ≥ 20 TB/month, the measured egress budget, and the CDN runbook in reserve (D20). No automatic switch to OpenFreeMap: it would add third-party requests (invariant 7).
- *A dead VPS during a flood loses the unrecoverable streams* (gap item 9). Hourly off-site raw sync (RPO ≤ 1 h), RTO ≤ 4 h, and the second-collector decision (D19).
- *Alert fatigue.* Thresholds tuned from the soak data.
- *A slip past 12-04.* The P11 cut list; launch is not gated on Belgium.

**Review focus**
- *Code review:* cache and versioning correctness under revisions; brownout toggles; realism of the load model; that the flood drill exercises every flood code path of §0.4; the egress model; ingestion priority under load; that the runbooks can actually be executed.
- *Security review:* a full end-to-end pass over the threat model, **including the owner channel** (WireGuard-only listener, nftables, `basic_auth`, `tls internal`, headers, view and role isolation, volumes, logs, backups, the owner canary coverage and the public ↔ owner boundary); exposed surfaces; logging privacy; the break-glass DNS/CDN takeover risk (the CDN never fronts the owner site); secrets inventory and rotation, including WireGuard keys and the `basic_auth` hash; supply-chain state; the whole CSP and header set on both sites.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Cross-cutting operations work whose mistakes only surface under stress |
| Code review | `fable` | `/code-review high` | Serving stale or wrong data during a flood through a cache or versioning mistake is the subtle launch failure |
| Security review | `fable` | max | The whole-system gate before going public, where correctness outweighs cost |

---

### P13 · Gated sources, as permissions arrive

**Window:** on permission (it may land before launch) · **Lane:** data · **Depends on:** the P5/P7/P8 patterns and the owner's permission for each source · **PRs:** one per source

**Goal.** Complete the Scheldt, Flemish Meuse, Kempen and lower Vechte coverage and the **official German state flood forecasts upstream of NL** (catalogue §0.5), from providers that need tokens or written consent. After D22 this phase is smaller: SPW and AGE already run in the owner view (P5c), so P13 holds VMM and HIC (owner audience once their credentials arrive, public only if the agreement or token terms allow), NLWKN, LfU RLP and LUBW (consent), and flipping SPW or AGE to public if either ever grants public display.

**Expected order:** BE-2 VMM (token) → BE-1 HIC (TYPE 3 credentials for a personal, non-commercial, private viewer) → DE-9 NLWKN → DE-3 public display (D4). **DE-10 LfU RLP (C11) goes first the day it is granted**: it is the single most valuable forecast permission (66 gauges). DE-12 LUBW (C12) follows if granted and if its forecasts are in the data (UNVERIFIED). A BE-3 or LU-2/3/4 public flip is a small PR whenever C3 or C4 grants public display.

**Scope in** (per source PR)
- **Shared KiWIS client** `adapters/_shared/kiwis/` (built in P5c for SPW), extended with the first VMM/HIC PR:
  - an OAuth2 client-credentials token cached ≤ 24 h and never logged;
  - a credit budget per run.
- **Audience on arrival.** BE-1 and BE-2 enter as `audience: owner`, with a `private_basis` that quotes the credential or token terms (and the HIC User Agreement), and move to `public` only if those terms allow public display (for VMM the Modellicentie already does, once the token terms have been read).
- **BE-1**:
  - non-tidal layers 156163 (H) and 156170 (Q);
  - tidal W via `getTimeseriesValues`, because the layer returns null for those series;
  - thresholds `DrempelPrewaak/Waak/Alarm` (m TAW);
  - exceedance percentiles;
  - the compulsory dated attribution.
- **BE-2**: `Absolute Value`, sentinel `-10000`, Modellicentie attribution. Includes the **Kempen gauges** that are the only coverage of the rivers entering NL directly (§0.6): Mark (Minderhout L11_047, Merksplas L11_048, Hoogstraten/Laermolen, the Meer weirs), Dommel (Neerpelt L11_025, De Wulp L11_026, Overpelt L11_022, Peer L11_023), Warmbeek (Achel L11_024), Kleine Aa/Weerijs (Wuustwezel L11_044, Brecht L11_046) and Noordermark (Baarle-Hertog). Whether they deliver live values is checked first (§10 R8).
- **BE-3 public flip** (only if SPW grants prior written consent for public display, C3): `registry/permissions/BE-3.md` with the channels granted, `audience: public`, the SPW-operated §0.6 partner stations switched from the FR-1 copy to BE-3 (FR-1 becomes `mirror`), and the BE-3 references and crosswalk row moving into the public classification. The adapter, references and catch-up already exist (P5c, P7).
- **LU-2/3/4 public flip** (only if AGE grants written authorisation, C4): the same steps for the Luxembourg forecasts and thresholds; LU-2 stays a twin of LU-1.
- **DE-10 LfU RLP** (once C11 is granted; allowlist `www.hochwasser.rlp.de`):
  - W and Q (48 h index, 5 days per site; the CSV holds 90 days, used for catch-up);
  - forecasts at **66 gauges** with nine percentiles p10…p90 (Rhine Maxau → Emmerich 20; Mosel 9 incl. Perl, Stadtbredimus, Wasserbillig and Trier; Ahr 3, Nahe 5, Lahn 4, Sauer 2, Our 2, Kyll, Prüm, Saar, Sieg, Wied, Nette), added to the §0.1a raw archiver the same day;
  - the **46 alert regions** (`alertClassId` 1–7) and the station legend mapped through §4.9;
  - attribution "LfU Rheinland-Pfalz" with the Bearbeitungsdatum;
  - no test server: a hand-built flood fixture from the 7 alert classes and the HW2–HW100 legend (§0.4);
  - the DE-10 CSV is offset-less, so the DST gate of P5 applies;
  - the LfU RLP data republished by AGE (the Bollendorf and Gemünd series in LU-1 and LU-2, the LU-3 Moselle runs at Perl, Stadtbredimus and Wasserbillig) is enabled in the same PR, or earlier if C4 confirms that AGE's terms cover it, in the audience that answer allows.
- **DE-12 LUBW** (once C12 is granted; allowlist `www.hvz.baden-wuerttemberg.de`): the Upper Rhine tributaries (Murg, Kinzig); forecasts only if they are in the data (UNVERIFIED); "MESZ"/"MEZ" stamps, so the DST gate applies.
- **DE-9**: `DatumUTC` only; `-888` sentinel; lat/lon swap fix.
- **DE-3**: public display (D4), from `owner` to `public`, with the BfG credit and the Belegexemplar recorded in `registry/permissions/DE-3.md`.
- **For every source**:
  - the capture spec, adapter, references and forecasts where published;
  - `registry/permissions/<ID>.md`, which CI requires before `audience: public`. It records the four §0.7 channel flags the permission grants (`display`, `api`, `bulk_export`, `history_export`) and the attribution and date duties; channels the permission does not name stay off. An `owner` grant records its `private_basis` instead;
  - **catch-up to the data epoch** where the provider keeps history (KiWIS: decades), within the credit budget;
  - a documented **purge procedure** in case permission is refused or withdrawn;
  - for BE-1, BE-2 and BE-3, **when the source becomes public**: the §0.6 Belgian partner stations that the agency operates switch from the FR-1 copy (`primary` until then) to the agency's own feed, and the FR-1 copy becomes `mirror` (A§7.2 exception). While the source is owner-audience, its series of those gauges stay twins.

**Acceptance criteria**
- [ ] [CI] Every adapter meets the P5 fixture standard; a source that arrives as `owner` (BE-1, BE-2) uses synthetic fixtures with the `synthetic: true` marker (P5c) until it is `public`.
- [ ] [CI] Tokens come only from Compose secrets. A canary secret never appears in logs, the manifest, archive metadata or `ingest_batch` (redaction test).
- [ ] [CI] CI blocks an `audience: public` entry that has no permission record, an `audience: owner` entry without a `private_basis`, and `api`, `bulk_export` or `history_export` on a P13 source unless its permission record (public) or its default owner channels (owner) allow that channel.
- [ ] [CI] A BE-1 or BE-2 source that arrives as `owner` passes the P9 owner canary and audience tests: none of its rows reaches a public output until its audience is `public`.
- [ ] [CI] Every offset-less P13 parser (DE-10 CSV, DE-12 "MESZ"/"MEZ", DE-13 HTML if ever added) passes the DST gate of P5.
- [ ] [CI] (DE-10) The hand-built flood fixture maps all 7 alert classes and the HW2–HW100 legend to the §4.9 levels, and the nine percentiles satisfy p10 ≤ … ≤ p90.
- [ ] [CI] When a BE source goes public, the registry test shows every §0.6 partner station it operates published exactly once, from the operator's feed, with the FR-1 copy as `mirror`.
- [ ] [CI] BE-1 tidal IDs are fetched through `getTimeseriesValues`, never the layer. The token is refreshed at most once per 24 h (fake clock).
- [ ] [CI] BE-1 tidal stations are styled as tidal. BE-3 regulated reaches show Q. The percentile conventions are correct per provider.
- [ ] [agent-prod] Twins, once BE-1 is public: RWS Maaseik (NAP) vs HIC Maaseik (TAW) = 2.33 m ± 2 cm, and RWS Eijsden is consistent with the nearest HIC gauges.
- [ ] [owner] While BE-1 or BE-3 is owner-audience, `verify-owner.sh` shows the same twins in the owner status: Maaseik NAP vs TAW = 2.33 m ± 2 cm, and RWS Eijsden consistent with the nearest HIC and SPW gauges.
- [ ] [agent-prod] For a source that goes public: catch-up to the epoch reaches ≥ 95% of buckets, and public health is green for it.
- [ ] [owner] For a source that arrives as `owner` (BE-1, BE-2): `verify-owner.sh` shows catch-up to the epoch ≥ 95% of buckets and the source healthy in the owner status, while public health lists only the `owner_sources` count.

**Providers / rivers**
- BE-1/BE-2 (Flanders): the tidal Zeeschelde, Leie, Bovenschelde, Dender, Demer, Dijle, Nete, Grensmaas (owner view first).
- BE-2 (Kempen): Mark, Dommel, Warmbeek, Kleine Aa/Weerijs, Noordermark (owner view first).
- DE-9: Vechte and Dinkel.
- Public flips only: BE-3 (Wallonia: the Meuse from Chooz to Lixhe, Sambre, Ourthe, Vesdre, Amblève, Semois, Escaut) and LU-2/3/4 (Sûre, Alzette and Moselle forecasts and thresholds), both already in the owner view since P5c.
- DE-10: Rhine Maxau → Emmerich, Mosel (incl. Perl, Stadtbredimus, Wasserbillig), Saar, Sauer/Sûre, Our, Ahr, Nahe, Lahn, Kyll, Prüm, Sieg, Wied, Nette.
- DE-12: Upper Rhine tributaries (Murg, Kinzig).

**Risks**
- *Refusal or conditions.* The `off` default, the go/no-go date in the tracker and the purge procedure.
- *A "display only" grant.* Channel flags stay off for `api` and exports (P9 enforces them).
- *KiWIS IDs changing and slow calls.* `ts_path` resolution and long timeouts.
- *RLP forecast runs before permission are lost.* Accepted and disclosed. (LU-3 runs are captured for the owner view since P1.)
- *Credentials granted for a personal viewer used publicly.* The audience stays `owner` until the agreement allows public display, and CI blocks `public` without a permission record.

**Review focus**
- *Code review:* conformance to the adapter template; KiWIS quirks (tidal nulls, TAW, quality codes, daily stamps at UTC+1); credit budgeting; the audience and channel flags against the permission record or `private_basis`; RLP percentile and alert-region mapping against §4.9.
- *Security review:* secret storage and rotation; log redaction; token scope; that credentials never reach the browser or the archive; that an owner-audience source stays in the owner channel until its public flip.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | high | The pattern is established; the quirks are catalogued |
| Code review | `sonnet` | `/code-review xhigh` | Conformance to the template and the pitfall checklist |
| Security review | `opus` | xhigh | The first real third-party credentials in the system |

---

### P14 · LATER: historical backfill and climatology

**Window:** 2027, starting no earlier than 4 weeks after a stable launch · **Lane:** data · **Depends on:** P12, plus data orders and permissions · **PRs:** per provider group

**Goal.** Extend history backwards for context, for our own day-of-year percentile classes and for travel-time calibration, without ever compromising the data captured since go-live.

**Scope in**
- **Backfill runner**: a `backfill_job` checkpoint table (no new queue dependency); resumable after `kill -9`; per-provider rate budgets; off-peak; `--dry-run`; yearly partitions before the epoch.
- **Row rules**:
  - rows carry QC bit 512 (backfilled) plus the provider's validation bits;
  - backfilled rows inherit their source's audience: owner-audience history (BE-3, LU-7) stays in the owner channel, and a percentile climatology built from it is an owner-audience reference;
  - **precedence**: a live-captured row changes only through a provider-validated value, and always via `obs_revision`;
  - rollups are rebuilt and `dayVersions` bumped.
- **Sources:**

  | Source | Route and limits |
  |---|---|
  | NL-1 REST | ≤ 160k values per request (about 2.5-year chunks), 1 request/s |
  | DE-8 NRW | opengeodata `hydro` (resample irregular timestamps; `hydro/q` was seen as a listing only, so verify the download first) |
  | BE-3 KiWIS | ≤ 250k values per call; **owner audience** (private backfill is personal use under the SPW mentions légales, catalogue §0.8); the full-resolution `Cmd.*.Comp` series back to 1969–2007 |
  | BE-1/2 KiWIS | ≤ 250k values per call, with credentials; the audience of the source (owner until the agreement allows public) |
  | FR-2 | `obs_elab` daily |
  | CH-8 | BAFU Datenservice order (**resolve the UTC vs UTC+1 question first**) |
  | CH-9 | data.bs.ch (2289 since 2020, 2106 since 2022) |
  | LU-7 | AGE archive 2002–2024 on request (C4); owner audience unless AGE grants public use |
  | DE-5 PEGELONLINE history form | **only with ITZBund's written OK** |
  | DE-11 HLNUG | `year.json` |

- **Analysis**: the day-of-year percentile climatology as a new `statistical` basis (only for stations with ≥ N years). Empirical travel-time calibration per reach and flow class, which enables indicative crest tracking.
- **Storage review ADR** at about 50 GB: TimescaleDB compression vs a Parquet export of closed partitions.

**Acceptance criteria**
- [ ] [CI] A test proves that backfill never changes a live row unless the provider-validated flag is set, and every such change is in `obs_revision`.
- [ ] [CI] Kill and restart resume with no duplicates and no gaps. The per-provider rate budget holds.
- [ ] [CI] Historical time-zone tests pass: the CH-8 CSV, KiWIS daily stamps, and pre-2007 FR local-time data.
- [ ] [CI] Percentile classes are enabled only for stations with ≥ N years, and they appear in the generated classification document.
- [ ] [CI] A backfill fixture with owner-audience rows (BE-3 history with the owner canary value) and the climatology derived from it never appear in a public output, and do appear in the owner outputs.
- [ ] [agent-prod] Live freshness stays within its limits during the backfill (health sampled hourly).
- [ ] [owner] The restore drill still completes in ≤ 4 h, or the RTO is revised in an ADR. The DB stays within its size budget.

**Review focus**
- *Code review:* precedence and revision rules; resumability; reconciliation against provider counts.
- *Security review:* bulk-download credentials and politeness; that data-order files are handled safely; that owner-audience history stays in the owner channel.

| Step | Model | Effort | Justification |
|---|---|---|---|
| Build | `opus` | xhigh | Long-running, rate-limited, resumable jobs across many providers |
| Code review | `fable` | `/code-review high` | Bulk writes land next to the only copy of the go-live data; the strongest independent check guards precedence |
| Security review | `sonnet` | high | Bulk egress and credentials behind the established guards |

**Backlog (not scheduled):**
- LfU Bayern, HLNUG live, Saarland, WVER and the Dutch water boards (including the Brabant boards De Dommel, Brabantse Delta and Aa en Maas; §10 R8), all with permission. (LfU RLP and LUBW moved to P13 after the gap check);
- Austria and Liechtenstein inflows (Ill, Bregenzerach, Bodensee at Bregenz), only if D21 brings them into scope;
- GloFAS as a clearly labelled "model outlook" layer, never as an official forecast (catalogue §0.5);
- a hand-curated French gauge-zero table (IGN Circé; §10 R6), after which D16 may allow converted heights for French stations;
- a second capture-only collector for the §0.1a streams at another provider (D19);
- deck.gl effects and shader-based flow;
- flood-crest ETAs, still indicative;
- a TypeScript 7 migration once 7.1 and the tooling allow it;
- EU-Hydro 2.0;
- a VictoriaMetrics/Grafana stack if operations need it.

---

## 6. Owner decisions and owner actions

### 6.1 Decisions

Defaults are recommended. "Needed by" is the phase whose build needs the answer.

| ID | Decision | Recommended default | Needed by |
|---|---|---|---|
| D1 | Commercial use (ads, paid tiers)? | **Non-commercial**, stated in every permission request (it helps with HIC, SPW, NLWKN and GKD) | P0 (e-mails) |
| D2 | Domain and contact mailbox | Register now. `contact@` and `security@` on the domain (used in the User-Agent, `security.txt` and the e-mails) | P1 |
| D3 | Capture before consent | **Amended 2026-09-24 (D22):** the owner-audience sources are captured from day one (P1) for the owner view: **BE-3 SPW and LU-2, LU-3 and LU-4 AGE** (their terms allow personal use; catalogue §0.8) and DE-2 and DE-3 (BfG duties attach to publication, not to private use). The earlier "no dark capture of SPW or AGE" no longer applies, and `dark` is retired. **DE-9 NLWKN, DE-10 LfU RLP and DE-12 LUBW stay off until consent** (their Impressum forbids storing or copying without it), and so does the LfU RLP data AGE republishes (the Bollendorf and Gemünd gauges, the LU-3 Moselle runs; catalogue §0.8) until C4 or C11; RLP forecast runs before consent are lost, which is accepted and disclosed. BE-1 and BE-2 stay off until their credentials and token arrive, then enter as `owner` | P1 |
| D4 | Publish BfG forecasts? | Yes: DE-2 at launch, after the Belegexemplar notice. DE-3 later (P13). Both are in the owner view from P8 | P8/P12 |
| D5 | Off-site backup target | An EU S3-compatible bucket with versioning + Object Lock (compliance mode, 30-day default retention); restic-encrypted | P1 |
| D6 | Public API status | Open and rate-limited, "unofficial, no SLA". Documented, not promoted | P9 |
| D7 | Repository visibility | **Public**: free CodeQL and secret scanning, fits the open-data spirit, and GHCR images need no pull token | P0 |
| D8 | Forecast horizon | **Per station**, capped at +48 h. "Estimate" styling beyond the provider's own forecast segment | P8 |
| D9 | Show seeded pre-go-live data? | Yes, labelled with the data epoch and "data since" per station | P4 |
| D10 | Default map mode | State (class) if the P7 coverage report shows ≥ 60% of tier-1 stations with a class other than `no_ref`; otherwise Δh | P10 |
| D11 | Slider step | 10 min; 15-min sources are shown by carrying the last observation forward | P4 |
| D12 | Tidal and impounded reaches | Tidal: hatched, raw level in the detail view, never interpolated, classed only from operational thresholds. Impounded: prefer Q or anomaly vs MW, and label the reach | P7/P11 |
| D13 | Object Lock bucket provider | The owner's choice. It must offer an EU region, the S3 API, versioning and Object Lock | P1 |
| D14 | Basemap extent | Full Rhine basin at z0–14 (4.3 GB) plus planet z0–6 | P3 |
| D15 | Publish the OSM-derived river graph under ODbL | Yes; required once it is served | P6 |
| D16 | Absolute heights | Detail view only, as "≈ m NAP (±2 cm)" next to the raw value; never on the map scale. **Amended after the gap check:** NL, DE, LU, CH and BE (TAW) only. **French stations get no converted height in the first release**; they show the gauge zero as published (Hub'Eau metadata, unverified), because at the three gauges shared with PEGELONLINE the Hub'Eau zeros sit +0.535, +0.58 and +1.57 m above the NHN zeros instead of the published ≈ +0.48 m, a disagreement of about 5 cm to 1.1 m (catalogue §4.1, §4.7(5), C40, §9 Q8). The same applies to any gauge zero taken only from Hub'Eau metadata, including the §0.6 Belgian partner stations in FR-1 (P5a stores those zeros but does not trust them) | P2/P7/P10 |
| D17 | HSTS preload | Not at launch; revisit 3 months later | P12 |
| D18 | **Class crosswalk sign-off** (catalogue §4.9, §9 Q31), including whether RWS NL-4 "Licht verhoogd" counts as `elevated` | Adopt §4.9 as proposed: one row per provider class with target level and basis (stage, discharge or area); gauge class beats area class; LHP duplicates by operating state, else worst class with provenance; "Licht verhoogd" = `elevated`, labelled as a Waterinfo display class and never as a warning. **Addendum (D22):** the §4.9 LU-4 rows apply in the owner view only, plus a BE-3 row for the owner view: SPW long-term non-exceedance percentiles give `low` at or below P05 and `normal` otherwise, never an alert level | **P7b** (P7a may start without it) |
| D19 | Second collector for the unrecoverable streams (gap item 9) | Not before launch. The hourly off-site raw sync bounds loss to ≤ 1 h (RPO) and the rebuild RTO is ≤ 4 h. Capture holds no DB credentials, so a capture-only instance at a second provider, writing to its own bucket prefix, is a configuration change; revisit at the P12 retrospective, after checking its IP is not blocked (`rws-reachability`) | P12 |
| D20 | Flood egress fallback (gap item 10) | Decide in advance from the P12 egress budget: if the flood-day peak exceeds 50% of the uplink or the month 50% of the quota, arm a CDN pull zone for `/tiles/*` and `/assets/*` only (static, licence-neutral) under the same hostname, disclosed on the privacy page. **No automatic switch to OpenFreeMap** (third-party browser requests, CSP change) | P12 |
| D21 | **Rivers not covered in the first release** (catalogue gap item 14, §9 Q32) | Accept for the first release and list them on the Method page: the Kempen rivers entering NL directly (Mark, Dommel, Aa/Weerijs, Warmbeek, Keersop, Merkske, Voer) until VMM (P13); the RLP tributaries Ahr, Kyll, Prüm and Nahe with LHP classes only until RLP (P13); the NL water-board stretches through German upstream gauges and RWS (backlog, §9 Q10); canal transfers only at the RWS points (`smeermaas.zuidwillemsvaart`, `kanne`). **Austria and Liechtenstein** (Ill, Bregenzerach, Bodensee at Bregenz): out of scope for the first release; the Alpine Rhine and Bodensee come from CH-1 | P6, P10 (Method page), P13 |
| D22 | **Hybrid audience** (decided by the owner, 2026-09-24; ADR-0017; catalogue §0.8) | **Decided:** keep the public site with the open sources exactly as planned, and add a login-only **owner view** that also shows the sources whose terms allow personal use: BE-3, LU-2, LU-3, LU-4, DE-3, DE-2 until the Belegexemplar, CH-2/CH-4/CH-5 if BAFU objects to public use, and BE-1/BE-2 once their credentials arrive. Only the owner uses it; giving anyone else access (credentials, a WireGuard peer, screenshots) is forbidden, because it would be distribution to third parties. Access: WireGuard only, then `basic_auth`. HIC and VMM are asked for credentials for a personal, non-commercial, private viewer (optionally also about public display); SPW and AGE are asked only for public display | P0 (registry), P1 (capture), P2, P5c, P7–P12, P13, P14 |

### 6.2 Actions

Everything non-code the owner must do, with the phase each item gates. The e-mail drafts are in `docs/legal/requests/` (P0b). Send them from the contact mailbox and record the dates in `docs/permissions.md`.

| # | Action | Details and contacts | Deadline | Gates |
|---|---|---|---|---|
| **A — Infrastructure** | | | | |
| A1 | Answer D1, D2, D5, D7 and D13 | See §6.1 | 09-25 | P0, P1 |
| A2 | Register the domain; create the mailboxes `contact@` and `security@` | Used in the User-Agent, `security.txt` and the permission e-mails | 09-25 | P1 (User-Agent), all e-mails |
| A3 | Order the VPS | EU region, 4 vCPU / 8 GB / ≥ 200 GB NVMe, ≥ 1 Gbit/s, ≥ 20 TB/month, IPv4 + IPv6, Debian 13. Enable provider snapshots (weekly) and the provider firewall (22 from your own IPs if static). Test console (break-glass) access. Install your SSH key (FIDO2 `sk-ed25519` recommended) | 09-27 | **P1b** (so the recorder can be live ≤ 10-02) |
| A4 | DNS | A/AAAA → VPS; CAA `0 issue "letsencrypt.org"`; DNSSEC if the registrar supports it | 09-27 | P1b (TLS) |
| A5 | Off-site backup bucket | EU S3-compatible provider (D13): a versioned bucket with Object Lock at creation (compliance, 30 days). Two keys: a **VPS key** (put, get, list; **no** `DeleteObjectVersion`, `BypassGovernanceRetention` or `PutObjectRetention`) and a **workstation key** for `restic forget --prune`. Generate the restic repository password and keep it offline (password manager + paper) | 09-28 | P1b (backups) |
| A6 | healthchecks.io | Create an account and a project. Add e-mail + phone/push integrations. Create a project API key for `rws-hc-sync` | 09-28 | P1b (alerts) |
| A7 | Put secrets on the VPS | `/etc/rws/secrets/` (0600): restic password, S3 keys, healthchecks API key (plus a GHCR read token if the repo is private). DB role passwords are generated by bootstrap in P2 | as each phase asks (P1b, P2) | P1b, P2 |
| A8 | **Set up WireGuard for the owner view** (D22; A§11.5) | On the VPS: run the P12a WireGuard script (`wg0` 10.66.0.1/24, UDP 51820). On each of **your own** devices (laptop, phone): install WireGuard, generate the key pair on the device, add it with `rws-wg-peer add <name>`, and add the owner hostname to the tunnel's DNS or hosts entry. Install the exported Caddy root CA on each device. Generate the `basic_auth` password (≥ 32 random characters, kept in your password manager) and put its bcrypt hash in `/etc/rws/secrets/owner_basic_auth`. Never add another person's device or share the password. Run `verify-owner.sh` and paste the output | ≤ 11-26 (or as soon as P12a's WireGuard PR merges, if pulled forward) | **P12a** (owner site live) |
| **B — GitHub** | | | | |
| B1 | Run `scripts/gh-settings.sh`, then `--check` | Ruleset on `main`: PR required (**0 required approvals**, because the owner is the only merger), required checks `ci` and `security`, linear history, no force push, no deletion. Tag ruleset protecting `legacy-v0`. Require SHA-pinned actions. Allowed-actions list. Default `GITHUB_TOKEN` read-only; Actions may not approve PRs. Secret scanning + push protection. Private vulnerability reporting. Dependabot alerts | right after P0b merges (09-26) | Closing P0; every later PR |
| B2 | Create the `production` environment | Required reviewer: owner. Deployment branch: `main`. **No environment secrets** | before P1b's first release | P1b onward (every deploy) |
| B3 | Legacy clean-up | Check repository and Actions secrets, deploy keys and webhooks, and revoke anything legacy (the legacy `ci.yml` used no secrets). Revoke access to the old server that `deploy/install-ubuntu.sh` set up. Label and close legacy issues and PRs, and delete stale branches **after** the tag is verified (keep `claude/river-water-level-map-hf7bcz` until P0b merges, unless PR #30 was merged; then it may be deleted) | 09-26 | P0 |
| B4 | GHCR visibility | If public (decision D7), set the packages public after the first release. If private, create a fine-grained read-only `read:packages` token and store it on the VPS (A7), not in GitHub | first P1b release | P1b |
| B5 | GitHub secrets | **None required.** cosign uses GitHub OIDC; GHCR push and issue updates use `GITHUB_TOKEN`. Do not add server credentials to GitHub (ADR-0008) | – | – |
| B6 | GitHub Actions must be able to run | On 2026-09-24 the account's Actions minutes were used up: jobs end in about 2 s without a runner (seen on PR #30). Either make the repository public (D7; standard GitHub-hosted runners are free for public repositories) or raise the Actions spending limit or plan. Check with a trivial workflow run before starting P0b | now, before P0b | **P0b** and every later `[CI]` criterion; P1b releases, geo.yml, the nightly contract check |
| **C — Data access and permission requests** (send by 09-28; HIC needs weeks). **Every request also asks** whether (a) machine-readable redistribution through our public API and exports is allowed and (b) we may keep and republish a history archive (catalogue §0.2, §0.7). Record the answer as audience and channel flags and set a go/no-go date per source in `docs/permissions.md`. The requests to SPW, HIC and AGE may cite the EU High-Value Datasets regulation (2023/138) only as a soft argument, because it sets no real-time requirement for hydrometry (catalogue §0.2). **After D22** (2026-09-24): C1 and C2 ask for credentials for a **personal, non-commercial, private viewer** used by the owner alone (optionally also whether public display would be allowed); C3 and C4 are optional requests for **public display** only and block nothing, because SPW and AGE already run in the owner view under their personal-use terms (catalogue §0.8) | | | | |
| C1 | **HIC** (BE-1): `hic@vlaanderen.be` | TYPE 3 credentials **and a User Agreement** for a **personal, non-commercial, private viewer** (one user, the owner; data never passed to third parties), polling every 10–15 min server-side; confirm the attribution wording and the credit allowance. Optionally ask whether public, non-commercial display on the website would be allowed | 09-28 | P13 (BE-1 as owner audience on arrival; public only if the agreement allows); Maaseik twin |
| C2 | **VMM** (BE-2): `hydrometrie@waterinfo.be` | A (free) API token for automated querying by a **personal, non-commercial, private viewer**, stating the data (H and Q of the Flemish non-navigable rivers, in particular the Kempen gauges on the Mark, Dommel, Warmbeek, Kleine Aa/Weerijs and Noordermark, the only coverage of those rivers, §0.6) and the frequency (every 10–15 min); confirm the Modellicentie attribution. Optionally confirm that public display under the Modellicentie is fine with the token | 09-28 | P13 (BE-2 as owner audience on arrival; public once the token terms are read and allow it) |
| C3 | **SPW** (BE-3): `hydrometrie@spw.wallonie.be` — **optional** | Prior written consent (mentions légales) to show the data **publicly** on the website (the owner view already runs under the personal-use reading, D22), to poll server-side every 10 min, and later to backfill publicly. Ask for numeric alert thresholds (`NIVCRU`). Ask whether the Metawal clause on "support statique (… pdf ou image sur Internet)" allows an image-only public display (UNVERIFIED) | when convenient | Nothing blocks on it; a grant becomes a P13 public-flip PR (BE-3) and allows a public P14 backfill |
| C4 | **AGE Luxembourg** (LU-2/3/4/7): `hydrometrie@eau.etat.lu`, plus the Service de la navigation for the Moselle stations (address not in the research; look it up) — **optional** | Written authorisation for **public** display of the per-station JSON (LU-2), the forecasts (LU-3) and the station-page thresholds (LU-4) (the owner view already uses them under the Aspects légaux, D22). **Ask whether the CC0 of the LU-1 CSV covers its third-party gauges** (LfU RLP Bollendorf and Gemünd, WSV Perl, Service de la navigation), and whether the site terms cover the LfU RLP data it republishes (the Bollendorf and Gemünd JSON files of LU-2 and the LU-3 Moselle forecasts at Perl, Stadtbredimus and Wasserbillig). Report the CSV bugs (15-min late labels, `SN_Remich.json` 404, `Water-Levels-Localstation.csv`). Ask about the 2002–2024 archive (LU-7) | when convenient | Nothing blocks on it: the LfU RLP-origin series (the Bollendorf and Gemünd gauges in LU-1 and LU-2, the LU-3 Moselle runs) simply stay withheld (`off`, and not fetched where they come in their own files) until C4 or C11 is answered; a grant becomes a P13 public-flip PR (LU-2/3/4); LU-7 feeds P14 (owner audience unless public use is granted) |
| C5 | **NLWKN** (DE-9): `HWVZ@nlwkn.niedersachsen.de` | Written clarification (the Impressum conflicts with the manual) permitting **storage and public display** of the Vechte and Dinkel gauges | 09-28 | P13 (DE-9) |
| C6 | **BfG** (DE-2/DE-3): `vorhersage@bafg.de` | Confirm the credit wording and whether `WV` inside PEGELONLINE falls under BfG terms. Announce that the site URL will be sent as the Belegexemplar. **Ask how `WV` behaves above HSW / Marke II**: capped, stopped in favour of the state flood centres' forecasts, or kept (§0.4, §10 R1). **At launch:** send the URL (with a screenshot) and record it in `registry/permissions/DE-2.md` | now; again at launch | **P12 launch gate** (DE-2 → public); P8 (flood behaviour of DE-2); P13 (DE-3) |
| C7 | **RWS** (NL-1): the "Servicedesk Data" contact form on rijkswaterstaatdata.nl, optionally also https://github.com/Rijkswaterstaat/WaterWebservices/discussions | Courtesy notice of the load (about 9k requests/day), the `X-API-KEY` value and the contact address. Ask about the forecast cadence ("elke 6 uur"), **whether the API hosts change with the CTD migration on 2026-11-05** (§10 R4; also ask in GitHub Discussions), the meaning of quality code 25, **whether the longer waterinfo fan/ensemble forecasts exist as data, whether the NL-4 classes correspond to the WMCN warning phases and whether those phases exist machine-readably** (§10 R3), where the next NL-4 edition will be published, and **what the `kanne` Q series measures** (§10 R9) | before 10-02 | Courtesy for P1 (not blocking); the answers inform P2b, P5 (`kanne`), P7 (NL-4 labelling) and P8 |
| C8 | **ITZBund / WSV** (DE-1/DE-5): contact address not in the research; use the contact on pegelonline.wsv.de | Courtesy notice. Ask whether `WV` and the third-party mirrors fall under DL-DE Zero, and ask permission for scripted use of the history form (DE-5) | 09-28 | Courtesy for P1; P14 (DE-5) |
| C9 | **BAFU** (CH-1…CH-8): `abfragezentrale@bafu.admin.ch` (live data), `hydrologie@bafu.admin.ch` (history orders) | Courtesy notice of 10-min LINDAS/hydrodaten use. Ask what `threshold_customer` means, about the history order (CH-8), and whether the CSV is UTC or UTC+1. (The hydrodaten polling permission is C13; one e-mail may carry both) | 09-28 | Courtesy for P1; P14 (CH-8) |
| C10 | Backlog providers | HLNUG, LfU Bayern and the Dutch water boards (Vechtstromen, Rijn en IJssel, Waterschap Limburg, and the Brabant boards De Dommel, Brabantse Delta and Aa en Maas, §10 R8): addresses not researched. (LfU RLP and LUBW moved to C11/C12) | after launch | Backlog |
| C11 | **LfU Rheinland-Pfalz** (DE-10) — **send now**: `poststelle@lfu.rlp.de`; Landesamt für Umwelt Rheinland-Pfalz, Kaiser-Friedrich-Straße 7, 55116 Mainz, tel. 06131 6033-0 | Consent (Impressum: *"nur mit Zustimmung des LfU … vervielfältigt … an Dritte abgegeben … öffentlichen Wiedergaben"*) to capture, store and publicly display the **forecasts at 66 gauges** (p10…p90), the **46 alert regions** and the W/Q values, with the source credit "LfU" and the Bearbeitungsdatum; the §0.2 API/export and history questions. The single most valuable forecast permission (catalogue §0.5): Rhine Maxau → Emmerich, Mosel incl. Perl/Stadtbredimus/Wasserbillig, Ahr, Nahe, Lahn, Sauer, Our, Kyll, Prüm | 09-28 | **P13 (DE-10)**; the P8 coverage matrix row "after a permission" |
| C12 | **LUBW** (DE-12) — send now: `Pegelinfo@lubw.bwl.de` | Consent under the Impressum for the Upper Rhine tributaries (Murg, Kinzig); ask whether forecasts are published as data (UNVERIFIED); the §0.2 API/export and history questions | 09-28 | P13 (DE-12); not needed for the first release |
| C13 | **BAFU hydrodaten polling**: `abfragezentrale@bafu.admin.ch` | Ask whether polling the undocumented hydrodaten website files is acceptable, and at what interval: CH-2 `hydro_sensor_pq.geojson` (thresholds `wl_1..wl_4`), CH-4 `q_forecast` (forecasts) and CH-5 `hydro_warn_levels` (warning sections); whether the 10-min rule of the BAFU 2019 conditions applies to them; and whether thresholds and forecasts are, or will be, on LINDAS (§10 R5). CH-2/4/5 are public under the BAFU conditions ("Freie Nutzung", §6 10-min rule, §8 forecasts free; catalogue §0.8), and silence by the go/no-go date keeps them public. **Fallback if BAFU objects to public use: the owner audience** (D22), instead of stopping: CH-2/4/5 stay in the owner view, and the public site shows CH-1 LINDAS `dangerLevel` plus the open CH-6 geo.admin.ch classes and national warning map (no permission needed; added in P7) and no Swiss forecasts. Only an explicit request to stop fetching the files stops their capture | 09-28; go/no-go 10-31 (P7) and 11-06 (P8) | P1 (capture continues), **P7 (CH-2, CH-5 audience)**, **P8 (CH-4 audience)** |
| **D — During the build** (action IDs D1–D8 are separate from the decision IDs D1–D22 of §6.1; the text says "owner action Dn" for these) | | | | |
| D1 | Approve each `/plan`, merge PRs and approve `production` deployments | – | continuous | every phase |
| D2 | Run the `[owner]` acceptance items | The scripts and checklists are supplied in each PR | per phase | closing each issue |
| D3 | DST weekend | On 2026-10-25 after 03:00 local, check `/status/capture.json`: every spec is fresh, and LU-1 and NL-2 payloads are archived | 10-25 | P5 (DST fixtures) |
| D4 | Basemap job | Run the first extract (P3). Enable the quarterly timer | 10-09 | P3, P4 |
| D5 | Monthly and quarterly operations | Check the restore-drill result monthly. Run `restic forget --prune` from the workstation quarterly. Watch the disk trend | from 11-01 | P1 onward |
| D6 | RWS CTD switch | On 2026-11-05/06 check the nightly contract check and the RWS updates page; if the API hosts or the NL-4 file path moved, update the base URLs in config (§10 R4) | 11-06 | P2b, P8 (NL-1 continuity) |
| D7 | First flood event | When an NL-bound Vigicrues forecast, a Swiss warning section above level 1, or an LHP class ≥ 2 appears live, tell the agent: the archived payloads become regression fixtures (§10 R2) | when it happens | P7, P8 (fixtures; not blocking) |
| D8 | Answer the gap-check decisions | D18 (crosswalk) before P7b; D21 (uncovered rivers) before P10b; D19 and D20 before P12 | D18 10-31; D21 11-10; D19/D20 11-26 | P7b, P10b, P12 |
| **E — Launch** | | | | |
| E1 | Send the BfG Belegexemplar (C6) and record it | `registry/permissions/DE-2.md` | ≤ 12-03 | P12 (DE-2 from `owner` to `public`) |
| E2 | Tell RWS, ITZBund and BAFU about go-live | Courtesy | 12-04 | – |
| E3 | Timed rebuild drill on a temporary VPS | Delete the temporary VPS afterwards | ≤ 12-03 | P12 |
| E4 | Sign the launch checklist | `docs/launch-checklist.md` | 12-04 | **Public launch** |
| E5 | Approve the legal pages | The disclaimer, colophon (operator name and contact) and privacy notice in NL and EN (catalogue gap item 18); confirm the privacy notice matches the logging configuration | 11-25 | P10b, P12 (launch checklist) |

---

## 7. Roadmap issue (content)

Title: **Roadmap: river levels flowing into NL (fresh start)**.

It contains:
- the table in §1, with each phase linked to its issue;
- the Gantt chart and dependency graph from §1;
- a permission tracker for C1–C13: sent, answered, granted or refused, the audience and channel flags granted, the go/no-go date, and the permission-record link (C1/C2 as personal-viewer requests; C3/C4 as optional public-display requests);
- the **audience table** (D22): every source with `public`, `owner` or `off`, the `private_basis` link for each owner source (catalogue §0.8), and the owner-view status (WireGuard set up, A8; owner site live, P12a);
- the owner-decision table (§6.1), with status (D22 decided);
- the hard dates: **recorder live ≤ 10-02**, **launch ≤ 12-04**;
- the P11 cut list.

---

## 8. Traceability to the requirements

| Requirement | Covered by |
|---|---|
| Public map on a free/open basemap, self-hosted | P3, P4, P10 (Protomaps PMTiles, MapLibre) |
| NL, DE, BE, FR, LU and CH from the start, including Moselle/Sauer and upper Rhine/Aare | P1 capture (all public IDs and the owner-audience IDs), P2, P5, P7, P8; on the public site Belgium has the ~25 ungated points of catalogue §0.6 (P5) until P13 (HIC, VMM, NLWKN, RLP, LUBW, and SPW/AGE public flips); the owner view adds SPW and the AGE forecasts and thresholds from P5c (D22) |
| Show sources whose terms allow only personal use, to the owner alone ("if that means only myself can use, that's also okay") | D22, ADR-0017, catalogue §0.8: P0 (audience, `private_basis`, invariant 11), P1 (owner capture), P2 (`own_*` views, `rws_owner_api`), P5c (SPW, AGE adapters), P6 (public reaches unchanged), P7 (owner thresholds), P8 (owner forecasts), P9 (owner publisher, owner API, owner canary), P10 (owner mode, banner), P11 (Walloon Meuse in the flow chain), P12 (WireGuard-only owner site, security review, launch checklist), P13 (VMM/HIC as owner, public flips), P14 (private backfill) |
| See water flowing into NL | P6 (graph), P11 (flow, upstream chain, reach colouring, playback, Hovmöller) |
| Date/time selector, including the near future | P4 (past), P8 (future), P10 |
| Collection from go-live; history later | P1 (live ≤ 10-02, seeds), P14 (LATER) |
| Water level, discharge, forecasts, thresholds and alert levels, classified honestly | P2, P5 (H/Q), P8 (forecasts, §0.5 coverage), P7 (references, classes, warnings, basis; the §4.9 crosswalk signed off in D18), P12 (flood drill) |
| Modest traffic with flood spikes | P9 (static-first, load shedding), P12 (load tests, flood drill, egress budget, brownout, CDN runbook) |
| NL default + EN; names as published | P0 (Paraglide), P4, P10; registry `name`/`water_name` exactly as published |
| One VPS with Docker Compose, DB + worker + API + TLS proxy | P1b, P2, P9 (A§11) |
| Fresh start: tag `legacy-v0`, nothing reused | P0a, ADR-0001, blob check |
| Phase issues with Build, Code review and Security review prompts, and a roadmap issue | §4 template, per-phase model tables, §7 |

---

## 9. Amendments after the catalogue gap check (2026-09-23)

`SOURCE-CATALOGUE.md` was revised by the gap check in `plan/CATALOGUE-GAPS.md` after this plan was written. This section lists, per gap item, what this plan now does about it. Use it to patch phase issues that were drafted before the amendment: "Affected phases" names every phase whose Scope in, Acceptance criteria, Risks or Review focus changed. "Covered" means the plan already handled it before the gap check. "Owner" means a new or amended entry in §6.1 (D) or §6.2 (A–E). Where §10 (2026-09-24) changes an item below (`dark` retired in favour of `owner` or a withheld `off` series; SPW and AGE moved from P13 to P5c as owner-audience sources; the C13 fallback now the owner audience), §10 wins; the rows below stay as the record of the 2026-09-23 amendment.

### 9.1 Gap items

| Gap # | Decision | What changed | Affected phases | Affected sections |
|---|---|---|---|---|
| 1 | amended | The unrecoverable streams (forecast runs, alert/class states, threshold versions; catalogue §0.1, §0.1a) are enabled first, and a CI test enumerates §0.1a. NL-1 forecasts now cover **all** 183 H + 13 Q locations (40 curated hourly, the rest every 3 h, inside the RWS budget). DE-6 takes all 16 states with `If-None-Match`. FR-5 is stored only when `DtHrInfoVigiCru` changes. NL-4 adds the link-page watch. Seeds = the §0.1b day-0 harvest, now including **LU-5 every CAP dump since 2025-06 (833 files)** and LU-1. CH-1 `dangerLevel` and CH-2 `wl_*` changes are kept forever (loader promotion from P7) | P1, P7 | PHASES P1 (Scope P1a; AC: §0.1a enumeration, seed report; Risks; Review); P7 (Scope P7a raw retention). A§2 principle 3; A§7.2 (priority and retention notes; rows NL-1 forecasts, NL-4, DE-6, FR-5, LU-1, LU-5, CH-1, CH-2); ADR-0003 |
| 2 | amended + owner | Flood fixtures (§0.4): LHP test server (stations 1–3, string alert classes 1/2/4/5) plus hand-edited class 4 / class 6 / class-less; real AGE LU-Alert flood alerts with Cancel and TEST; Wayback `InfoVigiCru` 2023-12-11 (old casing); hand-built CH-5; CH-4 storm Ciarán (Wayback, gzip); FR-4 Loire payload as a schema-only fixture. `WV` absent or capped above HSW → "no forecast". **Flood drill** before launch in compose e2e with the k6 flood scenario running. Owner: C6 now asks BfG about `WV` above HSW (R1); new owner action D7 in §6.2 (promote the first live flood payloads to fixtures, R2) | P7, P8, P12 | PHASES P7 (Scope P7a flood fixtures; AC flood fixtures; Risks); P8 (Scope P8a DE-2, P8b CH-4 and FR-4; AC; Risks); P12 (Scope P12a flood drill; AC flood drill; Review; launch checklist). §6.2 C6, D7 |
| 3 | amended + owner | §0.5 coverage matrix: P8 publishes forecast coverage per reach and per country (health endpoint, then `status.json` from P9a); empty reaches say "no official forecast" and name the agency that would supply it. EFAS and GloFAS are not used (P8 scope out, ADR-0010; GloFAS "model outlook" only in the backlog). **LfU RLP permission moved to "send now"** (new C11, `poststelle@lfu.rlp.de`) and LUBW too (new C12); DE-10 (66 forecast gauges p10…p90, 46 alert regions, W/Q) and DE-12 are gated P13 sources; DE-10/DE-12 `off` in the registry and in D3 until consent; RLP and LUBW removed from the backlog and from C10. C7 asks RWS about the longer fan forecasts (R3) | P0, P8, P13, P14 | PHASES P0 (registry flags; AC); P8 (Scope P8a coverage; Scope out; AC; Risks; Providers); P13 (Goal; Expected order; Scope DE-10, DE-12; AC; Providers; Risks; Review); P14 (backlog). §6.1 D3; §6.2 C7, C10, C11, C12; §7; §8. A§7.2 "Not captured"; ADR-0007; ADR-0010 |
| 4 | amended + owner | P5 adds the **ungated Belgian set** (§0.6): 7 RWS points on Belgian soil (NL-1 registry rows: `antwerpen`, `lixhebiefaval`, `maaseik`, `herenlaak`, `lanaken`, `kanne`, `smeermaas.zuidwillemsvaart`) and the **18 NL-bound Hub'Eau partner stations** as `primary` (exception to the FR-1 mirror rule until BE sources are public); Tournai, Solre-Erquelinnes and Roesbrugge excluded; `sasvangent` is NL. P6 adds the rivers of those points and keeps canal points on overrides. The permission tracker records sent/answered/conditions/channels and a **go/no-go date** per source. C2 names the Kempen gauges; C3 asks about the Metawal static-image route; the EU HVD regulation is cited as a soft argument only (§6.2 C header). P1 captures the whole set from day one (NL-1 specs, FR-1 code coverage test). When a BE source goes public in P13, its partner stations switch to the operator's feed and the FR-1 copy becomes `mirror` | P0, P1, P5, P6, P11, P13 | PHASES P0 (Scope P0b docs); P1 (Scope P1a; AC); P5 (Scope P5a FR-1 and Belgian set; AC precedence and Belgian set; Providers; Risks; Review); P6 (Scope P6a/P6b; AC); P11 (Providers); P13 (Scope "for every source"; AC); §6.2 C2, C3; §8. A§7.2 (Belgian coverage, mirror exception); A§7.4 item 6; ADR-0007 |
| 5 | amended + owner | **Licence channel flags** (§0.7: `display`, `api`, `bulk_export`, `history_export`, attribution text/URL, last-updated/retrieval-date duties) in `registry/sources.yaml` with defaults (all on for open licences; `api`/exports off for anything under written permission) and a validator; schema columns on `source`/`series` (narrow, never widen); the views enforce the channels and the history window; P9 adds the **display-only canary** and a per-response `attribution` array; invariant 8 now covers channels (goes verbatim into `CLAUDE.md` in P0); P13 permission records state the granted channels; the launch checklist verifies the flags; every permission e-mail asks about API redistribution and history archives | P0, P2, P9, P12, P13 | PHASES P0 (Scope P0b registry and docs; AC; Review); P2 (Scope P2a schema); P9 (Scope P9b; AC channel canary and attribution; Risks; Review); P12 (launch checklist); P13 (Scope "for every source"; AC; Risks; Review); §6.2 C header. A§2 principle 6; A§6 (`source`, `series`, views); A§9.2 rules; A§12.1 invariant 8; ADR-0007 |
| 6 | amended + owner | P7 uses the **§4.9 crosswalk**, which needs owner sign-off (**new D18**, §9 Q31; P7b waits for it). Gauge class beats area class; area classes colour stations only with a "section" badge (P10). LHP duplicate rule; features **without an `lhpClass` key** (216) → `no_ref`; LHP alert scale (string, 1/2/4/5/6) kept apart from the station scale. **Correction:** FR-5 station → section now comes from `TronEntVigiCru` `aNMoinsUn` (the `StaEntVigiCru` link is a placeholder), captured daily in P1; no section covers the French Escaut/Scarpe/Deûle | P1, P7, P10 | PHASES P1 (capture via A§7.2); P7 (header; Scope P7a FR-5, DE-6; Scope P7b; AC; Risks; Review); P10 (Scope P10a; AC). §6.1 D18; §6.2 D8. A§7.2 rows FR-5, DE-6; A§7.4 items 6 and 10; A§10; ADR-0009 |
| 7 | amended + owner | **Correction:** NL-4 is Waterinfo display classes, not alert levels. The P2b converter follows the §2.1 specification (union of `Gehele jaar` and seasonal windows, lower `Priority` wins, slug dedup 6,245 → 1,542, bounds from `From`/`To`, `'NULL'` as a string, the list of curated series without classes) with new AC; `reference_value` gets a recurring season and `priority`; P1 watches the link page and alerts on a new file or a 404 (CTD risk); P7 and P10 label NL-4 as "not an official warning". C7 asks about WMCN phases and the next edition (R3) | P1, P2, P7, P10 | PHASES P1 (Scope; Risks); P2 (Scope P2a schema, P2b NL-4; AC; Review); P7 (Scope P7a NL-4; Risks); P10 (Scope P10b disclaimer, Method; Review); §1 dated events; §6.2 C7. A§6 `reference_value`; A§7.2 NL-4 row; ADR-0009 |
| 8 | amended (decision) | **D16 amended: no converted absolute height for French stations** (nor for any zero taken only from Hub'Eau metadata, such as the §0.6 Belgian partner stations) in the first release; they show the published gauge zero marked unverified. The datum function returns "not converted" for IGN69/NGF-1884 (P2), the classifier skips them (P7), the panel shows the gauge-zero note (P10), each with a [CI] check. The A§6 datum line no longer states IGN69 ≈ NAP + 0.47…0.49 m. A curated French zero table is backlog (R6) | P2, P7, P10, P14 | PHASES P2 (Scope P2a; AC); P7 (Scope P7b; AC); P10 (Scope P10a; AC; Review); P14 (backlog); §6.1 D16. A§6 Datums; A§10; ADR-0009 |
| 9 | covered + amended + owner | Already covered: hourly restic of `raw` to an Object Lock bucket, monthly and forced restore drill, disk alarm at 75% (P1b); the RTO ≤ 4 h rebuild drill (P12, E3). Added: **RPO ≤ 1 h** stated for the raw archive; Compose `cpus` limits and an `rws_api` connection limit that reserves the ingestion pools (P12a); **new D19** on a second capture-only collector (default: not before launch; backlog) | P12, P14 | PHASES P12 (Scope P12a tuning; Risks; Review); P14 (backlog); §6.1 D19. A§9.2 database session; A§11.1; A§11.3 recovery objectives; ADR-0011 |
| 10 | amended + owner | **Egress budget** in P12a: a Playwright session profile measures bytes per map session, and `docs/capacity.md` compares the flood-day peak with the uplink and the month with the traffic quota ([CI] + [owner] AC). **New D20**: if either exceeds 50%, arm a CDN pull zone for `/tiles/*` and `/assets/*` only, disclosed on the privacy page; no automatic OpenFreeMap switch | P10, P12 | PHASES P10 (Scope P10b privacy); P12 (Scope P12a; AC; Risks; Review). §6.1 D20; §6.2 D8. A§10 privacy; A§12.2 privacy |
| 11 | amended | P1b adds `rws-reachability`: an owner-run check on the VPS over IPv4 and IPv6 against every §1a endpoint and the sandbox failures to re-test, asserting on body signatures; [owner] AC and a new risk (R7) | P1 | PHASES P1 (Scope P1b; AC; Risks). A§5 layout; A§12.2 |
| 12 | amended + owner | **DST gate**: an adapter with an offset-less convention is not enabled in `load` until synthetic fall-back and spring-forward fixtures pass; enforced by a registry test in P5 (LU-1) and applied to DE-6 (P7), DE-3 (P8) and DE-10/DE-12/DE-13 (P13). NL-2 in P2 was already covered by its DST criteria. RWS CTD: C7 asks about the API hosts (R4); **new owner action D6** (§6.2) checks the contract check and updates page on 11-05/06; the NL-4 path is flagged at risk | P5, P7, P8, P13 | PHASES §1 dated events; P5 (Scope P5b DST gate; AC; Risks; Review); P7 (Scope P7a DE-6; AC); P8 (Scope P8b DE-3; AC); P13 (Scope DE-10, DE-12; AC); §6.2 C7, D6. A§7.4 item 2 |
| 13 | amended | **Per-format guards** (§6.7; not "JSON only"): ZIP ≤ 10 allowlisted members, ≤ 200 MB uncompressed, ratio ≤ 50:1, streamed; XML with DTDs and entities off and `<!DOCTYPE` rejected, CAP ≤ 1 MB; XLSX gets both; CSV row, column and field caps with a declared encoding; HTML only via `data-to-json`. Allowlist adds `download.data.public.lu`, `rijkswaterstaatdata.nl`, `pegelonline.wsv.de` and `vorhersage.bafg.de` (DE-3 is captured dark from P1; gated hosts only on permission); canonical URLs avoid cross-host redirects. [CI] AC in P1 | P1, P2, P5, P7, P13 | PHASES P1 (Scope P1a polite client; AC; Review); P2 (Scope P2b NL-4); P5 (Scope P5b DE-7); P7 (Review); P13 (Scope LU-4, DE-10, DE-12). A§7.1; A§12.2 fetcher |
| 14 | amended + owner | **New D21** (§9 Q32): the uncovered rivers are accepted for the first release and listed on the Method page (Kempen rivers until VMM, RLP tributaries until RLP, NL water-board stretches via German and RWS gauges, canals only at the RWS points; **Austria and Liechtenstein out of scope**). P6 adds the Kempen rivers, the Voer and Ahr/Kyll/Prüm to `rivers.yaml`; P13 BE-2 includes the Kempen gauges (live check, R8) and DE-10 the RLP tributaries; the Brabant water boards join C10 and the backlog | P6, P10, P13, P14 | PHASES P6 (Scope P6a); P10 (Scope P10b Method); P13 (Scope BE-2, DE-10; Providers); P14 (backlog). §6.1 D21; §6.2 C2, C10, D8 |
| 15 | owner + amended | **New C13**: ask BAFU (`abfragezentrale@bafu.admin.ch`, send by 09-28, go/no-go 10-31 for P7 and 11-06 for P8) whether polling the undocumented hydrodaten files CH-2, CH-4 and CH-5 is acceptable and at what interval, and whether thresholds and forecasts are or will be on LINDAS (R5). Fallback (on a refusal, or on no answer by a go/no-go date the owner does not extend): CH-1 `dangerLevel` plus the open CH-6 geo.admin.ch classes and warning map (no permission needed, so added in P7, not P13), no Swiss forecasts | P5, P7, P8 | PHASES P5 (Risks); P7 (Scope P7a CH-2/CH-5, CH-6 fallback; Providers); P8 (Risks); §6.2 C9, C13. A§7.2 CH-2 row and "Not captured" (CH-6) |
| 16 | amended | `docs/capacity.md` from the first 48 h of production capture (after dedup and zstd): bytes/day per spec, year-1 projection vs disk and bucket, retention per source ([agent-prod] AC). Delta-friendly gates (`DtHrInfoVigiCru`, conditional GETs; NRW layer 10 if the zip dominates) | P1 | PHASES P1 (Scope P1b; AC; Risks). A§5 layout; A§7.2 retention; A§7.3 size budget; A§11.4 |
| 17 | amended | A station-registry schema with the gap-17 fields (canonical and provider IDs, coordinates, datum and zero with validity, river and km system, tidal/weir flags, expected threshold and forecast source, licence-gate status, `first_release`) lands in P0b with a validator, is filled in P2 (DE, NL) and P5 (FR, CH, LU, ungated BE), and feeds two metrics: the share of `first_release` stations with a non-grey class (P7) and with a current forecast (P8), both from sources that need no permission | P0, P2, P5, P7, P8 | PHASES P0 (Scope P0b; AC); P2 (Scope P2a tier-1 DE registry); P5 (Scope P5a Belgian set; Scope P5b tier-1 LU registry); P7 (Scope P7b coverage report); P8 (Scope P8a coverage). A§6 station registry |
| 18 | amended + owner | P10b adds a consolidated **"Geen officiële waarschuwingsdienst / Not an official warning service"** page with the official channel for each of the six countries (incl. RWS/WMCN), a **colophon** (operator, contact, licences) and an expanded **privacy notice** (masked logs 14 days, limiter state in memory, no analytics, no third parties, CDN disclosure), with [CI] AC. The launch checklist requires owner approval (**new E5**) and a privacy notice that matches the logging configuration | P10, P12 | PHASES P10 (Scope P10b; AC); P12 (launch checklist); §6.2 E5. A§10 routes, privacy, legal pages; A§12.2 privacy |
| 19 | amended | River names from a reviewed `name_nl`/`name_en` table in `rivers.yaml` (P6); provider class and alert labels mapped to reviewed NL/EN text in `registry/labels/<SOURCE-ID>.yaml`, with an unmapped label failing CI (P7); the UI shows station names as published, river names from the table, and provider labels raw beside our translation (P10) | P6, P7, P10 | PHASES P6 (Scope P6a; AC); P7 (Scope P7a; AC); P10 (Scope P10a; AC; Review). A§5 layout; A§10 |
| 20 | amended / covered | `pegeldaten.zip` is now [V]: the P1 seed was already planned (covered). DE-8 `hydro/q` is a listing only: the P14 route must be verified. DE-6 alert schema verified via the test server: used in P7. FR-4 Loire-only: schema-only fixture in P8. LU-3 "hourly" partly verified: hourly polling with content-hash dedup in P13. `WV` weekend schedule [D]: schedule-aware run-age alert in P8 with [CI] AC. §6.5 conditional requests: DE-6 `If-None-Match`, FR-5 no ETag (A§7.2). LU-1 third-party gauges: RLP-operated gauges `dark` until C4 answers (P5b); C4 asks. Open owner decisions (R12): see §9.2 | P5, P7, P8, P13, P14 | PHASES P5 (Scope P5b LU-1; AC); P7 (Scope P7a DE-6); P8 (Scope P8a DE-2, P8b FR-4; AC); P13 (Scope LU-2/3/4); P14 (Sources table); §6.2 C4. A§7.2 rows DE-6, FR-5, LU-1; A§7.3 |

### 9.2 Remaining open items R1–R12 (catalogue §10) and what closes them

| R# | Open item | Closed by |
|---|---|---|
| R1 | BfG `WV` above HSW / Marke II | Owner action **C6** (asks BfG). Until answered, P8 shows a missing or capped run as "no forecast"; P12 gates DE-2 publication |
| R2 | Flood fixtures for FR-4 (NL-bound), CH-5, DE-10 | P1 captures them live whenever they occur; hand-built fixtures in **P7** (CH-5), **P8** (FR-4 schema) and **P13** (DE-10); owner action **D7** promotes the first real payloads |
| R3 | RWS fan forecasts as data; NL-4 ↔ WMCN phases | Owner action **C7**; meanwhile **P7/P10** label NL-4 as display classes, and fan forecasts stay out of scope |
| R4 | RWS API hosts after the CTD switch on 11-05 | Owner actions **C7** (Servicedesk and GitHub Discussions) and **D6** (11-05/06 check); URLs in config (P1); nightly contract check (**P2b**) |
| R5 | Permission answers (HIC, VMM, SPW, AGE, NLWKN, BfG, LfU RLP, LUBW, BAFU) | Owner actions **C1–C6, C9, C11–C13** with the tracker and go/no-go dates (**P0b**); each grant becomes a **P13** PR (C13 decides the **P7/P8** audience of CH-2/4/5). Since D22 (§10), SPW and AGE run in the owner view without waiting (C3/C4 are optional public-display requests), and HIC/VMM credentials first enable the owner view |
| R6 | IGN69 offset and French gauge zeros | Decision **D16** (amended): no French converted heights in **P2/P7/P10**; the curated zero table is in the **P14** backlog |
| R7 | Reachability from the production VPS | **P1** [owner] criterion: `rws-reachability` over IPv4 and IPv6 with body signatures |
| R8 | VMM Kempen gauges live; Brabant water-board data | **P13** (BE-2 PR checks live delivery after the C2 token); Brabant boards via **C10** and the **P14** backlog |
| R9 | What RWS `kanne` Q measures | Owner action **C7**; **P5** publishes it without a river assignment, **P6** places it only by override |
| R10 | Austria and Liechtenstein inflows | Decision **D21** (out of scope for the first release; backlog if that changes) |
| R11 | Design items: volume, backup/RPO/isolation, bandwidth, DST fixtures, seed list and coverage, privacy/legal, multilingual | Volume: **P1** (`docs/capacity.md`). Backup/RPO: **P1b** (covered) + A§11.3; isolation: **P12a**; second collector: **D19**. Bandwidth: **P12a** + **D20**. DST: **P5** gate, applied in **P7/P8/P13**. Seed list and coverage: **P0b/P2/P5/P7/P8**. Privacy/legal: **P10b/P12b** + **E5**. Multilingual: **P6/P7/P10** |
| R12 | Owner decisions: go-live date, commercial or not, who sends the e-mails, crosswalk sign-off | Go-live: the hard dates (recorder ≤ 10-02 sets the data epoch; launch ≤ 12-04); `T_MIN` is `displayStart`, decision **D9** (default: seeded data from about 08-24, marked with the epoch). Commercial: decision **D1** (A1 by 09-25). E-mails: the owner sends §6.2 C from the contact mailbox (A2, P0 [owner] criterion). Crosswalk: decision **D18** (owner action D8, by 10-31) |

---

## 10. Amendment: owner audience (2026-09-24)

The owner decided on a **hybrid audience** (D22; ADR-0017; catalogue §0.8). The public site keeps the open sources exactly as planned. A login-only **owner view**, used by the owner alone and never shared, also shows the sources whose terms allow personal use. The flag `publication: public | dark | off` becomes `audience: public | owner | off`, and `dark` is retired: DE-2 and DE-3 become `owner`, and the RLP-operated gauges inside LU-1 become a withheld series (`off`). Use this table to patch phase issues drafted before 2026-09-24. "Affected phases" names every phase whose Scope in, Acceptance criteria, Risks, Review focus or header changed; "Affected sections" names the exact places. No window and no model/effort table changed: P5c uses the P5a models (Opus xhigh · Sonnet `/code-review xhigh` · Sonnet xhigh).

| Change | Affected phases | Affected sections |
|---|---|---|
| **O1. Decision and evidence.** New decision **D22** (hybrid audience, decided). New catalogue **§0.8** with the per-source verdict and verbatim clause: owner-only use without consent is allowed for BE-3 SPW, LU-2/3/4 AGE, DE-2/DE-3 BfG (privately, without the Belegexemplar) and CH-2/4/5 BAFU (public too); VMM needs only a token; HIC needs TYPE-3 credentials; DE-9 NLWKN, DE-10 LfU RLP and DE-12 LUBW stay off (even private storage or copying needs consent). New **ADR-0017** "Owner audience for personal-use sources". Not legal advice | P0 | PHASES §6.1 D22 (new); P0 Scope P0b Docs (`docs/adr/0017`, threat model v1 with the owner channel). A header, §1 (new row), §13 ADR-0017 (new) and ADR list note. Catalogue header, §0.2 (owner-only note), §0.8 (new) |
| **O2. Registry `audience` and `private_basis`.** `audience: public \| owner \| off` per source replaces `publication` (a series may only narrow it). `private_basis` (`clause` verbatim from §0.8, `url`, `retrieved`) is mandatory for `owner`. Initial values: `public` = the §0.2 safe sources + CH-2/4/5; `owner` = BE-3, LU-2, LU-3, LU-4, DE-3, DE-2 (until the Belegexemplar); `off` = NL-3, DE-9, DE-10, DE-12, DE-13 and the backlog, BE-1/BE-2 until credentials (then `owner`). Owner channel defaults: `display`, `api`, `history_export` on and `bulk_export` off. Station rows carry `audience`; owner-station rows hold identification only. Registry canaries: an owner canary source and a withheld canary series | P0, P13 | PHASES P0 Scope P0b Registry, Licence channel flags, Station registry schema; P0 AC registry (rewritten), **`private_basis` validation (new)**, channel flags (extended); P0 Risks (wrong audience); P0 Review (code); P13 Scope "Audience on arrival", "For every source"; P13 AC permission record. A§2 principle 6; A§5 registry line; A§6 `source`, `series`, station registry note; ADR-0007 |
| **O3. Security invariants.** Invariant 2 (public vs owner roles and views), 8 (`audience: public` only; withheld canary; `private_basis` for `owner`) and 9 (synthetic owner fixtures) amended; **new invariant 11, owner-audience isolation**, verbatim-ready for `CLAUDE.md` and every prompt's `<INVARIANTS>` block. A doc test checks that `CLAUDE.md` quotes invariants 1–11 verbatim | P0 (and the `<INVARIANTS>` block of every phase issue, P0–P14) | PHASES P0 Scope P0b `CLAUDE.md` (invariants + audience rules); P0 AC doc test (new); P0 Review (security). A§12.1 invariants 2, 8, 9, 11 |
| **O4. Owner-audience capture from day one.** Specs: BE-3 KiWIS groups 1962373 and 1962340 every 10 min (2 requests) + daily metadata; LU-2 39 JSON files hourly (no query string; the LfU RLP-operated Bollendorf and Gemünd files not fetched); LU-3 55 percentile files of the 11 AGE-computed stations hourly (content hash; first-enabled, with LU-4; the LfU RLP Moselle runs not fetched until C4 or C11); LU-4 station pages weekly (`data-to-json` only); DE-2/DE-3 now `owner`. Allowlist: `hydrometrie.wallonie.be` (BE-3), `inondations.public.lu` for LU-2/3/4. Budget tests. LU-2 7-day first capture. Owner spec status only in `owner/status/capture.json`; public `capture.json` gets the aggregate `owner_specs` count only. Healthchecks **owner** group (18 checks). `/srv/rws/owner` created. D3 amended (no longer "no dark capture of SPW/AGE") | P1 | PHASES P1 Scope P1a Polite client (allowlist), unrecoverable streams (DE-2 owner), **Owner-audience capture (new)**, Seeds, Status and alerts; P1 Scope P1b bootstrap (`/srv/rws/owner`); P1 AC allowlist, budget config, **owner-audience capture (new)**, capture freshness (`owner_specs`); P1 Providers; P1 Risks (2 new); P1 Review (both). §6.1 D3. A§4 roles table (`capture`); A§7.1 retention/audience line, Capture status; A§7.2 table column "Audience", rows DE-2, DE-3, **BE-3, BE-3 metadata, LU-2, LU-3, LU-4 (new)**, LU-1, CH-2, owner-audience paragraph, Not captured, Belgium paragraph; A§7.3 config tests; A§11.1 `capture` volumes; A§11.3 healthchecks; A§12.2 allowlist, HTML rule |
| **O5. Schema, views and role.** `source.audience` + `private_basis` (CHECK), `series.audience` (narrow only), `reference_value.source_id`; **`own_*`** view family (public + owner rows) beside `pub_*` (public rows only, audience filter at every join); **`rws_owner_api`** (LOGIN, read-only, `own_*` only, `CONNECTION LIMIT 4`; unrelated to `rws_owner`); public roles have no grant on `own_*`; view names only in `apps/server/src/db/audience.ts` (CI grep); public health shows only an `owner_sources` count | P2 | PHASES P2 Scope P2a `db/migrations` (audience columns, roles, view families), Registry sync, Minimal `api` role; P2 AC Roles (rewritten), **audience filter at every join (new)**; P2 Risks (new); P2 Review (security). A§5 import rules; A§6 schema (`source`, `series`, `reference_value`, sentinels) and "Audiences, views and roles" (rewritten); A§8 note; A§12.2 Database roles |
| **O6. New PR P5c "owner-audience adapters: SPW BE-3 and AGE LU-2/LU-3/LU-4"** (moved out of P13). Shared KiWIS client moved here from P13. BE-3 H/Q/QADM (UTC, datum `9999.0`, quality codes, same-name stations, impounded reaches, SPW attribution, catch-up from 2026-08-24). LU-2 as an LU-1 twin, never primary. LU-3 and LU-4 parse + normalise (loading enabled in P8a/P7a). **Synthetic fixtures** with a `synthetic: true` marker. Owner twins: SPW-operated §0.6 partner stations and LU-2 stay twins in both audiences; the LU-1 offset detector keeps using DE-1 Perl | P5, P13 | PHASES §1 table PR column (P5 gains c); P5 header PRs, Goal, Scope P5a FR-1 (owner twins), Scope P5b LU-1 (RLP gauges `off`), **Scope P5c (new)**, Scope out; P5 AC precedence (RLP `off`), **P5c AC ×5 (new: fixture standard and synthetic marker, BE-3, LU-2/3/4, audience, agent-prod health)**; P5 Providers; P5 Risks (3 new); P5 Review (both); P5 model note (P5c = P5a models); P13 Scope Shared KiWIS client. A§6 sentinels; A§7.2 mirrors (owner twins); A§7.4 items 6, 7 (twins table + owner twins), 8, 11 (new) |
| **O7. Public river graph unchanged by owner stations.** Owner-audience stations are snapped and get chainage, but the public `reaches-<ver>.json` and `rivers.pmtiles` are segmented at public stations only | P6 | PHASES P6 Scope P6b Reaches; P6 AC SPW snapping and no owner station in public reach files (new) |
| **O8. Owner-audience references and per-audience classification.** LU-4 vigilance levels, HQ2–HQ100 and status bounds, and BE-3 non-exceedance percentiles (`statistical`) and `CrueDeReference.Top3` (`historical`), stored with `source_id`; the classifier and the coverage report run per audience; LU-4 rows and a BE-3 percentile row (D18 addendum: `low`/`normal` only) apply in the owner view only | P7 | PHASES P7 Scope P7a **Owner-audience references (new)**; Scope P7b classifier (per audience), Coverage report (per audience); Scope out; P7 AC **per-audience classification, LU-4/BE-3 boundary tests, LU-4 change (new)**; P7 Providers; P7 Risks (2 new); P7 Review (both). §6.1 D18 (addendum). A§7.4 item 11 |
| **O9. Owner forecasts.** LU-3 loading in **P8a** (run = series + first step + content hash; floors; `forecastsLimit`); DE-2 `owner` until the P12 gate; DE-3 `owner` (public in P13); forecast coverage matrix **per audience**; the future snapshot and `asof` queries take the audience's view family | P8 | PHASES §1 table PR column (P8a + LU-3); P8 header PRs; P8 Scope P8a DE-2, **LU-3 (new)**, Forecast coverage; Scope P8b DE-3, **Owner view (new)**; Scope out; P8 AC Playwright canary (rewritten), **LU-3 (new)**, public coverage (no owner source), **owner coverage (new)**; P8 Providers; P8 Risks (CH-4, owner run leak); P8 Review (both) |
| **O10. Owner publisher, owner API and owner canary.** `publish-owner` (`--audience owner`, `rws_owner_api`) writes the hot-path files to `/srv/rws/owner/data/v1/` (settled snapshots and frames via the owner API); `api-owner` (pool 2, no export route, `audience: "owner"`, attribution); owner Caddy site in the Caddyfile with `basic_auth`, `tls internal`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, **port unpublished in production until P12a**; production owner canary; **owner canary `777777.777`** absent from every public output; withheld canary (formerly dark) absent everywhere; isolation by construction (roles, volumes, listener) | P9 | PHASES P9 Goal; Scope P9a **Owner publisher, Owner Caddy site, Production owner canary (new)**; Scope P9b canary tests, **Owner API (new)**; P9 AC withheld canary (renamed), **owner canary, isolation by construction, agent-prod canary sweep (new)**; P9 Providers; P9 Risks (leakage, rewritten); P9 Review (both). A§4 diagram and roles table; A§9.1 `sources.json` row and public-output note; A§9.2 Licence channels; **A§9.3 (new)**; A§11.1 services `api-owner`, `publish-owner`, `caddy` volumes |
| **O11. Owner mode in the SPA.** One build; `/runtime-config.json` per site; relative data paths; persistent banner "Persoonlijk gebruik — niet delen / Personal use only — do not share" linking each `private_basis`; "alleen eigenaar / owner only" badges; AGE values as published; query keys per audience; public build free of owner data | P10 | PHASES P10 Scope P10a **Owner mode (new)**; P10 AC **owner mode Playwright, public build grep (new)**; P10 Providers; P10 Risks (2 new); P10 Review (both). A§5 layout (`features/owner`, `lib/config`); A§10 tree and **Owner mode** bullet |
| **O12. Walloon Meuse in the owner flow chain.** The upstream chain, reach colouring, frames and Hovmöller use owner data in the owner view (SPW Meuse gauges from Chooz to Lixhe, plus the Sambre, Ourthe, Vesdre and Amblève); owner split points added by the owner publisher; public outputs unchanged | P11 | PHASES P11 Scope **Owner view (new)**; P11 AC **owner view chain (new)**; P11 Providers (Meuse line); P11 Review (both) |
| **O13. WireGuard-only owner site and launch.** WireGuard on the host (`wg0` 10.66.0.1/24, UDP 51820, owner devices only, `rws-wg-peer`); owner port published only on the WireGuard address, nftables drop off-`wg0`, catch-all 421; `basic_auth` (bcrypt, ≥ 32 random characters); `tls internal`, no public DNS record; owner access log; `verify-owner.sh`; runbooks (device add/revoke, password rotation, exposure). The owner channel joins the final security pass, threat model v2, hardening checks and the launch checklist; DE-2 flips from `owner` to `public`; `noindex` removed on the public site only. New owner action **A8** (WireGuard) | P12 | PHASES P12 header (depends on A8, PRs), Goal; Scope P12a **WireGuard and the owner site (new)**, Final security pass; Scope P12b launch checklist (DE-2 flip, **owner channel (new)**), Going public; P12 AC hardening (extended), **WireGuard-only listener [agent-prod] (new)**, **`verify-owner.sh` [owner] (new)**, BfG (reworded); P12 Providers; P12 Risks (new); P12 Review (security). §6.2 **A8 (new)**, E1. A§5 layout (`host/wireguard/`, `rws-wg-peer`, `verify-owner.sh`); A§11.1 networks; **A§11.5 (new)**; A§12.2 headers, host, agents, threat model |
| **O14. P13 shrinks.** VMM and HIC enter as `owner` when their credentials arrive (public only if the agreement or token terms allow); NLWKN, LfU RLP, LUBW unchanged (consent); SPW and AGE are only **public flips** if they ever grant public display; DE-3 public flip (D4); partner-station precedence switches only when a BE source becomes public | P13 | PHASES P13 Goal, Expected order; Scope Shared KiWIS client (extension only), **Audience on arrival (new)**, BE-3 → public flip, LU-2/3/4 → public flip, DE-3, For every source; P13 AC permission record (rewritten), **owner BE-1/BE-2 isolation (new)**, twins (reworded to "once BE-1 is public"), **owner-status twins via `verify-owner.sh` (new)**; P13 Providers; P13 Risks; P13 Review (both) |
| **O15. Private backfill.** Backfill of owner-audience sources is allowed privately: BE-3 KiWIS history (owner audience), LU-7 AGE archive on request (owner unless public use is granted); backfilled rows and climatology inherit the audience | P14 | PHASES P14 Scope Row rules, Sources table (BE-3, BE-1/2, LU-7); P14 AC owner backfill (new); P14 Review (security) |
| **O16. C13 fallback = owner audience.** CH-2/4/5 stay public under the BAFU conditions unless BAFU objects (silence keeps them public); on an objection they move to `owner` (public: CH-1 + CH-6, no Swiss forecasts); only a request to stop fetching stops capture | P0, P7, P8 | PHASES P0 Registry (CH-2/4/5 `public`); P7 Scope P7a CH-2/CH-5; P8 Risks (CH-4). §6.2 C13. A§7.2 CH-2 row, Not captured (CH-6); ADR-0017. Catalogue §0.8 |
| **O17. Permission requests reworded.** C1 HIC and C2 VMM ask for credentials for a **personal, non-commercial, private viewer** (optionally public display); C3 SPW and C4 AGE become **optional** public-display requests that block nothing (the LfU RLP-origin data on the AGE site stays withheld until C4 or C11: the Bollendorf and Gemünd gauges in LU-1, and, not even fetched, their LU-2 files and the LU-3 Moselle runs); the C header, tracker and P0 e-mail criterion follow | P0, P5, P13 | PHASES P0 Scope P0b Docs (`docs/permissions.md`, request drafts); P0 AC e-mails (rewritten); P0 Review (code); P5 Scope P5b LU-1, P5 AC precedence; P13 Scope BE-3/LU flips. §6.2 C header, C1, C2, C3, C4; §7 permission tracker |
| **O18. Evidence and tracking.** The PR evidence checklist gains an "Audience" line; the roadmap issue gains the audience table and owner-view status; traceability gains the owner-view requirement; §9 notes that §10 wins where it changes a 2026-09-23 item; R5 updated | P0 (templates) | PHASES §2.3 (new line); §7 (audience table, tracker wording, D22 status); §8 (BE row, new owner-view row); §9 intro note; §9.2 R5 |
| **O19. Verification fixes (2026-09-24).** (a) LfU RLP data republished by AGE is treated like the RLP gauges inside LU-1: withheld in both audiences, and not fetched where it comes in its own file (LU-2 `Bollendorf.json` and `Gemünd_Our.json`; the LU-3 Moselle runs at Perl, Stadtbredimus and Wasserbillig, which LfU RLP computes). LU-2 is therefore 39 files and LU-3 55 files of 11 AGE-computed stations, the owner Mosel LU/DE forecast reach stays empty until C4 or C11, and C4 asks about it. (b) Fixtures of every owner-audience source are synthetic from P1 on (validity fixtures; DE-2, DE-3 and LU-3 in P8; BE-1/BE-2 in P13), and the P7 golden-state test uses public providers only. (c) The P5 CH-2 risk follows the C13 owner fallback. (d) Public health reads `pub_source_health`, `pub_twin_check`, `pub_ingest_batch` and the count-only `pub_owner_health`. (e) The owner canary grep also covers `/api/v1/health*`, attribution arrays, the canary source ID and its attribution text; the LU-2 seed stays out of the public `seed-report.json`; the catch-up of a BE-1/BE-2 owner source is an [owner] check. (f) Public ports are published on the explicit public addresses (a wildcard bind would also claim `10.66.0.1:443`), and Docker starts after `wg-quick@wg0`. (g) `verify-owner.sh` checks `/runtime-config.json` rather than the client-rendered banner. (h) The DE-2 `WV` schedule and HSW text is back under DE-2 in P8a. (i) Invariant 11 names health endpoints, attribution arrays and restores, and states what the repository may hold; the catalogue keeps the NLWKN key redacted | P0, P1, P2, P5, P7, P8, P9, P12, P13 | PHASES P0 Scope P0b Registry (series narrowing); P1 Scope P1a Owner-audience capture (LU-2, LU-3), Seeds; P1 AC validity fixtures, budget config; P2 Scope P2a Minimal `api` role; P5 Scope P5c LU-3; P5 AC fixture standard (P5a/P5b), P5c synthetic marker; P5 Risks (CH-2); P7 AC golden state; P8 Scope P8a DE-2, owner fixtures (new), LU-3, Forecast coverage; P8 AC owner coverage; P8 Providers; P9 AC owner canary; P12 Scope P12a WireGuard; P12 AC hardening, `verify-owner.sh`; P13 Scope DE-10; P13 AC fixture standard, catch-up (split into [agent-prod] and [owner]); §6.2 C4; §10 O4, O17. A§6 "Audiences, views and roles" (health views); A§7.2 LU-2, LU-3; A§7.3 budget; A§7.4 item 11; A§11.1 networks; A§11.3 backups; A§11.5 listener, checks; A§12.1 invariant 11; ADR-0017 consequences. Catalogue header, §0.1a, §0.1b and §0.5 (owner notes), §0.8 notes, §1a (NLWKN key redacted) |

---

## 11. Amendment: P1a build (2026-09-29)

What the P1a build found when it recorded every endpoint live (issue #16), and what the recorder does about it. Each item is also in the P1a PR.

| Item | Reality | What P1a does |
|---|---|---|
| DE-7 thresholds | `hochwasserportal.nrw/data/internet/layers/10/index.json` answers 404 (the WISKI-Web app no longer exposes it) | The same threshold values (`LANUV_MNW/MW/MHW`, `LANUV_Info_1..3`) are in `pegel_stationen.txt` inside `pegeldaten.zip`: that file is the §0.1b seed and is captured weekly, kept forever. `alarmlevel.json` per station is not captured |
| DE-3 index | `vorhersage.bafg.de/14-Tage-Vorhersage/` answers 404 | `14-Tage-Vorhersage/index.html`; the file list `registry/seed/de-3.csv` comes from the recorded indexes (Rhine files only) |
| CH-4 stations | BAFU lists 54 forecast stations (catalogue: 55) | `registry/seed/ch-4.csv` is the recorded `hydro_sensor_pq_forecast.geojson`; a daily `ch-4-stations` spec reports a change of that list |
| NL-1 budget | 25 key gauges at 10 min with their Q, 45 others and 196 forecast requests exceed 400/hour | Key gauges fetch H every 10 min; every Q, the other gauges and the Belgian points every 30 min; forecasts: 40 requests hourly, the other 156 in three 3-hourly buckets at :45. Busiest 60 min: 367 requests |
| DE-6 alerts | An empty alert list is the normal state | `min: 0` for the DE-6 alerts list as for the FR-4 list; an empty-but-200 (a zero-byte body) still fails. The checklist allows an empty list for FR-4 only; the owner OK'd the extension on 2026-09-29 (#16, issuecomment-5894422289) |
| `pegelonline.wsv.de` | The §6.7 host of DE-4/DE-5, both `off` | Allowlisted under DE-1 (same provider); no spec uses it yet |
| LU-4 pages | The Bollendorf and Gemünd pages describe LfU RLP-operated gauges | Not fetched, as their LU-2 files (40 of 42 pages) |
| XLSX guard | The NL-4 workbook has 14 members with `/` in their names | An OOXML name profile and a member cap of 20 for XLSX; the flat ZIP rule (≤ 10 members, no `/`) stays for ZIPs |
| CSV guard | `messwerte.txt` (239k rows) and `pegel_messwerte.txt` (2.1M rows) exceed 100,000 rows; LU-1 rows are one field wider than its header | ZIP members keep the column and field caps and are bounded by the ZIP total; a row one field wider than the header is accepted |
| HTTP encodings | – | Only one layer of gzip or br (what we advertise) is decoded; stacked or other encodings are refused |
| croner `protect` | croner re-fires a blocked tick as soon as the busy run ends (a late, queued run) | The scheduler keeps its own busy flag per job: a blocked tick is counted and dropped |
| NL-1 observations | – | The gap-stretch window is capped at P31D (RWS keeps decades; longer gaps are a P14 backfill) |
| FR-1 gap walks | Hub'Eau answers newest first, so a walk from the last success − 60 min that stops at its page cap leaves the oldest part of a gap unfetched | A gap over one day is fetched one closed day window per run, oldest first (`window.step: P1D`), and the window moves only when its whole walk completed. A walk that hits `max_expand` (20 pages after the first; a normal day is ~6) goes on next run below the oldest observation it fetched, so a flood day of any size completes and the window then moves to the end of the whole day; a capped run that got no older (a `next` that never ends) is no success, so the group goes stale and pages. The seed's `page_cap` (400) bounds the whole 30-day seed, and an unfinished seed gets another round every hour for at most 31 days, then is reported incomplete in the log and the daily report |

---

## 12. Amendment: P1b build (2026-09-29)

What the P1b build (issue #16, PR #35) changed or settled against the plan, and why. The owner decided the first five on 2026-09-29, when the plan was approved.

| Item | Plan | What P1b does |
|---|---|---|
| pnpm in the server build image | 12.6.0 | 12.5.1 through `scripts/install-pnpm.sh`: the `packageManager`, lockfile and BOM pin. Bumping to 12.6.0 is its own BOM change (owner decision) |
| `ops` and sudo | – | NOPASSWD sudo, like Debian's cloud user; the SSH key (FIDO2 recommended) is the only secret (owner decision; risk register) |
| Kernel updates | unattended-upgrades | They also reboot at 03:40 UTC when an update needs it (owner decision); the reboot path is an [owner] criterion |
| Grype gate (A§12.2) | P1b | Deferred to P12 (owner decision): Go standard-library findings in the pinned caddy and restic binaries would block the first release. buildx still attaches an SBOM (Syft) to every image |
| VPS architecture | – | amd64 only (owner confirmed) |
| Caddy capability | `NET_BIND_SERVICE` only | None at all. The stock binary's `cap_net_bind_service+ep` file capability makes exec fail under `cap_drop: ALL` (caddy-docker#396), so the web image copies the binary and drops it. Non-root Caddy (uid 65533) binds 80/443 through the namespaced `net.ipv4.ip_unprivileged_port_start` (set explicitly; it covers IPv6). Tighter than planned |
| Secret file modes (A7: 0600) | root 0600 | `root:<per-secret gid>` 0440 in a `root 0700` directory. Compose ignores `uid`/`gid`/`mode` for file secrets and bind-mounts them with their host owner, so a root 0600 file is unreadable to uid 65532. Only the consuming service has the gid in `group_add`, and only it mounts the file |
| Firewall hook | "hook the chain Docker uses" | Docker 29.8.1 still uses the iptables-nft backend: published ports are DNATed in `nat PREROUTING` and accepted in `filter FORWARD → DOCKER-FORWARD`, never INPUT. `nftables.conf` keeps its own `table inet rws` with a forward base chain at priority `filter - 5` (a drop is final in any base chain; it also holds with Docker's experimental nftables backend). It never flushes the ruleset, and `rws-firewall.service` replaces Debian's `nftables.service`, whose `ExecStop` flushes every table (Docker's included). It fails closed at start: `docker.service` `Requires=` it, and `bootstrap.sh` runs `nft -c` before installing a new ruleset. Stopping it keeps the table (no `ExecStop`), and `rws-tick` restores a table deleted by hand |
| `backup` service | on `db`, `egress` | Its own `backup` network, allowed only TCP 443 to the bucket's addresses (an nftables set that `rws-backup` fills before each run; the repository may name no other port). It is a job (`profiles: [jobs]`, `restart: "no"`, no healthcheck), started by the timers with `compose run` |
| Backup image | restic 0.19.1 + pg client | Our own image: the sha256-pinned restic binary on distroless static. `restic/restic` is `FROM alpine:latest` and is not signed by our release identity. P2 adds the pg client |
| `/status/ops.json` | written by the backup and drill jobs | Also by `rws-tick` (disk %, every 10 min), which also restarts a container Docker reports unhealthy. It lives in the root-owned `/srv/rws/public/ops/` so capture (uid 65532, owner of `public/status`) cannot rewrite it; the URL is unchanged |
| `/status/capture.json` | served from capture's status directory | Served from a copy in the root-owned `/srv/rws/public/ops/`: Caddy follows symlinks, so it never mounts the capture-writable `public/status` (P1b security review S1). `rws-status-copy` (root; `rws-status-copy.path` on every write, `rws-tick` and each deploy's smoke test as backstops) copies under a size limit just past 1 MiB and publishes only a regular file of at most 1 MiB that is a single JSON text of the contract's shape and names no owner-audience term (`deploy/owner-terms.json`). Capture's paths and the URL are unchanged |
| The "previous manifest" to roll back to | – | The last release that passed its smoke test (`/var/lib/rws/current`). A failed release goes into `skip_upto` and is never retried automatically; a failed first deploy leaves the containers running and fails loudly; a manual `rws-deploy` of a release older than the one before it holds automatic updates until the next new one (up to the newer of the release before it and the latest, also when GitHub is unreachable); redeploying the current release holds nothing back |
| Host files | from the verified bundle | `rws-update` takes only `compose.yaml` from each verified bundle. Host scripts, units and the firewall are installed by `bootstrap.sh`, run by the owner from a verified release. There is no self-updating updater: while the running release brings other host files (`deploy/bin`, `host`, `systemd`, the healthchecks, reachability and owner-term lists, the two `[owner]` tests; not the image build inputs), every `rws-update` run pings `update` `/fail` (`host_files_changed`) until the owner has run its bootstrap, except during a rollback hold |
| Release manifest | the image digests | Also the sha256 of `deploy-bundle.tar.gz` (the tar of `deploy/`), as compact JSON, which the first-install runbook reads with grep (`deploy/tests/runbook.test.sh`). The release is created as a draft and published once its assets are uploaded, and only while its commit is still the head of `main`. The VPS reads `releases/latest/download/…`, so it parses no GitHub API data at all |
| `verify-prod.sh` | a shell script | A wrapper around `scripts/verify-prod.ts`, which reuses the contract schemas (`CaptureStatus`, `OpsStatus`) and the registry for the owner-leak grep |
| `rws-reachability` | "one GET each" | One request each; the RWS API accepts only POST, so NL-1 is a POST (still without a key). Targets that are not first-release endpoints (the R7 re-tests, and the keyless later §1a endpoints BE-1, BE-2, DE-10, DE-12 and NL-5) are reported but do not fail the run; every signature is data, never a generic word. DE-9 (its key is in every URL) and the CH-6 fallback (file names not in the catalogue) are not targets (KG-046) |
| Reboot at boot | – | `net.ipv{4,6}.ip_nonlocal_bind = 1`: docker-proxy binds the explicit IPv6 address, which is still tentative (duplicate address detection) when Docker starts, and would otherwise fail, leaving Caddy down after a reboot (host-wide, R-035). `rws-resolvers` runs again once the network is online, and from `rws-tick`: the firewall's own run at sysinit may find no resolver, which left containers without DNS |

---

## 13. Amendment: P2a build (2026-09-30)

What the P2a build (issue #17) changed or settled against the plan, and why. D1–D14 are the decisions of the approved build plan; the rows after D14 are what the build found. `ARCHITECTURE.md` carries a short "(P2a: …)" note at each place it changes.

| Item | Plan | What P2a does |
|---|---|---|
| D1 · `migrate` | The official dbmate image (A§4, A§11.1; BOM row `dbmate (image)`) | The server image has a `migrate` role. It builds the database URL in the process from the file secret `db_rws_migrator`, runs the sha256-pinned **dbmate 2.36.0 release binary** (`/app/bin/dbmate`, `--no-dump-schema --wait migrate`, output scrubbed of the URL and the password), then `ensure_partitions` from 2026-08-01 to three months ahead, then the registry sync, all as `rws_owner` (`ALTER ROLE rws_migrator SET role`). `db/migrations` ships in the cosign-verified image (`.dockerignore` allowlist). Exit 0, 1 or 78. The `dbmate (image)` BOM row is dropped: the deploy bundle holds only `deploy/`, there is no shell on the host and no fourth image |
| D2 · roles and passwords | Roles and `pg_hba` in `db/migrations` | A migration cannot create the login role it runs as. `deploy/postgres/roles.sql` (idempotent, no passwords: the seven roles, read-only sessions and 2 s on the readers, `temp_file_limit` 256MB on the readers (superuser-only, so a session cannot raise it), every role's own role-wide and per-database settings reset before its own are set (a role may change its own), EXECUTE on the large-object write functions, `pg_logical_emit_message` and every advisory-lock function and USAGE on plpgsql (granted to `rws_owner`, so no reader or loader runs a DO block) revoked from PUBLIC in the application database, `CONNECTION LIMIT`s, database owner, UTC, CONNECT and TEMPORARY revoked from PUBLIC) is applied by `db_prepare` in `rws-lib.sh`, with the passwords from the file secrets, over the `db` container's local socket, from stdin, before `migrate`. Grants live in migrations. `pg_hba.conf` and `pg_ident.conf` are in `deploy/postgres` and installed by `bootstrap.sh` to `/etc/rws/postgres` (host files) |
| D3 · `pg_dump` | The backup job joins `db` and carries a pg client (A§11.1) | `pg_dump -Fc --no-large-objects` and `pg_dumpall --globals-only --no-role-passwords` run inside the `db` container as `rws_backup`, nightly (first `rws-backup` run at or after 02:00 UTC, or when the dump is 24 h old, under the deploy lock), into `/srv/rws/backup/db` (`root:61003` 0750, files 0440; its parent `/srv/rws/backup` is `root:root` 0700, so no uid-65532 process can swap `db` for a link), which the backup job mounts read-only; restic backs it up with the raw archive; failure code `dump_failed`. The backup image stays restic-only and off the `db` network (tighter than A§11.1). The restore drill does not restore the dump yet (KG-054) |
| D4 · `own_*` roles | – | Both families keep `series.role = 'primary'` only, so mirrors and twins are in neither; the twin views filter on the audience of **both** series of a pair, not on role |
| D5 · 1-minute series | "1-minute series are downsampled to 15 min" | Declared per series (`native_step`, `expected_step`; 20 basin series). A dense series with `native_step < expected_step` keeps its **on-grid samples only** (a timestamp that is a whole multiple of the expected step, UTC); a grid minute the provider did not publish is a gap, which Q7 counts, never filled with a neighbour. The basin snapshot's current value is stored as published (owner decision). A function of each sample alone, so overlapping windows, in either order, and replays store the same rows (property-tested). In the recorded 1-minute fixture 1 of 24 buckets has no on-grid sample: the leading one, where the window starts at minute 17 |
| D6 · schema | A§6 as drawn | `reference_value` key = (series_id, source_id, kind, season_from_md, season_to_md, priority, valid WITHOUT OVERLAPS): NL-4 rows that differ only in priority or season end, and two sources with the same kind, must coexist. `ingest_batch.archive_key` UNIQUE plus `loaded_at`, and `error` restricted by a CHECK to fixed codes (a replay updates a batch, it never adds one). `load_cursor.byte_offset` (`offset` is reserved). `source_health.status` and `detail jsonb`. A table `twin(id, series_a, series_b)`. `series.native_step`; `series.datum` nullable for Q; the datum list includes `DNG`. `source.history_window NOT NULL DEFAULT '0'`, hours and smaller only (a CHECK; the registry sync writes hours). `ingest_batch.n_skipped`: values a registry change could still load. No FK from `obs*.batch_id`. No `source.kind` and no `provider.homepage` (the registry has neither). `attribution` keyed (source_id, ord). `obs.value` CHECK rejects NaN and infinity. Partitions are made by `ensure_partitions` with `CREATE … LIKE` then `ATTACH` |
| D7 · QC | Range, spike and frozen-with-neighbour checks (A§7.4 step 3) | Sentinels dropped; future (more than 15 min) and older-than-45-days timestamps dropped; the range bit (16) and the provider's flags. Spike (32) and frozen (64) are defined, **not evaluated**: an in-batch spike check flips `qc` at window edges and writes false revisions, and frozen needs the P6 neighbour graph (R-039) |
| D8 · tier 1 | "Tier-1 DE registry from §3.1 and §3.2" | The catalogue §3.1/§3.2 gauges verbatim, minus mirrors: 41 stations, 69 series (29 Q). Health reports `fresh`, `provider_stale` and `total`. A stale series is provider-stale only when a payload fetched within two cadences (30 minutes for DE-1) itself stated its latest value (`obs_latest.batch_id` follows every confirmation); a series we stopped storing (a unit mismatch, a 404, a changed key) is plain stale and counts against the source. **On 2026-09-29 five tier-1 Q series were provider-stale** (Köln, Düsseldorf, Wesel, Rees, Emmerich: low-water rating cut-off): 64 of 69 = 92.8%, below the 95% [agent-prod] criterion by the letter. `verify-prod.sh` prints FAIL with the provider-stale count; the owner judges (R-041) |
| D9 · packages at runtime | – | `packages/core` and `packages/contracts` emit JS: `exports` maps the condition `rws-dist` to `./dist/index.js` and `default` to `./src/index.ts`, `files: [dist]`; the image sets `NODE_OPTIONS=--conditions=rws-dist`. Node does not strip types inside `node_modules`; dev and tests keep running from `src` |
| D10 · registry schema | The P0b station fields | `stations.ts` gains required `tier`, `role`, `provider_key`, `native_unit`, `to_canonical`, `value_kind`, `native_step`, `expected_step`, `staleness_limit`; `Source` gains optional `history_window`, required when `history_export` is off (for a source that is not `off`). `p0b-sample.yaml` moves to `packages/contracts/test/fixtures/`. `series.audience` comes from the station row's audience; `lic_override` has no registry user yet (schema and views are tested with seeded rows) |
| D11 · dependencies | `kysely`, `kysely-codegen`, `fast-check` planned | Installed. `pg` moves from dev to runtime. `@vitest/coverage-v8` 5.0.1 is new (dev only). `csv-parse` and `proj4` stay planned |
| D12 · healthchecks | 15 checks | A 16th, `load`, pinged by the watchdog from `/api/v1/health` (`load_unreachable`, `load_contract`, `load_down`, `load_stale`, `load_quarantined`, `load_lag`, and `load_backlog`: a manifest line left unconsumed for 15 minutes, which is a stalled loader; a provider that is down is capture's freshness, not the loader's). The loader has no egress. An HTTP 404 means the release with the api is not deployed: no ping |
| D13 · secrets | A7: root 0600 | The P1b convention: `root:<gid> 0440` in the root-only directory. Six database passwords, generated by `bootstrap.sh` (64 hex characters, gids 61004–61009, never overwritten) |
| D14 · agent sandbox | Trust for role `rws` on database `rws` only | Role `rws` is a superuser of the throw-away cluster and other roles log in over loopback with scram-sha-256, so the role tests run with real logins (T-DB-1, R-018) |
| Q1 | A§8 Q1 through `pub_series` and `pub_obs` | A `LIMIT` cannot be pushed into a `security_barrier` view, so the same lookup reads and sorts each series' whole staleness window (measured 90–280 ms). One `SECURITY DEFINER` function per family, `pub_obs_at` and `own_obs_at`, takes one backward step on the `(series_id, ts)` index per series: median 27.8 ms and p95 44.5 ms on 3,000 series × 60 days (17.28 M rows, local PostgreSQL 18.6). CI job `bench` asserts the index scan and the 50 ms limit. Both functions run with `SET TimeZone = 'UTC'`, so a caller's session zone never reaches them (600 series × 20 days: median 4.3 ms before, 4.2–4.8 ms after) |
| Loader-state view | Health from `pub_source_health`, `pub_twin_check`, `pub_ingest_batch`, `pub_owner_health` | Also `pub_loader`: the loader's computed-at time, backlog, the age of the oldest unconsumed manifest line (`backlog_age_s`) and bad manifest lines, numbers about the loader with no source in them. `lag_p95` is null for a source with no line loaded in the last hour (never the last known value). `own_private_basis` is the owner family's only extra view |
| Registry sync | Part of the load scope | Runs in `migrate`, as `rws_owner`, from the registry files of the signed image. `rws_load` has SELECT only on the registry tables and cannot change an audience or a channel (T-LOAD-4). A series is registered only by a station row; one that leaves becomes inactive; `registry/permissions` records are refused until P13 |
| Newest fetch wins | `ON CONFLICT … WHERE IS DISTINCT FROM` | The stored row of a point is the value stated by the payload with the greatest (`fetched_at`, batch id) among all that stated it, whatever order they arrive in, except that an exact `fetched_at` tie goes to the greater batch id, which follows the order of the first load (KG-066): a point is written only when the batch that holds it is older, or is this very batch and its value or qc now differs (a replay after a parser, normaliser or registry fix corrects what its own batch stored; KG-074 for a unit change). Gauge zeros follow the same rule for the same `validFrom` (a newer `validFrom` supersedes). A newer fetch that states the same value and qc is a **confirmation**: the row's `batch_id` (and `obs_latest.batch_id` for the latest row) moves to it, with no revision, no rollup and no count, so a late payload fetched in between cannot overwrite it. A replay with an unchanged parser writes nothing. A changed value or qc writes exactly one `obs_revision` row; the revision log records the changes in the order they were stored, so it is the one thing that depends on arrival order (the rows, rollups and checksums do not). Every re-statement of an unchanged point rewrites its `batch_id` (about six row updates per insert for DE-1's hourly `PT6H` window; `ponytail:` in `store.ts`) |
| Lines the loader does not parse | Not specified | `dup_of`, 304 and a closed gate: fetch ok, no rows, no batch row. Failed validity or an unattributable `recovered` series payload: batch `skipped`. A fetch error: a failure count. No adapter: cursor and fetch health only. A missing object: batch `skipped`, and in the tail an `object_missing` alert. `SchemaDrift` (including a document over its node or depth cap), an oversized or corrupt object or a sha256 mismatch: batch `quarantined` with a fixed code and an alert. A failure of the payload's own (a database error of class 21, 22, 23 or P0, an object that cannot be read): the payload is tried twice and quarantined on the third pass (`load_error`, `archive_unreadable`). The attempt is recorded in `app_meta` before the payload is touched, keyed by the line's place in the manifest and cleared in the commit that ends its pass, so a payload that kills the process (out of memory, a crash) is quarantined as `load_crashed` on the pass after its second attempt, without being read. A failure that is not the payload's (a connection, a lock timeout, any class 42 or 0A error: with bound parameters that is our SQL or schema) stalls the tail and never counts: alert `load_stalled` when it starts and every 15 minutes, and the age of the oldest unconsumed line in health. A damaged manifest line is counted and alerted once. A tick reads for at most 20 s, then health and the nightly jobs get their turn; the nightly jobs wait while a whole manifest line is unconsumed (a torn last line is not a backlog) |
| `rws_backup` | A login role with scram (A§12.2) | No password exists: `pg_hba` maps the container's `postgres` OS user to it on the local socket. Read-only, `pg_read_all_data` granted `WITH INHERIT TRUE` (the role is NOINHERIT like the others) |
| First-deploy order | "Deploy: `db`, `migrate`, `load` and `api`" | The installed P1b `rws-update` would deploy P2a without the database secrets, fail and roll back. The owner stops `rws-update.timer` before approving `production`, verifies and unpacks the release, runs the new `bootstrap.sh`, runs `rws-deploy <tag>`, then `rws-hc-sync` (16 checks) and starts the timer (`docs/runbooks/bootstrap.md`). The deploy runs pull → `up --wait db` → `db_prepare` → `run migrate` → `up -d` → smoke (plus `/api/v1/health` when the release has an `api`); codes `db_start_failed`, `db_prepare_failed`, `migrate_failed`; no automatic `dbmate down`; a rollback to a P1b release removes `db`, `load` and `api` and keeps the `pgdata` volume |
| History window | "Rows older than the window need `lic_history_export`" | Fail closed: a source with no history export and an unknown window (`history_window` `0`) shows no observation in `obs` or its rollups (nothing older than now). The window holds hours only (a CHECK; the sync writes `P30D` as 720 hours, and a month fails it), because `now() - interval '30 days'` depends on the session's time zone and a reader session chooses its own |
| Retention pruner | "Retention deletion constrained to the `raw/` root" | Also: only objects the loader parsed `ok` and stored whole (`n_skipped` 0: no series the registry does not know, no unit mismatch, no unknown gauge-zero unit, so a registry change and a replay can still load them); never an object whose own line or a `dup_of` line is inside 90 days; never CH-1 or CH-2 payloads before P7 or the first object per spec and UTC day of a mixed source. Bounded memory: candidates come from the manifest files older than the window, one file at a time, looked up per file; the newer files are only scanned for lines that name an old object. The nightly jobs mark their UTC day in `app_meta`, so a restart does not run them again. Dry run unless `RWS_PRUNE_APPLY=1`, which is not set in `compose.yaml` |
| DE-1 registry | 211 stations, 35 without coordinates (catalogue) | `registry/stations/de-1.yaml` is generated by `scripts/gen-de1-stations.ts` from the recorded fixtures: 199 stations (238 series: 198 H, 40 Q), 29 without coordinates. The catalogue's count included the Dutch-side waters, which the basin call does not request. 5 mirror stations (6 series: Lobith, Pannerdense Kop, Basel-Rheinhalle, Konstanz-Rhein, Hattingen); 9 `m+NN` series; 20 one-minute series; 8 `cm` series without a gauge zero (datum `LOCAL`). NEUWIED STADT (27100370, a third-party agency whose licence is unverified) is audience `off`, `licence_gate: withheld`: the loader stores nothing for it until the owner verifies the licence and switches it on in a reviewed registry change |
| `check-boundaries` | View names only in `audience.ts` | Scans more: every TypeScript file under `apps/`, `packages/`, `scripts/` and `test/` (fixture directories too; only the checker's own test trees in `scripts/fixtures/boundaries` are skipped), and `.sql` under `apps/` and `packages/` (`db/migrations` is where the views are created). The match ignores case (SQL folds unquoted names). A test or view title that contains a view name fails it |
| Registry drift report | Compare the registry with a harvested `stations.json` | Once a UTC day, from the live loader on a `de-1-basin` payload: stored in `app_meta` (`registry_drift:DE-1`), alert `registry_drift` when a series vanished or changed unit or step. It only reports |
| Bounded parsing | Strict Zod schemas with array caps | Zod records one issue per element before an array cap applies, so a wrong-shaped body inside the byte caps ran the loader out of memory (review S1: 2.1 GB for 8 MiB of `[0,…]`). Every document is bounded before JSON.parse by a scan of its text (`packages/core` `boundedJson`): at most 30,000 values and depth 8 for the basin call (the fixture: 5,776, depth 5), 200,000 and 10 for the metadata call (41,043, depth 7), 200,000 and 3 for a series window (8,920; 60,000 points are 180,001). Every array is length-checked before its elements are parsed, and a document's top-level elements are parsed one at a time, so a bad document stops at its first bad element. The worst body at each cap ends in `SchemaDrift` under a 256 MiB heap (tested in child processes; the worst, one station of 12,000 wrong-shaped characteristic values, fails at a 96 MiB heap and passes at 128 MiB) |
| Unit switch | – | `measurements.json` carries no unit. The loader keeps, per source, the series whose unit the newest basin payload showed changed (`app_meta` `unit_mismatch:DE-1`, written in that payload's transaction; an older payload never replaces a newer list) and drops those series' measurements payloads as `unit_mismatch` (`n_skipped`, so they are kept and replayed after the registry fix) |
| Role exit codes | P1: `load`, `publish` and `replay` exit 2 until their phase | Only `publish` exits 2 now; `load`, `replay` and `migrate` are implemented (`healthcheck` is unchanged: exit 0 while the heartbeat is fresh) |

---

## 14. Amendment: P2b build (2026-09-30)

What the P2b build (issue #17, PR "P2b: NL-1/NL-2/NL-4") found or settled against the plan and the issue, and why. No audience or channel flag changed (NL-1, NL-2 and NL-4 stay `public`), and the PR adds no migration, no grant, no dependency and no GitHub Action. `ARCHITECTURE.md` carries a short "(P2b: …)" note at each place it changes.

| Item | Plan | What P2b does |
|---|---|---|
| Eijsden TAW capture | "The Eijsden-grens TAW series, which is kept as a twin" (P2 scope), but the P1 specs ask RWS for `Hoedanigheid` NAP only, so nothing recorded TAW | A new spec `nl-1-obs-twin` in `registry/capture.yaml`: cron `1-59/10 * * * *` (the same minute as `nl-1-obs-key`), `variants: {seed: nl-1, where: {tier: twin}}`, `params: {proces: meting, hoedanigheid: TAW}`, window `PT3H` (maximum `P31D`, overlap `PT1H`), retention `obs`; one new seed row `eijsden.grens,H,twin,taw`. `adapters/nl-1/capture.ts` sends TAW when `params.hoedanigheid` is `TAW` and NAP otherwise, as before. The busiest 60 minutes on `ddapi20-waterwebservices.rijkswaterstaat.nl` go from 367 (the figure in §11) to **373 requests**, under the limit of 400 |
| NL-1 series key | "WATHTE/NAP/meting with method F007, and Q with per-station method codes" | `provider_key` is `<Locatie.Code>/<Grootheid>/<Hoedanigheid>/<WaardeBepalingsMethode.Code>`, verbatim (for example `eijsden.grens/WATHTE/TAW/other:F007`). The registry row is the single declaration of the method per series. A payload names its own series, so no manifest variant is needed (`needsVariant: false`) and a `recovered` line loads too. Why: a provider that changes a method code cannot make us store a different series under the old key |
| The method comes from the WFS, not the catalogue | Method codes from the catalogue (§2.1) | The catalogue lists two to seven candidate methods for most locations. `scripts/gen-nl1-stations.ts` takes the one method that is live in the recorded NL-2 WFS snapshot for each series and fails when there is none or more than one. The Q methods are F230 (Lobith, Millingen, Pannerden), F006 (Tiel, Olst, `westervoort.1`, Borgharen), F103 (Venlo, Megen, Sint Pieter, Ommen, Hagestein) and F216 (Eijsden), as the catalogue expects |
| F155 | H is method F007 | H is F007 except **F155 at `holtheme.vecht` and `ommen.vecht`**, the two Vecht gauges whose live WFS feature carries that method |
| Stale list and Driel Q | "A stale-series filter (Arnhem, Driel Q, Westervoort IJsselkop Q, §2.1)" | `STALE_SERIES` (exported from `adapters/nl-1/normalise.ts`, key prefixes): `arnhem.nederrijn/WATHTE/NAP`, `arnhem.nederrijn/Q/NVT`, `driel.boven/Q/NVT` and `westervoort.ijsselkop/Q/NVT/other:F230`. Their values are dropped as `stale_series`. `driel.boven` Q is live in the WFS snapshot (10.19 m³/s) while REST serves only code-99 gaps for it: REST wins, and NL-2 lists the key as unregistered (an info line, no alert) |
| Quality codes | "Quality code 99 is a gap" | 99 is a gap whatever the value. The codes 00, 10, 20, 25, 30 and 40 are kept with no extra QC bit (25 gets no meaning of our own: catalogue C7). **Any other code is withheld** as `unknown_quality` and alerted. `Ongecontroleerd` sets the `raw` bit; `Gecontroleerd` and `Definitief` set the `validated` bit |
| Two values for one instant | Not specified | Split lists of one series are merged and sorted by time. Same instant and same value: one row, the validated one (counted as `duplicate`). Same instant and different values: the instant is **withheld** as `conflict` and alerted; nothing is chosen between them |
| Withheld values | Only `unit_mismatch` and `unknown_zero_unit` kept the object for a replay (§13, retention pruner) | `RETAINED` in `load/pipeline.ts` also holds `unregistered_method` (a registered series arrived under another method code), `unknown_quality`, `conflict` and `registered_dropped` (a list under a registered key with another ProcesType, compartment or grouping; review F3: before it, such a list was only counted as `process`, `compartment` or `grouping`, which stay the codes of unregistered keys). These dropped values count in the batch's `n_skipped` (the pruner keeps the object; a replay after a registry or parser fix loads them) and each raises an alert under its own code with `source`, `spec` and `n` |
| NL-1 registry | "Tier-1 NL registry from §3.1 and §3.3", and a registry that holds one series per quantity | `scripts/gen-nl1-stations.ts` generates `registry/stations/nl-1.yaml` byte for byte: 76 rows at 65 stations (62 H primary, one H twin, 13 Q). Tier 1 is the 31 stations of the P2b brief (42 rows: 28 H, the twin, 13 Q); the 41 primary tier-1 rows are `first_release`. Tier 2 is 34 stations with 34 H rows. 12 of the 88 seed rows are not registered: the 9 Belgian rows (P5), `driel.boven` Q and `arnhem.nederrijn` Q (stale list) and `hedel` H (no WFS feature, so not live). `epen.geul.cottessen` Q is live at RWS but not captured, so it is not a row. `packages/contracts` gains `Twin`, `TwinsFile` and `validateTwins`: a station may carry a second row of the same quantity only when that row has `role: twin` |
| Staleness against "< 60 min" | "≥ 95% of tier-1 series have an `obs_latest` age < 45 min (DE-1) or < 60 min (NL-1)" | Each series carries its own `staleness_limit`: `PT1H` for the 25 key gauges (fetched every 10 minutes) and the twin, `PT90M` for the 49 series fetched every 30 minutes (every Q and the other H gauges) and `PT2H` for `eijsden.grens` Q, which RWS publishes about 75 minutes late. Of the 42 tier-1 rows, 23 have `PT1H`, 18 `PT90M` and 1 `PT2H`. `verify-prod.sh` judges each series against its own limit. `PT90M` is three of the 30-minute fetch intervals; a 60-minute limit would leave room for no missed fetch at all in that tier. Accepted deviation (R-054, KG-081) |
| NL-4 coverage | "Coverage of the curated list is reported as 49/54 H and 14/18 Q" (the count of an older list) | Against the series P1 captures (tiers key and other): **61 of 69 H and 15 of 18 Q**. Without classes: H `millingenaanderijn.pannerdensekop`, `holtheme.vecht`, `herenlaak`, `lixhebiefaval`, `antwerpen`, `lith.beneden`, `rhenen.grebbeberg`, `hedel`; Q `millingenaanderijn`, `hagestein.boven`, `kanne`. Of the nine series that the P2 scope names without classes, `maastricht.sintpieter.zuid` and `roermond.hambeek` are not captured |
| NL-4 rows in `reference_value` | "The rows load into `reference_value` with semantics `provider_class`" | The registry sync in `migrate` (as the object owner, from the registry files of the signed image) deletes the NL-4 rows and inserts them again on every run: for every registered primary NL-1 series whose station code and quantity match (H only on NAP series), `source_id` NL-4, `semantics` `provider_class`, the season (`season_from_md`, `season_to_md`), `priority`, `basis_label` = the workbook label verbatim, unit `cm` or `m³/s`, `valid` = [2026-04-15T00:00Z, ∞), and one row of kind **`NL4_FROM`** (value = From) and one of kind **`NL4_TO`** (value = To) where that bound is not `NULL`. Result: 702 rows on 69 series (58 H, 11 Q). The `alle*` rows match no station. NL-4 has no loader entry: its weekly archive payloads stay unparsed |
| NL-4 bound direction | Bounds from `From`/`To`, never from the label text | Unchanged, but the labels read "> 4450" (an exclusive lower bound) while the specification reads a class as [from, to). How Waterinfo treats a value exactly on a bound is unknown. `classOf` uses [from, to). The file also holds 46 bands with From ≥ To and 18 with both bounds `NULL`, kept as the file states them. P7 maps classes to states and must settle both (KG-083); whether the classes match WMCN phases is still unverified (C7) |
| XLSX limits | P1a (§11): an OOXML name profile and a member cap of 20 for XLSX | `readXlsx` in `http/guards.ts`: at most 20 members, 200 MB unzipped, ratio 50:1, streamed with CRC; XML text of at most **8 MB per member and 16 MB in total** (the NL-4 sheet is 3.8 MB; the generic rule says 1 MB); strict UTF-8; any DOCTYPE or ENTITY is refused. The converter adds an **exact member allowlist** (the 14 members of the workbook) and a pinned sha256. Review rounds 1 and 2: every XML text (CAP too) is refused before the validator runs when one tag or processing instruction is longer than 16 KiB, it holds more than 1.5 million tags plus attributes, or elements nest deeper than 256 (the workbook's longest tag has 643 characters, its sheet 669,675 tags plus attributes and a depth of 5), a ZIP entry marked as a Unix symbolic link is refused, and the NL-4 parser and the class CSV refuse control characters, format characters (Unicode Cf) and bidirectional controls |
| NL-2 count check and drift report | "Discovery and coordinates only; `local-labelled-Z`; REST wins" | NL-2 writes no observation row, ever. `parseCollection` requires `numberReturned`, `numberMatched` and `totalFeatures` to equal the number of features (`invalid_value at numberReturned` otherwise): a paged or capped answer would report every series it left out as vanished. The loader's daily drift report runs against the **NL-1 registry** (`SpecLoader.driftSource: 'NL-1'`): `unregistered`, `vanished` (a registered NAP or NVT key with no value for 12 hours, the capture's CQL filter) and `changed` (`position`, more than 1e-4°), stored in `app_meta` `registry_drift:NL-2`; only `vanished` and `changed` raise the alert `registry_drift`. On the recorded snapshot it lists two unregistered series (`driel.boven/Q/NVT/other:F103` and `epen.geul.cottessen/Q/NVT/other:F007`), nothing vanished, nothing changed |
| DST gate (A§7.4 step 2) | Synthetic fall-back and spring-forward fixtures before an offset-less local-time adapter runs in `load` | The gate is a test: `apps/server/test/adapters/nl-2.test.ts` fails when NL-2 is in `LOAD_ADAPTERS` while a fall-back fixture (two: the first and the second pass of 2026-10-25) or the spring-forward fixture (2027-03-28) is missing. NL-2 is in `LOAD_ADAPTERS` (it stores nothing) |
| Eijsden twin check | "Eijsden twin: TAW − NAP", "twin status in health" | `checkTwins` (`load/twins.ts`) runs in the loader's 60-second health pass, not as a job of its own. For the current UTC hour it checks the 24 hours before it, on timestamps both series have, **leaving out the newest 30 minutes** (values that are still being revised), and writes one `twin_check` row per pair and hour (an idempotent upsert). A pair with nothing aligned in the window gets **a failing row with `n_aligned` 0** (both deltas NULL) when it was checked before, so a side that stops (RWS no longer serves TAW, or its capture stops) shows as a failing twin; a pair never checked gets no row, so data that has not arrived yet is no breach (review F2; before it, nothing aligned wrote no row). `ok` means that every delta (TAW − NAP) differs from the expected offset by no more than the tolerance. `registry/twins.yaml` holds the pair (`eijsden-grens-taw-nap`, offset 233 cm ± 1) and the sync in `migrate` writes the `twin` table. The loader logs `twin_breach` when a pair turns failing and again at each new hour while it fails; `/api/v1/health/sources` twins gain `checks_7d` and `failed_7d`; the watchdog's `load` check adds `load_twin` |
| Q7 over the outage window | "Q7 (in health) reports 0 missing buckets for tier-1 DE-1 and NL-1 series over the window" (the window is not defined) | `findOutages` (`load/health.ts`, stateless, every 10 minutes) takes per source the last gap of at most 168 hours between two payloads loaded `ok` (by `fetched_at`) that is longer than the larger of 3 × the source's shortest capture cadence and 30 minutes. `computeHealth` counts the buckets still without data in that window for tier-1 primary series that had data in the 24 hours before, and stores `detail.outage`; `/api/v1/health/sources` shows `outage: {from, to, missing_buckets} \| null`. `deploy/bin/rws-drill stop-capture <Nm\|Nh>` (new; `docs/runbooks/outage-drill.md`) makes the outage on purpose. The criterion's 2-hour drill shows that the recorder and the loader recover and leave no gap, but not that the recorder stretches its window: the default windows (3 hours for `nl-1-obs-key`, 6 hours for `nl-1-obs-other` and `de-1-series`) already cover a 2-hour gap. `rws-drill stop-capture 4h` exercises the stretch of the 3-hour specs, `6h` (the script's maximum) that of all four, the 6-hour specs by minutes only (the runbook, §1; KG-091) |
| `provider_stale` | §13 (D8): a payload fetched within two cadences of the source (30 minutes for DE-1) stated the latest value | Judged by the cadence of the spec that stated the value (`specCadenceS`; RWS series are fetched every 10 or 30 minutes), falling back to the source's shortest cadence. It applies to DE-1 too: a value last stated by `de-1-series` (hourly in `registry/capture.yaml`) is provider-stale when that payload was fetched within two hours, where §13 allowed 30 minutes (two cadences of `de-1-basin`) |
| "Base URLs in config" (D6, 2026-11-05/06) | The RWS CTD switch changes URLs in config | The URLs are literal in `registry/capture.yaml` (with the `hosts` allowlist). The contract check reads its targets from there |
| The production replay | "Deploy: `db`, `migrate`, `load` and `api`, then replay everything since P1" | The P2a loader had no NL-1 adapter and moved its cursor past every NL-1 line. After the P2b release the owner runs `replay --source NL-1 --from <first P1 day> --to <today>` explicitly (`docs/runbooks/replay.md`). NL-2 needs no replay (it stores nothing) and NL-4 is never replayed |
| `contract-check.yml` | "Live fetch and parse for DE-1, NL-1 and NL-2; it opens or updates a `contract-drift` issue on failure" | As planned, at 03:23 UTC and by hand: `scripts/contract-check.ts` sends at most three requests (`de-1-basin`, `nl-1-obs-key`, `nl-2-wfs`) from the targets of `registry/capture.yaml`, through the loader's validity and parse path. The contact identity comes from the **Actions variables** `RWS_DOMAIN` and `RWS_CONTACT_EMAIL` (not secrets); no RWS key is sent. The report is one fixed code per spec; the `report` job re-validates every line and comments on the one open `contract-drift` issue or opens it, never a second |
| Fixtures | "≥ 3 real fixtures from the P1 archive" | None comes from the production archive (an agent has no production access). Recorded live on 2026-09-30T15:49:46Z with `smoke-capture.ts --row` (5 RWS requests): Eijsden TAW (`nl-1-obs-twin`) and NAP, Driel Q, Lobith Q and Arnhem Q (an HTTP 204). Recorded on 2026-09-29 in P1a: `nl-1-obs-key` (Lobith H), `nl-1-catalogue`, `nl-2-wfs`, `nl-4-xlsx`. Synthetic and marked so: `nl-1-obs-split`, the NL-2 DST and empty collections and `nl-4-overlap` (KG-076, KG-077); the zip-bomb, unexpected-member and DOCTYPE workbooks are built inside the tests |
| Reviewers | Security review by `sonnet` at xhigh (§3.4) | Two Opus reviewers, one for code and one for security, on the owner's instruction for this PR |
| Found on the way | – | `extractDataToJson` (the LU-4 HTML reader in `guards.ts`, P1) threw a `RangeError` on a character reference beyond U+10FFFF instead of leaving it as text: fixed in one line, with a test |

---

## 15. Amendment: P3 build (2026-10-01)

What the P3 build (issue #18, PR #45) found or settled against the plan and the issue, and why. The owner decided the flavour, the committed assets and the packaging of the job on 2026-10-01, when the plan was approved. No audience or channel flag changed, and the PR adds no migration, no grant and no healthchecks check. `ARCHITECTURE.md` carries a short "(P3: …)" note at each place it changes.

| Item | Plan | What P3 does |
|---|---|---|
| Hosts of the job | "egress to `build.protomaps.com` only" (P3 scope, A§11.1) | Two hosts. `build-metadata.protomaps.dev` serves `builds.json` (a JSON array, one entry per daily build, with its file name and tiles version; old entries are versions 0.x and 3.x) and `build.protomaps.com` serves the files (`Range` answers 206). Both are in `registry/basemap.yaml` (`protomaps.hosts`). The application holds the build list and a one-byte `Range` probe to them through the SSRF-guarded client, with no redirect at all; at the firewall the job's `egress` network is TCP 443 to any address plus DNS, like `capture` (R-060) |
| Resume and checksum | "The job resumes and is checksum-verified" | go-pmtiles 1.31.2 `extract` has no resume and writes its output directly, so `fetch` empties `.staging` first and every run starts clean (an interrupted fetch costs the whole download again; a limit of 4 hours per extract). Protomaps publishes checksums only for the full planet file, so the sha256 of each extract is computed after it is written, fsynced and recorded in `result.json`, and `promote` re-checks it before the file is served |
| Packaging of the job | A§11.1: "small job image with go-pmtiles 1.31.2 (built in CI, digest-pinned, signed)" | A role of the server image, the P2a precedent of `migrate` with dbmate: go-pmtiles is `/app/bin/pmtiles` (`ADD --checksum` of the release tarball in `deploy/server/Dockerfile`). No fourth image; the release manifest, `rws-update` and `release.yml` are unchanged. Two Compose jobs (profile `jobs`, `restart: "no"`, uid 65532, 512 MB, 1 cpu, 64 pids, no secret, healthcheck disabled): `basemap` (`basemap fetch`; network `egress`; `/srv/rws/tiles` read-only and `/srv/rws/tiles/.staging` read-write; `TMPDIR` in `.staging`, `GOMEMLIMIT` 400 MiB; `ulimits: fsize` 6.5 GB, so no file of the job grows past it, review round 1) and `basemap-promote` (`basemap promote` and `rollback`; `network_mode: none`; `/srv/rws/tiles` read-write). Why two: Caddy follows symlinks and holds the TLS keys, so the job that reads third-party bytes never writes the directory Caddy serves (T-WEB-1, T-MAP-1). `/srv/rws/tiles` is now owned by uid 65532 (root's before P3) and Caddy mounts it read-only; `bootstrap.sh` creates it and `.staging` |
| What `promote` checks | "verifies the result and writes its sha256; swaps `tiles/manifest.json` atomically and **keeps the previous version**" | No network. Every file is opened with `O_NOFOLLOW` and must be regular with one link and within its size limit (6 GB basin, 100 MB world); its hash must equal `result.json`'s; `pmtiles verify` must pass; `pmtiles show --header-json` must say vector tiles compressed with gzip or not at all (what pmtiles.js reads), the registry's zoom range, basin bounds inside the bbox ± 0.01° and a world extract spanning the world; both files are checked before either moves. After each rename the served name must still be a regular file with one link and the checked device and inode, else `file_swapped`; any failure between the first rename and the manifest removes every name the run moved in (`file_remove_failed` when one cannot be removed), so no orphan is left (review rounds 1 and 2). A served name is immutable: a name that holds other bytes is refused (`exists_different`). The manifest is written by temporary file, fsync and rename (current = the new build, previous = what was current), and retention deletes only tile names that no entry names. `result.json` is removed last, so a cut-off promote is finished by running it again. `rollback` re-checks the previous files and swaps current and previous in one manifest write; a second rollback undoes the first. Failure codes are fixed; `docs/runbooks/basemap.md` lists them |
| Which build, and `--build` | "picks the newest build from `builds.json`" | Eligible: a file name `<8 digits>.pmtiles`, a real date up to tomorrow (UTC), tiles version 4.x (`tiles_major`); a date listed twice with two versions is dropped. Without `--build` the job only moves forward: it does nothing when the newest build is the current one (`already current`), older than it (`not_newer`) or the one that was rolled back from (`rolled_back_build`), so a scheduled run never re-fetches a rolled-back build. `--build` of the manifest's previous build is refused before anything is downloaded (`build_is_previous`: a fresh extract could differ byte for byte from the files still on disk; `--rollback` makes it current again). `--build YYYYMMDD` takes a listed eligible build: the owner's first run needs it, because "previous" exists only after a second build is promoted and Protomaps keeps its builds about a week |
| Style flavour | "muted light flavour" | `white`: `@protomaps/basemaps` 5.7.2 has no "muted" flavour (owner decision, ADR-0016). Labels from `name:nl` and `name:en`. One style per language, 132 layers each (64 from the `planet` source, 68 from `basemap`): the planet extract (z0–6, overzoomed) is an underlay at every zoom with its labels to z7, the basin extract is drawn from z7; five planet label layers whose own range starts at z7 or later are dropped |
| Style build | "Style build (in `geo.yml`)" | `tools/geo/basemap/build-style.ts` generates the two styles offline and deterministically into `apps/web/src/features/map/styles/`; they are committed. `geo.yml` (a pull request that touches the geo paths, and by hand; not a required check) runs `build-style.ts --check`, `test/basemap-style.test.ts` and `fetch-assets.ts --verify`. The test is in `pnpm check`: it regenerates the styles, validates them against `@maplibre/maplibre-gl-style-spec` 26.4.4 (the version maplibre-gl 6.11.1 resolves), refuses any third-party URL, checks every source layer against the fixture's `vector_layers`, and every asset against `SHA256SUMS` and the registry pin |
| Glyphs and sprites | "self-hosted glyphs and sprites under `/assets/map/`" | Committed in full, by owner decision: `protomaps/basemaps-assets` at commit `028c18f` (about 17.8 MB, 1,031 files: four font stacks of 256 ranges, `OFL.txt`, `sprites/v4/white*`, `LICENSES.md`, `SHA256SUMS`) under `apps/web/public/assets/map/028c18f/`. Vite's public directory puts them in the web image, and Caddy serves them as immutable `/assets/map/028c18f/…`. The Devanagari stack is mostly copies of the regular one (252 of 256 upstream files are symlinks, written as regular files). Fonts SIL OFL 1.1, sprites MIT |
| Map module and spike | "A dev-only `/_spike` route" | `apps/web/src/features/map/`: `useMapLibre`; `createMap.ts` is the lazy chunk (maplibre-gl, its CSS, pmtiles with `metadata: false`, the worker through `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and `setWorkerUrl`); `lib/time/temporal.ts` loads `temporal-polyfill/global` only where `Temporal` is missing. The spike pages `/_spike/` and `/en/_spike/` (200 fixture stations as `circle` with `feature-state`) exist only in `vite build --mode e2e` (`dist-e2e`, with a `window.__spike` hook); production pages load none of the map chunks (`apps/web/test/map-build.test.ts`). The e2e build's chunks: the map 1,038 kB (283 kB gzip), the worker 510 kB, the polyfill 59 kB (20 kB gzip), each style 104 kB (6.5 kB gzip) |
| CSP | Security review focus: whether the CSP is minimal (`worker-src`, `img-src blob:`) | `blob:` is gone from `img-src` and `worker-src`: the final string is in A§12.2, `deploy/web/site.caddy` and `test/verify-prod.test.ts`. `img-src 'self' data:` stays, for the SVG icons in MapLibre's CSS. The worker is a same-origin module file, never a blob. ADR-0016 has the three variants that were tried in Chromium, Firefox and WebKit |
| Caddy routes | "`/tiles/*` with range requests and immutable caching; `/assets/map/*`" | GET and HEAD only. `/tiles/manifest.json` is `public, max-age=60`; `/tiles/(basemap\|planet-z6)-<8 digits>.pmtiles` is `public, max-age=31536000, immutable` and answers `Range` with 206; exact, case-sensitive path match, from `/srv/rws/tiles` only. Both routes and `/assets/*` answer only for a file that exists (a `file` matcher), because Caddy keeps headers set before `file_server` on its own 404s, so a missing tile would otherwise be a 404 marked immutable; every other `/tiles` path is a 404 without `Cache-Control`; `encode` skips `/tiles/*`. A tile file is served only for one explicit range (`bytes=<first>-<last>`, what pmtiles.js sends) without `If-Range`, `If-Match` or `If-Unmodified-Since`; no `Range`, an open range, several ranges and a range with one of those headers are a 416 (review rounds 1 and 2, SR-1, SR2-1). A path with a dot segment is a 404 (`path_regexp`, ahead of `/assets`). A whole file is still one request away (R-061) |
| Fixtures | "a committed tile fixture of ≤ 5 MB (a small bbox around Lobith)" | Two, 3.67 MB together, in `tools/geo/fixtures/`: `lobith-z14.pmtiles` (2,803,030 bytes, z0–14, bbox 6.04,51.82,6.16,51.88) and `planet-z2.pmtiles` (864,227 bytes, the world to z2), both cut from the Protomaps build 20261001 (tiles 4.15.2), with `lobith-z14.metadata.json` and a README that gives their sha256 and the ODbL credit. KG-102 |
| Playwright and axe | A§3: Playwright in P4, axe in P10 | Installed in P3 (`@playwright/test` 1.63.0, `@axe-core/playwright` 4.13.0; their BOM rows are now `installed`), because the acceptance criteria of P3 need them. The CI job `e2e` (in the `ci` aggregate) serves `pnpm -F web build:e2e` through the stock `caddy:2.11.4-alpine` (the web image's base) with `deploy/web/site.caddy` on `https://localhost`, and runs Chromium, Firefox and WebKit in the digest-pinned `mcr.microsoft.com/playwright:v1.63.0-noble` image (a BOM row; `test/e2e-pins.test.ts`). The specs: WebGL2 first; the production headers byte for byte; the lazy map chunk; the worker under `/assets`; a pixel check at z12 (the basemap alone is not blank, the station colours are present, the fallback magenta is absent); `feature-state`; the attribution text and its single link; a request log (manifest, both tile files, a glyph, the sprite); a z4–z14 sweep; unmount and remount; `Temporal`; axe on both spike pages (Chromium only). WebKit 26.6 ships `Temporal`, so that test deletes it before the page scripts run to prove the polyfill path (KG-103). Every test fails on any `securitypolicyviolation`, CSP console message, CSP-blocked request or off-origin request |
| Dependencies | A§3 plans maplibre-gl, pmtiles, `@protomaps/basemaps`, go-pmtiles and `temporal-polyfill` | All are now `installed` BOM rows. New rows: `@maplibre/maplibre-gl-style-spec` 26.4.4 (dev only) and the Playwright image. maplibre-gl, pmtiles and `temporal-polyfill` are runtime dependencies of the web bundle, each with an ADR-lite line in the PR |
| Host script and timer | "A quarterly timer is installed but disabled until the owner enables it" | As planned, in detail: `deploy/bin/rws-basemap-refresh [--dry-run \| --rollback \| --build YYYYMMDD]` first promotes what an interrupted run left staged (a no-op when nothing is), then runs `fetch` and `promote`, under its own lock (never the deploy lock); `rws-basemap-refresh.timer` (`OnCalendar=*-01,04,07,10-15 05:10:00`, the 15th of January, April, July and October, clear of the 03:40 UTC unattended-upgrades reboot, `Persistent=true`, `RandomizedDelaySec=1h`) and the service (`TimeoutStartSec=4h`) are installed by `bootstrap.sh`, which does not enable the timer. They are host files: the release that brings them pings `update` `/fail` `host_files_changed` until the owner runs its bootstrap. `deploy/reachability.yaml` gains an optional target `protomaps-builds` |
| Alerting | – (the plan names no alert for the job; A§11.3 lists the checks) | The job sends no ping: the 16 checks are a closed set. A failed run is a failed unit and its journal lines; the map keeps working from the last good extract (R-062, KG-100) |
| `verify-prod.sh` | "`/tiles/basemap-<date>.pmtiles` answers `Range` requests with 206 and `Cache-Control: public, max-age=31536000, immutable`. `tiles/manifest.json` lists the current and previous versions" | New checks: `tiles manifest`; `tiles <file>` for every listed file (a `Range: bytes=0-15` request: 206, `Content-Range` total equal to the manifest's byte count, the exact immutable header, no `Content-Encoding`, the PMTiles magic); `tiles previous` (n/a while the manifest has no previous extract); `tiles 404` (`/tiles/`, `/tiles/.staging/` and a dated name that nothing promoted); `tiles 416` (the current basemap file without `Range` and with two ranges; review round 1); `map assets` (a pinned glyph file, immutable). Before the first extract `tiles manifest`, `tiles previous` and `tiles 416` fail in production, by design (no manifest names a file) |
| Reviewers | Code review by `sonnet` at `/code-review high` and security review by `sonnet` at xhigh (§3.3, §3.4) | As planned: two Sonnet reviewers, one for code and one for security; the fixes by Opus |

---

## 16. Amendment: P4a build (2026-10-01)

What the P4a build (issue #19, PR "P4a: API") found or settled against the plan and the issue, and why. The owner approved the decisions on 2026-10-01. No audience or channel flag changed. The PR adds two migrations (the two display-window values, and the meta view pair with its grants) and one build argument in `release.yml`; it adds no dependency and no GitHub Action. `ARCHITECTURE.md` carries a short "(P4a: …)" note at each place it changes.

| Item | Plan | What P4a does |
|---|---|---|
| D9 values in `app_meta` | A§7.5: `data_epoch` "around 2026-10-02"; `display_start` is an owner decision (D9), and the default shows the seeded data. P2 had neither key | The owner took the plan's defaults: `display_start` **2026-08-24T00:00Z** (the seeded data) and `data_epoch` **2026-10-02T00:00Z** (the plan's date for the recorder going live). The hand-written migration `20261014000001_display_window.sql` inserts both as JSON strings with an explicit `Z`, because P2 wrote neither and no reader can read `app_meta`. A change is a new migration, never an edit of this one. The API reads them through the new meta view pair (logical name `meta` in `audience.ts`; `pub_meta` and `own_meta`), whose public and owner members hold only the two instants. The cast carries an explicit offset, so no session time zone reaches it |
| The window in memory | "Each of these returns **400 without any DB query** (spy)": `t` before `displayStart`, in the future, … | `DisplayWindow` (`api/window.ts`) holds both instants in memory. It is loaded from the meta view before the server listens, tried again every 10 seconds until the first load succeeds and refreshed every 5 minutes after it; a failed refresh keeps the last value and logs a fixed code. Validation compares against the held values, so a refused request costs no query. Until the first load the routes that need the window (`/meta`, `/snapshot`, `/series/{id}`) answer 503 `unavailable`. `displayStart` is rounded up to the 10-minute grid when it loads, so the floored `t` or `from` that equals it is served: it is exactly the earliest instant `t`, `from` may take |
| Views migrations | P2a (§13): `scripts/gen-views.ts` writes `20261003000006_views.sql`, and CI regenerates and diffs it | Production has applied that migration, so its text never changes. `gen-views.ts` has a table `LATER`: each view added afterwards is generated into a migration of its own, and the first migration skips it. The meta pair is `20261014000002_views_meta.sql` (CREATE VIEW and GRANT for both families, DROP on the way down). `pnpm db:views` writes every generated file and `--check` diffs every one. A change to the body of an existing view would need a migration that replaces it; there is none yet |
| OpenAPI | `@hono/zod-openapi` 1.6.3 (A§3; P4a scope: "Hono + zod-openapi") | Zod 4.6.5's own `z.toJSONSchema` (draft 2020-12, the dialect of OpenAPI 3.1). `packages/contracts/src/openapi.ts` writes the paths out, and the components are generated from the schemas that the API validates its answers against (`ApiError`, `Meta`, `Stations`, `Snapshot`, `Series`, `Health`, `HealthSources`, and `HealthUnavailable`, the 503 body of the health routes), so the document and the answers cannot drift apart. No new dependency: the BOM row of `@hono/zod-openapi` stays `planned` (P9). The document names no software version |
| "Data since" | A§7.5: "a per-station 'data since' note"; the `series` table has `first_seen` | `series.first_seen` is the registration time (the sync's `DEFAULT now()`), not the first data: the DE-1 seeds reach back to 2026-08-24. `/stations` therefore returns `dataSince` per series: the first UTC day with data in the display channel, read from the daily rollup view (so the history window applies), or `null`. Day precision (KG-112). Ceiling (`ponytail:` in `api/data.ts`): a `GROUP BY` over the daily rollup, once per computation and cached for 300 s (580 ms uncached at 3,000 series × 365 days); the first-data day is stored per series once the registry passes 1,000 active series or an uncached `/stations` passes 500 ms |
| Field names and source IDs | A§9.1: the static files are camelCase (`dataEpoch`, `displayStart`); the P2a health documents are snake_case | The new documents are camelCase like the static files (`dataEpoch`, `displayStart`, `ageSeconds`, `stalenessLimitSeconds`); the health documents keep their snake_case. The source ID is per series (`series[].source`), not per station, because a station may in principle carry series of more than one source. Values are in the canonical unit (`cm` for H, `m³/s` for Q) and `nativeUnit` names the provider's |
| Instants | P4: "`t` needs an offset, ≤ 32 characters, quantised to 10 min, within [`displayStart`, now]; unknown parameters → 400". A§9.2 allows `t` up to now + 48 h | RFC 3339 with an offset: uppercase `T` and `Z`, seconds optional (the web's `?t=2026-11-20T14:00Z` is valid), a fraction of at most 9 digits, years 1900–2099, a real calendar day, an hour of at most 23, a minute and a second of at most 59 (`:60` is refused), an offset of at most 23:59, and `-00:00` refused (RFC 3339 §4.3: the offset is unknown). At most 32 characters, checked before anything is parsed. In a query string a `+` must be sent as `%2B`: a raw `+` decodes to a space and is a 400. The instant is floored to the 10-minute UTC grid. `t` may be at most 5 minutes ahead of the server clock (client skew; a future `t` is P8), `to` at most 10 minutes; anything below `displayStart` is `out_of_range`. A repeated key, an unknown key and a missing or malformed value are 400s |
| Spans, `res` and points | A§9.2: span caps raw 14 d, 1h 366 d, 1d 10 y; at most 20k points | `from` and `to` are floored, and `from` must be before `to`. The caps are raw 14 days, 1h 366 days and 1d 3,660 days. `res` is optional: without it the finest resolution whose cap holds the span is used, and a span that fits none is `span_too_long`. `res` is part of the cache key. At most 20,000 points; the answer says `truncated` when there were more. The span is half-open, [from, to). The series id must be a positive int4 |
| Series that cannot be shown | Not specified | An unknown series, a series that is not in the api channel (`lic_api` off, an owner or `off` audience, a mirror or a twin) and an inactive series (in no other answer either) answer the same 404 `not_found`, and the answer is never cached, so a visitor cannot tell a withheld series from one that does not exist |
| Channels per route | A§9.2: the static files and `/snapshot` are the `display` channel; `/series` is the `api` channel | `/meta`, `/stations` and `/snapshot` read the display views (`/snapshot` through the at-T function). `/series/{id}` reads the api-channel views, so it needs `lic_api`, and rows older than a source's history window need `lic_history_export`, inside the views. Only active series are listed; station flags `tidal` and `impounded` are `null` when unknown |
| Errors and the HTTP surface | P4 review focus: "the error bodies leak no stack traces"; A§12.2: no CORS headers | Every refusal is `{"error": <code>}` with `Cache-Control: no-store` and echoes nothing of the request. The codes (`API_ERROR_CODES` in `packages/contracts`): `unknown_parameter`, `repeated_parameter`, `bad_parameter`, `out_of_range`, `span_too_long` (400), `not_found` (404), `method_not_allowed` (405 with `Allow: GET, HEAD`), `busy` (503 with `Retry-After: 5`), `unavailable` (503) and `internal` (500). Only GET and HEAD, for the whole `/api/v1` tree, the health routes included; any other path under it is a JSON 404; no `access-control-*` header is ever sent. The health routes keep their own 503 body (`{"status":"down","error":"unavailable"}`, `HealthUnavailable` in the OpenAPI document). Every answer is checked against its Zod contract before it is cached or sent, so a field added by mistake is a 503, never a leak. A failure is logged once per computation with a fixed code, never a driver message. Hono 4 answers HEAD through the GET route and drops the body, so a HEAD costs what a GET costs |
| `Cache-Control` | A§9.2: "now 60 s; < 48 h 600 s; older with `v` immutable" | By the age of the quantised instant (`to` for a series): the current 10-minute bucket or later `public, max-age=60, stale-while-revalidate=300`; younger than 48 hours `public, max-age=600`; older `public, max-age=86400`. Never `immutable`: there is no `v` before the versioned URLs of P9b. `/meta` is `public, max-age=60`, `/stations` and `/openapi.json` `public, max-age=300`, the health routes 30 s as before, every error `no-store`. `/meta`'s `now` is the time of its computation, so it may be up to 60 s old. No response depends on a request header |
| LRU and single flight | A§9.2: "An in-process LRU holds precompressed bodies"; "`singleflight` collapses identical in-flight requests"; a global DB-concurrency semaphore returns 503 | `api/lru.ts`: an LRU of answers bounded by 2,048 entries and 64 MiB (a body larger than that is not stored), each kept for the max-age it is sent with, least recently used out first. It holds the JSON text, not a precompressed body. Only answers are stored, never a failure. Callers that ask for a key while it is computed share that one computation, its result or its error. At most 64 distinct keys are computed at once; a new key beyond that is a 503 `busy` with `Retry-After: 5`. The fixed keys `meta` and `stations`, a closed set, are never refused, so the map holds at most 66 computations and a flood of `/series` or `/snapshot` keys cannot take `/meta` and `/stations` down. That is a bound on the in-flight map, not the semaphore of P9b: there is no per-client rate limit and no DB semaphore yet (R-067). The key space is closed: `meta`, `stations`, `snapshot\|<t>` and `series\|<id>\|<res>\|<from>\|<to>` over floored instants. One instance serves one audience per process |
| Pool | A§9.2: "a pool of 10" | P2a built 4 connections for the two health routes. P4a opens 10 (`API_POOL_MAX`, `openApiDb` in `main.ts`). The role's `CONNECTION LIMIT` 12 is unchanged and leaves room for a deploy's overlap |
| Build id | A§9.1: `meta.json` carries a build id | `RWS_BUILD` is the release commit: `release.yml` passes `build-args: RWS_BUILD=${{ github.sha }}` to the server image, whose Dockerfile sets it in the `ENV`; any other build is `dev`. `buildId()` reports only 40 hexadecimal characters or `dev`, so nothing else of the environment can reach `/meta`. `/healthz` still reports no version (A§12.2). The release before this change carries no `RWS_BUILD` (KG-109) |
| `/meta` sources | P4b: "footer attribution from `meta` sources"; A§9.2: an `attribution` array in every response | `sources` lists the public sources that have an active display series (today NL-1 and DE-1), each with its attribution rows verbatim in the registry's language (NL-1 `nl`, DE-1 `de`: the registry holds no English variant, KG-113). The per-response `attribution` array and the dates a licence asks for stay P9b (#24) |
| Q1 | A§8 Q1: the at-T form for a past `t`, "for t = now: `obs_latest`" | `/snapshot` runs the at-T function for every `t`, the current bucket included. No shortcut through the latest-value view: nothing proves it equal to the at-T result at a quantised past `t` |
| Reachability | P4: "Caddy: `/api/v1/*` proxy" | Caddy still proxies only `/api/v1/health` and `/api/v1/health/sources`, and P4a changes no Caddyfile, so the new routes are not public until P4b widens the allowlist (KG-110). `scripts/verify-prod.ts` expects a 404 from `/api/v1/stations` through Caddy: that check stays valid until then, and P4b extends `verify-prod.sh` to the data routes and their headers (the plan's scope) |
| Performance | "On the synthetic seed, `/snapshot` p95 is < 50 ms warm and < 150 ms cold; `/series` over 14 days raw is < 50 ms" | Measured by the CI job `bench` on the synthetic seed of `scripts/bench-q1.ts` (its API phase): cold means an LRU miss, so a database read; warm means an LRU hit. The numbers are in the PR (see the PR). They are not a production measurement (KG-111) |
| Review round 1 | Code review (CR-1 … CR-11) and security review (SR-1 … SR-3) of the PR | CR-1: `/series/{id}` is the same 404 for an inactive series. CR-2: the OpenAPI document gives the health routes their own 503 schema, `HealthUnavailable`. CR-3: the display window is tried again every 10 s until it loads, then every 5 minutes; tests of keep-last-value, the cadence and the load before listen (the api role of `main.ts` in a child process). CR-4: a route test of the 503 `busy` with `Retry-After: 5`. CR-5: the `dataSince` ceiling names its trigger (KG-112). CR-6: `displayStart` is rounded up to the grid. CR-7: `/openapi.json` answers the refusal's own code. CR-8 (a malformed `t` before the window loads is a 503, not a 400) and CR-10 (the in-flight cap is a bound on the map, not the load shedding of P9b) are accepted as they are. CR-9: the shared helpers live in `api/util.ts`. CR-11: the bench limit stays the issue's number (CI: `/series` 14 days raw p95 19.8 ms). SR-1: the fixed keys bypass the in-flight cap. SR-2: `apps/server/test/api/history-export.test.ts` fails when a public source or series turns `history_export` off, because the cache lifetime ignores history windows (KG-114). SR-3: `test/migrations.test.ts` pins the sha256 of every migration. Threat model v4.12 and R-067 updated |
