# Switzerland (BAFU/FOEN/OFEV) hydrology: research for phase planning

I checked these sources live on 2026-09-23 between 19:56 and 20:12 UTC. I called every endpoint below with curl through the proxy, with TLS verification on. Anything I could not check live is marked **UNVERIFIED**. I did not use any file from the local repository.

---

## 1. Summary

- **The only documented official feed for live values is LINDAS.** It is the federal Linked Data Service, queried with SPARQL at `https://ld.admin.ch/query`. BAFU says it carries discharge, water level, water temperature and flood danger level, updated every 10 minutes. It holds **only the latest value per station, with no history**. Your own collector therefore has to build the history.
- **hydrodaten.admin.ch has richer JSON that nobody documents.** It is public and needs no key, but it is internal to the website and could change without notice. It contains:
  - One GeoJSON file with the latest values, 24-hour min/mean/max, all 4 danger thresholds per station, and fault notices for every station.
  - Per-station JSON with 7 days and **40 days of 5-minute raw data**.
  - **Ensemble forecasts** per station: median, 25–75 % band and min/max, hourly, about 5 days ahead.
  - Warning sections with their validity periods.
- **The official open-data layers on geo.admin.ch give classes, not values.** They are the `ch.bafu.hydroweb-messstationen_*` layers, published as GeoJSON on data.geo.admin.ch. They give the percentile class (from very low to very high) and the current danger level (1–5), but no numbers. They are useful as an official cross-check and for the warning-map polygons.
- **History is not available as a bulk API.** Two ways to get it:
  - The last 40 days of raw data are online on hydrodaten.
  - Longer history (continuous data from 1974, daily values much earlier) is ordered by email or form from the "Datenservice Hydrologie". It has been free since 2020 and arrives as CSV.
  - Exception: Kanton Basel-Stadt republishes Rhein-Basel (2289) since 2020-06-22 and Birs (2106) since 2022-10-29 as 5-minute data with a proper API.
- **Units and conventions:**
  - Discharge is in m³/s; a few small stations use l/s.
  - Water level is in **m ü. M. on the LN02 datum** (BAFU FAQ). BAFU does not use LHN95.
  - Live data is in Swiss local time, and the timestamps carry an explicit offset.
  - LINDAS always writes `+01:00`. The website plots write `+02:00` in summer. Both are correct if you parse the offset.
- **Licence:** free use, commercial use included. Naming the source is *recommended*, not required. Raw data may be downloaded **no more often than every 10 minutes** (BAFU general conditions, 2019). Forecasts may be used freely, but warnings on small and medium rivers are the cantons' responsibility. BAFU recommends shipping an explanation of how to read the forecasts.

---

## 2. Source inventory

| # | Source | Access (exact) | Content | Cadence (observed) | History | Status / licence | Verified |
|---|---|---|---|---|---|---|---|
| A | **LINDAS cube "river"** | SPARQL POST `https://ld.admin.ch/query` (also `https://lindas.admin.ch/query`); cube `https://environment.ld.admin.ch/foen/hydro/river` | Q, W, T, dangerLevel for 199 river stations; WGS84 point; water body | Cube `dateModified` 19:54:10Z, then 20:04:03Z, so 10 min. Values lag measurement by about 14–24 min | **None** (latest per station only) | Official and documented by BAFU. The cube is marked `CreativeWorkStatus/Draft` | Yes |
| A2 | **LINDAS cube "lake"** | cube `https://environment.ld.admin.ch/foen/hydro/lake` | W, T, dangerLevel for 34 lakes (incl. Bodensee: Romanshorn 2032, Berlingen 2043) | 10 min | None | Official | Yes |
| B | **hydrodaten live GeoJSON** | `https://www.hydrodaten.admin.ch/web-hydro-maps/hydro_sensor_pq.geojson` (also `hydro_sensor_warn_level.geojson`, `hydro_sensor_pq_forecast.geojson`) | 207 stations: last value, 24 h min/mean/max for Q and W, **thresholds wl_1..wl_4**, `failure_text`, section name; EPSG:2056 | `produced_at` 22:08:06 local; latest value 20:00Z, seen at 20:08Z (about 8 min lag); `Cache-Control: max-age=30` | None | Internal to the website, undocumented | Yes |
| C | **hydrodaten plot JSON** | `https://www.hydrodaten.admin.ch/plots/p_q_7days/{id}_p_q_7days_{de,en,fr,it}.json`; `…/plots/p_q_40days/{id}_p_q_40days_{lang}.json`; `…/plots/temperature_7days/…`; `…/plots/pq_group/{id}_pq_group_5_{lang}.json` | Plotly traces: W and Q at **5-min** resolution (40 days = 11,480 points) | Regenerated about every 5–15 min | **40 days raw** | Internal, undocumented | Yes |
| D | **hydrodaten forecast JSON** | `https://www.hydrodaten.admin.ch/plots/q_forecast/{id}_q_forecast_{lang}.json` | Hourly median, 25–75 % band, min/max, the last 24 h of hourly measurements, and threshold bands | Run issued daily, more often during floods (the run seen started 19:00 local) | Only the current run | Internal. Forecasts are "freely usable" (2019 general conditions) | Yes |
| E | **hydrodaten warning sections** | `https://www.hydrodaten.admin.ch/web-hydro-maps/hydro_warn_levels_{de,en,fr,it}.geojson` | 93 river/lake/region sections: `level`, `valid_from`, `valid_until`, key station | Issued 07:24 local; valid until 25.09 11:00 | Current only | Internal | Yes |
| F | **geo.admin GeoJSON layers** | `https://data.geo.admin.ch/ch.bafu.hydroweb-messstationen_{zustand,gefahren,vorhersage,temperatur}/…_{de,en,fr,it}.json`; `https://data.geo.admin.ch/ch.bafu.hydroweb-warnkarte_national/ch.bafu.hydroweb-warnkarte_national_{lang}.json` | **Classes only**: `quant-class` (zustand: percentile class 1–5; gefahren: danger level 1–5; 0 = no data); warning-map polygons and lines | Last-Modified 19:52Z, then 20:07Z. Warning map about twice a day | None | Official open data on opendata.swiss, "Open use" | Yes |
| G | **STAC station metadata** | `https://data.geo.admin.ch/api/stac/v1/collections/ch.bafu.hydrologie-hydromessstationen/items` gives SHP/GDB zips of stations and catchments | Station locations and catchment polygons (EPSG:2056) | Static (2024-06-01) | n/a | STAC `license: proprietary`, linked to opendata.swiss terms_by | Yes |
| H | **Historical order service** | `https://www.bafu.admin.ch/de/datenservice-hydrologie-fuer-fliessgewaesser-und-seen`, hydrologie@bafu.admin.ch | CSV of 5-min, 10-min or hourly means (from 1974); daily/monthly from the 19th century; checked or validated quality | On request, "some days" | Deep | Free since 2020-01-01 | Page and sample CSV verified; turnaround UNVERIFIED |
| I | **data.bs.ch (Kanton Basel-Stadt)** | `https://data.bs.ch/api/explore/v2.1/catalog/datasets/100089/records` (Rhein, 2289), `…/100236/records` (Birs, 2106) | 5-min Q, W and gauge height, in UTC | Latest 19:50Z, seen at about 20:00Z | 100089 since **2020-06-22**, 100236 since **2022-10-29** | "Open use" (terms_open); `X-RateLimit-Limit: 500000` per day | Yes |
| J | existenz.ch (third party, noted only) | `https://api.existenz.ch/apiv1/hydro/latest?locations=…&parameters=flow,height`, `/daterange` | Mirror of BAFU, 10-min values | Near real time | About 30 days only (2026-08-24 present, 2026-08-10 absent) | Not official | Yes |
| K | opendata.swiss catalogue | `https://ckan.opendata.swiss/api/3/action/package_search` | Metadata only | n/a | n/a | **Returns 403 without a non-default User-Agent** | Yes |

The "Meine Pegel" app from hochwasserzentralen.info is named by BAFU as another distribution channel. It is not an API for third parties.

---

## 3. Source details

### 3.1 LINDAS (official live feed, recommended primary)

**BAFU's statement** (`https://www.hydrodaten.admin.ch/de/aktuelle-hydrologische-daten-beziehen`): the discharge, water level, temperature and flood danger level data shown on hydrodaten "are also published on LINDAS and are updated every 10 minutes". Contact: abfragezentrale@bafu.admin.ch.

**Verified query.** It returned 201 rows for 199 stations in about 2 s and asks for CSV (`Accept: text/csv`):
```sparql
PREFIX h: <https://environment.ld.admin.ch/foen/hydro/dimension/>
PREFIX schema: <http://schema.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX cube: <https://cube.link/>
SELECT ?id ?name ?water ?time ?q ?w ?t ?dl ?wkt WHERE {
  <https://environment.ld.admin.ch/foen/hydro/river> cube:observationSet ?set .
  ?set cube:observation ?obs .
  ?obs h:station ?st ; h:measurementTime ?time .
  ?st schema:identifier ?id ; schema:name ?name .
  OPTIONAL { ?st schema:containedInPlace ?water }
  OPTIONAL { ?st geo:hasGeometry/geo:asWKT ?wkt }
  OPTIONAL { ?obs h:discharge ?q } OPTIONAL { ?obs h:waterLevel ?w }
  OPTIONAL { ?obs h:waterTemperature ?t } OPTIONAL { ?obs h:dangerLevel ?dl }
}
```
For lakes, replace `river` with `lake`. Each observation can also be fetched directly, for example `https://environment.ld.admin.ch/foen/hydro/river/observation/2091` with `Accept: text/turtle`.

**Units** come from the cube shape at `https://environment.ld.admin.ch/foen/hydro/river/shape`: discharge `unit:M3-PER-SEC`, waterLevel `unit:M`, waterTemperature `unit:DEG_C`, dangerLevel an integer.

**What the snapshot showed:**
- **Time:** `measurementTime` always uses a fixed `+01:00` offset. For example, `2026-09-23T20:40:00+01:00` is 19:40Z, the same instant as the website's 21:40 CEST.
- **Cadence per station:** most stations are on a 10-minute clock. A few report every 20 or 60 minutes (9 stations stood at 20:00+01:00).
- **Stale stations:** 2269 Blatten was destroyed by the rockslide of 2025-05-28. 2283 is stale since 2026-09-17 and 2356 since 2026-09-22. The shape's `sh:minInclusive` gives away the oldest stale timestamp. **Every value needs a freshness check.**
- **Duplicates:** stations 520 and 2283 return two observations each. Keep the one with the latest time per station.
- **Missing danger level:** 36 stations show `dangerLevel` as `https://cube.link/Undefined` because they have no thresholds.
- **Relative gauges:** some small stations report water level relative to a local zero (values such as 0.074 m, -0.137 m), not m ü. M.
- **Missing parameters:** 2289 Basel and 2205 Stilli have no real-time temperature. 2288's temperature is currently flagged as distorted by low water, and that flag appears only on hydrodaten (see 3.2).
- **No history:** only two hydro cubes exist (`lake`, `river`), both "current". Each observation URI is keyed by station and overwritten on every update.
- **Endpoint behaviour:**
  - The response headers allow cross-origin requests (`access-control-allow-origin: *`) and send no rate-limit headers.
  - The endpoint's own terms of use are **UNVERIFIED**; BAFU's data terms still apply (section 6).
  - A third-party source mentions a 30-second runtime limit per query (**UNVERIFIED**).
  - Broad unanchored queries timed out at 90 s. Always anchor queries on the cube.

### 3.2 hydrodaten.admin.ch internal JSON (best content, not a contract)

**`/web-hydro-maps/hydro_sensor_pq.geojson`** (about 250 kB, EPSG:2056)

One call gives the whole network. Example feature, Rheinfelden (abridged):
```json
{"key":"2091","label":"Rhein - Rheinfelden, Messstation","kind":"river",
 "hydro_body":"Rhein von Mündung Aare bis Mündung Ergolz","last_value":"475","metric":"discharge_ms","unit":"m³/s",
 "last_measured_at":"2026-09-23T22:00:00.000+02:00","min_24h":"292","max_24h":"475","mean_24h":"358",
 "sensor_waterlevel_last_value":"261.35 m ü.M.","wl_1":"2500 m³/s","wl_2":"3000 m³/s","wl_3":"3600 m³/s","wl_4":"4500 m³/s",
 "threshold_customer":"1760 m³/s","failure_text":null,"failure_valid_from":null}
```
- `wl_1`–`wl_4` are the lower bounds of danger levels 2, 3, 4 and 5. 180 of 207 stations have them. For lakes they are in m ü. M., for example Ägerisee `724.10 m ü.M.`.
- `threshold_customer` exists for 16 stations. Its meaning is **UNVERIFIED**; it may be a notification threshold.
- `failure_text` holds operational notices in the station's own language, for example the 2288 temperature fault and the 2269 station destroyed in the 2025 rockslide.
- Values are strings with units attached. The parser must strip the units.

**Plot JSON under `/plots/…`** (Plotly format)
- `p_q_7days` and `p_q_40days` hold a "Wasserstand" trace (m ü. M.) and an "Abfluss" trace (m³/s) at 5-minute steps. Timestamps are local with an offset, such as `2026-09-17T00:05:00.000+02:00`.
- A 40-day file is about 900 kB per station.
- The threshold bands are in `layout.shapes`: filled rectangles, yellow #FFFF00 / orange #FF9900 / red #F7001D / dark red #800000, with `y0`/`y1` equal to the thresholds.
- `pq_group` returns neighbour stations together. For 2091 that is Rheinfelden, Aare-Brugg, Reuss-Mellingen, Limmat-Baden and Thur-Andelfingen.

**Station HTML** at `https://www.hydrodaten.admin.ch/de/seen-und-fluesse/stationen-und-daten/{id}` (the old `/de/{id}.html` redirects there with a 301). It holds the metadata in section 4, the period of record, links to yearly tables (PDF) and fault banners.

**Robustness:** there is no robots.txt; the URL returns a 404 page. There is no documented API. Treat these URLs as volatile, validate them against a schema, and keep a fallback to LINDAS.

### 3.3 Official open-data layers on geo.admin.ch

These are listed on opendata.swiss with "Open use" terms, for example `vergleich-von-abfluss-und-pegeldaten-mit-den-gefahrenstufen`, `allgemeine-lage-der-fliessgewasser-und-seen`, `hochwasserwarnkarte` and `hydrologische-stationen-mit-vorhersagen`. `layersConfig` points them to data.geo.admin.ch GeoJSON files. The `api3.geo.admin.ch` feature lookup returns 400 "No Vector Table" for these layers, so use the GeoJSON directly.

| Layer | What it contains |
|---|---|
| `…_zustand` | 200 features: `quant-class` 1–5 = monthly percentile class from very low to very high, 0 = no data. **No numbers.** |
| `…_gefahren` | 182 features: `quant-class` = current danger level (178 at level 1, 3 at 0 = no data). |
| `…_vorhersage` | 55 forecast stations: `param` Abfluss (40) or Pegel (15). |
| `ch.bafu.hydroweb-warnkarte_national` | 93 features: 42 river sections (MultiLineString), 13 lakes and 38 regions (MultiPolygon); `ws-class` such as `River.1` and `Region.0`. `ID` is **not unique across types**. Issued 05:24Z. |

The `data.zip` behind opendata.swiss (`…_gefahren/data.zip`) is **stale** (Last-Modified 2024-08-27). Do not use it.

### 3.4 Forecasts, danger levels and warnings (Gefahrenstufen)

**How BAFU forecasts** (`https://www.bafu.admin.ch/de/hydrologische-vorhersagen-und-warnungen`):
- BAFU runs the **WaSiM** model at hourly resolution.
- Forecasts are "created daily … updated several times a day". The forecast-stations page says they are published "once a day (several times a day during floods)".
- The forecast graphics are said to show the next 3 days, but the JSON checked live ran **115 hours** (19:00 on 23 Sept to 14:00 on 28 Sept).
- The ensemble has "21 model results", which matches MeteoSwiss ICON-CH2-EPS (21 members, 5 days). BAFU's page lists only SwissMetNet, cantonal and neighbouring-country stations plus radar as inputs. The link to ICON-CH1/CH2-EPS and IFS-ENS comes from web search only and is **UNVERIFIED** against a BAFU document.
- **Coverage:** 55 stations, and **every key station in section 4 has a forecast** (all returned 200).

**Danger levels and warnings:**
- There are 5 national danger levels. BAFU warns the cantons through the national alarm centre (NAZ) from level 2 upward.
- The "Hochwasser-Ausblick" is a 5-day outlook with three probability classes (>70 %, 40–70 %, <40 %), updated daily at 12:00. It is only available as HTML; no machine-readable form was found (**UNVERIFIED** that none exists).
- The warning-map sections are machine-readable through source E (`valid_from`/`valid_until`) and source F.
- The official, authoritative wording lives in the Naturgefahrenbulletin on naturgefahren.ch. A web search reports that the old aggregated naturgefahren.ch API was discontinued (**UNVERIFIED**). The MeteoSwiss open-data catalogue has no warnings category.

**Danger thresholds per station** are machine-readable through the `wl_1`–`wl_4` fields (source B) and the forecast/plot shapes. The station HTML shows them as a table, and the values match.

### 3.5 History

- **Official bulk history:** order it through the Datenservice Hydrologie. Available as 5-min, 10-min or hourly means from 1974, and as daily, monthly and yearly values back to the 19th century (Basel-Rheinhalle discharge from 1868). Quality status is raw, checked (about 1 month later) or validated (the following year).
- **Sample CSV** (`https://www.bafu.admin.ch/dam/de/sd-web/6BXSUZsNMYvz/beispiel-abfluss-stundenmittel.csv`): Latin-1 encoded, semicolon-separated, with an 8-line header block. Columns: `Stationsname;Stationsnummer;Parameter;Zeitreihe;Parametereinheit;Gewässer;Zeitstempel;Zeitpunkt_des_Auftretens;Wert;Freigabestatus`.
- **Conflict on time zone:** the sample CSV writes `2017-12-01 00:00:00+00:00`, while the FAQ says historical data is in UTC+1 and timestamps mark the start of the interval. **Clarify with BAFU before any backfill.**
- **Online without ordering:** 40 days of raw data (source C). Yearly tables as PDF from 1993.
- **data.bs.ch** gives 657,503 records for 2289 from 2020-06-22 and 410,279 for 2106 from 2022-10-29, at 5 minutes, in UTC. Its field names are counter-intuitive: `pegel` is the water level in m ü. M., and `pegelhoehe` is the gauge reading in cm, equal to water level minus 240 m ü. M. (Port of Switzerland gauge).
- **existenz.ch** keeps only about 30 days.

---

## 4. Key stations (verified 2026-09-23)

Coordinates are WGS84 from LINDAS. Snapshot values are from LINDAS at 19:40Z. Thresholds are the lower bounds of levels 2/3/4/5 in m³/s. Every station listed has a BAFU forecast.

| Nr | River – station | Lon, lat | Q m³/s | W m ü. M. | T °C | Thresholds L2/L3/L4/L5 | Elevation; catchment | Data from | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **2289** | Rhein – Basel, Rheinhalle | 7.61668, 47.55943 | 456.5 | 244.938 | – | 2550/3050/3700/4700 | 260 m; 35,878 km² | Q 1868, W 1974 | Last Swiss station before FR/DE; no temperature |
| **2091** | Rhein – Rheinfelden | 7.79991, 47.56071 | 445.4 | 261.311 | 19.9 | 2500/3000/3600/4500 | 265 m; 34,524 km² | Q 1933, W 1964 | Record 4,550 m³/s on 12.05.1999 |
| **2143** | Rhein – Rekingen | 8.32983, 47.57035 | 155.4 | 321.923 | 18.17 | 1150/1500/1700/1900 | 326 m; 14,767 km² | Q 1904, W 1964 | Upstream of the Aare confluence |
| **2288** | Rhein – Neuhausen, Flurlingerbrücke | 8.62630, 47.68147 | 123.9 | 382.222 | 15.34* | 670/890/1000/1150 | 388 m; 11,930 km² | Q 1904, W 1964 | *Temperature flagged distorted since 27.07.2026 |
| **2473** | Rhein – Diepoldsau, Rietbrücke | 9.64091, 47.38307 | 83.9 | 407.035 | 13.39 | 1300/1950/2450/3050 | 412 m; 6,299 km² | Q 1919, W 1984 | Alpine Rhine above Bodensee; also O₂ and turbidity |
| **2016** | Aare – Brugg | 8.19488, 47.48253 | 124.7 | 331.062 | 19.49 | 820/1100/1250/1350 | 336 m; 11,681 km² | Q 1916, W 1964 | Above the Reuss/Limmat confluences |
| **2205** | Aare – Untersiggenthal, Stilli | 8.23472, 47.51591 | 207.4 | 325.415 | – | 1550/2050/2300/2550 | 331 m; 17,553 km² | Q 1904, W 1975 | Below Reuss+Limmat; temperature is computed, not measured |
| **2018** | Reuss – Mellingen | 8.27127, 47.42103 | 47.3 | 343.743 | 19.67 | 480/640/720/830 | 346 m; 3,386 km² | Q 1904, W 1964 | |
| **2243** | Limmat – Baden, Limmatpromenade | 8.30941, 47.47570 | 33.7 | 349.999 | 20.55 | 350/480/550/630 | 353 m; 2,394 km² | Q 1951, W 1964 | |
| **2044** | Thur – Andelfingen | 8.68197, 47.59652 | 3.9 | 354.553 | 17.71 | 500/700/1150/1400 | 361 m; 1,702 km² | Q 1904, W 1964 | Flashy river; WMO centennial station |
| **2106** | Birs – Münchenstein, Hofmatt | 7.61879, 47.51832 | 1.6 | 267.128 | 16.46 | 140/220/280/350 | 271 m; 887 km² | Q 1908, W 1964 | Also on data.bs.ch 100236 |

Useful additional Rhine-chain stations in the same feeds: Bodensee Romanshorn **2032** and Berlingen **2043** (lake levels), Rhein Domat/Ems **2602**, Aare Bern-Schönau **2135**, Brügg-Aegerten **2029** and Murgenthal **2063**, Rhein Basel-Klingentalfähre **2615**. Bodensee and the regulated Jura lakes (Bielersee and others) strongly damp and delay flood waves. That matters for the "follow the water downstream" feature.

---

## 5. Units, datum and time

- **Discharge:** m³/s (`metric: discharge_ms`); 6 small stations use l/s (`discharge_ls`).
- **Water level:** m ü. M. on **LN02** ("Die Höhenangaben … beziehen sich auf das Schweizerische Landesnivellementsnetz LN02", BAFU FAQ). BAFU does not use LHN95. A few stations use a relative gauge (see 3.1).
- **Cross-border offset:**
  - Derived: BfG Undine gives the Basel gauge zero as **NHN + 239.68 m**, and Basel-Stadt defines the Rheinhalle gauge as water level − **240 m ü. M.** (LN02). So **LN02 ≈ NHN + 0.32 m at Basel**.
  - Web search reports about 32 cm at the Rhine border and 36 cm at Schaffhausen, with BKG's D-A-CH height-transformation tool as the source (not opened; **UNVERIFIED** beyond the Basel derivation).
  - The NAP↔NHN difference was not checked here.
  - Recommendation: never compare absolute levels across borders. Use discharge, level relative to thresholds, or percentiles.
- **Time:**
  - Live data is in local time with an explicit offset: `+02:00` in summer in the hydrodaten JSON, fixed `+01:00` in LINDAS. The FAQ says "Rohdaten sowie auch Vorhersage-Werte werden jeweils in Ortszeit publiziert". (The FAQ itself mislabels summer time as "UTC+2 (MEZ)".)
  - Historical exports are in winter time (UTC+1), with the timestamp at the start of the interval. The sample CSV contradicts this (3.5).
  - data.bs.ch is in UTC.
  - **Store everything as UTC `timestamptz`.**
- **Resolution and quality:** loggers record 5- or 10-minute means, rarely 2-minute. Everything live is **raw** data (Rohdaten); checked data follows after about 1 month, validated data the following year.
- **Coordinates:** GeoJSON files are in EPSG:2056 (LV95). LINDAS gives WGS84 WKT.

---

## 6. Licence, terms and attribution

- **BAFU delivery and usage conditions for hydrological data, 2020** (`https://www.bafu.admin.ch/dam/de/sd-web/g7vjiKP5LJ11/liefer-nutzungsbedingungen-hydrologische-daten.pdf`):
  - "Freie Nutzung": commercial and non-commercial use allowed.
  - "Die Angabe der Quelle wird empfohlen" (naming the source is recommended).
  - No liability accepted.
- **General conditions for current raw data and forecasts, 16.09.2019** (`https://www.bafu.admin.ch/dam/de/sd-web/5NAitqNKub6m/allgemeine_bedingungenfuerdasherunterladenaktuellerhydrologische.pdf`):
  - §6: download **"nicht häufiger als alle 10 Minuten"** (no more often than every 10 minutes).
  - §8: forecasts "dürfen frei verwendet werden" (may be used freely). Warnings on small and medium rivers are the cantons' responsibility. When redistributing forecasts, an explanation of how to read them is recommended.
  - The document is written for account-based downloads, but it is the only rate rule BAFU publishes. Apply it everywhere.
- **opendata.swiss terms** (verified on its terms-of-use page):
  - "Open use" (the geo.admin layers, data.bs.ch): commercial use allowed, source recommended.
  - "Open use. Must provide the source" (terms_by; the STAC station-metadata collection): source required.
- **Suggested attribution** (BAFU FAQ): "Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum)". Proposed page text:
  - EN: "Swiss river data: Federal Office for the Environment FOEN, Hydrology Division (raw, unverified data; retrieved <date>)"
  - NL: "Zwitserse riviergegevens: Bundesamt für Umwelt BAFU, afdeling Hydrologie (ruwe, ongecontroleerde gegevens; opgehaald <datum>)"
  - Add "Kanton Basel-Stadt, data.bs.ch" wherever that dataset is used.
- **Disclaimer to show:** "In case of warnings, the Naturgefahrenbulletin on www.naturgefahren.ch is authoritative; forecasts are direct model output." This mirrors the hydrodaten wording.

---

## 7. Flood travel time Basel → Lobith

No single authoritative figure was found. The pieces that are sourced:

- **Basel → Karlsruhe/Maxau: about 23 h.** It "has been reduced from 64 to 23 hours" by the Upper Rhine training works (IKSR/ICPR, `https://www.iksr.org/en/topics/floods/water-retention`).
- **Andernach → Lobith: about 28–49 h** for Lobith peaks of 5,640–10,000 m³/s. Source: Rijkswaterstaat note GWIO 85.006, "Looptijden hoogwatergolven op de Rijn" (de Vrees, Aug 1985), appendix 1 (`https://open.rijkswaterstaat.nl/publish/pages/61132/gwio_85006.pdf`).
  - Cologne → Lobith: about 22–40 h.
  - *Correction, 2026-10-10 (#110): the scan of appendix 1 gives Andernach 28¾–48¾ h and Cologne 22½–40¾ h, so "28–49" above is 48¾ rounded up and "22–40" floored 40¾. The registry uses whole hours rounded outward: Andernach 28–49, Cologne 22–41 (catalogue §3.7, §8 C1).*
  - Travel time depends strongly on discharge. It slows as floodplains fill, around 5,000 m³/s at Lobith, and speeds up again once floodplains carry flow, around 7,000 m³/s.
- **Maxau → Andernach:** not sourced (**UNVERIFIED**; in the order of 1–1.5 days).
- **Overall estimate: about 3–4 days** for a flood crest from Basel to Lobith. This is an **UNVERIFIED** composite. A Dutch blog (klimaatgek.nl, 2026-08-30) quotes "6 days"; it is not authoritative and probably describes mean flow.
- Recommendation: model this as configurable, discharge-dependent lag per river segment, calibrated later from your own collected data. Label it "indicative" in the UI.

---

## 8. Tech stack implications (the stack is new)

The Swiss source shapes these choices:

1. **Ingestion workers in Python 3.12**, one adapter per provider, using httpx, tenacity and pydantic.
   - **Swiss adapter:** SPARQL POST to LINDAS as the primary source, plus `hydro_sensor_pq.geojson` as a secondary source for faster values, thresholds and fault notices. Every 10 minutes, offset to about :04/:14/…
   - **Forecast adapter:** 55 `q_forecast` files hourly. They carry no run ID, so a change of run start plus the file's `Last-Modified` defines a new run. Store forecasts per run.
   - **Warning adapter:** `hydro_warn_levels_{lang}.geojson` every 30–60 min.
   - **Each cycle:** send conditional GETs (`If-Modified-Since`/ETag, which data.geo.admin.ch and hydrodaten support), set a descriptive `User-Agent` with a contact address (opendata.swiss rejects the default curl UA), save raw payloads to disk (zstd) so they can be replayed, and deduplicate on (station, parameter, UTC timestamp).
   - **On first start:** a one-off 40-day backfill from `p_q_40days` for the key stations.
2. **PostgreSQL 16/17 with TimescaleDB and PostGIS** in one container.
   - Tables:
     - `station` holds the provider ID, native CRS with both LV95 and WGS84 coordinates, `datum_code='LN02'`, the gauge zero and the river-network link.
     - `series` holds station, parameter and unit.
     - `observation` is a hypertable of `(series_id, ts timestamptz, value, quality='raw', source, ingested_at)`.
     - `forecast_run` and `forecast_value` hold `(run_id, ts, p0, p25, p50, p75, p100)`.
     - `threshold` holds `(series_id, level, lower_bound, unit, source, valid_from)`.
     - `warning_section` holds geometry, level and `valid_from`/`valid_until`.
   - Size: about 230 CH stations × up to 3 parameters × 144 values/day is about 100k rows/day, or about 35 M rows/year. That is trivial for TimescaleDB with compression.
3. **API layer: FastAPI**, sharing the models with the workers. The central "state at time T" query uses `LATERAL … ORDER BY ts DESC LIMIT 1` per series within a staleness window. Add continuous aggregates (hourly and daily) for fast time-slider scrubbing. Round T to 10 minutes so responses can be cached.
4. **Surviving flood-time traffic spikes.** Precompute a snapshot JSON of all stations per 10-minute tick and serve it with long cache headers through Caddy or nginx. Optionally put a CDN in front. Hourly and daily aggregates cover history browsing.
5. **Frontend:** MapLibre GL JS with self-hosted OSM vector tiles (a Protomaps PMTiles basemap, credited "© OpenStreetMap contributors"), a time slider, ECharts or uPlot for charts, and NL/EN i18n. Station names stay in their source language. Map provider section names such as "Rhein von Mündung Aare bis Mündung Ergolz" to your own NL/EN labels.
6. **Operations:** one Docker Compose file with caddy, api, worker(s) and timescaledb-postgis. Add backups (pgBackRest or nightly pg_dump), staleness alerting per provider (for example Uptime Kuma or Prometheus with Grafana), and schema-drift alerts for the undocumented hydrodaten endpoints.

---

## 9. Risks and open questions

- **The hydrodaten JSON endpoints are undocumented.** Keep LINDAS as the fallback for values. The fallback loses thresholds, which you can cache in the database since they rarely change.
- **LINDAS cubes are marked "Draft".** Their schema may change. Monitor the shape.
- **No official live history API.** The site's own database is the archive from go-live. Backfill needs a data order; ask BAFU (hydrologie@bafu.admin.ch) whether they can supply the whole network, 10-min, 2000–present, in one delivery.
- **Time zone of historical CSV** (UTC vs UTC+1) must be clarified with BAFU.
- **Meaning of `threshold_customer`** and the forecast issuance schedule outside floods: ask abfragezentrale@bafu.admin.ch.
- **Forecast redistribution:** allowed, but add an explanation of how to read the forecast and the cantonal-responsibility disclaimer.
- **Datum:** LN02 vs NHN/NAP. Do not plot absolute water-surface profiles across borders without a transformation.

---

## Recommendation for phase planning

1. **Phase 1 (MVP, go-live):**
   - Ingest all Swiss river and lake stations from **LINDAS** every 10 minutes: Q, W, T and danger level; station geometry in WGS84.
   - Enrich with **`hydro_sensor_pq.geojson`** for the 4 thresholds, 24-hour statistics and fault notices.
   - Store UTC and mark all data as raw.
   - Show attribution (section 6) and the naturgefahren.ch disclaimer.
   - Hard-code the 11 key stations in section 4 as the "Rhine chain into NL", together with Bodensee 2032/2043.
   - Enforce ≥10-minute polling and a staleness check per station.
2. **Phase 1b (same release if possible):**
   - Hourly ingestion of the BAFU ensemble forecasts (median, 25–75 %, min/max; 55 stations, including all key stations).
   - Warning sections from `hydro_warn_levels_{lang}.geojson` (or the official `ch.bafu.hydroweb-warnkarte_national` GeoJSON), with `valid_from`/`valid_until`.
   - A one-off **40-day** backfill from `p_q_40days` for the key stations.
3. **Phase 2 (history):**
   - Import data.bs.ch for 2289 (from 2020) and 2106 (from 2022) through its API.
   - File a Datenservice order for validated 10-min or hourly Q/W series of the key stations. From 1974 is available, but 2000+ is enough for the UI. Resolve the CSV time-zone question first.
   - Load it as quality "validated" or "checked", alongside the raw data.
4. **Phase 3 (downstream following):**
   - Discharge-dependent segment lags. Basel→Maxau about 23 h (IKSR) and Andernach→Lobith 28–49 h (RWS 1985) are the sourced anchors; calibrate the rest from your own collected CH/DE/NL series.
   - Use discharge or threshold-relative display, not LN02 levels, for the cross-border view.
5. **Do not build on** geo.admin `data.zip` (stale since 2024), existenz.ch (third-party, about 30 days) or HTML scraping of station pages. The one exception is the one-off metadata harvest (elevation, catchment, period of record) if the STAC shapefile does not provide it.

Sample payloads from this run are saved in `(research-session scratch files, not kept)`.

**Sources:**
- https://www.hydrodaten.admin.ch/de/aktuelle-hydrologische-daten-beziehen
- https://www.hydrodaten.admin.ch/de/fragen
- https://www.bafu.admin.ch/de/datenservice-hydrologie-fuer-fliessgewaesser-und-seen
- https://www.bafu.admin.ch/de/hydrologische-vorhersagen-und-warnungen
- https://www.hydrodaten.admin.ch/de/erlauterungen-zu-den-vorhersage-plots
- BAFU delivery and usage conditions 2020: https://www.bafu.admin.ch/dam/de/sd-web/g7vjiKP5LJ11/liefer-nutzungsbedingungen-hydrologische-daten.pdf
- BAFU general conditions 2019: https://www.bafu.admin.ch/dam/de/sd-web/5NAitqNKub6m/allgemeine_bedingungenfuerdasherunterladenaktuellerhydrologische.pdf
- https://opendata.swiss/en/terms-of-use
- https://data.bs.ch/api/v2/catalog/datasets/100089
- https://undine.bafg.de/rhein/pegel/rhein_pegel_basel.html
- https://www.iksr.org/en/topics/floods/water-retention
- https://open.rijkswaterstaat.nl/@87627/looptijden-hoogwatergolven-rijn/
- https://www.meteoswiss.admin.ch/weather/warning-and-forecasting-systems/icon-forecasting-systems.html
- https://opendatadocs.meteoswiss.ch/
- https://gibs.bkg.bund.de/geoid/de/dacherlaeuter_em.php
- https://klimaatgek.nl/wordpress/2026/08/30/nogmaals-rijnafvoer/ (non-authoritative)