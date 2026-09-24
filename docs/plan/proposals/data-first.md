# Proposal: data-first / risk-first plan for river levels flowing into the Netherlands

Angle: **data-first / risk-first**. Date: 2026-09-23. Inputs: the live-verified research reports in `scratchpad/research/`.
✓ = version or fact verified live on 2026-09-23 (npm, PyPI or git tags, by the research agents or by this agent). [U] = unverified; it becomes an acceptance check in the phase that depends on it.

---

## 0. The plan on one page

**Thesis.** The riskiest part of this project is the set of heterogeneous upstream APIs, not the UI. It is also the only irreversible part. A UI bug can be fixed next week. A day in which forecast runs, provider class labels, LINDAS values or Luxembourg's 5-day CSV go uncaptured is lost for good. The plan is built on eight rules.

1. **Capture first, parse later.** Within about a week (P1, target **≤ 2026-10-02**) a "flight recorder" runs in production. It fetches every legally capturable endpoint on schedule and stores the **raw response bytes**: content-addressed, zstd-compressed, with a manifest, synced off-site. It has no parsers and no database. Everything downstream is a replayable projection of this archive.
2. **The raw archive is the source of truth; the database is a rebuildable projection.** Parsers can be written, fixed and re-run (`replay`) later without losing a day. The same archive is the test-fixture corpus: real payloads, including the **2026-10-25 DST fall-back**, which is captured before the parsers exist.
3. **Ingest wide, display narrow.** Capture every station in the NL-bound basins, because storage is cheap and missed data cannot be collected again. Curate a smaller tier-1 set for the map.
4. **Adapter isolation.** Each provider is its own workspace package with a fixed pipeline: `capture → parse (strict Zod) → normalise (pure) → canonical`. When one provider's format drifts, only its payloads are quarantined; capture and every other provider keep running.
5. **Honest comparability by construction.** Values are stored exactly as published, plus a canonical unit. Datum and gauge zero belong to the series and carry validity ranges. Every map class has a `basis`, meaning the agency reference that produced it. Absolute heights are never compared across borders. Change (Δh) and discharge are offered as datum-free views.
6. **Licensing is gated in data, not in code.** Each source has `publication: public | dark | off` in the registry. The web tier can only read public database views. Sources still waiting for consent can be captured "dark" (an owner decision), then published retroactively by replay once consent arrives.
7. **Serve static files first.** A publisher writes precomputed, precompressed JSON for every 10-minute bucket, and Caddy serves those files plus self-hosted PMTiles. A flood-time traffic spike therefore hits files on disk, not Node or Postgres.
8. **"Twins" act as live integration tests.** When two feeds publish the same physical gauge, they are compared continuously. Examples: Perl (PEGELONLINE ≡ AGE), Chooz (Hub'Eau ≡ Vigicrues), Eijsden NAP vs TAW (233 cm), Maaseik RWS vs HIC (2.33 m). A time shift, unit error or datum error trips an alert.

**Key dates:**

| Date | Milestone |
|---|---|
| 2026-10-02 | Recorder live (target) |
| 2026-10-25 | DST fall-back, captured raw |
| 2026-10-28 | Node 26 becomes LTS |
| 2026-11-05 | RWS documentation moves to "CTD" |
| mid-December 2026 | Public launch target; Rhine/Meuse flood season runs Dec–Feb |

### 0.1 Data perishability: why the capture-only recorder (P1) comes before the data model

| Data | What the provider keeps | Perishability | Captured from |
|---|---|---|---|
| Forecast runs (RWS `verwachting`, WSV `WV`, BfG CSV, BAFU `q_forecast`, Vigicrues, AGE) | Latest run only. RWS keeps one value per timestamp and no run id | **Total** | P1 |
| Provider classes and warnings (waterinfo.rws labels, LINDAS `dangerLevel`, Vigicrues vigilance, BAFU warning sections, LHP classes) | Current state only | **Total** | P1 |
| BAFU LINDAS values | Latest value only (hydrodaten: 40 days, undocumented) | Very high | P1, plus a 40-day seed |
| AGE Luxembourg observations | CSV 5 days, JSON 7 days | Very high | P1 |
| PEGELONLINE observations | 31 days. Older data only via an undocumented web form | High | P1, plus a 31-day seed |
| Hub'Eau `observations_tr` | 1 month (Vigicrues about 2 months) | High | P1, plus a seed |
| NLWKN | 30 days | High | P1 dark (if D3) / P11 |
| Thresholds, characteristic values, gauge zeros | Current values only; changes overwrite them | Medium | P1, daily |
| NRW LANUK `messwerte.zip` | 7 days (decades via opengeodata) | Medium | P1 |
| RWS observations | Decades | Low | P1 (cheap, and needed live) |
| HIC / VMM / SPW observations | Decades | Low | P11 (SPW dark from P1 if D3) |
| LU-Alert CAP | Archive since 2025-06 | Low | P1 |

The **seed** captures are one-off fetches of each provider's full rolling window at recorder start. They are not the later historical backfill. They mean the time slider starts about 4–6 weeks before go-live for PEGELONLINE, Hub'Eau and Switzerland, at zero extra cost.

### 0.2 Architecture

```
 providers NL·DE·BE·FR·LU·CH   (HTTPS, allowlisted hosts, polite schedules)
          │
 ┌────────▼────────┐  raw bytes + manifest  ┌──────────────────┐  restic hourly  ┌───────────────┐
 │ capture         │───────────────────────►│ raw archive      │────────────────►│ off-site (EU) │
 │ egress net only │                        │ zstd, sha256     │                 │ S3-compatible │
 └─────────────────┘                        └────────┬─────────┘                 └───────────────┘
                                                     │ manifest tail  /  replay CLI
                                            ┌────────▼─────────┐  idempotent upsert  ┌───────────────────────┐
                                            │ load             │  + revisions        │ PostgreSQL 18         │
                                            │ parse→QC→normal. │────────────────────►│ + TimescaleDB 2.30    │
                                            │ quarantine drift │                     │ obs · forecasts · refs│
                                            └──────────────────┘                     └──────┬──────────┬─────┘
                                                                      public views (ro)     │          │ (ro)
                                                                    ┌───────────────────────▼┐   ┌─────▼──────┐
                                                                    │ publish: static JSON   │   │ api (Hono) │
                                                                    │ per 10-min bucket      │   │ bounded    │
                                                                    └───────────┬────────────┘   └─────▲──────┘
                                                                                │ files                │ /api/*
                                             ┌──────────────────────────────────▼──────────────────────┴──┐
 browsers ◄──── HTTPS / HTTP3 ───────────────│ Caddy: SPA · /data/* precompressed · /tiles/*.pmtiles     │
                                             └────────────────────────────────────────────────────────────┘
```

Each component runs in its own container:
- `capture` and `backup` are the only containers with internet egress.
- `load`, `publish`, `api` and `db` sit on `internal: true` networks.
- `capture` has no database credentials.
- `api` and `publish` hold read-only roles on public views.

---

## A. Tech stack

### A.1 Layer-by-layer choices

| Layer | Choice (version) | Licence | Why (one line) | Rejected alternative |
|---|---|---|---|---|
| **Language / runtime** | **TypeScript 6.0.3** ✓ (strict) on **Node.js 26.10.x** ✓ (LTS from 2026-10-28, EOL 2029-04-30) | Apache-2.0 / MIT | One language across capture, API and web with shared Zod contracts. Node 26 ships `Temporal` for DST-safe parsing ✓ and built-in zstd | **TS 7.0** (no stable API; typescript-eslint and svelte-check cap at <6.1; revisit at 7.1). **Node 24** (maintenance from 2026-10-20). **Bun 1.4** (fresh Rust rewrite, "not 100% Node-compatible"). **Python services** (two ecosystems; its record-and-replay edge is neutralised by our raw archive) |
| Offline geo tooling only | **Python 3.14.7** ✓ + **uv 0.12.18** ✓ + ruff 0.16.8 ✓, confined to `tools/rivernet` (own container, never in runtime) | PSF / MIT | pyosmium, shapely and networkx are the mature tools for OSM node-level topology | TypeScript geo stack (no mature OSM topology reader) |
| **Repo layout / package manager** | **pnpm 12.6.0** ✓ workspaces: `apps/*`, `packages/*`, `adapters/*`, `tools/*`. Settings: `minimumReleaseAge: 10080` (7 days), `strictDepBuilds`, explicit `allowBuilds`, `--frozen-lockfile` | MIT | Best supply-chain defaults after the 2026 npm worm. Strict workspaces make adapter boundaries enforceable | npm workspaces (weaker defaults); Nx / Turborepo (orchestration not needed) |
| **Capture scheduling** | **croner 10.0.1** ✓ in-process cron. **undici 8.11.0** ✓ `Agent` with a custom DNS lookup that rejects private IPs, plus per-host connection caps. `node:zlib` zstd. Own backoff and circuit breaker (about 100 tested lines) | MIT | Capture must keep working when the DB is down, so the component that must never lose data does not depend on the DB | **pg-boss 12.34** for capture (couples capture to the DB; it is reserved for P12 backfill); supercronic (no in-process politeness state); Temporal server (overkill) |
| **Provider parsing** | **Zod 4.6.5** ✓ (one strict schema per provider response); **fast-xml-parser 5.11.1** ✓ (entities off) for CAP; **csv-parse 7.0.2** ✓; **fflate 0.8.3** ✓ for ZIP (entry-count and size caps); **proj4 2.22.0** ✓ (LV95, Lambert 72/2008, LUREF and RD to WGS84); **yaml 2.9.1** ✓ for the registry | MIT / ISC | Strict schemas catch format drift on the first failed payload. The pure parse and normalise functions are fully covered by golden tests | Runtime xlsx parsing: the RWS thresholds workbook is converted offline instead, so no SheetJS in production. Lenient parsers |
| **Database** | **PostgreSQL 18.6** ✓ + **TimescaleDB 2.30.1** ✓, image `timescale/timescaledb:2.30.1-pg18` pinned by digest. Note the PG18 volume path is `/var/lib/postgresql` | PostgreSQL / Apache-2.0 + TSL (free self-hosting) | From go-live onward we keep 200–300 M observation and forecast rows per year, forever, on one VPS. That needs columnstore compression (about 10×), continuous aggregates (1 h / 1 d) for the slider, and SkipScan for "value at time T" | **Plain partitioned PG** (about 25–30 GB/year including forecasts; hand-rolled rollups and partition management); ClickHouse / QuestDB (a second system with weak upserts and revisions); PostGIS (no runtime spatial queries; geometry is precomputed offline) |
| Migrations | **dbmate 2.36.0** ✓, plain SQL, run as a one-shot compose service before `load` and `api` start | MIT | Handles hypertable and continuous-aggregate DDL natively | drizzle-kit (Drizzle 1.0 still RC; no hypertable awareness); node-pg-migrate |
| Query layer | **Kysely 0.29.6** ✓ + kysely-codegen 0.20.0 ✓ on **pg 8.23.0** ✓. Hot queries are reviewed SQL via Kysely's `sql` | MIT | Typed SQL without ORM magic; Timescale functions stay first-class | Drizzle ORM 0.45 / 1.0-rc (churn); Prisma (heavy; poor fit for Timescale SQL) |
| **API** | **Hono 4.13.8** ✓ + @hono/node-server 2.1.1 ✓ + **@hono/zod-openapi 1.6.3** ✓, producing OpenAPI 3.1 from the same Zod contracts. Own token-bucket rate limiter and in-process LRU | MIT | Small and stable (v4 since 2024, no pending major); typed contract shared with the web app | Fastify 5.12 (v6 migration due in 2027); NestJS 12 (DI overkill); FastAPI (second language) |
| **River network processing** | `tools/rivernet`: **pyosmium 4.3.1** ✓, **shapely 2.1.2** ✓, **networkx 3.7** ✓, **pyproj 3.8.0** ✓, **osmium-tool 1.19.1** ✓ (GPL-3.0, build-time CLI only), **tippecanoe 2.79.0** ✓. Input: Geofabrik PBF (OSM). QA: EU-Hydro v1.3 REST. Output published under ODbL | BSD / MIT / GPL (tool only) | OSM ways point downstream and support bifurcations (Pannerdensche Kop, IJsselkop). EU-Hydro gives a licence-clean direction check | HydroRIVERS (no bifurcations; licence passes on to users); Natural Earth (too coarse); CCM2 (non-commercial, unreachable); EU-Hydro as primary (2006–2012 imagery; EU Login for bulk) |
| **Basemap / tiles** | **Protomaps** daily build (basemap v4.15.2 ✓), extracted with **go-pmtiles 1.31.2** ✓ to the Rhine-basin bbox `1.5,45.8,12.5,54.0` at z0–14 (**≈ 4.3 GB** ✓ dry-run), plus planet z0–6 (≈ 45 MB ✓). Styled with **@protomaps/basemaps 5.7.2** ✓ (muted light), with self-hosted glyphs and sprites, served by Caddy with HTTP range requests. **Fallback and dev default:** OpenFreeMap `positron` | ODbL data; BSD-3 code | A static file has no third-party dependency during a flood. The bbox covers CH/Aare to the Wadden Sea | tile.openstreetmap.org (no SLA; blocks with an HTTP 200 "blocked" tile); OpenFreeMap or VersaTiles as primary (no SLA; VersaTiles data 3.5 months old); martin / tileserver (a server where a file suffices) |
| **Map library / visualisation** | **MapLibre GL JS 6.11.1** ✓ (ESM-only, WebGL2-only) + **pmtiles 4.5.0** ✓, with a thin in-house React binding (about 200 lines). Stations are a `circle` layer with `feature-state`. Rivers are a `line` layer. Flow direction is an animated `line-dasharray`. Space-time panel uses an ECharts heatmap | BSD-3 | The vector-tile style ecosystem is MapLibre-native, and a few thousand points are trivial for it | @vis.gl/react-maplibre 8.1 (MapLibre 6 compatibility only reported [U]); Leaflet (no WebGL vector); OpenLayers; **deck.gl 9.4** (575 KB, MapLibre 6 interleaving unverified; deferred until after launch) |
| **Frontend framework** | **React 19.3.0** ✓ + **Vite 8.3.0** ✓, built as a static SPA with `/nl` and `/en` routes | MIT | Largest ecosystem and highest agent familiarity; a static bundle is the most flood-proof delivery | SvelteKit 2 (3.0 RC migration imminent); Vue / Nuxt (`vue-maplibre-gl` lacks MapLibre 6); SSR (Next / Astro): a server in the hot path |
| Router + data fetching | **TanStack Router 1.170.39** ✓ (typed search params `?t=&s=&mode=&v=`) + **TanStack Query 5.103.2** ✓ | MIT | Deep-linkable, type-safe URL state for the time selector | React Router 8 (weaker search-param typing) |
| Charts | **Apache ECharts 6.1.0** ✓ | Apache-2.0 | `markLine` for thresholds, `markArea` for alert bands, forecast bands, `dataZoom`, and a heatmap for the Hovmöller panel | uPlot 1.6.32 (no built-in bands or marks; last release 2025-03); Chart.js |
| i18n / dates | **Paraglide JS 2.25.4** ✓ (compile-time, typed; `nl` default + `en`; CI fails on a missing key). **temporal-polyfill 1.0.5** ✓ (Safari lacks Temporal). **Tailwind CSS 4.3.3** ✓ | MIT | Zero runtime cost, and type errors on missing messages | i18next 26 (runtime loading, untyped keys); date-fns-tz (second date model) |
| **Testing** | **Vitest 5.0.1** ✓ with `onUnhandledRequest: 'error'` (no test touches the network); **golden tests** from real archived payloads; **fast-check 4.10.2** ✓ property tests (time, unit, datum); **msw 2.15.0** ✓ (HTTP client and capture specs); **testcontainers 12.1.0** ✓ with the exact production Timescale image; **Playwright 1.63.0** ✓ (Chromium, WebKit, Firefox, no-WebGL2); **@axe-core/playwright 4.13.0** ✓; **k6 v1.8.1** ✓ (load tests) | MIT / Apache-2.0 / MPL-2.0 / AGPL (tool) | Offline, deterministic tests on real-world payloads. The archive is a better corpus than VCR recordings | nock (native-fetch recorder [U]); VCR-style recording; nightly tests against live APIs as the main guard (flaky; used only as a canary) |
| **Lint / format / typecheck** | **Biome 2.5.14** ✓ (lint + format); `tsc --noEmit` with TS 6.0.3 `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; ruff for Python; a repo script enforcing adapter import boundaries | MIT / Apache-2.0 | One fast tool, and compatible with TS 6 | typescript-eslint 8.70 (caps TS <6.1; slow); ESLint + Prettier (two tools) |
| **Reverse proxy / TLS / caching** | **Caddy 2.11.4** ✓ (`caddy:2.11.4-alpine`, stock, no plugins): automatic HTTPS (absorbs the shrinking Let's Encrypt lifetimes), HTTP/3, `file_server precompressed zstd gzip`, range requests, path-based `Cache-Control`. A static-first publisher replaces a proxy cache | Apache-2.0 | Past buckets become files; a spike costs disk reads | nginx 1.30 (good `proxy_cache`, but the newer ACME module is less proven and static-first makes a proxy cache unnecessary); Caddy + Souin xcaddy build (extra supply chain); Traefik; third-party CDN (dependency; documented only as a flood-mode option) |
| **Containers** | **Docker Engine 29.8.1** ✓ + **Compose v5.5.1** ✓ on Debian 13. Runtime image `gcr.io/distroless/nodejs26-debian13:nonroot` ✓; build stage `node:26-trixie-slim`; all pinned by digest. Every service runs non-root with `read_only`, `cap_drop: [ALL]`, `no-new-privileges` and segmented networks | Apache-2.0 | Minimal attack surface on one host | Podman rootless (friction binding ports 80/443); Bitnami (legacy catalogue); Kubernetes (one VPS); Watchtower (archived) |
| **CI/CD + supply chain** | GitHub Actions with **every action pinned to a full SHA** (checkout v7, setup-node v7, pnpm/action-setup v6.1.0, docker/build-push-action v7.4.0, login v4.6.0, setup-buildx v4.4.1, metadata v6.2.0, cosign-installer v4.1.2, attest-build-provenance v4.2.2, harden-runner v2.21.1 ✓) and top-level `permissions: {}`. Scanners: **zizmor 1.30.1**, **gitleaks 8.30.1** (CLI), **Syft 1.52.0 + Grype 0.119.0** ✓. buildx `provenance: mode=max`, `sbom: true`; images on GHCR; **cosign keyless** (GitHub OIDC). **Renovate** (`config:best-practices`, `helpers:pinGitHubActionDigests`, `minimumReleaseAge: 7 days`). CodeQL v4.38.1 if the repo is public. Nightly **contract-canary** workflow. Deploy: an SSH key restricted by `command=` to `deploy.sh <digest>`, which runs **`cosign verify`** pinned to this repo's main-branch workflow before `docker compose pull && up -d` | MIT / Apache-2.0 | Reflects the 2026 incidents: the Trivy tag hijack, the npm worm, classic npm tokens revoked | Trivy / trivy-action (March 2026 compromise); Dependabot (weaker grouping and digest pinning); long-lived registry tokens; auto-updaters |
| **Observability / alerting** | **pino 10.3.1** ✓ JSON logs with Docker log rotation. Domain health lives in the DB (`source_health`: newest data per source and series against its expected step, loader lag, quarantine count), exposed at `/api/v1/health`. **healthchecks.io** (hosted, free 20 checks) as a dead-man switch per provider, plus checks for disk, backup and publisher. External uptime: a scheduled GitHub workflow curls the public health endpoint and pings a check. A rate-limited client-error beacon endpoint | MIT / BSD-3 | The signal that matters is per-source freshness, and it must alert from **outside** the VPS | Prometheus + Grafana at MVP (RAM and ops for little gain; revisit VictoriaMetrics 1.152 later); Sentry self-hosted (16 GB RAM); Uptime Kuma on the same VPS (dies with it) |
| **Backups / DR** | **restic 0.19.1** ✓: raw archive hourly (append-only, **kept forever**); nightly `pg_dump -Fc` (using the Timescale pre/post-restore procedure), retained 7 daily / 8 weekly / 12 monthly, to an EU S3-compatible bucket. Monthly automated restore drill. The DB can be rebuilt from the archive (`replay`), and the provider windows (7–40 days) refill any gap after a rebuild | BSD-2 | The archive plus replay already gives point-in-time recovery, and dumps give a fast restore | WAL-G / pgBackRest PITR (unnecessary; pgBackRest maintenance status in flux) |
| Secrets | Compose `secrets:` from root-owned 0600 files on the VPS (DB roles, KiWIS tokens, restic key, healthchecks URLs). Never in git (gitleaks). GitHub holds only the restricted deploy key; cosign uses OIDC (no signing key) | — | Minimal moving parts on one host | Vault / SOPS (overkill) |
| VPS | 4 vCPU, 8 GB RAM, **≥ 200 GB NVMe**, EU region, Debian 13. nftables allows 22 (keys only), 80 and 443; unattended-upgrades; **chrony** (accurate clocks matter for fetch timestamps) | — | The DB compresses to about 5 GB/year, the hot raw archive is about 5 GB, the PMTiles about 4.3 GB; comfortable headroom | 16 GB tier (only needed if Grafana or VictoriaMetrics are added) |

### A.2 Canonical data model (outline; P2 finalises it)

```sql
provider(id PK, name, country, licence, attribution_nl, attribution_en, terms_url,
         publication 'public'|'dark'|'off', permission_ref, contact)
station(id PK,             -- '<CC>-<AUTHORITY>-<code>': DE-WSV-2790020, NL-RWS-lobith.bovenrijn.haven,
                           -- FR-SANDRE-B720000001, CH-BAFU-2289, LU-AGE-diekirch, BE-HIC-maa02a-1066
        name, water_name,  -- exactly as published by the authoritative provider
        country, lon, lat, river_id, km_official, km_system, km_to_nl_entry,
        flags (tidal, impounded, lake, reservoir), tier 1|2, operator)
series(id PK, station_id, provider_id, quantity 'H'|'Q', value_kind 'stage'|'level',
       provider_key, native_unit, to_canonical,   -- H→cm, Q→m³/s; declared, never inferred per row
       datum 'NAP'|'TAW'|'NHN'|'NN'|'IGN69'|'NGF1884'|'LN02'|'NG95'|'LOCAL'|'MSL',
       expected_step, staleness_limit, role 'primary'|'twin'|'mirror', active)
gauge_zero(series_id, value_m, datum, valid tstzrange, source_batch)       -- WITHOUT OVERLAPS
obs(series_id, ts timestamptz, value real, qc int2, batch_id)             -- hypertable, PK(series_id, ts), 7-day chunks
obs_revision(series_id, ts, old_value, new_value, old_qc, new_qc, batch_id, changed_at)
obs_latest(series_id PK, ts, value, qc)
obs_1h, obs_1d                                                             -- continuous aggregates: min/max/avg/last/n/qc_or
reference_value(series_id, kind, value, unit,
                semantics 'operational'|'statistical'|'historical',
                percentile_convention 'exceedance'|'non_exceedance'|NULL,
                period daterange, valid tstzrange, source_batch)           -- WITHOUT OVERLAPS
class_obs(subject_id, ts, provider_code, provider_label, batch_id)        -- provider-issued classes (hypertable)
forecast_run(id, series_id, source, issued_at, issued_inferred bool, first_valid, fetched_at,
             content_hash, kind 'deterministic'|'quantiles'|'ensemble_summary', UNIQUE(series_id, content_hash))
forecast_value(run_id, valid_ts, value, p05, p10, p25, p50, p75, p90, p95, vmin, vmax, flags)  -- hypertable
warning(id, provider_id, area_key, geometry jsonb, level_norm, level_raw, label_raw, valid tstzrange, issued_at, batch_id)
ingest_batch(id, provider_id, spec_id, archive_key, sha256, fetched_at, http_status, bytes, adapter_version,
             parse_status 'ok'|'quarantined'|'skipped', n_rows, n_new, n_changed, error)
-- web tier roles see only views: public_series, public_obs, public_forecast, … (filtered on provider.publication)
```

**QC bitmask:**

| Bit | Meaning | Bit | Meaning |
|---|---|---|---|
| 1 | raw / provisional | 32 | our spike check |
| 2 | validated | 64 | our flatline-with-neighbour check |
| 4 | provider-suspect | 128 | censored (for example BfG `---` > 640 cm) |
| 8 | estimated | 256 | forecast `estimate` segment |
| 16 | our range check | | |

**Sentinels** (`99999`, `-10000`, `-888`, and RWS quality code 99 with value `0.0`) are declared per adapter and never stored as values.

**Stored units:** H in cm (`real`), Q in m³/s. Absolute heights are only derived for display, as "≈ m NAP (±2 cm)".

### A.3 Adapter contract (the unit of isolation)

```ts
export interface Adapter {
  id: ProviderId;                                   // e.g. 'de-wsv'
  captures: CaptureSpec[];                          // endpoint, schedule+offset, politeness, seed window, max bytes
  conventions: { time: TimeConvention;              // 'iso-offset' | 'fixed-offset(+01:00)' | 'local-labelled-Z'
                 units: UnitDecl[];                  //  | 'naive-local(Europe/Luxembourg)' | 'epoch-ms' | 'dotnet-date'
                 sentinels: Sentinel[]; qcMap: QcMap };
  parse(p: ArchivedPayload): ProviderRecords;       // pure; throws SchemaDrift → payload quarantined
  normalise(r: ProviderRecords, reg: RegistryView): CanonicalBatch;  // pure
}
// CanonicalBatch = { observations, references, classObs, forecastRuns, warnings, stationSightings }
```

Rules:
- Adapters may import only `@rws/core`.
- No adapter imports another adapter; a CI script enforces this.
- Each adapter ships `fixtures/*.raw` (real archive payloads) plus `*.golden.json`.

### A.4 Repository layout

```
apps/worker      one image, role by command: capture | load | publish | twin-check | replay
apps/api         Hono read API
apps/web         React SPA (baked into the Caddy image)
packages/core    canonical types, time/unit/datum/QC, classification (pure functions)
packages/contracts  Zod schemas for static files + API  → JSON Schema / OpenAPI
packages/db      dbmate migrations, Kysely types, reviewed SQL, roles
packages/http    polite fetch client, archive writer/reader, manifest
packages/registry   YAML registry loader + validator + DB sync + drift report
packages/kiwis   shared KISTERS KiWIS client (P11)
adapters/        nl-rws de-wsv de-bfg de-nw-lanuk de-lhp fr-hubeau fr-vigicrues ch-bafu lu-age lu-lualert
                 (P11: be-hic be-vmm be-spw de-ni-nlwkn)
registry/        providers.yaml, stations/*.yaml, twins.yaml, thresholds/*.csv, permissions/*.md
tools/rivernet   Python/uv pipeline: OSM → directed graph, snapping, rivers.pmtiles (own Dockerfile)
tools/basemap    go-pmtiles extract + style build scripts
infra/compose    compose.yml, Caddyfile;   infra/vps: bootstrap.sh, deploy.sh, restic units
docs/            adr/, sources/ (catalogue + research), legal/, runbooks/, classification.md
```

### A.5 Published contracts (hot path = static files)

**Static files:**

| Path | Contents | `Cache-Control` |
|---|---|---|
| `/data/latest.json` | Latest state | `max-age=60, stale-while-revalidate=300` |
| `/data/snap/recent/YYYY/MM/DD/HHmm.json` | Buckets up to 48 h old | `max-age=300` |
| `/data/snap/settled/…` | Buckets older than 48 h | `max-age=86400, stale-while-revalidate=604800`, with ETag |
| `/data/frames/YYYY-MM-DD.json` | Hourly frames for animation | same as above |
| `/data/stations.json`, `/data/sources.json`, `/data/warnings/latest.geojson`, `/data/series/{station}/recent.json` | Station list, source attribution, warning areas, last 7 days of observations plus the latest forecast run and references | — |
| `/tiles/basemap.pmtiles`, `/tiles/rivers.pmtiles` | Map tiles | range requests |

**Dynamic API:**
- `/api/v1/series/{id}?from&to&res=raw|1h|1d`: bounded, quantised, at most 20k points.
- `/api/v1/stations/{id}`
- `/api/v1/snapshot?t=`: fallback only.
- `/api/v1/health`
- `/api/v1/openapi.json`

Every file carries a `schemaVersion` and validates against `@rws/contracts`.

---

## B. Phases

### B.0 Overview and lanes

| # | Phase | Lane | Indicative window | Depends on | Build | Code review | Security review |
|---|---|---|---|---|---|---|---|
| P0 | Reset & foundation | – | 09-24 → 09-26 | – | Opus 5.5 · high | Sonnet 5 · `/code-review high` | Sonnet 5 · xhigh |
| P1 | **Flight recorder**: capture-only in production | data | 09-26 → **10-02** | P0 | Opus 5.5 · xhigh | **Fable 5.1** · `/code-review high` | Opus 5.5 · xhigh |
| P2 | Data spine + RWS & PEGELONLINE | data | 10-03 → 10-16 | P1 | **Fable 5.1** · xhigh | Opus 5.5 · `/code-review max` | Sonnet 5 · xhigh |
| P3 | Observation adapters, wave 2 (open sources) | data | 10-17 → 10-27 | P2 | Opus 5.5 · xhigh | Sonnet 5 · `/code-review xhigh` | Sonnet 5 · xhigh |
| P4 | References, classes, warnings & honest classification | data | 10-28 → 11-06 | P3 | Opus 5.5 · xhigh | **Fable 5.1** · `/code-review xhigh` | Sonnet 5 · high |
| P5 | Official forecasts (bi-temporal) | data | 11-07 → 11-13 | P4 | Opus 5.5 · xhigh | **Fable 5.1** · `/code-review high` | Sonnet 5 · high |
| P6 | Publishing layer & read API | serve | 11-07 → 11-20 | P4 (P5 stubbed) | Opus 5.5 · xhigh | Sonnet 5 · `/code-review xhigh` | **Fable 5.1** · xhigh |
| P7 | River network, snapping & basemap | geo | 10-17 → 11-10 (parallel) | P2 | Opus 5.5 · xhigh | Sonnet 5 · `/code-review high` | Sonnet 5 · medium |
| P8 | Web app MVP (map, time selector, NL/EN) | web | 11-16 → 12-04 | P6 contracts, P7 | Opus 5.5 · xhigh | Sonnet 5 · `/code-review xhigh` | Sonnet 5 · xhigh |
| P9 | "Follow the water" flow visualisation | web | 12-05 → 12-12 | P7, P8 | Opus 5.5 · xhigh | Sonnet 5 · `/code-review xhigh` | Sonnet 5 · medium |
| P10 | Flood hardening, operations & public launch | ops | 12-07 → 12-18 | P6, P8, P9 | Opus 5.5 · xhigh | Sonnet 5 · `/code-review high` | **Fable 5.1** · xhigh |
| P11 | Gated sources (as permissions arrive) | data | on permission | P3–P5 | Opus 5.5 · high | Sonnet 5 · `/code-review xhigh` | Sonnet 5 · xhigh |
| P12 | **LATER**: historical backfill | data | 2027 | launch | Opus 5.5 · xhigh | **Fable 5.1** · `/code-review high` | Sonnet 5 · high |

Only P1's date is a hard target. Every day of delay there is data lost. The windows after P1 are indicative. The lanes (data, geo, serve/web) run in parallel on separate branches.

**Model policy:**
- Fable 5.1 is used for 7 of 39 steps. These are the steps where a miss is irreversible or most visible: data loss, silent corruption, misleading classes or forecasts, or the public attack surface.
- Opus 5.5 is the workhorse builder.
- Sonnet 5 handles reviews of well-patterned work and low-surface security reviews.
- Every review uses a different model from its build step, except P1's security review; the reason is given in P1.
- Haiku 4.5 is deliberately unused in phase prompts, because correctness dominates cost here.

**Issue template (one per phase):**

```
### 1. Build            /model opus   /effort xhigh   /plan   (then paste the build prompt)
    Prompt: read CLAUDE.md, docs/adr/*, docs/sources/*, this issue. Implement the scope; treat the
    acceptance criteria as a checklist you must prove (tests/commands). Branch claude/phase-N-<slug>,
    open a PR "Phase N – <name>", do not merge. List any [U] item you could not verify.
### 2. Code review      /model sonnet   /code-review xhigh --comment <PR#>
### 3. Security review  /model fable    /effort xhigh   /security-review   (on the phase branch)
    Then: a builder-model session addresses review comments; owner merges.
```

---

### P0: Reset & foundation

- **Goal:** Clean slate. Every later agent inherits guardrails: pinned bill of materials (BOM), CI, supply-chain policy, and the data-first rules.
- **Scope in:**
  - Annotated tag `legacy-v0` on the current `main` HEAD, pushed. A PR that removes every legacy file from `main`.
  - pnpm workspace skeleton (A.4) with empty packages.
  - TS 6.0.3 strict base config, Biome, Vitest, and `pnpm check` (Biome + tsc + Vitest).
  - pnpm supply-chain settings.
  - CI workflows: `ci.yml` and `security.yml` (zizmor, gitleaks, Syft/Grype), all SHA-pinned with `permissions: {}`. Renovate config.
  - **CLAUDE.md** containing:
    - the mission;
    - the **fresh-start rule** (never read or restore `legacy-v0` code);
    - the BOM with exact pins, and version gotchas: MapLibre 6 is ESM/WebGL2-only; PG18 `PGDATA` and volume path; TS 7 is forbidden; Vitest 5 defaults; Node 26 Temporal;
    - the architecture and the adapter contract;
    - rules: UTC everywhere, canonical units declared never inferred, no network in tests, provider strings are untrusted, no `innerHTML` / `setHTML` with provider data;
    - the definition of done, and the PR and review workflow.
  - SessionStart hook (via the `session-start-hook` skill) so a claude.ai/code session can run `pnpm check`.
  - ADR-0001…0007 recording the decisions in this plan.
  - `docs/sources/`: SOURCE-CATALOGUE.md plus the research reports.
  - `docs/legal/requests/`: ready-to-send emails to SPW, HIC, VMM, AGE, NLWKN, BAFU (history and threshold usage), BfG (forecast credit and Belegexemplar), ITZBund (heads-up and history form), and the RWS servicedesk (load heads-up, `X-API-KEY`).
- **Scope out:** any product code; the VPS itself.
- **Deliverables:** tag; clean `main`; scaffold; CI; Renovate; CLAUDE.md; ADRs; hook; legal request drafts; `scripts/verify-fresh-start.sh`; `scripts/check-bom.ts`.
- **Acceptance criteria:**
  1. `git rev-parse legacy-v0^{commit}` equals the pre-reset `main` HEAD, and the tag exists on the remote.
  2. `verify-fresh-start.sh` shows that no blob on `main` is byte-identical to a blob in `legacy-v0`, apart from an explicit allowlist (e.g. LICENSE).
  3. On a clean runner, `pnpm install --frozen-lockfile && pnpm check` passes in CI.
  4. zizmor reports 0 findings, and a CI grep asserts that every `uses:` references a 40-character SHA.
  5. gitleaks passes on the full history of `main`.
  6. `check-bom.ts` passes: the CLAUDE.md BOM equals the pins in `package.json` / lockfile.
  7. A fresh claude.ai/code session runs `pnpm check` green with no manual setup.
- **Owner actions (day 1, in parallel):**
  - Send the legal and access emails.
  - Order the VPS.
  - Register the domain and a contact mailbox for the User-Agent.
  - Create the off-site EU S3 bucket and the restic password.
  - Create a healthchecks.io account.
  - Enable branch protection (CI plus review), secret scanning with push protection, and the Actions SHA-pinning policy.
- **Providers / rivers:** none. Legal requests go to SPW, HIC, VMM, AGE, NLWKN, BAFU, BfG, ITZBund and RWS.
- **Risks:** legacy assumptions creeping back in (the fresh-start rule and the blob check prevent this); a 7-day release age blocking an urgent security fix (documented override procedure in CLAUDE.md).
- **Models:**
  - Build **Opus 5.5 / high**: mostly patterned scaffolding. CLAUDE.md and CI policy become every agent's operating manual, so it needs a strong model, but high effort suffices for known patterns.
  - Code review **Sonnet 5 / `/code-review high`**: reviewing config and docs is mechanical; a different model adds a second view cheaply.
  - Security review **Sonnet 5 / xhigh**: CI permissions, pinning and secret hygiene are well-patterned, and zizmor/gitleaks already automate most of it.

### P1: Flight recorder (capture-only ingestion in production)

- **Goal:** Stop data loss now. Every perishable, legally capturable endpoint is fetched on schedule and archived raw, synced off-site, and monitored, before any parser or database exists. Target: **live ≤ 2026-10-02**.
- **Scope in:**
  - `packages/http`, the polite client:
    - host allowlist, and private and loopback IPs rejected in DNS lookup;
    - connect timeout 10 s, total 60 s (120 s for KiWIS and metadata);
    - body cap 25 MB, decompressed cap 100 MB;
    - redirects handled manually and followed only to the same host (Vigicrues 302s);
    - User-Agent `rws-rivers/<ver> (+https://<domain>/contact)`;
    - 1–2 connections per host;
    - ETag / `If-None-Match` / `If-Modified-Since`;
    - backoff with full jitter (base 30 s, cap 30 min, honour `Retry-After`), and a per-host circuit breaker (opens after 5 failures, probes every 30 min);
    - staggered schedule offsets.
  - Archive writer:
    - key `archive/{provider}/{spec}/{yyyy}/{mm}/{dd}/{HHmmss}Z-{sha256:16}.zst`, written via tmp + fsync + rename;
    - daily JSONL manifest recording request descriptor, `fetched_at` start and end (UTC), status, selected headers, sha256, bytes, spec version and **shape fingerprint** (hash of sorted JSON key paths or the CSV header);
    - an unchanged body is recorded as `dup_of` and not stored again;
    - a changed fingerprint raises an alert.
  - `apps/worker capture` (croner) with `capture.ts` for each adapter (A.4 names), plus a `registry/seed/*.csv` of per-station lists (RWS about 80 codes, CH forecast stations, Vigicrues key stations).
  - **Seed captures**, one-off and idempotent:
    - PEGELONLINE `P31D` for series on the relevant waters;
    - Hub'Eau 1 month for key stations;
    - Vigicrues about 2 months for key French stations;
    - hydrodaten `p_q_40days` for Swiss key stations;
    - NRW 7-day zip;
    - LU CSV 5 days.
  - Infrastructure:
    - `infra/vps/bootstrap.sh` (Debian 13: SSH keys only, nftables, unattended-upgrades, chrony, Docker 29 + Compose v5, log rotation);
    - `compose.yml` with `capture` and `backup` (restic hourly);
    - image build: sign, SBOM, provenance, GHCR;
    - `deploy.sh` with `cosign verify`, behind a forced-command SSH key.
  - Monitoring:
    - a healthchecks.io ping per provider after each successful cycle (grace 3× cadence);
    - disk (alert at 80%) and restic checks;
    - a daily capture report (per spec: attempts, successes, bytes, duplicates, failures by status).
  - Licence gating: `capture_policy` per source from the registry. Defaults are in the table below.
- **Recurring capture set:**

| Provider | Endpoints (cadence) | Policy |
|---|---|---|
| RWS | WFS `locatiesmetlaatstewaarneming` H+Q (10 min). REST `OphalenWaarnemingen` for about 80 curated locations × WATHTE/NAP and Q, `Periode` now−3 h (10 min). `verwachting` WATHTE/Q (hourly, deduped). `OphalenCatalogus` (daily). waterinfo.rws.nl `latestmeasurement` class labels (15 min, undocumented). Thresholds workbook (weekly hash) | public |
| PEGELONLINE / BfG | `stations.json?waters=RHEIN,MOSEL,SAAR,MAIN,NECKAR,LAHN,RUHR,EMS,DEK&includeCurrentMeasurement…` with ETag (15 min at hh:02/17/32/47). `measurements.json?start=PT6H` per curated series (hourly). Characteristic values + gauge zero (daily). `WV` for 7 Rhine gauges (2 h). BfG 14-day + 6-week CSVs (daily) | public (BfG publication: D4) |
| Hub'Eau / Vigicrues | `observations_tr` for `A*,B*,D*,E1*,E2*,E3*`, 3 h window, paged (15 min). `referentiel/stations` (daily). `InfoVigiCru.geojson` (30 min). `prevision.json` list + per-station forecasts (30 min, event-driven). `StaEntVigiCru` (daily). `station.json` CruesHistoriques (weekly) | public |
| BAFU | LINDAS river + lake SPARQL (**10 min, never faster**). `hydro_sensor_pq.geojson` (10 min). `q_forecast` for 55 stations (hourly). Warning-level GeoJSON (hourly). geo.admin class layers (30 min) | public |
| NRW LANUK | `messwerte.zip` and `layers/10/index.json` (15 min). OpenHygon master data (daily) | public |
| LU AGE / LU-Alert | CC0 `Water-Levels-LocalTime.csv` (15 min at :07/:22/:37/:52). data.public.lu CAP resources (5 min). pygeoapi 655 (daily). Per-station JSON, percentile forecasts and station pages | public / **off** until AGE answers (D3) |
| LHP | `data/stations` (all states) + `data/alerts` (15 min) | public |
| SPW Wallonia | Value layers 1962373 / 1962340 (10 min) | **dark** if D3, else off |
| NLWKN | Vechte / Dinkel stations (15 min) | **dark** if D3, else off |
| HIC / VMM | – (their terms require tokens for automated use) | **off** until tokens (P11) |

- **Scope out:** parsing, database, any public HTTP endpoint, Caddy.
- **Deliverables:** running recorder on the VPS; off-site archive; alerts; seed coverage report; deploy pipeline; runbook "recorder down".
- **Acceptance criteria:**
  1. The recorder has run 72 h on the VPS with ≥ 99% of scheduled captures succeeding per provider. Upstream failures are logged with their status and excluded. This soak runs while P2 starts.
  2. Fault injection works: killing `capture` mid-write leaves no partial object and the next cycle resumes; a VPS reboot resumes capture unattended.
  3. A restic restore of a 100-object sample to a temp directory reproduces identical sha256.
  4. Stopping capture beyond 3× cadence fires a healthchecks.io alert. Tested once per provider group, and the alert reaches the owner.
  5. Offline unit tests, with msw erroring on unhandled requests:
     - the client rejects a non-allowlisted host, a private IP, a cross-host redirect, an over-cap body and a gzip bomb;
     - backoff and circuit-breaker behaviour is correct under fake timers;
     - the manifest round-trips through its schema.
  6. A config test asserts the politeness budgets, and that BAFU is never scheduled more often than every 10 minutes.
  7. Deploying an unsigned image, or one signed by another identity, fails.
  8. The seed report lists the window covered per provider and series.
- **Dependencies:** P0, plus the owner's VPS, backup bucket and healthchecks account.
- **Providers / rivers:**
  - Providers: RWS, WSV/BfG, NRW LANUK, LHP, Hub'Eau, Vigicrues, BAFU, AGE / LU-Alert; SPW and NLWKN dark if D3.
  - Rivers:
    - Rhine from the Swiss Aare and upper Rhine to the NL branches;
    - Moselle, Saar and Sauer/Sûre/Our;
    - Main, Neckar, Lahn, Sieg, Ruhr and Lippe;
    - Meuse with Chiers, Semois, Sambre, Ourthe, Rur and Niers;
    - Scheldt and Lys (French side);
    - Ems, Vechte, Dinkel and Berkel.
- **Risks:**
  - Silent gaps: mitigated by dead-man checks, the daily report and fingerprints.
  - Disk filling up: caps and an 80% alert.
  - Over-polling: budget tests and a contact User-Agent.
  - Clock skew: chrony.
  - The RWS CTD move on 11-05: URLs live in config.
- **Models:**
  - Build **Opus 5.5 / xhigh**: unattended 24/7 code where every bug means unrecoverable data loss, plus the first infrastructure and deploy pipeline.
  - Code review **Fable 5.1 / `/code-review high`**: a small diff with the highest cost of failure; the most capable model independently hunts atomicity, scheduling and silent-gap bugs.
  - Security review **Opus 5.5 / xhigh**: a fresh session with only a security mandate. It audits the VPS baseline, the deploy trust chain and the outbound fetcher (SSRF, egress). Everything later relies on this, so it gets the stronger of the two non-Fable models even though that repeats the builder's model.

### P2: Data spine (canonical model, database, loader) with RWS and PEGELONLINE

- **Goal:** Turn the archive into a correct, provenance-tracked time-series store. Prove the design on two dissimilar providers:
  - RWS: POST requests per station, fixed `+01:00` timestamps, WFS timestamps that are local time labelled `Z`;
  - PEGELONLINE: GET with ETag, local offsets, a 31-day window, mixed units.
- **Scope in:**
  - `packages/core`:
    - canonical Zod types (A.2);
    - Temporal-based time-convention parsers;
    - unit table;
    - datum enum and offset table, each offset with its source and uncertainty (TAW ≈ NAP + 2.33 m; NHN ≈ NAP −0.5 to −2 cm; IGN69 ≈ NAP + 0.47 to 0.49 m; LN02 ≈ NHN + 0.32 m at Basel);
    - QC bitmask and sentinels.
  - `packages/db`:
    - dbmate migrations for the **complete** schema, including forecast, reference, class and warning tables, so later phases only add data;
    - hypertables; continuous aggregates `obs_1h` and `obs_1d` (refresh `start_offset` 40 d); columnstore compression for data older than 45 days;
    - roles `ingest_rw`, `publisher_ro`, `api_ro` (`default_transaction_read_only`, `statement_timeout 2s`) and public views;
    - Kysely codegen.
  - `packages/registry`: YAML schema and validation, DB sync, and a drift report against harvested catalogues.
  - `apps/worker load`:
    - tails the manifest → parses → QC (sentinels, timestamps more than 15 min in the future, ranges) → idempotent upsert (`ON CONFLICT … WHERE (value, qc) IS DISTINCT FROM`) that writes an `obs_revision` row → updates `obs_latest`;
    - quarantines the payload on schema drift and alerts, while capture continues;
    - `replay` CLI with filters for provider, spec and date range.
  - Adapter `nl-rws` (observations):
    - H: WATHTE/NAP/`meting` with method F007;
    - Q with per-station method codes;
    - quality code 99 is a gap;
    - TAW/MSL/PLAATSLR duplicates are dropped, except TAW kept as a twin at Eijsden;
    - REST wins over WFS;
    - stale "latest" series are filtered out.
  - Adapter `de-wsv` (W and Q):
    - units `cm`, `m+NN`, `m+PNP`;
    - sentinel `99999`;
    - RWS, Swiss and Ruhrverband mirrors marked `mirror` and not published;
    - 1-minute series stored natively.
  - Golden fixtures taken from the P1 archive (including 2026-10-25 if P2 lands after it; otherwise synthetic, then refreshed).
  - Deploy `db` + `migrate` + `load`, and replay everything captured since P1.
- **Scope out:** other providers; references, classes and forecasts (their tables exist but stay empty); API, publisher, UI.
- **Deliverables:** core, db, registry and loader packages; 2 adapters; registry entries for NL and German federal key stations; production DB filled since P1; runbook for the Timescale extension upgrade.
- **Acceptance criteria:**
  1. Replaying the full archive twice gives an identical `obs` checksum (`md5(string_agg(...))` per partition) and zero spurious revisions.
  2. Golden tests: every fixture's parse + normalise output equals its committed `.golden.json`. Property tests cover time parsers (round-trip, DST gap and overlap) and unit conversions.
  3. Known-instant tests:
     - RWS `2026-09-23T20:50:00.000+01:00` → 19:50Z;
     - WFS "Z" local time → correct UTC in both summer and winter;
     - PEGELONLINE `+02:00` / `+01:00` → UTC.
  4. Twin check: RWS Eijsden-grens TAW − NAP = 233 ± 1 cm for every aligned timestamp in the last 7 days.
  5. RWS quality-99 `0.0` values and PEGELONLINE `99999` never appear as values.
  6. Integration tests (testcontainers, image `2.30.1-pg18`):
     - migrations run from an empty DB;
     - continuous aggregates refresh and the compression job runs;
     - `api_ro` cannot write and cannot see non-public rows.
  7. Production: loader lag p95 < 2 min; the "every series at time T" query takes < 50 ms.
  8. Drift simulation: a mutated payload is quarantined and alerts, capture continues, and a replay after the fix loads it.
- **Dependencies:** P1.
- **Providers / rivers:**
  - Providers: RWS, PEGELONLINE.
  - Rivers:
    - Rhine from Maxau to Lobith, then Waal, Pannerdensch Kanaal, Nederrijn-Lek and IJssel;
    - federal Moselle, Saar, Main, Neckar, Lahn and Ruhr, and the Ems;
    - Dutch Meuse from Eijsden to Keizersveer;
    - Overijsselse Vecht and Geul;
    - NL delta stations flagged as tidal.
- **Risks:**
  - Model mistakes propagate everywhere: mitigated by Fable with `/plan`, an Opus `max` review, and the ability to replay.
  - Compressed-chunk revisions: compress only data older than 45 days.
  - Extension upgrades: runbook.
- **Models:**
  - Build **Fable 5.1 / xhigh**, starting in `/plan`: the hardest and most consequential design (canonical model, time/unit/datum semantics, idempotency and revisions). Errors silently corrupt the only archive of go-live data.
  - Code review **Opus 5.5 / `/code-review max`**: an independent model, at max effort because correct normalisation outweighs cost.
  - Security review **Sonnet 5 / xhigh**: mostly internal surface (DB roles, parameterised SQL, parser resource limits) with well-known checks.

### P3: Observation adapters, wave 2 (open sources)

- **Goal:** Parse the archive for every remaining open-licence observation source, and resolve mirrors and duplicates so that each physical gauge is published once.
- **Scope in:**
  - `fr-hubeau`:
    - H in mm → cm, Q in l/s → m³/s;
    - `206` pages;
    - drop `code_station: null` site-level Q;
    - Swiss, German and Belgian mirrors set as twins or mirrors;
    - negative Q allowed but flagged.
  - `ch-bafu`:
    - LINDAS CSV with fixed `+01:00`;
    - W in m ü. M. (LN02) with `value_kind=level`, and relative gauges detected;
    - duplicate observations per station resolved by latest time;
    - hydrodaten as secondary and twin.
  - `de-nw-lanuk`:
    - ZIP with count, size and path caps;
    - fixed `+01:00`;
    - placeholder IDs;
    - W only.
  - `lu-age` (CSV):
    - wide table;
    - naive `Europe/Luxembourg` local time with DST;
    - the **label offset auto-detected daily** against the Perl twin in PEGELONLINE;
    - mixed units (Esch-Sûre reservoir in m);
    - stations matched by name to pygeoapi.
  - Registry expansion: tier-1 curation, with tier 2 created automatically from catalogues. Precedence rules:
    - WSV gauges come from PEGELONLINE;
    - Perl and Stadtbredimus come from PEGELONLINE, with the AGE copies as twins;
    - NL gauges come from RWS;
    - PEGELONLINE's RWS mirrors are ignored.
  - `twin-check` job: compares the last 24 h, estimates lag by cross-correlation, and alerts on any offset or lag ≠ 0.
  - QC for range, spike, and flatline-with-neighbour.
- **Scope out:** references and classes (P4), forecasts (P5), gated sources (P11).
- **Deliverables:** 4 adapters; registry; twin checks; replay since P1.
- **Acceptance criteria:**
  1. Each adapter has ≥ 3 real fixtures (normal; edge case such as DST, sentinel or missing data; empty or error) with golden outputs, and ≥ 90% line coverage of parse and normalise.
  2. Hub'Eau vs the Vigicrues twin: Chooz |ΔH| ≤ 1 cm, and Uckange Q equal after unit conversion.
  3. LU: the detected label offset is reported. After correction, Perl AGE equals Perl PEGELONLINE for ≥ 99% of timestamps.
  4. NRW zip-bomb and zip-slip fixtures are rejected.
  5. A registry test shows no physical gauge published twice. `source_health` is green for all open providers after the replay.
- **Dependencies:** P2.
- **Providers / rivers:**
  - Hub'Eau: French Meuse, Chiers, Semois, Sambre, Moselle, Meurthe, Sarre, Alsace Rhine, Escaut, Scarpe and Lys.
  - BAFU: Rhine, Aare, Reuss, Limmat, Thur, Birs and Lake Constance (Bodensee).
  - LANUK: Rur, Wurm, Niers, Schwalm, Berkel, Issel, Bocholter Aa, Dinkel, upper Vechte and Ems, Lippe, Sieg and Erft.
  - AGE: Moselle, Sûre, Our and Alzette.
- **Risks:**
  - Naive local time at DST, and the silent LU label fix: handled by twins.
  - The hydrodaten endpoint is undocumented: LINDAS is primary.
  - ZIP and CSV brittleness: fingerprints and quarantine.
- **Models:**
  - Build **Opus 5.5 / xhigh**: four dissimilar formats (paged JSON, SPARQL CSV, zipped CSV, wide local-time CSV), each with a silent-corruption trap.
  - Code review **Sonnet 5 / `/code-review xhigh`**: P2 fixes the contract and golden pattern, so this review checks conformance against the catalogue's pitfall list.
  - Security review **Sonnet 5 / xhigh**: new untrusted-input parsers (ZIP extraction, CSV, SPARQL responses) and zip-slip / bomb / resource-exhaustion checks, driven by a checklist.

### P4: References, thresholds, provider classes, warnings and honest classification

- **Goal:** Every published value carries an honestly derived state and a visible `basis`. Operational thresholds, statistical references, and provider-issued classes and warnings from all open sources are stored with validity ranges.
- **Scope in:**
  - Parsers:
    - PEGELONLINE characteristic values (MNW, MW, MHW, NNW, HHW, HSW, GlW, Marke I–III with timespans) and gauge zero (`validFrom`);
    - the RWS thresholds workbook, converted offline by a pinned `tools/` script to `registry/thresholds/nl-rws.csv` with the source sha256 (the weekly capture detects new versions), plus waterinfo labels as `class_obs`;
    - BAFU `wl_1…wl_4` (discharge-based, m³/s), LINDAS `dangerLevel` and the geo.admin percentile class;
    - Vigicrues tronçon vigilance, mapped to stations via `StaEntVigiCru`, plus `CruesHistoriques` as historical reference lines;
    - LANUK thresholds from `layers/10` (semantics verified);
    - LHP classes as an overlay for other German states (classes only, no values);
    - LU-Alert CAP zones (Nord / Sud / Moselle; `TEST` dropped; `ALERT_LVL_1…4` mapped);
    - gauge zeros from Hub'Eau, NRW and LU where available.
  - **Classification engine**, a pure function in `core`:
    - ordinal scale `no_ref < low < normal < elevated < high < extreme`, with flags `stale`, `suspect`, `tidal` and `impounded`;
    - priority: operational thresholds > statistical references > provider class;
    - `docs/classification.md` is **generated from the same mapping table the code uses**;
    - Δh since window start, and trend (rising / falling / steady);
    - an "≈ m NAP" conversion for the detail view only, shown with its uncertainty.
  - A `warning` table for areas: geometry, level normalised 1–5, and the raw code.
- **Scope out:** forecasts; thresholds from gated providers (HIC, VMM, SPW, and AGE station pages come in P11).
- **Deliverables:** parsers; classification engine and matrix doc; coverage report.
- **Acceptance criteria:**
  1. CI fails if `docs/classification.md` differs from the code table.
  2. Table-driven tests per provider. Example: Kaub 9 cm with MNW 65 → `low`, basis "WSV MNW 2010–2020". A station without references → `no_ref`, never a guess.
  3. The reference enum represents exceedance percentiles (HIC-style) and non-exceedance percentiles (SPW-style) explicitly.
  4. A changed threshold or gauge zero creates a new validity range (`WITHOUT OVERLAPS`), never an overwrite, and raises an alert.
  5. LU-Alert `TEST` fixtures are excluded. Vigicrues section levels reach every station in the section.
  6. A published coverage report gives, per country, the share of tier-1 stations that have a class other than `no_ref`. Honesty is shown in numbers.
- **Dependencies:** P3.
- **Providers / rivers:** WSV, RWS, BAFU, Vigicrues, LANUK, LHP and LU-Alert, across all rivers from P2 and P3.
- **Risks:**
  - Semantic misreadings (percentile conventions, "Marke", discharge-based thresholds): mitigated by a Fable review.
  - Changes to the RWS workbook: hash watch.
- **Models:**
  - Build **Opus 5.5 / xhigh**, starting in `/plan` and writing the matrix first: careful semantic mapping across seven providers.
  - Code review **Fable 5.1 / `/code-review xhigh`**: honest cross-country comparison is the product's credibility, so the strongest independent model challenges every mapping.
  - Security review **Sonnet 5 / high**: little new surface (XML CAP parsing with XXE and entity expansion, the offline xlsx script).

### P5: Official forecasts (bi-temporal)

- **Goal:** Load every forecast run captured since P1 as an immutable bi-temporal run, and expose the latest run per series for the future part of the time selector.
- **Scope in:**
  - Adapters and run-identity rules:

    | Source | Run identity and quirks |
    |---|---|
    | RWS `verwachting` | No run id: run = (series, first valid time, content hash) |
    | PEGELONLINE `WV` | `initialized` time; values beyond 48 h flagged `estimate` |
    | BfG 14-day quantiles | Daily means; GMT+1; start-of-interval stamps; `---` = censored above 640 cm. Publication is D4 |
    | BAFU `q_forecast` | Median, 25–75 % band, min/max; run inferred |
    | Vigicrues | P10/P50/P90 with `DtProdSimul`. HTTP 200 bodies can carry an error. The v1.1 route uses `+02:00`, the legacy route `+00:00` |
    | AGE percentiles (gated) | `below_floor` flag at the Moselle floors of 250 / 260 / 220 cm |

  - A "latest run issued ≤ t" query.
  - QC: quantiles must be monotone; horizon sanity checks.
  - Display rules in `contracts`:
    - never blend providers;
    - always show the issuing agency and issue time (or "fetched" time when inferred);
    - the slider reaches +48 h;
    - provider display limits are respected (AGE `forecastsLimit`).
- **Scope out:** forecast verification statistics; producing our own forecasts (never).
- **Deliverables:** forecast adapters; run history since P1; contract types.
- **Acceptance criteria:**
  1. Replay rebuilds the run history since P1 with no duplicates: the run count equals the number of unique content hashes per series.
  2. PEGELONLINE `WV` values beyond 48 h are flagged `estimate`. BfG `---` is stored as censored, not as zero.
  3. Vigicrues v1.1 (`+02:00`) and legacy (`+00:00`) payloads for the same run give identical UTC values.
  4. The LU Perl fixture (p10 = p50 = p90 = 250) is flagged `below_floor`.
  5. "Latest run as of T" returns in < 50 ms across all forecast series.
- **Dependencies:** P4, and the P1 captures.
- **Providers / rivers:**
  - RWS: Lobith, NL branches, Eijsden and the Meuse.
  - WSV / BfG: 7 Rhine gauges.
  - BAFU: 55 stations covering the Rhine and Aare.
  - Vigicrues: French stations during events.
  - AGE (gated): Sûre, Alzette and Moselle.
- **Risks:**
  - Inferred run identity could merge or split runs: key on hash plus first valid time, and test with fixtures.
  - Forecasts only during events: this is shown honestly in the UI.
- **Models:**
  - Build **Opus 5.5 / xhigh**: six formats with implicit run identity and mixed time conventions.
  - Code review **Fable 5.1 / `/code-review high`**: a shifted or mislabelled forecast misleads the public exactly during a flood, so the bi-temporal semantics get the strongest independent check.
  - Security review **Sonnet 5 / high**: this phase only adds parsers, with well-known checks.

### P6: Publishing layer and read API

- **Goal:** A flood spike costs almost no application CPU. Precomputed static files serve the hot paths, and a small, bounded Hono API serves the rest.
- **Scope in:**
  - `apps/worker publish`:
    - dirty-bucket tracking from the loader;
    - writes the A.5 files, precompressed (zstd + gzip), atomically;
    - covers the `recent` / `settled` split, frames, per-station recent files, warnings, and `sources.json` (attribution in NL/EN with last-update times, as Vigicrues, HIC and LHP require).
  - `apps/api`:
    - Hono with zod-openapi;
    - strict validation (`t` quantised to 10 min; span limits per resolution; ≤ 50 ids; ≤ 20k points);
    - per-IP token bucket behind the trusted proxy;
    - LRU cache and ETag;
    - reads `api_ro` public views only.
  - Caddy:
    - TLS, HSTS, security headers, baseline CSP;
    - precompressed `file_server` with cache classes per path;
    - range requests for `/tiles/*`;
    - `/api` reverse proxy with timeouts and body limit;
    - JSON access logs;
    - a placeholder landing page.
  - `contracts` published as JSON Schema; `schemaVersion` on every file.
- **Scope out:** the UI.
- **Deliverables:** publisher; API with OpenAPI; Caddy image; compose services; cache policy doc.
- **Acceptance criteria:**
  1. Every published file validates against its schema, and the OpenAPI document is snapshot-tested.
  2. **Dark-data leak test:** a dark series seeded with a canary value never appears in any file or API response. The test greps all outputs.
  3. Malformed or oversized inputs return 400 without any DB query (spy). Over-rate requests return 429 with `Retry-After`.
  4. Property test: for 200 random values of T, the snapshot file equals the reference SQL at-time-T result.
  5. `latest.json` age is < 2 min after a loader commit. Re-rendering one day takes < 60 s.
  6. k6 smoke on 4 vCPU: 300 req/s static + 30 req/s API for 2 min, p95 < 200 ms, 0 errors.
- **Dependencies:** P4 (classes). P5 can be stubbed at first.
- **Providers / rivers:** all public sources.
- **Risks:**
  - Stale caches after revisions: settled files revalidate daily via ETag.
  - Dark-data leakage: DB views plus the canary test.
  - Cache-key explosion: quantisation.
- **Models:**
  - Build **Opus 5.5 / xhigh**: performance-critical publishing with cache semantics and strict contracts.
  - Code review **Sonnet 5 / `/code-review xhigh`**: HTTP and API patterns are well known; the review verifies the contract tests and quantisation.
  - Security review **Fable 5.1 / xhigh**: the first internet-facing surface. It covers input validation, DoS through expensive queries, cache poisoning, headers and CSP, and dark-data leakage.

### P7: River network, station snapping and basemap (parallel lane)

- **Goal:** A directed river graph with bifurcations for every NL-bound river; stations snapped with chainage; self-hosted basemap and river overlay.
- **Scope in:**
  - `tools/rivernet` (Python/uv container) builds from Geofabrik PBFs using a curated list of OSM relations: Rhein 123924, Meuse 1075197, Escaut 324288, Moselle 390416, Ems 370068, Main 412876, Neckar 123881, Sambre 1600647, Ourthe 2246211, Rur 384594, Lahn 412935, Saar 390393, Sieg 409090, Ruhr 364754, Lippe 379691, plus Aare, Sûre, Our, Alzette, Lys/Leie, Dender, Niers, Vecht/Vechte, Dinkel, Berkel, Waal, Nederrijn-Lek and IJssel. Wikidata ambiguities for Nahe and Lys are resolved by hand.
  - Graph construction:
    - a DAG with a cycle check;
    - bifurcations at Pannerdensche Kop and IJsselkop;
    - simplification per zoom level, keeping the unsimplified geometry for snapping;
    - EU-Hydro direction QA report.
  - Snapping uses **water-body name plus distance** (canal traps: Juliana, Albert, Bijlandsch Kanaal, Grand Canal d'Alsace), with a manual override table.
  - Chainage comes from the official km (PEGELONLINE `km`, RWS rkm, others where published). Otherwise it is the graph distance to an NL entry node: Lobith, Eijsden, the Scheldt border, Dollard, or the Vecht border.
  - Segment flags: tidal and impounded.
  - Travel-time priors are stored as **indicative** data only (RWS 1985, IKSR Basel→Maxau).
  - Outputs, under ODbL: `rivers.pmtiles` (tippecanoe), `river_graph.json`, and `station_snap.csv` → registry.
  - `tools/basemap`:
    - Protomaps extract (bbox and zooms as in A.1) run on the VPS;
    - muted style with self-hosted glyphs and sprites;
    - OpenFreeMap fallback config;
    - quarterly refresh runbook.
- **Scope out:** animation (P9), deck.gl.
- **Deliverables:** pipeline container; versioned artifacts (published as release assets); registry river fields; ODbL download page text; basemap on the VPS.
- **Acceptance criteria:**
  1. The graph has no cycles. Every tier-1 station has a (river, km) and a downstream path to an NL entry node. Basel → Lobith → {Waal, Nederrijn-Lek, IJssel} is traversable.
  2. At least 98% of edge directions agree with EU-Hydro, and every disagreement is listed. Canal-trap fixtures produce zero name-mismatched snaps.
  3. Ordering by km is monotone upstream → downstream for the Rhine (Konstanz → Lobith), Meuse (Chooz → Keizersveer) and Moselle (Uckange → Koblenz) chains.
  4. The same PBF date gives byte-identical outputs.
  5. Basemap + rivers render at z4–14 in 5 Playwright screenshot viewports with no missing tiles and with the attribution visible. Compatibility of `@protomaps/basemaps` 5.7.2 with v4 tiles is verified [U].
- **Dependencies:** P2 registry. Runs in parallel with P3–P6.
- **Providers / rivers:** OSM (ODbL), EU-Hydro (QA), Protomaps; official km from WSV and RWS. All rivers.
- **Risks:**
  - ODbL share-alike: the graph is published as ODbL.
  - Inconsistent OSM roles (Moselle, Escaut): cleanup rules plus overrides.
  - Protomaps keeps builds for only about a week: we keep our own extract.
  - Tidal and impounded reaches are flagged.
- **Models:**
  - Build **Opus 5.5 / xhigh**: topology with bifurcations and canal-aware snapping is subtle geo work.
  - Code review **Sonnet 5 / `/code-review high`**: the QA report and graph tests assert correctness; the review checks the tests and the overrides.
  - Security review **Sonnet 5 / medium**: an offline tool with no runtime surface. It checks pinning, the container, and licence and attribution compliance.

### P8: Web app MVP (map, date/time selector, station detail, NL/EN)

- **Goal:** A public-grade, bilingual SPA:
  - a map with classified stations, rivers and warning areas;
  - a date/time selector from the start of the archive to +48 h;
  - a station panel with a hydrograph, thresholds, forecast and provenance.
- **Scope in:**
  - Stack as in A.1.
  - URL state `?t=<UTC>&s=<station>&mode=state|delta|q&v=<view>`.
  - The selector shows Europe/Amsterdam time with a CET/CEST label. The repeated hour on 2026-10-25 can be selected.
  - Modes: State (default), Δh change, and Discharge. The legend carries the honesty note: "classes follow each agency's own references; not strictly equivalent".
  - Styling for stale, suspect, tidal and impounded.
  - ECharts hydrograph: thresholds, alert bands, forecast band labelled with agency and issue time, raw value as published with unit and datum, and "≈ m NAP" with ±.
  - A table view for devices without WebGL2 and for accessibility.
  - A sources and attribution page generated from `sources.json`.
  - A disclaimer linking to the official services: RWS/waterinfo, Vigicrues, naturgefahren.ch, inondations.lu, hochwasserzentralen.de, waterinfo.be and hydrometrie.wallonie.be.
  - About and method pages in NL/EN, and a privacy note (no cookies, no trackers).
  - `prefers-reduced-motion`, a keyboard-operable slider, and a colour-blind-safe diverging palette.
- **Scope out:** flow animation and the Hovmöller panel (P9); accounts; notifications.
- **Deliverables:** SPA baked into the Caddy image; e2e suite; i18n catalogues.
- **Acceptance criteria:**
  1. Playwright in Chromium, WebKit and Firefox:
     - `/` opens in NL;
     - switching to EN keeps `t` and `s`;
     - a deep link reproduces the view;
     - past and future selection work;
     - forecasts appear only where published, and are labelled.
  2. CI fails on a missing `nl` or `en` key or on a hard-coded UI string.
  3. With WebGL disabled, the table view renders.
  4. axe finds 0 serious violations on the main views, and the app can be operated by keyboard alone.
  5. Initial JS ≤ 250 KB gzip excluding the lazily loaded MapLibre chunk. LCP < 2.5 s on throttled 4G.
  6. Fixture provider strings containing `<img onerror>` render inert: no `innerHTML` / `setHTML` with provider data.
  7. On 2026-10-25, 02:30 CEST and 02:30 CET are distinct selectable instants.
- **Dependencies:** P6 contracts (the web work can start against fixture files once the schemas are frozen), P7 tiles.
- **Providers / rivers:** all public sources.
- **Risks:**
  - MapLibre 6, Vite 8 and Vitest 5 are newer than most model knowledge: CLAUDE.md gotchas, pinned versions and tests.
  - Safari lacks Temporal: polyfill.
  - Bundle size: lazy chunks.
- **Models:**
  - Build **Opus 5.5 / xhigh**, starting in `/plan`: the largest UI surface, on new major versions where agent knowledge is thin.
  - Code review **Sonnet 5 / `/code-review xhigh`**: React, i18n and a11y patterns are well known; an independent, cheaper reviewer.
  - Security review **Sonnet 5 / xhigh**: CSP compatibility, DOM XSS from provider strings, URL-parameter injection; checklist-driven.

### P9: "Follow the water" flow visualisation

- **Goal:** A visitor can **see** water flowing from the supplying rivers into the Netherlands. This is in the first release.
- **Scope in:**
  - River segments between snapped stations, coloured by interpolated state or Δh. An optional time shift uses the indicative travel time and is labelled as such.
  - Flow-direction animation with an animated dash:
    - 20–30 fps cap;
    - pauses when the tab is hidden;
    - off when `prefers-reduced-motion` is set.
  - Playback of hourly frames over a chosen window.
  - An upstream-chain panel per station: upstream stations with their state and a typical travel-time **range**, never an ETA.
  - A space-time (Hovmöller) panel for the Rhine (Basel → Lobith → branches) and the Meuse (Chooz → Keizersveer).
  - Tidal reaches are hatched and excluded from interpolation. Impounded reaches use Q where it exists.
- **Scope out:** deck.gl and WebGL shaders, crest tracking, empirical travel-time calibration (after launch).
- **Acceptance criteria:**
  1. Playing back 7 days of hourly frames runs at ≥ 20 fps on a mid-range mobile profile, and uses near-zero CPU when the tab is hidden.
  2. The Hovmöller km axis runs upstream → downstream, as in the registry.
  3. No numeric ETA appears anywhere. All travel-time text carries "indicatief / indicative".
  4. Tidal fixtures (Scheldt, Ems) never receive interpolated colours.
  5. Visual regression passes for 3 scenes: the real low water of Aug–Sep 2026 from our archive, a synthetic flood, and the DST night.
- **Dependencies:** P7, P8.
- **Providers / rivers:**
  - Rhine with Aare, Neckar, Main, Moselle/Saar/Sauer, Lahn, Sieg, Ruhr and Lippe;
  - the NL branches;
  - Meuse with Chiers, Semois, Sambre, Ourthe, Rur and Niers;
  - Scheldt and Lys (tidal rules);
  - Ems and Vecht.
- **Risks:**
  - Visuals implying precision: honest labels and priors shown as ranges.
  - Mobile battery: throttling.
- **Models:**
  - Build **Opus 5.5 / xhigh**: new visual and geo logic on MapLibre 6 under performance constraints.
  - Code review **Sonnet 5 / `/code-review xhigh`**: verifies interpolation against the registry, the performance guards and the honesty labels.
  - Security review **Sonnet 5 / medium**: client-side rendering of already-public data, with minimal new surface.

### P10: Flood hardening, operations and public launch

- **Goal:** The site survives a flood-day spike, data keeps flowing under load, and failures page the owner.
- **Scope in:**
  - k6 load test at about 20× normal peak.
  - Tuning: DB pool sizes, statement timeouts, publisher cadence, OS limits.
  - "Flood mode" flags: longer TTLs, and long API ranges disabled.
  - Alerting:
    - per-source freshness thresholds → healthchecks.io;
    - an external uptime check from a scheduled GitHub workflow;
    - disk, backup and certificate checks;
    - the client-error beacon.
  - Backups: nightly `pg_dump` plus restic, with retention. An **automated monthly restore drill** restores into a scratch container, verifies checksums against production, and runs a 1-day rebuild-by-replay test.
  - Runbooks:
    - provider outage, schema drift, disk full;
    - **VPS rebuild from scratch (RTO ≤ 4 h)**;
    - token rotation, PMTiles refresh, Timescale upgrade;
    - flood mode, DST check.
  - A final pass on CSP and headers, plus a script that asserts container hardening.
  - Privacy note; launch checklist.
- **Scope out:** new features.
- **Acceptance criteria:**
  1. Load test: 1,000 req/s static (including PMTiles range requests) + 50 req/s API for 15 min gives p95 < 300 ms and errors < 0.1%, while loader lag p95 stays < 2 min.
  2. Chaos tests:
     - with `api` killed, the map still works from static files;
     - with the DB stopped for 10 min, capture continues and the backlog loads without loss;
     - with a provider blackholed, the stale styling and the alert both fire.
  3. A rebuild drill from repo plus backups completes in ≤ 4 h, measured. The post-restore gap is 0 for sources with windows of 7 days or more.
  4. Every alert is tested end-to-end and reaches the owner.
  5. The headers scan passes, the CSP has no `'unsafe-inline'` scripts, and the `docker inspect` hardening assertions pass.
  6. The owner signs the launch checklist.
- **Dependencies:** P6, P8, P9 (and P11 wherever permissions have arrived).
- **Models:**
  - Build **Opus 5.5 / xhigh**: cross-cutting operations work whose mistakes only surface under stress.
  - Code review **Sonnet 5 / `/code-review high`**: infrastructure config and runbooks are well-patterned.
  - Security review **Fable 5.1 / xhigh**: the full-system audit before launch, covering everything that becomes public. This is the review with the widest blast radius if something is missed.

### P11: Gated sources (as permissions and tokens arrive; may be before launch)

- **Goal:** Complete coverage of Scheldt, Meuse and Vechte, and of Luxembourg forecasts and thresholds, from providers that require tokens or written consent.
- **Scope in:**
  - `packages/kiwis` (KiWIS 1.11.x):
    - value layers;
    - `getTimeseriesValues` with batches of ≤ 100 ts_ids, `period=`, `timezone=UTC`;
    - timeouts of 60–120 s;
    - metadata cached daily, and no wildcard listings on the hot path;
    - token auth.
  - `be-hic`:
    - non-tidal value layer;
    - tidal W fetched via values, because the value layer returns null for tidal series;
    - TAW datum and quality codes;
    - prewaak / waak / alarm thresholds;
    - attribution including the retrieval date.
  - `be-vmm`: absolute values, `datasource=1`, thresholds where present.
  - `be-spw`:
    - value layers and QADM;
    - weir-controlled stages;
    - non-exceedance percentiles.
  - `de-ni-nlwkn`: `DatumUTC` only.
  - `lu-age` full: per-station JSON, weekly station-page thresholds, and p10–p90 forecasts.
  - BfG forecast publication, once D4 is settled.
  - Optionally HLNUG (Lahn, Kinzig) and RLP (Nahe) if they grant consent.
  - A registry `publication` flip requires a `registry/permissions/<source>.md` record, checked in CI.
  - A documented purge procedure for data whose permission is refused.
- **Acceptance criteria:**
  1. Every adapter meets the P3 fixture standard. Tokens come only from Compose secrets and never appear in logs (redaction test).
  2. CI blocks a `publication: public` entry that has no permission record.
  3. Twins: RWS Maaseik (NAP) vs HIC Maaseik (TAW) = 2.33 m ± 2 cm, and RWS Eijsden is consistent with the nearest HIC and SPW gauges.
  4. On a flip, dark history captured since P1 appears on the time slider after replay.
  5. HIC tidal stations are styled as tidal. SPW regulated reaches show Q.
- **Dependencies:** the P3–P5 patterns and the owner's permissions.
- **Providers / rivers:**
  - Flanders: Zeeschelde tidal chain, Leie, Bovenschelde, Dender, Demer, Dijle, Nete and Grensmaas.
  - Wallonia: Meuse from Chooz to Lixhe, Sambre, Ourthe, Vesdre, Amblève, Semois and Escaut.
  - Niedersachsen: Vechte and Dinkel.
  - Luxembourg: forecasts and thresholds.
- **Risks:**
  - Refusal or conditions: covered by the dark / off policy and the purge procedure.
  - Slow or changing KiWIS instances: resolve by `ts_path` at startup, and use long timeouts.
- **Models:**
  - Build **Opus 5.5 / high**: P2–P5 already set the pattern, but the KiWIS quirks (tidal nulls, TAW, datasource IDs, quality codes) and auth still need care. High effort suffices given the template.
  - Code review **Sonnet 5 / `/code-review xhigh`**: checks conformance to the established contract and the pitfall checklist.
  - Security review **Sonnet 5 / xhigh**: the first real third-party credentials in the system (secret storage, log redaction, token scope).

### P12: LATER — historical backfill (separate phase, after launch)

- **Goal:** Extend the history backwards for context and our own percentile climatology, without ever compromising the data captured since go-live.
- **Scope in:**
  - **pg-boss 12.34** queue with per-provider rate limits, resumable and idempotent jobs.
  - Sources:
    - RWS REST (≤ 160k values per request, chunks ≤ 2.5 years, 1 req/s, off-peak);
    - NRW opengeodata `hydro` (decades; resample the irregular timestamps);
    - HIC, VMM and SPW KiWIS (250k values per call; with permission);
    - Hub'Eau `obs_elab` (daily);
    - a BAFU Datenservice order (resolve the UTC vs UTC+1 question first);
    - data.bs.ch Basel 2020+;
    - the AGE archive on request;
    - the PEGELONLINE history form **only with ITZBund's permission**;
    - HLNUG `year.json`.
  - Rows are marked `origin=backfill` with provider quality.
  - Precedence: live-captured rows change only through provider-validated values, via `obs_revision`.
  - Day-of-year percentile climatology as a new statistical reference kind.
  - Compression and retention tuned.
- **Acceptance criteria:**
  1. A test proves backfill never alters a live row unless the provider-validated flag is set, and every such change is in `obs_revision`.
  2. Kill/restart resumes with no duplicates, and the per-provider rate budget holds.
  3. Percentile classes are enabled only for stations with ≥ N years of data, and are documented in the classification matrix.
  4. The restore drill still completes in ≤ 4 h, and the DB stays within its size budget.
- **Models:**
  - Build **Opus 5.5 / xhigh**: long-running, rate-limited, resumable jobs across many providers.
  - Code review **Fable 5.1 / `/code-review high`**: bulk writes land next to the only copy of go-live data, so the strongest independent reviewer guards the precedence and revision rules.
  - Security review **Sonnet 5 / high**: bulk-download credentials and politeness, with well-known checks.

---

## C. Cross-cutting risks and mitigations

| # | Risk | Impact | Mitigation (phase) |
|---|---|---|---|
| 1 | **Data lost before or while the pipeline is built.** Forecasts, classes, LINDAS values and LU are perishable | Irreversible | Recorder live ≤ 10-02 (P1); seeds of the provider windows; off-site archive hourly; dead-man switch per provider; DB rebuildable by replay (P2) |
| 2 | **Upstream drift or outage.** Examples: the RWS API is young and had a week-long stall in June 2026; Vigicrues is beta; hydrodaten and waterinfo.rws are undocumented; the LU site was relaunched; the RWS docs move to CTD on 11-05 | Gaps, crashes | Adapter isolation; strict Zod; quarantine and replay; shape fingerprints; nightly contract canary; fallback feeds per reach (REST↔WFS, LINDAS↔hydrodaten, Hub'Eau↔Vigicrues); URLs in config (P1–P3) |
| 3 | **Silent semantic corruption** (time conventions, DST, units mm/cm/m/l/s, datums, sentinels, the LU CSV 15-min label bug) | Wrong data that looks plausible | Declared per-adapter conventions; golden fixtures from real payloads including the real DST night; property tests; **twin checks** with lag estimation; units declared per series, never inferred (P2–P3) |
| 4 | **Misleading cross-country comparison** | Loss of credibility; false reassurance in a flood | Ordinal classes carry a `basis`; the matrix is generated from code and reviewed by Fable; `no_ref` is never guessed; no absolute cross-border comparison; Δh and Q modes; legend honesty note; no ETAs; links to official warning services (P4, P8, P9) |
| 5 | **Licences and permissions** (SPW forbids redistribution; HIC "non-commercial", TYPE 3 agreement; VMM and HIC tokens; NLWKN Impressum; AGE site terms; BfG Belegexemplar) | Blocked coverage; legal exposure | Requests sent on day 1 (P0); `publication` policy lives in data; web roles see public views only; dark-leak canary test (P6); CI requires a permission record; purge procedure; the launch does not depend on gated sources (P11) |
| 6 | **Flood traffic spike** | Outage exactly when the site matters | Static-first publisher; precompressed files; self-hosted PMTiles; the API is bounded, quantised, rate-limited and read-only with a 2 s timeout; serving isolated from ingest; 20× load test; flood mode (P6, P10) |
| 7 | **Single VPS lost** | Downtime, data gap | Off-site raw archive and dumps; bootstrap script; tested rebuild in ≤ 4 h; provider windows refill the gap (P1, P10) |
| 8 | **Supply-chain compromise** (the 2026 npm worm, the Trivy tag hijack) | Code execution in CI or production | 7-day release age; `allowBuilds`; SHA-pinned actions; zizmor; Grype/Syft; cosign-verified deploys; distroless non-root read-only containers; few frontend dependencies (P0, P1) |
| 9 | **Agent knowledge gaps** (TS 7, MapLibre 6, Vite 8, Vitest 5, the PG18 image path, Compose v5) | Subtle bugs, churn | CLAUDE.md BOM with gotchas; `check-bom`; exact pins; strict types; each review by a different model; `/plan` on the big phases (P0 onward) |
| 10 | **Being blocked by providers for impoliteness** | Loss of a source | Budgets tested in config; ETag; staggering; contact User-Agent; BAFU ≥ 10 min; RWS servicedesk informed; circuit breakers (P1) |
| 11 | **Stale, broken, tidal or impounded gauges shown as current or meaningful** | Misleading map | Staleness rule `max(3×step, 45 min)`, removed from the map after 25 h; registry flags; tidal reaches hatched; Q preferred on weir-controlled reaches (P3, P4, P9) |
| 12 | **Timescale lock-in or upgrade friction** | Ops burden | Plain SQL migrations; aggregates are derived and rebuildable; an upgrade runbook; the raw archive stays engine-neutral (P2, P10) |
| 13 | **Visualisation scope creep** (deck.gl, shaders) | Delays launch | MVP uses MapLibre only; deck.gl and crest tracking are explicitly after launch (P9) |
| 14 | **Legacy code temptation** | Hidden coupling to old assumptions | Tag `legacy-v0`; blob-level fresh-start check; CLAUDE.md rule (P0) |

---

## D. Owner decisions and actions needed now

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Will the site be commercial (ads, paid tiers)? This affects HIC, SPW, NLWKN and GKD | Non-commercial; say so in every permission request |
| D2 | Domain and contact mailbox, needed for the User-Agent and the permission emails | Decide in P0 |
| D3 | May sources awaiting consent be captured **dark** (stored, never published, purged if refused)? | **Yes for SPW and NLWKN.** Their terms restrict redistribution and publication, not retrieval. **No for AGE's per-station JSON, forecasts and thresholds** until AGE replies (the site terms restrict reproduction; the CC0 CSV covers observations). HIC and VMM stay **off** until tokens arrive |
| D4 | Publish BfG forecasts? This requires the BfG credit and a free copy of the publication (Belegexemplar), which for a website means sending the URL | Yes, notify BfG. `WV` values are captured in any case |
| D5 | Off-site backup target | An EU S3-compatible bucket, restic-encrypted |
| D6 | Public API status | Open, rate-limited, "no SLA, unofficial". Documented but not promoted |
| D7 | Repo visibility | Public enables free CodeQL and matches the open-data spirit. Private is fine; CodeQL is then skipped |

**Traceability to the product requirements:**

| Requirement | Where it is covered |
|---|---|
| Map with OSM-based self-hosted tiles | P7, P8 |
| NL, DE, BE, FR, LU and CH sources | P1–P3, P11 |
| Seeing water flow into the Netherlands | P9 |
| Date/time selector including the near future | P5, P8 |
| Water level, discharge, forecasts, thresholds | P2–P5 |
| NL default + EN, provider names untouched | P8 |
| Modest traffic with flood spikes | P6, P10 |
| One VPS with Docker Compose, TLS proxy | P1, P6, P10 |
| Fresh start | P0 |
| Collection from go-live, backfill later | P1, P12 |
| Phase issues with Build / Code review / Security review prompts | B.0 template |

**Belgium caveat.** Until HIC, VMM and SPW grant access, Belgium is covered only at the borders. The sources are RWS (Eijsden, Sint Pieter, Maaseik on the NL side), the Hub'Eau/Vigicrues mirrors (Semois, Chiers at Torgny, Sambre at Erquelinnes, Escaut at Tournai, Lys at Menen), and links out to the Belgian portals. The licence status of these mirrors is ambiguous, so they are dark twins until clarified. This is why the permission emails go out on day 1.
