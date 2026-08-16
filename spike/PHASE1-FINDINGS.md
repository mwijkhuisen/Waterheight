# Phase 1 — spike & sizing results

Measured against the live service on **2026-08-16**. Raw numbers in
`fixtures/trimmed/phase1-report.json`; reproduce with `node spike/phase1-spike.mjs`.

## Headline numbers

| Metric | Value |
| --- | --- |
| `locaties` (all water-management locations) | **19,003** |
| `locatiesmetlaatstewaarneming` rows | **942,691** |
| …unique locations behind those rows | **2,608** |
| …**active** (latest observation < 7 days) | **567** |
| Distinct active location+quantity pairs | 3,491 |
| Projected physical series (after fan-out) | ~7,730 |
| **Projected rows for 1 year** | **~190 million** |
| Projected on-disk, uncompressed | ~23 GB |
| Projected download | ~92,760 month-chunks, **~8 h** at concurrency 4 |

Freshness distribution across the 2,608 unique locations:

| Age of latest observation | Locations |
| --- | --- |
| < 24 h | 563 |
| 1–7 days | 4 |
| 7–30 days | 143 |
| 30–365 days | 271 |
| > 1 year | **1,627** |

The 7-day cut-off is doing real work: **1,627 of 2,608 locations in
`locatiesmetlaatstewaarneming` are more than a year stale** (the oldest sampled row is
from 1988). The distribution is also strongly bimodal — 563 locations reported within
24 h and only 4 more within the next six days — so the exact window is not delicate.
Anything from 2 to 7 days yields essentially the same ~567 locations.

## Endpoint behaviour

| Probe | Result |
| --- | --- |
| `OphalenCatalogus` | **200 in ~1.2 s**, 6.5 MB — 2,635 locations, 1,912 metadata combos, 91,563 links |
| WFS `GetCapabilities` | GeoJSON **is** offered (`application/json`) |
| `AanvragenBulkWaarnemingen` | **Exists** at `/BULKWAARNEMINGENSERVICES/…` (400 = validation) |
| `OphalenWaarnemingen`, one month | 200 in **~1.0 s**, ~1.2 MB, ~4,450 points |
| `OphalenAantalWaarnemingen` | 200, but **5–200 s** per location |

The catalogue is documented as slow but answered in **1.2 seconds**. It should still be
cached rather than called per page load, but it is not the bottleneck the brief expects.

The bulk service survived the migration: the empty-body probe returns a 400 naming the
required fields (`Zoekvraag`, `Email_bevestiging`, `Email_fout`, `Email_succes`).
It is asynchronous and **delivers results by email**, so it does not fit an automated
ingester without a mailbox to poll. I did not pursue it further — at ~8 h the chunked
path is acceptable. Worth revisiting only if you want a faster cold start.

## Things that differ from the brief

Four findings contradict the brief. Fixtures are recorded for each.

**1. `OphalenAantalWaarnemingen` is far slower than just fetching the data.** The brief
proposes using it to skip empty months before downloading. In practice one count call
covering a year cost 5–200 s (median ~14 s, worst `ijgeul.1` at 195 s), while fetching a
real month of observations took ~1 s. **Pre-flighting counts would cost more than it
saves** and I recommend dropping it from the default path — issue the fetch, treat 204
as empty, and keep the count endpoint for planning and reporting only.

**2. There is no DST hazard — the archive returns a constant `+01:00` offset
year-round.** Verified across both transitions: March 2026 returned 4,462 points and
October 2025 returned 4,465, all stamped `+01:00`, with no `+02:00` anywhere and no
duplicated or missing hour. RWS returns fixed CET, *not* Europe/Amsterdam local time,
so conversion to UTC is an unconditional one-hour subtraction. The elaborate DST
handling the brief asks for is not needed, though the ingester should still assert the
offset and fail loudly if it ever changes.

**3. Both period endpoints are inclusive.** A request for `[Jul 1 00:00, Aug 1 00:00)`
returns points at *both* boundaries, so adjacent month chunks overlap by one timestamp.
Harmless given the idempotent upsert, but it means chunk row counts will not sum to the
table total.

**4. One `(compartiment, grootheid)` pair is not one series.** It fans out ~2.2× into
distinct physical series differing by instrument, sampling height, and sampling method —
`a12` returned 50 series from 19 quantity pairs, `ijgeul.1` returned 131 from 16. The
uniqueness constraint the brief specifies, `(location_code, quantity, timestamp,
proces_type)`, **will silently collapse these into one another and lose data.** This
needs deciding before the Phase 2 migration; see the open question below.

Two smaller notes. The WFS layer's `KWALITEITSWAARDE_CODE` uses a different code list
(e.g. `1004`) than the observation API's `Kwaliteitswaardecode` (`00`, `99`), so the two
must not be compared. And every sampled value carried `Statuswaarde: "Ongecontroleerd"`,
confirming that the rolling correction re-fetch is genuinely needed.

## Sizing detail

The per-location mean is a trap: 407,610 points/location/year against a **median of
142,053**. Two offshore platforms (`ijgeul.1` at 2.6 M, `a12` at 1.24 M) carry 63 % of
the sample. Projecting on the mean overestimates by ~20 %, so the ~190 M figure above
projects per *series* instead (7,730 series × ~24,654 points/series/year).

Volume by quantity across the 15-location sample:

| Quantity | Points | Series | Share |
| --- | --- | --- | --- |
| `WATHTE` water level | 1,106,551 | 31 | 18.1 % |
| `STROOMRTG` current direction | 703,363 | 38 | 11.5 % |
| `STROOMSHD` current speed | 631,131 | 36 | 10.3 % |
| `ECHO` echo sounding | 543,744 | 32 | 8.9 % |
| `T` temperature | 451,985 | 14 | 7.4 % |
| `GELDHD` conductivity | 317,653 | 10 | 5.2 % |
| `CONCTTE` concentration | 316,732 | 10 | 5.2 % |
| `Q` discharge | 38,713 | 1 | 0.6 % |
| *(20 further quantities)* | | | 30.8 % |

**Tier 1 as specified (`WATHTE` + `Q`) is only 18.7 % of volume** — roughly 36 M rows and
~1.5 h of downloading. `Q` barely registers because discharge is measured at a handful
of river stations, not across the coastal network.

The catalogue lists **136 quantities** across 10 compartments (`OW` surface water, `LT`
air, plus `BS`, `LM`, `NT`, `NVT`, `OE`, `OR`, `PM`, `ZS`).

## Recommendation

The full 190 M-row backfill is **feasible** — ~8 h of downloading and ~23 GB before
TimescaleDB compression, which is comfortable for Postgres. It is not a multi-day job
and does not need narrowing on volume grounds alone.

I would still not make it the default. My proposal:

- **Tier 1 (eager): `WATHTE`, `Q`, `T`, plus the wave and wind quantities** — the things
  the detail panel actually plots. Roughly 30 % of volume, ~55 M rows, ~2.5 h.
- **Tier 2 (lazy on first request):** current direction/speed and echo sounding. These
  are 30 % of volume between them and are near-useless in a general-purpose map panel.
- **Tier 3 (eager, negligible):** the chemistry and low-frequency series, which the
  brief guessed would be cheap. Confirmed — they are a rounding error in volume.

That gets a useful product in ~3 h instead of 8, with everything else one lazy fetch
away. Say the word and I will make the full set eager instead; it is one config change.

## Open question for you

**How should the extra metadata dimensions be keyed?** Because one quantity pair fans
out into several physical series, the specified key `(location_code, quantity,
timestamp, proces_type)` is not unique in the real data — ingesting `a12` would discard
49 of its 50 series. Three options:

1. **Extend the key** with the distinguishing fields (sampling height, instrument,
   sampling method). Faithful, but widens the hypertable key and the API surface.
2. **Add a synthetic `series_id`** keyed off the full AquoMetadata, with the extra
   dimensions in a joined table. Keeps the observations table narrow.
3. **Pick one series per (location, quantity)** — e.g. the one with the most points —
   and drop the rest. Simplest, matches what waterinfo.rws.nl appears to show, but
   loses data irreversibly.

I lean towards **2**: it keeps the hypertable narrow and the constraint honest, and the
map UI can keep showing one series per quantity while the data underneath stays whole.
This is the one thing blocking the Phase 2 migration, since it decides the primary key.
