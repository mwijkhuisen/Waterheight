# Going international: OpenStreetMap basemap, and the upstream basins

A design note, not an implementation. It works through what it takes to turn this from a
Rijkswaterstaat map of the Netherlands into a map of the whole catchment that feeds the Dutch
delta — the Rhine down from Basel, the Meuse down from Lorraine, the Scheldt down from Picardy —
and says plainly which parts are cheap, which are hard, and which are impossible with the sources
that exist.

Everything below about the foreign services was **verified live against the real endpoints** while
writing this, not taken from documentation. Response shapes, station counts, history depths and
quirks are what the services actually returned. Dates in the samples are August 2026.

## Contents

- [The ask contains two changes](#the-ask-contains-two-changes)
- [Why the basemap has to go first](#why-the-basemap-has-to-go-first)
- [The four upstream sources](#the-four-upstream-sources)
- [What breaks in the current model](#what-breaks-in-the-current-model)
- [The datum problem, which is the whole problem](#the-datum-problem-which-is-the-whole-problem)
- [History is wildly asymmetric](#history-is-wildly-asymmetric)
- [Schema changes](#schema-changes)
- [The river network, which is the actual feature](#the-river-network-which-is-the-actual-feature)
- [Phasing](#phasing)
- [What not to do](#what-not-to-do)
- [Licences and attribution](#licences-and-attribution)
- [Verified and unverified](#verified-and-unverified)

## The ask contains two changes

They are independent, they have different costs, and conflating them is how this goes wrong.

1. **Swap the basemap** from PDOK's BRT achtergrondkaart to something built on OpenStreetMap.
   Small, self-contained, roughly one file.
2. **Add German, Belgian and French measurement data** alongside the Rijkswaterstaat data, so the
   map shows the whole contributing catchment rather than the bottom 10% of it. Large, touches
   the schema, the ingest layer, the API and the frontend.

Change 1 is a hard prerequisite for change 2, but on its own it is a small regression rather than
an improvement — see below. Do not ship it alone.

## Why the basemap has to go first

`packages/web/src/components/MapView.tsx` pins the basemap to:

```
https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png
```

BRT achtergrondkaart is the Dutch national basemap and it **stops at the Dutch border**. Tiles
outside the Netherlands come back empty. Today that is invisible, because `INITIAL_BOUNDS` is
`[3.0, 50.6, 7.3, 53.7]` and every location is inside it. The moment a station at Basel
(47.56 N) or Koblenz (50.36 N) appears, most of the map is blank grey with dots floating on it.

So "move to open street data" is not a preference, it is the enabling change. Three ways to do it,
in the order I would consider them:

**OpenFreeMap** (`https://tiles.openfreemap.org/styles/positron`) — OpenStreetMap vector tiles,
no API key, no registration, no request limit, MIT-licensed and self-hostable. The `positron`
style is a pale grey almost identical in feel to the BRT grey the app uses now, which matters:
the design decision that the basemap is decoration and the data layer carries the colour survives
intact. Attribution required is `OpenFreeMap © OpenMapTiles Data from OpenStreetMap`.

**Self-hosted Protomaps `.pmtiles`** — one file on disk, served by the existing Fastify process
from the same origin. This fits the app's stated architecture better than anything else: one
process, one origin, no third-party runtime dependency, works on a disconnected network. The cost
is a ~10 GB download for Europe and a build step. Worth revisiting if the third-party dependency
ever becomes a problem; not worth it for the first cut.

**`tile.openstreetmap.org` directly** — do not. The OSM Foundation's tile usage policy exists
precisely to stop applications doing this, and an app that ingests four national services and
serves a public API is not the "low-volume experiment" the policy tolerates.

Recommendation: OpenFreeMap now, with the style URL in config so it can be pointed at a
self-hosted Protomaps instance later without a code change. The existing `style.load` handling in
`MapView.tsx` — which deliberately does not wait for basemap tiles, so a slow provider cannot take
the data layer down with it — already covers the risk of depending on someone else's tile server.

Also needs widening at the same time:

- `INITIAL_BOUNDS` — the Rhine basin reaches Basel, the Meuse rises near Goncourt (48.24 N). A
  basin-wide fit is roughly `[2.5, 47.0, 12.0, 54.0]`. Opening at that zoom makes the Dutch
  stations unreadable, so keep the default view Dutch and add an explicit "whole basin" control.
- `maxzoom: 17` and the raster `tileSize: 256` assumptions, which are raster-specific and go away
  with a vector style.
- The attribution string, which currently credits PDOK and Rijkswaterstaat only.

## The four upstream sources

All four are open, all four answered anonymously from this environment, and none needs a key.

| | Germany | France | Belgium (Wallonia) | Belgium (Flanders) |
|---|---|---|---|---|
| Service | PEGELONLINE (WSV) | Hub'Eau Hydrométrie v2 | SPW hydrométrie | waterinfo.be (VMM) |
| Base | `www.pegelonline.wsv.de/webservices/rest-api/v2` | `hubeau.eaufrance.fr/api/v2/hydrometrie` | `hydrometrie.wallonie.be/services/KiWIS/KiWIS` | `download.waterinfo.be/tsmdownload/KiWIS/KiWIS` |
| Protocol | plain JSON REST | plain JSON REST | KiWIS (KISTERS) | KiWIS (KISTERS) |
| Stations | 787 | thousands | 501 (442 geolocated) | 1,977 (1,942 geolocated) |
| Auth | none | none | none | none; token advised for volume |
| History | **31 days, hard cap** | ~1 month live, daily back to 1971 observed | back to 1995 observed | long, via KiWIS |
| Water level unit | cm above gauge zero | mm | m | m |
| Discharge | m³/s | l/s | m³/s | m³/s |

Two things fall out of that table immediately.

**Wallonia and Flanders speak the same protocol.** Both are KISTERS KiWIS deployments —
`request=getStationList`, `request=getTimeseriesList`, `request=getTimeseriesValues`, keyed on an
opaque `ts_id`, returning column-header-plus-rows arrays rather than objects. One adapter with a
configurable base URL covers both, and would also cover any other KiWIS deployment in Europe,
of which there are many. That is one adapter for two countries.

**Germany is the odd one out on history**, and it is the source we most need history from.

### Germany, PEGELONLINE

Federal waterways only — the Bundeswasserstraßen — which for our purposes is exactly right: the
Rhine, the Mosel, the Main, the Neckar, the Lahn, the Saar, the Ems. 787 stations, of which ~246
are in basins that drain to the Dutch delta.

`GET /stations.json?waters=RHEIN&includeTimeseries=true&includeCurrentMeasurement=true` returns
the whole Rhine in one call, and it is a remarkably clean payload:

```json
{
  "uuid": "9598e4cb-0849-401e-bba0-689234b27644",
  "number": "...", "shortname": "EMMERICH", "km": 851.9,
  "longitude": 6.09, "latitude": 51.83,
  "water": { "shortname": "RHEIN" },
  "timeseries": [
    { "shortname": "W", "unit": "cm", "equidistance": 15,
      "gaugeZero": { "unit": "m. ü. NHN", "value": 7.998, "validFrom": "2019-11-01" },
      "currentMeasurement": { "timestamp": "...", "value": 20.0 } }
  ]
}
```

Three gifts in there. `km` is the river kilometre, `water.shortname` is the river, and `gaugeZero`
is the conversion key to a real vertical datum. Between them they make the upstream-ordering
feature below almost free. `gaugeZero` is present on 33 of the 36 Rhine water-level series.

Series types across the network: `W` water level (738), `WT` water temperature (139), `Q`
discharge (93), `LT` air temperature (61), `LF` conductivity (34), `WG` flow velocity (25), `O2`
oxygen (16). That maps onto the existing compartiment/grootheid model without strain.

It also carries stations that are not German: `BASEL-RHEINHALLE` (agency `BUNDESAMT FÜR UMWELT
CH`) and, notably, **`LOBITH`** — the Dutch border gauge, which Rijkswaterstaat also publishes.
Deduplication is not a hypothetical.

**The 31-day cap is real and is the central constraint.** Requesting `?start=P90D` on Emmerich
returned 2,610 points beginning 2026-07-20 — thirty-one days, not ninety. The service silently
clamps rather than erroring. There is no depth parameter, no bulk endpoint, no archive behind it.

This directly contradicts what the app is for. The README's pitch is "charts over the full
history", the whole backfill pipeline exists to build that, and for Germany there is nothing to
back-fill from. Options, none of them free:

- **Become the archive.** Poll every 15 minutes and accumulate. Correct, and after a year the
  German series are as good as the Dutch ones — but on day one they are empty, and any gap in
  operations is a permanent hole in the record with no way to repair it. This makes the ingester's
  uptime a data-integrity concern for the first time, which it currently is not.
- **Per-Land portals** (LUBW/HVZ for Baden-Württemberg, ELWAS for NRW, and so on) hold decades,
  but each is a different service with a different format. That is a project per state.
- **GRDC** (Global Runoff Data Centre, at the BfG in Koblenz) holds long daily discharge series
  including the Rhine, but it is a registration-and-request archive, not an API, and its terms
  restrict redistribution. Fine for a one-off seed, not for a public map.

My recommendation is to accumulate, and to be honest about it in the UI: a German station's chart
should say "collected since <date>" rather than implying a truncated history. This is exactly the
kind of thing the existing `backfillPending` flag in `ObservationsResponse` was for, and it wants a
sibling — call it `historyStartsAt` — so the frontend can distinguish "we have not fetched this
yet" from "this cannot be fetched, ever".

### France, Hub'Eau

The best-documented of the four, and the largest. `referentiel/stations` supports `bbox`, and a
box over the French Meuse returned 220 stations; a `libelle_cours_eau=La Meuse` query returned 23,
from Goncourt near the source down to the Belgian border.

Two observation endpoints with very different characters:

- `observations_tr` — near-real-time, updated every 5 minutes, holds about a month, cursor
  paginated. A single `bbox` query over the upper Meuse reported `count: 237545`. Volume is not
  a problem here; restraint is.
- `obs_elab` — elaborated daily and monthly series, and the reason France matters. The Meuse at
  Goncourt (`B0220010`, `grandeur_hydro_elab=QmnJ`) returns **40,126 daily discharge values
  starting 1971-09-15**, each carrying a validation status (`Donnée validée`), a method
  (`Expertisée`) and a qualification (`Bonne`). This is the one foreign source where the app's
  existing full-history promise can actually be kept.

Three traps, all of which cost me time while probing.

**Units are mm and l/s** on `observations_tr`, not m and m³/s — divide by 1000 for both, at the
adapter boundary, and never let a raw value past it. Whether `obs_elab` uses the same scaling is
unconfirmed and must be checked against a station of known flow before any French discharge is
plotted next to a German one.

**`code_entite` is not one namespace.** It accepts 8-character *site* codes and 10-character
*station* codes, and `obs_elab` answers on sites where `observations_tr` answers on stations.
Get it wrong and you get `count: 0` with HTTP 200 — indistinguishable from "this gauge has no
data". Resolve entity codes from `referentiel/sites` and `referentiel/stations` rather than
deriving one from the other by truncation.

**`grandeur_hydro_elab` rejects plausible codes.** `QmJ` returns a pattern-validation error;
`QmnJ` (daily mean discharge) and `QmM` (monthly mean) are the working codes. The failure is a
400 with a message that does not name the valid set.

Documented capacity is ~10 calls/s; default page 5,000, maximum 20,000; referential paging capped
at 20,000 records. The existing `Semaphore` in `rws/client.ts` already implements the politeness
cap this needs.

### Belgium

**Wallonia** matters more than Flanders for this purpose: the Meuse crosses Wallonia between
France and the Dutch border at Eijsden, so Walloon gauges are the last upstream reading before the
water arrives. 501 stations, 442 with coordinates. `getTimeseriesList` for station 7132 (AMAY, on
the Meuse moyenne) shows series from 1995-11-28 to now — real history, and more of it than
Germany offers.

The KiWIS surface has sharp edges. `getTimeseriesValues` refuses anything but `ts_id`,
`timeseriesgroup_id` or `ts_path`; station number is not accepted. Unencoded `é` or `*` in a query
returns a Tomcat HTML 400, not JSON. Timestamps come back in local time with offset
(`2026-08-20T01:00:00.000+02:00`), so the existing `toUtcIso` discipline applies unchanged.
Quality arrives as a numeric code (200 observed) on a different scale from the Aquo two-character
codes — it needs its own mapping, not a cast.

A further wrinkle: KiWIS explodes each station into dozens of derived series. Station 7132 alone
publishes `Debit ultrason.InterAn.Jour.P85`, `.An.Maximum`, `.InterAn.Jour.Moyen`, `.Jour.Minimum`,
`.3jMob.Moyen` and many more — percentiles, annual maxima, rolling means. Ingesting all of them
would multiply the series table by an order of magnitude with statistics rather than measurements.
Filter to the base measured series on `ts_name` and treat the rest as out of scope.

**Flanders** (VMM, `download.waterinfo.be`) returned 1,977 stations, 1,942 geolocated, and served
`getTimeseriesValues` anonymously. It is the right source for the Scheldt. The site asks heavy
users to request a download token from `hydrometrie@waterinfo.be`, valid 24 hours from a client
credential — build the adapter to send a token when configured and work without one when not.
The separate HIC deployment at `www.waterinfo.be/tsmhic/KiWIS/KiWIS` returned an empty body when I
probed it; whether that is a permanent change or a transient failure needs checking before relying
on it.

## What breaks in the current model

The schema is in better shape for this than I expected. `series` is already a generic bag of
dimensions with a `natural_key`, and the comment in `004_series.sql` explaining why
`(location, quantity)` is not a series turns out to apply just as well to foreign sources. The
things that actually break:

**1. `locations.code` is a flat namespace.** It is `text PRIMARY KEY`, lowercased by
`normaliseLocationCode`. Four sources will collide — and PEGELONLINE's `LOBITH` collides with a
Rijkswaterstaat location by name today. Every code needs a source prefix: `rws:lobith`,
`de:9598e4cb-…`, `fr:B720000101`, `be-wal:7132`, `be-vl:01L05_404`. That is a migration touching
`locations`, `location_events`, `series`, `location_quantities` and every route that takes a
`:code` parameter.

**2. Compartiment and grootheid are Aquo codes.** `WATHTE`, `Q`, `OW` are a Dutch national
vocabulary. No foreign service uses them. Either map every source onto Aquo — which is a lie for
anything without an Aquo equivalent, but keeps one vocabulary and every existing filter working —
or introduce a neutral vocabulary and map Rijkswaterstaat onto it too. I would map onto Aquo:
`W`/`H` → `WATHTE`, `Q` → `Q`, `WT` → `T`, all in compartiment `OW`. It is the smaller change and
the vocabulary is genuinely adequate for the handful of quantities involved. Record the source's
own code alongside it so nothing is lost.

**3. The ingest path is WFS-shaped.** `ingest/locations.ts` is built around one 940k-row CSV layer
streamed in pages, with a truncation guard tuned to that layer's failure mode. None of the foreign
sources look anything like that; three of them return the complete station list in a single small
JSON response. The refresh needs to become per-source, with `refresh_state` keyed by source, so a
PEGELONLINE outage cannot block a Hub'Eau refresh and one source's failure cannot deactivate
another's stations. The `MAX_MISSING_FRACTION` guard is specific to the WFS layer and must not be
generalised into a rule that fires on a source which legitimately returns fewer stations.

**4. `config.rws` is a single upstream.** Timeout, retry, concurrency and base URL are one object
consumed by one client. It needs to become per-source, because the tolerances genuinely differ —
Hub'Eau documents ~10 calls/s, PEGELONLINE documents nothing, and the WFS layer needs a 120-second
timeout that would be absurd for a 3 KB JSON station list.

**5. The frontend assumes one authority.** `freshness.ts` thresholds are built around
Rijkswaterstaat's ~10-minute cadence; PEGELONLINE's `equidistance` is 15 minutes and varies by
station, Walloon daily series update once a day. A daily series is not "delayed" at 11:00 — but
the current model would paint it red. Freshness has to become relative to the series' own expected
cadence, which the sources do supply.

## The datum problem, which is the whole problem

Everything above is engineering. This is the part that decides whether the result is useful or
actively misleading.

Water level is meaningless without a reference. The four sources use four:

| Source | Unit | Reference |
|---|---|---|
| Rijkswaterstaat | cm | NAP (Normaal Amsterdams Peil) |
| PEGELONLINE | cm | **gauge zero (Pegelnullpunkt) — a local datum, different at every gauge** |
| Hub'Eau | mm | station's own altimetric system (NGF-IGN69 and others) |
| Belgium | m | TAW/DNG, ~2.33 m below NAP |

The German case is the dangerous one, because the numbers look plausible. Emmerich returned
`20.0` and `-20.0` cm while I was probing. Lobith — 10 km downstream, same river, same water —
reads in the high hundreds of cm because it is referenced to NAP. Plot those on one axis and the
Rhine appears to fall eight metres in ten kilometres. Someone will screenshot that.

The fix is available in the data and costs almost nothing. PEGELONLINE ships `gaugeZero` in metres
above NHN, and NHN and NAP both realise the same European vertical reference — they agree to
within a few centimetres. So:

```
level_m_nap ≈ gaugeZero.value + (W_cm / 100)
```

Emmerich at `20.0` cm becomes `7.998 + 0.20 = 8.20` m NAP. That is a number you can honestly put
next to Lobith.

This argues for storing a **normalised** value alongside the raw one — SI units, one vertical
datum — rather than only the raw reading as now. The existing `observations` table is deliberately
narrow, and the comment in `005_observations.sql` is right that every column costs ~190M times its
width, so this is not a free decision. But the alternative is doing the conversion at read time on
every chart request, and needing `gaugeZero` and its `validFrom` history joined in to do it. Store
it once at ingest.

Three consequences to accept up front:

- **`gaugeZero` has a `validFrom`.** Gauge zeros are revised. A conversion applied today is not
  automatically right for a reading from 2015, and re-datuming history when a gauge is re-levelled
  is a real operation the schema should be able to express.
- **33 of 36 Rhine water-level series carry a `gaugeZero`; three do not.** Those three cannot be
  converted and must be shown as raw-only, not silently plotted on the NAP axis.
- **Discharge has no datum problem at all.** m³/s is m³/s everywhere. If the datum work looks too
  expensive for a first cut, **ship discharge first** — it is the physically meaningful quantity
  for "what is coming down the river" anyway, and it is comparable across all four countries with
  nothing more than a unit conversion.

**The acceptance test writes itself.** Emmerich (DE, Rhine km 851.9) and Lobith (NL, km 862) are
ten kilometres apart. After conversion their levels must agree to within the river's slope over
that distance — order of centimetres, not metres. If that check passes, the datum handling is
right. If it fails, something is wrong and it is better to find out in CI than on the map. Do the
same for Eijsden against the nearest Walloon gauge on the Meuse.

## History is wildly asymmetric

Worth stating plainly, because it shapes what the product can promise:

| Source | Depth |
|---|---|
| Rijkswaterstaat | full archive, already back-filled |
| France | daily back to 1971 observed (`obs_elab`); ~1 month sub-daily |
| Wallonia | back to 1995 observed |
| Flanders | long, via KiWIS |
| **Germany** | **31 days, full stop** |

There is no configuration that makes these uniform. The app should not pretend otherwise: a chart
spanning four countries needs to show where each series actually starts, and the "5 years" period
button should not silently render a German series as a stub in the corner. This is a UI honesty
problem more than a data problem, and the codebase already has the habit — the `stale` and
`backfillPending` flags exist for exactly this reason.

## Schema changes

Sketched, not final:

```sql
-- 012_sources.sql
CREATE TABLE sources (
  id          text PRIMARY KEY,          -- 'rws', 'de-wsv', 'fr-hubeau', 'be-wal', 'be-vl'
  name        text NOT NULL,
  country     text NOT NULL,             -- ISO 3166-1 alpha-2
  attribution text NOT NULL,             -- rendered in the map's attribution control
  licence     text NOT NULL,
  base_url    text NOT NULL
);

ALTER TABLE locations
  ADD COLUMN source_id     text REFERENCES sources (id),
  ADD COLUMN source_code   text,          -- the code in the source's own namespace
  ADD COLUMN river         text,          -- 'RHEIN', 'La Meuse', ...
  ADD COLUMN river_km      double precision,
  ADD COLUMN datum         text,          -- 'NAP', 'PNP', 'NGF-IGN69', 'TAW'
  ADD COLUMN datum_offset_m double precision;  -- to NAP; null when unconvertible

ALTER TABLE observations
  ADD COLUMN value_si double precision;   -- m for level (NAP), m³/s for discharge
```

`locations.code` becomes `source_id || ':' || source_code`, generated rather than free-form, so
collisions are impossible by construction.

`refresh_state` is already keyed by name, so per-source refresh needs no schema change — just
`refreshLocations('de-wsv')` instead of `refreshLocations()`.

The `Location` type in `packages/shared` gains `source`, `country`, `river` and `riverKm`. The rule
in that file's header — that raw upstream field names must never appear in it — now has to hold
for four vocabularies instead of one, which is a good argument for the adapter boundary being
strict about normalising before anything reaches shared types.

**Adapter shape.** The cleanest structure is an interface each source implements, with
`packages/server/src/rws/` becoming `packages/server/src/sources/rws/` alongside `de-wsv/`,
`fr-hubeau/` and `kiwis/` — the last parameterised over Wallonia and Flanders:

```ts
interface SourceAdapter {
  readonly id: string;
  listStations(): Promise<NormalisedStation[]>;
  listSeries(station: NormalisedStation): Promise<NormalisedSeriesMeta[]>;
  fetchObservations(series: NormalisedSeriesMeta, from: Date, to: Date): Promise<NormalisedPoint[]>;
  readonly historyDepth: { kind: 'full' } | { kind: 'window'; days: number };
}
```

`historyDepth` is what lets the backfill planner do the right thing per source without special-
casing Germany in five places.

## The river network, which is the actual feature

"A total overview of the rivers that feed our rivers" is not delivered by more dots. Four thousand
dots across five countries is less legible than eight hundred dots across one. What delivers it is
**upstream ordering**: the ability to look at Lobith, follow the Rhine back through Emmerich, Rees,
Wesel, Duisburg, Köln, Andernach, Kaub, Maxau, Basel, and see the same flood peak arriving at each
one a few hours apart.

That is the thing worth building, and it is closer than it looks:

- PEGELONLINE gives `water.shortname` and `km` for free, already ordered along the river.
- Hub'Eau gives `libelle_cours_eau` and `code_cours_eau` (a SANDRE identifier).
- Wallonia's KiWIS gives `river_name` ("Meuse moyenne", "Ourthe inférieure").
- Rijkswaterstaat gives **neither** — no river, no river kilometre, on any layer we ingest. Dutch
  stations have to be assigned to a river some other way: by name convention, by hand for the
  fifty or so that matter on the Rhine/Waal/Lek/IJssel and the Meuse, or by spatial join against a
  river network.

For a drawn river network on the map, two options. **OpenStreetMap waterways** (`waterway=river`)
are already implicit in the OSM basemap and can be styled up from a vector source without a second
dataset. **HydroRIVERS** (HydroSHEDS) is a purpose-built global network with basin topology and
upstream/downstream relationships, free for commercial use with attribution — the right choice if
the goal is real basin logic rather than a blue line.

Start with the ordering, not the drawing. A "Rhine profile" view — a single chart with every gauge
from Basel to Lobith, stacked by river kilometre — is more of the requested overview than any
amount of cartography, and needs no new geodata at all.

## Phasing

Each step should be shippable on its own.

**1. Basemap.** OpenFreeMap, style URL in config, widen `INITIAL_BOUNDS`, fix attribution. One
file, no schema change. Ship together with step 2, not before it.

**2. Source abstraction, no new data.** Introduce `sources`, prefix location codes, move
`rws/` under `sources/rws/`, split `config.rws` per source, make `refresh_state` per source.
Behaviour identical, all tests still green. This is the risky migration and it should land with
nothing else in it.

**3. Germany.** One source, richest metadata, cleanest payload, and it carries `gaugeZero` so the
datum work gets done properly the first time. Includes the Emmerich/Lobith acceptance test and the
`historyStartsAt` UI honesty. Deduplicate against Rijkswaterstaat's Lobith.

**4. Belgium, both regions.** One KiWIS adapter, two configurations. Meuse and Scheldt coverage.
Filter derived statistical series out.

**5. France.** Largest volume; needs bbox-scoped station selection from the start rather than
ingesting the national network. `obs_elab` gives real history — the only foreign source where it
does.

**6. River ordering.** `river`/`river_km` populated, Dutch stations mapped by hand, the Rhine
profile view.

Steps 3–5 are independent of each other and can go in any order, or in parallel.

## What not to do

- **Do not ingest every station in France.** Hub'Eau's referential is the whole country. The
  Loire, the Garonne and the Rhône do not feed the Dutch delta. Scope by basin — Meuse, Scheldt,
  Sambre, Moselle — and say so in config, not in code.
- **Do not put foreign readings on a Dutch axis before the datum conversion works.** A wrong
  number on a map is worse than a missing one.
- **Do not let Rijkswaterstaat's active-window logic reconcile foreign sources.** A Walloon daily
  series is not stale at 11:00, and `ACTIVE_WINDOW_DAYS` is a single global today.
- **Do not scrape.** All four services publish real APIs. Where one is missing a capability —
  German history — the answer is to say so, not to scrape a frontend.
- **Do not silently drop Belgium's derived series** into `series` as if they were measurements.
  Percentiles and annual maxima are not observations.

## Licences and attribution

All four are open, but the terms differ and the map's attribution control has to reflect that. It
currently credits PDOK and Rijkswaterstaat.

- **PEGELONLINE** — DL-DE→Zero-2.0. Redistribution, modification and commercial use permitted;
  no attribution strictly required. Credit it anyway.
- **Hub'Eau** — French open data, Licence Ouverte / Etalab. Attribution required.
- **SPW Wallonia** — free, unrestricted purpose, indefinite duration, per the portal's terms.
- **waterinfo.be** — free; heavy users should request a token, which is a courtesy the app should
  honour rather than route around.
- **OpenFreeMap** — `OpenFreeMap © OpenMapTiles Data from OpenStreetMap` required.
- **HydroRIVERS**, if used — free for commercial use with attribution.

The `sources` table above carries `attribution` and `licence` per source so the control can be
built from data rather than a hard-coded string, and so a source added later cannot be shipped
without its credit.

## Verified and unverified

In the spirit of the README's own section.

**Verified live, August 2026:**

- PEGELONLINE `/stations.json` returns 787 stations; `waters=RHEIN` returns 36 including
  `BASEL-RHEINHALLE` (CH) and `LOBITH` (NL); `includeTimeseries` carries `gaugeZero` on 33 of 36
  Rhine water-level series in m ü. NHN.
- PEGELONLINE clamps to 31 days: `?start=P90D` on Emmerich returned 2,610 points from 2026-07-20,
  without an error.
- Hub'Eau `referentiel/stations` with a Meuse bbox returned 220 stations and
  `libelle_cours_eau=La Meuse` returned 23; `observations_tr` over a bbox reported `count: 237545`;
  `code_entite` mismatches return `count: 0` with HTTP 200.
- Hub'Eau `obs_elab` on site `B0220010` (La Meuse à Goncourt) with `grandeur_hydro_elab=QmnJ`
  returned 40,126 daily values, earliest 1971-09-15, with validation status and qualification
  per record. `QmM` returned 1,316 monthly values. `QmJ` is rejected as an invalid code.
- SPW Wallonia KiWIS returned 501 stations (442 geolocated); station 7132 (AMAY, Meuse) has series
  from 1995-11-28; `getTimeseriesValues` requires `ts_id` and rejects station number.
- waterinfo.be VMM KiWIS returned 1,977 stations (1,942 geolocated) and served
  `getTimeseriesValues` anonymously.
- All four answered without authentication.

**Not verified:**

- The HIC deployment at `www.waterinfo.be/tsmhic/KiWIS/KiWIS` returned an empty body. Unclear
  whether that is permanent.
- waterinfo.be's anonymous rate limit is undocumented and was not probed; the threshold at which a
  token becomes necessary is unknown.
- The NHN↔NAP agreement is asserted from the shared European vertical reference, not measured. The
  Emmerich/Lobith check is proposed, not run.
- Whether `obs_elab` returns l/s like `observations_tr`, or already-scaled m³/s. The Goncourt
  series reads 74.0 for 1971-09-15; both readings are physically possible for a headwater gauge in
  September, so the value alone does not settle it. Confirm against a large gauge with a known
  mean flow before trusting French discharge.
- Whether the 1900 depth the documentation claims is reached anywhere; the deepest series actually
  observed starts in 1971.
- No load testing against any of the four.
