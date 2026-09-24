# Belgium, Flanders: waterinfo.be (VMM, HIC / Waterbouwkundig Laboratorium, De Vlaamse Waterweg)

Research date: 2026-09-23, around 20:12–20:26 UTC. I checked every endpoint below with curl unless it is marked **UNVERIFIED**. Excerpts are trimmed real responses.

---

## 0. TL;DR

- Flanders publishes its data through **two separate KISTERS KiWIS servers**. Both work anonymously, send `Access-Control-Allow-Origin: *`, and return JSON, CSV or GeoJSON:
  1. **VMM** (Vlaamse Milieumaatschappij, the environment agency; non-navigable rivers such as the upper Dijle, Demer, Nete, Mark, Voer, Jeker and Gete): `https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=1&...`
  2. **HIC** (Hydrologisch InformatieCentrum, part of Waterbouwkundig Laboratorium; navigable waterways, including the **tidal Zeeschelde**, the Leie, Bovenschelde, Dender, lower Demer/Dijle/Nete and the **Grensmaas**): `https://hicws.vlaanderen.be/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=4&...`. The legacy URL `https://www.waterinfo.be/tsmhic/KiWIS/KiWIS` still works via a 302 redirect.
- **Water level (H, and W for tidal stations) is in m TAW** (TAW is the Belgian vertical datum). **Discharge (Q) is in m³/s.** Timestamps default to Belgian local time with an explicit offset (`2026-09-23T22:00:00.000+02:00`). Adding `timezone=UTC` returns `...Z`, and `dateformat=UNIX` returns epoch milliseconds.
- **Latency is roughly 5–15 minutes.**
  - HIC tidal stations report every 10 min.
  - HIC non-tidal stations report every 1–15 min.
  - VMM stations report every 15 min.
- **History is deep:**
  - VMM 15-minute data back to the 1970s (for example Sint-Joris-Weert on the Dijle since 1973).
  - HIC tidal 10-minute data since 1996.
  - Antwerpen high/low water peaks since **1888**.
  - Daily Meuse discharge at Liège since 1911.
- A single call returns at most **250,000 values**; beyond that the server answers `TooManyResults`.
- **Both providers require a token for automated or scheduled use**, which a public website is:
  - VMM: request credentials from hydrometrie@waterinfo.be.
  - HIC: this project counts as a "TYPE 3" customer, which requires credentials plus a **User Agreement**; contact hic@vlaanderen.be.
- **Licensing is split:**
  - VMM data is under the **Modellicentie Gratis Hergebruik v1.0**, which allows commercial reuse with attribution.
  - HIC data has its own disclaimer. The English version says "intended for information and **non-commercial** purposes" and grants download "for personal use"; HIC keeps all IP rights. **Get written clearance from HIC before go-live.**

---

## 1. Architecture: who measures what

| Backend | Operator | Network | ts_id suffix | Station_no style |
|---|---|---|---|---|
| VMM KiWIS (`download.waterinfo.be`, datasource=1) | VMM, afdeling Operationeel Waterbeheer (AOW) | Non-navigable watercourses, pumping stations, flood-retention basins, partner stations | `...042` (e.g. `3880042`) | `L08_098` (river gauge, "limnigraaf"), `K09_032` (structure, "kunstwerk"), `S..` (partner), `HIS_...` (historic/closed) |
| HIC KiWIS (`hicws.vlaanderen.be`, datasource=4) | Waterbouwkundig Laboratorium – HIC (MOW); data also from De Vlaamse Waterweg | Navigable waterways, the tidal Scheldt and its tidal tributaries, Grensmaas, canals | `...010` (e.g. `53989010`) | `zes21a-1066` (zes = Zeeschelde, followed by a location code that increases upstream), `lei12e-1066`, `maa02a-1066`, `HIS_...` = closed |

The station_no suffixes `-1066`, `-1115`, `-1073` and `-1060` probably mean HIC's own gauges, lock gauges, De Vlaamse Waterweg (DVW) and external/RWS respectively. That reading is inferred from the station names and was not checked against documentation.

The waterinfo FAQ page confirms the split: "MOW-HIC: bevaarbare waterwegen … VMM: onbevaarbare waterlopen". Each provider has its own token.

---

## 2. VMM KiWIS (download.waterinfo.be)

### 2.1 Base URL and the datasource pitfall

```
https://download.waterinfo.be/tsmdownload/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=1&request=<...>
```

- **Use `datasource=1`.** It returns the classic unprefixed IDs (`ts_id 3880042`, `station_no L08_098`, group `192780`).
- With `datasource=0`, every ID gets a `01` prefix (`ts_id 0128764042`, `station_no 01K07_211`, group `01192780`). Passing `timeseriesgroup_id=192780` with `datasource=0` fails with `"Could not find a datasource of splitted request id 192780"`.
- `datasource` values 2, 3 and 4 return `"Datasource parameter not found in config."`.
- `getrequestinfo` reports `KISTERS QueryServices … Version 1.11.4`. Every command accepts GET, and POST as well with `?kvp=true`.
- Response headers: `access-control-allow-origin: *`, `cache-control: public,max-age=0,no-cache`, plus a `tsmtest=` load-balancer cookie. No rate-limit headers.

### 2.2 Available requests (verified via `request=getrequestinfo&format=json`)

- `getGroupList`
- `getSiteList`
- `getStationList`, with `bbox`, `station_name` wildcards and `object_type`
- `getParameterList`
- `getTimeseriesList`
- `getTimeseriesValues`
  - formats: ascii, html, csv, dajson ("json"), esrijson, wml2, xlsx
  - parameters: `ts_id` (comma list), `ts_path` (wildcards OK), `timeseriesgroup_id`, `from`, `to`, `period`
- `getTimeseriesValueLayer`, which is the one to use for the map
  - formats: json, csv, **geojson**, esrijson, …
  - parameters: `timeseriesgroup_id`, `ts_id`, `bbox`, **`date`**, **`valuecolumn=default|absolute|runoff`**, `invalidPeriod`/`invalidValue`
- `getGraph` (png/jpg)

Useful optional parameters:
- `returnfields`
- `metadata=true` combined with `md_returnfields`
- `timezone` (Java TZ string, e.g. `UTC`)
- `dateformat` (e.g. `UNIX`)
- `csvdiv`
- `downloadaszip`

### 2.3 Public time-series groups (VMM manual "Open Data waterinfo.be", v02/2022; IDs re-verified live)

| Group | timeseriesgroup_id | Live check |
|---|---|---|
| Waterstand_15m (H) | **192780** | 1,085 series in the value layer (mix of river gauges, structures and partner stations; 868 had a value in the current hour) |
| Waterstand_uur / dag / maand / jaar | 192785 / 192782 / 192783 / 192784 | listed in getGroupList |
| Afvoer_15m (Q) | **192786** | 136 series, all `m³/s`, ts_path `.../15m.Cmd.Pv.RunOff`; 102 active today |
| Afvoer_uur / dag / maand / jaar | 192892 / 192893 / 192894 / 192895 | listed |
| Watersnelheid (flow velocity) 15m | 192901 | listed |

Other groups exist, for example `WEBLayer_Stage_15m.Cmd` 118730 and `WEBLayer_Tidal` 172085. Several HIC-named groups (`179621`, `372911`, `372912`, `172085`) return `["No matches."]` on VMM. **HIC data is not served by the VMM server.**

### 2.4 Parameter types (getParameterList, verified)

| parametertype_name | parametertype_id (VMM) | Unit |
|---|---|---|
| H, "River Stage" | 559 | meter |
| Q, "River Discharge" | 557 | cubic meter per second |
| v, "Flow Velocity" | 561 | m/s |
| H_voorspeld / Q_voorspeld (forecast) | 93277 / 93283 | m / m³/s |

### 2.5 ts_name and ts_path conventions

Seen for station L08_098 Sint-Joris-Weert/Dijle; the meanings are inferred from the names:
- `Pv.15`, path `AOW_LIMNIGRAFEN/L08_098/H/15m.Cmd.Pv.RelAbs`: the 15-minute "processed" series the portal shows. It is the member of groups 192780/192786.
- `P.15` (`15m.Cmd.P.RelAbs`), `O.15` (original/raw), `P.60` (hourly), `DagGem` / `DagMax` / `DagMin` (daily).
- Year and period statistics: `KalJaarP90`, `MeetPeriodeMax`, …
- Threshold series: `DrempelAlarm`, `DrempelWaak`, `DrempelPrewaak`.
- At structures ("kunstwerken"): `Hopw01` / `Hafw01` = water level upstream / downstream of the structure, e.g. `AOW_KUNSTWERK/K09_032/Hopw01/15m.Cmd.Abs`.
- **`ts_path` addressing works** and is more stable than ts_id:
  `&request=getTimeseriesValues&ts_path=AOW_LIMNIGRAFEN/L08_098/H/15m.Cmd.Pv.RelAbs&period=PT30M` returned `ts_id 3880042`.

### 2.6 Vertical datum: pitfall with `Value` vs `Absolute Value`

On `...RelAbs` series, `Value` can be **relative to the local gauge zero**, while `Absolute Value` is **m TAW**. The two are not consistent across stations: Geel's default `Value` was already absolute, while Sint-Joris-Weert and Hasselt were relative. **Always request `Absolute Value`, or `valuecolumn=absolute` in the layer.**

```
GET ...datasource=1&request=getTimeseriesValues&ts_id=3880042&period=PT1H&format=json&metadata=true
    &returnfields=Timestamp,Value,Absolute%20Value,Quality%20Code
    &md_returnfields=ts_id,ts_name,ts_path,station_no,station_name,parametertype_name,ts_unitsymbol,ts_unitsymbol_abs,timezone,ts_spacing
→ [{"ts_id":"3880042","ts_name":"Pv.15","ts_path":"AOW_LIMNIGRAFEN/L08_098/H/15m.Cmd.Pv.RelAbs",
    "station_no":"L08_098","station_name":"Sint-Joris-Weert/Dijle","parametertype_name":"H",
    "ts_unitsymbol":"m","ts_unitsymbol_abs":"m","timezone":"Europe/Berlin","ts_spacing":"PT15M","rows":"2",
    "columns":"Timestamp,Value,Absolute Value,Quality Code",
    "data":[["2026-09-23T21:30:00.000+02:00",0.174,27.396,110],["2026-09-23T21:45:00.000+02:00",0.174,27.396,110]]}]
```

Hasselt/Demer shows the same pattern: Value −0.258, Absolute 30.212.

### 2.7 Latest values for a whole group (the map call)

```
GET ...datasource=1&request=getTimeseriesValueLayer&timeseriesgroup_id=192780&format=json&valuecolumn=absolute
    &metadata=true&md_returnfields=ts_id,station_no,station_name,ts_path&timezone=UTC
→ 200, 330 KB, 1.3 s
[{"ts_id":4342042,"timestamp":"2026-09-23T20:00:00.000Z","req_timestamp":null,"ts_value":30.212,
  "station_latitude":50.9315276462155,"station_longitude":5.37611387147317,"station_no":"L09_136",
  "station_name":"Hasselt/Demer","ts_path":"AOW_LIMNIGRAFEN/L09_136/H/15m.Cmd.Pv.RelAbs"}, ...]
```

- **`format=geojson` works.** It returns a FeatureCollection with Point geometry in [lon, lat] (tested on 192786, 0.9 s).
- **Time travel:** `&date=2026-09-20T12:00:00Z` returns the value at or before that instant, with `req_timestamp` set. It took 12 s. **Pitfall:** dead series return their last value from years ago (e.g. `2020-03-04`), so compare `timestamp` against `req_timestamp`.
- **Staleness filter:** `invalidPeriod=PT2H&invalidValue=-9999` replaced 34 stale Q entries, but with **`-10000`**, not the requested −9999. Treat −10000 as a sentinel.
- **Note:** `ts_id` is a JSON *number* in the layer and a *string* in getTimeseriesValues.

### 2.8 Multiple series and gap filling

- A comma-separated `ts_id` list works: 100 IDs, `period=PT1H`, 2.0 s, 22 KB.
- `timeseriesgroup_id=192786&period=PT1H` in getTimeseriesValues works (2.3 s).
- **The same call with group 192780 (H, 1,085 series) failed** with HTTP 500 `{"code":"DatasourceError","message":"Error getting tsinfolist from cache."}`. Use batches of ts_ids instead.
- The VMM manual warns that getTimeseriesValues calls "worden niet standaard in de cache voorbereid en kunnen … meer 'credits' verbruiken" (they are not pre-cached and can cost more credits).

### 2.9 Timestamps and time zone

- Default output is local time with an offset, `yyyy-MM-dd'T'HH:mm:ss.SSSXXX`, metadata timezone `Europe/Berlin` (the same rules as Brussels).
- `timezone=UTC` gives `Z`; `dateformat=UNIX` gives epoch milliseconds (tested on HIC, which runs the same software).
- Input formats: ISO with offset, `yyyy-MM-dd`, `yyyy`, UNIX milliseconds, and ISO-8601 periods (`PT6H`, `P3D`).
- **UNVERIFIED:** how offset-less `from`/`to` inputs are interpreted (pywaterinfo notes say CET). Always send an explicit `Z`.

### 2.10 Freshness, history and limits

- **Freshness:** at 20:12 UTC the value layer held 868 series at 20:00Z; single series lagged about 7–35 minutes.
- **History:** anonymous access returned Sint-Joris-Weert data for 1995 (`["1995-01-26T00:00:00.000Z",1.120,28.342,220]`). Coverage starts in 1973.
  - A 400-day 15-minute pull (about 38k values, 1.5 MB) succeeded anonymously.
  - `period=P10Y` failed: `{"code":"TooManyResults","message":"Maximum number of timeseries values surpassed. Please narrow your request. Limit is: 250000"}`.
- **Quality codes seen:** 110 and 130 on recent data, 220 on 1995 data. The VMM code table is **UNVERIFIED** (the DOV wiki returned 503). It most likely follows the same WISKI ranges as the HIC table in §3.6.

### 2.11 Authentication and fair use (VMM)

- **Anonymous use:** allowed, with an "restrictie op aantal gegevens en aantal requests" (limit on data volume and number of requests). The exact figures are not published (**UNVERIFIED**).
- **Automated use:** "VMM vraagt … steeds gebruik te maken van de token access bij geautomatiseerde databevraging" (VMM asks that automated querying always uses token access). Contact hydrometrie@waterinfo.be and state what data you need and how often.
- **Token endpoint** (from wateRinfo docs): `POST https://download.waterinfo.be/kiwis-auth/token` with `grant_type=client_credentials` and HTTP Basic client credentials. Tokens last 24 h and usage is metered in credits.
  - Live: without credentials it answers `{"type":"error","status":400,"errorCode":40007,"message":"Invalid auth data."}`, so the endpoint exists.
  - With credentials: **UNVERIFIED** (no credentials available).
- **Stability disclaimer:** VMM takes no responsibility for changes to identifiers or group contents ("De inhoud en de aantallen van deze groepen kunnen in de loop van de tijd wijzigen").
- **Throttling:** about 40 anonymous VMM calls in 15 minutes were never throttled.

---

## 3. HIC KiWIS (hicws.vlaanderen.be): the tidal Scheldt and navigable rivers

**Yes, there is a documented API:** the "Manual on the use of HIC webservices", version 24/07/2026, at https://hicws.vlaanderen.be/Manual_for_the_use_of_webservices_HIC.pdf (26 pages, downloaded and read).

### 3.1 Base URL

```
https://hicws.vlaanderen.be/KiWIS/KiWIS?service=kisters&type=queryServices&datasource=4&request=<...>
```

- Headers: `access-control-allow-origin: *` and `cache-control` of `max-age=30` (value layer), `max-age=60` (values) or `max-age=300` (lists).
- The legacy `https://www.waterinfo.be/tsmhic/KiWIS/KiWIS?...datasource=4` redirects (302) to `waterinfo.vlaanderen.be/tsmhic/...` and works.

### 3.2 Public groups (manual Table 2; the key ones verified live)

| Group | ID | Type | Live |
|---|---|---|---|
| Waterstand_hoge resolutie (water level, native resolution; H plus tidal W) | **156163** | Cmd | 225 series: 191 H (`Pv`, `H/Cmd.Abs.Pv`) and 34 W (`Pv.10`, `W/10m.Cmd.Abs.Pv`); 206 active |
| Waterstand_uur / dag | 156164 / 156162 | Cmd | per manual |
| Afvoer_hoge resolutie (discharge) | **156170** | Cmd | about 50 Q series, `Q/Cmd.RunOff.Pv`, m³/s |
| Afvoer_uur / dag | 156171 / 156169 | Cmd | per manual |
| High and low waters, Scheldt tidal area | **156165** | Cmd | 35 series `Pv.HWLW`; supports `returnfields=...,Tide%20Number` |
| High waters only / low waters only | 510205 / 510207 | Cmd | per manual |
| Calculated discharges at key waterway locations | 260592 | Cmd | 11 daily series (see §4) |
| Astronomic tide predictions, Scheldt and coast, mTAW (10-min / HW-LW) | 354718 / 350099 | Cmd | Antwerpen `Astro.10` ts 112650010, runs to **2028-01-03** |
| Same predictions in LAT (lowest astronomical tide) | 512458 / 515316 | Cmd | per manual |
| Water-level forecast 48 h / 10 days | **506056** / 506058 | Ensemble | Antwerpen `W_voorspeld` ts 89202010; latest forecast run 18:00Z, horizon to +60 h, 5-min steps, 721 rows |
| Discharge forecast 48 h / 10 days | 506057 / 506059 | Ensemble | per manual |
| Tidal previsions high/low water | 432821 | Ensemble | per manual |

HIC parameter types (getParameterList):

| Name | ID | Meaning |
|---|---|---|
| **H** | 560 | River Stage |
| **W** | 563 | Tidal Water Level |
| **Q** | 558 | River Discharge |
| W_voorspeld | 12307 | tidal level forecast |
| H_voorspeld | 12271 | level forecast |
| Q_voorspeld | 12295 | discharge forecast |

Datum: "The reference plane used for water level data is 0 m TAW" (hicws.vlaanderen.be).

### 3.3 Key calls (verified)

**Series list with river names**, 7.9 s, 51 KB:

```
GET ...datasource=4&request=getTimeseriesList&format=json&timeseriesgroup_id=156163
    &returnfields=ts_id,ts_name,ts_path,station_no,station_name,stationparameter_name,parametertype_name,station_latitude,station_longitude,ts_unitsymbol,coverage,ca_sta
    &ca_sta_returnfields=river_name
→ [["ts_id","ts_name","ts_path","station_no","station_name","stationparameter_name","parametertype_name","station_latitude","station_longitude","ts_unitsymbol","from","to","river_name"],
   ["94318010","Pv.10","Mechelen/dij08a-1066/W/10m.Cmd.Abs.Pv","dij08a-1066","Mechelen Stuw Opwaarts tij/Dijle","W","W","51.0233894164117","4.49703107901109","m","2016-12-21T13:30:00.000+01:00","2026-09-23T22:20:00.000+02:00","Dijle"], ...]
```

**Values for a tidal station**, 1.9 s:

```
GET ...datasource=4&request=getTimeseriesValues&ts_id=53989010&period=PT2H&format=json&metadata=true
    &returnfields=Timestamp,Value,Quality%20Code&md_returnfields=ts_id,ts_name,station_no,station_name,parametertype_name,ts_unitsymbol,timezone,ts_spacing
→ [{"ts_id":"53989010","ts_name":"Pv.10","station_no":"zes21a-1066","station_name":"Antwerpen tij/Zeeschelde",
    "parametertype_name":"W","ts_unitsymbol":"m","timezone":"Europe/Berlin","ts_spacing":"PT10M","rows":"12",
    "columns":"Timestamp,Value,Quality Code",
    "data":[["2026-09-23T20:20:00.000+02:00",0.50,111], ... ,["2026-09-23T22:10:00.000+02:00",0.62,111]]}]
```

**Latest values for a group (layer)**, 0.6–1.0 s, 66 KB:

```
GET ...datasource=4&request=getTimeseriesValueLayer&timeseriesgroup_id=156163&format=json&metadata=true
    &md_returnfields=ts_id,station_no,station_name,parametertype_name,ts_unitsymbol&timezone=UTC
→ [{"ts_id":114978010,"timestamp":"2026-09-23T20:10:00.000Z","req_timestamp":null,"ts_value":6.57,
    "station_latitude":50.969276505467,"station_longitude":4.69217891181747,"station_no":"dij13a-1066",
    "station_name":"Werchter/Dijle","parametertype_name":"H","ts_unitsymbol":"m"}, ...]
```

**Important pitfall:** in the latest-value layer, **all 34 tidal W (`Pv.10`) series come back with `"timestamp":null,"ts_value":null`**. This also happens when they are requested by ts_id (`...getTimeseriesValueLayer&ts_id=53989010,55493010` gives nulls). Tidal stations must be fetched with `getTimeseriesValues&ts_id=...&period=PT1H`.

With `&date=2026-09-20T12:00:00Z` the layer does return tidal values (206 of 225 series exactly at 12:00Z), but that took **38 s**.

**Group-level values**: `getTimeseriesValues&timeseriesgroup_id=156163&period=PT1H` works but took **44 s** (87 KB).

**Multiple ts_ids**: `ts_id=53989010,55493010,...&period=PT30M` returned 7 series in one call. Include `ts_id` in `md_returnfields`, otherwise the rows are not labelled.

**ts_path with a wildcard**: `ts_path=*/zes21a-1066/W/10m.Cmd.Abs.Pv` returned ts 53989010.

**No-`from` "last value" call**: `getTimeseriesValues&ts_id=53989010` with no `from`/`period` returned `rows:"0"`, although the KiWIS docs say it should return the last value. Always send a `period`.

**Tidal high/low water with tide numbers:**

```
GET ...&request=getTimeseriesValues&ts_id=53995010&period=P1D&format=json&timezone=UTC&returnfields=Timestamp,Value,Quality%20Code,Tide%20Number
→ "data":[["2026-09-23T00:36:00.000Z",4.74,111,20261025],["2026-09-23T07:01:00.000Z",0.34,111,20261026],
          ["2026-09-23T12:51:00.000Z",4.64,111,20261027],["2026-09-23T19:20:00.000Z",0.11,111,20261028]]
```

The tide number is useful for following one tide wave up the Scheldt.

**Ensemble forecasts:** use `request=getTimeseriesEnsembleValues` (JSON only) to get all forecast runs. A plain `getTimeseriesValues&ts_id=<ensemble>` returns only the most recent run; that was verified on 89202010. The manual warns that treating an ensemble like a Cmd series mixes different forecast runs.

### 3.4 Freshness

- At 20:22Z the Antwerpen, Temse, Dendermonde and Melle tidal series ended at 20:10Z (10-min step).
- Menen had data to 20:15Z (15-min step).
- Maaseik reports every 5 min; Sint-Pieter Noord H every **1 min**.
- Latency is about 5–12 minutes.
- **Pitfall:** Q series sometimes carry a trailing placeholder `[..., null, -1]`, e.g. Melle Q at 20:20Z and Maaseik Q. Coverage `to` can also be about 5 minutes ahead of the real last value.

### 3.5 History and limits

- The same **250,000-value limit** applies; `period=P10Y` gave `TooManyResults … Limit is: 250000`.
- Anonymous access returned 1996 data: `["1996-05-02T00:00:00.000Z",4.87,221]`.
- Deep history starts:
  - Antwerpen high/low water: **1888-01-01**.
  - Dendermonde high/low water: 1888.
  - Melle high/low water: 1900.
  - Temse high/low water: 1900.
  - Maaseik Q: 1974.
  - Aarschot Q: 1968.
  - Liège daily Q (calculated): 1911.
- The manual also says: use pauses between large calls, and cost is based on the *theoretical* number of values in the requested range.

### 3.6 Quality flags (hicws.vlaanderen.be table)

| Code | Meaning |
|---|---|
| 6–8 | externally validated (6 good, 7 estimated, 8 suspect) |
| 10–19 | good measurements |
| 20–29 | good calculations |
| 30–39 | estimated measurements |
| 40–49 | estimated calculations |
| 60–69 | suspect measurements |
| 70–79 | suspect calculations |
| 110–179 | **unchecked** (live data comes as 111 or 121) |
| 221–223 | unknown (import) |
| 255 / −1 | missing |

### 3.7 Authentication and fair use (HIC manual, chapters 1 and 5)

- **TYPE 1:** sporadic, manual, limited use. No authentication needed. May be **blocked when the system is overloaded**.
- **TYPE 2:** sporadic large downloads. Authentication required.
- **TYPE 3:** "data are requested in an automatic process and/or scheduled in a tool/viewer/software… (example: integration of HIC webservices in a viewer …)". Authentication is required and "A User Agreement fit to your needs is put in place after consultation with HIC". **This website is TYPE 3.**
- **Token flow:** OAuth2 client-credentials.
  - Request: `POST https://hicwsauth.vlaanderen.be/auth` with header `Authorization: Basic <base64 clientId:clientSecret>` and body `grant_type=client_credentials`.
  - Response: `{"access_token":"…","token_type":"Bearer","expires_in":86400}`.
  - Then call KiWIS with `Authorization: Bearer …`.
  - Live without credentials: 400 `"Invalid auth data."`, so the endpoint exists.
- **Credits:** a daily allowance. Metadata and last-value layers are cheap. Large lists, large value layers and long high-density ranges are expensive, at roughly 1 credit per 10,000 theoretical values. Requests over 250,000 credits are never allowed.
- **HIC's own advice:**
  - Request a token only once per 24 h.
  - Fetch one big metadata list rather than many small ones.
  - Use value layers per group.
  - Use `period=P7D`-style URLs so caches can be reused.
- **Response time:** "first answer within 5 working days" (hic@vlaanderen.be).

---

## 4. Key stations: codes and ts_ids

All water levels are in m TAW. W = tidal 10-minute series, H = native resolution.

### Zeeschelde, downstream to upstream (HIC)

| Station | station_no | Level ts_id | Q ts_id | Notes |
|---|---|---|---|---|
| Prosperpolder tij (at the NL border) | zes01a-1066 | W 56088010 | – | since 1996; HW/LW 56094010 |
| Liefkenshoek tij | zes10a-1066 | W 54936010 | – | |
| Kallosluis tij | zes14a-1066 | W 54606010 | – | |
| **Antwerpen tij** (lat 51.2275, lon 4.3999; very likely the Loodsgebouw gauge, not confirmed) | zes21a-1066 | W **53989010** | – | 10-min since 1996; HW/LW **53995010** since 1888; forecast 89202010; astronomic 112650010 |
| Hemiksem tij | zes28a-1066 | W 54493010 | – | HW/LW 54499010 |
| **Schelle tij** | HIS_zes29a-1066 | W 55311010 | – | **closed 2013-06-30**. Use Hemiksem or Temse. "Schelle calc" daily Q 83735010 has been stale since 2026-01-03 |
| **Temse tij** | zes36a-1066 | W **55493010** | – | HW/LW 55499010 |
| Driegoten tij | zes39a-1066 | W 102376010 | – | |
| Sint-Amands tij | zes42a-1066 | W 55419010 | – | HW/LW 55425010 |
| **Dendermonde tij** | zes47a-1066 | W **54186010** | – | HW/LW 54192010 |
| Schoonaarde Brug tij | zes48y-1066 | W 129633010 | – | the older HIS_zes49a closed 2025-06 |
| Uitbergen tij | zes52a-1066 | W 102435010 | – | |
| Wetteren Brug tij | zes55c-1066 | W 101631010 | – | |
| **Melle tij** (Gent) | zes57a-1066 | W **116528010** | Q **72594010** (since 1971) | HW/LW 116529010 |
| Gentbrugge tij | zes58a-1066 | W 54411010 | – | |

Tidal tributaries:
- Rupel: Boom tij (`HIS_rup02a`) closed in 2015.
- Durme: Tielrode tij 55565010, Hamme tij 117472010.
- Nete: Rumst tij 114021010, Duffel Sluis tij 54283010, Lier Molbrug tij 54823010, Emblem tij 54366010, Kessel tij 54693010.
- Dijle and Zenne: Mechelen Benedensluis tij 54980010, Hombeek tij 54580010, Zemst tij 56227010.

### Leie / Lys, entering from France (HIC)

- **Wervik: no public station found**, neither in HIC's getStationList (`*Wervik*`, `*Komen*`, `*Comines*`) nor in VMM's.
- The most upstream public gauges:
  - Menen Opwaarts `lei12e-1066`, H **72768010**, since 1996.
  - Menen Ropswalle `lei11m-1066`, H **116853010**, Q **116893010**.
- Further downstream:
  - Lauwe 70813010
  - Kortrijk 5063010
  - Harelbeke 68244010
  - Sint-Baafs-Vijve 76375010 / 76412010
  - Machelen H 4800010, Q 5128010
  - Deinze H 65341010, Q 65350010
  - Sint-Martens-Latem 76519010
- DVW stations such as `WW065-OPW-1073` (Menen Opwaarts DVW) exist with many series, but they are **not in the public groups**. The manual recommends using only the groups.

### Bovenschelde / Escaut, entering from France (HIC)

- Helkijn `bos05m-1066`: H 4779010, Q 68658010
- Kerkhove 69983010
- Oudenaarde 74965010
- Asper 62853010
- Gavere: H 67105010, Q 67056010
- Zwijnaarde 79534010

### Dender (HIC)

- Overboelare `den12a`: H 4821010, Q 75053010
- Geraardsbergen 67577010
- Idegem (temporary gauges) 130149010 / 130171010
- Erembodegem `den06a`: H 16602010, Q 66529010
- Aalst (several gauges, 120041010 …)
- Denderbelle 65436010
- **Dendermonde `den02a`: H 65608010, Q 65562010**

### Demer

- HIC:
  - Aarschot Afwaarts `dem02a`: H 62410010, Q 62310010 (since 1968)
  - Zichem `dem04a`: H 5084010, Q 5754010
  - Testelt 77401010, Betekom 114956010, Langdorp 114934010
- VMM:
  - Hasselt `L09_136`: H 4342042, Q 68898042
  - Bilzen `L09_138`: H 4364042, Q 68922042
  - Molenstede `L09_126`: H 4254042, Q 68828042
  - Linkhout `L09_132` H 4298042

### Dijle

- HIC: Werchter `dij13a` 114978010, Rijmenam `dij10a` 79593010
- VMM:
  - **Sint-Joris-Weert `L08_098`: H 3880042, Q 68498042 (since 1973)**
  - Wilsele `L08_093`: H 3792042, Q 68427042
  - Korbeek-Dijle `L08_097` H 3858042

### Nete

- HIC:
  - Hulshout `gnt05a`: H 69227010, Q 69196010
  - Geel-Zammel `gnt07a`: H 67324010, Q 67302010
  - Itegem 69503010
  - Grobbendonk Troon (Kleine Nete) `knt03a`: H 67854010, Q 67863010
- VMM:
  - Geel/Grote Nete `L10_077`: H 5156042, Q 69694042
  - Meerhout `L10_078`: H 5178042, Q 69717042
  - Herentals/Kleine Nete `L10_055`: H 5024042, Q 69530042

### Zenne (Brussels outflow)

- HIC: Eppegem `zen03a`: H 66503010, Q 66513010; Vilvoorde: H 78079010, Q 78096010
- VMM: Lot/Zenne Q 68734042
- **Brussels region:** flowbru.be now redirects to hydria.be (an interactive map). I found no public API; this is **UNVERIFIED** and low priority, since the Flemish gauges downstream of Brussels cover the outflow.

### Grensmaas / Gemeenschappelijke Maas, Flemish side (HIC, H in m TAW)

- **Sint-Pieter Noord rkm 10.8 `SINT-WL1-1060`: H 76330010 (1-min), Q 76339010 (since 1996)**
- Lanaken-Smeermaas rkm 18.4 `maa08a`: 70680010
- Uikhoven rkm 25.3 `maa06x`: 110665010
- Eisden-Mazenhoven rkm 34.7 `maa06a`: 66304010
- Meeswijk Veer rkm 39.0: 72498010
- Negenoord rkm 42.5: 74032010
- Rotem rkm 44.9: 104065010
- **Maaseik rkm 52.8 `maa02a`: H 72032010, Q 72039010 (Q since 1974)**
- "Liège Afwaarts Onverdeeld calc" daily Q 92926010, since 1911, updated through 2026-09-22.
- Kessenich (on the Maas itself) and Borgharen (`BORD-1060`) exist as stations but are **not in the public groups**.

Calculated daily discharges (group 260592):
- Liège calc 92926010, Zelzate border B-NL calc 119039010 and "Gent IN" calc 119040010 are current (to 2026-09-22).
- The Zeeschelde, Rupel, Durme and Dijle calculated series stopped at **2026-01-03**.

---

## 5. Pitfalls observed

1. **VMM `datasource=0` vs `1`** changes every ID (`01` prefix). Use `datasource=1`.
2. **VMM relative vs absolute level:** always use `Absolute Value` or `valuecolumn=absolute` to get m TAW.
3. **The HIC latest-value layer returns null for all tidal W series.** Poll those with `getTimeseriesValues` and a `period`.
4. `getTimeseriesValues` without `from`/`period` returned 0 rows on HIC. Always send `period`.
5. **Stale and dead series are mixed in:**
   - 18 null and many years-old entries in the VMM H layer, 24 series with 0 rows in the HIC group call.
   - `HIS_` station prefix = closed station.
   - The `invalidPeriod` sentinel came back as −10000.
   - Trailing `null` values with quality −1 appear on HIC.
6. **Discharge at weirs is noisy or negative:**
   - Sint-Pieter Noord Q went 43.4 → 11.5 → 3.2 → 5.3 → 46.5 m³/s within 40 minutes.
   - Dendermonde/Dender Q oscillated between −1.13 and 2.95.
   - Smooth these values or show them as "indicative".
7. **Real-time data is "unchecked"** (quality 110–179) and may be revised. Re-fetch a trailing window, for example the last 6–24 h.
8. **Slow calls:**
   - HIC group values: 44 s.
   - HIC historic value layer: 38 s.
   - VMM `getTimeseriesList` for a group: 23 s.
   - VMM `getTimeseriesValues` for group 192780: HTTP 500 `DatasourceError`.
   - Use timeouts of at least 60 s and batch ts_ids (100 per call worked).
9. **JSON type inconsistency:** `ts_id` is a number in value layers and a string in value responses.
10. **Coordinates:** `station_carteasting`/`station_cartnorthing` on HIC switched from Lambert72 to **Lambert2008 on 2026-02-03**. Use the WGS84 `station_latitude`/`station_longitude` fields.
11. **Datum mismatch with the Netherlands:** Belgian TAW vs Dutch NAP. 0 m TAW is approximately NAP −2.33 m (general knowledge, about ±2 cm regionally; **UNVERIFIED** in this study). Normalise when you show levels continuing across the border into the Westerschelde or the Maas.
12. **Group contents and IDs can change without notice** (VMM disclaimer). Store `ts_path` and refresh metadata periodically.
13. The VMM open-data page returned 503 once. Treat the service as best-effort.

---

## 6. License and attribution

**VMM data**
- "Alle datasets van de Vlaamse Milieumaatschappij worden ter beschikking gesteld onder de modellicentie voor gratis hergebruik" (all VMM datasets are released under the Model Licence for Free Reuse) — https://vmm.vlaanderen.be/disclaimer
- Licence page: https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie/modellicentie-gratis-hergebruik
- Commercial reuse is allowed, for an unlimited period.
- Required attribution: "Bij hergebruik van de data vermeld je steeds als bron de VMM-website (bv. https://vmm.vlaanderen.be, https://waterinfo.vlaanderen.be …)" (when reusing, always cite the VMM website as source).
- Suggested UI text: **"Bron: VMM – waterinfo.vlaanderen.be (Modellicentie Gratis Hergebruik v1.0)"**.
- The licence also allows the generic line "bevat overheidsinformatie, verkregen onder de modellicentie voor gratis hergebruik Vlaanderen v1.0" (contains government information obtained under the Flemish model licence for free reuse v1.0).
- Some INSPIRE metadata records instead reference "Vlaamse Open Data licentie v1.0".

**HIC data** (https://hicws.vlaanderen.be)
- Required acknowledgement, which is "compulsory in case of use of the data in external applications":
  - EN: *"Flanders Hydraulics Research. Measurements and forecasts from the database of the Hydrological Information Centre [DATA]. [date of retrieval: dd/mm/jjjj]."*
  - NL: *"Waterbouwkundig Laboratorium. Metingen en voorspellingen afkomstig uit de databank van het Hydrologisch InformatieCentrum [DATA]. [datum van bevraging: dd/mm/jjjj]."*
- Restrictions:
  - The English disclaimer says data are "intended for information and **non-commercial** purposes". The Dutch version says only "informatieve doeleinden" (informational purposes).
  - The IP clause grants the right to "download information for **personal use** and to reproduce … provided the source is acknowledged"; "The HIC reserve all intellectual property rights".
  - **This is not an open licence.** A public website needs the TYPE 3 User Agreement to settle the terms.

---

## 7. Items marked UNVERIFIED

- Exact anonymous per-day quotas and the credit allowance for tokens (VMM and HIC): not published, and no credentials were available.
- Token calls with real credentials; only the endpoints' existence was confirmed (400 "Invalid auth data").
- The VMM quality-code table (DOV wiki returned 503).
- How offset-less `from`/`to` timestamps are interpreted.
- Whether the HIC `Pv.10` timestamps are instantaneous or interval-end.
- That zes21a "Antwerpen tij" is exactly the Loodsgebouw gauge (the coordinates fit).
- The TAW↔NAP offset, which comes from general knowledge.
- A Brussels (hydria/flowbru) API.
- `getTimeseriesEnsembleValues` was not called; this study only confirmed that plain `getTimeseriesValues` on an ensemble series returns the latest forecast run.

---

## 8. Recommendation for phase planning

**MVP (collect from go-live):**
1. **Apply for access before building the ingest:**
   - VMM token: hydrometrie@waterinfo.be.
   - HIC TYPE 3 credentials and User Agreement: hic@vlaanderen.be. Ask explicitly about public, possibly commercial display and redistribution, and about the "non-commercial" wording.
   - Allow weeks of lead time; HIC promises only a first reply within 5 working days.
2. **Curated station set** of about 60–90 series covering:
   - the Zeeschelde tidal chain (Prosperpolder to Gentbrugge)
   - Leie (Menen to Deinze)
   - Bovenschelde (Helkijn to Zwijnaarde)
   - Dender
   - lower Demer, Dijle and Nete (HIC)
   - upper Demer, Dijle and Nete (VMM)
   - Grensmaas (Sint-Pieter to Maaseik)

   Skip the roughly 1,000 VMM structure, pumping-station and retention-basin gauges.
3. **Polling every 10–15 minutes**, backend-side (CORS is open, but tokens must not reach the browser):
   - HIC: `getTimeseriesValueLayer` for groups 156163 (non-tidal H) and 156170 (Q).
   - HIC tidal: `getTimeseriesValues&ts_id=<~20 tidal W ids>&period=PT2H`, because the layer returns null for these.
   - VMM: `getTimeseriesValues` with batches of ≤100 ts_ids, `returnfields=Timestamp,Absolute%20Value,Quality%20Code`, `period=PT2H`, `timezone=UTC`. The VMM layer with `valuecolumn=absolute` is the cheap alternative.
   - Re-fetch a trailing 6–24 h window daily to pick up revisions.
4. **Store data in UTC**, with ts_path, quality code and datum (m TAW). Convert to NAP for cross-border display, clearly labelled.
5. **Attribution in the UI:** the VMM line and the HIC line (with retrieval date).
6. **Show discharge (Q) as secondary or indicative**, and smooth weir-affected series.

**Later phases:**
- **Historical backfill** (needs credits and polite pacing; 250k values per call):
  - 15-minute data: about 7 years per call.
  - 10-minute tidal data: about 4.7 years per call.
  - Sint-Pieter 1-minute data: about 170 days per call.
  - Deep archives: Antwerpen high/low water since 1888, 10-minute tidal since 1996, VMM since the 1970s, Liège daily Q since 1911.
- **Forecasts:** HIC 48 h and 10-day ensembles (506056 / 506058), astronomic tide predictions (354718, available to 2028), VMM `H_voorspeld`.
- **Tide-wave animation** using high/low water with `Tide Number` (group 156165).
- **Threshold colouring** from VMM `DrempelWaak` / `DrempelAlarm` series.

**Risks:**
- HIC licence and usage terms (non-commercial / personal-use wording; the User Agreement is mandatory for this use case).
- Anonymous blocking under system load.
- ID and group changes without notice.
- Tidal stations missing from the HIC value layer.
- Noisy or negative Q at weirs.
- Unchecked real-time quality.
- Slow group calls of 20–45 s.
- TAW↔NAP datum confusion at the border.
- No Wervik (Leie border) gauge in the public data; the Leie border point must come from Menen or from the French side (Vigicrues/Hydroportail, covered in another report).

---

**Sources:**
- [HIC webservices home](https://hicws.vlaanderen.be/)
- [HIC manual PDF (24/07/2026)](https://hicws.vlaanderen.be/Manual_for_the_use_of_webservices_HIC.pdf)
- [waterinfo FAQ open data](https://waterinfo.vlaanderen.be/default.aspx?path=Public%2FOver+waterinfo%2FFAQ+open+data)
- [VMM "Open Data waterinfo.be" manual](https://waterinfo.vlaanderen.be/download/9f5ee0c9-dafa-46de-958b-7cac46eb8c23?dl=0)
- [VMM disclaimer / licence](https://vmm.vlaanderen.be/disclaimer)
- [Modellicentie Gratis Hergebruik](https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie/modellicentie-gratis-hergebruik)
- [wateRinfo docs (token endpoint)](https://docs.ropensci.org/wateRinfo/)
- [pywaterinfo tutorial](https://fluves.github.io/pywaterinfo/tutorial.html)
- [pywaterinfo issue #19 (HIC endpoint)](https://github.com/fluves/pywaterinfo/issues/19)
- [Metadata: Meetpunten debiet oppervlaktewater](https://metadata.beta-vlaanderen.be/srv/api/records/83299953-7afa-4d5e-b8a2-0af017ab4c72)

Temporary files, not deliverables: `(research-session scratch files, not kept)` (raw responses, manual text extracts).
