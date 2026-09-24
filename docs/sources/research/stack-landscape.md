# Tech-stack landscape check for the river water-level website (as of 2026-09-23)

## 0. Method and legend

**How versions were checked (live, today).** I queried these sources directly:
- package registries: `npm view` on the npm registry, the PyPI JSON API, the Go module proxy (`proxy.golang.org/.../@latest`) and the crates.io API;
- GitHub tags via `git ls-remote --tags`. The GitHub REST API and HTML pages return 403 or "not enabled" in this environment, so tags were visible but GitHub release dates were not;
- container registries: the Docker Hub tag API, the gcr.io/distroless and cgr.dev (Chainguard) registry APIs, and dhi.io;
- release schedules: nodejs.org `dist/index.json` plus `nodejs/Release/schedule.json`, the python.org release API plus the PEP `release-cycle.json`, go.dev/dl JSON, the static.rust-lang.org stable channel manifest, and the postgresql.org versioning page.

**Tools actually run:**
- The **Node 26.10.0** binary: I checked `Temporal` and native `.ts` type-stripping.
- **go-pmtiles 1.31.2**: I ran `show` and `extract --dry-run` against the Protomaps daily planet build.
- **OpenFreeMap and VersaTiles**: I fetched a style and a vector tile from each.

**Legend:**
- **[L]** means verified live today.
- **[D]** means not verified live. The claim comes from an official vendor doc or changelog I read today. Treat it as UNVERIFIED-live.
- **[U]** means UNVERIFIED. The claim comes from secondary or press sources, or from background knowledge.

**Disclosure:** Bun is owned by Anthropic, the maker of this assistant. It is assessed on the same criteria as the others.

---

## 1. What has changed recently

These are the changes most likely to trip up an agent working from 2025-era knowledge.

1. **TypeScript 7.0 is stable (2026-07-08) [L].** It is the Go-native `tsc`, installed from the normal `typescript` package as per-platform binaries [L]. It has **no stable programmatic API yet**; that is expected in 7.1 [U]. As a result, several tools still require TypeScript 6 or older [L]:
   - `typescript-eslint` 8.70.1 accepts only TS `>=4.8.4 <6.1.0`;
   - `svelte-check` 4.7.6 and `@astrojs/check` accept only TS `^5 || ^6`;
   - `@sveltejs/kit` peers on TS `^5.3.3 || ^6.0.0`.

   **TypeScript 6.0.3 is the safe baseline** [L].
2. **Node.js.**
   - Node 26.10.0 is the Current line. It becomes **LTS on 2026-10-28** and reaches end of life (EOL) on 2029-04-30 [L].
   - Node 24 "Krypton" is Active LTS until 2026-10-20, then in maintenance until 2028-04-30 [L]. Node 22 reaches EOL on 2027-04-30. Node 20 reached EOL on 2026-04-30 [L].
   - Node 26 has `Temporal` enabled by default and runs `.ts` files directly through type-stripping. I confirmed both by running the binary; V8 is 14.6 [L].
   - From Node 27, Node moves to **one major release per year, and every release becomes LTS**. Node 27 alpha starts on 2026-10-28 [L schedule.json, D blog].
3. **Build and test tooling.**
   - Vite 8 (2026-03-12) uses **Rolldown as its only bundler** [L date, D].
   - Vitest 5.0 (2026-09-03) needs Node ≥22.12 and Vite ≥6.4. `clearMocks` now defaults to true, and unawaited async assertions now fail the test [L peer/engines, D].
4. **MapLibre GL JS 6 (2026-07-22) [L] is a big break.**
   - It is **ESM-only**: the UMD and CSP bundles are gone, and the default export is gone.
   - **WebGL1 support is removed; WebGL2 is required.**
   - `map.transform` is removed, events became classes, and `GeoJSONSource.setData` changed [L CHANGELOG].
   - v5 is frozen at 5.24.0 (2026-04-23) [L].
   - v6 is releasing about once a week: 6.0 to 6.11.1 in two months [L].
5. **Bun 1.4 (2026-08-20) is the first release of a Zig-to-Rust rewrite [L date, D].** The vendor says it is "not 100% compatible with Node.js yet" [D].
6. **Framework churn** (release dates [L] from npm unless marked; status claims are [D] or [U] as marked):
   - SolidStart 2.0 (2026-08-04) was moved into **maintenance mode** days later; Solid 2.0 is at RC [U].
   - SvelteKit 3 has been in release-candidate stage since 2026-08-13 [D]; `3.0.0-next.27` is on npm [L].
   - Astro 7 was released 2026-06-22.
   - NestJS 12 was released 2026-08-27 and is ESM-only [U].
   - React Router 8 was released 2026-06-17.
   - Fastify 6 is at alpha.4.
   - Drizzle 1.0 is still at `rc.4`; the stable line is 0.45.3.
   - TypeBox 1.x has moved to the **`typebox`** package name and is ESM-only [L/D].
7. **Python.**
   - Python 3.15.0 is due 2026-10-01 (rc2 is out) [L].
   - `httpx` has had no release since 0.28.1 (2024-12), and its issue tracker was closed [U]. A Pydantic-stewarded **`httpx2` 2.13.1** exists on PyPI (github.com/pydantic/httpx2) [L].
   - APScheduler 4 is still alpha [L]. Litestar 3 is not released [D].
8. **PostgreSQL and TimescaleDB.**
   - PostgreSQL 18.6 is current. PG 19 has had its Beta 3 release, and `REL_19_BETA4` is tagged [L].
   - TimescaleDB 2.30.1 (2026-09-17) supports PG 16, 17 and 18. PG15 support was dropped in 2.29.0 [L CHANGELOG].
   - The **official `postgres:18` image moved `PGDATA` to `/var/lib/postgresql/18/docker` and the `VOLUME` to `/var/lib/postgresql`** [L docs]. This matters for compose files.
9. **Supply-chain incidents and new defaults.**
   - The Trivy and trivy-action compromise (2026-03-19): 76 of 77 action tags were force-pushed [U, advisory GHSA-69fq-xp46-6x23].
   - An npm worm in August 2026, dubbed "ChainDrop"/Shai-Hulud, hit keyv, cacheable and about 440 other packages [U].
   - npm classic tokens were revoked on 2025-12-09 [U].
   - pnpm 11 and later have secure defaults on [U]. Dependabot supports a `cooldown` setting [U]. Renovate's `config:best-practices` preset waits 3 days on npm updates [U]. uv supports `exclude-newer = "7 days"` [U].
   - GitHub policy can now **enforce full-SHA pinning** of actions [D changelog 2025-08-15].
10. **Containers and ops tools.**
    - Docker Hardened Images have been free under Apache-2.0 since 2025-12-17 [U]; `dhi.io` requires a login [L 401].
    - Bitnami's free catalog moved to `bitnamilegacy` in 2025 [U]. **Watchtower was archived on 2025-12-17** [U].
    - Docker Compose is now **v5** (v5.5.1) [L].
    - pgBackRest was archived in April 2026, then revived by a coalition of sponsors; 2.59.1 is the latest tag [L tag, U status].

---

## 2. Runtimes and languages

| Runtime | Current | Support status | License | Verif. |
|---|---|---|---|---|
| Node.js 26 | 26.10.0 (2026-09-21) | Current → **LTS 2026-10-28**, EOL 2029-04-30. Temporal and TS type-stripping on by default | MIT | [L] |
| Node.js 24 "Krypton" | 24.21.0 | Active LTS until 2026-10-20, maintenance until EOL 2028-04-30 | MIT | [L] |
| Node.js 22 "Jod" | 22.23.3 | Maintenance, EOL 2027-04-30 | MIT | [L] |
| Bun | 1.4.2 (1.4.0 on 2026-08-20) | First release of the Rust port; "not 100% Node-compatible" | MIT [U] | [L]/[D] |
| Deno | 2.9.7 tag (npm 2.9.6; 2.9.0 on 2026-06-25) | Stable 2.x | MIT [U] | [L] |
| Python | 3.14.7 (2026-08-05); 3.13.15 | 3.14 bugfix to EOL 2030-10; 3.15.0 due 2026-10-01; 3.10 EOL 2026-10 | PSF | [L] |
| Go | 1.27.1 / 1.26.8 | 1.27 (Aug 2026): generic methods, `encoding/json` backed by v2, `uuid` pkg | BSD-3 | [L]/[D] |
| Rust | 1.98.1 (manifest 2026-09-03) | Stable; axum 0.8.9, tokio 1.53.1, sqlx 0.9.0, reqwest 0.13.5 | MIT/Apache | [L] |

**(a) Ingestion worker.** This is scheduled HTTP polling of about 8 heterogeneous JSON, XML and CSV APIs, plus coordinate conversion. Any of Node, Python or Go handles the load trivially. The deciding factors are elsewhere:
- **Node 26** gives built-in `fetch` (undici 8) [D] and `Temporal` for time-zone and DST-safe handling of Europe/Amsterdam [L]. The same Zod schemas can serve ingest, API and frontend.
- **Python** has the best record-and-replay testing (VCR.py) and data tooling (polars 1.44.2, pyproj 3.8.0 [L]).
- **Go** gives the smallest footprint and the most stable language.
- Useful libraries [L]: `fast-xml-parser` 5.11.1, `csv-parse` 7.0.2, `proj4` 2.22.0 (for RD New EPSG:28992, Belgian Lambert and Swiss LV95 EPSG:2056 to WGS84), `lxml` 6.1.3.

**(b) Small read-only JSON API.** Any of them works. **Bun 1.4** is too new for production after a full rewrite. **Deno 2.9** is viable; its per-host `--allow-net` sandbox is attractive for an ingest worker. However, pg-boss, testcontainers, Vitest and Playwright are Node-first. Agent familiarity is highest for Node.

---

## 3. API frameworks

| Framework | Current | Notes | License | Verif. |
|---|---|---|---|---|
| **Hono** | 4.13.8 (v4 since 2024-02); `@hono/node-server` 2.1.1 | Small; Standard-Schema validator (`@hono/standard-validator` 0.4.0); typed RPC client; `hono-openapi` 1.3.3, `@hono/zod-openapi` 1.6.3 (zod ^4). No pending major | MIT | [L] |
| **Fastify** | 5.12.5; **6.0.0-alpha.4** | Mature; `@fastify/type-provider-typebox` 6.1.0 now depends on `typebox` ^1; `fastify-type-provider-zod` 7.0.0; swagger 9.9, rate-limit 11.2. A v6 migration is likely in 2027 | MIT | [L] |
| Express | 5.2.1 (4.x still at 4.22.3) | Fine but weak typing and slower; no advantage here | MIT | [L] |
| NestJS | 12.1.0 (12.0 on 2026-08-27) | ESM-only, Standard Schema, new CLI [U]; heavy DI; ecosystem lag reported (e.g. Sentry) [U]. **Overkill** | MIT | [L]/[U] |
| FastAPI | 0.141.1 (Starlette 1.7.0, Pydantic ≥2.9) | De-facto standard; auto OpenAPI | MIT | [L] |
| Litestar | 2.24.0 | 3.0 not released; DI rewrite blocked on maintainer capacity [D] | MIT | [L]/[D] |
| Go stdlib `net/http` | Go 1.27 | Method and wildcard routing since 1.22; enough for this API | BSD-3 | [L] |
| chi | v5.3.2 (2026-08-20) | Thin middleware on stdlib | MIT | [L] |
| echo | v5.3.1 (v5.0.0 on 2026-01-18); v4.15.4 | New major this year means churn | MIT | [L] |
| huma | v2.39.1 | OpenAPI-first on stdlib or chi | MIT [U] | [L] |

---

## 4. Frontend

| Option | Current | Map binding and status | Notes | Verif. |
|---|---|---|---|---|
| **React 19.3 + Vite 8.3** | react 19.3.0 (2026-09-09), vite 8.3.0, `@vitejs/plugin-react` 6.1.1 | `@vis.gl/react-maplibre` 8.1.3 (peer maplibre-gl ≥4). ML6 fix (removed `map.transform`) reported in 8.1.3 [U] | Largest ecosystem and agent familiarity. TanStack Router 1.170.39 gives typed URL search params, ideal for `?t=…&station=…`. React Router 8.4.0 | [L] |
| **SvelteKit 2 / Svelte 5** | kit 2.70.3 (**3.0 RC**), svelte 5.57.1 | `svelte-maplibre-gl` 2.2.1 peers `maplibre-gl ^5.19 \|\| ^6` | Smaller bundles; official Paraglide add-on; `svelte-check` locks TS ≤6; SvelteKit 3 migration imminent | [L]/[D] |
| SolidStart 2 | 2.0.5; solid-js 1.9.15 (2.0 rc.9) | `solid-map-gl` 2.2.4 (ML ^6 ok) | **Maintenance mode** [U]. Avoid | [L]/[U] |
| Vue 3 / Nuxt 4 | vue 3.5.43 (3.6 rc.9), nuxt 4.5.2 | **`vue-maplibre-gl` 5.6.1 peers `maplibre-gl ^5.17` only (no v6)** | Friction on the map layer | [L] |
| Astro 7 | 7.3.4 (7.0 on 2026-06-22), Node ≥22.12 | Via framework islands | Content-first; adds a layer around a single map island. Useful only for static about/method pages | [L]/[D] |

**Data fetching.** `@tanstack/react-query` 5.103.2; `@tanstack/svelte-query` 6.2.4 (built for Svelte 5 runes); vue and solid variants are also on 5.103.2 [L].

**Charts** [L]:

| Library | Version | Last release | License | Fit |
|---|---|---|---|---|
| Apache ECharts | 6.1.0 | 2026-05-19 | Apache-2.0 | Best fit for hydrographs: `markLine` thresholds, `markArea` alert bands, forecast ranges, `dataZoom`. Heavier but tree-shakable |
| uPlot | 1.6.32 | 2025-03-14 | MIT | Smallest and fastest for long time series; mature but slow-moving |
| Observable Plot | 0.6.17 | 2025-02-14 | ISC | SVG, declarative; less interactive |
| Chart.js | 4.5.1 | 2025-10-13 | MIT | Canvas; thresholds via the annotation plugin |

**i18n (NL/EN)** [L]: `@inlang/paraglide-js` 2.25.4 (compile-time, typed messages; works with React and Svelte) or `i18next` 26.4.2 with `react-i18next` 17.0.15.

**Dates.** Browsers lack `Temporal` in **Safari**; it is only in Technology Preview behind a flag [U]. Chrome, Edge 144+ and Firefox 139+ ship it [U]. Use `temporal-polyfill` 1.0.5, or `date-fns` 4.4.0 with `@date-fns/tz` 1.5.0 [L].

**Styling and tooling** [L]: `tailwindcss` 4.3.3, Biome 2.5.14, oxlint 1.85.0, ESLint 10.11.0, Prettier 3.9.9.

---

## 5. Map stack

| Component | Current | License | Notes | Verif. |
|---|---|---|---|---|
| **MapLibre GL JS** | 6.11.1 | BSD-3 | ESM-only, WebGL2-only. Needs a no-WebGL2 fallback (e.g. a table view, also good for accessibility). Agents must follow the v5→v6 migration guide | [L] |
| deck.gl | 9.4.0 (2026-09-05) | MIT | Overkill for about 2–3k station points. MapLibre circle and symbol layers plus feature-state cover the time slider | [L] |
| pmtiles (JS) | 4.5.0 | BSD-3 | Protocol handler for MapLibre | [L] |
| go-pmtiles CLI | 1.31.2 | BSD-3 | **Ran it**: `show` on the daily build, `extract --dry-run` | [L] |
| Protomaps daily planet | `20260923.pmtiles`, basemap v4.15.2, built with planetiler 0.10.2, about 138 GB | ODbL data | `build-metadata.protomaps.dev/builds.json` lists 62 builds. `@protomaps/basemaps` style package is 5.7.2; compatibility with v4 tiles UNVERIFIED | [L] |
| planetiler | 0.10.2 | Apache-2.0 | Java; builds your own planet or region tiles | [L] |
| tilemaker | 3.2.0 | FTWPL (permissive) | C++ alternative | [L] |
| tippecanoe (felt) | 2.79.0 | BSD-2 | For your own overlays (river lines, catchments, stations) as PMTiles | [L] |
| martin | 1.16.1 | MIT / Apache-2.0 | Serves PMTiles, MBTiles and dynamic PostGIS tiles. **Not needed** if static PMTiles are served by Caddy | [L] |
| VersaTiles | versatiles-rs 4.15.0 | MIT | Public tiles at `tiles.versatiles.org`: style 200, tile 200 `application/vnd.mapbox-vector-tile`. Download `osm.20260608.versatiles` | [L] |
| **OpenFreeMap** | public instance live; planet build `20260913_164504_pt`, maxzoom 14 | MIT (code), ODbL data | Style `liberty` and a tile both returned 200. No keys, no limits, donation-funded, **no SLA** [D] | [L] |

**Verified extract sizes.** For a regional basemap covering the Rhine, Meuse, Scheldt, Ems and Vecht basins with bbox `2.0,45.5,11.0,54.0` [L]:
- up to z12: **926 MB**;
- up to z15: **8.2 GB**.

That is easily self-hosted as one static file on the VPS, served with HTTP range requests. This matters during floods: relying on a donation-funded public tile service without an SLA is exactly when you least want a dependency. Use OpenFreeMap or VersaTiles in development and as a fallback. Serve a self-hosted PMTiles extract in production.

**Labels and attribution.** Show "© OpenStreetMap contributors" (ODbL). NL/EN basemap labels depend on the style's `name:nl` / `name:en` handling [U].

---

## 6. Database

| Component | Current | Status / license | Verif. |
|---|---|---|---|
| **PostgreSQL 18** | 18.6 | Supported to 2030-11-14. Relevant features: async I/O, `uuidv7()`, virtual generated columns, **temporal `WITHOUT OVERLAPS` constraints** (useful for time-valid threshold and station metadata), B-tree skip scan, checksums on by default [D] | [L] |
| PostgreSQL 17 | 17.11 | Supported to 2029-11-08 | [L] |
| PostgreSQL 19 | Beta 3 released, Beta 4 tagged | Not GA. TimescaleDB support will lag; PG18 support arrived in TimescaleDB 2.23.0, about 5 weeks after PG18 GA [L] | [L] |
| **TimescaleDB** | 2.30.1 (2026-09-17) | PG 16/17/18. **License split** [L LICENSE, D editions page]: see below | [L] |
| TimescaleDB images | `timescale/timescaledb:2.30.1-pg18` (about 366 MB amd64; also `-oss`) and `timescale/timescaledb-ha:pg18` (Ubuntu, about 666 MB, **includes PostGIS**) | Default tag = community build including TSL; `-oss` = Apache-only | [L] |
| PostGIS | 3.6.4; `postgis/postgis:18-3.6(-alpine)` | GPL-2.0 [U]. Probably **not needed**: station points and river lines can be static data or PMTiles | [L] |
| pg_partman / pg_cron | 5.5.0 / 1.6.8 | For the plain-Postgres partitioning route | [L] |
| ClickHouse | 26.8 LTS / 26.9 stable | Apache-2.0. Overkill: a second database to operate | [L] |
| QuestDB | 10.0.1 | Apache-2.0. Overkill for this scale | [L] |

**TimescaleDB license split in detail:**
- **Apache-2.0 part:** hypertables and `time_bucket`.
- **TSL (Timescale License) part:** columnstore compression, continuous aggregates, retention policies, the job scheduler and `time_bucket_gapfill`.
- TSL allows free self-hosting and modification. It forbids selling TimescaleDB as a database service. That restriction does not affect this project.

**Data-volume estimate [U].** Assume about 2,000 gauges with about 1.5 series each, at 10–15-minute resolution. That gives roughly 100–250 million observation rows per year, plus forecasts of a similar order depending on the forecast model. On plain Postgres that is roughly 8–20 GB per year including the primary-key index. With TimescaleDB columnstore compression it is typically under 10% of that.

Both options fit comfortably on one VPS:
- **TimescaleDB** earns its place through continuous aggregates (hourly and daily rollups for a zoomed-out time slider), gap-filling with last-observation-carried-forward (the "value at moment t" query), compression and retention. The cost is one extra ops step: `ALTER EXTENSION timescaledb UPDATE` after each image bump.
- **Plain partitioned PG18** plus BRIN indexes plus rollup tables maintained by ingest is the zero-extension alternative.

**Migrations and data access** [L]:

| Tool | Version | License | Note |
|---|---|---|---|
| **dbmate** | 2.36.0 (npm and Go) | MIT | Plain SQL; language-neutral; handles Timescale DDL naturally |
| sqitch | develop branch | MIT | Version not checked |
| node-pg-migrate | 9.0.0 | MIT | |
| **Kysely** | 0.29.6 (Node ≥22), `kysely-codegen` 0.20.0 | MIT | Typed SQL builder |
| Drizzle ORM / drizzle-kit | 0.45.3 (Apache-2.0) / 0.31.11 (MIT) | | 1.0 still at rc.4, so churn. Its generator does not understand hypertables |
| sqlc | 1.31.1 | MIT | Go |
| goose / golang-migrate | 3.28.0 / 4.20.1 | MIT | Go |
| Alembic + SQLAlchemy | 1.20.0 + 2.0.54 (2.1 at rc2) | MIT | Python |
| psycopg / asyncpg | 3.3.6 (LGPL-3.0) / 0.31.0 | | Python drivers |
| pgx | v5.11.0 | MIT [U] | Go driver |

**Backups.** Options:
- nightly `pg_dump` plus `restic` 0.19.1 to an offsite target;
- or WAL-G 3.0.9 or pgBackRest 2.59.1 for point-in-time recovery [L tags]. Note that pgBackRest's maintenance status was in flux in April–May 2026 [U].

---

## 7. Job scheduling inside a container

| Option | Current | Fit | Verif. |
|---|---|---|---|
| In-process cron: **croner** / node-cron | 10.0.1 (MIT) / 4.6.0 (ISC) | Simplest. Add a Postgres advisory lock per source and store cursor/state in a table. Retries and backfill are on you | [L] |
| **pg-boss** | 12.34.0 (MIT, Node ≥22.12) | Postgres-backed; cron and RRULE schedules, retries with backoff, dead-letter queues, throttling and singletons. **Also covers the later backfill phase as a job queue** without extra infrastructure | [L] |
| graphile-worker | 0.18.0 (MIT, Node ≥22.18) | Similar, with a crontab feature; very fast | [L] |
| supercronic (cron in a container) | 0.2.49 | Fine for one script per run; loses in-process state and connection reuse | [L] |
| Temporal | server 1.32.0 (MIT), TS SDK 1.24.0 | **Overkill**: its own server, database and UI to operate | [L] |
| Python: APScheduler / Procrastinate | 3.11.3 (4.0 still alpha) / 3.9.0 (MIT, Postgres-backed) | | [L] |
| Go: River / gocron | 0.47.0 (MPL-2.0) / v2.22.0 | | [L] |

**Recommendation:** pg-boss, or croner for a first spike. Temporal is not justified here.

---

## 8. Validation

| Library | Version | Notes | Verif. |
|---|---|---|---|
| **Zod** | 4.6.5 (v4 since 2025-07-09) | Standard Schema; built-in JSON Schema export | [L] |
| Valibot | 1.5.0 | Smallest bundle | [L] |
| TypeBox | **`typebox` 1.3.34**; `@sinclair/typebox` 0.34.52 is legacy | ESM-only; `Date` and `Uint8Array` types removed [D] | [L] |
| ArkType | 2.2.3 | | [L] |
| Standard Schema spec | 1.1.0 | | [L] |
| Pydantic | 2.13.5 (2.14 beta) | Python; pydantic-settings 2.15.0 | [L] |

For heterogeneous provider payloads, write **one strict schema per provider response**, then map it to one canonical `Observation` / `Forecast` / `Threshold` type.

---

## 9. Testing

| Tool | Version | Notes | Verif. |
|---|---|---|---|
| Vitest | 5.0.1 | Node ≥22.12 | [L] |
| Playwright | 1.63.0 | Apache-2.0 | [L] |
| pytest / pytest-asyncio | 9.1.1 / 1.4.0 | | [L] |
| msw | 2.15.0 | Node fetch interception with fixtures | [L] |
| nock | 14.0.17 | Built on the mswjs interceptors; whether its recorder works with native `fetch` is UNVERIFIED | [L] |
| **VCR.py** / pytest-recording / respx | 8.3.0 / 0.13.4 (2025-05) / 0.23.1 | Best record-and-replay story; compatibility with `httpx2` UNVERIFIED | [L] |
| go-vcr | v4.0.7 | | [L] |
| testcontainers | Node 12.1.0, Go 0.44.0, Python 4.15.0 | Real TimescaleDB in integration tests | [L] |

**Agent-relevant pattern.** Unit and integration tests must run **offline against recorded provider fixtures**. Agent sessions sit behind proxies and live APIs are flaky. Separately, a **nightly live "contract check" job** in CI polls each provider once and fails if the schema has drifted.

---

## 10. Reverse proxy, TLS and containers

| Component | Current | Notes | Verif. |
|---|---|---|---|
| **Caddy** | 2.11.4 (Apache-2.0); `caddy:2.11.4-alpine` | Automatic HTTPS, HTTP/3, zstd, `file_server` with range requests for PMTiles. **No built-in response cache**: `cache-handler` v0.17.0 (Souin) needs a custom build with xcaddy 0.4.7 | [L] |
| Traefik | 3.7.13 (MIT) | Docker-label discovery; adds little for a fixed compose set | [L] |
| nginx | stable **1.30.5** / mainline 1.31.6 | Built-in `proxy_cache` is good for spikes. Native ACME module (Rust, HTTP-01) since Aug 2025 [D/U] | [L] |
| Docker CLI / Compose | 29.8.1 / **v5.5.1** | Compose v5 added init containers and `pull_policy` refresh windows [U] | [L] |
| Podman | 6.1.2 | Rootless or quadlets alternative | [L] |
| Distroless | `gcr.io/distroless/{nodejs24,nodejs26,python3,static,base}-debian13` with `:nonroot`/`:debug` tags | | [L] |
| Chainguard (free) | only `latest`/`latest-dev` tags visible for node/python/postgres; no caddy | Pin by digest | [L tags], [U] policy |
| Docker Hardened Images | Free under Apache-2.0 since 2025-12-17 [U]; `dhi.io` returns 401 without a login | | [L] |
| Bitnami | Avoid: catalog moved to `bitnamilegacy` | | [U] |
| Watchtower | **Archived** | Do not use for auto-updates | [U] |

**Let's Encrypt lifetimes are shrinking:** 45-day certificates are opt-in since 2026-05-13, the default becomes 64 days from 2027-02-10, and 45 days from 2028-02-16 [U]. Caddy and Traefik automation absorb this.

**Rootless.** Rootless Docker or Podman complicates binding ports 80 and 443. It needs `net.ipv4.ip_unprivileged_port_start` or a port-forwarding driver [U]. A pragmatic hardening baseline is a rootful daemon with every container configured as:
- non-root `USER`;
- `read_only: true`;
- `cap_drop: [ALL]`;
- `security_opt: no-new-privileges`;
- an internal network for Postgres, with no published port.

**Flood-spike design.** Past time buckets never change, so `/snapshot?t=<bucket>` responses can be served with `Cache-Control: public, max-age=31536000, immutable`. For the current bucket, use `max-age=60, stale-while-revalidate`. Better still, have the ingest worker write precomputed JSON snapshot files that Caddy serves statically. That makes a spike cost nearly zero app CPU, and no proxy cache is needed. A CDN in front is optional but means a third-party dependency.

---

## 11. CI/CD and supply chain

**Current action majors** [L tags]:

| Area | Action | Version |
|---|---|---|
| Core | `actions/checkout` | v7 |
| | `actions/setup-node` / `setup-python` / `setup-go` | v7 |
| | `actions/cache` | v6 |
| | `actions/upload-artifact` | v7 |
| Attestation | `actions/attest-build-provenance` / `actions/attest` | v4.2.2 |
| Docker | `docker/build-push-action` | v7.4.0 |
| | `docker/login-action` | v4.6.0 |
| | `docker/setup-buildx-action` | v4.4.1 |
| | `docker/metadata-action` | v6.2.0 |
| Security | `github/codeql-action` | v4.38.1 |
| | `step-security/harden-runner` | v2.21.1 |
| | `zizmorcore/zizmor` | v1.30.1 (MIT) |
| | `ossf/scorecard-action` | v2.4.4 |
| | `anchore/sbom-action` | v0.24.2 |
| | `aquasecurity/trivy-action` | v0.36.0 |
| | `gitleaks/gitleaks-action` | v3.0.0 |
| | `sigstore/cosign-installer` | v4.1.2 |
| Toolchain setup | `pnpm/action-setup` / `astral-sh/setup-uv` | v6.1.0 / v10.2.0 |

GitHub is removing Node 20 from runners, so only node24-based action majors will work [U; exact removal date UNVERIFIED]. gitleaks-action v3 moved to Node 24 and needs a **license key only for organization-owned repos** [L README].

**Scanners and dependency bots:**
- **Trivy** 0.74.0 and **Grype** 0.119.0 plus **Syft** 1.52.0 (all Apache-2.0) [L]. After the March 2026 compromise, pin any Trivy action to a reviewed commit SHA, or run Grype and Syft instead.
- **gitleaks** 8.30.1 (MIT) [L].
- **Renovate** CLI 44.111.3 (AGPL-3.0) [L]; the hosted Mend app is free [U]. Dependabot is the alternative, with `cooldown` [U].
- **CodeQL** is free on public repos. Private repos need GitHub Code Security, about $30 per active committer per month [U].

**Best-practice baseline:**
- Pin every action to a full commit SHA. Renovate's `helpers:pinGitHubActionDigests` keeps the pins updated. Optionally enforce pinning via repo/org policy [D].
- Set top-level `permissions: {}` and grant per job.
- Run `zizmor` on the workflows.
- Use `harden-runner` in audit mode.
- Push to GHCR with `GITHUB_TOKEN`.
- Use buildx `provenance: mode=max` plus `sbom: true`.
- **Use cosign keyless signing via GitHub OIDC.** This is where OIDC fits for a VPS; deploying to a VPS does not consume OIDC. Run `cosign verify` on the VPS before `docker compose pull && up -d`.
- Deploy through a restricted SSH key (`command=`-forced), or pull-based via a systemd timer.

**Lockfile hygiene:**
- Use pnpm 12.6.0 (12.0 on 2026-08-26) [L]. pnpm 11+ defaults [U]: `minimumReleaseAge` 1440 minutes, `strictDepBuilds`, `blockExoticSubdeps`. Raise the release age to 3–7 days, list `allowBuilds` explicitly, and install with `--frozen-lockfile`.
- npm 12.1.0 has `min-release-age` [L version, U feature].
- For Python, set `[tool.uv] exclude-newer = "7 days"` [U].
- npm provenance and trusted publishing only matter if you publish packages. You won't.

---

## 12. Observability

| Tool | Current | License | Fit | Verif. |
|---|---|---|---|---|
| **Uptime Kuma** | 2.5.5 | MIT | External HTTP and certificate-expiry checks | [L] |
| **healthchecks.io** | v4.4 | BSD-3 [U] | Dead-man's switch per ingest source. Hosted free tier: 20 checks [D] | [L] |
| Prometheus + Grafana | 3.14.0 + 13.2.2 | Apache / **AGPL-3.0** | Useful in a later phase; about 0.5–1 GB RAM [U] | [L] |
| VictoriaMetrics | 1.152.0 | Apache-2.0 | Lighter Prometheus-compatible option | [L] |
| Loki / Alloy | 3.7.8 / 1.19.2 | | | [L] |
| Exporters | node_exporter 1.12.1, postgres_exporter 0.20.1, blackbox 0.28.0 | | | [L] |
| Structured logging | pino 10.3.1 / structlog 26.1.0 / Go `slog` | | JSON to stdout, docker log rotation | [L] |
| Metrics / tracing | prom-client 15.1.3, `@opentelemetry/sdk-node` 0.222.0 | | | [L] |
| **GlitchTip** | 6.2.6 tag | MIT | 256–512 MB RAM, Postgres only; Valkey optional [D]. Compatibility with Sentry JS SDK 11.0.0 UNVERIFIED | [L] |
| Sentry self-hosted | 26.9.0 | **FSL-1.1-Apache-2.0** | **Minimum 4 cores, 16 GB RAM plus 16 GB swap** [D]. Too heavy for this VPS | [L] |

The most valuable signal is domain-specific: **per-source data freshness**, i.e. the newest observation age per provider and per station, exposed as `/health` and as a metric. Uptime Kuma or healthchecks can alert on it.

---

## 13. Agent-specific considerations (Claude Code)

- **Knowledge-gap risk is high.** Many majors are newer than most model training data: TS 7, Node 26, Vite 8, Vitest 5, MapLibre 6, pnpm 11/12, Compose v5, React Router 8, Astro 7, NestJS 12, SvelteKit 3, TypeBox 1.0, httpx2, and the PG18 image path change. Mitigations:
  - a `CLAUDE.md` "bill of materials" with pinned versions and links to migration guides;
  - exact pins in `package.json`;
  - strict typechecking and tests as the guardrail;
  - preferring low-churn libraries: Kysely over the Drizzle RC; Hono or Fastify 5 over NestJS 12.
- **Single-language TypeScript** lets agents share Zod schemas and types across ingest, API and UI. Hono RPC or OpenAPI typegen catches contract drift at compile time.
- **Fast feedback loop:** Vitest 5, and TS 7 when the tooling allows. Native TS execution in Node 26 [L] removes `tsx` / `ts-node` from scripts.
- **Tests must run offline** from recorded fixtures (section 9). Add a SessionStart hook so cloud agent sessions have dependencies installed.

---

## 14. Candidate stacks

### Stack A: TypeScript monorepo (recommended)

| Layer | Choice |
|---|---|
| Runtime | Node **26** (LTS from 2026-10-28) |
| Workspace | pnpm 12 workspaces: `apps/{ingest,api,web}`, `packages/{schemas,db}` |
| TypeScript | TS 6.0.3 strict |
| Ingest | fetch/undici + p-retry/p-limit + fast-xml-parser/csv-parse + proj4 + **Zod 4** + **pg-boss 12** |
| DB | **PostgreSQL 18 + TimescaleDB 2.30**, **Kysely 0.29** + kysely-codegen, **dbmate** SQL migrations |
| API | **Hono 4.13** on `@hono/node-server` (alternative: Fastify 5.12) |
| Web | **React 19.3 + Vite 8.3 + TanStack Router + TanStack Query 5 + MapLibre 6.11 + pmtiles + ECharts 6 (or uPlot) + Paraglide 2 + temporal-polyfill** |
| Tests | **Vitest 5, msw 2, testcontainers 12, Playwright 1.63** |
| Logs / errors / edge | pino 10; GlitchTip; **Caddy 2.11** |
| Images | built on `node:26-trixie-slim`, run on `gcr.io/distroless/nodejs26-debian13:nonroot` (or DHI), pinned by digest |

- **Pros:** one language; shared schemas; best agent familiarity; best frontend ecosystem; all pieces verified current and supported.
- **Cons:** npm supply-chain exposure (mitigated as in section 11); frontend churn (MapLibre 6 cadence); two majors due in 2027 (TS 7 adoption, Fastify 6 if Fastify is chosen).

**Svelte variant (A-S).** Swap the web layer for SvelteKit 2 with adapter-static SPA mode, Svelte 5, `svelte-maplibre-gl` 2.2 and svelte-query 6. You get smaller and simpler UI code and official Paraglide support. The price is an imminent SvelteKit 3 migration and TS pinned to ≤6 via `svelte-check`.

### Stack B: Python services + TypeScript SPA

| Layer | Choice |
|---|---|
| Language / tooling | Python 3.14 + uv 0.12.18 + ruff 0.16.8 + mypy 2.3.1 or pyright 1.1.414 (`ty` 0.0.83 is pre-1.0) |
| API | FastAPI 0.141 + Pydantic 2.13 + Granian 2.8 or Uvicorn 0.53 |
| DB access | SQLAlchemy 2.0 Core or psycopg 3.3 + Alembic 1.20 |
| HTTP client | **httpx2 2.13** or niquests 3.21 / aiohttp 3.14 |
| Scheduling | Procrastinate 3.9 or APScheduler 3.11 |
| Logs / tests | structlog 26; pytest 9 + VCR.py 8 |
| Frontend | Same web as A; types via FastAPI OpenAPI to `openapi-typescript` 7.13 + `openapi-fetch` 0.17 |

- **Pros:** best record-and-replay testing; Pydantic is excellent for messy payloads; strong data tooling for the backfill and analytics phase.
- **Cons:** two languages, toolchains and dependency ecosystems; the HTTP-client situation (httpx to httpx2) is unsettled; boundary typing is weaker than TS end-to-end.

### Stack C: Go services + TypeScript SPA

| Layer | Choice |
|---|---|
| Language / HTTP | Go 1.27 + stdlib `net/http` (or chi v5.3) + huma v2 for OpenAPI |
| DB | pgx v5.11 + sqlc 1.31 + goose/dbmate |
| Scheduling | River 0.47 (MPL-2.0) or gocron v2 |
| Logs / tests | `slog`; go-vcr v4 + testcontainers-go |
| Images | `distroless/static-debian13` |
| Frontend | Same web as A via OpenAPI typegen |

- **Pros:** lowest RAM and ops footprint; single static binaries; the most stable language (Go 1 compatibility), good for long-lived code maintained by agents.
- **Cons:** two languages; more boilerplate for heterogeneous XML/CSV/JSON parsing and coordinate conversion; OpenAPI typegen adds a step.

### Trade-off matrix (qualitative)

| Criterion | A (TS) | B (Py + TS) | C (Go + TS) |
|---|---|---|---|
| Languages / toolchains | **1** | 2 | 2 |
| End-to-end typing | **Strongest** (shared Zod / RPC) | Medium (OpenAPI bridge) | Strong (OpenAPI bridge) |
| Provider-parsing ergonomics | Good | **Best** | OK |
| Record-and-replay testing | Good (msw fixtures) | **Best** (VCR.py) | Good (go-vcr) |
| Runtime footprint | Medium | Medium | **Lowest** |
| Agent familiarity | **Highest** | High | High |
| Supply-chain surface | Largest (npm) | Medium | **Smallest** |
| 12-month churn risk | Medium-high (frontend and TS 7) | Medium | **Low** (backend) |
| Backfill / analysis fit | Good | **Best** | Good |

**VPS sizing estimate [U]:** 4 vCPU, 8 GB RAM, ≥160 GB NVMe. That covers Postgres/Timescale with about 2 GB `shared_buffers`, the API and worker (about 100–200 MB each for Node), Caddy, GlitchTip (about 512 MB), Uptime Kuma, and an 8.2 GB PMTiles file. Grow to 16 GB if Prometheus and Grafana are added.

---

## Recommendation for phase planning

**Stack decision.** Adopt **Stack A (TypeScript monorepo, React variant)** as the default. Keep **Stack C (Go)** as the documented fallback if the npm supply-chain posture or Node memory becomes a concern.

**Pins for the planning bill of materials:**

| Area | Pins |
|---|---|
| Runtime and tooling | Node 26.x (24.x until 2026-10-28 if strict LTS-from-day-one is required), pnpm 12.6, TypeScript 6.0.3 |
| Backend | Hono 4.13, Zod 4.6, Kysely 0.29, dbmate 2.36, pg-boss 12.34 |
| Frontend | React 19.3, Vite 8.3, TanStack Router 1.170 / Query 5.103, MapLibre GL JS 6.11, pmtiles 4.5, ECharts 6.1 (or uPlot 1.6.32), Paraglide 2.25 |
| Tests | Vitest 5.0, Playwright 1.63, msw 2.15, testcontainers 12.1 |
| Database | PostgreSQL 18.6 + TimescaleDB 2.30.1 (`timescale/timescaledb:2.30.1-pg18`) |
| Infrastructure | Caddy 2.11.4, distroless `nodejs26-debian13:nonroot`, Docker Compose v5 |

**Phase 0 — Foundation (repo, CI, supply chain, runtime skeleton)**
- Repo and tooling:
  - pnpm workspace; `CLAUDE.md` with the bill of materials and version gotchas (MapLibre 6 ESM/WebGL2, the PG18 `PGDATA`/volume path, TS 7 tooling limits, TypeBox rename, Vitest 5 defaults);
  - a SessionStart hook for agent sessions.
- CI:
  - SHA-pinned actions; `permissions: {}`; zizmor; gitleaks; harden-runner;
  - Renovate with `minimumReleaseAge` of 3–7 days, digest pinning and grouped updates;
  - Grype + Syft SBOM, buildx provenance, cosign keyless signing;
  - CodeQL only if the repo is public, or if paying for Code Security.
- Runtime skeleton: Compose with Caddy, TimescaleDB, api and ingest; non-root, read-only containers; internal DB network.
- Decide on backups: `pg_dump` + restic offsite for this phase; WAL-G or pgBackRest point-in-time recovery later.

**Phase 1 — Data spine**
- Schema:
  - stations and series;
  - observations hypertable;
  - forecasts modelled bi-temporally (issue time × valid time);
  - thresholds with validity ranges (PG18 `WITHOUT OVERLAPS`);
  - per-source freshness.
- Ingest: 1–2 providers end-to-end with Zod schemas, recorded fixtures, pg-boss schedules and retries, and coordinate normalisation with proj4.
- Nightly live contract-check job.

**Phase 2 — API and map MVP**
- API endpoints:
  - `/stations`;
  - `/snapshot?t=` (bucketed and immutable-cacheable, or precomputed static JSON);
  - `/series/:id?from&to`;
  - `/thresholds`.
- Map:
  - MapLibre 6 with a self-hosted PMTiles extract (about 0.9 GB to z12, 8.2 GB to z15, verified); OpenFreeMap as the dev fallback;
  - time slider state in typed URL search params; hydrograph charts; NL/EN.
- Playwright tests for NL/EN, the slider and the no-WebGL2 fallback.

**Phase 3 — Coverage**
- Remaining providers (NL, DE, BE, FR, LU, CH).
- Provider alert levels and thresholds.
- The "follow the water downstream" view: a river-network overlay built with tippecanoe.
- Continuous aggregates for zoomed-out time ranges.

**Phase 4 — Hardening for floods**
- Load-test a flood-spike scenario.
- Tune the caching strategy.
- Monitoring: Uptime Kuma + healthchecks.io + GlitchTip, plus the freshness endpoint. Prometheus/Grafana or VictoriaMetrics only if needed.
- Runbooks and a restore drill.

**Phase 5 — Historical backfill**
- Reuse pg-boss queues with per-provider rate limits.
- Enable TimescaleDB compression and retention policies.
- Revisit Python (polars) tooling only if analysis needs appear.

**Scheduled re-check points:**

| When | Check |
|---|---|
| 2026-10-28 | Node 26 LTS |
| When TS 7.1 ships a stable API and typescript-eslint / svelte-check support it | Move to TS 7 |
| If the Svelte variant is chosen | SvelteKit 3 GA |
| If Fastify is chosen | Fastify 6 GA |
| If Drizzle is reconsidered | Drizzle 1.0 GA |
| After PG 19 GA | Wait for TimescaleDB PG19 support before any upgrade; not before 2027 |
| When Safari ships Temporal | Drop the polyfill |
| Until then | Keep watching for further npm and GitHub Actions supply-chain incidents |

---

### Sources
- Node: [Node.js 26.0.0 release](https://nodejs.org/en/blog/release/v26.0.0), [Evolving the Node.js release schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule), [InfoQ on Node 26 Temporal](https://www.infoq.com/news/2026/07/nodejs-26-temporal/)
- TypeScript 7: [InfoQ on TypeScript 7](https://www.infoq.com/news/2026/08/typescript-7-released/), [The Register on the TS 7 Go compiler](https://www.theregister.com/devops/2026/07/09/speedier-type-checks-in-typescript-70-as-first-stable-go-release-ships/5268828)
- Build and test tooling: [Vite 8 announcement](https://vite.dev/blog/announcing-vite8), [Vitest 5 announcement](https://vitest.dev/blog/vitest-5.html)
- Bun: [Bun v1.4 blog](https://bun.com/blog/bun-v1.4), [Anthropic acquires Bun](https://anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone)
- Frameworks: [Astro 7](https://astro.build/blog/astro-7/), [InfoQ on SolidStart 2](https://www.infoq.com/news/2026/09/solid-start-v2/), [SvelteKit 3 RC](https://svelte.dev/blog/sveltekit-3-release-candidate), [NestJS v12 (Trilon)](https://trilon.io/blog/nestjs-12-is-now-available), [Fastify v6 milestone](https://github.com/fastify/fastify/milestone/6), [Litestar 3 announcement](https://litestar.dev/blog/v3-announcement/), [Drizzle latest releases](https://orm.drizzle.team/docs/latest-releases), [TypeBox 1.0 migration guide](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.0.0-migration.md)
- Map: [MapLibre v5-to-v6 migration guide](https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/), [react-map-gl what's new](https://visgl.github.io/react-map-gl/docs/whats-new), [OpenFreeMap](https://openfreemap.org/)
- Database: [TimescaleDB editions (Tiger Data)](https://www.tigerdata.com/docs/about/latest/timescaledb-editions), [PostgreSQL 18 release](https://www.postgresql.org/about/news/postgresql-18-released-3142/)
- Python: [HTTPX status 2026 (BSWEN)](https://docs.bswen.com/blog/2026-03-05-httpx-library-status/), [uv exclude-newer](https://pydevtools.com/handbook/how-to/how-to-use-exclude-newer-for-reproducible-python-environments/)
- Supply chain: [Trivy advisory GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23), [Microsoft on the Trivy compromise](https://www.microsoft.com/en-us/security/blog/2026/03/24/detecting-investigating-defending-against-trivy-supply-chain-compromise/), [Wiz on the keyv/cacheable npm attack](https://www.wiz.io/blog/keyv-and-cacheable-npm-supply-chain-attack), [npm classic token revocation](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/), [pnpm 11 defaults (Socket)](https://socket.dev/blog/pnpm-11-adds-new-supply-chain-protection-defaults), [GitHub Actions SHA-pinning policy](https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/), [Dependabot minimum package age](https://github.blog/changelog/2025-07-01-dependabot-supports-configuration-of-a-minimum-package-age/), [Renovate discussion on minimumReleaseAge](https://github.com/renovatebot/renovate/discussions/42610), [GitHub Actions Node 20 deprecation](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/), [GitHub security plans](https://github.com/security/plans)
- Containers: [Docker Hardened Images for everyone](https://www.docker.com/blog/docker-hardened-images-for-every-developer/), [Bitnami catalog changes](https://github.com/bitnami/containers/issues/83267), [Chainguard free tier changes](https://support.chainguard.dev/hc/en-us/articles/40405733238299-Customer-Notice-Free-Image-Tier-Changes), [Watchtower end of maintenance](https://linuxiac.com/docker-update-tool-watchtower-reaches-end-of-maintenance/), [Docker Compose releases](https://github.com/docker/compose/releases)
- TLS and proxies: [Let's Encrypt 90 to 45 days](https://letsencrypt.org/2025/12/02/from-90-to-45), [Native ACME for NGINX](https://letsencrypt.org/2025/09/11/native-acme-for-nginx)
- Observability and ops: [Sentry self-hosted requirements](https://develop.sentry.dev/self-hosted/), [GlitchTip install docs](https://glitchtip.com/documentation/install), [healthchecks.io pricing](https://healthchecks.io/pricing/), [pgBackRest archived (Percona)](https://percona.community/blog/2026/04/28/pgbackrest-is-archived-what-now/), [pgBackRest will continue](https://noise.getoto.net/2026/05/19/pgbackrest-will-continue/)
- Browser support: [Temporal on caniuse](https://caniuse.com/temporal)