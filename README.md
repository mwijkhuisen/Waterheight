# rws — Rijkswaterstaat monitoring map

A map of the Netherlands showing the measurement locations Rijkswaterstaat monitors, backed by a thin
API over the official Rijkswaterstaat WaterWebservices (WADAR / `ddapi20`).

**Status: Phase 2 complete** — schema, ingestion and API. The map frontend is Phase 3 and the batch
backfill is Phase 4. The full brief is in [`PROMPT.md`](PROMPT.md); the Phase 1 measurements that
shaped these decisions are in [`spike/PHASE1-FINDINGS.md`](spike/PHASE1-FINDINGS.md).

## Quick start

```sh
cp .env.example .env
docker compose up -d          # database + migrations + API on :3000
npm install
npm run refresh               # populate locations and the quantity catalogue
curl localhost:3000/api/health
```

`docker compose up` brings up TimescaleDB, applies migrations and leaves a usable but **empty**
system. `npm run refresh` fills it: the catalogue (~1.2 s) and the location layer (~6 min). The
historical backfill is started separately in Phase 4.

Working against a local database instead of the compose one:

```sh
npm run migrate
npm run refresh               # or: npm run refresh -- catalogue
npm run dev
npm test
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
API and ingestion, and the map client arrives in Phase 3.

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
| `backfill_jobs` | Work queue for Phase 4 |
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

## Attribution

Data is from Rijkswaterstaat and subject to their terms — see
<https://rijkswaterstaatdata.nl/waterdata/>. This project is not affiliated with or endorsed by
Rijkswaterstaat.
