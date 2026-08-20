# Phase 3 — Germany (PEGELONLINE)

Add the German federal waterways as a second data source, so the map shows the Rhine and its
tributaries above the Dutch border rather than stopping at it.

This is a self-contained piece of work and belongs in **its own pull request**. The plan it comes
from is [`INTERNATIONAL-DATA.md`](INTERNATIONAL-DATA.md); the abstraction it builds on landed in
phase 2 and is described under *Sources* in the [README](../README.md).

Everything stated below about PEGELONLINE was verified against the live service, not read from its
documentation. Where something is unverified it says so. Figures are from August 2026 — re-check
the counts rather than asserting them.

---

## Branch and PR

Base this on the phase 2 branch, **not** on `main`: phase 2 introduced the source abstraction this
work depends on, and at the time of writing it has not merged.

```sh
git fetch origin
git checkout -b claude/germany-pegelonline origin/claude/map-data-source-expansion-8hiepw
```

If phase 2 has merged by the time you start, branch from `origin/main` instead and ignore the
above. Check with `git log --oneline origin/main | head`.

Open one PR for this work. Do not touch the basemap, do not add Belgium or France, and do not
start on river ordering — each is its own phase.

The basemap phase has since shipped, which is what makes this one worth doing: the map is on
OpenStreetMap tiles now, so a station at Koblenz lands on a real map instead of on blank grey, and
the map page has a control that frames whatever is loaded. Nothing here needs to touch it. If the
stations you ingest turn out to need something of the map that it does not do, that is a finding for
the PR description, not a change in this branch.

## Read these first

- `packages/server/src/sources/registry.ts` — the source registry and the location-code namespace.
  You add an entry here; you do not add a migration for it.
- `packages/server/src/sources/http.ts` — concurrency gate, retry, backoff. Shared. Use it.
- `packages/server/src/sources/rws/` — the only adapter today. Follow its shape: a `client.ts` that
  knows the service's status semantics, a `normalise.ts` of pure functions tested against recorded
  fixtures, and `types.ts` for the wire shapes.
- `packages/server/migrations/012_sources.sql` — how sources were introduced, and the invariant
  assertion pattern to copy if you need one.
- The *Sources* section of the README — in particular the two boundaries that fail silently.

## Getting a database to test against

The integration suite skips without one, which hides most of what matters here. Ubuntu ships no
TimescaleDB package, so add Timescale's repository — `deploy/install-ubuntu.sh` does the same thing
and is the reference:

```sh
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ ${CODENAME} main" \
  > /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
  | gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/timescaledb.gpg
apt-get update -qq && apt-get install -y timescaledb-2-postgresql-16
pg_conftool 16 main set shared_preload_libraries timescaledb
pg_ctlcluster 16 main start
```

Then allow loopback connections without a password (`trust` for `127.0.0.1/32` in `pg_hba.conf`,
reload) and `npm test` runs the full suite. All 111 tests must still pass, plus whatever you add.

## The service

Base URL `https://www.pegelonline.wsv.de/webservices/rest-api/v2`. No authentication, no API key,
no registration. Licence is **DL-DE→Zero-2.0**: redistribution, modification and commercial use are
all permitted and attribution is not strictly required. Credit it anyway — the `sources` table has
a field for exactly this.

Coverage is the *Bundeswasserstraßen* — the federal waterways — which is precisely what this
project wants: the Rhine, the Mosel, the Main, the Neckar, the Lahn, the Saar, the Ems. 787
stations network-wide.

**Stations.** One call returns the whole network, or one river:

```
GET /stations.json?waters=RHEIN&includeTimeseries=true&includeCurrentMeasurement=true
```

```json
{
  "uuid": "9598e4cb-0849-401e-bba0-689234b27644",
  "number": "...", "shortname": "EMMERICH", "longname": "EMMERICH",
  "km": 851.9, "agency": "...",
  "longitude": 6.09, "latitude": 51.83,
  "water": { "shortname": "RHEIN", "longname": "RHEIN" },
  "timeseries": [
    { "shortname": "W", "longname": "WASSERSTAND ROHDATEN",
      "unit": "cm", "equidistance": 15,
      "gaugeZero": { "unit": "m. ü. NHN", "value": 7.998, "validFrom": "2019-11-01" },
      "currentMeasurement": { "timestamp": "...", "value": -20.0,
                              "stateMnwMhw": "low", "stateNswHsw": "normal" } }
  ]
}
```

`uuid` is the station's stable identifier and is what location codes should be built from
(`de-wsv:9598e4cb-…`). `km` is the river kilometre and `water.shortname` the river — store both
even though the feature that uses them is phase 6, because they arrive free and re-fetching later
is work for nothing.

**Measurements.**

```
GET /stations/{uuid}/W/measurements.json?start=P31D
GET /stations/{uuid}/Q/measurements.json?start=2026-07-20T00:00:00%2B02:00&end=...
```

Each point is `{"timestamp": "2026-08-18T13:30:00+02:00", "value": -25.0}` and **nothing else** —
see *What this service does not give you* below. Timestamps carry a real local offset that switches
with DST, unlike the archive's constant `+01:00`. Convert to UTC at the adapter boundary, as
`toUtcIso` already does.

## Scope: which stations

Do **not** ingest all 787. Ingest the basins that drain to the Dutch delta, filtered by
`water.shortname`, with the list in configuration rather than buried in code:

`RHEIN`, `MOSEL`, `MAIN`, `NECKAR`, `LAHN`, `SAAR`, `SIEG`, `RUHR`, `LIPPE`, `EMS`, `NIERS`,
`VECHTE`, `BERKEL`

That was ~246 stations when measured. `WESER` and `SAALE` are in the feed and do **not** drain to
the Netherlands — leave them out, and make it obvious in the config that the list is a choice.

## The three water-level unit cases

This is the part that decides whether the result is useful or actively misleading, and it is not
what the plan in `INTERNATIONAL-DATA.md` assumed. That document says German levels are "cm above
gauge zero". Across the network they are one of **three** things:

| `timeseries.unit` | count | `gaugeZero` present | Conversion to metres on an absolute datum |
| --- | --- | --- | --- |
| `cm` | 669 | 640 of 669 | `gaugeZero.value + value / 100` |
| `m+NN` | 67 | **0 of 67** | `value` — already absolute, add nothing |
| `m+PNP` | 2 | 2 of 2 | `gaugeZero.value + value` |

Applying the `cm` rule to an `m+NN` series adds a gauge zero that is not there, and treating
`m+NN` as centimetres puts the reading 100× out. The `m+NN` series are the canals — `DEK`, `DHK`,
`ESK`, `MLK`, `RHK`, `WDK` — plus the Ruhr, which makes sense: a canal is held at a fixed level and
is gauged absolutely. Several are in the ingest scope above, so this is not a case you can skip.

**The 29 `cm` series with no `gaugeZero` cannot be converted.** Store them, serve them, and mark
them raw-only. Never silently plot an unconvertible series on the shared axis.

Two further details:

- `gaugeZero.unit` is **`m. ü. NHN` on some stations and `m. ü. NN` on others** (and `mü.M.` on the
  Swiss-operated Basel gauge, which is metres above the Swiss datum). NN and NHN differ by
  centimetres across most of Germany, and the Swiss datum does not. Store the datum string with
  the offset rather than assuming they are interchangeable, and treat the Swiss one as its own case.
- `gaugeZero` has a `validFrom`. Gauge zeros get revised when a gauge is re-levelled, so a
  conversion that is right today is not automatically right for a 2015 reading. You are only
  accumulating forward (see below), so this does not bite yet — but the schema should be able to
  express it, and a comment should say why.

Store the converted value **at ingest**, not at read time. Reading requires joining `gaugeZero` and
its validity per point; the observations table is deliberately narrow, so add one column and pay
for it once.

**If this looks too expensive for the first PR, ship discharge (`Q`) first and water level second.**
m³/s is m³/s in every country, so `Q` needs a unit conversion and no datum work at all, and it is
the physically meaningful quantity for "what is coming down the river" anyway.

## Mapping quantities onto Aquo

The rest of the system speaks Aquo codes. Map at the adapter boundary and keep the source's own
code alongside, so nothing is lost:

Every Aquo code below was checked against a live `OphalenCatalogus` call; the descriptions are the
service's own.

| PEGELONLINE | n | Aquo `grootheid` | `compartiment` | Notes |
| --- | --- | --- | --- | --- |
| `W` | 738 | `WATHTE` (Waterhoogte) | `OW` | see the unit cases above |
| `WT` | 139 | `T` (Temperatuur) | `OW` | °C throughout |
| `Q` | 93 | `Q` (Debiet) | `OW` | m³/s throughout |
| `LT` | 61 | `T` (Temperatuur) | `LT` (Lucht) | **air** temperature — the compartiment is what distinguishes it |
| `LF` | 34 | `GELDHD` (Geleidendheid) | `OW` | **µS/cm on 21, mS/cm on 13** — normalise or you are 1000× out |
| `WG` | 25 | `STROOMSHD` (Stroomsnelheid) | `OW` | m/s |
| `WR` | 24 | `STROOMRTG` (Stroomrichting) | `OW` | degrees |

**`O2` is deliberately not in that table.** There is no `O2` grootheid in Aquo: dissolved oxygen is
modelled as grootheid `CONCTTE` ("(massa)Concentratie") carrying parameter `O2` ("zuurstof"), so it
is the only quantity here that needs the parameter dimension as well. That is a modelling decision
worth making on purpose rather than in passing, and it is 16 series. Skip it, and say so.

Everything below that count (`GRU`, `PH`, `CL`, `DFH`, `TR`, `VA`, `MAXH`, `SIGH`, `TP`, …) is a
handful of series each and several have mutually incompatible units within one code — `TR`
turbidity appears as `FNU`, `TE/F` and `NTU`; `MAXH` and `SIGH` mix metres and centimetres.
**Ingest only the codes in the table and skip the rest**, logging what was skipped so the decision
is visible rather than looking like complete coverage.

## What this service does not give you

Three absences, all of which the existing schema handles but none of which should be papered over:

- **No quality codes and no status.** A measurement is `{timestamp, value}`. Leave `quality_code`
  and `status` null rather than inventing a code that means "fine".

  The read path already survives this — `readObservations` filters with
  `quality_code IS NULL OR quality_code = ANY(...)`, and the continuous aggregates do not filter on
  quality at all — so nothing breaks. What changes is meaning: for Rijkswaterstaat a null quality
  code is rare, for Germany it is every row, so `?includeAllQuality` and the default display filter
  become no-ops on German series. That is defensible, but it is a promise the API currently makes
  uniformly and would then keep only for some sources. Document it; do not leave a consumer to
  infer that German data has been quality-filtered when it has not.
- **No forecasts to exclude.** The RWS ingest filters `ProcesType: 'meting'` to keep forecasts out
  of history. The stations feed carries no forecast series, so there is nothing to filter — but do
  not assume that means the concept is absent; re-check before relying on it.
- **No history.** See below.

## The 31-day cap

**PEGELONLINE serves 31 days and silently clamps anything longer.** Requesting `?start=P90D` on
Emmerich returned 2,610 points beginning 31 days earlier, with a `200` and no warning. There is no
bulk endpoint, no archive, and no depth parameter behind it.

So there is nothing to back-fill from, and the application becomes the archive: poll on a cadence
and accumulate. Consequences to handle explicitly rather than discover in production:

- **The backfill planner must not queue German months it can never fetch.** Phase 2 left a natural
  place for this: give the source a declared history depth and have the planner read it, rather
  than special-casing Germany at each call site.
- **The UI must not imply a truncated history.** `ObservationsResponse` already carries
  `backfillPending` for "not fetched yet". Add a sibling — `historyStartsAt` is the name the plan
  uses — for "this cannot be fetched, ever, and the record starts here". A five-year chart of a
  German station should say so, not render a stub in the corner.
- **Ingester uptime becomes a data-integrity concern for the first time.** A gap in operation is a
  permanent hole with no way to repair it. Say this in the README rather than leaving it implicit.

## Stations that are already in the map

PEGELONLINE relays gauges it does not operate, and two of them are Rijkswaterstaat's:

| Station | km | agency | `gaugeZero` |
| --- | --- | --- | --- |
| `LOBITH` | 862.0 | `RIJKSWATERSTAAT` | none |
| `PANNERDENSE KOP` | 867.3 | `RIJKSWATERSTAAT` | none |
| `BASEL-RHEINHALLE` | 164.3 | `BUNDESAMT FÜR UMWELT CH` | `mü.M.` (Swiss datum) |

The Dutch two are already in the map from Rijkswaterstaat, at 10-minute cadence, with quality codes
and full history. The German relay has none of that. They are the same physical gauges, and the
qualified location codes mean nothing collides at the database level — but showing two markers a
few metres apart is a bug from the user's point of view.

**Decide this deliberately and write down why.** The obvious answer is to prefer the operator's own
feed: skip a PEGELONLINE station whose `agency` is `RIJKSWATERSTAAT`, and record that it was
skipped. Do not silently ingest both.

They are also a gift: two stations published by both services, in the same units on the same datum,
are the best possible check that the pipeline is right. See below.

## Freshness

`freshness.ts` thresholds assume Rijkswaterstaat's ~10-minute cadence. PEGELONLINE stations declare
their own `equidistance` in minutes — 15 for most German gauges, 10 for the relayed Dutch ones —
and it varies. Store it and make freshness relative to the series' declared cadence. A gauge that
reports every 15 minutes is not late at minute 11.

## Acceptance tests

Add these to the integration suite, against ingested fixture data rather than live calls. They are
the difference between "it compiles" and "the numbers are right".

1. **The three unit cases convert correctly.** A `cm` series with a gauge zero, an `m+NN` series
   without one, and an `m+PNP` series, each asserted to the expected metres. Pure functions, so
   these belong in the normalise unit tests too.

2. **An unconvertible series is marked, not guessed.** A `cm` series with no `gaugeZero` must come
   back flagged raw-only and must never carry a converted value.

3. **The Rhine profile decreases downstream.** Converted levels at Wesel (km 814), Rees (km 837.4)
   and Emmerich (km 851.9) must be strictly decreasing — water flows downhill, and any datum error
   large enough to matter breaks the ordering. Measured live: 12.106 m, 9.043 m, 7.798 m.

   Note this is an *ordering* test, not an equality one. The plan in `INTERNATIONAL-DATA.md`
   proposed comparing Emmerich with Lobith and expecting agreement "to within the river's slope";
   the real numbers show ~1.5 m between them over 10 km, which is the actual water-surface slope
   during low flow, not an error. Do not write a test that expects those two to match.

4. **The same gauge from two sources agrees.** Rijkswaterstaat's Lobith and PEGELONLINE's LOBITH
   are the same instrument, both in centimetres on NAP. Once both are ingested their readings at
   the same timestamp should agree to within a few centimetres. This is the strongest end-to-end
   check available and it exercises the dedup decision at the same time. If you skip the relayed
   station (recommended above), keep the check as a one-off verification during development and say
   in the PR what it produced.

## Traps that cost time in phase 2

All three were silent — wrong behaviour, no error anywhere. Assume this service has its own.

- **Codes are qualified going in and unqualified going out.** `de-wsv:9598e4cb-…` is the database
  key; the UUID alone is what goes in the URL to PEGELONLINE. Sending the qualified form to an
  upstream typically yields an empty result rather than an error, which reads exactly like "this
  station has no data".
- **Validate upstream codes before qualifying them.** The RWS parser's plausibility check rejects
  everything if it runs on the qualified key, because the separator is not in its pattern.
- **`series.natural_key` begins with the location code.** Anything that changes how a location is
  keyed changes every natural key, and a mismatch does not raise — it inserts a duplicate series
  and splits the station's history in two. There is a test pinning this; keep it passing.

## What not to do

- **Do not ingest all 787 stations**, and do not ingest the long tail of quantity codes.
- **Do not put an unconverted or unconvertible German level on the same axis as a Dutch one.** A
  wrong number on a map is worse than a missing one.
- **Do not scrape.** Where the API lacks something — history — say so in the UI and the README.
- **Do not invent quality codes** to fill the columns RWS populates.
- **Do not let the RWS active-window logic reconcile German stations.** Phase 2 scoped
  reconciliation per source; keep it that way, and give this source its own window.
- **Do not touch `ACTIVE_WINDOW_DAYS`, the basemap, or the frontend map style.** Out of scope, and
  the basemap in particular is already done.
- **Do not extract a `SourceAdapter` interface just because there are now two adapters** unless the
  second one genuinely fits it. If it does, that is the right moment and this is the PR for it —
  but let the code decide, and say in the PR description which way it went and why.

## Definition of done

- A `de-wsv` entry in the registry, an adapter under `packages/server/src/sources/de-wsv/`, and a
  migration for whatever columns the datum work needs.
- `npm run typecheck` clean, `npm test` green including the pre-existing 111, run against a real
  TimescaleDB rather than skipped.
- Recorded fixtures under `fixtures/` for the payloads the unit tests parse, trimmed the way the
  existing ones are.
- README updated: the source, its licence and attribution, the 31-day limitation and what it means
  for German charts, and the scope decision about which basins are ingested.
- `INTERNATIONAL-DATA.md` phase 3 marked done, with anything this work turned out to disprove
  corrected in place — that document already has two corrections of its own and should keep
  earning its keep.
- The PR description states: how many stations were ingested and from which basins, what was
  skipped and why, which acceptance tests were added, and what you could not verify.

## Verified and not verified

**Verified live, August 2026:**

- 787 stations network-wide; `waters=RHEIN` returns 36.
- W unit distribution 669 `cm` / 67 `m+NN` / 2 `m+PNP`; `gaugeZero` present on 640 / 0 / 2 of them
  respectively.
- `gaugeZero.unit` appears as `m. ü. NHN`, `m. ü. NN` and `mü.M.`.
- The 31-day clamp: `?start=P90D` on Emmerich returned 2,610 points from 31 days prior, HTTP 200.
- `measurements.json` points carry `timestamp` and `value` only.
- Rhine W series without `gaugeZero` are exactly KONSTANZ-RHEIN, LOBITH and PANNERDENSE KOP; the
  latter two report `agency: RIJKSWATERSTAAT`.
- Rhine converted levels Wesel 12.106 m, Rees 9.043 m, Emmerich 7.798 m; PEGELONLINE's LOBITH read
  623 cm at the same time.
- Timeseries code and unit counts as tabulated above.
- The Aquo targets: `WATHTE`, `Q`, `T`, `GELDHD`, `STROOMSHD`, `STROOMRTG` all exist as grootheden
  and `LT` as a compartiment ("Lucht"). `O2` does **not** exist as a grootheid; it is parameter
  `O2` ("zuurstof") under grootheid `CONCTTE`.

**Not verified — check before relying on it:**

- That NHN, NN and NAP agree closely enough for a shared axis. This is asserted from their common
  European vertical reference, not measured. It is worth ten minutes with a published conversion
  before the datum code is written.
- Rijkswaterstaat's own Lobith reading at the same instant. An ad-hoc `OphalenLaatsteWaarnemingen`
  call for `lobith` + `OW`/`WATHTE` returned 204 for the metadata combination tried, so the
  same-gauge comparison above is designed but not executed. The ingested data is the better place
  to run it anyway.
- Whether forecast series (`WV` in the documentation) appear anywhere in the stations feed. They
  did not in the enumeration above.
- Rate limits. None are documented and none were hit; the shared HTTP gate should still cap
  concurrency conservatively.
- Whether `equidistance` is reliable across the whole network or only populated for some series.
