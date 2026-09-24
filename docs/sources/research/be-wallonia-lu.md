# Wallonia (SPW) and Luxembourg: river-level data sources

**Runtime:** this research agent ran for about 18 minutes (20:12 to 20:30 UTC on 2026-09-23). Probes were run live on that date; response excerpts below are trimmed.

---

## 1. Summary

1. **All Walloon hydrometric data now comes from one portal, `hydrometrie.wallonie.be`.** It went live on 30 June 2022 and is run jointly by two SPW departments:
   - **DGH** (SPW Mobilité et Infrastructures): network "WACONDAH", covering navigable rivers, reservoirs, 5-minute data.
   - **DCENN** (SPW ARNE): network "AQUALIM", covering non-navigable rivers, 10-minute data.

   The legacy sites are gone:
   - `voies-hydrauliques.wallonie.be/...hydro...` returns 301 to an unrelated navigation page on infrastructures.wallonie.be.
   - `appli.voies-hydrauliques.wallonie.be` gives connection reset or 503.
   - `aqualim.environnement.wallonie.be` does not resolve (proxy CONNECT 502).
2. **There is a live, public KISTERS KiWIS endpoint:** `https://hydrometrie.wallonie.be/services/KiWIS/KiWIS`.
   - No authentication. Response headers include `X-spw-user: public`, `Access-Control-Allow-Origin: *` and `Cache-Control: max-age=300`.
   - KiWIS version 1.11.9, full standard QueryServices.
   - It is not documented for third parties, but it is the portal's own backend and it self-documents through `getrequestinfo`.
   - One call returns the latest value for all 320 public water-level series (88 KB, under 1 s).
3. **Licensing is the main risk for Wallonia.** The official terms on `hydrometrie.wallonie.be/mentions-legales.html` **forbid redistributing the data to the public, including through a website or web service, without SPW's prior written consent.** Metawal (the Walloon metadata catalogue) says the same for the measurement datasets: "ne peut pas… publier les données sur Internet via un service web". Only station locations (INSPIRE layers) are CC-BY 4.0. Several web pages claim the KiWIS data is "Open Data, CC BY 4.0". I traced that only to third-party sites and could not find it on any official SPW page, so it is UNVERIFIED.
4. **Coverage of the stations the brief asked for:**
   - Present: Dinant, Anseremme, Namur (Meuse, absolute level), Salzinnes-Ronet (Sambre discharge), Ampsin, Neuville, Liège, Visé (discharge only), Lixhe (the last Meuse weir before the NL border), Tabreux, Chaudfontaine, Martinrive, Gendron, Membre/Bouillon (Semois), Châtelet/Monceau (Charleroi), Chooz (Meuse in France, just upstream of the border), and the Escaut (Tournai, Kain, Pecq).
   - Not in the public KiWIS: Heer-Agimont, Hastière-on-Meuse, Andenne, Monsin and Pont des Arches. Note that station "HASTIERE" is on the Hermeton, not the Meuse.
5. **History is deep.** Full-resolution series go back to 1969 (Tabreux discharge), 1976–1977 (Tabreux, Chooz levels) and 1995 (Visé). The portal's own 5-minute series ("-Alarmes") start on 2019-01-01. All of it can be queried through KiWIS.
6. **Luxembourg:** the Administration de la gestion de l'eau (AGE) publishes a CC0 CSV on data.public.lu with 42 stations, 15-minute levels in cm, the last 5 days, local time, and about 10 minutes latency. Station points are available as CC0 GeoJSON / OGC API.
   - There are no discharge values in open data.
   - Adding Luxembourg later is simple for levels, but the CSV format is fragile.

---

## 2. SPW KiWIS: endpoint reference

**Base URL (GET or POST):**
```
https://hydrometrie.wallonie.be/services/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=0&format=json&request=<REQUEST>&...
```
- Other formats: `csv`, `html`, `geojson` (on list/layer requests), `xlsx`, `objson`/`tabjson`.
- Self-documentation: `request=getrequestinfo` returns `"Version": "1.11.9"` and the list of requests: getGroupList, getStationList, getTimeseriesList, getTimeseriesValues, getTimeseriesValueLayer, getQualityCodes, getRatingCurveList, getRasterTimeseriesValues and others.
- The frontend (KISTERS Web Components, `/services/kiwcp/`) uses `usergroups="web_s0_public"`. Responses carry `Vary: X-User-Group`, so anonymous callers only see what the public group allows.
- **No pagination.** Bound the volume with `period`, `from`/`to` and `ts_id` lists. The bulk download form on the site caps requests at 250,000 values per request ("un peu plus de 2 ans de données haute résolution… pour une station"). The frontend allows at most 365 days of high-resolution data per download.
- **Rate limits:** none documented and none observed. Responses are cached for 300 s at the edge (`X-Cache` from `sp5640v.wallonie.intra`). Polling more often than every 5 minutes is pointless.
- **CORS:** `Access-Control-Allow-Origin: *`. Given the licence, the backend should fetch the data server-side and not proxy it openly.
- **robots.txt:** none (404).

### 2.1 Discovery

**Groups:** `request=getGroupList` returns 162 groups. The relevant public web groups are:

| group_id | group_name | contents |
|---|---|---|
| **1962373** | `WEBPortal_ESurf-Hauteur` | 320 level series: DCENN 193 × `H`, DGH 107 × `H`, 12 × `H_sonde`, 4 × `Habs_sonde`, 2 × `Habs`, plus reservoirs GIL/EUP |
| **1962340** | `WEBPortal_ESurf-Debit` | 286 discharge series: `Q` (rating-curve discharge) and `QADM` (11 ultrasonic ADM stations on navigable reaches) |
| 1962392 / 1962354 | `…HauteurTendency` / `…DebitTendency` | trend values used by the map |
| 3617241 | `WEBPortal_ESurf-StationsActives` | station group |

**Timeseries in a group:**
```
GET …&request=getTimeseriesList&timeseriesgroup_id=1962373
   &returnfields=station_no,station_name,station_id,ts_id,ts_name,ts_shortname,ts_path,
                 stationparameter_no,ts_unitsymbol,station_latitude,station_longitude,site_no,coverage
```
- The call returned 92 KB in 2.9 s.
- Pitfall: any unknown returnfield (for example `river_name` here) gives HTTP 500 `{"code":"InvalidParameterValue","message":"Parameter 'returnfields' contains at least one invalid field."}`. The valid fields are listed in `getrequestinfo`.
```json
["L7550","Ecaussinnes","15720","188700010","05a-Hauteur.Complet.Alarmes","Cmd.Rel.Abs.Comp-Alarmes",
 "DCENN/L7550/H/Cmd.Rel.Abs.Comp-Alarmes","H","m","50.5604663951544","4.16774476638753","DCENN",
 "2019-01-01T00:00:00.000+01:00","2026-09-23T22:00:00.000+02:00"]
```

**Station metadata, including gauge datum:**
```
GET …&request=getStationList&station_no=5921,8001,5451,L8470
   &returnfields=station_no,station_name,station_carteasting,station_cartnorthing,station_georefsystem,
                 station_timezone,station_utcoffset,river_name,ca_sta
```
- The full list without filter has 501 stations: DGH 237, DCENN 193, "Bassins" 59, EUP 6, IDEA 4, GIL 1, VES 1. It took 0.7 s.
- `ca_sta` expands to about 50 custom attributes, including `station_gauge_datum`, `station_gauge_datum_unit`, `CATCHMENT_SIZE`, `BASSIN_INFOCRUE`, `NIVCRU`, `ADRESSE` and `ObjectDescription`.
- Excerpt for Tabreux: `"station_gauge_datum":"109.9","station_gauge_datum_unit":"DNG","station_timezone":"(UTC+01:00) Generic time zone","station_utcoffset":"-60","CATCHMENT_SIZE":"1607,00 km²"`.

### 2.2 Current values: recommended polling call

```
GET …&request=getTimeseriesValueLayer&timeseriesgroup_id=1962373&timezone=UTC
   &metadata=true&md_returnfields=station_no,station_name,ts_id,stationparameter_no,ts_unitsymbol
```
- Returns 320 objects, 87.9 KB, in 0.9 s. The discharge group (`1962340`) returns 286 objects, 50 KB, in 0.5 s.
```json
[{"ts_id":246052010,"timestamp":"2026-09-23T19:55:00.000Z","req_timestamp":null,"ts_value":1.276,
  "station_latitude":50.5164135163075,"station_longitude":5.23421331783582,
  "station_no":"7141","station_name":"HUY","stationparameter_no":"H","ts_unitsymbol":"m"}, …]
```
- `format=geojson` returns a FeatureCollection with WGS84 points, which is handy for the map.
- `date=2026-09-20T12:00:00Z` gives a snapshot at any past moment, so it can be used for backfill at chosen instants.
- `valuecolumn=absolute` returns levels in m DNG, for example Tabreux `110.096`, Dinant `91.058`. It returns `null` for series that are already absolute (`Habs_sonde`, as at Liège).

**Latency measured at 20:17 UTC over the 320 level series:**

| Lag since last value | Series |
|---|---|
| Under 30 min | 277 |
| 30–120 min | 32 |
| 2–24 h | 8 |
| Over 1 day | 3 (dead or maintenance: L5800 about 4.7 days, L7370 about 58 days, 5804 ANGLEUR GR BAT. Av since 2024-11-30) |

- DGH series are 5-minute, DCENN series 10-minute, and QADM series hourly.

### 2.3 Time series values

```
GET …&request=getTimeseriesValues&ts_id=240759010,250652010,245267010&period=PT20M&timezone=UTC
   &returnfields=Timestamp,Value,Absolute%20Value,Quality%20Code
```
```json
[{"ts_id":"240759010","rows":"2","columns":"Timestamp,Value,Absolute Value,Quality Code",
  "data":[["2026-09-23T20:00:00.000Z",0.188,110.088,200],["2026-09-23T20:05:00.000Z",0.188,110.088,200]]},
 {"ts_id":"250652010", … "data":[["2026-09-23T20:05:00.000Z",1.053,91.055,200]]},
 {"ts_id":"245267010", … "data":[["2026-09-23T20:05:00.000Z",59.981,null,200]]}]
```
- **Time window options:** `from`/`to` (ISO; a bare date `yyyy-MM-dd` covers the whole day), `period=PT3H|P1D|complete`, `futureperiod`, or no `from` at all, which returns only the last value.
- **Wildcard paths work:** `ts_path=DCENN/L6660/*/Cmd.*Comp-Alarmes` returns both H and Q for Sippenaeken (Gueule/Geul at the NL border) at 10-minute steps.
- **Time zone:** by default timestamps come back in local time with offset, for example `2026-09-23T22:05:00.000+02:00`. **Always pass `timezone=UTC`**, which gives `…Z`. Aggregated daily values are stamped at `T01:00+02:00` / `T23:00Z` (station time zone is fixed UTC+1). Treat interval stamping as ambiguous and verify it before using daily or hourly means.
- **Whole group over a window:** `timeseriesgroup_id=1962373&period=PT1H` works (2,135 rows) but took 9.9 s. Use the value layer for "now" and per-series calls for gaps.

**Quality codes** (`request=getQualityCodes`):
- 0 Excellent, 40 Good, 80 Fair, 120 Suspect, 160 Poor, 161–165 manual or limnimetry, **200 Unknown (raw, unvalidated)**, 205 "Douteux (publié)", 210 "Douteux (non publié)", 253 "Valeurs fantômes".
- The legal notice says validated data has a code below 200. Live values are 200.

**Historical depth (verified):**
- Visé daily-mean discharge, July 2021: `["2021-07-14T23:00:00.000Z",2428.024],["2021-07-15T23:00:00.000Z",2742.985]`.
- Tabreux hourly discharge in 1980: `["1980-01-01T00:00:00.000Z",46.089,40]`.
- Tabreux 5-minute level on 2021-07-15: `3.953 m / 113.853 m DNG`.

| Series type (`ts_shortname`) | Meaning | Typical start |
|---|---|---|
| `Cmd.Rel.Abs.Comp` / `Cmd.RunOff.Comp` / `Cmd.Abs.Comp` | full-resolution level / discharge / absolute level | 1969–2007, depending on station |
| `…Comp-Alarmes` | public web series (in the public groups) | 2019-01-01 |
| `h.Mean`, `Day.Mean`, `Month.Mean`, plus LTV/percentile statistics | aggregates | same as the full-resolution series |

### 2.4 Quantities, units and datum

- **`H`:** stage in **m relative to the local gauge zero**. `station_gauge_datum` (in `ca_sta`) gives the zero in **m DNG**, the Belgian "Deuxième Nivellement Général" datum based on Ostend low water, which is about 2.3 m below NAP.
  - Get absolute values through `returnfields=…,Absolute Value`.
  - Pitfall: DCENN stations can have datum `9999.0` (unknown), as seen at L8470.
- **`Habs`, `Habs_sonde`:** absolute level in m DNG. Namur reads 78.5, Liège 59.98.
- **`H_sonde`:** level from a pressure probe, relative.
- **`Q`:** discharge in m³/s from a rating curve.
- **`QADM`:** discharge in m³/s measured by ultrasonic crossed paths on regulated reaches. It is hourly, and the "to" timestamp in its coverage is always one step in the future, carrying `null` with quality `-1`.
- **`QEtimeuse`** at Liège 5491: half-hourly model or estimate. It is not in the public group.
- **Navigable Meuse and Sambre stages are controlled by weirs.** Stage says little about flow there, so use QADM or Q for "follow the flood wave". Bief Amont/Aval pairs sit upstream and downstream of locks.

### 2.5 Key station codes (verified in KiWIS)

Station numbers are `station_no` and the prefix is `site_no`. The ts_ids are the public 5-minute or 10-minute "-Alarmes" series unless noted.

**Meuse main stem, France to Netherlands:**

| Location | site/station_no | Level ts_id | Discharge ts_id | Notes |
|---|---|---|---|---|
| Chooz (FR, upstream of Givet / Heer-Agimont) | DGH 8702 | 253255010 (H) | 301649010 (Q) | full-resolution since 1977 (H) / 1983 (Q) |
| Waulsort | DGH 8078 | none | 251086010 (QADM, hourly) | QADM since 1983 |
| Anseremme Monia | DGH 8067 | 250781010 | none | |
| Dinant | DGH 8059 | 250652010 | none | not DCENN L8470 "Dinant", which is the Ruisseau des Fonds de Leffe |
| Tailfer | DGH 8016 | none | 367460010 (QADM) | returned null for 5 days, so treat as unreliable |
| Namur | DGH 8001 | 354633010 (Habs_sonde, m DNG) | none | |
| Grands-Malades Bief Amont | DGH 7197 | 246276010 | none | |
| Huy | DGH 7141 | 246052010 | none | |
| Ampsin Bief Amont / Neuville Bief Aval | DGH 7137 / 7133 | 245773010 / 245678010 | none | |
| Amay | DGH 7132 | none | 245521010 (QADM) | |
| Ivoz-Ramet Bief Amont | DGH 7117 | 245399010 | none | |
| Liège | DGH 7102 | 245267010 (Habs_sonde) | 382389010 (QEtimeuse, DGH 5491, not public-group) | at 50.6126 N, 5.5772 E; not Monsin or Pont des Arches |
| Haccourt (Albert Canal) | DGH 5771 | none | 239603010 (QADM) | canal withdrawal |
| Visé | DGH 5451 | none | 239015010 (QADM, hourly) | full-resolution since 1995 |
| Lixhe Bief Amont / Lixhe Aval (last weir before NL) | DGH 5447 / 5436 | 238955010 / 238765010 | Lixhe Aval Q 297557010 | |

- **Not found anywhere** in the 501-station list: Heer-Agimont, Hastière on the Meuse, Andenne (LANDENNE 7168 is a rain gauge), Monsin, Pont des Arches, Charleroi by name.

**Sambre:**

| Location | site/station_no | Level ts_id | Discharge ts_id |
|---|---|---|---|
| Solre | DGH 7487 | none | QADM 248506010 |
| Landelies US | DGH 7408 | none | QADM 387498010 |
| Monceau Aval Barrage-Écluse (Charleroi) | DGH 7394 | H 247998010 | none |
| Châtelet | DGH 7371 | none | QADM 247526010 |
| Salzinnes-Ronet (Namur) | DGH 7319 | none | QADM 247033010 (full-resolution 247062010, since 2006) |

**Tributaries:**

| River | Location | site/station_no | Level ts_id | Discharge ts_id |
|---|---|---|---|---|
| Ourthe | Tabreux | DGH 5921 | 240759010 | 297989010 |
| Ourthe (mouth) | Angleur 2 BIS | DGH 5808 | none | 346891010 |
| Vesdre | Chaudfontaine Piscine | DGH 6228 | 242295010 | 298637010 |
| Vesdre | Chaudfontaine Pont | DGH 6229 | 370054010 (H_sonde) | 370213010 |
| Amblève | Martinrive | DGH 6621 | 243172010 | 298925010 |
| Lesse | Gendron | DGH 8221 | 251929010 | 301217010 |
| Semois | Membre Pont | DGH 9434 | 254647010 | 302441010 |
| Semois | Bouillon | DGH 9461 | 254963010 | 302585010 |

**Border rivers flowing directly to the NL or to the Rhine:**

| River | Location | Code |
|---|---|---|
| Gueule/Geul | Kelmis | DGH 5291: H 238670010, Q 297485010 |
| Gueule/Geul | Sippenaeken (at the NL border) | DCENN L6660 |
| Geer/Jeker | Eben-Emael | DCENN L6340 |
| Geer/Jeker | Bergilers | DGH 5572 |
| Berwinne | Dalhem | DCENN L6390 |
| Our (to Sauer, Moselle, Rhine) | Schoenberg | DGH 9926 |
| Our | Reuland | DGH 9914 |
| Our | Ouren | DCENN L6330 |
| Sûre | Martelange | DCENN L5610 |

**Scheldt basin (Hainaut):**

| River | Location | Code |
|---|---|---|
| Escaut | Tournai | DGH 3282: QADM 236825010 |
| Escaut | Kain Amont / Aval Barrage-Écluse | DGH 3276 / 3274: H 236731010 / 236636010 |
| Escaut | Pecq | DGH 3270: Habs_sonde 398877010 |
| Haine | Boussoit | DGH 3561: H 237384010, Q 297197010 |
| Haine | Obourg | DCENN L7570 |
| Dendre | Ath | DGH 2971 |
| Dendre | Lessines US | DGH 2708: QADM |
| Lys | Comines | DGH 3886 / 3884 |
| Dyle | Bierges | DGH 1046 |
| Senne | Tubize | DGH 1951 |

### 2.6 Other SPW sources checked

- **Geoportail / Metawal (INSPIRE):** "Stations de mesure de la hauteur d'eau des cours d'eau non-navigables" (uuid a06b1f40-…) is **CC-BY 4.0** and served as OGC API Features at `https://geoservices.wallonie.be/geoserver/inspire_ef/ogc/features/v1/…`.
  - The collection `EF.EnvironmentalMonitoringFacilities_surfacewaterbody_gauging_wfd` holds only 33 WFD gauging sites (sample id `BERW_L5170`, BAISIEUX).
  - It is less complete than KiWIS `getStationList`, but it is the only station geometry with a clear open licence.
- **ODWB open data portal** (`odwb.be`): no hydrometric datasets.
- **Static files used by the frontend:** `/services/kiwcp/configs/config.json` (1.4 MB of UI config), `/services/kiwcp/data/hDayOffsetPub.json` (327 KB, hourly offsets, regenerated about every 10 minutes), and `catchments.json` (TopoJSON). These are frontend internals and should not be used.

### 2.7 Licence and attribution

**Official legal notice** (`https://hydrometrie.wallonie.be/mentions-legales.html`, verified live):
> "La reproduction des données figurant sur le site… est autorisée sans accord préalable. L'utilisateur indique la mention « Sources des données : Service public de Wallonie » ou « Sources des données : SPW »… Dans la mesure du possible, la mention comporte un hyperlien vers hydrometrie.wallonie.be. **Le SPW est seul habilité à distribuer les données. Sauf accord préalable et écrit du SPW, il est interdit à l'utilisateur de fournir les données à un tiers sous quelque forme que ce soit - fichiers, site web, webservice, etc - ou de diffuser celles-ci au public.** La reproduction et la diffusion commerciale ou publicitaire… sont interdites sans autorisation préalable."

The notice also says: "Les données brutes ne sont pas validées… peuvent être entachées d'erreurs importantes."

**Metawal measurement-data records** (49373603-… and 9e8f77db-…), under the CGU SPW:
> "L'Utilisateur ne peut pas redistribuer les données à un tiers ni publier les données sur Internet via un service web. L'utilisateur peut publier les données sur support statique (… pdf ou image sur Internet…)."

**Conclusion:**
- Showing SPW values on a public dynamic website needs **written permission from `hydrometrie@spw.wallonie.be`**.
- If it is granted, use the attribution "Sources des données : Service public de Wallonie (SPW)", linked to https://hydrometrie.wallonie.be.
- The "CC BY 4.0 via KiWIS" statements found through search come from third parties (for example kayaksemois-ardenne.be, which I could not load: 503 and connection reset). **They are UNVERIFIED and contradicted by the official terms.**

---

## 3. Luxembourg (AGE, inondations.public.lu)

- `inondations.lu` redirects (302) to `https://inondations.public.lu/`. The site lists stations for the Alzette, Sûre/Our, Moselle and Chiers basins.
- **Open data:** data.public.lu dataset "Niveau d'eau" (`https://data.public.lu/fr/datasets/niveau-deau/`), publisher Administration de la gestion de l'eau, **licence `cc-zero`**, marked "daily".

**Levels CSV (verified):** `GET https://inondations.public.lu/dam-assets/ctie/datas/Water-Levels-LocalTime.csv`
- 154 KB, `text/csv`, `cache-control: public, max-age=14400`, `last-modified` about 1 minute before the request.
- It is a wide format: one row per station and one column per 15-minute timestamp, covering 480 timestamps (5 days).
```
"Name","Number","Unit","18.09.2026 22:30","18.09.2026 22:45",…
SN_Remich,,cm,… last "23.09.2026 22:15" = 347.0
Esch-Sure,,m,… 314.35        (reservoir, absolute m, unlike the others)
```
- 42 stations, including the Moselle (SN_Remich, SN_Stadtbredimus, SN_Grevenmacher, SN_Wasserbillig, Perl), the Sûre (Bollendorf, Rosport, Diekirch, Michelau, Bigonville, Heiderscheidergrund), the Our (Vianden, Gemünd, Dasbourg) and the Alzette.
- **Pitfalls:**
  - Timestamps are **local Luxembourg time without an offset** (`dd.mm.yyyy HH:MM`). Since 09/2026 the data is local time with DST; before that it was UTC+1. The DST fall-back hour is ambiguous.
  - The `Number` column is empty, so stations must be matched by name.
  - There is a trailing empty column.
  - Units are mixed (cm and m).
  - The companion `Water-Levels-Localstation.csv` listed on data.public.lu returns **404**.
- **Station geometry:** `https://features.geoportail.lu/collections/655/items?f=json` (pygeoapi, 51 features, WGS84, CC0) returns only name, status and PDF links. The gauge zero (for example "137,17 m NN" at Remich) appears only in the web page config and the station PDFs.
- **Per-station JSON** used by the website: `/content/dam/inondations/ctie/datas/SN_Remich.json`, `Bollendorf.json`. These are KiWIS-format dumps, 7 days at 15 minutes, in cm, e.g. `"ts_path":"0/00229150/W1/15m.Cmd.RelAbs.P"`, with timestamps `…+02:00`.
  - They are covered by the site's CGU ("Sauf indication contraire… ne peuvent être diffusés en dehors du site"), so rely on the CC0 CSV instead.
  - Some stations belong to other operators, for example Bollendorf is run by the LfU Rheinland-Pfalz. This is a possible rights question for those rows, UNVERIFIED.
- **Discharge:** no open dataset found.
- **Effort to add later:** low, about a day for a parser plus name-to-coordinate mapping.
- **Overlap with other sources:** the Moselle at Perl and Trier and the Sauer at Bollendorf are probably also on the German services (PEGELONLINE / LfU RLP), covered in the Germany report. That may be cleaner for the Moselle; Luxembourg adds the Alzette, Sûre and Our upstream.

---

## 4. Pitfalls observed

1. The same place name refers to different rivers:
   - "HASTIERE" (8622) is on the Hermeton.
   - DCENN "Dinant" (L8470) is on the Fonds de Leffe brook.
   - DGH and DCENN both have "Stavelot", "Malmedy" and "Daverdisse" with different codes, and sometimes different rivers.
   - **Always key on `site_no/station_no`.**
2. Navigable-reach stages are weir-controlled. Visé and Tailfer have no public stage at all, only QADM. Visé read 13.9 m³/s at low flow, after the Albert Canal withdrawal at Monsin.
3. QADM coverage always ends one hour in the future with a `null` / quality `-1` placeholder. The value layer can return `ts_value: null` for stale series (Tailfer's last timestamp was 2026-09-18). Filter out nulls.
4. Default timestamps are local with offset; daily aggregates are stamped in fixed UTC+1. Use `timezone=UTC`.
5. `valuecolumn=absolute` or `Absolute Value` is null for already-absolute series and meaningless where the datum is `9999.0`.
6. An invalid `returnfields` value gives HTTP 500, not a partial result.
7. Live data is raw (quality 200) and gets revised after validation. Store `Quality Code`, and consider re-fetching the last N days.

---

## 5. Recommendation for phase planning

**Pre-MVP (blocking), sent now:**
- Email `hydrometrie@spw.wallonie.be` for **written permission** to show SPW data on a public, non-commercial website. Cite the legal notice clause. Ask:
  - whether the KiWIS endpoint may be polled server-side, and at what frequency;
  - which attribution wording they want;
  - whether historical backfill is allowed.
- In parallel, ask whether a CC-BY / High-Value-Dataset release is planned. This is UNVERIFIED whether it applies.
- Without permission, the MVP should show the Meuse entry into NL from Dutch (RWS: Eijsden / Sint Pieter), French (Vigicrues) and Flemish sources, and only *link* to hydrometrie.wallonie.be for Wallonia.

**MVP, if permission is granted:**
- Poll `getTimeseriesValueLayer` for groups **1962373** (levels) and **1962340** (discharge) every 10 minutes: 2 requests of about 140 KB total, under 2 s.
- Store `ts_id`, UTC timestamp, value and quality.
- Restrict the map to a curated list of about 25–40 stations: the Meuse chain Chooz → Waulsort/Anseremme → Dinant → Namur → Grands-Malades → Huy → Ampsin → Amay (Q) → Ivoz-Ramet → Liège → Visé (Q) → Lixhe, plus the Sambre QADM stations, Tabreux, Chaudfontaine, Martinrive, Gendron, Membre, Kelmis/Sippenaeken, and the Escaut at Tournai/Kain/Pecq.
- Use discharge (Q/QADM) as the "flow" signal on regulated reaches.
- Load station metadata (coordinates, gauge datum in m DNG, river) once from `getStationList` with `ca_sta`, or take geometry from the CC-BY INSPIRE layer.

**Later phases:**
- **Backfill** from the full-resolution / `h.Mean` series through `getTimeseriesValues`, one station at a time in windows of at most 1 year. Hourly data goes back to 1969–1997.
- **Wider coverage:** all 500+ stations, flood thresholds (`NIVCRU`, catchment alert classes), and forecasts (the portal mentions them; not found in the public KiWIS, UNVERIFIED).
- **Luxembourg:** add the CC0 CSV (Moselle, Sûre, Our, Alzette), mapped by name to the pygeoapi points.

**Risks:**
- The licence is restrictive: the high risk is being refused or given conditions.
- The endpoint is undocumented, so paths, groups or ts_ids can change without notice. Mitigate by resolving ts_ids by `ts_path` or group at startup.
- Raw data can contain errors.
- Several key Meuse points are missing from the public set (Heer-Agimont, Andenne, Monsin).
- Weir-controlled stages confuse a naive "water level" colour scale.
- Luxembourg's CSV uses local time without offset and has a history of format and link changes (the 09/2026 note, the 404 companion file).

**Sources:**
- [hydrometrie.wallonie.be – Mentions légales](https://hydrometrie.wallonie.be/mentions-legales.html)
- [Téléchargements des données](https://hydrometrie.wallonie.be/home/services/telechargements-des-donnees.html)
- [Réseaux de mesure](https://hydrometrie.wallonie.be/home/en-savoir-plus/reseaux-de-mesure.html)
- [Géoportail – INSPIRE stations hauteur d'eau (CC-BY 4.0)](https://geoportail.wallonie.be/catalogue/a06b1f40-f85f-469e-a1af-ede1b578553d.html)
- [Géoportail – Données de hauteur d'eau et de débits (CGU SPW)](https://geoportail.wallonie.be/catalogue/49373603-418d-451b-afb5-7badc8783a43.html)
- [SPW MI news: new portal, 2022](https://infrastructures.wallonie.be/news/lhydrometrie-en-wallonie--le-nouveau-portail)
- [data.public.lu – Niveau d'eau (CC0)](https://data.public.lu/fr/datasets/niveau-deau/)
- [inondations.public.lu – Aspects légaux](https://inondations.public.lu/fr/support/aspects-legaux.html)
- Third-party CC-BY claim, not verified: [kayaksemois-ardenne.be](https://www.kayaksemois-ardenne.be/nl/waterpeil-meuse)