# Germany: state (Länder) hydrology services for tributaries PEGELONLINE does not cover

*Research date: 2026-09-23 (evening, CEST). Every endpoint below was called live with curl unless it is marked **UNVERIFIED**. No local repository files were used.*

---

## 0. Summary

| Service | Official, documented machine interface? | Live-verified | Real-time values | History online | Licence / terms | First release? |
|---|---|---|---|---|---|---|
| **LHP PublicAPI** (hochwasserzentralen.de) | **Yes.** OpenAPI 3 spec | ✅ | **No values.** Flood class only, plus alerts | None | CC BY 4.0 | Yes, as an optional overlay |
| **NRW – LANUK** (was LANUV). Hochwasserportal.NRW / OpenHygon | **Yes (files).** Official download ZIPs refreshed about every 5 min; the WISKI-Web JSON is internal but serves the same data | ✅ | W (water level) only, 15-min/5-min | 7 d (15-min); 2 mo + 2 y daily; verified data back to the 1930s | **DL-DE-Zero-2.0** | **Yes. Top priority.** |
| Wasserverband Eifel-Rur (WVER) | No (static HTML and JSON behind the frontend) | ✅ (main site); `server.wver.de` ❌ | W, Q | about 1 y (15-min) per station JSON | CC BY-SA 4.0 | Later |
| Niersverband | No (PDF charts only) | ✅ | – | – | not stated | No (use LANUK) |
| **Niedersachsen – NLWKN** | **Yes.** REST API with a PDF manual and a public key | ✅ | W, 15-min | **30 days max** | Free to use, source must be named. **But the Impressum contradicts this** | **Yes** (Vechte/Dinkel), after clarifying the licence |
| Rheinland-Pfalz – LfU (hochwasser.rlp.de) | No (internal SPA JSON). CSV export is hot-link protected | ✅ | W (+Q), 15-min, **plus probabilistic forecast** | 48 h / 5 d (API); 90 d 15-min + 3 y daily (CSV) | Impressum: **LfU consent required** | Later, with permission |
| Hessen – HLNUG | No (WISKI-Web JSON). The download area is licensed | ✅ | W, Q, 15-min, **plus forecasts** | 7 d 15-min; daily values since about 1995 | Download area **CC BY 4.0** | Phase 2 |
| Baden-Württemberg – LUBW HVZ | No (JS data arrays) | ✅ | W, Q (latest only) | none (images only) | Impressum: **LUBW consent required** | Later, with permission |
| Bayern – LfU GKD/HND | No API (HTML tables; human download centre) | ✅ | W, Q (HTML) | from 1963 (download centre) | Download page says CC BY 4.0. Impressum/robots.txt restrict automation | Later / backfill only |
| Saarland – LUA | Unknown | ❌ **UNVERIFIED** (bot shield 403) | – | – | – | Later (LHP class only) |

Key message: **NRW (LANUK) is the only state source that is both officially machine-readable and permissively licensed.** It covers almost every NL-bound tributary: Rur, Wurm, Niers, Schwalm, Berkel, Issel/Oude IJssel, Bocholter Aa, Dinkel, upper Vechte and upper Ems. NLWKN adds the lower German Vechte and Dinkel. Everything further upstream (Nahe, Lahn, Kinzig, Murg, upper Neckar, Main tributaries, Blies) sits behind undocumented frontends and/or "consent required" terms.

---

## 1. Länderübergreifendes Hochwasserportal: LHP PublicAPI (all states)

- Docs page: https://www.hochwasserzentralen.de/developers/ and https://www.hochwasserzentralen.de/developers/api-docs
- OpenAPI spec: https://www.hochwasserzentralen.de/developers/docs/lhp-public-api_v1.20240123.yaml. The spec's version string is `1.0_beta_2025_01-23`; responses report `apiVersion: "1.0 beta, 2025-02-04"`.
- Servers:
  - `https://api.hochwasserzentralen.de/public/v1` (live)
  - `…/public/v1/test` (fixed test data)
- Authentication: none. CORS `*`. `Cache-Control: max-age=60`.

### Endpoints (all GET)

| Path | Params | Content |
|---|---|---|
| `/data/stations` | `format` (json/geojson), `states` (comma list of BB,BE,BW,BY,HE,HB,HH,MV,NI,NW,RP,SH,SL,SN,ST,TH), `lang` | GeoJSON FeatureCollection of about 1,200 flood gauges, with flood class only |
| `/data/alerts` | same | Regional flood warnings (polygons or river sections) |
| `/images/logo` | `Accept: image/svg+xml` | LHP logo |

**Important:** the docs say explicitly: *"Nicht bereitgestellt werden Messwerte wie Wasserstand oder Abfluss. Bitte wenden Sie sich hierfür an die jeweiligen Betreiber."* The API gives no water level or discharge values, only the flood class.

### Verified call

```
GET https://api.hochwasserzentralen.de/public/v1/data/stations?format=json&states=NW
200 application/geo+json; ETag: c8166220cb8aa01d48f2e203c39ade19; Cache-Control: max-age=60; Access-Control-Allow-Origin: *
{"apiVersion":"1.0 beta, 2025-02-04","status":"success",
 "licence":"https://creativecommons.org/licenses/by/4.0/deed.de","licenceName":"CC BY 4.0 - Namensnennung",
 "updated":"2026-09-23T21:07:46+01:00",
 "legend":{"items":[{"lhpClass":4,"lhpClassName":"Sehr großes Hochwasser","color":"#941094"}, …,
                    {"lhpClass":0,"lhpClassName":"Kein Hochwasser","color":"#7CBD5C"},{"lhpClass":-1,"lhpClassName":"Derzeit keine Daten","color":"#7b7b7b"}]},
 "stateLinks":{"DE-NW":"https://hochwasserportal.nrw.de/lanuv/webpublic/index.html#/Lageberichte"},
 "features":[{"kind":"Station","id":"NW_2721390000100","type":"Feature",
   "geometry":{"type":"Point","coordinates":[8.0264,50.894]},
   "properties":{"name":"Weidenau","water":"Sieg","timestamp":"2026-09-23 22:00:00","lhpClass":0,
     "stateClassName":"Kein Hochwasser",
     "stationLink":"https://www.hochwasserportal.nrw/webpublic/#/overview/Wasserstand/station/28754/Weidenau/Wasserstand",
     "stateId":"DE-NW"},"style":{"color":"#7CBD5C"}}, …]}   // 137 NW features
```

- Station counts (verified): BY 243, RP 180, BW 179, HE 163, NW 137, NI 100, SL 24.
- The feature `id` is `<state>_<state station number>`. This is useful for discovering stations and linking them across sources.
- `/data/alerts?states=NW,NI` returned 200 with 0 features (no active warnings).

### Licence and attribution

- CC BY 4.0.
- Show the source visibly, as a clickable link online: *"Datenquelle: www.hochwasserzentralen.de"* (or "Quelle: Länderübergreifendes Hochwasserportal (LHP)", linking to https://www.hochwasserzentralen.de).
- Also show *"Stand: TT.MM.JJJJ hh:mm"*, taken from `updated`.
- Data is updated every minute. When republishing online, refresh at least every 10 min. LHP class colours should be kept.

### Pitfalls observed

- **Time zones are mixed.** `updated` carries a fixed `+01:00` (MEZ). Feature `timestamp` has **no offset and is local legal time (MESZ in summer)**. Verified: Hessen "Sannerz" is `2026-09-21 16:30:00` in LHP and `15:30:00+01:00` in HLNUG.
- `format=xml` still returned `application/geo+json`.
- The ETag changed on every call because `updated` changes every minute, so `If-None-Match` rarely yields 304.
- Saarland features have `stationLink: null`. NRW Rhine gauges link to RLP pages.
- The internal frontend endpoints (`/webservices/get_lagepegel.php`, `get_lagepegel_archiv.php`, POST) returned empty bodies to plain GET/POST. They are undocumented; don't use them.

---

## 2. Nordrhein-Westfalen: LANUK (Landesamt für Natur, Umwelt und Klima; formerly LANUV)

The portal is https://www.hochwasserportal.nrw/webpublic/. The legacy host `hochwasserportal.nrw.de/lanuv/…` redirects there. It is a KISTERS WISKI-Web frontend whose data root is `https://www.hochwasserportal.nrw/data/`.

### 2.1 Official downloads (documented on the portal "Downloads" page)

The portal's own Downloads component lists these files under `../data/downloads/`, with the text *"Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0)"*. The start page also says: *"Die Möglichkeiten für den Datendownload … stehen unter der OpenData Lizenz (Deutschland Zero 2.0)"*.

| File | Content (portal wording) | Refresh |
|---|---|---|
| `https://www.hochwasserportal.nrw/data/downloads/messwerte.zip` | W, 15-min (some 5-min), all LANUK stations, last 7 days | "kontinuierlich". Observed Last-Modified 20:04:03, 20:18:46 and 20:23:46 UTC, so **about every 5 min** |
| `…/downloads/pegeldaten.zip` (≈10 MB) | W high-res (2 months), daily mean/max (2 years), metadata | "täglich (Tageswechsel)" |
| `…/downloads/temperatur.zip`, `temperaturdaten.zip`, `niederschlag.zip`, `niederschlagsdaten.zip` | temperature and precipitation | same pattern |

```
GET https://www.hochwasserportal.nrw/data/downloads/messwerte.zip    (≈909 KB → messwerte.txt 12.1 MB, ASCII, CRLF)
station_no;time;value(cm)
2847500000100;2026-09-16T21:15:00.000+01:00;42.60
2847500000100;2026-09-16T21:30:00.000+01:00;42.60
…
2829100000100;2026-09-23T21:00:00.000+01:00;32.00
2829100000100;                  <- every station block ends with "station_no;" and empty fields (253 such lines)
```

The file holds 255 station blocks, about 239k rows, and covers 7 days.

The same product is mirrored **once a day** (about 05:09) on the state open-data server:

- `https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hygon/`. This is a JSON directory listing containing `OpenHygon-Pegel-aktuell_CSV.zip`, `OpenHygon-Pegel-Bestand_CSV.zip` (10 MB), `OpenHygon-Pegel-Stationen_EPSG4326.txt`, shapefiles and `OpenHygon_meta.zip`.
- GovData catalogue entry "Hydrologische Rohdaten (Hochwasserportal NRW)": licence `http://dcat-ap.de/def/licenses/dl-zero-de/2.0`, frequency `CONT`, publisher "Landesamt für Natur, Umwelt und Klima Nordrhein-Westfalen".

### 2.2 WISKI-Web JSON (internal frontend files, same data)

Not documented as an API. These are the static JSON files the portal SPA loads, and `robots.txt` is `Disallow:` (empty).

| GET | Content |
|---|---|
| `https://www.hochwasserportal.nrw/data/internet/layers/index.json` | layers: 10 Wasserstand, 11 WasserstandMax (48h), 20 Wassertemperatur, 30 Niederschlag, 40 Niedrigwasser. **No discharge layer.** |
| `…/data/internet/layers/10/index.json` (272 KB) | **latest value of all 302 W stations**, with thresholds |
| `…/data/internet/stations/stations.json` (568 KB) | 620 stations (all types) |
| `…/data/internet/stations/{site_no}/{station_no}/S/week.json` | 7 d of 15-min W |
| `…/data/internet/stations/{site_no}/{station_no}/S/year.json` | 365 d daily mean + daily max |
| `…/data/internet/stations/{site_no}/{station_no}/S/alarmlevel.json` | information levels 1–3, N7W, etc. |

```
GET https://www.hochwasserportal.nrw/data/internet/layers/10/index.json
[{"ts_id":88499010,"timestamp":"2026-09-23T20:45:00.000+01:00","ts_value":"32.00",
  "station_latitude":51.0978936437795,"station_longitude":6.10451262980085,"classification":"MN7W",
  "ts_name":"Wasserstand.Internet.15","ts_shortname":"15m.Cmd.Internet","station_id":"28723",
  "station_no":"2829100000100","site_no":"100","station_name":"Stah","ts_unitsymbol":"cm",
  "stationparameter_no":"S","catchment_name":"Rureinzugsgebiet","WTO_OBJECT":"Rur","WEB_STATYPE":"Infopegel",
  "LANUV_MHW":"211.0","LANUV_MNW":"31.0","LANUV_MW":"65.0","LANUV_Info_1":"200.0","LANUV_Info_2":"245.0","LANUV_Info_3":"265.0", …}, …]

GET https://www.hochwasserportal.nrw/data/internet/stations/100/2829100000100/S/week.json
[{"station_name":"Stah","station_no":"2829100000100","ts_name":"Wasserstand.Internet.15","ts_unitsymbol":"cm",
  "CATCHMENT_SIZE":"2135.15 km²","WTO_OBJECT":"Rur","rows":"664","columns":"Timestamp,Value",
  "data":[["2026-09-16T23:00:00.000+01:00",39.0], …,["2026-09-23T20:45:00.000+01:00",32.0]]}]

GET …/S/year.json  -> ts "Day.Mean.B.Inter.W" (364 rows) and "Day.Max.B.Inter.W" (365 rows),
  columns "Timestamp,Value,Aggregation Accuracy %", e.g. ["2026-09-23T00:00:00.000+01:00",35.0,88.55]
```

Headers: `last-modified` present, `cache-control: max-age=0`, no ETag. `month.json`, `Q/week.json` and `…/index.json` return 404.

### 2.3 Verified (checked) history for backfill: opengeodata "hydro"

- Base: `https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hydro/`. Licence dl-zero-de/2.0. `temporal_start` 1930-01-01.
- `hydro/w/` holds 16 catchment datasets as decade ZIPs, for example `Rureinzugsgebiet-NRW-W_2020-2029_EPSG25832_CSV.zip` (20 MB) and `Niers-u-Schwalmeinzugsgebiet…`, `Issel-Berkel-Vechteeinzugsgebiet…`, `Emseinzugsgebiet…`, `Ruhr…`, `Lippe…`, `Wupper…`, `Erft…`, `Sieg…`.
- `hydro/q/` holds discharge in the same structure (listed via GovData, not downloaded).

```
Ahreinzugsgebiet-NRW-W_2020-2029_EPSG25832_CSV.zip -> 2718193000100_Ahrhuette-Neuhof_2020-2025_Wasserstand_cm.csv
station_name;station_no;dateTime;value[cm]
Ahrhütte-Neuhof;2718193000100;2020-01-01T00:00:00+01:00;27.536
Ahrhütte-Neuhof;2718193000100;2020-01-01T00:07:30+01:00;27.486
Ahrhütte-Neuhof;2718193000100;2020-01-01T01:37:30+01:00;27.486
…
Ahrhütte-Neuhof;2718193000100;2026-06-12T14:00:00+01:00;NA
```

Pitfall: the timestamps are **irregular, change-driven** (not a 15-min grid), and verified data lags about 3 months.

### 2.4 Station metadata and vertical datum

- `hydro/Hydrologische-Stationen-NRW_EPSG25832_CSV.zip` (**ISO-8859-1**). The column `Nullpunkt` is the gauge zero in m. Example: `Stah;2829100000100;ja;…;297270.8265;5664699.114;32U;19050601;22.91;2135.15;29.938;Wassenberg;…`, so PNP = 29.938 m.
- `hydro/Wasserstand_MetaDaten_Pegel_EPSG25832_Shape.zip` (the CSV inside is UTF-8) has `Hoehensystem` = **DHHN2016**, plus `Folgegewaesser` (e.g. "Maas"), river km, and purpose (`Hochwassermeldepegel`).
- Values are **cm above gauge zero (PNP)**. To get absolute height: `m NHN (DHHN2016) = PNP + W/100`.

### 2.5 Coverage of the NL-bound rivers (verified in layer 10, 23 Sep 2026)

| River | NRW gauges (`station_no`, * = Infopegel/flood-report gauge) |
|---|---|
| Rur | Monschau* 2821530000200, Zerkall*, Altenburg_1*, Selhausen 2823900000100, Jülich-Stadion* 2825190000200, Linnich 2825330000100, **Stah* 2829100000100** (last gauge before NL) |
| Inde | Eschweiler*, Kirchberg1*, Kornelimünster*, Lamersdorf |
| Wurm | Kalkofen 2828100000100, Herzogenrath_1* 2828300000200, Randerath* 2828900000200 |
| Niers | Oedt* 2861700000100, Geldern Burgstraße*, Weeze* 2867900000100, **Goch* 2869500000200**, Bettrather_Dyck (stale since 2026-06-09) |
| Schwalm | Molzmühle 2843000000100, Pannenmühle 2847500000100, **Landesgrenze 2849900000100** |
| Issel (Oude IJssel) | Dämmerwald* 9281330000100, **Isselburg* 9281700000200** |
| Bocholter Aa | Rhedebrügge* 9282570000100 |
| Berkel | Gescher, Lutum*, Stadtlohn*, **Ammeloe* 9284730000100** |
| Dinkel | Legden 9286410000100, Heek*, **Gronau* 9286455000200** |
| Vechte | Schöppingen* 9286139100100, Bilk 9286190000100 |
| Ems (upper) | Steinhorst*, Rheda*, Warendorf*, Einen*, Greven*, Espeln, Haskenau (+WSV Rheine) |
| Ruhr / Lippe / Sieg / Erft / Wupper | 8 / 11 / 7 / 4 / 5 gauges |

### 2.6 ELWAS

ELWAS-WEB (https://www.elwasweb.nrw.de/elwas-web/index.xhtml) is a JSF GIS app. I found no documented machine interface. Its verified time series are the ones published in `hydro/` above.

### 2.7 NRW pitfalls observed

- **Timestamps use a fixed `+01:00` (MEZ) all year**, including in summer. Parse the offset; do not assume local legal time.
- `ts_value` is a **string** in layer 10 but a number in week.json.
- `site_no` meaning: 100 = LANUK, 102 = WSV (mirrored PEGELONLINE gauges such as `2790020` WSV_Emmerich), 104 = other operators (WVER, Aggerverband, Ruhrverband), 105 = RLP. **Deduplicate WSV gauges against PEGELONLINE.**
- **Placeholder station numbers:** `1234567` (St. Heimbach UW), `123456` (St. Obermaubach UW) and `1234512345` (Soestbach, appears **twice**). Key on `station_id` + `site_no`, not on `station_no` alone.
- Stale stations remain in the snapshot (the oldest timestamp was 2026-06-09). Apply a freshness filter.
- No real-time discharge (Q) is published in NRW.
- The downloads text contains an older paragraph ("kommerzielle Nutzung … Nutzungsvereinbarung") alongside the DL-DE-Zero statement. See §11.

---

## 3. Wasserverband Eifel-Rur (WVER)

- Portal: https://wver.de/pegelstaende/ links to the static table `https://wver.de/karten_messwerte/Messdatenportal/aktuelle_Werte_Pegel.html` (HTML).
- It covers about 70 Rur-basin gauges: WVER's own, LANUK, RWE and Dutch ones (e.g. "Wurm Rimburg NL", "Amstelbach Eygelshoven WL").

```
| Rur Stah LANUK | Pegel | 23.09.2026 21:45 | 32,0 cm |
| Wurm Rimburg NL | Pegel | 23.09.2026 20:00 | 84,14 cm |
| Stb. Obermaubach UW | Pegel | 23.09.2026 21:45 | 47,22 cm |
```

- Station pages (e.g. `…/Messdatenportal/Kall%20Zerkall.html`) fetch `Messdaten/<Name>WasserstandBasis.P.json` and `…AbflussBasis.P.json`, which are KiWIS-style JSON:

```
GET https://wver.de/karten_messwerte/Messdatenportal/Messdaten/Kall%20ZerkallWasserstandBasis.P.json  (1.44 MB)
{"ts_id":"46966010","station_name":"Kall Zerkall","station_latitude":"50.6837529504102",…,"parametertype_name":"Wasserstand",
 "ts_unitsymbol":"cm","station_no":"ob.8.15","rows":"672","columns":"Timestamp,Value",
 "data":[["2025-09-18T00:00:00.000+02:00",7.0], …,["2026-09-23T22:00:00.000+02:00",4.2]]}
```

- It holds about 1 year of 15-min data. **Timestamps carry the correct local offset (+02:00)**, unlike LANUK. `rows` ("672") does not match the actual length.
- Licence: `Hinweise.html` says *"Ungeprüfte Rohdaten | Lizenzhinweis: CC BY-SA 4.0 | Längere Zeiträume auf Anfrage"*. ShareAlike would apply to redistributed derived data.
- `https://server.wver.de/pegeldaten/` ("Übersichtstabelle Messstellen/Zeitreihen") is **UNVERIFIED**: the TLS connection was reset (proxy relay `ws_closed_mid_exchange`) and plain `http://` returned 503.
- Assessment: this is frontend scraping with no documented API. The main Rur/Wurm/Inde gauges are already in LANUK, so WVER only adds small tributaries, dam outflows and the NL cross-border gauges.

## 4. Niersverband

https://www.niersverband.de/gewaesser/pegelwesen/daten publishes **PDF charts only** for Kessel/Goch, Geldern, B7/Viersen and Bettrather Dyck, e.g. `/fileadmin/user_upload/Dateien_GL/GL_GH/Internet_peg-kesw-woche.PDF`. The page says it is updated "mehrmals täglich" and times are in MEZ. There is no machine-readable interface. The Niers state gauges Oedt, Geldern, Weeze and Goch are in LANUK, so **use LANUK**.

*(Also seen: the Ruhrverband page https://www.talsperrenleitzentrale-ruhr.de/online-daten/gewaesserpegel is HTML only, with W and Q for about 37 Ruhr gauges including Mülheim, Hattingen and Essen-Werden. No API was found. Other water boards (Wupperverband, Erftverband, Aggerverband, EGLV) were not investigated.)*

---

## 5. Niedersachsen: NLWKN Pegelonline

- Portal: https://www.pegelonline.nlwkn.niedersachsen.de/
- The `/Hinweis#Webservice` page says: *"NLWKN Pegelonline stellt einen Webservice bereit, der kostenfrei genutzt werden kann … REST-API"*. Manual: https://www.pegelonline.nlwkn.niedersachsen.de/pdf/BenutzerhandbuchWebservicePegelonline.pdf ("Stand: 26.10.2023").
- The manual gives the **public key** as `<NLWKN_PUBLIC_KEY>`, passed as the query parameter `key`. An invalid key returns **401**.
- Base URL: `https://bis.azure-api.net/PegelonlinePublic/REST/` (Azure API Management).

| GET | Meaning |
|---|---|
| `stammdaten/stationen/All?key=…` | all NLWKN stations with master data and latest value (858 KB, **112 stations**, about 3 s) |
| `stammdaten/stationen/{id,id,…}?key=…` | selected stations (unknown IDs are silently dropped) |
| `station/{STA_ID}/datenspuren/parameter/{PAT_ID}/tage/{-n}?key=…` | series; `PAT_ID` 1 = Wasserstand; `tage` **negative** |
| `chart/station/{STA_ID}/datenspuren/parameter/{PAT_ID}/tage/{-n}?key=…` | same series, with chart metadata |

```
GET https://bis.azure-api.net/PegelonlinePublic/REST/station/258/datenspuren/parameter/1/tage/-1?key=<NLWKN_PUBLIC_KEY>
{"getPegelDatenspurenResult":{"Betreiber":"NLWKN Betriebsstelle Meppen","GewaesserName":"Vechte","GewaesserNameNachfolger":"Issel",
 "Hoehe":7.961,"Hoehe_Text":"NN + 7,961 m","Latitude":"6.85700772610435","Longitude":"52.6022309606521",
 "Name":"Emlichheim","STA_ID":258,"STA_Nummer":"9286162","WGS84Hochwert":6.857007726104353,"WGS84Rechtswert":52.60223096065214,
 "Parameter":[{"Name":"Wasserstand","Einheit":"cm","PAT_ID":1,"Datenspuren":[{"DAS_ID":14681695,"IntervallSek":900,
   "Meldestufen":[{"Stufe":1,"Wert":390,"WertNNM":11.861},{"Stufe":2,"Wert":430},{"Stufe":3,"Wert":510}],
   "Pegelstaende":[{"Datum":"/Date(1790197200000+0000)/","DatumUTC":"/Date(1790193600000)/","Wert":121}, …95 values]}]}]}}
```

- Relevant stations (`STA_ID` / number):

  | River | Station | STA_ID | Number | Note |
  |---|---|---|---|---|
  | Vechte | Ohne | 465 | 9286106 | |
  | Vechte | Wehr Neuenhaus | 111 | 9286127 | |
  | Vechte | **Emlichheim** | 258 | 9286162 | last before NL |
  | Dinkel | Lage I | 388 | 9286136 | |

  Hase gauges also exist (Bokeloh 201, Herzlake 328, Haselünne 310, …). The lower Ems is WSV (PEGELONLINE) and is **not** in the public API.
- History: **max 30 days**. A request for `-45` returned 2,886 values from 2026-08-24 to 2026-09-23. The manual points to www.wasserdaten.niedersachsen.de for older or verified data (**UNVERIFIED**, not called).
- Timestamps:
  - `DatumUTC` = true UTC epoch ms. 1790193600000 is 2026-09-23T20:00Z.
  - `Datum` = the same instant **+1 h (MEZ) mislabelled `+0000`**. Do not use it.
  - The frontend string `AktuellerMesswert_Zeitpunkt` "23.09.2026 21:45" is local legal time.
- Other pitfalls:
  - **`Latitude`/`Longitude` are swapped**, and `WGS84Rechtswert` holds the latitude.
  - Datum is labelled "NN + x m" (legacy NN label; the actual system is not stated).
  - Results are ordered newest first.
  - `-888` is the no-data sentinel.
  - The web frontend itself uses a different API (`/PegelonlineNeu/REST/…?subscription-key=…`, with the key embedded in JS). **Do not use it; use the documented public API.**
- **Licence conflict.**
  - The manual says: *"Die Quelle www.pegelonline.nlwkn.niedersachsen.de muss bei Verwendung der Services immer angegeben werden."*
  - But `/Impressum` says: *"Es ist weder gestattet, die bereitgestellten Daten … zu kommerziellen Zwecken zu nutzen, … an Dritte weiterzugeben oder sie in elektronische Systeme einzuspeichern."*
  - The footer adds: *"Vervielfältigung nur mit unserer Genehmigung"*.
  - **Get written confirmation from HWVZ@nlwkn.niedersachsen.de before go-live.**

---

## 6. Rheinland-Pfalz: LfU (hochwasser.rlp.de)

### 6.1 Frontend API (internal)

The SPA (axios base `/api/v1`) calls these; `robots.txt` is empty.

| GET | Content |
|---|---|
| `https://www.hochwasser.rlp.de/api/v1/index` (2.9 MB) | `createDate`, 46 alert regions, **292 measurement sites × 48 h of 15-min W** |
| `…/api/v1/config` (286 KB) | site master data (`number`, `name`, `easting`/`northing` in EPSG:25832, `elevation`, `rivers`), operators, legends |
| `…/api/v1/measurement-site/{number}` | W/Q for 5 d + **probabilistic forecast p10–p90** + historical floods + `downloadUrl` |
| `…/api/v1/status-report`, `/alert-region/{id}`, `/river-area` | situation reports |

```
GET https://www.hochwasser.rlp.de/api/v1/measurement-site/25400750      (Nahe, Bad Kreuznach)
{"W":{"xLast":"2026-09-23T20:00:00Z","yLast":240,"measurements":[{"y":240,"x":"2026-09-18T20:00:00Z"}, … 481],
      "predictions":{"p10":[…46],"p50":[…],"p90":[…],"time":"2026-09-23T18:00:00Z","nextUpdateTime":"2026-09-23T23:15:00Z"}},
 "Q":{"measurements":[]},
 "extremeevents":{"W":[{"date":"1981-12-31T23:00:00Z","value":780,"dimension":"cm","confirmed":1}, …]},
 "downloadUrl":"https://geodaten-wasser.rlp-umwelt.de/wasserstand/2540075000/download"}
```

- Timestamps are ISO **UTC `Z`**, which is clean.
- The index also carries foreign operators' data (DREAL Grand Est, LANUK, WSA, Luxembourg, SPW). **Rights for those belong to the original operators.**
- Relevant stations:
  - Nahe: Heimbach Bhf., Oberstein 2, Kallenfels, Martinstein 2, Boos, **Bad Kreuznach**, Dietersheim, Altenbamberg (Alsenz)
  - Lahn: Diez, Kalkofen (WSA)
  - Sieg: Betzdorf, Etzbach

### 6.2 Messdatenauskunft CSV (geodaten-wasser.rlp-umwelt.de)

```
GET https://geodaten-wasser.rlp-umwelt.de/api/export/messstellen_wasserstand_messwerte.csv?w=messstellennummer%3D2540075000
  -> 403 (nginx) without a Referer; 200 text/csv with "Referer: https://geodaten-wasser.rlp-umwelt.de/wasserstand/2540075000/download"
Messstellennummer;Messstellenbezeichnung;Datum;Wasserstand in cm
2540075000;Bad Kreuznach;24.06.2026 22:15;245
…
2540075000;Bad Kreuznach;23.09.2026 21:00;240
2540075000;Bad Kreuznach;23.09.2026 21:15;-        <- future slots padded with "-"
GET …/api/data/messstellen_wasserstand_stammdaten?w=messstellennummer%3D2540075000
[{"messstellennummer":2540075000,"pegelname":"Bad Kreuznach","gewaesser":"Nahe","ezg":3424.96,"rechtswert":417852,
  "hochwert":5522038,"nullpunkt":"96,534 (DHHN2016)","pegelart":"Sonderpegel", …}]
```

- Export paths (from the SPA): `messstellen_wasserstand_messwerte` (**90 days** of W), `…_abfluss` (90 d Q), `…_messwerte_mittel` / `…_abfluss_mittel` (**3 years** of daily means, raw), `…_hauptwerte`.
- Pitfalls:
  - A **Referer check** blocks non-browser clients. This is deliberate hot-link protection, so it is a ToS red flag.
  - The CSV time has no zone. The last value of 21:00 matches the API's 20:00Z, which **implies MEZ (UTC+1)**. This is inferred, not documented.
  - Station IDs differ between systems: 8 digits (`25400750`) in hochwasser.rlp.de and 10 digits (`2540075000`, with "00" appended) in geodaten-wasser.
- **Licence:** the Impressum (`/static/shared/partials/impressum.phtml`) says: *"Alle … Daten sind urheberrechtlich geschützt. Sie dürfen nur mit Zustimmung des LfU verändert, vervielfältigt, … oder zu öffentlichen Wiedergaben verwendet werden. Als Quelle ist das LfU zu nennen."* GovData lists only station layers (WMS, cc-zero / dl-by-de) and no measurement dataset. **LfU permission is required.**

---

## 7. Hessen: HLNUG (WISKI-Web)

- Portal: https://www.hlnug.de/static/pegel/wiskiweb3/webpublic/ (the bare `/wiskiweb3/` returns 403). Data root: `https://www.hlnug.de/static/pegel/wiskiweb3/data/`. It is the same KISTERS structure as NRW, with `site_no` = `0`.

| GET | Content |
|---|---|
| `…/data/internet/layers/10/index.json` (151 KB) | latest W, 188 stations. Layer 20 is Durchfluss (Q); layer 16 is Vorhersage |
| `…/data/internet/stations/stations.json` (532 KB) | 336 stations, incl. `GAUGE_DATUM` (e.g. Leun "134.99" m) |
| `…/data/internet/stations/0/{station_no}/W/week.json` | 7 d of 15-min W (`15.P`) + forecast `vhs.60` (to about +24 h) + `abs.60`/`nor.60` (to about +7 d) |
| `…/data/internet/stations/0/{station_no}/Q/week.json` | same for Q (m³/s) |
| `…/data/internet/stations/0/{station_no}/W/year.json` | **daily mean/min/max for the whole period of record** (Leun: from 1995-01-01; 1.3 MB) |

```
GET https://www.hlnug.de/static/pegel/wiskiweb3/data/internet/layers/10/index.json
{"ts_id":9605010,"timestamp":"2026-09-23T21:00:00.000+01:00","ts_value":41,"station_latitude":49.638812,
 "station_longitude":8.766926,"station_no":"23940359","station_name":"Fahrenbach","stationparameter_name":"W",
 "ts_shortname":"15m.Cmd.RelAbs.P","ts_unitsymbol":"cm","ts_path":"0/23940359/W/15m.Cmd.RelAbs.P",
 "WTO_OBJECT":"Weschnitz","BODY_RESPONSIBLE":"RPU Darmstadt","Vorhersagepegel":"no"}
GET …/stations/0/25800200/Q/week.json -> "15.P" m³/s 757 rows [["2026-09-16T00:00:00.000+01:00",7.37] … ["2026-09-23T21:00:00.000+01:00",6.16]]
```

- Relevant stations:
  - Lahn: Feudingen, Biedenkopf, Sarnau, Marburg, Gießen, Leun (WSV), Limburg, Diez, Kalkofen
  - Kinzig (Main tributary): Sannerz (stale), Steinau, Ahl, Gelnhausen, Hanau, Hanau-Mündung
  - Also Nidda, Fulda, Eder, Dill, Weil
- Refresh: Last-Modified moved from 20:08:50 to 20:23:44 UTC, so about every 15 min. An ETag is present.
- Timestamps: fixed **`+01:00`**. The config also states `"Zeitbezug":"MEZ"`.
- **Licence:** the portal's own download component config says: *"Sofern nicht anders angegeben, stehen alle Inhalte und Dateien in diesem Downloadbereich unter der Lizenz Creative Commons Namensnennung 4.0 International (CC BY 4.0 …). Bei der Vervielfältigung … müssen Sie den Namen des Erstellers wie folgt angeben: „Hessisches Landesamt für Naturschutz, Umwelt und Geologie (HLNUG)“. Zudem müssen Sie einen Link zur Lizenz beifügen und angeben, ob Änderungen vorgenommen wurden."*
  - The downloads are generated from the same `week.json`/`year.json` files, but the JSON paths themselves are undocumented.
  - WSV-operated gauges (e.g. Leun, Kalkofen) are excluded from the HLNUG download filter. Take those from PEGELONLINE.

---

## 8. Baden-Württemberg: LUBW HVZ

- Portal: https://www.hvz.baden-wuerttemberg.de/ (identical content at hvz.lubw.baden-wuerttemberg.de).
- Data is published as **JavaScript array files**:

| GET | Content |
|---|---|
| `https://www.hvz.baden-wuerttemberg.de/js/jf-data-def-peg.js` | column positions (`STM_*`, `DB_*`) |
| `…/js/jf-data-stm-peg.js` (139 KB) | 333 stations: DASA id, name, river, catchment, **NP (PNP)**, HW/MQ statistics, UTM x/y, **GL/GB (lon/lat)** |
| `…/js/jf-data-db-peg.js` (40 KB) | **latest W and Q** per station, regenerated about every 5 min ("Stand" 21:20:04 → 21:25:04 MEZ) |

```
// jf-data-db-peg.js		| Stand: 23.09.2026 21:20:04 MEZ
JF.DATA.PEG.DB = [
['00111','23.09.2026 22:15 MESZ','14','','cm','23.09.2026 22:15 MESZ','2.14','+0.02','m³/s',0,'140',1,1,0,…],   // Murg, Bad Rotenfels
['09056','23.09.2026 22:00 MESZ','382.23','+2','müM', …],                                                    // Neuhausen (CH) – W in m ü.M.!
```

- Relevant stations:
  - Kinzig: Schenkenzell 00200, Wolfach, Hausach, Biberach, **Schwaibach 00002**
  - Murg: Baiersbronn, Schwarzenberg, Forbach, **Bad Rotenfels 00111**, Rastatt
  - Upper Neckar: Rottweil 00146, Oberndorf, Horb, Kirchentellinsfurt, Wendlingen, Plochingen
- **Only the latest value is published.** Per-gauge history exists only as GIF charts (`gifs/…`). The UDO data service (udo.lubw.baden-wuerttemberg.de) is interactive; no API was found.
- Pitfalls:
  - Time strings are local, with a "MESZ" suffix, while the file header says "MEZ".
  - The HTTP `Last-Modified` header is **2 h behind real UTC** (18:25 GMT for a file built at 20:25 UTC).
  - Units are mixed (`cm`, `m`, `müM`).
  - Files are UTF-8 even though the HTML is old-style.
  - One gauge showed a **future** timestamp (Neuenbürg 23:15 MESZ at 22:25).
- **Licence:** the Impressum says *"Alle … Daten sind urheberrechtlich geschützt. Sie dürfen nur mit Zustimmung der LUBW … zu öffentlichen Wiedergaben verwendet werden. Als Quelle ist die LUBW zu nennen."* This is scraping of JS with **consent required** (contact Pegelinfo@lubw.bwl.de).

---

## 9. Bayern: LfU, GKD and HND

- **GKD** (https://www.gkd.bayern.de): station pages have HTML tables. Download page, e.g. `/de/fluesse/wasserstand/bayern/schwuerbitz-24006007/download`: *"Datenbestand vom 01.11.1963 bis zum 23.09.2026 … Die Zeichenkodierung der Downloaddatei ist ISO 8859-1. Diese Daten sind lizenziert unter einer Creative Commons Namensnennung 4.0 International Lizenz"*.
  - Downloads run through `POST /de/downloadcenter/enqueue_download` with a deeplink or e-mail. **robots.txt disallows** `/webservices/`, `/de/downloadcenter/enqueue_download` and `/de/downloadcenter/download`.
  - The terms checkbox links to the Impressum ("nur zum privaten und sonstigen eigenen Gebrauch … Veröffentlichung nur mit unserer Einwilligung"). This contradicts the CC BY 4.0 statement.

```
GET https://www.gkd.bayern.de/de/fluesse/wasserstand/bayern/schwuerbitz-24006007/messwerte?beginn=22.09.2026&ende=23.09.2026
<table> Datum | Wasserstand [cm]
        23.09.2026 22:15 Uhr | 145      (local legal time, inferred)
        23.09.2026 22:00 Uhr | 144 …
```

- **HND** (https://www.hnd.bayern.de/pegel/…) is HTML pages with PNG charts (`/webservices/graphik.php?statnr=…`). It has about 820 gauges; relevant ones are in `oberer_main_elbe` (Schwürbitz, Mainleus, Kemmern, Unterlangenstadt…), `regnitz` and `unterer_main` (Wolfsmünster/Fränk. Saale, Mittelsinn…). It has 18-h forecasts and ensemble trends.
- **LfU WMS** `https://www.lfu.bayern.de/gdi/wms/wasser/pegel?` covers station locations only. Licence: *"CC BY-SA 4.0; Datenquelle: Bayerisches Landesamt für Umwelt, www.lfu.bayern.de"* (via WebFetch of the LfU service page).
- Assessment: there is no machine interface. The Main itself is covered by PEGELONLINE. The Bavarian tributaries are far from NL, so they are a low priority.

## 10. Saarland: LUA

**UNVERIFIED.**
- `https://www.saarland.de/…/wasserstaende_warnlage_node.html` returned **403 with a Bunny Shield JavaScript challenge**, both via curl and WebFetch.
- The legacy `https://umweltserver.saarland.de/extern/wasser/Daten.js` still responds, but the data is **frozen at 23.02.2023** (dead). Example: `Pegel(408,411,'1062220','1','Reinheim','Blies',' 144','23.02.2023  6:00','  +1');`.
- LHP has 24 SL gauges, class only (Blies: Alsfassen, Ottweiler, Neunkirchen, Blieskastel, Reinheim).
- The Saar itself is PEGELONLINE/WSA. Blies at Bliesbruck/Frauenberg is DREAL Grand Est, so it is covered by the France report.

---

## 11. Cross-cutting normalisation notes

**Time zones.** Normalise everything to UTC at ingest.

| Source | Timestamp format | Zone |
|---|---|---|
| LANUK, HLNUG, OpenHygon | ISO with offset | fixed `+01:00` |
| WVER | ISO with offset | `+02:00` (true local) |
| RLP API | ISO | `Z` |
| NLWKN | `/Date(ms)/` | `DatumUTC` only is correct |
| BW | strings with "MESZ" | local |
| LHP features, GKD HTML, RLP CSV | no zone | naive local (LHP/GKD) or MEZ (RLP CSV, inferred) |

**Units.** All W is in cm relative to gauge zero, except some BW rows in m or m ü.M. Q is in m³/s.

**Datum.** PNP is available from:
- NRW: `Nullpunkt`, DHHN2016
- RLP: `nullpunkt "96,534 (DHHN2016)"`
- HE: `GAUGE_DATUM` (system not stated)
- NI: `Hoehe`, labelled "NN"
- BW: `NP`

Absolute heights (m NHN) are feasible but need per-source datum checks.

**Duplicates.** WSV gauges appear in the NRW (`site_no` 102), NLWKN frontend, RLP and HLNUG feeds, and NRW gauges appear in RLP (Sieg) and WVER. Keep one canonical source per physical gauge, with PEGELONLINE taking precedence for WSV gauges.

**Rate limits.** None are documented for any service. Keep polling to 5–15 min per bulk file; one bulk snapshot per state is enough. LHP asks clients to use ETag.

---

## 12. Open questions for the product owner

1. Will the site be **commercial** (ads, paid tiers)? This decides how far we can rely on NLWKN (Impressum ban on commercial use), LANUK's legacy "Nutzungsvereinbarung" paragraph and GKD.
2. Water level only, or **discharge** too? NRW publishes no real-time Q; HE, RLP and BW do.
3. Show cm relative to gauge zero, or absolute m NHN / NAP-comparable heights? The latter needs a datum table per gauge.
4. Is it acceptable to e-mail agencies for written permission (NLWKN, LfU RLP, LUBW, LfU BY, LUA SL) as a phase-0 task?
5. What time step does the date/time selector need? 15 min matches most sources.

---

## Recommendation for phase planning

### MVP (first release)

1. **NRW LANUK.** Poll `https://www.hochwasserportal.nrw/data/downloads/messwerte.zip` every 15 min (it refreshes about every 5 min).
   - It is an official, **DL-DE-Zero-2.0** file with 7 days of history, so gaps from short outages self-heal.
   - Optionally use `layers/10/index.json` as a lighter latest-value snapshot with thresholds.
   - Load master data once from opengeodata (`OpenHygon-Pegel-Stationen_EPSG4326.txt`, `Hydrologische-Stationen-NRW…CSV` for PNP/DHHN2016).
   - This alone covers Rur, Wurm, Niers, Schwalm, Issel, Bocholter Aa, Berkel, Dinkel, upper Vechte and upper Ems. Those are the German tributaries that matter most for "water flowing into NL".
   - Attribution (courtesy, since DL-Zero requires none): "Datenquelle: LANUK NRW, Hochwasserportal.NRW".
2. **NLWKN public API** for Vechte (Ohne, Wehr Neuenhaus, Emlichheim) and Dinkel (Lage I). Poll `station/{id}/…/tage/-1` every 15 min for 4–6 stations. Credit "www.pegelonline.nlwkn.niedersachsen.de". **Blocker risk:** the Impressum conflict. Request written OK now; if it is refused, drop these stations or show only LHP classes.
3. **Optional: LHP PublicAPI** (CC BY 4.0) as a nationwide flood-class and warning overlay. It gives state context (Nahe, Lahn, Neckar…) at zero licence risk but has no values. Show "Datenquelle: www.hochwasserzentralen.de" and "Stand: …".

### Phase 2 (after MVP)

- **Hessen HLNUG**: Lahn and Kinzig, W+Q plus forecasts, CC BY 4.0 for downloads. Mind that the JSON paths are undocumented; ask HLNUG to confirm automated retrieval. Skip WSV-owned gauges.
- **Backfill**:
  - NRW opengeodata `hydro/w` and `hydro/q`: verified, decades deep, DL-Zero. Requires resampling the irregular timestamps.
  - NRW `pegeldaten.zip`: 2 months of 15-min data and 2 years of daily values.
  - HLNUG `year.json`: daily values since about 1995.
  - NLWKN: only 30 days online; older data needs wasserdaten.niedersachsen.de (unverified).
  - GKD Bayern: from 1963, CC BY 4.0, but only through the human download centre. Ask LfU for bulk access rather than automating it.

### Later / only with written permission

- **RLP LfU** (Nahe; excellent API with p10–p90 forecasts) and **LUBW** (Kinzig, Murg, upper Neckar). Both need consent under their Impressum. RLP's CSV export has Referer hot-link protection.
- **WVER**: extra Rur tributaries and NL cross-border gauges. CC BY-SA 4.0, so check the ShareAlike implications.
- **Ruhrverband / other Verbände**: HTML only.
- **Saarland**: currently unreachable. Rely on LHP classes and the France/Vigicrues data for the Blies.

### Risks

- **Licensing.** Only LANUK (DL-Zero) and the LHP API (CC BY 4.0) are unambiguous. NLWKN and GKD contradict themselves. RLP and BW require consent.
- **Undocumented endpoints.** The KISTERS WISKI-Web and SPA JSON can change without notice when vendors update (the asset hashes show frequent deploys). Put each source behind its own adapter, with health checks and staleness alarms.
- **Time handling.** There are at least 5 different conventions, including mislabelled offsets (NLWKN `Datum`, BW header versus values). Unit-test the parsers against known instants.
- **Data quality.** Expect placeholder or duplicate IDs (NRW `1234567`, `1234512345`), stale gauges, swapped coordinates (NLWKN), future timestamps (BW) and `-`/`NA`/`-888` sentinels.
- **No real-time discharge in NRW.** If the product needs Q for the Rur/Niers corridor, it must come from the Dutch side or from WVER.
- **Access fragility.** Bot protection (saarland.de, RLP Referer check) and proxy-level connection resets (server.wver.de) show that scraping-based sources can disappear. Don't make the MVP depend on them.

**Sources:**
- [LHP developers](https://www.hochwasserzentralen.de/developers/)
- [Hochwasserportal.NRW](https://www.hochwasserportal.nrw/webpublic/)
- [opengeodata.nrw.de hygon](https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hygon/)
- [opengeodata.nrw.de hydro](https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hydro/)
- [GovData CKAN API](https://www.govdata.de/ckan/api/3/action/package_search?q=hygon)
- [WVER Pegelstände](https://wver.de/pegelstaende/)
- [Niersverband Daten](https://www.niersverband.de/gewaesser/pegelwesen/daten)
- [NLWKN Webservice manual](https://www.pegelonline.nlwkn.niedersachsen.de/pdf/BenutzerhandbuchWebservicePegelonline.pdf)
- [hochwasser.rlp.de](https://www.hochwasser.rlp.de/)
- [HLNUG WISKI-Web](https://www.hlnug.de/static/pegel/wiskiweb3/webpublic/)
- [LUBW HVZ](https://www.hvz.baden-wuerttemberg.de/)
- [GKD Bayern](https://www.gkd.bayern.de/)
- [HND Bayern](https://www.hnd.bayern.de/pegel)
- [LfU Bayern Pegel WMS](https://www.lfu.bayern.de/umweltdaten/geodatendienste/index_detail.htm?id=1e21731e-b21d-4a3d-b9a3-bc8fa8ac8871&profil=WMS)
- [Saarland Hochwassermeldedienst](https://www.saarland.de/mukmav/DE/portale/wasser/informationen/hochwassermeldedienst/wasserstaende_warnlage)
- [Ruhrverband Online-Daten](https://www.talsperrenleitzentrale-ruhr.de/online-daten)