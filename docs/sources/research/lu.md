# Luxembourg (AGE) hydrology open data: research for phase planning

**Scope:** Luxembourg only. The Administration de la gestion de l'eau (AGE) runs inondations.lu. I also looked at data.public.lu, geoportail.lu and LU-Alert, and at where these overlap with German PEGELONLINE.
**When:** 2026-09-23, roughly 19:55–20:25 UTC (21:55–22:25 CEST).
**Labels:** **[V]** means I called it live and checked the result. **[UNVERIFIED]** means it comes from documents or inference only.

---

## 1. Summary

- **inondations.lu was relaunched on a new platform (Adobe AEM) in February 2026.** Every old export URL (for example `https://www.inondations.lu/water-level-export/all`) now just redirects to the new home page. The INSPIRE metadata still points at those dead links. [V]
- **Current water levels (W) for 42 stations** come as one static JSON file per station, plus one CSV covering all stations. Values are every 15 minutes, in cm above the gauge zero. The JSON holds a rolling 7 days, the CSV a rolling 5 days. Measured delay is about 11–25 minutes. [V]
- **No live discharge (Q) is published.** Not in the JSON, the CSV or the geoportail layers, even though the stations measure it (the station fiche for Diekirch ticks "Débit"). [V, I checked those channels only]
- **Forecasts:** one JSON file per station per percentile (p10, p30, p50, p70, p90), for 14 stations. Each run is hourly steps about 45 h ahead. AGE runs refresh hourly; I saw one refresh land at 20:11–20:19 UTC. The Moselle forecasts come from the Landesamt für Umwelt Rheinland-Pfalz (LfU RLP), and their start time jumped 3 h (17:00 to 20:00 CEST). The files carry no issue time and old runs are not archived. [V]
- **Thresholds per station** sit in a JSON attribute inside each station's HTML page. They include the orange and red "vigilance" levels and water levels equivalent to the HQ2–HQ100 floods (all in cm), plus the gauge zero, river kilometre and catchment area. [V]
- **Official flood alerts are regional**, not per station. There are 3 AGE zones: Nord, Sud and Moselle. They are issued through LU-Alert in the CAP-LU format (a Luxembourg profile of the Common Alerting Protocol), in FR, DE and EN. The documented, CC BY-licensed copy is on data.public.lu, about 4 minutes after an alert is sent. [V]
- **Licence:** the data.public.lu dataset "Niveau d'eau" is **CC0** and explicitly lists the CSV hosted on inondations.public.lu. The per-station JSON files, the forecast files and the page-embedded thresholds are **not listed anywhere**. Their only terms are the website's own conditions of use, which are restrictive. **We need AGE's written confirmation.** [V]
- **Duplicates with PEGELONLINE:**
  - Perl and Stadtbredimus are **byte-identical** to PEGELONLINE 26100100 and 26100130: 669/669 and 671/671 values match over 7 days.
  - Grevenmacher is a near-duplicate of PEGELONLINE 26100200 (differences up to 3 cm).
  - Remich and Wasserbillig (Moselle), and all Sûre, Our and Alzette stations, are **not** in PEGELONLINE. [V]
- **Data bug:** the CSV's time labels are **15 minutes late** compared with the JSON and PEGELONLINE. Its timestamps also carry no UTC offset, so they are ambiguous during the daylight-saving change. [V]

---

## 2. Sources at a glance

| # | Source | What it holds | Format | Status | Licence | Use in MVP? |
|---|---|---|---|---|---|---|
| A | Per-station JSON `inondations.public.lu/content/dam/inondations/ctie/datas/<File>.json` | W, 15-min, 7 days, ISO 8601 with offset | JSON | [V] 41/42 return 200 (Remich returns 404) | Not stated; covered only by the site's conditions (see §9) | **Primary** for observations, once AGE confirms |
| B | CSV `https://inondations.public.lu/dam-assets/ctie/datas/Water-Levels-LocalTime.csv` | W, all 42 stations, 15-min, 5 days, wide table | CSV | [V] | **CC0** (listed on data.public.lu) | Fallback, and the only source for Remich |
| C | Forecasts `https://inondations.public.lu/percentile/<slug>-p{10,30,50,70,90}.json` | Hourly, about 45 h, 14 stations | JSON | [V] | Not stated | Yes, once AGE confirms |
| D | Station page `data-to-json` attribute | Thresholds, gauge zero, river km, catchment, operator, notes | JSON inside HTML | [V] | Not stated | Scrape weekly, once AGE confirms |
| E | LU-Alert CAP-LU dumps on data.public.lu | Flood vigilance per zone | CAP XML | [V] | **CC BY, credit "LU-Alert"** | **Yes** |
| E2 | `https://inondations.public.lu/ctie/lualert?sender=AGE…` | Same alerts as JSON | JSON | [V] | Not stated; undocumented | No (use E) |
| F | pygeoapi `https://features.geoportail.lu/collections/655/items?f=json` | 51 station points in WGS84, links to station fiches | GeoJSON (OGC API – Features) | [V] | CC0 | Yes, station geometry |
| G | WMS `https://wms.geoportail.lu/public_map_layers/service`, layer `655` | Station map layer | WMS 1.3.0 | [V] (no WFS: GetCapabilities returns 400) | CC0 | Optional |
| H | INSPIRE Environmental Monitoring Facilities GML (data.public.lu) | 51 stations, EPSG:3035 | GML | [V] | CC0 | No (stale metadata) |
| I | River network `https://features.geoportail.lu/collections/749/23` (primary rivers, 311 features); flood-zone collections 3036/3037/3065/3261–3263 | Map context | GeoJSON | [V] | CC0 | Later phase |
| J | Validated history 2002–2022/24 | Water level + discharge | On request | [V] (AGE annual report 2024, p.19) | [UNVERIFIED] | Backfill phase |
| — | SensorThings / KISTERS KiWIS / OGC SOS | — | — | **None found.** `ts_path` values show AGE uses a WISKI database internally (confirmed in the report), but nothing is public | — | — |

---

## 3. inondations.public.lu in detail

### 3.1 Observations: per-station JSON [V]
- **URL pattern:** `https://inondations.public.lu/content/dam/inondations/ctie/datas/<File>.json`. The same file is also served at `/dam-assets/ctie/datas/<File>.json`.
- **Where the file name comes from:** the `jsonFile` field on each station page. Some names contain non-ASCII characters and must be URL-encoded, for example `Ettelbr%C3%BCck-Alzette.json`.
  - Other non-ASCII names: `Pétange.json`, `Müllerthal.json`, `Gemünd_Our.json`.
  - Moselle names: `SN_Grevenmacher.json`, `SN_Stadtbredimus.json`, `SN_Wasserbillig.json`. `SN_Remich.json` returns **404**.
  - Irregular spellings: `Hunnebuer.json` (the station is "Hunnebour"), `Roodt-sur-Syre.json`, `Esch-Sure.json`.
- **Example** (Diekirch):
  ```
  [{"ts_path":"0/11/W_out/15m.Cmd.RelAbs.P","ts_unitsymbol":"cm","station_name":"Diekirch",
    "parametertype_name":"W","rows":"671","columns":"Timestamp,Value",
    "data":[["2026-09-16T22:15:00.000+02:00",122.0], … ,["2026-09-23T21:45:00.000+02:00",121.0]]}]
  ```
- **`ts_path` contains a stable provider code:**
  - AGE stations are numbered: `0/11/…` is Diekirch.
  - Moselle stations use the navigation service (SN) numbers: `0/02610012/W1/…`.
  - Perl uses the WSV number `0/26100100/W/…`.
  - Stations fed by LfU RLP carry the suffix `W_out_LFU`, for example Gemünd `0/26260303/…`.
  - Use these codes as IDs, not the names.
- **Units:** cm above the gauge zero. The exception is Esch-Sûre dam (`W_out_LAC`, unit `m`), which gives the absolute lake level in m NN, for example 314.35.
- **Time zone:** Europe/Luxembourg local time, with an explicit offset (`+02:00` in summer).
- **Window:** about 671 values, a rolling 7 days (the chart on the site shows 72 h). Missing values are simply left out rather than set to null. I found one 30-minute gap each at Livange and Schoenfels.
- **Delay after the measurement time:** usually 11–19 minutes. The 22:00 CEST value appeared between 20:10:55 and 20:18:56 UTC. Some stations lag 30–60 minutes: Perl, Eischen and Ubersyren.
  - Eischen's page note says it sends hourly, and every 15 minutes once the level is above 100 cm.
- **HTTP behaviour:**
  - The files sit behind Cloudflare with `cache-control: public, max-age=14400` (4 h). The CDN copy itself refreshes within a few minutes.
  - `last-modified` is always the request time, and there is no ETag. Conditional requests therefore save nothing.
  - No CORS header is sent, so browsers cannot fetch the files directly and our backend must proxy them.
  - robots.txt forbids query strings (`Disallow: /*?*`), so **never add cache-busting query parameters**.
- **Rate limits:** none documented. [UNVERIFIED]

### 3.2 Bulk CSV (the CC0-licensed route) [V]
- `https://inondations.public.lu/dam-assets/ctie/datas/Water-Levels-LocalTime.csv`, about 154 KB, `text/csv`.
- **Layout:** a wide table. Header row is `"Name","Number","Unit","18.09.2026 22:00",…` with 480 time columns (5 days). One row per station, 42 rows.
  - The `Number` column is **empty**, so rows can only be matched by name (`SN_Remich`, `Gemünd_Our`, …).
  - Each data row has one more column than the header (a trailing separator).
- **Timestamps:** local time with no offset, so the hour that repeats on the autumn clock change (25 Oct 2026, 02:00–03:00) is ambiguous.
- **15-minute offset bug:** the value under CSV label T is the value that the JSON and PEGELONLINE give for T−15 min. I checked this against the JSON (479/480 exact matches at Diekirch and Stadtbredimus) and against PEGELONLINE (94/94 at Perl, 95/95 at Stadtbredimus).
- The companion "Export by station" link, `…/Water-Levels-Localstation.csv`, returns **404**, even though data.public.lu lists it.
- data.public.lu note (09/2026): *"Les niveaux d'eau mesurés sont désormais disponibles qu'en heure locale…"* (measured levels are now only available in local time). The INSPIRE metadata still says "UTC+1 all year", which is out of date.

### 3.3 Forecasts [V]
- **URL:** `https://inondations.public.lu/percentile/<slug>-p50.json`; `-p10`, `-p30`, `-p70`, `-p90` also exist.
- **How the slug is built** (taken from the site's JavaScript): take `forecastsFileName` if the page has one, otherwise the station `id`. Then trim, lowercase, strip accents, turn `/` (with any surrounding spaces) into `-`, turn spaces into `-`, and collapse repeated `-`. So `Ettelbrück-/-Alzette` becomes `ettelbruck-alzette`, and Gemünd becomes `gemund-our`.
- **Format:**
  ```
  {"rows":null,"columns":null,"data":[["2026-09-23T20:00:00.000+02:00",121.0],…],
   "ts_path":null,"ts_unitsymbol":null,"station_name":"DIEKIRCH","parametertype_name":null}
  ```
  Values are in cm and **there is no issue time**. The first step is one hour before the latest full hour; I use it as the run identifier.
- **Stations returning 200:** ettelbruck-alzette, ettelbruck-wark, hesperange, mersch, bissen, bigonville, diekirch, rosport, kautenbach, dasbourg, gemund-our, perl, stadtbredimus, wasserbillig.
  - **Configured on the page but 404:** bollendorf (display window 48 h) and grevenmacher.
- **Horizon:** AGE runs have 46 hourly steps (about 45 h); LfU runs have 45. The site shows only 24 h or 48 h per station (`forecastsLimit` h24/h48). **We should respect that display limit.**
- **Who computes them:** most by AGE with the LARSIM model (AGE 2024 report). Perl, Stadtbredimus and Wasserbillig are computed by LfU RLP.
- **Cadence:**
  - AGE: at 20:10:55 UTC the run started at 20:00 CEST; at 20:18:56 UTC it started at 21:00 CEST, which fits hourly. The site says "toutes les heures"; the government flood-forecast page says "at least every three hours, hourly during floods".
  - LfU: the start time jumped 17:00 to 20:00 CEST, which suggests a 3-hourly run [partly verified].
- **Moselle forecast floor:** below a set level the forecast is a flat line. The station notes give the floors: Perl 250 cm, Stadtbredimus 260 cm, Wasserbillig 220 cm "with uncertainties", Mondorf 250 cm. Perl's live p10 = p50 = p90 = 250.0 while the observed level was about 212 cm. **Values at the floor must be marked "below forecastable range", not shown as a prediction.**
- **No archive:** each run overwrites the last, so **we must store every run ourselves.**
- How the percentiles are produced (for example LARSIM driven by ensemble weather forecasts) is [UNVERIFIED].

### 3.4 Station metadata and thresholds [V]
- **Where:** each station page `https://inondations.public.lu/{fr|de|en}/<basin>/<river>/<station>.html` contains `<cmp-dashboard-station data-to-json="{…}">`. There is no Luxembourgish or Dutch version (404).
- **Fields:** `id`, `jsonFile`, `levelsMax` (yellow/orange/red vigilance levels, where 0 means not defined), `newVigilanceList` (HQ2…HQ100 as **water level in cm**), `zeroScale` (m NN), `pk` (river km), `basinVersion` (catchment in km²), `coordinates` (LUREF E/N), `serviceDate`, `operator`, `forecastsCalcul`, `forecastsLimit`, `bannerInfoText` (notes such as "affected by a dam" or datum changes; available in FR/DE/EN).
- **Quality issues:**
  - Hesperange's easting `786023` is invalid, so take geometry from source F instead.
  - Heiderscheidergrund's date is written `01.111996`.
  - The yellow level is 0 everywhere except Stadtbredimus (530 cm).
- **Official alert gauges** (the notes say "Station d'alerte officielle"): Ettelbrück/Alzette, Hesperange, Mersch, Pfaffenthal, Steinsel, Bissen, Reichlange, Hunnebour, Ettelbrück/Wark, Perl, Stadtbredimus, Bigonville, Bollendorf, Diekirch.
- **Status class per station:** the home page draws a coloured pin for each station, computed by AGE on the server: `lowerboundexceeded` (< MNQ, mean low flow), `mnq` (< MQ, mean flow), `mq` (< HQ2), `hq2`, `hq10`, `hq20`, `hq50`, `hq100`, `notavailable`. The underlying MNQ and MQ levels are **not** published.

### 3.5 Alerts (LU-Alert, CAP-LU) [V]
- **Documented feed:** dataset "Alertes du système LU-ALERT", `https://data.public.lu/fr/datasets/alertes-du-systeme-lu-alert/` (id `67aca67bcaea3ae62308114f`). Licence **CC BY**: *"obligation d'indiquer la source de l'alerte, à savoir LU-Alert"* (you must credit LU-Alert as the source).
  - **Polling:** `https://data.public.lu/api/2/datasets/67aca67bcaea3ae62308114f/resources/?page_size=20` is sorted newest-first and is about 4 KB. Each alert is one XML file (`dump-alert.<epoch>.xml`).
  - 836 files, covering 2025-06 to now, from **all** LU-Alert senders. Filter on `<sender>[AGE]` and `eventCode FLOOD`.
  - Delay: an alert sent at 11:46:21Z was published at 11:50:07Z.
- **What a flood alert contains:**
  - `msgType` Alert, Update or Cancel, plus `references`.
  - Three `info` blocks: fr-FR, de, en-US.
  - Area polygons (lat,lon) for **"AGE Zone Nord du Luxembourg" / "Sud" / "Moselle"**.
  - Parameters `…:cap-lu:1.0:name` (e.g. "Vigilance jaune inondations Moselle") and `…:cb-eu-level`. The level codes map as **ALERT_LVL_1 = red, 2 = orange, 3 = yellow, 4 = information**.
  - Test messages exist: `cb-eu-level=TEST`, headline starting "TEST". Discard them.
- **What the levels mean** (from the site): Information (no risk), Yellow ("Soyez attentifs"), Orange (bulletins at least daily), Red (bulletins at least twice a day).
- **Alternative (not recommended):** `https://inondations.public.lu/ctie/lualert?sender=AGE[&status=INPROGRESS]`. Its response headers include `x-totalresult: 710`, and its history reaches back to Jan 2025. It is undocumented, and its query strings are disallowed by robots.txt.

---

## 4. data.public.lu and geoportail.lu [V]
- **Dataset "Niveau d'eau"** (`https://data.public.lu/fr/datasets/niveau-deau/`, id `59c220a4111e9b1de61d8864`): `cc-zero`, last updated 2026-09-11.
  - Resources: pygeoapi collection 655, WMS, the Geocatalogue record (`124abb10-1d87-4449-912b-06fbf307a95f`), the two CSV links from §3.2, and station geometry as shp/gpkg/geojson (`…/20260911-010313/wasserstand.geojson`, 51 features, WGS84).
- **pygeoapi 0.23.4:** `https://features.geoportail.lu/collections/655/items?f=json&limit=100`.
  - 51 features with attributes `Nom`, `Etat_de_se` (in service / out of service), `Hyperlinks` (station fiche PDF), `Hyperlin_1` (photo), `Hyperlinks_graph` (always null).
  - `bbox` filtering works and `Access-Control-Allow-Origin: *` is set.
  - **No measured values.**
- **Station fiche PDFs:** `http://geoportail.eau.etat.lu/pdf/hydrometrie/FichesStations/<code>-<Name>.pdf`. The file name carries the station code (e.g. `11-Diekirch`, `00229150-Remich`, `02610015-Grevenmacher`). They also list the parameters measured, LUREF coordinates, gauge zero, and the contact `hydrometrie@eau.etat.lu`.
- **The geoportail list has 9 more entries than the 42 on inondations** (not shown there): Bavigne, Grondmillen, Rommelerkräiz, Schéimelzerbesch, Drosbech, Reisdorf, Sassel, Kautenbach (104), plus 2 out-of-service.
- **Precipitation stations:** collection 609 has 18 AGE rain gauges (locations only).
- **Nothing on either portal** for live discharge or forecasts, and no SensorThings, SOS or WFS service.

---

## 5. Requested stations

| Requested | Station (inondations) | River | Code (source) | Obs file | Forecast | Gauge zero (m NN) | km | Area (km²) | Thresholds (cm) | In PEGELONLINE? |
|---|---|---|---|---|---|---|---|---|---|---|
| Schengen | **No LU gauge.** Perl, on the German bank opposite Schengen | Moselle | WSV **26100100** | Perl.json | LfU RLP; floor 250 | 138.50 (PEGELONLINE: 138.491 m NHN) | 241.8 | 11522 | No LU thresholds. PEGELONLINE characteristic values: MW 246, MHW 521, HW 651, HHW 851 | **Yes, identical** (has W and Q) |
| Remich | SN_Remich | Moselle | SN **00229150** (from fiche file name) | **CSV only** (JSON 404) | none | 137.17 | 233.43 | 11555 | HQ5 634, HQ10 680, HQ50 818, HQ100 872 | No |
| (LU's official Moselle alert gauge) | Stadtbredimus | Moselle | SN **02610012** | SN_Stadtbredimus.json | LfU RLP; floor 260 | 134.50 | 229.48 | 11623 | Yellow 530 / orange 620 / red 780; HQ5 774, HQ10 822, HQ20 872, HQ50 975, HQ100 1050 | **Yes, identical** to 26100130 "Stadtbredimus UP" |
| Grevenmacher | SN_Grevenmacher | Moselle | SN **02610015** (`W4/15m.Cmd.O`) | SN_Grevenmacher.json | configured, 404 | 128.25 | 212.5 | 11751 | HQ5 759, HQ10 808, HQ50 939, HQ100 990 | **Near-duplicate** of 26100200 "Grevenmacher UP" (303/670 identical, max difference 3 cm) |
| Wasserbillig (Moselle) | SN_Wasserbillig | Moselle | SN **00229151** | SN_Wasserbillig.json | LfU RLP; floor 220 | 128.25 | 205.92 | 12044 | HQ5 597, HQ10 653, HQ50 738, HQ100 778 | No |
| Wasserbillig (Sauer) | **No Sauer gauge at the mouth.** The lowest Sauer gauge is Rosport. The "Wasserbillig" gauge is on the Moselle; its 12044 km² catchment suggests it sits above the Sauer confluence [inference] | — | — | — | — | — | — | — | — | — |
| Diekirch | Diekirch | Sûre | AGE **11** | Diekirch.json | AGE, 24 h | 185.41 (since 2012-01-02; 186.61 before) | 55.62 | 2149 | Orange 420 / red 470; HQ2 459, HQ5 497, HQ10 522, HQ20 544, HQ50 575, HQ100 597 | No |
| Bollendorf | Bollendorf | Sûre | AGE **15**; operator LfU RLP (`W_out_LFU`) | Bollendorf.json | configured 48 h, **404** | 162.34 | 34.06 | 3227 | Orange 350 / red 425; HQ2 377, HQ5 448, HQ10 500, HQ20 552, HQ50 620, HQ100 671 | No. Also on the RLP portal hochwasser.rlp.de (an app page; I did not identify a feed) [UNVERIFIED] |
| Rosport | Rosport | Sûre | AGE **16** | Rosport.json | AGE, 48 h | 139.95 | 12.83 | 4231.8 | HQ2 548, HQ5 631, HQ10 687, HQ20 739, HQ50 806, HQ100 854 | No |
| Mersch | Mersch | Alzette | AGE **7** | Mersch.json | AGE, 24 h | 212.35 | 16.48 | 707 | Orange 350 / red 400; HQ2 400, HQ5 458, HQ10 498, HQ20 537, HQ50 574, HQ100 600 | No |
| Ettelbruck | Ettelbrück / Alzette | Alzette | AGE **42** | Ettelbrück-Alzette.json | AGE, 24 h | 194.06 | 1.14 | 1091.9 | Orange 180 / red 230; HQ2 232, HQ5 281, HQ10 317, HQ20 348, HQ50 384, HQ100 411 | No |
| Vianden | Vianden | Our | AGE **12** | Vianden.json | none (upstream Dasbourg 13 and Gemünd have forecasts) | 202.00 | 12.09 | 641.3 | HQ2 225, HQ5 259, HQ10 285, HQ20 310, HQ50 344, HQ100 372 | No |
| Wiltz | Wiltz | Wiltz | AGE **38** | Wiltz.json | none (Kautenbach, AGE 14, has one) | 305.28 | 17.46 | 114.5 | HQ2 148, HQ5 178, HQ10 198, HQ20 218, HQ50 243, HQ100 261 | No |
| Clerve | Clervaux | Woltz/Clerve | AGE **35** | Clervaux.json | none | 347.02 | 25.76 | 147.2 | HQ2 160, HQ5 177, HQ10 203, HQ20 218, HQ50 238, HQ100 255 | No |

**Other stations worth including**, with their AGE code (taken from `ts_path`):

- **Sûre:** Bigonville 17 (where the Sûre enters from Belgium; has a forecast), Esch-Sûre dam 40 (m NN), Heiderscheidergrund 19, Michelau 34
- **Our:** Gemünd 26260303 (LfU RLP), Dasbourg 13
- **Wiltz:** Kautenbach 14
- **Clerve:** Troisvierges 37
- **Alzette:** Livange 1, Hesperange 2, Pfaffenthal 3, Steinsel 4, Walferdange 30
- **Attert:** Reichlange 9, Bissen 10
- **Eisch:** Hunnebour 6, Eischen 107
- **Mamer:** Schoenfels 5
- **Wark:** Niederfeulen 27, Welscheid 28, Welscheid-Village 29, Ettelbrück/Wark 41
- **Ernz:** Larochette 43, Müllerthal 39
- **Syre:** Mertert 32, Roodt-Syre 52, Uebersyren 109
- **Gander:** Mondorf 108
- **Pétange 33** on the Chiers: **the only Luxembourg station in the Meuse basin.**

---

## 6. Overlap with Germany (to avoid duplicates) [V]
- **Moselle stations in PEGELONLINE on the Luxembourg border:** Perl 26100100, Stadtbredimus UP 26100130 and OP 26100110, Wincheringen 26100140, Grevenmacher UP 26100200 and OP 2610180.
  - There is **no PEGELONLINE station** for Remich, Wasserbillig, or anything on the Sauer or Our (station lookups return 404 and the water-body filter returns nothing).
- **Recommended rule:**
  - Take Perl and Stadtbredimus from **PEGELONLINE** only. It is the same data, adds discharge at Perl, and has cleaner documentation (licence per the German research [UNVERIFIED here]).
  - Keep AGE's Stadtbredimus **thresholds** (yellow, orange and red levels) attached to that station.
  - For Grevenmacher, pick **one** source and link the other as the same site. I'd lean to PEGELONLINE, but AGE's value is what their thresholds refer to.
  - Remich, Wasserbillig and all Sûre, Our and Alzette stations: take from **AGE** only.
- **Bollendorf and Gemünd** are LfU RLP gauges passed through by AGE. If the German research ingests the RLP portal, they will appear twice. Match them on the codes (Gemünd 26260303) and on coordinates. RLP's code for Bollendorf is unknown [UNVERIFIED].

---

## 7. Units, datum, time
- **W** is in cm above the gauge zero. The only exception is the Esch-Sûre dam, in m NN.
- **Gauge zero** is in "m NN", Luxembourg's NG95 datum, which is tied to the Amsterdam tide gauge (NAP). It agrees with the German NHN values to within 1 cm at the shared gauges (138.50 vs 138.491).
  - Zeros change over time: Diekirch changed in 2012 and Steinsel from 223.26 to 222.26. **Store the gauge zero with a validity period.**
- **Coordinates:** WGS84 from source F; LUREF (EPSG:2169) on the station pages.
- **Time zone:** JSON has ISO 8601 with offset (Europe/Luxembourg). The CSV is local time with no offset and labelled 15 minutes late. Forecasts are ISO 8601 with offset. Alerts use CAP times with offset, or epoch milliseconds on E2.
  - **Convert everything to UTC `timestamptz` when ingesting.**

## 8. How much history each source gives
- **Observations:** 7 days rolling in JSON, 5 days in the CSV. A collector outage of under 7 days heals itself.
- **Forecasts:** only the latest run.
- **Thresholds:** only the current values.
- **Alerts:** CAP files on data.public.lu from about June 2025 (all senders); endpoint E2 from Jan 2025.
- **Validated archive:** high-resolution water level and discharge for 2002–2024, validated for 2002–2022 at most stations, plus regionalised flows. It is available only **on request** from the Service Hydrologie et hydrométrie. AGE handled 346 such requests in 2024 (AGE annual report 2024, p.19) [V]. The licence of delivered data is [UNVERIFIED].
- **Network:** 42 water-level stations and 18 rain gauges, stored in WISKI 7 and transmitted via SODA 5 (same report, p.18) [V].

## 9. Licence and attribution
- **data.public.lu:** the portal default is *"Sauf indication contraire, tout le contenu de ce site est disponible sous Creative Commons CC0"* (unless stated otherwise, all content is CC0). "Niveau d'eau" is CC0, which covers the CSV (B) and station geodata (F, G). No attribution is required, but credit anyway: **"Source: Administration de la gestion de l'eau (AGE), Luxembourg – inondations.lu; Moselle stations: Service de la navigation"**. The INSPIRE record names both as data issuers.
- **LU-Alert CAP:** CC BY, and **"LU-Alert" must be credited**.
- **inondations.public.lu website conditions** (Aspects légaux, 05.08.2026): *"Sauf indication contraire… aucune reproduction… n'est permise sans l'autorisation écrite préalable"*. Otherwise use is personal only and the documents must not be distributed outside the site.
  - This covers the JSON (A), forecasts (C) and page metadata (D), which are **not** listed on data.public.lu.
  - (Oddly, the clause names the Bibliothèque nationale as the body giving authorisation.)
  - **Action: email `hydrometrie@eau.etat.lu`.** Ask that A, C and D be confirmed as CC0 like the "Niveau d'eau" dataset. Report the two 404s (`Water-Levels-Localstation.csv`, `SN_Remich.json`) and the CSV's 15-minute offset.
- **All data is raw and unvalidated:** *"données brutes… collectées automatiquement sans contrôle"*. We need a disclaimer, and should link to inondations.lu as the official channel.

## 10. Risks
- The endpoints are undocumented files from a site relaunched in Feb 2026, and data.public.lu already notes that links changed in 09/2026. **Expect changes without notice.** Validate the schema, header and file name on every fetch, and alert on drift.
- The CSV's 15-minute offset may be fixed silently. **Measure the offset daily** (compare shifts of −15, 0 and +15 min against the JSON) rather than hard-coding it.
- Forecast floors, the missing issue time and the missing archive are covered in §3.3.
- Moselle levels are set by locks and weirs ("perturbé par barrage/écluse"), and several stations are affected by hydropower or plant growth. Show the provider's note next to the value.
- Cloudflare with a 4-hour client max-age: never let an intermediate cache sit between our collector and AGE.
- Discharge is missing for Luxembourg, which limits a comparable flow view along the Sûre and Alzette. Only water levels and HQ-equivalent water levels are available.

## 11. Tech-stack implications
You said the stack is fresh, so here is what the Luxembourg sources require of it, followed by a proposed stack.

**What the Luxembourg sources require:**
1. **Store raw responses before parsing** (compressed, content-addressed). Forecasts, thresholds and notes are overwritten upstream, so only our copy gives history. It also lets us re-parse when the schema changes or the CSV offset bug is fixed.
2. **One adapter module per source** (fetch → archive raw → parse → normalise → upsert), each with a freshness metric.
   - Luxembourg needs 4 adapters: observations (JSON + CSV), forecasts, station metadata, and CAP alerts.
   - A CAP parser for the XML format is reusable for other countries' warnings.
3. **Data model:**
   - A station **cross-reference table** linking provider codes (AGE 11 / SN 02610012 / WSV 26100130 / LfU 26260303) to one canonical station, with a preferred source per parameter.
   - Gauge zero with validity periods.
   - A thresholds table (type, value, unit, source, when fetched; 0 treated as "not defined").
   - Forecast runs as run plus values (percentile, lead time, `below_floor` flag).
   - Alerts with area polygons.
   - All timestamps UTC `timestamptz`.
4. **Time slider:** a snapshot endpoint returning all stations at a 15-minute slot. Past slots never change, so they can be cached for a long time and survive flood traffic spikes. Always serve upstream data through our backend (inondations sends no CORS headers).

**Proposed stack** (fits one VPS with Docker Compose):
- **Database:** PostgreSQL 17 with TimescaleDB (hypertables, compression, continuous aggregates) and PostGIS.
- **Collector:** Python 3.13 (httpx, pydantic v2, lxml, APScheduler) in one container.
- **Read API:** FastAPI, sharing models with the collector.
- **Web server:** Caddy, for automatic TLS, serving the self-hosted OpenStreetMap vector basemap (Protomaps PMTiles) and micro-caching API responses. A free Cloudflare tier is optional for flood spikes.
- **Frontend:** MapLibre GL JS with a static SvelteKit (or Vite + TypeScript) app and NL/EN translations. Alert level names come from the provider in FR/DE/EN; show EN and translate the yellow/orange/red labels ourselves for NL.
- **Monitoring:** Prometheus + Grafana, or Uptime Kuma plus a `/health/sources` endpoint that alarms when Luxembourg data is more than 45 minutes stale.
- **Load from Luxembourg:** 42 JSON files × about 27 KB every 15 minutes, which is about 105 MB/day and 0.05 requests/s. Alternatively one 154 KB CSV every 15 minutes. Send a User-Agent with a contact email, and never add query-string cache busters.

## 12. Sources
- https://inondations.public.lu/fr.html · https://inondations.public.lu/fr/information-niveaux-alertes.html · https://inondations.public.lu/fr/support/aspects-legaux.html · https://inondations.public.lu/fr/hydrometrie.html
- https://data.public.lu/fr/datasets/niveau-deau/ · https://data.public.lu/fr/datasets/alertes-du-systeme-lu-alert/ · https://data.public.lu/fr/pages/api-tutorial · https://data.public.lu/en/pages/fact-sheets/licenses/
- https://features.geoportail.lu/collections/655 · https://wms.geoportail.lu/public_map_layers/service
- https://eau.gouvernement.lu/fr/domaines-activite/inondations/service-de-prevision-des-crues.html · AGE annual report 2024: https://eau.gouvernement.lu/dam-assets/publications/rapports-d'activit%C3%A9/2024.pdf (pp.18–21)
- http://geoportail.eau.etat.lu/pdf/hydrometrie/FichesStations/11-Diekirch.pdf
- https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json?waters=MOSEL,SAAR,SAUER,OUR
- NG95 datum: https://act.public.lu/content/dam/act/fr/publications/documents-techniques/20210322-DTECH-NG95-height-datum.pdf
- LHP / "Meine Pegel" (Luxembourg takes part): https://gouvernement.lu/de/actualites/toutes_actualites/communiques/2022/11-novembre/07-application-eau.html. No machine-readable feed from it was verified [UNVERIFIED].

---

## Recommendation for phase planning

**Phase 0 – before building (1–2 weeks, runs alongside other work):**
- Email AGE (`hydrometrie@eau.etat.lu`, and include the Service de la navigation for the Moselle). Ask for:
  - written confirmation that the per-station JSON, the percentile forecasts and the station-page metadata may be reused under **CC0** like "Niveau d'eau";
  - whether a stable, documented feed is planned;
  - fixes for the CSV 15-minute offset, `SN_Remich.json` and `Water-Levels-Localstation.csv`;
  - how to obtain the 2002+ validated water level and discharge archive, and under what licence.
- Until they answer, go live only with the CC0 CSV and the CC BY alerts, and link out to inondations.lu for forecasts.

**Phase 1 – MVP (Luxembourg adapter):**
- **Observations:** poll every 15 minutes, staggered (for example :07, :22, :37, :52).
  - Use the per-station JSON as primary once AGE confirms, otherwise the CSV. Use the CSV for Remich.
  - Detect and correct the CSV time offset automatically.
  - Station IDs come from `ts_path`; geometry from pygeoapi collection 655.
  - Ingest all 42 stations (cheap). Take Perl and Stadtbredimus from PEGELONLINE and link the Luxembourg copies as the same site.
- **Alerts:** poll the data.public.lu v2 resources endpoint every 5 minutes. Filter on `[AGE]`/`FLOOD`, drop `TEST`, map ALERT_LVL_1–4 to red/orange/yellow/information, draw the three zone polygons, and credit "LU-Alert".
- **Thresholds:** scrape the station pages weekly, alert on any change, and store with validity periods. Show the orange and red vigilance levels and the HQ2–HQ100 water levels. Treat 0 as "not defined".
- **Freshness monitoring:** alarm when Luxembourg data is more than 45 minutes old, and on schema drift in the JSON keys or CSV header.

**Phase 2 – forecasts** (once AGE confirms):
- Poll hourly at about :20 past the hour.
- Store every run, identified by (station, first step) plus a hash of the file contents.
- Keep p10–p90 as a band. Mark values at the Moselle floors (250/260/220 cm) as below the forecastable range. Show 24 h or 48 h per `forecastsLimit`.
- Credit AGE or LfU RLP per station.

**Phase 3 – history and enrichment:**
- Backfill from the AGE validated archive (2002–2022/24; water level and discharge) through a formal data request.
- Discharge for Luxembourg is only realistic through that archive, or through discharge ratings (water level to flow), if AGE will share them.
- Add the CC0 map layers: primary river network (749/23) and flood-hazard zones for HQ10/HQ100/extreme.

**Cross-country dependencies to hand to the other research tracks:**
- The German track should confirm PEGELONLINE licence and characteristic values for Perl, Stadtbredimus and Grevenmacher, and whether the RLP portal has a feed for Bollendorf and Gemünd.
- The Belgian and French tracks should cover the upstream Sûre (Martelange) and the Moselle above Perl (Apach/Uckange), and the Chiers for the Meuse link.

Working files (raw responses, station configs, logs) are in `(research-session scratch files, not kept)`. The most useful are `station_configs.json` (thresholds and metadata for all 42 stations), `js/` (station JSON files), `fc/` (forecast files), `Water-Levels-LocalTime.csv`, `lualert_all.json` and `fc_watch.log` (the cadence check).