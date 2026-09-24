# Proposal "skeleton": walking-skeleton / ship-early plan

Date: 2026-09-23. Angle: build one thin end-to-end slice first (one provider → DB → API → map with a time slider → deployed on the VPS), then widen coverage. Keep the stack small and boring, with the fewest moving parts a solo owner has to run.

Sources: the live-verified research reports in `scratchpad/research/*.md`. Version numbers below are the ones those reports verified on 2026-09-23. **[pin]** marks a component the research did not version-check. The phase that introduces it must pin and record its exact version.

---

## 0. Plan at a glance

### 0.1 Five principles

1. **Deploy first, then build features. Collect production data before polishing the UI.** A "hello" build goes out through the real pipeline (TLS, signed images, backups) before any feature code exists. Production ingestion then starts as early as possible.
2. **The data epoch and the 30-day clock.** The *data epoch* is the moment the first production ingestion starts (target: **2026-10-05**). Every adapter added later backfills on its first run to `max(epoch, now − provider retention)`:

   | Provider | Retention available for catch-up |
   |---|---|
   | PEGELONLINE | 31 d |
   | Hub'Eau | 30 d |
   | hydrodaten | 40 d |
   | NRW | 7 d / 2 months |
   | LU CSV | 5 d |
   | RWS, KiWIS | decades |

   So a provider added later does **not** lose data if its adapter goes live within about 30 days of the epoch. For extra safety, Phase 2 adds **insurance capture**: the raw response bodies of every licence-clear, short-retention source are archived from the epoch, and later phases parse them by *replay*. This turns widening coverage from a race into ordinary work, and it is what makes it safe to build the UI slice before widening.
3. **One provider end-to-end first: PEGELONLINE.** One gzip GET covers 211 gauges, with no auth, ETag/304 support and the DL-DE-Zero licence. It carries MNW/MW/MHW for honest classification and 4-day forecasts at 7 Rhine gauges. It covers the whole German Rhine chain, Moselle, Saar, Main, Neckar and Lahn, which is most of "water flowing into NL" in one adapter.
4. **The default page view is static, so it survives a flood.** The SPA, the tiles, `stations.json` and `latest.json` are all static files served by Caddy. The worker writes the two JSON files after every cycle. The API is only hit when a visitor scrubs the time slider or opens a chart, and those responses sit behind quantised, cacheable URLs.
5. **Few moving parts.** The whole system is:
   - 1 VPS and 1 Compose file;
   - 4 long-running containers (`caddy`, `api`, `ingest`, `db`) plus 1 one-shot (`migrate`);
   - 1 backend image with two entrypoints;
   - hosted dead-man alerting (healthchecks.io).

   Deliberately left out: a queue, a metrics stack, an error tracker, a tile server, a CDN and PostGIS.

### 0.2 Phases and target dates (indicative)

| # | Phase | Target | Milestone |
|---|---|---|---|
| P0 | Reset and scaffold | 09-24 → 09-26 | legacy archived, CI green |
| P1 | Platform: VPS, Compose, signed pull-based CD, backups | 09-27 → 10-03 | "hello" live over TLS |
| P2 | Data spine + ingest framework + PEGELONLINE + insurance capture | 09-27 → 10-05 | **DATA EPOCH** |
| P3 | Thin slice: API + map + time slider (PEGELONLINE) | 10-06 → 10-14 | end-to-end skeleton live (noindex beta) |
| P4 | Widen 1: Netherlands (RWS) + France (Hub'Eau, Vigicrues) | 10-15 → 10-22 | NL destination on the map |
| P5 | Widen 2: Switzerland, Luxembourg, German states (NRW, NLWKN*, LHP) | 10-23 → 11-01 | all licence-clear countries live |
| P6 | Widen 3: Belgium (HIC, VMM, SPW*), gated on permission | floating (Nov) | BE live, or deferred with no data loss |
| P7 | Honest classification, thresholds, forecasts in the slider, official warnings | 11-02 → 11-12 | first-release data scope complete |
| P8 | Flood hardening + self-hosted basemap + **public beta launch** | 11-13 → 11-25 | public, before winter flood season |
| P9 | River-network pipeline (OSM graph, snapping, chainage) | 11-26 → 12-04 | directed river graph + `rivers.pmtiles` |
| P10 | "See the water flow": river colouring, flow animation, playback, along-river panel | 12-05 → 12-18 | v1.0 |
| P11 | **LATER**: historical backfill + climatology | 2027 | separate stage |

\* permission-gated sources.

Dated events that interact with this schedule:

| Date | Event | What it means for the plan |
|---|---|---|
| 2026-10-25 | DST ends | The fall-back hour is ambiguous. Hitting it 20 days after the epoch is why P2 carries DST tests. |
| 2026-10-28 | Node 26 becomes LTS | — |
| 2026-11-05 | RWS documentation moves to the "Centraal Toegangspunt Data" (CTD) | Risk for P4 |

Winter flood season on the Rhine and Meuse usually runs December to March. **P8 must land before it.**

### 0.3 Dependencies and parallel lanes

```
P0 ─┬─ P1 ─────────────┐ (P1 and P2 can run in two parallel sessions; P2 go-live needs P1)
    └─ P2 ─┬─ P3 ───────┼─ P7 ─ P8 ─ P9 ─ P10 ─ P11
           ├─ P4 ───────┤
           ├─ P5 ───────┤
           └─ P6 (gated)┘  (P6 may land after P8 without data loss: BE history is decades deep)
```

### 0.4 Owner tasks on day 1

The agent drafts these in P0; the owner sends them on day 1. Lead times are weeks, and replies from HIC take at least 5 working days.

| Recipient | Request |
|---|---|
| HIC (`hic@vlaanderen.be`) | TYPE 3 credentials and a User Agreement that allows public display |
| VMM (`hydrometrie@waterinfo.be`) | API token |
| SPW (`hydrometrie@spw.wallonie.be`) | Written permission to show the data on a public website |
| AGE (`hydrometrie@eau.etat.lu`) | Confirm the per-station JSON, forecasts and metadata are CC0; report the CSV bugs |
| NLWKN | Licence clarification (the Impressum contradicts the terms) |
| BfG | Attribution and the Belegexemplar (free copy) obligation for forecast use |
| ITZBund | Courtesy notice, and a later request for bulk history |
| RWS Servicedesk | Notice of polling load, and the `X-API-KEY` identifier we will send |
| BAFU (`abfragezentrale`) | Courtesy notice, and ask for a future historical data order |

The owner also registers the domain, orders the VPS, and creates a healthchecks.io account and an offsite restic target.

### 0.5 Per-phase workflow

Every phase is one GitHub issue with three prompts, and a roadmap issue links all phases. The steps:

1. **Build.** Start a fresh session with `/model …` and `/effort …`, then `/plan`. The owner approves the plan. The build runs on branch `phase-N-<slug>` and opens a PR. Acceptance evidence goes into the PR body.
2. **Code review.** A new session with a *different model* runs `/code-review <level> --comment <PR#>`. The build session, or a new one, fixes the findings.
3. **Security review.** A new session runs `/security-review` on the branch. Fix the findings.
4. **Merge and ship.** The owner merges. The release workflow waits for approval on the `production` environment. After approval, the VPS pulls, verifies and deploys. The agent then runs `scripts/verify-prod.sh <domain>` against public endpoints (no SSH needed).

---

## A. Tech stack

### A.1 Choices per layer

**Hosting baseline**
- One EU VPS: 4 vCPU, 8 GB RAM, ≥160 GB NVMe, Ubuntu 26.04 LTS.
- Docker Engine 29.8 with Compose v5.5.1 from Docker's apt repository.
- Disk budget:

  | Item | Size |
  |---|---|
  | Database, plain PG | 7–23 GB/yr |
  | Raw archive | about 2–5 GB steady state after 90-day retention |
  | Basemap | 4.3 GB |
  | Images and logs | a few GB |

| Layer | Choice (version line) | Licence | Rationale | Rejected alternative |
|---|---|---|---|---|
| Language / runtime | **Node.js 26.x** (26.10.0 today; LTS 2026-10-28, EOL 2029-04-30). **TypeScript 6.0.3** strict. Server code runs through Node's **native TS type-stripping**, so the server has no build step (`erasableSyntaxOnly`, `.ts` import extensions, no enums). Native `Temporal` on the server. | MIT / Apache-2.0 | One language for ingest, API and UI, with shared Zod types, the highest agent familiarity and the fewest toolchains. TS 7 is blocked for now because typescript-eslint and other tools cap TS below 6.1. | Go 1.27 backend + TS SPA (smallest footprint, but two toolchains). Python 3.14 (two languages; httpx is in limbo). Bun 1.4 (fresh Rust rewrite, "not 100% Node-compatible"). |
| Repo layout / package manager | **pnpm 12.6.0** workspaces with exactly two packages: `apps/server` (ingest + API, one image, two entrypoints) and `apps/web` (SPA). Plus `db/` (migrations), `config/` (curated stations), `deploy/`, `tools/geodata/`, `docs/`. Settings: `minimumReleaseAge` 7 days, `strictDepBuilds` with an explicit `allowBuilds`, `--frozen-lockfile`. Install pnpm explicitly: corepack is no longer bundled with Node 26 [verify in P0]. | MIT | Two packages means no internal runtime package, so Node never has to type-strip files under `node_modules`. pnpm's supply-chain defaults are the best available. | npm workspaces (no release-age or build-script gating). Nx/Turborepo (orchestration the repo doesn't need). |
| Ingestion worker + scheduling | One Node process `apps/server/src/ingest/main.ts`:<br>• **croner 10.0.1**: one schedule per source, `protect` (no overlap), jitter<br>• built-in `fetch` (undici), wrapped in our own egress guard: host allowlist, same-host redirects only, private-IP rejection after DNS, size and decompression caps, timeouts<br>• our own retry with full jitter, and a circuit breaker per source<br>• **Zod 4.6.5** schema per provider response<br>• **fast-xml-parser 5.11.1** (entities and DTD off), **csv-parse 7.0.2**, **proj4 2.22.0**, fflate for ZIP [pin]<br>• raw payloads archived to disk as zstd (`node:zlib`), content-addressed<br>• provenance in `ingest_run` | MIT | About 15 fixed polling loops do not need a queue. State lives in Postgres tables (`source_state`, `ingest_run`), so a restart is harmless and the gap-filler self-heals. | pg-boss 12.34 (queue semantics are unneeded; reconsider for the P11 backfill). Temporal server (overkill). supercronic (loses in-process state and connection reuse). |
| API + validation + OpenAPI | **Hono 4.13.8** on **@hono/node-server 2.1.1**, with **Zod 4.6.5** request/response schemas. **@hono/zod-openapi 1.6.3** emits OpenAPI 3.1 at `/api/v1/openapi.json`. The web client uses `hono/client` (`hc`) through a **type-only** import. Endpoints are versioned under `/api/v1`. No CORS (same-origin only). | MIT | Small, stable v4 line; Standard Schema; one Zod schema serves validation, OpenAPI and client types. | Fastify 5.12 (v6 is in alpha, so a 2027 migration). NestJS 12 (DI-heavy, overkill). |
| Database + extensions | **PostgreSQL 18.6**, official `postgres:18.6` image pinned by digest, **no extensions**. Note PG18's new `PGDATA`/volume path at `/var/lib/postgresql`. Layout:<br>• native **monthly range partitions** on `obs`, PK `(series_id, ts)`, BRIN on `ts`<br>• `obs_latest`, plus an `obs_1h` rollup maintained incrementally in the same transaction as each batch<br>• roles `migrator` / `ingest` / `web` (read-only, `statement_timeout` 2 s) | PostgreSQL | Measured: the "all series at time T" query takes 16–20 ms; the 3,000 × 72 frame query takes 160 ms. Worst case about 23 GB/yr. Standard `pg_dump`/restore, and no licence or extension-upgrade steps. | TimescaleDB 2.30.1 (TSL licence split, extension update after each image bump, special restore procedure; revisit when raw data passes 50 GB). PostGIS 3.6 (lon/lat columns are enough; geometry lives in static tiles). |
| Migrations + query layer | **dbmate 2.36.0**: plain-SQL up/down, committed `db/schema.sql`, `ghcr.io/amacneil/dbmate` image for production. **Kysely 0.29.6** + **kysely-codegen 0.20.0**, with generated `db-types.ts` committed and a drift check in CI. Hot queries use Kysely's `sql` template. Driver `pg` (node-postgres) 8.x [pin], with `timestamptz` parsed to string and then to `Temporal.Instant`. | MIT | SQL-first, so partitions and LATERAL queries are natural. Typed without an ORM. dbmate is language-neutral. | Drizzle (1.0 still RC; its generator doesn't understand our partitioning). node-pg-migrate 9 (JS migrations are harder to review than SQL). |
| River-network toolchain | Offline, Dockerised pipeline in `tools/geodata/`:<br>1. Geofabrik PBF extracts → osmium-tool [pin; GPL-3.0, offline tool only]<br>2. Node 26 TS graph builder: directed DAG with bifurcations, name-aware snapping, chainage from official river-km<br>3. **tippecanoe 2.79.0** → `rivers.pmtiles`, plus `rivers.geojson` published under ODbL<br>4. EU-Hydro ArcGIS REST used for QA only | BSD-2 (tippecanoe) | OSM ways already point downstream and handle the Rhine bifurcations; the geometry matches the basemap. Runs monthly, off the hot path. | HydroRIVERS (no bifurcations; licence obligations pass to end users). PostGIS + pgRouting (a DB extension for a monthly offline job). |
| Basemap / tiles hosting | **Protomaps daily build** cut with **go-pmtiles 1.31.2**:<br>• bbox `1.5,45.8,12.5,54.0` at z0–14 (**≈4.3 GB**, whole Rhine basin incl. CH Alps and Main)<br>• plus planet z0–6 (≈45 MB)<br>• style **@protomaps/basemaps 5.7.2**, muted light flavour; glyphs and sprites self-hosted<br>• served by Caddy `file_server` with HTTP range requests; versioned filenames; quarterly refresh<br>**OpenFreeMap** `positron` is the dev default and the automatic client fallback. | BSD-3 tools; ODbL data | One static file, no tile server, no third-party SLA dependency during floods. | OSM standard raster tiles (usage policy; blocked responses still return HTTP 200). OpenFreeMap as primary ("no SLA, may discontinue"). martin / tileserver-gl (another service to run). |
| Map library + visualisation | **MapLibre GL JS 6.11.1** used directly behind a small own hook (ESM-only, WebGL2) + **pmtiles 4.5.0** protocol:<br>• stations as a `circle` layer coloured through `feature-state` per time step<br>• rivers as a PMTiles line layer with feature-state colouring and an animated `line-dasharray` for flow direction<br>• an accessible **table view** as the fallback when WebGL2 is missing | BSD-3 | Handles ≤5k points and about 60 rivers with no extra rendering library. | deck.gl 9.4 (575 KB gz, version coupling; unneeded at this scale). Leaflet (no WebGL line animation). `@vis.gl/react-maplibre` (wrapper churn around ML6; its fix is unverified). |
| Frontend framework, router, data, charts, i18n | • **React 19.3.0** + **Vite 8.3.0** (`@vitejs/plugin-react` 6.1.1)<br>• **TanStack Router 1.170.39**: typed search params `t`, `station`, `mode`<br>• **TanStack Query 5.103.2**<br>• **Apache ECharts 6.1.0**, lazy-loaded chunk for hydrographs: `markLine` thresholds, forecast bands<br>• **Paraglide JS 2.25.4**: NL default at `/`, EN at `/en/`<br>• **temporal-polyfill 1.0.5**<br>• CSS Modules, no CSS framework | MIT; Apache-2.0 (ECharts) | Largest ecosystem and agent familiarity. URL-typed state gives shareable moments ("`?t=2026-11-20T14:00Z&station=…`"). Paraglide catches missing translations at compile time. | SvelteKit 2 (3.0 RC means an imminent migration). uPlot (bands and thresholds hand-drawn). i18next (runtime, untyped keys). Tailwind (one more toolchain for a small UI). |
| Testing | • **Vitest 5.0.1** (unit + integration against a **real PG 18**: a CI service container, and in agent sessions a PG 18 cluster that the SessionStart hook starts)<br>• **msw 2.15.0** replaying **recorded provider fixtures** (tests never call live APIs)<br>• **Playwright 1.63.0** (Chromium + WebKit, to cover Safari and the Temporal polyfill; axe checks [pin @axe-core/playwright])<br>• k6 for load tests [pin, P8]<br>• nightly live **contract check** | MIT / Apache-2.0 | Offline, deterministic tests. A real database catches partition and SQL issues. WebKit catches the Safari gaps. | testcontainers 12.1 (needs Docker, which agent sandboxes may not have). nock (its native-fetch recorder is unverified). |
| Lint / format / typecheck | **Biome 2.5.14** (lint + format) and `tsc --noEmit` on TS 6.0.3 per package. Generated files (Paraglide, TanStack route tree, `db-types.ts`) are excluded from lint and checked for drift. | MIT / Apache-2.0 | One fast binary. No typescript-eslint peer lock on the TS version. | ESLint 10 + typescript-eslint 8.70 + Prettier 3.9 (three tools; caps TS below 6.1). |
| Reverse proxy / TLS / caching | **Caddy 2.11.4** stock `caddy:2.11.4-alpine` image with the web build baked in:<br>• automatic Let's Encrypt (absorbs the move to 45/64-day certificates), HTTP/3, zstd/gzip<br>• SPA fallback for `/` and `/en/`; hashed assets `immutable`<br>• PMTiles with range support; `/api/*` reverse proxy<br>• `/data/latest.json` and `/data/stations.json` written by the worker<br>• `handle_errors` fallback to the static latest snapshot<br>• IP-masked access logs<br>API-side caching: quantised URLs, `Cache-Control` per age class, an in-process LRU of pre-compressed bodies with single-flight, and a per-IP rate limit on uncached endpoints. | Apache-2.0 | Zero-config TLS. The static default view needs no proxy cache. | nginx 1.30 `proxy_cache` (heavier config; its native ACME module is new). Caddy + Souin (custom xcaddy build to maintain). Traefik (label discovery unneeded). |
| Containers | • Server: built on `node:26-trixie-slim` with `pnpm deploy --prod`, run on **`gcr.io/distroless/nodejs26-debian13:nonroot`**<br>• Web: baked into the Caddy image<br>• `postgres:18.6`; dbmate 2.36.0 for migrations<br>• **every base image pinned by digest**<br>• all containers: non-root, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `tmpfs` for `/tmp`, memory limits, healthchecks, log rotation<br>• DB on an internal network with no published port; secrets as Compose file secrets | Various, permissive | Small attack surface. One image for ingest and API halves the build and scan work. | Podman rootless (friction binding ports 80/443). Watchtower (archived). Bitnami images (moved to the legacy catalogue). |
| CI/CD + supply chain | GitHub Actions:<br>• every action **pinned to a full SHA**: checkout v7, setup-node v7, pnpm/action-setup v6.1.0, docker/build-push v7.4.0, login v4.6.0, setup-buildx v4.4.1, metadata v6.2.0, attest-build-provenance v4.2.2, cosign-installer v4.1.2, harden-runner v2.21.1 (audit), codeql-action v4.38.1 (repo public), gitleaks-action v3.0.0<br>• top-level `permissions: {}`; **zizmor 1.30.1**<br>• **Grype 0.119.0 + Syft 1.52.0** (fail on fixable critical/high)<br>• buildx provenance `mode=max` + SBOM; GHCR; **cosign keyless** signing<br>• **Dependabot** with a 7-day cooldown and grouped updates (npm, actions, docker)<br>**CD is pull-based.** A `rws-update` systemd timer on the VPS picks up the release that the `production` environment approved, runs `cosign verify` (identity pinned to `release.yml@refs/heads/main`), then `compose pull` → `migrate` → `up -d` → smoke test, and rolls back automatically on failure. | Apache-2.0 / MIT | No inbound deploy SSH and no VPS credentials in GitHub. Every production image is signed and verified. Pinning plus cooldown blunt worm-style npm and action compromises. | SSH push deploy (opens SSH to runner IP ranges and puts a key in GitHub). trivy-action (compromised in March 2026). Renovate (a third-party app; Dependabot covers the needs). |
| Observability / alerting | • **pino 10.3.1** JSON logs to stdout, Docker log rotation<br>• `/api/v1/health/sources` (per-source freshness, last run, circuit state) feeding a public **"Databronnen / Data sources"** status page<br>• hosted **healthchecks.io** (free tier ≤20 checks): per-source dead-man pings, backup, update, and a canary (the worker fetches the public URL and checks disk space every 5 min) | BSD-3 (healthchecks) | The signal that matters is data freshness per source. External alerting still fires when the VPS itself is down. Nothing extra to run. | Prometheus + Grafana (0.5–1 GB RAM, AGPL Grafana). GlitchTip / Sentry self-hosted (another service; Sentry needs 16 GB). Uptime Kuma on the same VPS (silent when the VPS dies). |
| Backups | Nightly `pg_dump -Fc` plus the raw archive → **restic 0.19.1** to an offsite S3/SFTP repo. Retention 7 daily / 4 weekly / 12 monthly. Automated **monthly restore drill**. After any restore, the gap-filler re-fetches the missing window from the providers, so the effective RPO is about 0 for every provider with a retention of 1 day or more. | BSD-2 | Boring, deduplicated, encrypted, verifiable. | WAL-G / pgBackRest point-in-time recovery (pgBackRest's maintenance was in turmoil in 2026; PITR is unnecessary given re-fetchable windows). |

### A.2 Data and API contract, fixed in P2 and P3

Every later phase reuses this contract.

**Canonical values**
- Water level (H) is stored in **cm** on the series' own datum. Discharge (Q) is in **m³/s**. Values are `real`.
- Every timestamp is UTC `timestamptz`. Parsers take an explicit offset or an explicit IANA zone rule. Timestamps more than 15 minutes in the future are rejected.

**Tables**

| Group | Tables |
|---|---|
| Registry | `provider` (licence status, `capture_enabled`, `display_enabled`), `station` (canonical; name exactly as published; lon/lat; country; river as published), `station_alias` (provider references and precedence), `series` (quantity, `native_unit`, `to_canonical`, datum, gauge zero with `valid_from`, `expected_step`, `staleness_limit`, `is_tidal`, `is_impounded`, `display_tier`) |
| Observations | `obs` (partitioned monthly), `obs_latest`, `obs_1h`, `obs_revision` |
| References and forecasts | `reference_value` (kind, value, unit, basis, `valid_from`), `forecast_run` (`provider_run_key`, `issued_at` nullable, `first_seen_at`, sha256), `forecast_value` (ts, value, p10/p50/p90, kind forecast/estimate, `below_floor`) |
| Warnings | `warning_area` (geometry as GeoJSON text, level, `valid_from`/`valid_until`) |
| Operations | `ingest_run`, `source_state`, `app_meta` (`data_epoch`, `data_version`) |

**Quality control**
- `qc` is a bitmask: 1 provisional, 2 validated, 4 provider-suspect, 8 estimated, 16 range, 32 spike, 64 flatline.
- Known sentinels (`99999`, `-10000`, RWS code 99 with value 0.0) are dropped at parse time.

**Time slider**
- Range `[data_epoch, now + 48 h]`, step 10 min, with `t` quantised to 10 min.
- A station's value at `t` is its last observation carried forward (LOCF) within `staleness_limit`, which is `max(3 × step, 45 min)`. Hide the station after 25 h without data.

**Endpoints**

| Endpoint | Purpose |
|---|---|
| `/api/v1/meta` | epoch, now, sources, `data_version` |
| `/api/v1/stations` (static `/data/stations.json` from P8) | station metadata |
| `/api/v1/snapshot?t=&v=` (static `/data/latest.json` from P8) | every station's value at `t` |
| `/api/v1/series/{id}?from&to` | hydrograph; raw if span ≤14 d, hourly if ≤366 d, 20k-point cap |
| `/api/v1/series/{id}/forecast` | forecast for one series |
| `/api/v1/frames?from&to&step=1h&v=` | playback frames (P10) |
| `/api/v1/health/sources` | per-source freshness |
| `/healthz` | liveness |

---

## B. Phases

Model notation: `/model fable` = Claude Fable 5.1, `/model opus` = Claude Opus 5.5, `/model sonnet` = Claude Sonnet 5. Effort is set with `/effort`. Code-review prompts use `/code-review <same level> --comment <PR#>`. Security-review prompts use `/security-review` on the phase branch. Every build prompt starts with `/plan`.

---

### P0 — Reset and scaffold

**Goal.** Archive the old code, start `main` from zero, and give every later agent a working monorepo, CI, conventions and provider knowledge.

**Scope in**
1. **Archive the legacy code.** Create the annotated tag `legacy-v0` on the current `origin/main` HEAD and push it. Then open a PR that `git rm -r`s everything. The owner closes legacy issues and branches.
2. **Scaffold the pnpm workspace:**
   - `apps/server`: a Hono `/healthz` and an ingest heartbeat stub, both run with native TS;
   - `apps/web`: a Vite + React page reading "Hallo/Hello" through Paraglide;
   - `db/migrations/` with an empty first migration;
   - `config/`, `deploy/`, `tools/`, `docs/`.
3. **Config baseline:**
   - `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax` and `.ts` extensions;
   - Biome and Vitest 5 configs;
   - pnpm settings for release age and build allowlist.
4. **CI:**
   - `ci.yml`: install, lint, typecheck, test, web build, dbmate up/down/up round trip against a PG 18 service;
   - `security.yml`: zizmor, gitleaks, and CodeQL if the repo is public;
   - `dependabot.yml`.
5. **Agent setup:**
   - `CLAUDE.md` with the bill of materials (BOM) and version gotchas:
     - MapLibre 6 is ESM-only and needs WebGL2;
     - the PG18 image moved `PGDATA` and the volume;
     - stay on TS 6, not 7;
     - Vitest 5 defaults changed;
     - Node type-stripping rules;
     - use native Temporal on the server and the polyfill in the web app;
     - corepack is no longer bundled.
   - `CLAUDE.md` also sets conventions: UTC everywhere, canonical units, the adapter pattern, fixtures only, never call live APIs in tests. It includes commands and a definition of done.
   - `.claude/settings.json` with a narrow permission allowlist and a **SessionStart hook** that installs dependencies and starts a local PG 18 test cluster (via the session-start-hook skill).
6. **Docs:**
   - `docs/adr/0001-stack.md` (this stack);
   - `docs/providers/*.md`: the research reports, condensed to endpoints, pitfalls and licence for each provider;
   - `docs/outreach/*.md`: the permission emails from §0.4;
   - `docs/roadmap.md`.

**Scope out.** Dockerfiles and deployment (P1); any data code (P2).

**Deliverables.** The tag, the reset PR, the files above, and green CI.

**Acceptance criteria**
- `git ls-remote --tags origin legacy-v0` returns the pre-reset SHA.
- `git ls-tree -r main` contains none of `packages/`, `spike/`, `PROMPT.md` or the old `README.md` content.
- `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm -F web build` pass on a clean checkout.
- CI is green. `zizmor` reports 0 findings. Every `uses:` line is pinned to a 40-character SHA; a grep test in CI enforces this.
- `node apps/server/src/api/main.ts` serves `GET /healthz` → 200 without any build step.
- The SessionStart hook runs idempotently in a fresh cloud session, and `pnpm test:integration` reaches PG 18.
- `CLAUDE.md` lists exact pins for every dependency in `package.json`. A CI script cross-checks them.

**Dependencies.** None.

**Providers / rivers.** None. The provider docs are imported from the research.

**Risks**
- An agent could pull in dependencies it doesn't need. Mitigation: `CLAUDE.md` requires an ADR line for any new runtime dependency.
- The corepack and pnpm install path on Node 26 is still to be verified.

**Models**
- **Build: Opus 5.5 · xhigh.** Mostly patterned scaffolding, but it sets the conventions and the BOM every later phase inherits, so it needs current-version awareness.
- **Code review: Sonnet 5 · high.** A mechanical check of configs, pins and scripts against `CLAUDE.md`.
- **Security review: Fable 5.1 · high.** A small diff, but it fixes the CI permission model, action pinning, the hook and the permission allowlist that every later phase inherits. Mistakes here are repository-compromise vectors.

---

### P1 — Platform: VPS, Compose, signed pull-based CD, backups

**Goal.** Get a "hello" build to production through the real, hardened path, so that merging P2 immediately means production ingestion.

**Scope in**
1. **`deploy/bootstrap.sh`** (idempotent, Ubuntu 26.04):
   - unattended-upgrades;
   - sshd with keys only, no root login;
   - firewall: 22 from the owner's IP, 80/tcp, and 443 on tcp+udp;
   - Docker Engine + Compose v5 from Docker's apt repository;
   - the `rws` user and `/srv/rws/{env,secrets,raw,public,tiles,backup}`;
   - systemd units `rws-update.timer`, `rws-backup.timer` and `rws-restore-drill.timer` (monthly).
2. **`deploy/compose.yaml`:**
   - services `caddy`, `api`, `ingest`, `db`, and `migrate` (a one-shot the others wait on via `service_completed_successfully`);
   - two networks: `edge` and an `internal` network for the DB;
   - the hardening flags from §A;
   - Compose file secrets;
   - PG tuning: `shared_buffers` 2 GB, `jit` off, `max_connections` 50.
3. **Caddyfile:**
   - automatic TLS;
   - HSTS, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a baseline CSP;
   - the SPA fallback, `/api/*` proxy and `/data/*` static files;
   - `X-Robots-Tag: noindex` during the beta;
   - IP-masked access logs, kept 14 days.
4. **Dockerfiles** for `server` (distroless) and `web` (Caddy), with digest-pinned bases.
5. **`release.yml`:**
   - buildx with provenance and SBOM, push to GHCR;
   - Grype gate;
   - cosign keyless signing;
   - an approval job on the `production` environment that writes the signed release manifest (digests) as the `production` tag.
6. **`deploy/rws-update.sh`:**
   - poll for the manifest;
   - `cosign verify` with the pinned identity and OIDC issuer;
   - `compose pull` → run `migrate` → `up -d`;
   - smoke-test `/healthz` and `/api/v1/health`;
   - on failure, roll back to the previous digests and ping healthchecks `/fail`.
7. **`deploy/backup.sh`** (`pg_dump -Fc`, raw directory → restic) and **`deploy/restore-drill.sh`** (restore into a throwaway container, sanity queries, report timing).
8. **`scripts/verify-prod.sh <domain>`**, which checks the headers, TLS and health endpoints from outside.
9. **Runbook** `docs/runbooks/platform.md`.

**Scope out.** Application features, the basemap, and load testing (P8).

**Deliverables.** The `deploy/` directory, the release workflow, the scripts and the runbook. **Owner checklist:** DNS A/AAAA records, VPS created and `bootstrap.sh` run, healthchecks.io checks created (update, backup), restic target, `.env` and secrets populated.

**Acceptance criteria**
- `https://<domain>/` serves the placeholder with a valid certificate.
- `verify-prod.sh` confirms HSTS, the CSP and `nosniff`, and that `/healthz` is 200.
- `nmap -p 5432 <domain>` shows the port closed or filtered.
- `docker inspect` script: every container is non-root, `ReadonlyRootfs=true`, `CapDrop=ALL`.
- A merge to `main` followed by approval is live within 10 minutes. An image signed by a different identity is **refused**; test with a manually signed or unsigned tag.
- An injected failing smoke test causes an automatic rollback to the previous digests, and healthchecks shows `fail`.
- The nightly backup appears in `restic snapshots`. `restore-drill.sh` restores and passes its sanity queries in under 30 minutes.
- Stopping the update timer makes the healthchecks "update" check go red within its grace period.

**Dependencies.** P0. It can run in parallel with P2.

**Providers / rivers.** None.

**Risks**
- The owner has to do the VPS steps. Mitigation: the scripts are idempotent, and each step has a verification command.
- The GHCR pull token is only needed if the repo is private; then use a fine-grained read-only token on the VPS.
- cosign's certificate identity string must match the workflow ref exactly. The test above proves it.

**Models**
- **Build: Opus 5.5 · xhigh.** Several interacting systems (Compose, Caddy, systemd, cosign, GHCR); needs careful end-to-end reasoning.
- **Code review: Sonnet 5 · xhigh.** Shell idempotency, Compose and Caddy correctness are pattern-checkable with a checklist.
- **Security review: Fable 5.1 · high.** The production trust chain: firewall, SSH, secrets, signature identity and rollback. This is the project's highest-stakes infrastructure review before launch.

---

### P2 — Data spine + ingest framework + PEGELONLINE + insurance capture → DATA EPOCH

**Goal.** Production ingestion of PEGELONLINE into a schema every later provider reuses, plus archive-only capture of every licence-clear short-retention source. From this day on, no data is lost.

**Scope in**

1. **Migrations (tables per §A.2):**
   - `ensure_partitions(from, to)`, which the worker calls for each batch's time range and daily for the next two months;
   - an idempotent upsert: `INSERT … SELECT unnest(…) ON CONFLICT DO UPDATE … WHERE (value, qc) IS DISTINCT FROM …`, which writes to `obs_revision` whenever an existing value changes;
   - `obs_latest` and `obs_1h` maintained in the same transaction;
   - the roles and their grants.
2. **The ingest framework:**
   - a `SourceAdapter` contract: id, hosts, schedule, `maxLookback`, `fetch`, `parse` (Zod), `mapSeries`, optional `syncMetadata` and `catchUp`;
   - the pipeline: fetch → archive raw → parse → normalise units and UTC → QC flags → transactional upsert → `ingest_run` row → healthchecks ping;
   - a per-source circuit breaker;
   - a gap-filler that runs at startup and hourly: it finds missing expected buckets in the last 6 h and calls the adapter's `catchUp`;
   - the epoch catch-up on an adapter's first run;
   - `app_meta.data_epoch`, set once on the first production run;
   - a replay CLI: `node src/ingest/replay.ts --source X --from --to`.
3. **The time library.** Parsers take an explicit offset or an IANA-zone rule. Offset-less local times go through a Temporal `ZonedDateTime` with explicit disambiguation for the DST hour. Table tests cover 2025-10-26 and 2026-10-25.
4. **The egress guard** (see §A.1). Send a `User-Agent` of the form `rivierstanden/<ver> (+https://<domain>/over; <contact>)`.
5. **The PEGELONLINE adapter:**
   - every 15 min at :02/:17/:32/:47: `stations.json?waters=RHEIN,MOSEL,SAAR,MAIN,NECKAR,LAHN,RUHR,EMS,DEK&includeTimeseries=true&includeCurrentMeasurement=true&timeseries=W,Q` with ETag and gzip;
   - gap-fill and catch-up through `measurements.json?start=PT6H…P30D`, with 1-minute series downsampled to 15 min;
   - a daily metadata sync of `characteristicValues` (MNW, MW, MHW, HHW, NNW, HSW) → `reference_value`, and of `gaugeZero` changes (logged);
   - `km` stored for later chainage;
   - skip the RWS, BAFU and Ruhrverband mirrors (placeholder gauge numbers, no gauge zero);
   - treat `m+NN` series correctly;
   - **WV forecasts** for the 7 Rhine gauges every 2 h → `forecast_run` / `forecast_value`, keyed by `initialized`.
6. **Insurance capture (archive-only).** Each source is configuration only; a cadence equal to or shorter than retention is safe; unchanged bodies are deduplicated by hash.

   | Source | What is captured | Cadence |
   |---|---|---|
   | Hub'Eau | `observations_tr?code_entite=A*,B*,D*,E1*,E2*,E3*&date_debut_obs={now-3h}&size=20000` (follow the `Link` rel=next cursor) | hourly |
   | LINDAS | river + lake cube SPARQL POST | every 10 min (**never more often**) |
   | hydrodaten | `hydro_sensor_pq.geojson`, `hydro_warn_levels_de.geojson`, `q_forecast` for the 11 key CH stations | hourly |
   | NRW LANUK | `messwerte.zip` | every 3 h |
   | LU AGE | `Water-Levels-LocalTime.csv` (CC0) | every 3 h |
   | Vigicrues | `InfoVigiCru.geojson` | hourly |
   | LHP | `/data/stations` and `/data/alerts` for NW, NI, RP, HE, BW, BY, SL | hourly |

7. **Raw archive layout:** `/srv/rws/raw/<source>/<yyyy>/<mm>/<dd>/<sha256>.zst`. Retention is 90 days after a successful parse; archive-only captures are kept until they have been replayed.
8. **Recorded fixtures** for PEGELONLINE and for every capture source (`pnpm fixtures:record <source>`, dev only), used by msw in tests.
9. **Nightly `contract-check.yml`.** Live fetch + parse for every no-auth source. On drift it opens or updates a GitHub issue.

**Scope out.** The public API (P3); parsing the captured sources (P4/P5); classification beyond storing references (P3/P7).

**Deliverables.** The migrations and `schema.sql`, `apps/server/src/ingest/**`, `apps/server/src/providers/pegelonline/**`, `config/capture.json`, `config/stations/pegelonline.json` (display tiers), fixtures, tests, `docs/providers/pegelonline.md` updated with observed behaviour, and `docs/runbooks/ingest.md`.

**Acceptance criteria**
- **Unit tests:**
  - time parsing covers at least 30 cases: fixed `+01:00`, `+02:00`, `Z`, offset-less Europe/Berlin across both DST transitions, with the ambiguous hour resolved or rejected explicitly;
  - unit conversion;
  - sentinel and future-timestamp rejection;
  - egress guard: a disallowed host, a cross-host redirect, a body over the cap and a gzip-bomb fixture are all refused.
- **Integration tests on PG 18:**
  - replaying the PEGELONLINE fixtures twice → the second run adds **0** rows;
  - a changed value → one `obs_revision` row;
  - a batch spanning a month boundary auto-creates the partition;
  - `obs_1h` equals an aggregate computed from scratch over the same data.
- **Production, within 1 h of deploy:** at least 95% of tier-1 PEGELONLINE series have an `obs_latest` age under 45 min (checked via `/api/v1/health/sources`, served by the minimal API stub).
- **24 h later:**
  - the `ingest_run` success ratio is at least 98%;
  - every capture source has a raw payload in every scheduled interval, or a logged 304 or unchanged hash.
- **Outage drill:** stop `ingest` for 2 h, then start it. The gap query reports **0** missing 15-min buckets for tier-1 series over that window.
- **Alerting:** stopping `ingest` makes the per-source healthchecks go red within 30 min.
- **Backups:** the nightly backup includes the raw directory, and a restore drill followed by a gap-fill leaves no gap.
- **Epoch:** `app_meta.data_epoch` is set and shown in `/api/v1/meta`.

**Dependencies.** P0. Go-live needs P1.

**Providers / rivers.**
- Parsed: PEGELONLINE, i.e. the Rhine from Konstanz and Basel to Emmerich, Moselle, Saar, Main, Neckar, Lahn, lower Ruhr and Ems (211 stations).
- Captured: FR (Rhine/Ill, Moselle/Meurthe/Sarre, Meuse/Chiers/Semoy, Sambre, Escaut/Scarpe/Lys), CH (Rhine, Aare, Reuss, Limmat, Thur, lakes), NRW tributaries (Rur, Niers, Berkel, Vechte, Dinkel, upper Ems…), LU (Moselle, Sûre, Our, Alzette), Vigicrues vigilance sections, and LHP classes.

**Risks**
- The DST fall-back on 2026-10-25 happens 20 days after go-live, hence the DST tests.
- PEGELONLINE's ETag might not change even when data does. The ETag poll is backed up by the hourly `catchUp`.
- The capture configuration might grab the wrong window. The nightly contract check and the per-interval capture acceptance check catch this.
- Scope creep. Capture sources are configuration, not code; anything beyond template parameters and cursor pagination is out of scope.

**Models**
- **Build: Fable 5.1 · xhigh.** The hardest and most consequential code in the project. Schema, time handling, idempotency and partitioning mistakes silently corrupt data or lose it for good, and every adapter copies this pattern.
- **Code review: Opus 5.5 · xhigh.** An independent strong reviewer for transaction boundaries, SQL correctness and the parse/normalise edge cases.
- **Security review: Opus 5.5 · high.** New outbound fetchers (SSRF guard, redirect handling, decompression bombs), parsing untrusted payloads, DB role separation and the raw-archive path.

---

### P3 — Thin slice: API + map + time slider (PEGELONLINE) → end-to-end skeleton live

**Goal.** A visitor picks a date and time and sees PEGELONLINE levels on a map at that moment, in Dutch or English, on the production domain (noindex beta).

**Scope in**
1. **API** (Hono + zod-openapi): `/api/v1/meta`, `/stations`, `/snapshot?t=`, `/series/{id}?from&to`, `/health/sources`, and `openapi.json`.
2. **Input validation per the research (datum-arch D.2):**
   - ISO timestamp with an offset, at most 32 characters, within `[epoch, now+48 h]`, quantised to 10 min;
   - integer IDs; span limits; a 20k-point cap.
3. **Cache-Control by age class:**

   | Request | Header |
   |---|---|
   | now | `max-age=60, stale-while-revalidate=300` |
   | `t` within 48 h | `max-age=600` |
   | older `t` | `max-age=86400, stale-while-revalidate=604800` |

4. **API runtime:** in-process LRU with single-flight; the `web` DB role; a pool of 10.
5. **Snapshot format:** columnar arrays (series ids, values, ages, qc, class) with provenance.
6. **Classification (initial, PEGELONLINE only):**

   | Class | Condition |
   |---|---|
   | low | below MNW |
   | normal | MNW to MHW |
   | high | above MHW |
   | extreme | above HHW |
   | no-ref | reference values missing |

   Also compute Δh since the start of the window.
7. **Web:**
   - MapLibre 6 on OpenFreeMap positron for the beta;
   - stations as a `circle` layer with `feature-state`, respecting display tiers;
   - a time slider from epoch to now: 10-min steps, play/pause/step, keyboard operable, times shown in Europe/Amsterdam with a CET/CEST label, UTC in the URL;
   - a station panel with an ECharts hydrograph (H and Q, MNW/MW/MHW lines), lazy-loaded;
   - NL at `/` and EN at `/en/`;
   - a table fallback when WebGL2 is missing, and a list-view toggle;
   - a beta banner;
   - footer attribution (PEGELONLINE DL-DE-Zero, "ungeprüfte Rohdaten"; OSM/OpenFreeMap) and a "not an official warning service" disclaimer.
8. **Playwright e2e** in CI against a seeded PG + the API + `vite preview`.

**Scope out.** Other providers (P4–P6), forecasts in the slider (P7), rivers (P9/P10), the self-hosted basemap (P8).

**Deliverables.** `apps/server/src/api/**`, `apps/web/**`, seed script `pnpm db:seed:synthetic` (3,000 series × 60 days, for performance tests), e2e tests, and `docs/api.md`.

**Acceptance criteria**
- **Integration:** `/snapshot?t=<now−1d>` equals a direct SQL LOCF computation for 50 random series. Invalid `t` values (no offset, before the epoch, more than 48 h ahead, over 32 characters) → **400**.
- **Cache headers:** a test asserts the `Cache-Control` value for each age class.
- **Performance** on the synthetic seed in CI: snapshot p95 below 50 ms warm and 150 ms cold; `/series` over 14 days raw in under 50 ms.
- **Playwright (Chromium + WebKit):**
  - NL is the default and EN switches;
  - moving the slider updates `?t=` and the marker states;
  - the deep link `?t=…&station=…` restores the view;
  - the slider works by keyboard;
  - the table fallback appears with WebGL2 disabled;
  - **no CSP violations** (the test fails on any `securitypolicyviolation` event);
  - axe finds no serious or critical issues.
- **Bundle budget:** initial JS ≤ 450 KB gzip including MapLibre; ECharts is not in the initial chunk.
- **Production:** `https://<domain>/` shows PEGELONLINE stations whose "latest" is 30 min old or less, `X-Robots-Tag: noindex` is present, and `verify-prod.sh` passes.

**Dependencies.** P2 (data and schema) and P1 (deploy).

**Providers / rivers.** PEGELONLINE: the German Rhine chain Basel → Emmerich, Moselle, Saar, Main, Neckar, Lahn, Ruhr, Ems.

**Risks**
- MapLibre v6 ships almost weekly. Pin the exact version and run WebKit e2e.
- The CSP without `unsafe-inline` for MapLibre and ECharts is unverified. The CSP-violation test settles it.
- The beta relies on OpenFreeMap (no SLA). Acceptable because the beta is unannounced; P8 removes the dependency.

**Models**
- **Build: Opus 5.5 · xhigh.** Full-stack workhorse task (API semantics + MapLibre 6 + typed routing) on patterns P2 fixed.
- **Code review: Sonnet 5 · xhigh.** Independent perspective. The LOCF, cache-header and URL-state checks are concrete and testable.
- **Security review: Opus 5.5 · high.** The first public attack surface: input validation, cache-key and poisoning risks, DoS through expensive spans, CSP and headers.

---

### P4 — Widen 1: Netherlands (RWS) + France (Hub'Eau, Vigicrues)

**Goal.** Put the destination (NL) and the French upstream on the map with continuous data from the epoch.

**Scope in**

1. **RWS adapter**, REST `ddapi20-waterwebservices` via POST `OphalenWaarnemingen`:
   - a curated list of about 60–80 river stations in `config/stations/rws.json`, from the research §5 table: Lobith, Pannerdense Kop, Nijmegen, Tiel, Zaltbommel, Driel, Amerongen, Hagestein, Westervoort/IJsselkop, Doesburg, Zutphen, Deventer, Olst, Zwolle, Kampen, Eijsden-grens, Sint Pieter, Borgharen, Stevensweert, Roermond, Venlo, Grave, Megen, Lith, the Vecht (Holtheme, Ommen, Dalfsen), the Geul (Epen), and tidal stations flagged (Bath, Hansweert, Vlissingen, Delfzijl, Nieuwe Statenzijl…);
   - WATHTE/NAP/F007 and Q per station, with a 3 h window every 10 min;
   - the fixed `+01:00` offset parsed;
   - quality 99 / 0.0 dropped;
   - TAW, MSL and PLAATSLR duplicates dropped;
   - `OphalenLaatsteWaarnemingen` **not used**;
   - an `X-API-KEY` identifier sent;
   - epoch catch-up through REST.
2. **RWS WFS `locatiesmetlaatstewaarneming`** every 10 min, only for station discovery and coordinates. Its timestamp is local time mislabelled `Z`; REST wins on conflict.
3. **RWS forecasts:** `ProcesType verwachting` / `RWSM-F232`, polled hourly. A new run is detected by content hash, and `first_seen_at` stands in for the missing issue time.
4. **Hub'Eau adapter:**
   - `observations_tr` for basins A*, B*, D*, E1–E3 every 15 min with a 3 h overlap;
   - cursor pagination and 206 handling;
   - mm → cm and l/s → m³/s;
   - rows with a null station dropped;
   - station catalogue synced daily (`referentiel/stations`), with gauge-zero metadata stored but not trusted;
   - **replay of the insurance archive from the epoch**.
5. **Deduplication rules:**
   - Hub'Eau mirrors of foreign stations (BE, DE, CH) are excluded;
   - PEGELONLINE mirrors of RWS stations are excluded;
   - `station_alias` records the links.
6. **Vigicrues:**
   - `InfoVigiCru.geojson` parsed into `warning_area`: vigilance level per section over time, replayed from the archive;
   - forecasts for `StationPrevision` stations captured when events occur (runs keyed by `DtProdSimul`).
7. **Attribution:**
   - RWS: CC0, with no implied government endorsement;
   - Hub'Eau: Licence Ouverte Etalab 2.0;
   - Vigicrues: "© VIGICRUES" plus the update date.

**Scope out.** Waterinfo's internal JSON (undocumented); water-board rivers (backlog); displaying forecasts and warnings (P7).

**Deliverables.** `providers/rws/**`, `providers/hubeau/**`, `providers/vigicrues/**`, curated station configs, fixtures, tests, updated provider docs.

**Acceptance criteria**
- **Parser fixture tests:**
  - `2026-09-23T21:00:00.000+01:00` → `20:00Z`;
  - the WFS `…T21:30:00.000Z` is interpreted as Amsterdam local time;
  - Hub'Eau 491 mm → 49.1 cm, and 17,300 l/s → 17.3 m³/s;
  - pagination across 2 pages works.
- **Replay:** replaying the Hub'Eau insurance archive twice is idempotent. For at least 95% of curated FR series, the gap query from the epoch to now reports no missing hourly buckets, unless the provider itself had a gap (verified against `ingest_run` records).
- **Production:**
  - Lobith and Eijsden-grens appear with latest values 40 min old or less;
  - at least 90% of curated RWS and FR series are fresh within their `staleness_limit`;
  - `/api/v1/health/sources` lists `rws`, `hubeau` and `vigicrues` as green.
- **Map:** NL and FR stations appear with the correct attribution strings (e2e).

**Dependencies.** P2 (framework and archive). Being after P3 is only for the UI check.

**Providers / rivers**
- **NL:** Rhine branches (Bovenrijn, Waal, Pannerdensch Kanaal, Nederrijn/Lek, IJssel), Meuse, Overijsselse Vecht, Geul, and the tidal Scheldt and Eems/Dollard, flagged tidal.
- **FR:** Rhine/Ill, Moselle, Meurthe, Sarre/Nied, Meuse, Chiers, Semoy, Sambre, Escaut, Scarpe, Lys.

**Risks**
- The RWS API is young and without an SLA. It had a one-week stall in June 2026, and its documentation moves to the CTD on 2026-11-05. Mitigations: endpoints live in configuration, the nightly contract check, and freshness alerts.
- RWS fair use is unquantified (100–150 small requests per 10 min).
- Hub'Eau gauge-zero metadata has errors, so do not use it for absolute heights in the MVP.
- The WFS can show a stale value with a fresh timestamp.

**Models**
- **Build: Opus 5.5 · xhigh.** The Netherlands is the product's anchor, and RWS has several subtle traps (fixed offset, WFS mislabelling, stale "latest", TAW duplicates) plus the first real replay.
- **Code review: Sonnet 5 · xhigh.** The research pitfall lists make this a precise checklist review.
- **Security review: Sonnet 5 · high.** New hosts on an established egress-guard pattern and no new auth; mechanical.

---

### P5 — Widen 2: Switzerland, Luxembourg, German states

**Goal.** Complete all licence-clear countries, so that Switzerland and Luxembourg are "in from the start". Their data starts at the epoch thanks to replay.

**Scope in**

1. **Switzerland:**
   - **LINDAS** river + lake cubes every 10 min (BAFU's rule: never more often), anchored on the cube;
   - duplicate observations per station resolved to the latest;
   - `cube.link/Undefined` treated as no danger level;
   - the fixed `+01:00` offset parsed;
   - relative-gauge stations flagged;
   - coordinates in WGS84 from the cube;
   - from **hydrodaten** `hydro_sensor_pq.geojson` (hourly): `wl_1…wl_4` → `reference_value` (the lower bounds of danger levels 2–5, strings with units stripped), and `failure_text` notices;
   - **`q_forecast`** for 55 stations hourly → forecast runs (median, p25–p75, min/max);
   - `hydro_warn_levels` → `warning_area`;
   - a one-off **40-day catch-up** from `p_q_40days` for the key stations to the epoch;
   - replay of the insurance archive;
   - the LINDAS fallback: if hydrodaten changes, values keep flowing and cached thresholds are kept;
   - key stations: 2289 Basel, 2091 Rheinfelden, 2143 Rekingen, 2288 Neuhausen, 2473 Diepoldsau, 2016 Brugg, 2205 Stilli, 2018 Mellingen, 2243 Baden, 2044 Andelfingen, 2106 Birs, and Bodensee 2032/2043.
2. **Luxembourg:**
   - a **CSV parser** for the wide format: offset-less local time, **with the DST ambiguity resolved by column order** (a duplicated 02:xx sequence means CEST first, then CET);
   - the **15-minute late label detected automatically each day** by comparing overlap stations with PEGELONLINE (Perl, Stadtbredimus);
   - mixed units (cm, and m at Esch-Sûre);
   - stations matched by name to pygeoapi collection 655;
   - Perl and Stadtbredimus taken from **PEGELONLINE**, with the AGE copies linked as aliases;
   - replay from the epoch;
   - **LU-Alert CAP** (CC BY; data.public.lu v2 resources every 5 min): filter `[AGE]` + `FLOOD`, drop `TEST`, map ALERT_LVL_1–4 to red/orange/yellow/information, parse XML safely, store zone polygons in `warning_area`;
   - the per-station JSON, forecasts and page thresholds stay **behind a `display`/`capture` flag that is off until AGE confirms**.
3. **Germany, states:**
   - **NRW LANUK** `messwerte.zip` (DL-DE-Zero) every 15 min, with 7 days of self-healing, plus the station master from opengeodata (gauge zero on DHHN2016). Rivers: Rur, Wurm, Niers, Schwalm, Issel, Bocholter Aa, Berkel, Dinkel, upper Vechte, upper Ems. Deduplicate WSV gauges against PEGELONLINE. ZIP extraction under strict size and entry caps.
   - **NLWKN** (lower German Vechte, Dinkel): adapter built, but `display_enabled=false` until the licence is clarified in writing.
   - **LHP PublicAPI** (CC BY 4.0): flood class **only**, as class markers for RP, HE, BW, BY and SL gauges with no value source (Nahe, Lahn tributaries, Kinzig, Neckar, Main tributaries, Blies). Naive local timestamps parsed as Europe/Berlin. Refreshed every 10 min for display. Credit "Datenquelle: www.hochwasserzentralen.de" and "Stand".
4. **Attribution:**
   - BAFU (recommended credit; raw-data note; the naturgefahren.ch disclaimer);
   - AGE / LU-Alert;
   - LANUK (courtesy);
   - LHP (required).

**Scope out.** RLP, HLNUG, LUBW, Bayern and WVER (backlog, permission needed); the display of warnings and forecasts (P7).

**Deliverables.** `providers/{lindas,hydrodaten,lu-age,lu-alert,nrw-lanuk,nlwkn,lhp}/**`, curated configs, fixtures and tests.

**Acceptance criteria**
- **Fixture tests:**
  - LINDAS `2026-09-23T20:40:00+01:00` → `19:40Z`, and duplicate observations are resolved;
  - `"2500 m³/s"` → 2500;
  - an LU CSV fixture containing the 2026-10-25 fall-back hour parses to monotonic UTC with no duplicates;
  - the offset detector finds +15 min on a fixture;
  - a CAP fixture with `TEST` is dropped;
  - an XML entity-expansion fixture is refused;
  - a ZIP bomb fixture is refused.
- **Replay:** for LU, CH and NRW, epoch-to-now coverage is at least 95% of expected buckets on curated series.
- **Production:**
  - Basel 2289, Rheinfelden and Brugg, plus LU Diekirch, Remich and Rosport, show latest values 30 min old or less;
  - the LINDAS poll interval is never below 10 min (asserted from `ingest_run` timestamps);
  - health is green for every new source.
- **The owner decision for NLWKN is recorded in `provider.licence_status`.**

**Dependencies.** P2. It may run in parallel with P3 and P4.

**Providers / rivers.**
- CH: High Rhine, Alpine Rhine, Aare, Reuss, Limmat, Thur, Birs, Bodensee.
- LU: Moselle, Sûre/Sauer, Our, Alzette.
- DE: Rur, Wurm, Niers, Schwalm, Berkel, Issel, Bocholter Aa, Dinkel, Vechte, upper Ems, plus LHP classes for Nahe, Lahn, Kinzig, Neckar, Main and Blies.

**Risks**
- hydrodaten and the LU files are undocumented, and the LINDAS cube is marked "Draft". Mitigations: schema validation, the LINDAS fallback, and contract checks.
- AGE or NLWKN could refuse permission. The flags keep this from blocking the phase.
- The LU CSV offset bug may be fixed silently. The daily auto-detection handles that.

**Models**
- **Build: Sonnet 5 · xhigh.** Seven adapters on an established framework, with the pitfalls pre-documented. Well-patterned work at volume.
- **Code review: Opus 5.5 · high.** A stronger, independent reviewer for the subtle time handling (LU DST, the offset detector) and deduplication rules that a Sonnet build could miss.
- **Security review: Opus 5.5 · high.** The first XML (CAP), ZIP and SPARQL inputs: XXE, entity expansion, zip bombs and query injection all need a careful eye.

---

### P6 — Widen 3: Belgium (HIC, VMM, SPW), gated on permission

**Goal.** Close the Meuse and Scheldt gap between France and the Netherlands once the permissions exist. Belgian history is decades deep, so the phase may float without data loss.

**Entry gate.** For each provider, the written permission and credentials are recorded in `docs/licences/`. Only permitted providers are built; the rest stay listed as "pending permission" on the sources page.

**Scope in**
1. **HIC** (TYPE 3 credentials):
   - OAuth2 client credentials; the token cached for 24 h in memory and never logged; secrets as Compose secrets;
   - `getTimeseriesValueLayer` groups **156163** (H) and **156170** (Q);
   - tidal W series via `getTimeseriesValues&ts_id=…&period=PT2H`, because the value layer returns null for them;
   - `timezone=UTC`;
   - metadata cached daily, **never** wildcard listings on the hot path;
   - a credit budget recorded per run;
   - thresholds `DrempelPrewaak.O`, `DrempelWaak.O` and `DrempelAlarm.O` (m TAW) → `reference_value`.
2. **VMM** (token): batches of at most 100 `ts_id`s; `returnfields=Timestamp,Absolute Value,Quality Code`; `-10000` treated as a sentinel.
3. **SPW** (only with written permission): value-layer groups **1962373** (H) and **1962340** (Q) every 10 min; `null` and quality `-1` placeholders filtered out; the Meuse chain Chooz → Dinant → Namur → Huy → Liège → Visé (Q) → Lixhe, plus the Ourthe, Vesdre, Amblève, Semois, Sambre, and the Escaut at Tournai/Kain/Pecq.
4. **Epoch catch-up** via `getTimeseriesValues`, within credit and value limits.
5. **Datum and dedup:** TAW is stored as the series datum. Hub'Eau mirrors of Belgian stations are excluded. The RWS ↔ HIC Grensmaas links are recorded as aliases, but the gauges are not merged.
6. **Attribution:**
   - HIC's required text including the retrieval date;
   - VMM Modellicentie;
   - "Sources des données : SPW" with a link.

**Scope out.** Brussels; the VMM structure and pumping-station gauges; HIC ensemble forecasts (P7 captures them if cheap, otherwise backlog).

**Deliverables.** `providers/{hic,vmm,spw}/**`, configs, fixtures, token handling, and `docs/licences/*`.

**Acceptance criteria**
- A fixture test shows tidal ids fetched through `getTimeseriesValues` and not through the layer.
- Token refresh happens at most once per 24 h (test with a fake clock).
- A test proves the secrets never appear in logs (grep over captured log output).
- Epoch catch-up completes for permitted providers; gap check at least 95%.
- Production health is green, and Maaseik, Antwerpen tij and Menen are fresh.
- The attribution e2e test includes HIC's dated line.

**Dependencies.** P2 and the permissions. P7 does not wait for it.

**Providers / rivers.**
- Flanders: Zeeschelde (tidal), Leie/Lys, Bovenschelde, Dender, Demer, Dijle, Nete, Grensmaas.
- Wallonia: Meuse, Sambre, Ourthe, Vesdre, Amblève, Semois, Escaut.

**Risks**
- HIC's "non-commercial / personal use" wording; SPW forbids public redistribution without consent.
- Anonymous access can be blocked under load.
- Group and ID changes happen without notice; resolve by `ts_path` at startup.
- Grouped KiWIS calls take 20–45 s.

**Models**
- **Build: Sonnet 5 · xhigh.** KiWIS is one well-documented pattern across three instances, on the established framework.
- **Code review: Opus 5.5 · high.** Independent review of the credit budgeting, the tidal special case and the dedup against RWS.
- **Security review: Opus 5.5 · high.** The first OAuth client secrets and bearer tokens: storage, rotation, redaction, and making sure they never reach the browser.

---

### P7 — Honest classification, thresholds, forecasts in the slider, official warnings

**Goal.** Deliver the rest of the first-release data scope: discharge, forecasts, and provider alert levels and thresholds, all classified honestly across countries.

**Scope in**

1. **State engine.** One ordinal scale, `no-ref · low · normal · elevated · high · extreme`, filled in this priority order:
   1. operational thresholds:
      - HIC prewaak/waak/alarm;
      - CH `wl_1…4`;
      - LU orange/red and HQ-equivalent levels (if permitted);
      - Vigicrues section level for stations inside a section;
      - the RWS "grenswaarden en legendakleuren" spreadsheet (15-4-2026), imported into `reference_value`;
   2. statistical references: PEGELONLINE MNW/MHW/HHW;
   3. the provider's own class: LHP.

   Every state carries a `state_basis`, such as `PEGELONLINE MNW/MHW 2010–2020`, shown in the popup. Mappings are pure functions with boundary tests.
2. **Map modes:**
   - **State** (default);
   - **Δh since window start**: datum-free, works everywhere;
   - **Discharge**: Q in m³/s where published, with the size encoding the magnitude.

   Tidal and impounded stations get a hatched or ring style. Stale stations get their own style.
3. **The legend** explains that classes follow each agency's own references and are not strictly equivalent across countries. The palette is colour-blind-safe, diverging brown–neutral–blue–purple, with no red/green pairing and redundant cues (arrows ▲/▼, size).
4. **Forecasts in the slider:**
   - for `t` in `(now, now+48 h]`, each station shows the value from its latest run issued at or before now; stations without a forecast are greyed out as "no forecast";
   - forecast markers are hollow;
   - PEGELONLINE values from 48 h onward are labelled "estimate";
   - LU Moselle values at the forecast floor are shown as "below forecastable range";
   - BAFU forecasts carry an explanation of how to read them and the naturgefahren.ch note;
   - BfG is credited as the source of the WV forecasts.
5. **Detail chart:** the forecast band (p10–p90 or p25–p75) with the issue or first-seen time, plus threshold `markLine`s with their basis.
6. **Official warnings layer.** Time-aware at `t`, drawn from `warning_area`: Vigicrues sections, CH warning sections, LU CAP zones, LHP alerts. Each links to the official channel.
7. **Endpoint** `/api/v1/series/{id}/forecast`. The snapshot for a future `t` merges the forecasts.

**Scope out.** Our own percentile climatology (P11); ensemble or fan charts beyond what providers publish; flood-crest ETAs (backlog).

**Deliverables.** `apps/server/src/domain/state/**`, the RWS threshold import script, the web modes, legend, forecast UI, warnings layer, and tests.

**Acceptance criteria**
- A boundary test for each mapping, with values exactly at each threshold.
- A golden-file test on about 30 real stations from fixtures across all providers; changes need an explicit golden update.
- 100% of displayed markers carry a `state_basis` or `no-ref`.
- **Forecast e2e:**
  - moving the slider past now switches to forecast styling;
  - stations without a forecast are greyed;
  - `?t=` beyond +48 h → 400 from the API, and the slider clamps.
- The Δh and Q modes render. The legend text exists in NL and EN; Paraglide compile fails on a missing key.
- An axe check passes, and a colour-vision-deficiency screenshot check is attached to the PR.

**Dependencies.** P3, P4 and P5 (P6 optional).

**Providers / rivers.** All live providers.

**Risks**
- This is where the project could mislead the public during a flood. Mitigations: provenance on every state, a conservative `no-ref`, the disclaimer, links to the official services, and a Fable review.
- The RWS threshold spreadsheet is a static file that may change; version it and alert on changes.
- Forecast semantics differ (runs with no issue time, event-only runs, floors).

**Models**
- **Build: Opus 5.5 · xhigh.** Cross-provider domain logic plus UI; the workhorse at full effort.
- **Code review: Fable 5.1 · high.** Honest cross-country classification is the product's credibility and is safety-adjacent. The most capable, independent reviewer checks semantics, not just code.
- **Security review: Sonnet 5 · medium.** A small new attack surface: one endpoint on the existing validation patterns.

---

### P8 — Flood hardening + self-hosted basemap + public beta launch

**Goal.** The site must not fall over, or depend on anyone else, during a flood. Launch publicly before the winter flood season.

**Scope in**

1. **Basemap:**
   - `tools/geodata/basemap.sh`: go-pmtiles extract of the Protomaps build (bbox `1.5,45.8,12.5,54.0`, z0–14) plus planet z0–6;
   - checksum, versioned filename, atomic swap on the VPS, quarterly refresh;
   - a muted `@protomaps/basemaps` style with NL/EN labels;
   - self-hosted glyphs and sprites;
   - OpenFreeMap fallback on load error;
   - attribution "© OpenStreetMap contributors · Protomaps".
2. **Static default view:**
   - after each cycle the worker writes `/srv/rws/public/data/latest.json` and, after metadata syncs, `stations.json` (temp file, then rename; same code path as the API);
   - Caddy serves them with `max-age=60, stale-while-revalidate=300`;
   - the SPA loads these first.
3. **Cache versioning:**
   - `app_meta.data_version` bumps on any write older than 48 h (backfill or revision);
   - snapshot, frames and series URLs carry `&v=`, so past buckets become `immutable, max-age=31536000`.
4. **Degradation:**
   - Caddy `handle_errors 502 503 504` on `/api/v1/snapshot*` → the static latest, with a "degraded" flag the UI shows as a banner;
   - per-IP rate limit on `/series` and `/frames`.
5. **Load test** (k6, `tests/load/flood.js`) against a production-like stack on the VPS during a quiet hour, or on a CI runner with the synthetic seed:
   - ramp to 300 virtual users (VUs);
   - 70% latest, 20% random past `t`, 10% series;
   - chaos step: kill `api` mid-test.
6. **Security final pass:**
   - CSP without `unsafe-inline`, verified by e2e;
   - TLS and headers;
   - SSH and firewall re-check;
   - secrets rotation procedure.
7. **Runbooks:** provider outage, API/DB down, disk full, restore (drill executed and timed), token rotation, adding a station, the emergency CDN lever (documented but not enabled), and the DST check.
8. **Public pages (NL/EN):**
   - "Bronnen & licenties / Sources & licences", generated from `provider` rows with dynamic dates (HIC retrieval date, VIGICRUES update date, LHP "Stand");
   - "Over / About", with the disclaimer "Geen officiële waarschuwingsdienst" and links to the official services per country;
   - privacy: no cookies, no trackers, IP-masked logs kept 14 days;
   - the status page.
9. **Launch:** remove `noindex`; add `robots.txt`, a sitemap and an OpenGraph image; remove the beta banner and keep a "beta" label.

**Scope out.** A CDN (only the documented lever); the river network (P9).

**Deliverables.** The basemap tooling, the static snapshot writer, cache versioning, the fallback config, the k6 suite and report, runbooks, public pages, and a launch checklist.

**Acceptance criteria**
- **k6 report attached:** p95 below 300 ms, error rate below 0.1%, VPS CPU below 70% at 300 VUs.
- **Chaos:** with `api` killed, the map still loads with the latest data and the degraded banner (e2e against the stack).
- **Zero third-party requests:** a Playwright network log shows only first-party hosts on the default view, unless the fallback fires.
- **Restore drill:** under 1 h end to end, including the gap-fill to no missing buckets.
- **Lighthouse (mobile):** performance ≥ 80, accessibility ≥ 95. Zero CSP violations.
- **Attribution:** an e2e test enumerates `provider WHERE display_enabled` and asserts each attribution string appears on the sources page.
- **Production:** `verify-prod.sh` passes, `noindex` is gone, and healthchecks are all green for 72 h after launch.

**Dependencies.** P7. P6 is optional; launching without Belgium is acceptable and disclosed.

**Providers / rivers.** All live providers; OSM/Protomaps basemap.

**Risks**
- Compatibility of the Protomaps style package (5.7.2) with v4 tiles is unverified; prototype that first.
- PMTiles range requests through browsers are fine; a CDN is not tested.
- `immutable` caching is only safe if `data_version` bumps whenever past data changes. The acceptance tests cover the backfill case.

**Models**
- **Build: Opus 5.5 · xhigh.** Cross-cutting systems work (caching semantics, fallbacks, load tests, launch polish).
- **Code review: Fable 5.1 · high.** The subtle failure mode, serving stale or wrong data during a flood because of cache-key or versioning mistakes, needs the strongest independent reviewer before launch.
- **Security review: Fable 5.1 · max.** The launch gate: a whole-system audit (headers, CSP, rate limits, secrets, host, supply chain) where correctness outweighs cost.

---

### P9 — River-network pipeline (OSM graph, snapping, chainage)

**Goal.** Produce the directed river geometry and the station-on-river model that "see the water flow" needs.

**Scope in**
1. **`tools/geodata/rivers/` Dockerfile:** osmium-tool + tippecanoe 2.79.0 + Node 26.
2. **`config/river-network/rivers.json`:** a curated list of about 40–60 OSM `type=waterway` relation IDs, taken from the research (Rhein 123924, Meuse 1075197, Escaut 324288, Moselle 390416, Ems 370068, Main 412876, Neckar 123881, Sambre 1600647, Ourthe 2246211, Rur 384594, Lahn 412935, Saar 390393, Sieg 409090, Ruhr 364754, Lippe 379691, …). Nahe and Lys are disambiguated. The list adds the Dutch branches, Aare/Reuss/Limmat, Sauer/Our/Alzette, Leie/Dender/Demer, Niers, Berkel and Vecht.
3. **Extraction and graph.** Extract from Geofabrik PBFs. Build a **directed DAG** from shared nodes, keeping main_stream or connecting empty-role ways. Allow **multiple downstream edges** (Pannerdensche Kop, IJsselkop). Detect cycles. Flag reversed ways against EU-Hydro `NEXTDOWNID` (buffer match about 200 m, sampled through the ArcGIS REST API).
4. **Display simplification** per zoom (Douglas–Peucker at 5, 50 and 500 m), keeping the unsimplified version for snapping.
5. **Station snapping.** Candidate edges within 500 m whose water-body name or Wikidata ID matches; **never distance alone** (canals run alongside). Keep a manual override table.
6. **Chainage:**
   - official river-km first (PEGELONLINE `km`, RWS rkm);
   - graph distance as fallback;
   - store `(river_id, km_official, km_system, km_to_nl_entry)`;
   - per-river km direction handled.
7. **Segments.** Split the main stems at snapped stations, with `seg_id`, `up_station`, `down_station`, `is_tidal` and `river_id`.
8. **Outputs:**
   - `rivers.pmtiles` (tippecanoe) and `segments.json`, both release assets;
   - the committed `config/river-network/stations-snapped.json`, loaded into `station` by migration or sync;
   - `rivers.geojson` downloadable under **ODbL**, with attribution.

**Scope out.** Rendering and animation (P10); empirical travel-time calibration (backlog).

**Deliverables.** The pipeline, configs, outputs, a QA report (`docs/geodata/qa-<date>.md`), and the ODbL notice.

**Acceptance criteria**
- The graph is acyclic.
- 100% of a golden list of 50 hand-checked stations snap to the correct river and segment.
- For each river with official km, the km values change monotonically along the graph in the documented direction.
- Paths exist downstream from Basel 2289, Trier, the Main mouth, Namur, Chooz and Maulde to the NL entry points (Lobith, Eijsden-grens, the Scheldt border).
- Bifurcations appear with two downstream edges.
- `rivers.pmtiles` is under 30 MB.
- The pipeline is reproducible: two runs on the same PBFs produce byte-identical outputs.
- The ODbL download and attribution are live.

**Dependencies.** P4 and P5 (stations with km). It can run in parallel with P7 and P8.

**Providers / rivers.** All in-scope rivers; the data is OSM (ODbL), with EU-Hydro used for QA.

**Risks**
- Inconsistent OSM relation roles (empty roles, `tributary`) and duplicate Wikidata candidates.
- The Overpass API and Geofabrik were unreachable from the research sandbox; run the pipeline on the VPS or the owner's machine.
- ODbL share-alike on the derived graph: publish it. Station attributes stay non-OSM (official km).

**Models**
- **Build: Opus 5.5 · xhigh.** Algorithmic geodata work (graph with bifurcations, name-aware snapping). Errors are visible and the pipeline is re-runnable, so Fable is not required.
- **Code review: Sonnet 5 · high.** The golden-list and monotonicity tests make review concrete.
- **Security review: Sonnet 5 · medium.** An offline pipeline: tool-image supply chain, the download integrity of PBFs, and ODbL compliance.

---

### P10 — "See the water flow": river colouring, flow animation, playback, along-river panel

**Goal.** Deliver the product's core promise: the visitor watches water, and flood waves, move from the supplying rivers into the Netherlands.

**Scope in**
1. **River layer** from `rivers.pmtiles`:
   - segments coloured by interpolating the state or Δh of their upstream and downstream stations at `t`, through `feature-state`;
   - tidal segments hatched;
   - stale or no-data segments grey and dashed.
2. **Flow-direction animation.** Cycle `line-dasharray`. Cap the frame rate at 20–30 fps, pause when the tab is hidden, and **stop under `prefers-reduced-motion`** (keeping the step buttons).
3. **Playback.** `/api/v1/frames?from&to&step=1h&v=` returns compact arrays from `obs_1h`. A 7-day window plays in about 15 s. Play, pause, step and speed controls. URL state.
4. **"Langs de rivier / Along the river" panel.** A per-river space-time (Hovmöller) canvas: x = km to the NL entry, y = time, colour = state or Δh. Provided for the Rhine, Meuse, Moselle and Scheldt. Linked both ways with the map slider and station selection.
5. **Indicative travel times.** Static text from published priors (RWS 1985, IKSR, the RWS Meuse 2021 report), labelled "indicatief". **No ETAs.**
6. **Mobile performance.** Cap MapLibre `pixelRatio` at 2, and throttle updates.

**Scope out.** deck.gl effects, crest tracking, empirical calibration (backlog).

**Deliverables.** The river layer, animation, playback, Hovmöller panel, and e2e and performance tests.

**Acceptance criteria**
- **e2e:**
  - playback fetches at most 1 frames request per window, and the URL reflects the state;
  - under reduced motion no animation runs (checked via `requestAnimationFrame` count);
  - the panel and the map selection stay in sync.
- **Performance traces attached:** 30 fps or better scrubbing on a mid-range laptop, and 20 fps or better on a throttled mobile profile.
- `/frames` for 3,000 series × 168 h returns in under 400 ms cold, and is cacheable with `v`.
- axe passes, and the Lighthouse scores stay at the P8 budget.

**Dependencies.** P9 and P8 (caching `v`).

**Providers / rivers.** All in-scope rivers.

**Risks**
- Interpolating across weirs (Moselle, Main, Neckar, Walloon Meuse) can mislead. Use a state or Q basis there, and mark impounded segments.
- Mobile battery and performance: throttle, cap the pixel ratio, pause when hidden.

**Models**
- **Build: Opus 5.5 · xhigh.** WebGL and MapLibre animation, canvas visualisation, and accessibility; demanding, but no data-integrity risk.
- **Code review: Sonnet 5 · xhigh.** Independent review against concrete performance and accessibility criteria.
- **Security review: Sonnet 5 · medium.** Frontend-only plus one cached read endpoint; confirm the CSP and the input limits on `/frames`.

---

### P11 — LATER: historical backfill + climatology

This is a separate, later stage. It does not start before v1.0 has been stable for about 4 weeks.

**Goal.** Add history from before the epoch, and replace "no-ref" with our own day-of-year percentiles where the history allows.

**Scope in**

1. **A backfill CLI per provider:**
   - a `backfill_job` checkpoint table;
   - resumable after `kill -9`;
   - a polite pace (1 request per second, off-peak);
   - `--dry-run`;
   - yearly partitions before the epoch;
   - `qc` validated/provisional bits;
   - reconciliation of gauge-zero `valid_from` changes;
   - `obs_1h` / `obs_1d` rebuilt;
   - `data_version` bumped.
2. **Sources:**

   | Source | Route and limits |
   |---|---|
   | RWS REST | ≤160k values per request (about 2.5 years of 10-min data) |
   | HIC / VMM / SPW KiWIS | ≤250k values per call; credits |
   | NRW | opengeodata `hydro` |
   | Hub'Eau | `obs_elab` daily; HydroPortail exports (manual) |
   | BAFU | Datenservice order; clarify the time zone first |
   | Basel-Stadt | data.bs.ch API: 2289 since 2020, 2106 since 2022 |
   | AGE | archive order, 2002–2024 |
   | HLNUG | `year.json` daily |
   | PEGELONLINE | web-form history **only with ITZBund's written OK** |

3. **Climatology:** day-of-year percentile classes (at least 3 years of data), added as a basis to the state engine.
4. **Storage review:** partitions over 50 GB → TimescaleDB compression or a Parquet export of old partitions (ADR).

**Scope out.** Anything that degrades live freshness.

**Acceptance criteria**
- A killed and resumed job produces no duplicates and no gaps.
- Live freshness stays inside its limits during the backfill (health endpoint sampled).
- Row counts reconcile with the provider's for sampled series.
- Historical time-zone tests pass (BAFU CSV UTC vs UTC+1; KiWIS daily stamps).
- Percentile classes pass their golden tests.

**Dependencies.** P10, and the data orders or permissions.

**Providers.** All, as the table above allows.

**Risks**
- Long unattended runs writing into production tables.
- Historical time-zone and datum changes.
- Provider fair use.

**Models**
- **Build: Opus 5.5 · xhigh.** Batch engineering on known patterns.
- **Code review: Fable 5.1 · high.** A bug here overwrites production history during multi-day unattended runs; the strongest independent check is warranted.
- **Security review: Sonnet 5 · high.** New bulk egress and credentials on established guards; watch that tokens and data orders are handled and stored properly.

---

### Backlog, not scheduled

- Rhineland-Palatinate LfU (Nahe, with p10–p90 forecasts), HLNUG (Lahn/Kinzig), LUBW, Bayern GKD, Saarland; all need written permission.
- WVER; Dutch water boards (Vechtstromen, Rijn en IJssel, Waterschap Limburg).
- Empirical travel-time calibration by cross-correlation per flow regime, and flood-crest tracking with indicative ETAs.
- deck.gl TripsLayer effects.
- A TypeScript 7 migration once the typescript-eslint-free toolchain and TS 7.1 API allow it.
- EU-Hydro 2.0.

### Model allocation summary

| Phase | Build | Code review | Security review |
|---|---|---|---|
| P0 Reset and scaffold | Opus · xhigh | Sonnet · high | **Fable · high** |
| P1 Platform and CD | Opus · xhigh | Sonnet · xhigh | **Fable · high** |
| P2 Data spine + PEGELONLINE | **Fable · xhigh** | Opus · xhigh | Opus · high |
| P3 Thin slice (API + map) | Opus · xhigh | Sonnet · xhigh | Opus · high |
| P4 NL + FR | Opus · xhigh | Sonnet · xhigh | Sonnet · high |
| P5 CH + LU + DE states | Sonnet · xhigh | Opus · high | Opus · high |
| P6 BE (gated) | Sonnet · xhigh | Opus · high | Opus · high |
| P7 Classification + forecasts | Opus · xhigh | **Fable · high** | Sonnet · medium |
| P8 Hardening + launch | Opus · xhigh | **Fable · high** | **Fable · max** |
| P9 River network | Opus · xhigh | Sonnet · high | Sonnet · medium |
| P10 Flow visualisation | Opus · xhigh | Sonnet · xhigh | Sonnet · medium |
| P11 LATER backfill | Opus · xhigh | **Fable · high** | Sonnet · high |

Every review uses a different model from its build. Fable is used where a mistake is either irrecoverable (P2 data, P11 history) or public-facing and safety-adjacent (P7 semantics, P8 launch), and on the two trust-chain security reviews (P0, P1).

---

## C. Cross-cutting risks and mitigations

| # | Risk | Mitigation in this plan | Where |
|---|---|---|---|
| 1 | **Irrecoverable data loss** while ingestion is missing or down (provider windows: LU 5–7 d, Hub'Eau 30 d, PEGELONLINE 31 d, LINDAS has no history, forecast runs are never archived) | The data epoch in P2 comes right after the deploy pipeline. Insurance raw capture of every licence-clear short-window source from the epoch. Catch-up to the epoch on each adapter's first run. An hourly gap-filler. Per-source dead-man alerts. Backups followed by a gap-fill. Forecast runs snapshotted from the day each adapter lands. | P1, P2, all adapters |
| 2 | **Licence and permission blockers** (HIC "non-commercial", SPW no redistribution, AGE site terms, NLWKN contradictions, BfG Belegexemplar) | Outreach on day 1 (P0). The `provider.licence_status`, `capture_enabled` and `display_enabled` flags. Gated sources are Belgian, with deep history, so waiting loses nothing. The sources page discloses what is pending. LHP class markers fill German gaps under CC BY. | P0, P5, P6, P8 |
| 3 | **Undocumented or unstable endpoints** (hydrodaten, LU files, the young RWS API, the Vigicrues beta, KiWIS group changes) | One adapter per source with strict Zod validation that fails loudly. Raw archive plus replay to re-parse after a fix. Nightly contract check. Per-source circuit breaker, so one provider never blocks another. Fallbacks such as LINDAS when hydrodaten breaks. Endpoints kept in config. | P2, P4–P6 |
| 4 | **Time and offset bugs** (RWS fixed +01:00, WFS local time labelled Z, the LU CSV's offset-less local time running 15 min late, LHP naive local time, KiWIS daily stamps at UTC+1, DST on 2026-10-25) | One Temporal-based parsing module with explicit rules. Table tests at known instants and both DST transitions. Future-timestamp rejection. Offset auto-detection for LU. Runbook check on the DST weekend. | P2, P4, P5 |
| 5 | **Misleading cross-country comparison** during floods | A provenance-carrying ordinal scale with `no-ref` as the default. Datum-free Δh mode and discharge mode. A legend on non-equivalence. Disclaimer plus links to the official warning services. No ETAs. Fable review of the semantics. | P3, P7, P10 |
| 6 | **Flood traffic spike** | The default view is fully static. Versioned, immutable caching of past buckets. Single-flight LRU in the API. Caddy falls back to the static latest if the API fails. Rate limits. k6 load and chaos testing. The emergency CDN lever is documented. | P3, P8 |
| 7 | **Operational burden on a solo owner** | One VPS, one Compose file, one backend image, no queue, metrics stack, tile server or CDN. Pull-based signed updates with automatic rollback. Hosted alerting. Runbooks. Automated monthly restore drills. | P1, P8 |
| 8 | **Supply-chain compromise** (npm worms, GitHub Action tag hijacks) | pnpm `minimumReleaseAge` of 7 days with a build allowlist and frozen lockfile. SHA-pinned actions enforced by zizmor. Dependabot cooldown. Grype, SBOMs, cosign signing plus verification on the VPS. Few dependencies, each needing an ADR line. | P0, P1 |
| 9 | **Agent knowledge gaps** on 2026 majors (MapLibre 6, Vite 8, Vitest 5, TS 6/7, PG18 image path, Node 26, pnpm 12, the Compose v5 image) | `CLAUDE.md` bill of materials and gotchas. Exact pins. Strict typechecking plus offline tests as guardrails. Provider research condensed into `docs/providers`. Each build starts in `/plan` for owner approval. | P0, every phase |
| 10 | **Agent sandbox limits** (no Docker, proxied network, flaky live APIs) | Tests run against a real PG 18 started by the SessionStart hook or the CI service, never testcontainers. All tests are offline with recorded fixtures. Production verified through public endpoints (`verify-prod.sh`), not SSH. | P0, every phase |
| 11 | **Duplicate stations and datum mixing** (Lobith 627 vs 615 cm; mirrors in PEGELONLINE and Hub'Eau; TAW vs NAP; LN02) | A canonical station plus `station_alias` with precedence rules. Mirrors excluded. Datum and gauge zero stored per series with `valid_from`. Absolute heights only in the detail view, labelled, never on the map scale. | P2, P4–P6 |
| 12 | **Storage growth** | Plain PG, measured at 7–23 GB per year. Raw archive retention of 90 days. `obs_1h` for zoomed-out reads. An ADR trigger at 50 GB for TimescaleDB compression or Parquet. | P2, P11 |
| 13 | **Map stack churn** (MapLibre v6 weekly, ESM-only, WebGL2-only) | Exact pin. No wrapper library. WebKit e2e. A table fallback without WebGL2. Dependabot grouped with cooldown. | P3, P10 |
| 14 | **Provider fair use** | ETag and conditional requests. Batching. Polite, jittered schedules. A `User-Agent` with a contact address. BAFU's 10-minute minimum asserted in tests. KiWIS credit budgets. RWS Servicedesk notified. | P2, P4–P6 |
| 15 | **Tidal and weir-regulated reaches misread as flow** | `is_tidal` and `is_impounded` flags with distinct styling. Discharge or state basis on impounded reaches. Tidal segments excluded from interpolation. | P4, P7, P10 |
