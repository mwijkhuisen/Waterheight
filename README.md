# rws — Rijkswaterstaat monitoring map

A map of the Netherlands showing the measurement locations Rijkswaterstaat monitors, backed by a thin
API over the official Rijkswaterstaat WaterWebservices (WADAR / `ddapi20`).

**Status: complete.** Schema, ingestion, API, clustered map, backfill pipeline and the detail panel
with charts over the full history. The full brief is in [`PROMPT.md`](PROMPT.md); the Phase 1
measurements that shaped these decisions are in
[`spike/PHASE1-FINDINGS.md`](spike/PHASE1-FINDINGS.md).

What has actually been exercised, and what has not, is listed under
[Verified and unverified](#verified-and-unverified) — worth reading before deploying.

## Deploying

One container serves the whole app: the API and the built map client on the same origin, which also
means the browser never needs CORS.

```sh
cp .env.example .env
# POSTGRES_PASSWORD has no default — compose refuses to start until you set it,
# so a known credential can never ship by accident.
$EDITOR .env

docker compose up -d --build          # database, migrations, then the app on :3000
docker compose run --rm migrate node packages/server/dist/cli/refresh.js
```

`docker compose up` brings up TimescaleDB, applies migrations and starts the app, but the database is
**empty** until that `refresh` runs: it loads the catalogue (~1.2 s) and the location layer (~6 min).
After that the map works immediately — observations for short periods are fetched on demand.

The API container carries the daily refresh and the weekly correction re-fetch (`ENABLE_SCHEDULES`,
on by default in compose). If you scale it past one replica, turn that off and run the schedules on a
single worker instead, or several instances will hit Rijkswaterstaat with the same job.

Then load history when you want it, from the host or `docker compose exec api`:

```sh
node packages/server/dist/cli/backfill.js --dry-run   # plan and projection only
node packages/server/dist/cli/backfill.js             # ~2.5 h for the eager tier
```

Health is at `/api/health`; the container healthcheck already uses it. It reports upstream
reachability, cache age, location counts and backfill progress.

### Before you expose it publicly

- Put TLS in front of it. The app speaks plain HTTP and trusts `X-Forwarded-*`, so it expects a proxy.
- Set `CORS_ORIGIN` if you do not want third parties calling the API from a browser.
- Tune `RATE_LIMIT_MAX` (default 300/min per IP). This protects the upstream budget as much as this
  service: `/observations` can trigger live fetches to Rijkswaterstaat.
- The database port is not published by default — only the API container reaches it.

## Development

```sh
cp .env.example .env
docker compose up -d db               # just the database
npm install
npm run migrate
npm run refresh                       # catalogue + location layer
npm run dev                           # API on :3000
npm run dev:web                       # map on :5173, proxying /api to :3000
npm test
```

The backfill CLI in development:

```sh
npm run backfill -- --dry-run                           # plan and projection, downloads nothing
npm run backfill -- --locations vlissingen --limit 20   # prove it on a few chunks first
npm run backfill                                        # the real thing; resumable
npm run backfill:status
```

## Architecture

```
WFS locatiesmetlaatstewaarneming ──► ingest/locations  ──┐
OphalenCatalogus                 ──► ingest/catalogue ──┤
OphalenWaarnemingen              ──► ingest/observations┤
                                                        ▼
                                       PostgreSQL + TimescaleDB
                                                        │
                                                   api/routes ──► /api/*
```

Three packages: `@rws/shared` holds the types both sides of the wire agree on, `@rws/server` is the
API and ingestion, and `@rws/web` is the map client. The shared package is the contract — a change to
a server response shape is a compile error in the client rather than a runtime surprise.

### Why this API exists at all

The browser cannot call Rijkswaterstaat directly (no CORS headers), the payload shape is awkward
enough that every consumer would reimplement the same normalisation, and some of it is actively
misleading if taken at face value — see *Data quirks* below. This layer owns all of that, so no raw
Rijkswaterstaat field name ever reaches a client. There is a test that asserts exactly that.

### Storage

PostgreSQL with TimescaleDB is the single datastore for everything: locations, catalogue, job queue
and observations. One database, one connection pool, one backup.

The ingester writes continuously while the API serves reads, which rules out an embedded
single-writer engine like DuckDB. Rijkswaterstaat also revises published values after the fact, so
corrections are in-place row updates rather than appends — with immutable files such as Parquet that
would mean rewriting whole partitions. The relational side (locations, catalogue, queue) has to exist
regardless, and keeping it in the same transactional store is worth more than a columnar engine's
scan speed at a volume PostgreSQL handles comfortably.

| Table | Purpose |
| --- | --- |
| `locations` | One row per location; never deleted, only activated/deactivated |
| `location_events` | Every activation and deactivation, with a reason |
| `location_quantities` | What each location publishes, from the WFS layer |
| `series` | One row per physically distinct measurement stream |
| `observations` | Hypertable, 7-day chunks, `(series_id, ts)` primary key |
| `observations_hourly` / `_daily` | Continuous aggregates with min/max/mean/count |
| `aquo_codes` | Catalogue code lists, for filter labels |
| `backfill_jobs` | Work queue, one row per (location, quantity, month) |
| `upstream_cache` | Cached upstream responses, for stale-serving |

Compression is delayed to 90 days, comfortably beyond the 60-day correction window, so the rolling
re-fetch never has to rewrite a compressed chunk. There is no retention policy: a year of history is
the product.

Schema changes go in `packages/server/migrations/` and are applied in filename order by a small
forward-only runner. A migration whose contents change after being applied is a hard error rather
than a silent divergence.

### The series model, and why `(location, quantity)` is not enough

The brief specified a uniqueness constraint of `(location_code, quantity, timestamp, proces_type)`.
Measured against the live service, that is **not unique**: one `(compartiment, grootheid)` pair fans
out roughly 2.2× into streams differing by instrument, sampling height and sampling method. `a12`
returns 50 series from 19 quantity pairs; `ijgeul.1` returns 131 from 16. That constraint would have
silently discarded 49 of `a12`'s 50 streams.

So each distinct AquoMetadata combination gets a synthetic `series_id`, with the dimensions stored
once in `series` and the hypertable referencing only the id. The alternatives were widening the key
across the whole hypertable (expensive at ~190M rows) or keeping one series per quantity and dropping
the rest (irreversible data loss). Upserts conflict on a canonical `natural_key` rather than a
twenty-column `ON CONFLICT` target.

The map still shows one series per quantity — `findSeries` picks the richest — so this complexity
stays out of the UI while the data underneath stays whole.

## Caching and freshness

- **Locations and catalogue**: refreshed on a schedule, persisted, never fetched in a request path.
- **Observations**: served from the local store. A window not covered locally triggers a live
  upstream fetch, which is then stored — this is what makes the API useful before the Phase 4
  backfill, and the lazy path for quantities that are never eagerly backfilled afterwards. Windows
  longer than 92 days are left to the batch pipeline rather than fetched while a user waits.
- **On upstream failure**: whatever is stored locally is still served, flagged `stale: true` with a
  `fetchedAt`. Only a request with nothing at all to serve becomes a 502.
- **Outbound calls** are capped at 4 concurrent with exponential backoff and full jitter, so retries
  from separate workers do not synchronise.

Quality filtering happens at **read** time. The raw `Kwaliteitswaardecode` is always stored, so
changing display policy never means re-downloading history. The default view shows the codes
waterinfo.rws.nl itself displays; `?includeAllQuality=true` opts out.

## API

| Endpoint | Notes |
| --- | --- |
| `GET /api/locations` | Active only by default. `includeInactive`, `grootheid`, `compartiment`, `bbox`, `q`, `limit` |
| `GET /api/locations/:code` | Location plus every published measurement type and its local coverage |
| `GET /api/locations/:code/latest` | Latest **reading** per series, skipping trailing gaps |
| `GET /api/locations/:code/observations` | `grootheid` required; `from`, `to`, `resolution`, `includeAllQuality` |
| `GET /api/quantities` | Quantities and compartments with active-location counts, for filter UI |
| `GET /api/health` | Upstream reachability, cache age, location counts, backfill progress |

ISO 8601 UTC timestamps throughout. Errors are always `{ error: { code, message } }`. An upstream 204
becomes `200` with an empty array; an upstream failure becomes `502`.

`observations` picks raw rows for short windows and the hourly or daily aggregate for longer ones,
capped at `MAX_POINTS_PER_RESPONSE`. The response always states the `resolution` actually served
alongside the `requestedResolution`, so a client can say it is showing aggregated data rather than
quietly drawing a different thing than was asked for.

## Data quirks

Each of these was observed on the live service and is covered by a test.

- **Gaps carry a 99999 sentinel.** Quality code `99` arrives with `Waarde_Numeriek: 99999` against
  real readings of 90–420 on the same series. Storing that as a number would poison every
  min/max/mean. `value_numeric` is null for gaps; the raw text and code are kept.
- **There is no DST hazard.** The archive returns a constant `+01:00` year-round — fixed CET, not
  Dutch local time. Verified across both 2025/2026 transitions: no `+02:00`, no duplicated or missing
  hour. Conversion to UTC is an unconditional one-hour subtraction.
- **Both period endpoints are inclusive**, so adjacent month chunks overlap by one timestamp. Harmless
  given idempotent upserts, but chunk row counts will not sum to the table total.
- **Series arrive split** across several `MetingenLijst` entries and must be merged by identity, not
  array position. Duplicate timestamps collapse, and a real reading always beats a gap.
- **The count endpoint is slower than the data.** `OphalenAantalWaarnemingen` took 5–200 s per
  location against ~1 s to fetch a real month. It is deliberately *not* used to pre-flight the
  backfill; it stays available for planning.
- **The WFS layer's `KWALITEITSWAARDE_CODE` is a different code list** (`1004`) from the observation
  API's (`00`, `99`). They must not be compared.
- **CSV and GeoJSON disagree on axis order**: the CSV emits `POINT (lat lon)`, GeoJSON `[lon, lat]`.

### Surviving a bad download

The location layer is ~940k rows. Live runs delivered 68% and 92% of it before the stream degraded
into field-shifted garbage — rows where a name fragment lands in the code column and the timestamp
parses as year 9007. An earlier run wrote 440 such junk locations before this was caught.

The refresh now defends in three places: it pages the download (~100k features per request, so a bad
page is retried in seconds rather than restarting 173 MB), it validates every row's code shape and
timestamp plausibility, and it compares the parsed total against the layer's own `resultType=hits`
count, refusing to reconcile `active` flags if too much is missing. Declining to refresh is always
recoverable; mass-deactivating two-thirds of the map is not.

## Frontend

A React + Vite app rendering a MapLibre GL map over PDOK's grey Dutch basemap (free, no API key).

**Clustering is native to the GeoJSON source**, not a plugin: markers are one GPU circle layer, so
several thousand points cost one draw call rather than that many DOM nodes. Clicking a cluster zooms
to its expansion level; clicking a marker opens the detail panel.

**Marker colour encodes freshness, never value.** Values across quantities share no scale — a water
level in cm and a wind speed in m/s are not comparable — so colouring by value would imply a
comparison that does not exist. The two states use the reserved status colours, validated for
colour-vision deficiency (worst-pair ΔE 11.3 protan, 27.6 normal vision). Because the "delayed"
yellow sits below 3:1 on a light surface, it never carries meaning alone: every marker gets a dark
ring, the legend names both states with their thresholds, and the panel prints the exact timestamp.

The layers are added on the style's `style.load`, deliberately **not** on `load`. `load` waits for
the first basemap tiles, so an unreachable or slow tile provider would take the entire data layer
down with it. The markers are the product; the basemap is decoration.

Other behaviour worth knowing: filters are driven server-side (`grootheid`, `compartiment`, `q`), the
compartment list narrows to what the chosen quantity can actually yield so the two filters cannot
combine into an empty map, search is debounced and flies the map to a unique match, and every state
has an explicit rendering — loading skeletons, an empty state naming what to change, and an error
notice — never a silent blank. On screens under 720px the sidebar becomes a bottom sheet.

### The detail panel and chart

Clicking a marker opens a panel with the location's identity, freshness with an explicit timestamp,
the latest reading as a headline number, a measurement picker, a period selector (24h / 48h / 7d /
30d / 1y) and a chart, plus a deep link to the matching waterinfo.rws.nl page.

The chart is hand-rolled inline SVG rather than a charting library: the requirement is one line, one
band, an axis pair and a crosshair, and owning the markup keeps theming, the aggregate band and the
accessibility story straightforward for about 200 lines.

**The client picks the resolution** — raw for 24h and 48h, hourly for 7d and 30d, daily for a year —
so the one-year view never begins by asking for 52,000 raw points. The server may coarsen further
under its own point cap and always reports what it actually served; when the two differ the panel
says so rather than quietly drawing something other than what was asked for.

**When the data is aggregated, it looks aggregated:** a min–max band sits behind the mean line, and
the caption names it. The tooltip adds the bucket's range and reading count. A gap in the series
breaks the line rather than drawing a straight segment across it, which would invent measurements
that were never taken.

Design rules the chart follows: a 2px line with round caps, the band as a ~10% wash of the same hue,
hairline solid gridlines one step off the surface, one y-axis only, and text in text tokens rather
than the series colour. The crosshair snaps to the nearest point so the reader aims at a time rather
than at a 2px line, and the tooltip leads with the value because the reader already knows the series.
Tooltips never gate a value: the latest reading is a headline number, the endpoint carries a dot, and
**Show values** opens a table of the underlying numbers.

If a location has no stored history for a measurement, the panel says so and names the fix — short
periods are fetched on demand, and the full year comes from the batch backfill — rather than
rendering an empty chart.

## Backfill

A batch pipeline, not a loop in a route handler. The unit of work is
`(location_code, compartiment, grootheid, month)` — one month per request keeps responses manageable
and makes a failure cheap to retry.

**Crash safety is the design centre.** A chunk is marked `done` in the *same transaction* that
commits its rows, so either both land or neither does. A killed process can never leave a chunk
recorded as complete while its data is missing. Verified by `SIGKILL`ing a running backfill: 24
chunks done, 132 pending, 4 stale claims, and zero chunks marked done without data.

Resuming is the default rather than a mode — planning never resets a completed chunk, so re-running
the same command picks up exactly where it left off. A crashed worker leaves its claims behind;
those are returned to the queue after an age threshold (`--reclaim-after`, default 30 minutes, set
`0` when you know the only worker died). The threshold exists so a *live* worker's claims are never
stolen, which is what lets several workers drain one queue via `SELECT … FOR UPDATE SKIP LOCKED`.

**Tiering lives in exactly one place**, `src/backfill/tiers.ts`, and is driven by the Phase 1
measurements. The brief's Tier 1 (`WATHTE` + `Q`) turned out to be only 18.7% of volume, while
current direction, current speed and echo sounding are ~31% between them and are near-useless in a
general map panel. So the default is eager-with-a-deferred-list rather than an eager allowlist:
everything is backfilled except those three, which arrive lazily on first request.
`BACKFILL_DEFERRED=` (empty) asks for a full eager backfill without touching code.

**The count endpoint is deliberately not used to skip empty months.** The brief proposes
pre-flighting each chunk with `OphalenAantalWaarnemingen`; Phase 1 measured that at 5–200 s per
location against ~1 s to fetch a real month, so checking first costs more than it saves. An upstream
204 is already a cheap "no data" answer and marks the chunk `empty`. `--check-counts` opts back in.

**Corrections.** The archive publishes early as `ongecontroleerd` and revises in place, so
`backfill refetch` re-downloads a rolling window (60 days by default) through the same idempotent
upsert. Verified idempotent: re-fetching 230,503 rows left the table's row count unchanged and
advanced `fetched_at`. The window sits comfortably inside the 90-day compression delay, so the
re-fetch never has to rewrite a compressed chunk.

Continuous aggregates are refreshed **once per run over the written range**, not per chunk. The
scheduled policies only cover recent time, so backfilled history would otherwise never be
materialised and a one-year chart would come back empty; doing it per chunk would mean tens of
thousands of refreshes of the same buckets.

Progress is observable from both sides: the CLI prints chunks done/total, rows, throughput, ETA and
failure count, and `/api/health` reports the same figures.

Set `ENABLE_SCHEDULES=true` on exactly one instance to run the daily refresh and weekly correction
re-fetch in-process.

## Tests

```sh
npm test
```

Unit tests run the normalisers against fixtures recorded from the live service in Phase 1 — they
never touch the network. Integration tests exercise the API through Fastify against a throwaway
database and a mocked upstream; they skip themselves with a warning if no database is reachable, so
the suite stays useful without one.

Raw spike dumps are gitignored (the WFS layer alone is 173 MB). The trimmed, shape-preserving subsets
the tests build on are committed in `fixtures/trimmed/`, regenerable with `node spike/trim-fixtures.mjs`.

## Verified and unverified

Everything below was run rather than assumed, except where noted.

**Verified against the live service:** the full ingest (942,378 rows parsed, 2,595 locations, 567
active — matching an independent Phase 1 count exactly), the on-demand observation path, a crash-safe
backfill (`SIGKILL` mid-run left zero chunks marked done without data, and the resume recovered
cleanly), an idempotent correction re-fetch (230,503 rows rewritten, row count unchanged), and the
map and detail panel in a real browser, both from the dev server and from the production
single-origin build. 89 tests pass.

**Not verified:** the Docker image and `docker compose up` have never actually run — there was no
Docker daemon available in the environment this was built in. The compose file is validated for
syntax and the CI workflow builds the image on every push, so the first real `docker compose up`
should be treated as the smoke test it is.

**Not yet run at scale:** the full backfill. The database has been exercised with ~924k rows across a
handful of locations, not the ~190M across 567 that a year of history for every active location would
hold. Phase 1's projections (~23 GB uncompressed, ~8 h for everything, ~2.5 h for the eager tier)
are measured extrapolations, not observations.

**Deliberately out of scope:** authentication (the data is public and the API read-only), multi-region
or HA deployment, and metrics beyond `/api/health`.

## Attribution

Data is from Rijkswaterstaat and subject to their terms — see
<https://rijkswaterstaatdata.nl/waterdata/>. This project is not affiliated with or endorsed by
Rijkswaterstaat.
