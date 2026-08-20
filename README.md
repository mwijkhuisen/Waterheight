# rws — Rijkswaterstaat monitoring map

A map of the Netherlands showing the measurement locations Rijkswaterstaat monitors, backed by a thin
API over the official Rijkswaterstaat WaterWebservices (WADAR / `ddapi20`).

**Status: complete.** Schema, ingestion, API, backfill pipeline, and a registry-style frontend —
global search, a result list, and a page per location with charts over the full history, plus the
clustered map. The full brief is in [`PROMPT.md`](PROMPT.md); the Phase 1
measurements that shaped these decisions are in
[`spike/PHASE1-FINDINGS.md`](spike/PHASE1-FINDINGS.md).

What has actually been exercised, and what has not, is listed under
[Verified and unverified](#verified-and-unverified) — worth reading before deploying.

## Deploying

The app is one process: the API also serves the built map client, so the whole thing is one origin
and the browser never needs CORS. It needs PostgreSQL with TimescaleDB, and nothing else.

Two supported paths. They install the same thing; pick whichever suits the machine.

### On Ubuntu, without Docker

Full walkthrough, including running alongside an existing MariaDB/MySQL, TLS, operations and
troubleshooting: **[`docs/INSTALL-UBUNTU.md`](docs/INSTALL-UBUNTU.md)**.

```sh
git clone https://github.com/mwijkhuisen/rws.git /opt/rws
cd /opt/rws
sudo ./deploy/install-ubuntu.sh
```

That installs Node, PostgreSQL and TimescaleDB from apt, creates the role and database, builds the
server and the client, writes `.env`, applies migrations and installs a systemd unit. It is
idempotent, so it is also the upgrade path.

Two things worth knowing before you run it:

- **Ubuntu packages Node 18**, and this needs >= 20, so the script installs from NodeSource. Plain
  `apt install nodejs` produces a build that fails at runtime.
- **PostgreSQL comes from PGDG**, not Ubuntu's archive, which carries only one major per release
  (16 on 24.04, 18 on 26.04). The script picks a major both PGDG and Timescale can satisfy,
  preferring 16 for parity with `docker-compose`; `--pg-major` overrides.
- **If MariaDB or MySQL is on the same box**, they coexist fine — different ports, data directories
  and units. The one real conflict is memory: `timescaledb-tune` sizes PostgreSQL's caches as though
  it owned all the RAM. The script detects the other engine and budgets half; `--pg-memory 4GB`
  overrides it.

```sh
systemctl status rws-api
journalctl -u rws-api -f
```

It listens on 3000 by default. `--port 3002` sets that on a first install, and
`PORT` in `.env` changes it afterwards — the client uses relative paths, so it follows the server
wherever it listens.

### With Docker

```sh
cp .env.example .env
# POSTGRES_PASSWORD has no default — compose refuses to start until you set it,
# so a known credential can never ship by accident.
$EDITOR .env

docker compose up -d --build          # database, migrations, then the app on :3000
```

The API container carries the daily refresh, the weekly correction re-fetch and the five-minute
latest poll (`ENABLE_SCHEDULES`, on by default in compose). If you scale it past one replica, turn
that off and run the schedules on a single worker instead, or several instances will hit
Rijkswaterstaat with the same job.

### Either way, the database starts empty

Migrations create the schema; they do not fetch anything. Nothing appears on the map until the
location layer is loaded — see [Loading data](#loading-data) next.

Health is at `/api/health`, which the compose healthcheck already uses. It reports upstream
reachability, cache age, location counts and backfill progress.

### Before you expose it publicly

- Put TLS in front of it. The app speaks plain HTTP and trusts `X-Forwarded-*`, so it expects a proxy.
- Set `CORS_ORIGIN` if you do not want third parties calling the API from a browser.
- Tune `RATE_LIMIT_MAX` (default 300/min per IP). This protects the upstream budget as much as this
  service: `/observations` can trigger live fetches to Rijkswaterstaat.
- The database port is not published by default — only the API container reaches it.

## Loading data

Two separate things: the **location layer**, which the map cannot work without, and **history**,
which is optional and can be loaded whenever.

Commands below are written for a native install from the repository root. Under Docker, prefix them
with `docker compose exec api` (or `docker compose run --rm migrate` before the API is up).

### The location layer — required, ~6 minutes

```sh
node packages/server/dist/cli/refresh.js
```

Loads the Aquo catalogue (~1.2 s) and streams the WFS location layer — ~940,000 features covering
~2,600 locations, about 173 MB. After it finishes the map works immediately: observations for short
periods are fetched from Rijkswaterstaat on demand and cached.

With `ENABLE_SCHEDULES=true` this then repeats daily on its own, so it is a one-off command.

### Live readings — the five-minute poll

The location layer is a daily snapshot; live readings come from the poll. It pulls the newest
reading of every live series on a fixed cadence, so *now* is already in the store when someone asks
for it and the only traffic upstream is the poll's own — not one call per visitor.

```sh
node packages/server/dist/cli/latest.js --dry-run   # the plan and what it costs, fetches nothing
node packages/server/dist/cli/latest.js             # one cycle
node packages/server/dist/cli/latest.js --watch     # keep polling on the configured interval
```

With `ENABLE_SCHEDULES=true` the API runs it every five minutes and on startup, so normally there is
nothing to run by hand. `--watch` is for a deployment scaled past one instance: turn the schedules
off there and let one worker poll while every instance serves what it wrote.

A cold store has no series to poll, so the first cycles are mostly discovery — the poll probes 50
pairs it has no live series for, oldest first, and the polled set grows until the whole active
network is covered a few hours later. `--discovery 500` hurries that along.

It only ever adds the *newest* reading per series. Full history is still the backfill's job, and a
series publishing faster than the poll interval will have gaps between poll cycles until the
[rolling re-fetch](#keeping-history-correct-afterwards) fills them in.

### Loading history

Everything past the on-demand window comes from the backfill CLI. **The default window is the last
365 days**, which is the "one year back" case:

```sh
node packages/server/dist/cli/backfill.js --dry-run   # plan and projection, downloads nothing
node packages/server/dist/cli/backfill.js             # the real thing, ~2.5 h for the eager tier
node packages/server/dist/cli/backfill.js status      # progress, throughput, ETA, failures
```

Always run `--dry-run` first. It prints the chunk count, the projected row count and disk, and an
ETA, without touching the network — which is how you find out what a full year costs before you
start downloading it. The projection scales with how many locations are currently active, so treat
its output as the number, not the figures quoted here: a run against 568 active locations planned
43,095 chunks, ~88 M rows and ~10.6 GB at ~3 h, while the Phase 1 projection over the whole network
was ~190 M rows and ~23 GB.

**Just the last few days**, which is the common catch-up after downtime:

```sh
node packages/server/dist/cli/backfill.js --from 2026-08-13          # explicit start, to now
node packages/server/dist/cli/backfill.js --from 2026-08-01 --to 2026-08-14
```

`--from`/`--to` take any parseable date. Chunks are whole months internally, so a narrow window
still fetches the months it touches; that is idempotent and cheap to repeat.

**A full year, including the deferred quantities.** Current direction, current speed and echo
sounding are excluded by default — ~31% of total volume, and rarely what someone opens the map for.
They arrive lazily on first request. To fetch them up front as well:

```sh
node packages/server/dist/cli/backfill.js --include-deferred         # ~8 h rather than ~2.5 h
```

**Prove it on a small slice first**, before letting it run for hours:

```sh
node packages/server/dist/cli/backfill.js --locations vlissingen --limit 20
```

Useful flags: `--locations a,b` and `--quantities WATHTE,Q` to narrow, `--concurrency n` to change
the outbound rate (default 4, deliberately polite), `--tier eager|deferred` to drain one tier,
`--limit n` to stop early.

#### It is resumable, so a long run is safe

A chunk is marked done in the *same transaction* that writes its rows, so a kill can never leave a
chunk recorded as complete with its data missing. Re-running the same command continues where it
stopped rather than starting over — resuming is the default, not a mode.

For a run measured in hours, use the unit rather than an SSH session, so a disconnect does not take
it down:

```sh
sudo systemctl start rws-backfill      # logs to the journal, resumable, Ctrl-C-safe
journalctl -u rws-backfill -f
sudo systemctl stop rws-backfill       # drains in-flight chunks and exits cleanly
```

If chunks failed — an upstream blip, usually:

```sh
node packages/server/dist/cli/backfill.js status         # what failed and why
node packages/server/dist/cli/backfill.js retry-failed   # return them to the queue
node packages/server/dist/cli/backfill.js               # drain it again
```

After a crash that you know killed the only worker, `--reclaim-after 0` returns its abandoned claims
immediately instead of waiting out the 30-minute threshold that protects a live worker's claims.

#### Keeping history correct afterwards

Rijkswaterstaat publishes early as `ongecontroleerd` and revises in place, so recent history changes
under you. The rolling re-fetch re-downloads a window through the same idempotent upsert:

```sh
node packages/server/dist/cli/backfill.js refetch                    # last 60 days
node packages/server/dist/cli/backfill.js refetch --refetch-days 90
```

With `ENABLE_SCHEDULES=true` this runs weekly on its own. The 60-day default sits inside the 90-day
compression delay, so it never has to rewrite a compressed chunk.

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

Without Docker, replace the `docker compose up -d db` line with a local PostgreSQL that has
TimescaleDB — steps 2 and 3 of [`docs/INSTALL-UBUNTU.md`](docs/INSTALL-UBUNTU.md) — and point
`DATABASE_URL` at it. Everything else is the same.

`.env` is resolved relative to the application rather than the shell's working directory, so the
`npm run` scripts pick up the repository-root `.env` even though npm runs them from
`packages/server`. `ENV_FILE=/path/to/.env` overrides it; real environment variables beat both.

The latest poll in development:

```sh
npm run latest -- --dry-run          # calls the cycle would make, fetches nothing
npm run latest                       # one cycle
npm run latest -- --discovery 500    # warm a cold store faster than 50 pairs a cycle
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
OphalenLaatsteWaarnemingen       ──► ingest/latest    ──┤
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
- **Live readings**: pulled by the five-minute poll, so the newest value of every live series is
  already stored when a request arrives. Nothing in the read path fetches them.
- **Observations**: served from the local store. A window not covered locally triggers a live
  upstream fetch, which is then stored — this is what makes the API useful before the Phase 4
  backfill, and the lazy path for quantities that are never eagerly backfilled afterwards. Windows
  longer than 92 days are left to the batch pipeline rather than fetched while a user waits.
  `LIVE_FETCH_ON_REQUEST=false` closes that path entirely, so every upstream call comes from the
  scheduler and visitor traffic can never reach Rijkswaterstaat's rate limit.
- **On upstream failure**: whatever is stored locally is still served, flagged `stale: true` with a
  `fetchedAt`. Only a request with nothing at all to serve becomes a 502.
- **Outbound calls** are capped at 4 concurrent with exponential backoff and full jitter, so retries
  from separate workers do not synchronise.

### What the poll costs upstream

`OphalenLaatsteWaarnemingen` answers a (compartiment, grootheid) pair with **every** series a
location ever ran for that quantity — 1900 included — each carrying a full ~1.5 KiB AquoMetadata
block. Asked bare, 18 locations wanting `CONCTTE` returned 4,622 series and 7.6 MB in 9.2 s, of
which 44 series carried a reading from the last six hours. Adding the parameter, instrument and
determination method those series are already known to use returned the same 44 live readings in
137 KiB and 0.44 s.

So the poll asks narrowly, from what the `series` table already knows, and packs several filters
into each call. Measured over 1,744 live series on 2026-08-20, against the live service:

| Filters per call | Calls | Downloaded | Live series found |
| --- | --- | --- | --- |
| One | 140 | 4.5 MiB | 1,720 |
| Four | 35 | 5.1 MiB | 1,721 |
| Sixteen | 9 | 6.7 MiB | 1,734 |
| Default (`LATEST_POLL_MAX_COMBINATIONS=2000`) | **8** | 6.6 MiB | 1,744 |

Packing costs bytes and saves calls, and finds slightly *more* than one filter per call does: the
cross product surfaces live series at locations our own metadata had not associated with that
filter, which is data we wanted anyway. The default trades a third more bandwidth for seventeen
times fewer calls, on the grounds that a service asking clients to identify themselves for future
rate limiting will count calls before bytes. Raise the cap for fewer, larger calls; lower it for
more, leaner ones.

A reading the store already has is recognised from `last_observed_at` and not rewritten, so a
five-minute poll against a ten-minute publish cadence writes on every other cycle rather than
churning `fetched_at` on every one.

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
| `GET /api/health` | Upstream reachability, cache age, last poll, location counts, backfill progress |

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

A React + Vite app laid out as a **package registry**: a persistent masthead with global search, a
results list, and a page per measurement location carrying tabs and a metadata rail. Search is the
primary way in; the map is one of the views it leads to rather than the shell everything hangs off.

| Route | What it is |
| --- | --- |
| `/` | Hero search, catalogue stats, browse-by-measurement-type, recently published |
| `/search?q=&grootheid=&compartiment=&sort=&page=` | Result list with facets and sorting |
| `/location/:code` | One location: Overview / Measurements / Data / Map, plus the metadata rail |
| `/map` | The full clustered map, filtered |
| `/docs` | API reference |

Routing is a ~130-line history-based router rather than a dependency: four routes, a `Link` that
leaves modifier-clicks to the browser, and a `popstate` subscription. Real paths, not a hash — Vite
and the Fastify `setNotFoundHandler` both already serve `index.html` for unknown non-`/api` paths, so
deep links work in dev and production alike.

**All page state lives in the URL.** Filters, sort, pagination and the active tab are query
parameters, so any view is a shareable link and the back button walks the refinement rather than
dumping you at the home page. Filter changes `replaceState` (a run of typing does not bury the
previous page under a dozen history entries); a tab change pushes.

**Each route loads its own data.** There is no shell state to inherit, so a deep link lands on a
complete page. The quantity/compartment catalogue is fetched once per page load and shared, since it
backs the header, the facets and the browse grid and changes on the order of days.

**MapLibre is code-split.** It and its stylesheet are about nine tenths of the JavaScript here and
only two routes render a map, so it loads on demand — the entry bundle is 201 kB (63 kB gzipped)
against 1.26 MB (351 kB) when the map was the shell. Note that MapLibre adds `.maplibregl-map` to the
map container and its stylesheet now arrives *after* the app's, so the container is sized by
`width/height: 100%` rather than absolute fill: a `position: absolute` there loses the tie and
collapses the map to zero height.

### The map

**Clustering is native to the GeoJSON source**, not a plugin: markers are one GPU circle layer, so
several thousand points cost one draw call rather than that many DOM nodes. Clicking a cluster zooms
to its expansion level; clicking a marker opens a card that links into the location page, so the map
feeds the same detail pages as everything else.

**Marker colour encodes freshness, never value.** Values across quantities share no scale — a water
level in cm and a wind speed in m/s are not comparable — so colouring by value would imply a
comparison that does not exist. The two states use the reserved status colours, validated for
colour-vision deficiency (worst-pair ΔE 11.3 protan, 27.6 normal vision). Because the "delayed"
yellow sits below 3:1 on a light surface, it never carries meaning alone: every marker gets a dark
ring, the legend names both states with their thresholds, and the location page prints the exact
timestamp.

The layers are added on the style's `style.load`, deliberately **not** on `load`. `load` waits for
the first basemap tiles, so an unreachable or slow tile provider would take the entire data layer
down with it. The markers are the product; the basemap is decoration.

### The location page

The main column carries the tabs — **Overview** (headline reading, period selector, chart, latest
values), **Measurements** (every series with its stored coverage), **Data** (the request that
produced the view, and the response as a table) and **Map**. The rail carries what a registry keeps
there: the `curl` that fetches it, the latest reading, stored points and history span, last publish,
coordinates, source links, the quantities as chips, and the licence.

Filters are driven server-side (`grootheid`, `compartiment`, `q`), the compartment list narrows to
what the chosen quantity can actually yield so the two filters cannot combine into an empty map, the
header search is debounced with a keyboard-navigable typeahead, and every state has an explicit
rendering — loading skeletons, an empty state naming what to change, and an error notice — never a
silent blank.

### The chart

Hand-rolled inline SVG rather than a charting library: the requirement is one line, one band, an axis
pair and a crosshair, and owning the markup keeps theming, the aggregate band and the accessibility
story straightforward for about 200 lines.

**The client picks the resolution** — raw for 24h and 48h, hourly for 7d and 30d, daily for a year —
so the one-year view never begins by asking for 52,000 raw points. The server may coarsen further
under its own point cap and always reports what it actually served; when the two differ the page says
so rather than quietly drawing something other than what was asked for.

**When the data is aggregated, it looks aggregated:** a min–max band sits behind the mean line, and
the caption names it. The tooltip adds the bucket's range and reading count. A gap in the series
breaks the line rather than drawing a straight segment across it, which would invent measurements
that were never taken.

Design rules the chart follows: a 2px line with round caps, the band as a ~10% wash of the same hue,
hairline solid gridlines one step off the surface, one y-axis only, and text in text tokens rather
than the series colour. The crosshair snaps to the nearest point so the reader aims at a time rather
than at a 2px line, and the tooltip leads with the value because the reader already knows the series.
Tooltips never gate a value: the latest reading is a headline number, the endpoint carries a dot, and
**Show values** opens a table of the underlying numbers. Axis ticks carry the date once a window
spans more than a day — the default 48h view would otherwise label all three ticks with the same
clock time.

If a location has no stored history for a measurement, the page says so and names the fix — short
periods are fetched on demand, and the full year comes from the batch backfill — rather than
rendering an empty chart.

### Look and feel

The palette is the npm registry's: a black masthead, white paper, hairline borders, and one red
(`#cb3837`) for the mark, active tabs and the search button. It is 5.05:1 on white, so it is safe as
text as well as decoration; on the dark scheme it falls to 3.6:1, so a lighter step carries text
there while the brand red stays on the mark and the rules. Colours are role tokens, so the dark
scheme is a token swap in one place. Type is the system stack with a monospace family for codes and
commands — no webfont request, so nothing about the layout waits on a third party.

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

Set `ENABLE_SCHEDULES=true` on exactly one instance to run the daily refresh, the weekly correction
re-fetch and the five-minute latest poll in-process. `/api/health` reports `cache.latestPolledAt`
and goes `degraded` if the poll has run but not for four intervals, so a poll that has quietly
stopped shows up as stale live data rather than as nothing at all.

## Tests

```sh
npm test
```

Unit tests run the normalisers against fixtures recorded from the live service in Phase 1 — they
never touch the network. Integration tests exercise the API through Fastify against a throwaway
database and a mocked upstream; they skip themselves with a warning if no database is reachable, so
the suite stays useful without one.

**A green run with the integration tests skipped is not a green run.** The full suite is 89 tests;
if you see 60 passing and 29 skipped, no database was reachable. They read `TEST_DATABASE_URL` from
`.env`, and because each run creates and drops a database of its own, that role needs `CREATEDB`:

```sh
sudo -u postgres psql -c "ALTER ROLE rws CREATEDB"
```

Raw spike dumps are gitignored (the WFS layer alone is 173 MB). The trimmed, shape-preserving subsets
the tests build on are committed in `fixtures/trimmed/`, regenerable with `node spike/trim-fixtures.mjs`.

## Verified and unverified

Everything below was run rather than assumed, except where noted.

**Verified against the live service:** the full ingest (942,378 rows parsed, 2,595 locations, 567
active — matching an independent Phase 1 count exactly), the on-demand observation path, a crash-safe
backfill (`SIGKILL` mid-run left zero chunks marked done without data, and the resume recovered
cleanly), an idempotent correction re-fetch (230,503 rows rewritten, row count unchanged), and the
map and detail panel in a real browser, both from the dev server and from the production
single-origin build. 110 tests pass.

**Verified for the latest poll:** run against the live service on a store holding the real location
layer (2,595 locations, 568 active, 3,406 active location+quantity pairs). Discovery found 1,744
live series across 750 probed pairs and the poll then kept them current in 8 calls and 6.6 MiB per
cycle, in 5.6 s, recognising 1,719 of 1,744 readings as ones it already had. The narrowing and
packing figures in [What the poll costs upstream](#what-the-poll-costs-upstream) are measurements
from that run, not projections. The remaining ~2,650 pairs were left undiscovered rather than
rushed upstream, so a cycle covering the *whole* active network is an extrapolation from those
numbers (~36 calls, ~30 MiB) rather than an observation.

**Verified for the registry-style frontend:** every route rendered in headless Chromium against a
stubbed API — light and dark schemes, desktop and 390px widths — with no page errors, plus the
typeahead (arrow keys and Enter into a location page), tab state surviving a reload, the back button,
and facet clicks rewriting the query string. `service.pdok.nl` and `demotiles.maplibre.org` are
unreachable from the build environment, so the map's data layer was confirmed with those two hosts
stubbed: style loaded, source loaded, clusters rendered. It has *not* been run against the live API
or a real basemap since the refactor.

**Not verified:** the Docker image and `docker compose up` have never actually run — there was no
Docker daemon available in the environment this was built in. The compose file is validated for
syntax and the CI workflow builds the image on every push, so the first real `docker compose up`
should be treated as the smoke test it is.

**Found while building the poll, not fixed:** the WFS layer stamps `TIJDSTIP_LAATSTE_METING` in
Dutch local time but labels it `Z`, so `locations.last_seen_at` and `location_quantities.last_seen_at`
sit up to two hours in the future — `aadorp` was stored as `13:30Z` while the observation API's
newest reading for it was `11:40Z`. The observation path is unaffected (it reads the fixed `+01:00`
the archive returns and converts correctly). The poll writes true UTC and both columns only ever
move forward, so its readings simply do not advance freshness until real time passes the layer's
figure — a couple of hours after each daily refresh. Fixing it means deciding whether the layer
follows Europe/Amsterdam or the archive's fixed CET, which cannot be settled from summer data alone.

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
