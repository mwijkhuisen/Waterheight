# Germany: PEGELONLINE (WSV / ITZBund) REST API v2, research report

**Research date:** 2026-09-23, around 21:50–22:05 CEST (19:50–20:05 UTC). Every endpoint marked **VERIFIED** was called live with curl through the proxy, TLS verification on. Anything I could not check is marked **UNVERIFIED** with the reason. No local repository files were used as sources.

---

## 1. Key facts

| Item | Finding | Status |
|---|---|---|
| Base URL | `https://www.pegelonline.wsv.de/webservices/rest-api/v2` (also works without `www.`) | VERIFIED |
| Auth | None | VERIFIED |
| CORS | `Access-Control-Allow-Origin: *`, methods `GET,OPTIONS` | VERIFIED |
| Formats | JSON (main), CSV (measurements and forecasts), PNG charts | VERIFIED |
| Stations, all of Germany | **786** stations, 102 waters. 737 have a water level (W), 94 have discharge (Q), 43 have a forecast (WV) | VERIFIED |
| Stations on the relevant waters | **211** stations on RHEIN, MOSEL, SAAR, MAIN, NECKAR, LAHN, RUHR, EMS, DEK and the Dutch waters | VERIFIED |
| Resolution | W mostly every 15 min. Some series every 1 min (Ems, DEK, Ruhr, coast), every 10 min (Rijkswaterstaat stations) or every 5 min (Basel) | VERIFIED |
| Delay | The 22:00 CEST value was in `measurements.json` by about 22:02. The `currentmeasurement` resource lagged by a few seconds to about a minute because of server caching (`max-age` 19–44 s) | VERIFIED |
| History in the REST API | About **31 days** (oldest point 2026-08-23T01:15+02:00). With no `start`, the default window is 10 days | VERIFIED |
| Long history | Unvalidated raw W and Q **since 2000-01-01**, through a web form endpoint (not a documented API) | VERIFIED (one small test) |
| Forecasts | `WV` series (2-hourly, about 4 days) for **7 Rhine gauges**: Oestrich, Kaub, Koblenz, Köln, Düsseldorf, Ruhrort, Emmerich. Separate BfG CSV files with 14-day quantiles and 6-week outlooks | VERIFIED |
| Time zone | JSON uses ISO 8601 with a local offset (`+02:00` summer, `+01:00` winter). CSV has **no offset**. The daily files in `/webservices/files` are in **CET all year** | VERIFIED (JSON/CSV live, daily-file rule from the docs) |
| Vertical datum | W in cm above the gauge zero (PNP). The PNP is given in `gaugeZero` in "m. ü. NHN" (DHHN), but some stations use "m. ü. NN", "m ü. A." or "mü.M." (Swiss). Some series are already absolute (unit `m+NN`) | VERIFIED |
| Rate limits | None documented. No rate-limit headers seen. ETag and `If-None-Match` give a 304; gzip is supported | VERIFIED (304 tested) |
| License | **Datenlizenz Deutschland – Zero – Version 2.0** (DL-DE->Zero-2.0). No attribution required | VERIFIED (terms page dated 21.05.2024 and the govdata license text) |

---

## 2. General API behaviour

- **Caching headers seen:** `Cache-Control: max-age=44, must-revalidate…` on `stations.json` and `max-age=19` on `currentmeasurement.json`, plus `Expires` and `ETag`. A second request with `If-None-Match: "<etag>"` returned **HTTP 304**.
- **Compression:** `--compressed` returned `Content-Encoding: gzip`.
  - Emmerich 15-min, 31 days: 9.2 KB gzipped.
  - Papenburg 1-min, 31 days: 44,630 points, 189 KB gzipped, 1.36 s.
  - All 786 stations with timeseries and current values: 70 KB gzipped, about 1.0 s.
  - The relevant waters with W and Q only: about 16 KB gzipped.
- **Cookies:** each response sets a load-balancer cookie (`Set-Cookie: 1dc1b36…; secure; httponly`). The REST API does not need it.
- **Errors** are JSON with the HTTP status:
  ```json
  {"status":400,"message":"Given start parameter is neither a valid ISO date time, nor an ISO period."}
  {"status":404,"message":"Timeseries does not exist."}
  ```
  An unknown station UUID in a measurements path also returns "Timeseries does not exist." (404).
- **Pretty printing:** on by default. `prettyprint=false` gives compact JSON.
- **Versioning:** the documentation says incompatible changes get a new URL, and additions stay on the existing URL.

---

## 3. Verified endpoints, with real response excerpts

### 3.1 `GET /stations.json`: station list and filters

```
GET https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json
→ 200, 786 stations
```
```json
{"uuid":"b475386c-30cc-453a-b3b7-1d17ace13595","number":"48300105","shortname":"CELLE",
 "longname":"CELLE","km":1.74,"agency":"VERDEN","longitude":10.062164,"latitude":52.622706,
 "voiceServiceNumber":"+49228 286527 001","water":{"shortname":"ALLER","longname":"ALLER"}}
```

**Parameters tested live:**

| Parameter | Example | Result |
|---|---|---|
| `waters` | `waters=RHEIN` / `waters=MOSEL,SAAR` / `waters=rhein` | 36 / 51 / 36 stations. Case-insensitive, comma list allowed |
| `ids` | `ids=<uuid>,<uuid>` | Only those stations |
| `latitude`,`longitude`,`radius` (km) | `latitude=51.83&longitude=6.25&radius=25` | EMMERICH, LOBITH, REES, PANNERDENSE KOP |
| `km` + `radius` (along the river, with `waters`) | `waters=RHEIN&km=850&radius=20` | REES 837.4, EMMERICH 851.9, LOBITH 862, PANNERDENSE KOP 867.3 |
| `fuzzyId` | `fuzzyId=köln` → KÖLN. `fuzzyId=niers` → NIERSTEIN-OPPENHEIM, RHEINE UNTERSCHLEUSE… | This is a fuzzy name search, **not an exact match** |
| `limit`,`offset` | `waters=RHEIN&limit=3&offset=3` → BREISACH, RUST, OTTENHEIM | Pagination works. Normally not needed, since the full list is only 70 KB gzipped |
| `hasTimeseries` | `waters=RHEIN&hasTimeseries=Q` | 17 stations |
| `timeseries` | `timeseries=Q&includeTimeseries=true` | Only Q series in the output (17 Rhine stations) |
| `includeTimeseries`, `includeCurrentMeasurement`, `includeCharacteristicValues` | see 3.4 | Works |
| `includeForecastTimeseries=true&hasTimeseries=WV` | see 3.7 | 43 stations |
| `includeTrmTimeseries=true&hasTimeseries=TRM` | | 120 stations with daily "Terminwerte" |
| **`bbox`** | `bbox=5.8,50.7,7.5,52.0` | **Not supported. It is silently ignored and all 786 stations come back.** Use lat/lon/radius or filter on the client |

**Station lookup:** `/stations/{id}.json` accepts a **UUID, a gauge number, or a shortname**. All three were tested and returned the same station:
```
/stations/9598e4cb-0849-401e-bba0-689234b27644.json
/stations/2790020.json
/stations/EMMERICH.json
```
Use the UUID as the stable key. The docs call it "unveränderliche" (immutable).

### 3.2 `GET /waters.json`

```
GET …/waters.json → 102 waters
[{"shortname":"ALLER","longname":"ALLER"},{"shortname":"ALTE_MAAS","longname":"ALTE MAAS"},{"shortname":"BSK","longname":"BERLIN-SPANDAUER-SCHIFFFAHRTSKANAL"}, …]
GET …/waters.json?ids=RHEIN&includeStations=true → 1 water, 36 stations
```
Waters relevant to this project: `RHEIN, MOSEL, SAAR, MAIN, NECKAR, LAHN, RUHR, EMS, DEK` (Dortmund-Ems-Kanal), `WDK`, `RHK`, `DHK` (canals), and the Dutch-side `WAAL, IJSSEL, LEK, ALTE_MAAS, NEUE_MAAS`. There is **no** water for MAAS/Meuse, RUR, NIERS or VECHTE.

### 3.3 Station with timeseries, current value, characteristic values and gauge zero

```
GET …/stations.json?waters=RHEIN&includeTimeseries=true&includeCurrentMeasurement=true&includeCharacteristicValues=true
→ 200, 97 KB uncompressed, 1.5 s
```
KÖLN, trimmed:
```json
{"uuid":"a6ee8177-107b-47dd-bcfd-30960ccc6e9c","number":"2730010","shortname":"KÖLN","km":688.0,
 "agency":"STANDORT KÖLN","longitude":6.9633,"latitude":50.936949,
 "water":{"shortname":"RHEIN","longname":"RHEIN"},
 "timeseries":[
  {"shortname":"Q","longname":"ABFLUSS_ROHDATEN","unit":"m³/s","equidistance":15,
   "currentMeasurement":{"timestamp":"2026-09-23T21:30:00+02:00","value":586.0},"characteristicValues":[]},
  {"shortname":"W","longname":"WASSERSTAND ROHDATEN","unit":"cm","equidistance":15,
   "currentMeasurement":{"timestamp":"2026-09-23T21:45:00+02:00","value":53.0,"stateMnwMhw":"low","stateNswHsw":"normal"},
   "gaugeZero":{"unit":"m. ü. NHN","value":35.038,"validFrom":"2019-11-01"},
   "characteristicValues":[
    {"shortname":"GlW","longname":"gleichwertiger Wasserstand","unit":"cm","value":139.0,"validFrom":"2023-01-01"},
    {"shortname":"HHW","longname":"Höchster Hochwasserstand","unit":"cm","value":1069.0,"occurrences":["1926-01-01"]},
    {"shortname":"NNW","longname":"Niedrigster Niedrigwasserstand","unit":"cm","value":69.0,"occurrences":["2018-10-23"]},
    {"shortname":"MNW","longname":"Mittel der Niedrigwasserstände ","unit":"cm","value":114.0,"timespanStart":"2010-11-01","timespanEnd":"2020-10-31"},
    {"shortname":"MW","longname":"Mittel der Tageswasserstände ","unit":"cm","value":297.0,"timespanStart":"2010-11-01","timespanEnd":"2020-10-31"},
    {"shortname":"MHW","longname":"Mittel der Hochwasserstände ","unit":"cm","value":725.0,"timespanStart":"2010-11-01","timespanEnd":"2020-10-31"},
    {"shortname":"HSW","longname":"höchster Schifffahrtswasserstand","unit":"cm","value":830.0,"validFrom":"1950-01-01"},
    {"shortname":"M_I","longname":"Marke_I","unit":"cm","value":620.0}, {"shortname":"M_II","longname":"Marke_II","unit":"cm","value":830.0},
    {"shortname":"TuGLW", …}]}]}
```
- **Characteristic values seen:** GlW, TuGLW, M_I, M_II, HHW, NNW, MNW, MW, MHW, HSW.
  - They come in different shapes: some have `validFrom`, some have `occurrences`, some have `timespanStart`/`timespanEnd`.
  - They exist **only for W**. None of the Q series in these basins has any, so there is no MQ, MNQ or MHQ in the API.
  - Many stations have none at all: all Rijkswaterstaat mirrors, the tidal Ems, Mannheim-Neckar and Hattingen.
- **`stateMnwMhw`** is `low` if W ≤ MNW, `normal` if between, and `high` if W ≥ MHW. It can also be `unknown`, `commented` or `out-dated`. **`stateNswHsw`** does the same against NSW/HSW.
  - Across all 737 W series: unknown 356, normal 219, low 156, out-dated 3, commented 3.
  - `stateNswHsw` is `unknown` for 605 of them.
  - Q current measurements carry **no** state fields.
- **Timeseries comments** are included automatically with `includeTimeseries` and explain gaps. Live examples:
  ```json
  EMMERICH Q: {"shortDescription":"Abflussermittlung unter W = -1cm aktuell nicht möglich", …}
  Heidelberg UP Q: {"shortDescription":"Abflussermittlung unter W=221cm nicht möglich"}
  RHEINWEILER Q: {"shortDescription":"Abflusswerte im niedrigen Bereich nicht plausibel"}
  Mehring AMS W: {"shortDescription":"Techn. Störung"}   (stateMnwMhw = "commented")
  ```
- The same data is available per timeseries: `GET …/stations/{uuid}/W.json?includeCurrentMeasurement=true&includeCharacteristicValues=true` (VERIFIED for Emmerich: `gaugeZero` 7.998 m. ü. NHN, validFrom 2019-11-01, NNW −1 cm on 2022-08-18, MNW 51, MW 239, MHW 669, HSW 870).

### 3.4 `GET /stations/{uuid}/{ts}/currentmeasurement.json`

```
GET …/stations/9598e4cb-0849-401e-bba0-689234b27644/W/currentmeasurement.json
{"timestamp":"2026-09-23T21:45:00+02:00","value":-7.0,"stateMnwMhw":"low","stateNswHsw":"normal"}

GET …/stations/9598e4cb-0849-401e-bba0-689234b27644/Q/currentmeasurement.json
{"timestamp":"2026-09-19T16:45:00+02:00","value":678.0}     ← 4 days stale (see comment above)
```

### 3.5 `GET /stations/{uuid}/{ts}/measurements.json` (and `.csv`, `.png`)

| Call (Emmerich W, 15-min) | Result |
|---|---|
| no params | 960 points, 2026-09-13T22:00 → 2026-09-23T21:45 (**10-day default**) |
| `start=P31D` | 2,976 points, from 2026-08-23T22:00 (**now minus 31 days**) |
| `start=P60D` | **Silently truncated**: 3,059 points from 2026-08-23T01:15. No error |
| `start=2026-07-01T00:00:00%2B02:00&end=2026-07-02T00:00:00%2B02:00` | `[]` with **HTTP 200**, no error |
| `start=2026-09-20T00:00:00%2B02:00&end=2026-09-20T01:00:00%2B02:00` | 5 points. **Both ends inclusive** |
| `start=2026-09-19T22:00:00Z&end=…Z` | Same 5 points. UTC `Z` is accepted |
| `start=…+02:00` with the `+` **not** encoded | Still worked, but encode it as `%2B` to be safe |
| `start=2026-09-20` (date only) | Read as local midnight |
| `start=PT1H` | Last hour |
| `start=yesterday` | 400 error (see §2) |

Excerpt:
```json
[{"timestamp":"2026-09-20T00:00:00+02:00","value":-4.0},{"timestamp":"2026-09-20T00:15:00+02:00","value":-4.0}, …]
```
- **CSV** (`measurements.csv?start=PT45M`) is semicolon-separated with no time-zone offset:
  ```
  timestamp;value
  2026-09-23 21:15;-7
  ```
- **PNG** (`measurements.png?start=P7D&width=600&height=300`) → `200 image/png`, 22 KB.
- **Consistency check:** fetching P31D twice about 8 minutes apart gave 0 changed values in 2,975 overlapping points and no gaps longer than 15 min. Whether raw values get revised later within the 31 days is **UNVERIFIED**, because I only had a few minutes to observe.

### 3.6 Update cadence, measured

- The docs say most inland gauges update every 15 min and coastal gauges are usually no more than 5 min old.
- Emmerich's 22:00 value was **not** there at 22:01:01 CEST. It **was** in `measurements.json` by 22:02:13. `currentmeasurement.json` still returned 21:45 at that moment and showed 22:00 by 22:02:23.
- Median age of the current W across all 737 series: 5 minutes. 8 series were older than 2 hours, and 3 older than 24 hours. In our basins that includes Mülheim Schlossbrücke (Ruhr), out of date since 2026-09-05.
- For Q: 20 of 94 were older than 2 hours. In our basins: Emmerich (4 days), Heidelberg UP (26 days), Diez Hafen (8 days) and Frankfurt Osthafen (2.6 h).

### 3.7 Forecasts: `WV` (Wasserstandsvorhersage)

```
GET …/stations.json?includeForecastTimeseries=true&hasTimeseries=WV → 43 stations
```
- **Rhine forecasts (7 stations, 4 days ahead, 2-hourly):** OESTRICH `665be0fe-…`, KAUB `1d26e504-…`, KOBLENZ `4c7d796a-…`, KÖLN `a6ee8177-…`, DÜSSELDORF `8f7e5f92-…`, DUISBURG-RUHRORT `c0f51e35-…`, EMMERICH `9598e4cb-…`.
- There is **no** WV for Maxau, Speyer, Mannheim, Worms, Mainz, or any station on Mosel, Main, Neckar, Saar, Lahn or Ems.
- The other WV stations are on the Danube, Elbe, Oder and Saale.

Series metadata:
```json
{"shortname":"WV","longname":"WASSERSTANDVORHERSAGE","unit":"cm","equidistance":120,
 "start":"2026-09-23T07:00:00+02:00","end":"2026-09-27T07:00:00+02:00",
 "comment":{"shortDescription":"nwv-bfg","longDescription":"Vorhersagen und Abschätzungen vom: 23.09.2026 um 07:00 Uhr, Quelle: Bundesanstalt für Gewässerkunde. …"}}
```
```
GET …/stations/1d26e504-7f9e-480a-b52c-5932be6549ab/WV/measurements.json → 49 points
```
```json
{"initialized":"2026-09-23T07:00:00+02:00","timestamp":"2026-09-23T07:00:00+02:00","value":13.0,"type":"forecast"}
…
{"initialized":"2026-09-23T07:00:00+02:00","timestamp":"2026-09-27T07:00:00+02:00","value":6.0,"type":"estimate"}
```
- Each run has 25 `forecast` points (0–48 h) and 24 `estimate` points (48–96 h).
- **Only the latest run is served.** Every point had the same `initialized` time, so there is no forecast archive.
- The CSV version has columns `percentile10…percentile90`. They were **empty** for Kaub today.
- A station without WV returns `404 {"message":"Timeseries does not exist."}` (tested on Mainz).
- According to the BfG page, runs are issued on working days, and also at weekends and holidays when Ruhrort is below 400 cm. Weekend behaviour was **UNVERIFIED** live, because today is a Wednesday.

**BfG machine-readable CSV files (outside PEGELONLINE):**
- **14-day probabilistic quantiles** (daily means). Index: `https://vorhersage.bafg.de/14-Tage-Vorhersage/`
  - Files: `Oestrich_Quantile_25100300.csv`, `Kaub_Quantile_25700100.csv`, `Koblenz_Quantile_25900700.csv`, `Koeln_Quantile_2730010.csv`, `Duesseldorf_Quantile_2750010.csv`, `Duisburg-Ruhrort_Quantile_2770010.csv`, `Emmerich_Quantile_2790020.csv`, plus PDFs.
  - VERIFIED: 200 `text/csv`, `Last-Modified: Wed, 23 Sep 2026 09:45:05 GMT`.
  ```
  # Probabilistische Wasserstandsvorhersage vom 2026-09-23 GMT+1
  # Quelle: Bundesanstalt fuer Gewaesserkunde <vorhersage@bafg.de>
  # Vorhersagetage 1 - 14 Tagesmittelwerte
  # Keine Veroeffentlichung von Werten > 640 cm (Wert '---')
  # !!!! Zeitstempel Beginn des Zeitschritts !!!!
  Kaub
  Datum;5%;10%;20%;25%;30%;40%;50%;60%;70%;75%;80%;90%;95%
  23.09.2026 00:00;9;10;10;10;10;10;10;10;11;11;11;11;11
  24.09.2026 00:00;5;5;6;6;6;7;7;7;8;8;8;9;9
  ```
  The header says GMT+1 (CET, no summer time), dates are `DD.MM.YYYY`, and values above 640 cm appear as `---`.
- **6-week outlook** (weekly means, ENS/ESP/OBS box-plot quantiles, W and Q). Index: `https://vorhersage.bafg.de/6-Wochen-Vorhersage/index.html`
  - Rhine gauges: Maxau and Worms (W only), Kaub, Köln and Duisburg-Ruhrort (W and Q). Example: `Rhein-Kaub_6Wochen_Abfluss_QuansBox.csv` (VERIFIED, issued 2026-09-21).
- **Official flood forecasts** come from the state flood centres, not BfG. BfG itself says: "Bei Hochwasser stellen die … Hochwasservorhersage- und -meldezentralen der Bundesländer bereitgestellten Vorhersagen die aktuelle, amtliche Information". **UNVERIFIED**: I did not test any state flood-centre feeds, which are out of scope here.

### 3.8 Other access routes found

- **HyDAS API (beta):** `https://pegelonline.wsv.de/api/v1/stations?ids=…`, `/stations/{id}/parameters`, `/stations/{id}/parameters/{W|Q}/values?from=&to=`.
  - VERIFIED for stations and parameters. The bare root `/api/v1` returns 400 "Required header 'X-API-SECRET' is not present", but the documented sub-paths work without a key.
  - Availability is the same ~31 days (`"start":"2026-08-23T01:00:00+02:00"`).
  - Useful extras: `riverLocation.stationingOrigin` (`source` or `mouth`), `state` (e.g. `DE-NW`) and `operatorUrl`.
  - The docs say not to use it in production yet: "Beta … inkompatibel ändern".
  - Note that some stations without coordinates in REST v2 also have none in HyDAS (e.g. Trier OP).
- **Long-term raw download since 2000-01-01**, used by the station pages (`/gast/stammdaten?pegelnr=…`). It is a **form, not a documented API**. It needs the session cookie and two steps:
  ```
  1) GET  https://pegelonline.wsv.de/gast/stammdaten?pegelnr=2790020        (sets cookie)
  2) POST https://pegelonline.wsv.de/gast/historische-zeitreihen/prepare-download
          uuid=9598e4cb-…&parameter=WASSERSTAND ROHDATEN&start=2020-01-01T00:00:00+01&end=2020-01-01T02:00:00+01&format=json|csv
     → 303 Location: /gast/historische-zeitreihen/download?filename=pegelonline-emmerich-W-20200101-20200101.zip-<token>
  3) GET  that Location with the same cookie → 200 application/zip
  ```
  - The zip holds the data file, `nutzungsbedingungen.txt` and `zeitreiheninformation.txt`:
  ```json
  [{"timestamp":"2020-01-01T00:00:00+01:00","value":396},{"timestamp":"2020-01-01T00:15:00+01:00","value":396}, …]
  ```
  ```
  station_number=2790020 … timeseries_unit=cm timeseries_equidistance=15 quality=unchecked
  ```
  - The Q form uses `parameter=ABFLUSS ROHDATEN` (a different form id on the page; I did not test a Q download).
  - The page warns that building a file can take up to 15 s.
  - The UI asks the user to tick the terms-of-use box, but this is only checked in the browser.
- **Daily files** at `https://pegelonline.wsv.de/webservices/files/<Parameter>/<WATER>/<uuid>/<date>/down.txt` cover the last 31 days. The timestamps are "ganzjährig in mitteleuropäischer Winterzeit" (CET all year). I did not fetch any; **UNVERIFIED**, and not needed.
- **WMS, WFS and SOS** are listed in the site menu. **UNVERIFIED**: I did not call them because the REST API is enough.

---

## 4. Data meaning and conversion

### 4.1 Parameters and units
- **W** (`WASSERSTAND ROHDATEN`, sometimes just `WASSERSTAND`) is in **cm** above the gauge zero for 683 series.
  - **54 series are already absolute**, in unit `m+NN`: all DEK/RHK/WDK/DHK canal stations, the Ruhr (Ruhrwehr OW, Schlossbrücke Mülheim), MLK and ESK.
  - 2 series are in `m+PNP` (dams).
  - **Always branch on `unit`.**
- **Q** is in m³/s. The longname is `ABFLUSS_ROHDATEN` for most WSV stations and `ABFLUSS` for the Main (WSA Aschaffenburg/Schweinfurt). It is computed live from a rating curve, and it stops when W leaves the curve's valid range (Emmerich below −1 cm, Heidelberg below 221 cm).
- Other series in these basins: WT (water temperature), LT (air temperature), O2, PH, LF, DFH (bridge clearance), VA (flow velocity), WG and WR (wind).

### 4.2 Converting W to an absolute height
- **Formula:** `H [m NHN] = gaugeZero.value + W[cm] / 100`. This holds when `gaugeZero.unit` is "m. ü. NHN" and the W unit is `cm`. The PEGELONLINE help page says the same: "Für absolute Höhenangaben (m ü. NHN) müssen Sie den PNP-Wert des jeweiligen Pegels addieren."
  - Köln: 35.038 + 0.53 = **35.57 m NHN**.
  - Emmerich: 7.998 − 0.07 = **7.93 m NHN**.
- **Datum mix found live:**
  - "m. ü. NHN": 593 series.
  - **none (no `gaugeZero`)**: 95 series. In our basins that means all 10 Rijkswaterstaat mirrors, Konstanz-Rhein, Mehring AMS, Stadtbredimus UP, Herbrum Hafendamm, Rhede, Versen Trennspitze and the `m+NN` canal and Ruhr series.
  - "m. ü. NN": 40 series, e.g. **Lingen-Darme (Ems) 14.98 m ü. NN, valid from 2001-10-16**. NN (DHHN12) differs from NHN by a few cm.
  - "m ü. A.": 8 series.
  - "mü.M.": 1 series, **Basel-Rheinhalle at 240.0 "mü.M."**, which is the Swiss datum (LN02), not NHN.
- **Datum versions:** the PNP table says DHHN2016 replaces DHHN92, both reported as "m ü. NHN". NHN and Dutch NAP both refer to Amsterdam, but they are **not identical**. The exact NHN–NAP offset near the border is **UNVERIFIED** and belongs in the synthesis. Before drawing one continuous profile across the border, check it or show relative values instead.
- **`gaugeZero.validFrom`:** the Rhine gauges show 2019-11-01. The historical download for Emmerich showed **no jump in W** across 2019-10-31 → 2019-11-01 (150 → 150 cm). That means the PNP change was a relabelling of the datum, not a physical shift of the gauge. The API **only exposes the current PNP**, so absolute heights before `validFrom` will be off by the datum difference (likely mm to a few cm; **UNVERIFIED**).
- **Rijkswaterstaat stations mirrored in PEGELONLINE** have no `gaugeZero`. Their values (Lobith 628, Nijmegen Haven 436, Krimpen −25, Rotterdam −28 cm) look like **cm relative to NAP**. This is **inferred and UNVERIFIED**; confirm it against the RWS source.
- **Tidal Ems:** Papenburg and Leerort have PNP −5.06 and −5.04 m NHN. Herbrum Hafendamm (568 cm) and Rhede (580 cm) have no PNP but are probably on the same NHN−5 m basis. **UNVERIFIED.**

### 4.3 River kilometres and flow direction (important for "following water downstream")
- **`km` is present for 784 of 786 stations.** VERSEN WEHR OP (Ems) has `km=None`.
- **The direction of km differs by river.** HyDAS `stationingOrigin` confirms:
  - **Rhine:** from the source (Konstanz km 0.5 → Pannerdense Kop km 867.3, increasing downstream).
  - **Mosel, Saar, Main, Neckar:** from the **mouth**, increasing upstream. For example Perl is Mosel km 241.8 and Koblenz is Mosel km 1.3.
  - **Lahn:** increases downstream (Marburg km −38.7 … Lahnstein km 136).
  - **Ruhr:** federal km increase **upstream** from the mouth (Ruhrwehr 2.96, Mülheim 12.18), yet HyDAS says `source` for Hattingen (km 56.9, a Ruhrverband gauge). **That metadata looks wrong.**
  - **Ems:** a mix of kilometre systems. The upper Ems and DEK use km 96–235 (Wachendorf 96.7 … Versen Wehrdurchstich 234.8). The tidal lower Ems restarts at **Papenburg km 0.39** → Emshörn km 74.3.
  - **Conclusion:** the downstream order has to be **curated by hand** per river, including where tributaries join the Rhine (Neckar at Mannheim km ~428, Main at Mainz km ~497, Lahn at Lahnstein km ~585, Mosel at Koblenz km ~592, Ruhr at Duisburg km ~780, Lippe/WDK at Wesel km ~814).
- **`water.longname`** always equals the shortname for rivers ("RHEIN"). Canals get full names ("DORTMUND-EMS-KANAL").
- **Missing coordinates:** 35 of the 211 basin stations have no latitude/longitude. They are mostly Mosel/Saar/Neckar lock "OP" and "UP" gauges, plus Dordrecht, Rotterdam, Krimpen, Zaltbommel, Vuren and IJsselkop. Positions would have to come from km plus river geometry, or be curated by hand.

---

## 5. Station inventory for the relevant basins (VERIFIED 2026-09-23)

| Water | Stations | with W | with Q | without coordinates | Notes |
|---|---|---|---|---|---|
| RHEIN | 36 | 36 | 17 | 0 | Includes CH Basel (BAFU), Konstanz (RP Freiburg), 2 RWS stations (Lobith, Pannerdense Kop) |
| MOSEL | 30 | 28 | 3 | 4 | Many lock OP/UP pairs (river is impounded). The border stretch with LU is Perl → Grevenmacher |
| SAAR | 21 | 21 | 3 | 11 | Impounded. Hanweiler is at the FR border |
| MAIN | 16 | 13 | 7 | 0 | |
| NECKAR | 43 | 43 | 6 | 13 | Mostly lock "Schleuse UP" gauges |
| LAHN | 26 | 26 | 4 | 1 | |
| RUHR | 3 | 3 | 1 | 0 | 2 in `m+NN`; Mülheim out of date; Hattingen from Ruhrverband |
| EMS | 17 | 17 | **0** | 0 | Upper Ems impounded; tidal from Herbrum/Papenburg; 1-min estuary gauges |
| DEK (Dortmund-Ems-Kanal) | 11 | 11 | 0 | 0 | Includes **Herbrum Hafendamm** and Rhede (Ems at the tidal limit), Versen Trennspitze |
| WAAL / IJSSEL / LEK / ALTE_MAAS / NEUE_MAAS | 4/1/1/1/1 | all | 0 | 6 total | RWS mirrors with placeholder numbers (e.g. `123456781`) |
| **Total** | **211** | | | **35** | |

**Not in PEGELONLINE:** Maas/Meuse, Rur/Roer, Niers, Vechte/Overijsselse Vecht, Lippe (except its canal), Erft and Sieg. These are state waters (NRW LANUV, NLWKN) or foreign ones. "Dordrecht"/"Rotterdam" appear only under ALTE_MAAS/NEUE_MAAS as RWS mirrors.

### 5.1 Key stations: snapshot 2026-09-23 about 21:45 CEST (W in cm; absolute = PNP + W/100)

| Water | Station | Number | UUID | km | PNP (m, datum, valid from) | W now | Abs. m | MNW / MW / MHW / HSW | Q | WV |
|---|---|---|---|---|---|---|---|---|---|---|
| RHEIN | Basel-Rheinhalle | 2310010 | `94f6eff1-4f3f-4850-82e0-a086198e9ffd` | 164.3 | 240.0 **mü.M.** 2010-02-01 | 494 | (CH datum) | –/–/–/820 | – | – |
| RHEIN | Rheinweiler | 23300130 | `06b978dd-8c4d-48ac-a0c8-2c16681ed281` | 186.2 | 217.291 NHN 2018-11-01 | 197 | 219.26 | 192/220/564/– | Q* | – |
| RHEIN | Kehl-Kronenhof | 23300900 | `23af9b02-5c82-4f6e-acb8-f92a06e5e4da` | 292.2 | 133.02 NHN 2018-11-01 | 185 | 134.87 | 180/236/426/– | Q | – |
| RHEIN | Iffezheim | 23500600 | `b02be240-1364-4c97-8bb6-675d7d842332` | 336.2 | 110.019 NHN | 36 | 110.38 | 104/240/518/– | Q | – |
| RHEIN | **Maxau** | 23700200 | `b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea` | 362.327 | 97.721 NHN 2017-07-18 | 285 | 100.57 | 353/496/785/750 | Q | – |
| RHEIN | **Speyer** | 23700600 | `2cb8ae5b-c5c9-4fa8-bac0-bb724f2754f4` | 400.61 | 88.467 NHN | 147 | 89.94 | 214/361/699/730 | Q | – |
| RHEIN | **Mannheim** | 23700700 | `57090802-c51a-4d09-8340-b4453cd0e1f5` | 424.733 | 85.117 NHN | 58 | 85.70 | 132/293/644/760 | – | – |
| RHEIN | **Worms** | 23900200 | `844a620f-f3b8-4b6b-8e3c-783ae2aa232a` | 443.37 | 84.112 NHN | **−22** | 83.89 | 46/195/529/650 | Q | – |
| RHEIN | **Mainz** | 25100100 | `a37a9aa3-45e9-4d90-9df6-109f3a28a5af` | 498.27 | 78.373 NHN 2019-11-01 | 105 | 79.42 | 159/288/547/630 | Q | – |
| RHEIN | Oestrich | 25100300 | `665be0fe-5e38-43f6-8b04-02a93bdbeeb4` | 518.08 | 77.562 NHN | 35 | 77.91 | 79/186/412/– | – | **WV** |
| RHEIN | Bingen | 25300200 | `0309cd61-90c9-470e-99d4-2ee4fb2c5f84` | 528.36 | 76.185 NHN | 33 | 76.52 | 84/195/436/490 | – | – |
| RHEIN | **Kaub** | 25700100 | `1d26e504-7f9e-480a-b52c-5932be6549ab` | 546.23 | 67.669 NHN | 9 | 67.76 | 65/208/544/640 | Q | **WV** |
| RHEIN | **Koblenz** | 25900700 | `4c7d796a-39f2-4f26-97a9-3aad01713e29` | 591.49 | 57.692 NHN | 9 | 57.78 | 60/214/588/650 | – | **WV** |
| RHEIN | **Andernach** | 27100400 | `5735892a-ec65-4b29-97c5-50939aa9584e` | 613.78 | 51.504 NHN | 12 | 51.62 | 71/258/672/760 | Q | – |
| RHEIN | **Bonn** | 2710080 | `593647aa-9fea-43ec-a7d6-6476a76ae868` | 654.8 | 42.713 NHN | 69 | 43.40 | 121/290/680/– | Q | – |
| RHEIN | **Köln** | 2730010 | `a6ee8177-107b-47dd-bcfd-30960ccc6e9c` | 688.0 | 35.038 NHN | 53 | 35.57 | 114/297/725/830 | Q | **WV** |
| RHEIN | **Düsseldorf** | 2750010 | `8f7e5f92-1153-4f93-acba-ca48670c8ca9` | 744.2 | 24.529 NHN | 8 | 24.61 | 70/257/684/880 | Q | **WV** |
| RHEIN | **Duisburg-Ruhrort** | 2770010 | `c0f51e35-d0e8-4318-afaf-c5fcbc29f4c1` | 780.8 | 16.106 NHN | 137 | 17.48 | 201/394/835/1130 | Q | **WV** |
| RHEIN | **Wesel** | 2770040 | `f33c3cc9-dc4b-4b77-baa9-5a5f10704398` | 814.0 | 11.206 NHN | 74 | 11.95 | 144/348/804/1060 | Q | – |
| RHEIN | **Rees** | 2790010 | `2f025389-fac8-4557-94d3-7d0428878c86` | 837.4 | 8.743 NHN | 22 | 8.96 | 91/293/747/– | Q | – |
| RHEIN | **Emmerich** | 2790020 | `9598e4cb-0849-401e-bba0-689234b27644` | 851.9 | 7.998 NHN 2019-11-01 | **−7** | 7.93 | 51/239/669/870 (NNW −1) | Q (stale) | **WV** |
| RHEIN | Lobith (RWS) | 2790050 | `efe13a3d-f239-4655-9c13-4ac56dfa4478` | 862.0 | – | 628 (NAP?) | – | – | – | – |
| RHEIN | Pannerdense Kop (RWS) | 2790060 | `3046493f-971f-4d22-9f29-7ef8e3b645a4` | 867.3 | – | 600 | – | – | – | – |
| MOSEL | **Perl** (FR/LU border) | 26100100 | `c263ea53-ca4d-41f5-b3f5-6178fec302aa` | 241.8 | 138.491 NHN 2019-01-01 | 216 | 140.65 | 210/246/521/– | Q | – |
| MOSEL | **Trier UP** | 26500100 | `3bec53ca-444e-4014-a7b0-07b3591e954b` | 195.3 | 121.013 NHN | 223 | 123.24 | 219/304/730/695 | – | – |
| MOSEL | **Cochem** | 26900400 | `768df4e9-ed5a-4141-901b-e25ac404d559` | 51.6 | 77.032 NHN | 216 | 79.19 | 210/273/648/600 | Q | – |
| MOSEL | Alken (Q only, no W) | 26900510 | `16578824-88de-4700-ab09-f61dbb1182bd` | 24.1 | – | – | – | – | Q | – |
| SAAR | Hanweiler (FR border) | 26400100 | `eeaba884-d4c5-4a83-88fb-adcd79adbc50` | 104.6 | 189.731 NHN | 234 | 192.07 | –/246/–/– | – | – |
| SAAR | Sankt Arnual | 26400220 | `a9ca43e9-ef92-4f1c-ac02-a6c8ccad7b9f` | 90.906 | 183.228 NHN 2024-11-13 | 201 | 185.24 | 189/205/342/230 | Q | – |
| SAAR | Fremersdorf | 26400550 | `fe72ee98-88e9-4d19-aba1-f97f61b7d4de` | 48.514 | 165.491 NHN | 205 | 167.54 | 196/217/432/390 | Q | – |
| MAIN | Würzburg | 24300600 | `915d76e1-3bf9-4e37-9a9a-4d144cd771cc` | 251.97 | 164.511 NHN | 152 | 166.03 | 140/174/515/340 | Q | – |
| MAIN | Frankfurt Osthafen | 24700404 | `66ff3eb4-513b-478b-abd2-2f5126ea66fd` | 37.591 | 90.626 NHN | 147 | 92.10 | 154/177/361/370 | Q | – |
| MAIN | **Raunheim** (near mouth) | 24900108 | `db1684c1-7ffc-4e8a-b8cf-8240a0d03519` | 12.213 | 82.879 NHN | 114 | 84.02 | 118/145/374/400 | Q | – |
| NECKAR | Plochingen | 23800100 | `be7ce40e-5fff-42df-8386-b42694ca86da` | 202.56 | 245.86 NHN | 152 | 247.38 | 148/164/373/– | Q | – |
| NECKAR | Lauffen | 23800500 | `8559d1a0-4a03-410a-8910-44a089a07df8` | 125.43 | 159.37 NHN | 217 | 161.54 | 219/259/532/– | Q | – |
| NECKAR | Rockenau SKA | 23800690 | `4c00a166-7d6d-48d7-b4dc-673b96b4041e` | 60.7 | 119.71 NHN | 210 | 121.81 | 208/237/623/– | Q (fault) | – |
| NECKAR | Heidelberg UP | 23800760 | `827b2685-47ec-44df-a90f-980f5e0c1591` | 26.1 | 103.22 NHN | 205 | 105.27 | 207/220/401/260 | Q (stale) | – |
| NECKAR | Mannheim Neckar | 23800900 | `25582d3f-dc5f-4c70-bd08-e84fd13201ca` | 3.1 | 84.787 NHN | 53 | 85.32 | – | – | – |
| LAHN | Leun neu | 25800200 | `32807065-b887-49f0-935a-80033e5f3cb0` | 25.1 | 134.993 NHN | 131 | 136.30 | 130/207/557/360 | Q | – |
| LAHN | Kalkofen neu | 25800600 | `64f735fd-88b6-42ea-9cdd-dc18d3806c34` | 106.4 | 86.4 NHN | 174 | 88.14 | 174/226/558/360 | Q | – |
| RUHR | Hattingen (Ruhrverband) | 2769510000100 | `c0594fb5-77ff-4287-9b8d-7ff326afe9ff` | 56.9 | 60.384 NHN 2011-11-01 | 103 | 61.41 | – | Q | – |
| RUHR | Ruhrwehr OW (Duisburg) | 27600090 | `12a3037f-cbf3-49d3-8da5-77fb38730bba` | 2.961 | – (**unit m+NN**) | 25.00 m | 25.00 | – | – | – |
| EMS | **Rheine Unterschleuse** | 3390020 | `50a449ba-af4c-42c7-b2c4-9a3eda37e1e3` | 153.03 | 24.188 NHN **1976-10-15** | 184 | 26.03 | 188/258/546/– | – | – |
| EMS | Lingen-Darme | 3500015 | `200363fc-cdc5-4c22-a271-a25d1ba880ed` | 196.2 | 14.98 **NN** 2001-10-16 | 118 | 16.16 | 123/214/504/– | – | – |
| EMS | **Versen Wehrdurchstich** | 3730010 | `6de43652-2db9-4627-a255-9cb1f8efb820` | 234.78 | 6.71 NHN | 97 | 7.68 | 91/142/350/– | – | – |
| EMS | Versen Wehr OP | 3730001 | `86f8dbab-6a64-408b-a5d5-69e69f01db2f` | **None** | … | … | | | – | – |
| DEK | **Herbrum Hafendamm** | 3770030 | `8177a148-5674-4b8f-8ded-050907f640f3` | 213.07 | **none** | 568 | ? | – | – | – |
| EMS | Papenburg (tidal) | 3790010 | `ec4a598d-773d-44c1-935e-2053b54e45a3` | 0.39 | −5.06 NHN | 587 | 0.81 | – | – | – |
| EMS | Leerort / Terborg / Pogum / Emden / Knock / Dukegat / Emshörn | 3910010 … 9340010 | see listing | 14.8–74.3 | ≈ −5 NHN | tidal | | | – | – |

\*Rheinweiler Q comment: "Abflusswerte im niedrigen Bereich nicht plausibel". This is the Restrhein, the old Rhine bed; most of the water goes through the French Grand Canal d'Alsace.

**Hydrological situation at the time of testing:** there was an extreme low-water event. Emmerich was at −7 cm, below its NNW of −1 cm (2022-08-18). Kaub was at 9 cm and Worms at −22 cm. Emmerich's Q had stopped because of the rating-curve limit. This shows directly that the product has to handle **negative W, out-of-range values and missing Q**.

---

## 6. License, terms and attribution

- **PEGELONLINE (REST, HyDAS, downloads):** "Informationen, Produkte oder Dienste, die Sie von dieser Website erhalten, dürfen übernommen werden. Dies geschieht auf der Grundlage der Lizenz DL-DE->Zero-2.0". Source: https://www.pegelonline.wsv.de/gast/nutzungsbedingungen, "Stand: 21.05.2024" (VERIFIED).
  - License text at https://www.govdata.de/dl-de/zero-2-0: "Jede Nutzung ist ohne Einschränkungen oder Bedingungen zulässig." Commercial use, modification and combination with other data are allowed, and **no attribution is required**.
  - The HyDAS responses repeat this in their `meta` block: `"licenseName":"DL-DE->Zero-2.0","licenseUrl":"https://www.govdata.de/dl-de/zero-2-0"`.
  - **Disclaimer to show:** the data are "ungeprüfte Rohdaten" (unvalidated raw data), with no liability for correctness or timeliness.
  - **Third-party data:** the terms say "In PEGELONLINE werden zusätzlich Daten Dritter … angezeigt", and the disclaimer covers them. Whether DL-DE Zero also applies to the mirrored **Rijkswaterstaat, Swiss BAFU (Basel), RP Freiburg (Konstanz) and Ruhrverband (Hattingen)** series is **not stated clearly**. **UNVERIFIED**: prefer getting those from their original source, or check their licenses.
  - **Suggested attribution** (voluntary, but good practice): `Pegeldaten: WSV/GDWS via PEGELONLINE (pegelonline.wsv.de), Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0). Ungeprüfte Rohdaten.`
- **BfG forecasts (14-day and 6-week, vorhersage.bafg.de and 6wochenvorhersage.bafg.de):** these are **not** DL-DE Zero. The BfG terms on https://6wochenvorhersage.bafg.de/ (VERIFIED) say: "Der Nutzer / die Nutzerin verpflichtet sich, in Veröffentlichungen, die auf der Grundlage der bereitgestellten Daten entstanden sind, die BfG als Datenquelle zu nennen und der BfG ein entsprechendes Belegexemplar unentgeltlich zur Verfügung zu stellen." So **attribution is required**, plus a free copy of the publication (Belegexemplar).
  - The `WV` series inside PEGELONLINE carry "Quelle: Bundesanstalt für Gewässerkunde" in their comment. Whether PEGELONLINE's DL-DE Zero covers WV or the BfG terms apply is **ambiguous**. Treat WV as BfG data: credit "Wasserstandsvorhersage: Bundesanstalt für Gewässerkunde (BfG)" and label it forecast or estimate.
- **ELWIS**, https://www.elwis.de/…/Haftungsausschluss-und-Nutzungsbedingungen (VERIFIED): "Alle über ELWIS veröffentlichten Informationen dürfen übernommen und auch kommerziell nachgenutzt werden, solange der Inhalt unverändert bleibt und als Quelle www.elwis.de angegeben wird." Content must stay unchanged and the source must be named, so avoid ELWIS as a source for derived views. PEGELONLINE and the BfG CSV files are better.
- **Rate limits and fair use:** none documented in the REST docs, the user guide or the terms. **UNVERIFIED** whether ITZBund throttles heavy clients; I did not run a load test on purpose. Use ETag or `If-None-Match`, gzip, and batch requests.

---

## 7. Pitfalls observed (all seen live)

1. **Retention is only about 31 days.** Asking for older data returns `[]` or a silently shortened list, with HTTP 200 and no error. The default window with no `start` is 10 days. A collector outage longer than about 30 days means permanent loss through the REST API; only the web-form history download is left.
2. **`bbox` is silently ignored** and all 786 stations come back.
3. **Units are mixed:** W in `cm`, `m+NN` or `m+PNP`; gauge-zero datums NHN, NN, "m ü. A." or Swiss "mü.M.", or missing entirely (95 series).
4. **Negative W is normal** (Emmerich −7, Worms −22). Do not treat it as invalid.
5. **Q goes stale or stops** outside the rating curve. Emmerich's Q was 4 days old and Heidelberg's 26 days, each with a comment. There is **no Q at all** on the Ems, at Koblenz, Mannheim or Oestrich, or at the Rijkswaterstaat mirrors. Raw Q is not mass-balanced along the river (Kehl 406 m³/s vs Iffezheim 293 m³/s).
6. **The `currentMeasurement` on Q has no state flags.** On W the state is often `unknown` when there are no MNW or MHW values.
7. **35 stations lack coordinates.** One station lacks `km`.
8. **km direction differs by river** (Mosel, Saar, Main and Neckar count up from the mouth), and the Ems has two km systems. HyDAS `stationingOrigin` is wrong for Hattingen.
9. **Impounded rivers** (Mosel, Saar, Neckar, Main, Lahn, upper Ems) have lock "OP/UP" gauges whose W barely moves, so a flood wave is barely visible there. Show Q, or the anomaly against MW, where it exists.
10. **Tidal gauges** (Ems below Herbrum, the Dutch delta mirrors) oscillate twice a day and show no downstream "flow" signal. They need separate styling or should be left out.
11. **Timestamps:**
    - JSON is correct ISO 8601 with offset. The API also accepts `Z`.
    - CSV has **no offset** (local time, ambiguous during the autumn DST hour).
    - The `/webservices/files` daily files are **CET all year**.
    - The BfG 14-day CSV is "GMT+1" with `DD.MM.YYYY` dates and daily means stamped at the **start** of the day.
    - **Store UTC.**
12. **Encode `+` as `%2B`** in ISO timestamps. The server accepted a raw `+`, but that is fragile.
13. **`fuzzyId` is fuzzy** ("niers" matches Nierstein), so do not use it to match a station.
14. **Forecasts:** `WV` keeps only the latest run (no archive), exists for just 7 Rhine gauges, and has no percentiles today. The 14-day CSV writes `---` for values above 640 cm.
15. **Server caching:** `currentmeasurement.json` can lag `measurements.json` by up to about a minute.
16. **Rijkswaterstaat mirror stations** have placeholder gauge numbers (`123456781`…`123456786`, `852369741`) and no PNP. Use the RWS source for them.
17. **Gauge zero history is not exposed.** Only the current PNP and its `validFrom` are available.

---

## 8. Answers to the specific questions

- **stations.json and its filters:** all verified. The one exception is **bbox, which is not supported**.
- **waters.json:** verified. `includeStations=true` works.
- **measurements.json with ISO and duration parameters (e.g. P31D):** verified. There is a hard limit of about 31 days, and inclusive bounds.
- **currentmeasurement.json:** verified.
- **characteristicValues (MNW, MW, MHW, HSW, NNW, HHW, GlW, Marke I/II):** verified. W only.
- **gaugeZero:** verified. Formula: `m NHN = PNP + W/100`, applied only when the W unit is `cm` and the gaugeZero unit is NHN.
- **Discharge Q:** 17 Rhine stations. No Q on the Ems or at the Dutch mirrors.
- **Forecasts:** yes, officially machine-readable:
  - `WV` in PEGELONLINE (7 Rhine gauges, about 4 days, 2-hourly, forecast then estimate).
  - BfG 14-day quantile CSVs for the same 7 gauges.
  - BfG 6-week CSVs (Maxau, Worms, Kaub, Köln, Ruhrort).
- **Update cadence:** 15 min for most gauges, 1 or 5 min for some. The new value appears about 2 or more minutes after its timestamp.
- **History:** REST gives 31 days. The web-form download goes back to 2000-01-01 (unvalidated raw W and Q). Validated yearbooks exist only as PDFs at dgj.de, which is **UNVERIFIED** and was not fetched.
- **Ruhr:** there are 3 stations, but only the lowest ~12 km are federal (in `m+NN`), plus a Ruhrverband gauge at Hattingen.
- **Maas/Rur/Niers/Vechte:** not in PEGELONLINE. They need NRW (LANUV/ELWAS) and Lower Saxony (NLWKN) sources, which are out of scope here.

---

## 9. Recommendation for phase planning

**MVP (Germany part):**
1. **Collector:** every 15 minutes (aligned to hh:02, :17, :32, :47), make one call:
   `GET …/stations.json?waters=RHEIN,MOSEL,SAAR,MAIN,NECKAR,LAHN,RUHR,EMS,DEK&includeTimeseries=true&includeCurrentMeasurement=true&timeseries=W,Q&prettyprint=false` with gzip and `If-None-Match`. That is about 16 KB and 1 request.
   - Keep a timestamp-plus-value history per series, keyed by UUID and timeseries.
2. **Gap filler:** once an hour, and after any outage, call `measurements.json?start=PT6H` (or up to `P30D`) for each curated series. With about 60–80 curated series that is about 1–2 requests per minute on average, which is light.
   - Downsample the 1-minute series to 15 minutes before storing.
   - Store UTC.
3. **Curated station list:** about 40–60 map stations, not all 211. Take the key table in §5.1 and add hand-set downstream order, confluence links, coordinates where missing, and a per-river km direction.
   - Prefer free-flowing gauges, or the UP gauge where the river is impounded.
   - Leave out the Rijkswaterstaat, Swiss and Ruhrverband mirrors and use their original sources.
4. **Display:** relative W (cm) plus the class against MNW/MW/MHW, computed in our own code because the API's `state` is often `unknown`. Add a "stale" badge when the last value is more than 2 hours old, and show the timeseries `comment`.
   - Only offer absolute m NHN where `unit=cm` and the gauge zero is NHN, and do **not** mix it with NAP until the offset has been checked.
5. **Metadata refresh:** reload stations, PNP and characteristic values once a day, and log any change to PNP or `validFrom`.
6. **Attribution:** show the DL-DE Zero line and the raw-data disclaimer in the footer.

**Later phases:**
- **Forecasts:** add `WV` for the 7 Rhine gauges, then the BfG 14-day quantile CSVs.
  - This needs the BfG credit and the Belegexemplar obligation, which is a legal and admin task.
  - Keep our own archive of forecast runs, because the API keeps only the latest one.
- **Historical backfill from 2000:** use the web-form endpoint. **Contact ITZBund/WSV before any bulk scripted download**, since it is not a documented API.
  - Reconcile gauge-zero datum changes (e.g. 2019-11-01).
  - Treat all of it as unvalidated.
- **Q-based flow view:** use Q along the Rhine for "following the water", and fill the gaps (Emmerich cut-off, Ems) from other sources or a model.
- **HyDAS API:** re-evaluate once it leaves beta. It gives state codes and km origin.

**Risks:**
- About **31-day retention**: a long collector outage means gaps that can only be filled through the unofficial history form. Monitor the collector.
- Raw, unvalidated data: outliers, stale Q, faults. They show up only in free-text comments.
- There is no SLA and no documented rate limit, so be polite: use caching and batching.
- The datum mix (NHN, NN, Swiss, NAP) can break any absolute cross-border profile.
- Station set and metadata can change: new UUIDs when a gauge is rebuilt ("Leun neu", "Kalkofen neu", "Wieblingen Wehr UP neu"). Use a curated mapping with alerts.
- The border and tributary rivers the product needs (Maas, Rur, Niers, Vechte) are **not** federal, so they need other data providers.

**Questions for you (the user asked to ask if anything is unclear):**
1. Should the MVP show Q (discharge) as well as W, knowing that Q is missing on the Ems and at Emmerich below −1 cm?
2. Should tidal gauges (the lower Ems and the Dutch delta) and impounded lock gauges appear on the map, or only free-flowing river gauges?
3. Is it acceptable to script the historical download form (for a later phase), or should we first ask ITZBund for permission or a bulk export?
4. Is displaying BfG forecasts, with the credit and free-copy obligation that comes with them, in scope?

---

**Sources:**
- PEGELONLINE REST API documentation: https://www.pegelonline.wsv.de/webservice/dokuRestapi
- REST API user guide: https://www.pegelonline.wsv.de/webservice/guideRestapi
- HyDAS API: https://www.pegelonline.wsv.de/webservice/hydas
- Downloads: https://www.pegelonline.wsv.de/webservice/downloads
- Help pages (time reference, datums, long-term download, data freshness): https://pegelonline.wsv.de/gast/hilfe
- Terms of use: https://www.pegelonline.wsv.de/gast/nutzungsbedingungen
- DL-DE Zero 2.0 license text: https://www.govdata.de/dl-de/zero-2-0
- BfG forecasts overview: https://www.bafg.de/DE/3_Beraet/2_Exp_quantitaet/Vorhersagen_M2/vorhersagen_node.html
- BfG 14-day forecast: https://www.bafg.de/DE/5_Informiert/1_Portale_Dienste/14Tagevorhersage/14tagevorhersage_text.html
- BfG forecast file index: https://vorhersage.bafg.de/
- BfG 6-week forecast and its terms: https://6wochenvorhersage.bafg.de/
- ELWIS Kaub forecast page: https://www.elwis.de/DE/dynamisch/Wasserstaende/Pegelvorhersage:KAUB
- ELWIS terms of use: https://www.elwis.de/DE/Service/Haftungsausschluss-und-Nutzungsbedingungen/Haftungsausschluss-und-Nutzungsbedingungen-node.html
- GovData dataset entry: https://www.govdata.de/suche/daten/pegelonline-rest-schnittstelle

Working files (raw API responses) are in `(research-session scratch files, not kept)`. The main ones are `stations_all.json`, `all_ts.json`, `basins_full.json`, `wv.json`, `kaub_q.csv` and `hist.zip`.