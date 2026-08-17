# Rijkswaterstaat monitoring map — project brief

Build a web application that shows a map of the Netherlands with all measurement locations that
Rijkswaterstaat monitors, backed by a small API of my own that wraps the official Rijkswaterstaat
WaterWebservices.

## Context you need before writing any code

Rijkswaterstaat publishes its water data (the same data behind https://waterinfo.rws.nl/) through
the **WaterWebservices**. These were migrated to the WADAR archive system; the classic
`waterwebservices.rijkswaterstaat.nl` and `waterwebservices.beta.rijkswaterstaat.nl` hosts were shut
down at the end of April 2026. Use only the endpoints below. Do not invent endpoints, and do not
scrape waterinfo.rws.nl's internal frontend API.

**Base URL:** `https://ddapi20-waterwebservices.rijkswaterstaat.nl`

All of these are `POST`, `Content-Type: application/json`. Send a dummy `X-API-KEY` header — it is
not required today but Rijkswaterstaat asks clients to include it so future key-based rate limiting
does not break them.

| Endpoint | Purpose |
| --- | --- |
| `/METADATASERVICES/OphalenCatalogus` | Catalogue of locations + available quantities |
| `/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen` | Latest observation per location/metadata combo |
| `/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen` | Time series for one location + period |
| `/ONLINEWAARNEMINGENSERVICES/CheckWaarnemingenAanwezig` | Cheap existence check for a period |
| `/ONLINEWAARNEMINGENSERVICES/OphalenAantalWaarnemingen` | Observation **counts**, grouped by `Groeperingsperiode` (`Jaar` / `Maand` / `Dag`) |

`OphalenAantalWaarnemingen` is the key to a sane backfill: it lets you find out how many points a
series actually has per month *before* downloading anything. Its request shape mirrors
`CheckWaarnemingenAanwezig` (`AquoMetadataLijst` + `LocatieLijst` + `Periode`) plus a
`"Groeperingsperiode"` field.

There is also a `BulkWaarnemingenService` / `AanvragenBulkWaarnemingen` operation documented for the
classic services, which queues a file for later download. Probe whether it still exists on
`ddapi20`. If it does, prefer it for the backfill; if it 404s, fall back to chunked
`OphalenWaarnemingen` calls as described below. Do not block on this — report what you find and move on.

There is also an OGC service which is often the *fastest* way to get all locations with their most
recent value, and it returns coordinates ready for mapping:

```
https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows
  ?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature
  &TYPENAME=locatiesmetlaatstewaarneming
  &outputFormat=csv
```

`TYPENAME=locaties` gives *all* possible water-management locations (with or without data);
`locatiesmetlaatstewaarneming` gives only those with a current observation, plus the value. Probe
`REQUEST=GetCapabilities` on that same URL first and check whether GeoJSON
(`outputFormat=application/json`) is offered — prefer GeoJSON over CSV if it is, and fall back to
CSV parsing if not.

### Scope: actively reporting locations only

**`locatiesmetlaatstewaarneming` is the authoritative source for which locations exist in this
application.** Do not ingest the full `locaties` layer. Concretely:

- A location enters the system only if it appears in `locatiesmetlaatstewaarneming`.
- Apply a freshness cut-off on top of that: a location counts as *active* if its latest observation
  is newer than `ACTIVE_WINDOW` (default 7 days, configurable). Some entries in that layer are
  stale by months; they should not show up as live markers.
- Store `active: boolean` and `lastSeenAt` rather than deleting rows. A station that goes quiet for
  maintenance should reappear when it resumes, and its history must survive the gap. Never hard-delete
  a location or its measurements.
- Log every activation and deactivation so a shrinking map is explainable rather than mysterious.
- Report the count in Phase 1: how many locations are in `locaties`, how many in
  `locatiesmetlaatstewaarneming`, and how many pass the 7-day freshness test. Those three numbers
  drive every sizing decision later.

### Example request bodies (verified against the official docs — use these verbatim as your starting point)

Catalogue:

```json
{"CatalogusFilter": {"Compartimenten": true, "Grootheden": true, "Parameters": true, "Eenheden": true}}
```

Latest observations:

```json
{
  "LocatieLijst": [{"Code": "vlissingen"}, {"Code": "hoekvanholland"}],
  "AquoPlusWaarnemingMetadataLijst": [
    {"AquoMetadata": {"Compartiment": {"Code": "OW"}, "Grootheid": {"Code": "WATHTE"}}}
  ]
}
```

Time series:

```json
{
  "Locatie": {"Code": "ameland.nes"},
  "AquoPlusWaarnemingMetadata": {
    "AquoMetadata": {
      "Compartiment": {"Code": "OW"},
      "Grootheid": {"Code": "WATHTE"},
      "ProcesType": "meting"
    }
  },
  "Periode": {
    "Begindatumtijd": "2026-08-01T00:00:00.000+02:00",
    "Einddatumtijd": "2026-08-08T00:00:00.000+02:00"
  }
}
```

### Behaviour and gotchas you must handle

- **Coordinates** come back as ETRS89 lat/lon (EPSG:4258), which is close enough to WGS84 to plot
  directly. Do not convert to RD/EPSG:28992 and do not send coordinates in requests — location
  `Code` is enough.
- **`OphalenCatalogus` is slow.** Rijkswaterstaat lists this as a known issue. Fetch it on a
  schedule, persist the result, and never call it in the request path of a user page load.
- **HTTP 204 No Content** means "no data matched", not an error. Surface it as an empty series.
- **404 responses still carry a useful JSON body** — log and parse it instead of discarding.
- 400 = malformed body, 405 = you used GET instead of POST, 415 = missing `Content-Type`.
- **Series get split**: the same metadata can come back spread over several `MetingenLijst`
  entries, and `OphalenLaatsteWaarnemingen` may return several rows where you expect one. Merge and
  deduplicate on timestamp, keeping the most recent.
- **Quality codes**: waterinfo.rws.nl itself only displays values with
  `Kwaliteitswaardecode` in `["00","10","20","25","30","40"]`; `"99"` marks a gap. Filter for display
  but keep the raw code in the API response so consumers can decide.
- **Forecasts vs measurements**: filter `"ProcesType": "meting"` for observed values,
  `"verwacht"` / `"verwachting"` for predictions. There is no separate `WATHTEVERWACHT` quantity any
  more — it is `WATHTE` plus a ProcesType.
- **Location codes were unified** (e.g. `HOEK`, `HVH25` and `HOEKVHLD` all became
  `hoekvanholland`). Treat codes as lowercase dotted strings and match case-insensitively.
- `Meetwaarde.Waarde_Alfanumeriek` is always populated, even when the value parses as a number.

## What to build

### 1. Backend API (my own thin layer over RWS)

A server that normalises the RWS responses into clean JSON. It exists because the browser cannot
call RWS directly (CORS), because the catalogue is too slow to hit live, and because the RWS payload
shape is awkward.

Endpoints:

- `GET /api/locations` → array of `{ code, name, lat, lon, quantities: string[], lastSeenAt, active }`.
  Returns **active locations only** by default; `?includeInactive=true` opts in.
  Other query params: `grootheid`, `compartiment`, `bbox`, `q` (name search).
- `GET /api/locations/:code` → one location plus the full list of available measurement types and,
  per type, the period actually covered locally (`coverage: { from, to, points }`).
- `GET /api/locations/:code/latest` → latest value(s): `{ code, quantity, unit, value, timestamp, qualityCode, procesType }`.
- `GET /api/locations/:code/observations?grootheid=WATHTE&from=…&to=…&resolution=raw|hourly|daily`
  → normalised time series, served from the local store, falling back to a live upstream call only
  for periods outside what has been backfilled.
- `GET /api/quantities` → the catalogue's quantities/compartments, for building filter UI.
- `GET /api/health` → upstream reachability, cache age, backfill progress.

Rules: never leak raw RWS field names to the client; ISO 8601 timestamps everywhere; consistent
error envelope `{ error: { code, message } }`; sensible HTTP status mapping (upstream 204 →
`200` with an empty array, upstream failure → `502`).

### 2. Caching / ingestion

- A refresh job that pulls the WFS `locatiesmetlaatstewaarneming` layer (and the catalogue, for
  quantity metadata) and upserts locations into Postgres. Refresh daily.
- Latest observations cached with a short TTL (5–10 minutes; RWS publishes on a 10-minute cadence).
- Time series cached per `(location, quantity, period)` for a few minutes.
- On upstream failure, serve stale cache and mark it: include `stale: true` and `fetchedAt`.
- A rate limiter / concurrency cap on outbound calls so we are a polite API consumer.

### 3. Historical backfill (~1 year)

Every active location needs roughly one year of history so the detail panel can show real trends,
not just the last few hours. This is the heaviest part of the project — treat it as a proper batch
pipeline, not a loop in a route handler.

**Size it before you build it.** At a 10-minute cadence one series-year is about 52,500 points.
Multiply by the number of active locations times their quantities and you may be looking at tens of
millions of rows. In Phase 1, use `OphalenAantalWaarnemingen` with `"Groeperingsperiode": "Maand"`
across a representative sample of locations to get real counts, then report the projected total row
count, on-disk size, and estimated wall-clock download time before writing the ingester. If the
projection is uncomfortable, tell me and propose a narrower default scope rather than starting a
multi-day download.

**Prioritise rather than backfilling everything.**

1. Tier 1, backfilled eagerly: water level (`WATHTE`) and discharge (`Q`) for all active locations.
   This is what people actually look at.
2. Tier 2, backfilled lazily on first request for that location+quantity, then cached permanently.
3. Chemistry and low-frequency series: cheap in volume, so they can go in Tier 1 too — confirm with
   the counts from `OphalenAantalWaarnemingen`.

Make the tiering configurable in one place, not scattered through the code.

**Job design.**

- A persistent work queue where the unit of work is `(locationCode, grootheid, month)`. One month per
  request keeps responses to a manageable size and makes failures cheap to retry.
- Each job row carries a status (`pending` / `running` / `done` / `empty` / `failed`), an attempt
  count, the last error, and timestamps. The whole backfill must be **resumable**: killing the
  process and restarting it should pick up exactly where it left off, never re-downloading completed
  chunks.
- Skip work before doing it: call `OphalenAantalWaarnemingen` (or `CheckWaarnemingenAanwezig`) per
  location+quantity for the full year, grouped by month, and mark zero-count months `empty` without
  ever calling `OphalenWaarnemingen`. Note that the RWS issue tracker reports these count/check
  endpoints are not always perfectly consistent with `OphalenWaarnemingen`, so treat a zero as
  "probably empty" — mark it `empty` but allow a `--verify` flag that fetches anyway.
- Bounded concurrency, default 4 parallel outbound requests, configurable. Exponential backoff with
  jitter on 5xx and timeouts. Retry limit of 5, then `failed` and move on — one bad chunk must not
  stall the queue.
- Filter to `"ProcesType": "meting"` for the historical series. Forecasts are archived too and will
  otherwise pollute the history. Backfill forecast series separately only if I ask.
- Do **not** filter on `Kwaliteitswaardecode` at ingest time. Store the raw code alongside every
  value and filter at read time. Rijkswaterstaat explicitly advises this for anything beyond simple
  display, and it means a change of display policy does not require re-downloading a year of data.
- Progress must be observable: a CLI that prints jobs done / total, current throughput, ETA, and
  failure count, plus the same figures on `/api/health`.

**Storage — this is decided, do not re-litigate it.** Use **PostgreSQL with the TimescaleDB
extension** as the single datastore for everything: locations, the quantities catalogue, the backfill
job queue, and the observations themselves. One database, one connection pool, one backup.

- Observations live in a hypertable partitioned on time. Start with a 7-day chunk interval and only
  change it if the Phase 1 volume numbers suggest otherwise.
- Primary key / unique constraint on `(location_code, quantity, timestamp, proces_type)`, so the
  idempotent upsert is a plain `INSERT … ON CONFLICT … DO UPDATE`. Corrections overwrite in place.
- Implement the hourly and daily rollups as **continuous aggregates** using `time_bucket`, with
  refresh policies — not as hand-written downsampling jobs. Each aggregate carries `min`, `max`,
  `mean` and `count`.
- Add a compression policy, but set the delay to **90 days**, comfortably beyond the 60-day
  correction re-fetch window. Compressing chunks that the rolling re-fetch still needs to rewrite
  creates avoidable friction.
- No retention policy: one year of history is the product, so nothing gets dropped.
- The job queue is an ordinary table in the same database. Mark a chunk `done` in the *same
  transaction* that commits its rows — this is what makes the backfill genuinely crash-safe rather
  than merely restartable.
- Timestamps are `timestamptz`, stored in UTC.

Rationale to record in the README: the ingester writes continuously while the API serves reads, so an
embedded single-writer engine (DuckDB) or immutable files (Parquet) would fight the workload —
corrections would mean rewriting partitions rather than updating rows. The relational side of the
app (locations, catalogue, queue) has to exist regardless, and keeping it in the same transactional
store is worth more here than the raw scan speed of a columnar engine, at a volume Postgres handles
comfortably.

**Corrections.** The new archive publishes data early as `ongecontroleerd` and applies corrections
in place afterwards, so a value fetched today may be revised next week. Handle this with a rolling
re-fetch: a scheduled job that re-downloads the most recent 60 days on a weekly cadence and
overwrites via the same idempotent upsert. Record `fetchedAt` per chunk so it is always clear how
fresh a given slice of history is.

**Deliverables for this part:** a `backfill` CLI with `--from`, `--to`, `--locations`,
`--quantities`, `--dry-run` (prints the plan and projected volume without downloading),
`--concurrency`, and `--resume`. Plus a `backfill:status` command. Wire the same code into a
scheduled job for the rolling re-fetch.

**Time handling.** Build request windows with explicit UTC offsets and be careful around the March
and October DST transitions, where `+01:00` and `+02:00` both occur inside a single month chunk. A
naive month boundary will silently drop or duplicate an hour. Convert to UTC at the boundary of the
ingester and never let local time reach the database.

**Read path.** `/api/locations/:code/observations` selects raw rows for short windows and the
hourly or daily continuous aggregate for longer ones. Never send 50,000 points to a browser to draw
a 400px-wide chart — cap the returned point count and say which resolution was served in the
response.

### 4. Frontend

- Full-bleed map of the Netherlands. Use MapLibre GL or Leaflet; if you pick Leaflet, use
  Leaflet.markercluster, because there are thousands of locations and unclustered markers will
  destroy performance. Clustering (or a vector/canvas layer) is a hard requirement, not a nice-to-have.
- Sidebar filters: measurement type (water level, discharge, wave height, temperature, chemistry…)
  and compartment (surface water / air). No "has data" toggle is needed — every location on the map
  is active by definition.
- Text search over location names, jumping the map to the result.
- Click a marker → panel with the location name and code, latest value with unit and timestamp,
  a time-series chart (default: last 48 hours), a period selector (24h / 7d / 30d / 1y / custom),
  and a link to the corresponding page on waterinfo.rws.nl.
- The chart requests `resolution=raw` for short windows and `hourly`/`daily` for longer ones, so the
  1-year view stays fast. Show the aggregate band (min–max) behind the mean line when downsampled,
  so users can see that they are looking at aggregated data.
- If a location's history has not been backfilled yet, say so explicitly in the panel and trigger the
  lazy backfill rather than showing an empty chart.
- Marker colour encodes data freshness (fresh / delayed), not the raw value — values across
  quantities are not comparable.
- Loading skeletons and explicit empty states ("no measurements in this period"), never a silent
  blank chart.
- Responsive: on mobile the sidebar collapses to a bottom sheet.

### 5. Non-functional

- TypeScript end to end, shared types between server and client.
- PostgreSQL + TimescaleDB, run from the official `timescale/timescaledb` image in
  `docker-compose`. Schema managed by versioned migrations from the first commit — including the
  `CREATE EXTENSION`, the `create_hypertable` call, the continuous aggregates and their policies.
  No hand-applied SQL.
- `.env` for base URLs, database connection and the dummy API key; commit a `.env.example`.
- Tests: unit tests for the RWS response normalisers using **recorded fixtures** (do not hit the
  live service in tests), plus a couple of API-level integration tests against a mocked upstream and
  a throwaway database.
- `docker-compose up` should bring the whole thing up, run migrations, and leave a usable empty
  system; the backfill is then started explicitly via the CLI.
- README covering setup, architecture, the caching strategy, and an attribution note: data is from
  Rijkswaterstaat, subject to their terms — link https://rijkswaterstaatdata.nl/waterdata/ and note
  that this project is not affiliated with or endorsed by Rijkswaterstaat.

## How to work

Work in phases and stop for review after each one.

1. **Phase 1 — Spike and sizing.** Throwaway script that calls `OphalenCatalogus`, both WFS layers,
   and `OphalenAantalWaarnemingen` on a sample. Dump raw responses to `fixtures/`. Report back:
   location counts (all / with-latest / active in 7 days), which quantities exist, response sizes,
   how long the catalogue call actually took, whether GeoJSON and the bulk service are available,
   and the projected volume and download time for a one-year backfill. **Stop here for review** —
   the backfill scope depends on these numbers.
2. **Phase 2 — Schema and backend.** Migrations, hypertable, continuous aggregates, then the live
   API on top, with normalisers tested against those fixtures.
3. **Phase 3 — Map frontend** with clustering and filters, running on live data only.
4. **Phase 4 — Backfill pipeline**: queue, CLI, storage, downsampling, rolling re-fetch. Prove it on
   a handful of locations before letting it loose on the full set.
5. **Phase 5 — Detail panel, charts over the full history, polish, README.**

Additional instructions:

- If a documented endpoint behaves differently from what is described above, trust the live service,
  tell me what differs, and record a fixture of the real response.
- Ask before adding any dependency beyond the obvious framework/map/chart choices.
- Keep commits small with meaningful messages.
