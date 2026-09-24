# Netherlands: Rijkswaterstaat (RWS) water level and discharge data

Research date 2026-09-23. Every endpoint below was called live with curl between about 19:50Z and 20:10Z unless it is marked UNVERIFIED. I made roughly 60 requests with small periods and filters.

---

## 0. TL;DR

- **The classic `waterwebservices.rijkswaterstaat.nl` has been retired.** Every path now answers `301` to `https://rijkswaterstaatdata.nl/projecten/waterwebservices-overschakeling/`, and that page returns `404`. RWS announced that the old services were "definitief uitgezet" on 30 April 2026. The new services went live on 5 Dec 2025, and the back-end is called WADAR.
- **The current REST API is `https://ddapi20-waterwebservices.rijkswaterstaat.nl`.** It is POST with JSON, needs no auth (`X-API-KEY` is optional and only identifies the caller), is licensed CC0, and has an OpenAPI 3.1 spec at `/webservices-api-docs`.
- **The current OGC service is GeoServer `https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wfs` (also `/ows` and `/wms`).** The layer `DDAPI20:locatiesmetlaatstewaarneming` returns the latest value of every series with coordinates. One filtered GeoJSON request of about 235 KB gives all ~319 live NL water-level stations and ~109 discharge stations. It sends CORS `*` and supports gzip.
- **River water level uses** `Compartiment OW` / `Grootheid WATHTE` / `Hoedanigheid NAP` / `Eenheid cm` / `ProcesType meting`, and for automatic stations `WaardeBepalingsMethode other:F007` (10-minute mean).
- **Discharge uses** `OW` / `Q` / `Hoedanigheid NVT` / `m3/s` / `meting`. The method code varies by station: F230, F006, F103 or F216.
- **Cadence and delay.** Values come every 10 minutes and appear about 20 minutes late in REST `OphalenWaarnemingen`. The WFS is about 10 minutes behind REST, and `OphalenLaatsteWaarnemingen` can lag 1–2 values. Eijsden discharge is about 70–80 minutes late.
- **Forecasts** (`ProcesType verwachting`, method `RWSM-F232`) run about 34 hours ahead in 10-minute steps. They exist for 183 water-level locations and 13 discharge locations.
- **Astronomical tide** (`astronomisch`) is available at tidal stations through at least the end of 2027.
- **History reaches back a long way.** Lobith has daily readings in 1901 and hourly values in 1990 and 1995. A request is capped at 160,000 values, about 3 years of 10-minute data, and covers one location.
- **The biggest pitfalls I saw:**
  1. WFS timestamps are Dutch local wall-clock time but carry a `Z` suffix.
  2. The WFS can show an old value with a fresh timestamp.
  3. `OphalenLaatsteWaarnemingen` returns hundreds of stale historic series.
  4. Quality code `99` marks a gap and comes with the value `0.0`.
  5. Belgian TAW series duplicate the NAP series at Meuse border stations.
  6. The REST API sends no CORS headers and no gzip.
- **Regional rivers.** RWS publishes the Overijsselse Vecht (Holtheme, Ommen, Dalfsen) and the Geul (Epen). Dinkel, Berkel, Roer and Niers are water-board data. I found no documented open API from Vechtstromen or Waterschap Limburg. Rijn en IJssel exposes latest values through a public ArcGIS FeatureServer, but it has no licence or documentation.

---

## 1. What is live and what is retired (verified 2026-09-23)

| Host / service | Status | Evidence |
|---|---|---|
| `https://waterwebservices.rijkswaterstaat.nl/*` (old REST, `*_DBO` paths) | **Retired** | Any path returns `HTTP/2 301 location: https://rijkswaterstaatdata.nl/projecten/waterwebservices-overschakeling/`, which returns 404. The RWS updates list says: "30 april – Oude webservices worden definitief uitgezet". |
| `https://ddapi20-waterwebservices.rijkswaterstaat.nl/` (new REST, WADAR) | **Live** | Landing page "Welkom bij Wadar webservices". OpenAPI says `"version":"1.0","x-build-number":"2.64.2"`. |
| `https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES_DBO/...` | Does not exist | `404 {"detail":"No endpoint POST /ONLINEWAARNEMINGENSERVICES_DBO/OphalenLaatsteWaarnemingen."}` |
| `https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows` (and `/wfs`, `/wms`) | **Live** | GeoServer WFS 2.0.0 / 1.1.0 and WMS 1.3.0. |
| `https://geo.rijkswaterstaat.nl/services/ogc/hws/wmdc15/wms` (old "Landelijk meetnet water" WMS in the NGR record) | Retired | GetCapabilities returns 404. |
| `https://waterinfo.rws.nl/api/...` (internal JSON of the Waterinfo front-end) | Live but undocumented | See §4. Do not build on it. |
| `rijkswaterstaatdata.nl` (documentation site) | Changing | It becomes the "Centraal Toegangspunt Data (CTD)" on **5 Nov 2026** (public beta 14–23 Sep). Documentation URLs may move. UNVERIFIED whether the API hosts change; nothing announced says so. |

RWS incident log on https://rijkswaterstaatdata.nl/waterdata/ ("Updates"):
- 4–11 June 2026: no new measurements reached the webservices for about a week.
- 12 June: a limit of 100,000 series per request was introduced.
- 7 July: `OphalenLaatsteWaarnemingen` was reduced to 50,000 series.
- 22 July: a release caused Bad Requests and was rolled back.
- 24 Aug: planned maintenance.

The page also says: "De WaterWebservices kennen geen garanties voor uptime, en zijn daarmee niet geschikt voor kritieke toepassingen."

---

## 2. REST API: WaterWebservices (WADAR / DDAPI20)

### 2.1 General

| Item | Value (verified) |
|---|---|
| Base URL | `https://ddapi20-waterwebservices.rijkswaterstaat.nl` |
| OpenAPI 3.1 spec | `GET https://ddapi20-waterwebservices.rijkswaterstaat.nl/webservices-api-docs` (about 20 KB). The Swagger UI is at `/swagger-ui/index.html` and its config at `/webservices-api-docs/swagger-config`. `/v3/api-docs` returns 404. |
| Method / body | `POST`, `Content-Type: application/json` |
| Auth | None. The spec defines header `X-API-KEY` on every endpoint: *"Deze header is optioneel en wordt gebruikt om requests aan de aanvrager te koppelen"*. A request with an arbitrary key returned 200 as normal. I found no registration process. |
| CORS | **None.** `OPTIONS` returns 200 with an `Allow:` header but no `Access-Control-Allow-Origin`, and POST responses have no ACAO either. Browsers cannot call it directly, so a backend is required. |
| Compression | **None.** `Accept-Encoding: gzip` came back uncompressed; the catalogue was 1.6–4.8 MB on the wire. |
| Caching headers | `Cache-Control: no-cache, no-store` |
| No data | `204 No Content` with an empty body. |
| Errors | Bad date: `400` plain text `Het parsen van 'Begindatumtijd' is mislukt. Lever geldige waarden aan in het formaat 'yyyy-MM-dd'T'HH:mm:ss+01:00'`. Unknown location: `400` JSON `{"location":"Locatie 'doesnotexist' niet gevonden. Controleer of de locatiecode bestaat via OphalenCatalogus."}`. The two error formats are inconsistent. |
| Rate limits | No numbers are published and I got no 429s or rate-limit headers. The terms say: "Bij onredelijk gebruik van deze service kan Rijkswaterstaat genoodzaakt zijn uw toegang (tijdelijk) te beperken." Documented hard limits: **160,000 observations per request**, **100,000 series per request**, and **50,000 series for `OphalenLaatsteWaarnemingen`** (since 7 July 2026). |
| Endpoints | `POST /METADATASERVICES/OphalenCatalogus`, `POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, `POST /ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen`, `POST /ONLINEWAARNEMINGENSERVICES/OphalenActueleWaarnemingen` (undocumented; see §2.4), `POST /ONLINEWAARNEMINGENSERVICES/CheckWaarnemingenAanwezig` |

Casing: the OpenAPI schema names the key `aquoMetadata` in lower camel case, but the RWS examples and my calls use `AquoMetadata`, and that works. The response always uses `AquoMetadata`.

### 2.2 Metadata model (Aquo) and the combinations to use

Each time series is a unique combination of **location + AquoMetadata + WaarnemingMetadata**.

- **AquoMetadata** has these fields: Compartiment, Grootheid, Eenheid, Hoedanigheid, Parameter, Groepering, Typering, WaardeBepalingsMethode, WaardeBewerkingsMethode, MeetApparaat, BemonsteringsApparaat/-Methode/-Soort, BioTaxon, Orgaan, ProcesType.
- **WaarnemingMetadata** is returned per value: Statuswaarde, Kwaliteitswaardecode, OpdrachtgevendeInstantie, Bemonsteringshoogte, Referentievlak.
- `Parameter_Wat_Omschrijving` is built as `[WaardeBewerkingsMethode] [Typering] [Grootheid] [Parameter] [ProcesType unless meting] 'in' [Compartiment] [Hoedanigheid] 'in' [Orgaan] [BioTaxon] [Eenheid]`.

Combinations found in the live catalogue (`OphalenCatalogus`, 2026-09-23):

| Purpose | Compartiment | Grootheid | Hoedanigheid | Eenheid | ProcesType | Groepering | WaardeBepalingsMethode | #locations in catalogue |
|---|---|---|---|---|---|---|---|---|
| **River / inland / coastal water level (live, 10 min)** | `OW` | `WATHTE` | `NAP` | `cm` | `meting` | *(empty)* | `other:F007` ("Rekenkundig gemiddelde waarde over vorige 5 en volgende 5 minuten") | 416 |
| Water level, some ONXXREG stations (Vecht, Twentekanaal, Pannerden regelwerk) | OW | WATHTE | NAP | cm | meting | – | `other:F155` ("Waterhoogte over vorige 5 en volgende 5 min.(SEMON)") | 20 |
| Historic: hourly/10-min mean of previous 10 min | OW | WATHTE | NAP | cm | meting | – | `other:F001` | 152 |
| Historic: manual daily staff readings | OW | WATHTE | NAP | cm | meting | – | `other:F009` (visual) / `other:F029` (immersion 1 min) | 207 / 103 |
| Duplicate in Belgian datum (Meuse border) | OW | WATHTE | `TAW` | cm | meting | – | F007 | 8 |
| Offshore platforms | OW | WATHTE | `MSL` | cm | meting | – | F007 / F001 / F046 | 17 |
| Local datum | OW | WATHTE | `PLAATSLR` | cm | meting | – | F007 | 22 |
| **Water level forecast** | OW | WATHTE | NAP | cm | `verwachting` | – | `RWSM-F232` | 183 |
| **Astronomical tide (10-min curve)** | OW | WATHTE | NAP (MSL offshore) | cm | `astronomisch` | – | `other:F012` (harmonic analysis); `F227` at Knock | 98 |
| Astronomical high/low waters | OW | WATHTE | NAP | cm | astronomisch | `GETETBRKD2` (`GETETBRKDMSL2` for MSL) | F012 / F008 / F227 | 95 |
| Measured high/low waters | OW | WATHTE | NAP | cm | meting | `GETETM2` (`GETETMSL2`) | F009 / F010 / F029 | 135 |
| **Discharge (live)** | `OW` | `Q` | `NVT` | `m3/s` | `meting` | – | Varies by station: `F230` (Q-f relatie 2018: Lobith, Millingen, Pannerden), `F006` (afvoerkromme Q/H: Tiel, Olst, Westervoort.1, Borgharen), `F103` (Rek. gem. afvoer ±5 min, MSW90: Venlo, Megen, Sint Pieter, Ommen, Driel, Hagestein), `F216` (Q-f relatie: Eijsden), `F128` (ADCP), `F058` (interpolated), `F007` | 199 locations |
| **Discharge forecast** | OW | Q | NVT | m3/s | verwachting | – | `RWSM-F232` | 13 |

The 13 discharge-forecast locations are `arnhem.nederrijn, driel.boven, eijsden.grens, hagestein.boven, lobith.bovenrijn.tolkamer, maaseik, maastricht.borgharen.maas.beneden, maastricht.sintpieter, megen.maas, olst, tiel.sluis.waal, tiel.waal, venlo`.

Other points:
- The old special grootheden `WATHTEVERWACHT`, `QVERWACHT` and `WATHTBRKD` **no longer exist.** Forecasts and tides are now `WATHTE`/`Q` distinguished by `ProcesType` and `WaardeBepalingsMethode`.
- **River versus tidal stations cannot be told apart by metadata.** Both use `OW/WATHTE/NAP/cm/meting/F007`. Tidal stations additionally have `astronomisch` and `GETET*` series. The planning needs a curated station list per river.
- **`OpdrachtgevendeInstantie`** tells you which RWS unit or programme owns a series. Observed values include `RIKZMON_WAT` (national monitoring), `ONXXREG_WAT`/`ONXXREG_AFVOER`/`ONXXREG_HOOGWTR` (RWS Oost-Nederland), `LBXXREG_WAT`/`LBXXREG_AFVOER` (RWS Zuid-Nederland/Limburg), `RIZAMON_AFVOER`, `RIKZ_AFVOER`, `NBXX_INWAT`, `ZLXXREG_ZEGE`. There are 53 values in total.
- **`Kwaliteitswaardecode`**: Waterinfo shows only `["00","10","20","25","30","40"]`, and `"99"` means a gap. I saw 99-coded rows with value `0.0` (Driel Q, §9). Code 31 is no longer issued and became 25.
- **`Statuswaarde`**: `Ongecontroleerd` (live), `Gecontroleerd`, `Definitief`.
- **`Referentievlak`** in WaarnemingMetadata is mostly `NVT` even for NAP series, and sometimes `NAP`. Do not use it; use `Hoedanigheid`.
- **`Bemonsteringshoogte`** is `"0"` for live series and `"-999999999"` for archived series. The WFS also shows `-100000000000`. Treat these as sentinels.

### 2.3 Catalogue: `OphalenCatalogus`

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus \
  -d '{"CatalogusFilter":{"Compartimenten":true,"Grootheden":true,"Hoedanigheden":true,"Eenheden":true,"Groeperingen":true,"ProcesTypes":true,"WaardeBepalingsmethoden":true}}'
```

- The result was 200, 4.86 MB, in 5.4 s. With only `Compartimenten`+`Grootheden` it was 1.6 MB in 2.9 s.
- It returned **2,499 locations**, 1,502 AquoMetadata combinations and 61,870 links.
- There is **no location or bbox filter**, so fetch it once a day and cache it.
- Coordinates are ETRS89 (EPSG:4258) lat/lon. RWS says this can be treated as WGS84 for display. The OpenAPI example says `"RD"`, but the actual value is `"ETRS89"` for all 2,499 locations.
- You join the three lists via `AquoMetadata_MessageID` and `Locatie_MessageID`.

Trimmed response:
```json
{"Succesvol":true,
 "AquoMetadataLijst":[{"AquoMetadata_MessageID":1405,"Compartiment":{"Code":"OW","Omschrijving":"Oppervlaktewater"},
   "Eenheid":{"Code":"cm"},"Grootheid":{"Code":"WATHTE","Omschrijving":"Waterhoogte"},
   "Hoedanigheid":{"Code":"NAP","Omschrijving":"t.o.v. Normaal Amsterdams Peil"},"ProcesType":"meting",
   "WaardeBepalingsMethode":{"Code":"other:F007","Omschrijving":"Rekenkundig gemiddelde waarde over vorige 5 en volgende 5 minuten"},
   "Parameter_Wat_Omschrijving":"Waterhoogte in Oppervlaktewater t.o.v. Normaal Amsterdams Peil in cm"}, ...],
 "LocatieLijst":[{"Locatie_MessageID":10603,"Code":"4epetroleumhaven","Coordinatenstelsel":"ETRS89","Lat":51.953524,"Lon":4.140491,"Naam":"4e Petroleumhaven"}, ...],
 "AquoMetadataLocatieLijst":[{"AquoMetaData_MessageID":1405,"Locatie_MessageID":...}, ...],
 "OpdrachtgevendeInstantieLijst":["ONXXREG_AFVOER","RIKZ_AFVOER",...],
 "ReferentievlakLijst":["","SPRONGLG","ONB","MSL","BODM","NAP","NVT","WATSGL","HALVWTKL"],
 "StatuswaardeLijst":["Ongecontroleerd","Gecontroleerd","Definitief"]}
```

Catalogue counts: 663 locations have WATHTE meting, 199 have Q meting, 183 have WATHTE verwachting and 13 have Q verwachting.

An Excel version of the catalogue is announced on the RWS page but is still marked "nog niet beschikbaar".

**Location codes changed** from the old 4-letter codes (e.g. `LOBI`, `LOBH`) to dotted slugs (`lobith.bovenrijn.tolkamer`). Older station lists and tutorials are invalid. The RWS thresholds spreadsheet (§8) still lists both forms, e.g. "Lobith(LOBI)" and "lobith.bovenrijn.tolkamer".

### 2.4 Latest values for many stations in one call

**`OphalenLaatsteWaarnemingen`** works but returns a lot of stale data:

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen \
  -d '{"LocatieLijst":[{"Code":"lobith.bovenrijn.tolkamer"},{"Code":"eijsden.grens"},{"Code":"nijmegen.waal"}],
       "AquoPlusWaarnemingMetadataLijst":[
         {"AquoMetadata":{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"WATHTE"},"Hoedanigheid":{"Code":"NAP"}}},
         {"AquoMetadata":{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"Q"}}}]}'
```

- It returns the **last value of every series ever recorded**, including terminated ones. For 6 stations I got 85 series, some last updated in 1876, 1934 or 1947.
- For 40 key stations it returned **417 series, 675 KB, in 1.7 s**, with no gzip.
- The client must keep the newest `Tijdstip` per (location, Grootheid, Hoedanigheid) and filter `Kwaliteitswaardecode != "99"`.
- I also saw **two identical-looking series** for Lobith Q F230 with different last timestamps (2026-08-24 and 2026-09-23).
- `ProcesType` is ignored; only `meting` is returned.

Trimmed excerpt:
```json
{"Succesvol":true,"WaarnemingenLijst":[
 {"AquoMetadata":{"Grootheid":{"Code":"WATHTE"},"Hoedanigheid":{"Code":"NAP"},"Eenheid":{"Code":"cm"},
   "WaardeBepalingsMethode":{"Code":"other:F007"},"MeetApparaat":{"Code":"10042","Omschrijving":"other:Vlotterniveaumeter - type DNM"},"ProcesType":"meting"},
  "Locatie":{"Code":"lobith.bovenrijn.tolkamer","Coordinatenstelsel":"ETRS89","Lat":51.8495,"Lon":6.1024,"Naam":"Lobith, Bovenrijn, Tolkamer"},
  "MetingenLijst":[{"Meetwaarde":{"Waarde_Alfanumeriek":"627","Waarde_Numeriek":627.0},
    "Tijdstip":"2026-09-23T20:20:00.000+01:00",
    "WaarnemingMetadata":{"Bemonsteringshoogte":"0","Kwaliteitswaardecode":"00","OpdrachtgevendeInstantie":"RIKZMON_WAT","Referentievlak":"NVT","Statuswaarde":"Ongecontroleerd"}}]},
 {"...":"lobith ... WATHTE F029 ... Tijdstip 1934-12-31T08:40:00.000+01:00, Statuswaarde Definitief"}, ...]}
```

Known lag: RWS confirmed in GitHub discussion #57 that `OphalenLaatsteWaarnemingen` "in sommige situaties één of meerdere metingen achter kan lopen". I saw the same thing: at about 19:55Z it returned 20:20+01:00, while `OphalenWaarnemingen` already had 20:30+01:00. A fix was promised for v2.64, which is the current build, but the lag was still present.

**`OphalenActueleWaarnemingen`** is in the OpenAPI spec but undocumented. According to RWS in #57 it should return "de meest recente meting van actieve reeksen". **It returned `204 No Content` on all 7 of my attempts** with different bodies (WATHTE/Q, with and without Hoedanigheid or method filter, and the RWS temperature example). Discussion #57 also reports intermittent 204s. Treat it as UNVERIFIED and unusable for now.

### 2.5 Time series per station and period: `OphalenWaarnemingen`

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen \
  -d '{"Locatie":{"Code":"lobith.bovenrijn.tolkamer"},
       "AquoPlusWaarnemingMetadata":{"AquoMetadata":{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"WATHTE"},
                                                     "Hoedanigheid":{"Code":"NAP"},"ProcesType":"meting"}},
       "Periode":{"Begindatumtijd":"2026-09-23T19:30:00Z","Einddatumtijd":"2026-09-23T21:00:00Z"}}'
```

Trimmed response:
```json
{"Succesvol":true,"WaarnemingenLijst":[{"AquoMetadata":{"...":"WATHTE/NAP/F007"},"Locatie":{"Code":"lobith.bovenrijn.tolkamer",...},
 "MetingenLijst":[
  {"Meetwaarde":{"Waarde_Numeriek":627.0},"Tijdstip":"2026-09-23T20:30:00.000+01:00","WaarnemingMetadata":{"Kwaliteitswaardecode":"00","Statuswaarde":"Ongecontroleerd",...}},
  {"Meetwaarde":{"Waarde_Numeriek":628.0},"Tijdstip":"2026-09-23T20:40:00.000+01:00", ...},
  {"Meetwaarde":{"Waarde_Numeriek":628.0},"Tijdstip":"2026-09-23T20:50:00.000+01:00", ...}]}]}
```

- **One location per request.** `Locatie` is singular. You can combine only by leaving AquoMetadata broad.
- A 5-hour window for one series was about 6 KB and took about 0.6 s.
- Without `ProcesType` you also get forecasts, and without `Hoedanigheid` you also get TAW/MSL duplicates. Always send both, and use `OpdrachtgevendeInstantieLijst`/`KwaliteitswaardecodeLijst` in `WaarnemingMetadata` if needed.
- **Maximum per request: 160,000 values** (documented, "ca. 3 jaar aan 10-minuut gegevens"), and 100,000 series. I did not test the limit, to keep load low. The error it produces is UNVERIFIED.
- No pagination. You page by splitting `Periode`.
- Values are split into separate `WaarnemingenLijst` entries whenever any metadata changes (method, status, etc.), so concatenate and sort by `Tijdstip`.

### 2.6 `CheckWaarnemingenAanwezig`

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/CheckWaarnemingenAanwezig \
  -d '{"LocatieLijst":[{"Code":"vlissingen"}],"AquoMetadataLijst":[{"Compartiment":{"Code":"OW"},"Grootheid":{"Code":"WATHTE"},"ProcesType":"astronomisch"}],
       "Periode":{"Begindatumtijd":"2027-12-30T00:00:00.000+01:00","Einddatumtijd":"2027-12-30T23:00:00.000+01:00"}}'
# -> {"Succesvol":true,"WaarnemingenAanwezig":"true"}
```

It returns a string, "true" or "false". The body key is `AquoMetadataLijst`, not `AquoPlus...`.

### 2.7 Forecasts and astronomical tide

- **Water-level and discharge forecasts** use `ProcesType: "verwachting"` with method `RWSM-F232`.
  - Lobith Q forecast requested at about 19:57Z: 205 values at 10-minute steps from `2026-09-23T20:00+01:00` to **`2026-09-25T06:00+01:00`**, a horizon of about 34 h. The response was 60 KB.
  - Eijsden WATHTE forecast had the same end, `2026-09-25T06:00+01:00`.
  - RWS documents that forecasts are recalculated "elke 6 uur". I did not verify that cadence (UNVERIFIED).
  - **Past forecasts are archived, but only one value per timestamp** (checked for Nijmegen 2026-09-20 12:00–13:00: 7 values, one per 10 minutes). There is no issue or run time in the response. To keep a forecast-versus-observed history you must snapshot each run yourself.
  - RWS advises fetching the window from T−10 min to T+2 days.
  - Longer-range forecasts shown on waterinfo.rws.nl (fan or ensemble charts, e.g. `api/chart/getfan`) are **not** in the public API (UNVERIFIED beyond the internal JS routes).
  - Excerpt: `{"AquoMetadata":{"Grootheid":{"Code":"Q"},"ProcesType":"verwachting","WaardeBepalingsMethode":{"Code":"RWSM-F232"},"Parameter_Wat_Omschrijving":"Debiet verwachting in Oppervlaktewater in m3/s"},"MetingenLijst":[{"Tijdstip":"2026-09-25T06:00:00.000+01:00","Meetwaarde":{"Waarde_Numeriek":606.0},"WaarnemingMetadata":{"OpdrachtgevendeInstantie":"ONXXREG_AFVOER",...}}]}`
- **Astronomical tide** uses `ProcesType: "astronomisch"`, method `other:F012`, at 10-minute steps. For Vlissingen, 2026-12-31 returned `-104, -113, -121 …` cm NAP.
  - `CheckWaarnemingenAanwezig` returned **true for 2027-06-01 and 2027-12-30** and **false for 2028-06-01**, so tide data is available through the end of 2027.
  - High and low waters are available via `"Groepering":{"Code":"GETETBRKD2"}` (astronomical) and `GETETM2` (measured). Grouped data comes back only if you ask for the Groepering.

### 2.8 Timestamps and time zone

- **REST output is always ISO-8601 with milliseconds and a fixed `+01:00` offset (MET, no DST) all year.** Example in September: `2026-09-23T20:50:00.000+01:00` = 19:50Z = 21:50 CEST. Normalise to UTC on ingest. There is no DST ambiguity in REST.
- **Input** accepts any ISO offset. `Z` worked, as did `+01:00`. A malformed value gives the 400 message quoted in §2.1.
- **The WFS is different; see §3.4.**

### 2.9 Update cadence and latency

- Live WATHTE and most Q series come at **10-minute** intervals.
- Latency: at 20:10:06Z REST `OphalenWaarnemingen` already had 19:50Z for Lobith, about **20 minutes**. The WFS had 19:40Z. `OphalenLaatsteWaarnemingen` had 19:40Z at around 20:07Z.
- **Eijsden Q (F216)** had its last value at 18:50Z when checked at 20:07Z, about **75 minutes** late.
- Waterinfo shows 28 days back and 2 days ahead (documented).

### 2.10 History depth (for the later backfill phase)

For `lobith.bovenrijn.tolkamer` WATHTE:
- **1901-01-01..04**: 4 daily values at 08:40 (method F029, `Definitief`, 1123 cm).
- **1990-01-01 00–03h**: hourly (F001).
- **1995-01-31**: **hourly** values although the method is F007 (1655 cm, the 1995 flood peak).
- `CheckWaarnemingenAanwezig` was true for 1995, 2005 and 2010 with F007.

`OphalenLaatsteWaarnemingen` showed archived series ending in 1876 (Vlissingen F029) and 1934/1947 (Lobith daily).

Conclusions:
- History goes back to the 19th century for daily data.
- Sub-daily resolution varies over time even under the same method code. I did not determine exactly when true 10-minute data starts per station; it is UNVERIFIED and must be probed per station.
- The alternative bulk path is Waterinfo "Download historische data", which sends a CSV by email and has the same 160k limit.
- GitHub discussion #58 "Bulk historische data" was unanswered.

### 2.11 Fair use and support

The service is best effort with no SLA. Support goes through the RWS "Servicedesk Data" contact form and the GitHub discussions at https://github.com/Rijkswaterstaat/WaterWebservices/discussions, where RWS staff do answer (e.g. #57). Community clients named by RWS are Deltares `ddlpy` and PyPI `rws-waterinfo` (Python) and `wstolte/rwsapi` (R). I did not verify that they are up to date with the new API.

---

## 3. OGC WFS/WMS: `DDAPI20` (GeoServer)

### 3.1 Endpoints

- `https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wfs` (the `/ows` alias also works).
- GetCapabilities: `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities` returns 200, 95 KB. Fees and AccessConstraints are `NONE`, `CountDefault` is 1,000,000, and paging is supported.
- WMS: `https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wms?service=WMS&version=1.3.0&request=GetCapabilities` returns 200 with layers `locaties` and `locatiesmetlaatstewaarneming`.
- **Output formats**: `application/json`, `csv` (with `format_options=csvseparator:semicolon`), `SHAPE-ZIP`, `KML`, and GML2/3/3.2.
- **CRS**: the default is `urn:ogc:def:crs:EPSG::4258`. Others include 28992 (RD), 4326, 3857, 25831, 25832, 31370 (Belgian Lambert 72), 32631, 32632, 23031, 28402, 900913 and 3395. `srsName=EPSG:28992` and `EPSG:4326` both reprojected correctly.
- **CORS**: `Access-Control-Allow-Origin: *` (GET, OPTIONS, HEAD), so the browser can call it directly.
- **gzip**: supported (`Content-Encoding: gzip`).

### 3.2 Layers and fields

- `DDAPI20:locaties` has 19,003 features covering all monitoring networks, including chemistry and ecology sampling points. Fields: `LOCATIE_CODE, LOCATIE_NAAM, LOCATIE_OMSCHRIJVING, LOCATIE_TYPE`, geometry `LON_LAT`.
- `DDAPI20:locatiesmetlaatstewaarneming` has **941,735 features**: one per series, including every historic and chemical series. **Always filter.** Fields:
  - `WAARNEMING_ID, NAAM, CODE, OMSCHRIJVING`
  - `STATUSWAARDE, BEMONSTERINGSHOOGTE, REFERENTIEVLAK, OPDRACHTGEVENDE_INSTANTIE, KWALITEITSWAARDE_CODE`
  - `WAARDE_LAATSTE_METING` (decimal) and `TIJDSTIP_LAATSTE_METING` (**string**)
  - `PARAMETER_WAT_OMSCHRIJVING`
  - `COMPARTIMENTCODE, EENHEIDCODE, GROOTHEIDCODE, HOEDANIGHEIDCODE, WAARDEBEPALINGSMETHODECODE, GROEPERINGCODE` and the other Aquo codes
  - `GEOMETRY`

### 3.3 Recommended call: all current river levels and discharges in one request

```
GET https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature
  &TYPENAMES=DDAPI20:locatiesmetlaatstewaarneming&outputFormat=application/json
  &CQL_FILTER=COMPARTIMENTCODE='OW' AND GROOTHEIDCODE IN ('WATHTE','Q') AND TIJDSTIP_LAATSTE_METING > '2026-09-23T12:00'
  &PROPERTYNAME=CODE,NAAM,GROOTHEIDCODE,HOEDANIGHEIDCODE,EENHEIDCODE,WAARDEBEPALINGSMETHODECODE,WAARDE_LAATSTE_METING,
                TIJDSTIP_LAATSTE_METING,BEMONSTERINGSHOOGTE,OPDRACHTGEVENDE_INSTANTIE,KWALITEITSWAARDE_CODE,GEOMETRY
```
(URL-encode the CQL.)

- The result was **438 features: 319 WATHTE locations and 109 Q locations. It was 235 KB uncompressed and took 1.1 s.**
- `TIJDSTIP_LAATSTE_METING` is a string, but ISO string comparison works in CQL.
- `count=`/`startIndex=`/`sortBy=CODE` paging works. With a filter, `numberMatched` was 312 for WATHTE/NAP today.
- **Include `GEOMETRY` in `PROPERTYNAME`**, or the geometry comes back `null`.

Trimmed GeoJSON:
```json
{"type":"FeatureCollection","numberMatched":45,"numberReturned":45,"crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::4258"}},
 "features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[6.1024,51.8495]},
  "properties":{"CODE":"lobith.bovenrijn.tolkamer","NAAM":"Lobith, Bovenrijn, Tolkamer","GROOTHEIDCODE":"WATHTE","HOEDANIGHEIDCODE":"NAP",
   "EENHEIDCODE":"cm","WAARDEBEPALINGSMETHODECODE":"other:F007","WAARDE_LAATSTE_METING":627,
   "TIJDSTIP_LAATSTE_METING":"2026-09-23T21:30:00.000Z","KWALITEITSWAARDE_CODE":"00","OPDRACHTGEVENDE_INSTANTIE":"RIKZMON_WAT",
   "STATUSWAARDE":"Ongecontroleerd","BEMONSTERINGSHOOGTE":0}}]}
```

CSV excerpt, with `outputFormat=csv&format_options=csvseparator:semicolon`:
```
FID;WAARNEMING_ID;NAAM;CODE;...;WAARDE_LAATSTE_METING;TIJDSTIP_LAATSTE_METING;...;GEOMETRY
locatiesmetlaatstewaarneming.fid--...;5854;Lobith, Bovenrijn, Tolkamer;lobith.bovenrijn.tolkamer;...;627;2026-09-23T21:30:00.000Z;...;POINT (51.8495 6.1024)
```

### 3.4 WFS pitfalls I observed

1. **`TIJDSTIP_LAATSTE_METING` is Europe/Amsterdam wall-clock time labelled with `Z`.**
   - Summer: REST `2026-09-23T20:30+01:00` (19:30Z) appeared in the WFS as `2026-09-23T21:30:00.000Z`, which is in the future at the time of the call (about 19:58Z).
   - Winter: REST `2025-11-27T00:50+01:00` appeared as `2025-11-27T00:50:00.000Z`, which is CET.
   - Summer historic: REST `2010-08-31T18:00+01:00` appeared as `…19:00:00.000Z`, which is CEST.
   - So parse it as a local time in `Europe/Amsterdam` and ignore the `Z`. During the October DST fall-back hour the value is ambiguous.
   - The collection-level `timeStamp` attribute, by contrast, is correct UTC or has an explicit offset.
2. **An old value can appear with a fresh timestamp.**
   - WFS `driel.boven` Q showed `10.19` m³/s at "21:30Z" with quality `00`.
   - REST showed the true series for that period as `0.0` with `Kwaliteitswaardecode "99"`, a gap.
   - REST `OphalenLaatsteWaarnemingen` dated the last valid 10.19 to **2026-07-28**.
   - Cross-check key stations against REST, or run REST as the source of truth.
3. **About 10 minutes behind** REST `OphalenWaarnemingen`. The layer refreshed every 10 minutes during my session (21:30 then 21:40 local).
4. **Axis order**: GeoJSON is `[lon, lat]`; CSV/WKT is `POINT (lat lon)` (EPSG:4258 axis order).
5. **Stale and duplicate series** are included: every historic series, TAW duplicates, and 8-hour-old values. Filter on time, on `HOEDANIGHEIDCODE IN ('NAP','NVT')` and on the method.
6. **Suspicious values** at `pannerden.regelwerk.boven/beneden` (F155, `ONXXREG_HOOGWTR`): 1139–1143 cm NAP, while the adjacent river at `millingenaanderijn.pannerdensekop` was 600 cm. Exclude these, as they are probably structure-internal.

---

## 4. Waterinfo internal JSON API (for reference only; do not depend on it)

The waterinfo.rws.nl Angular bundle calls `/api/point/latestmeasurement?parameterId=…`, `/api/chart/get`, `/api/chart/getfan`, `/api/point/latestmeasurements`, `/api/bulkdatadownload/post` and others.

`GET https://waterinfo.rws.nl/api/point/latestmeasurement?parameterId=waterhoogte` returned 200, 220 KB:
```json
{"features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[656857.08,5733842.51]},
 "properties":{"name":"'s-Hertogenbosch Crevecoeur","measurements":[{"locationCode":"shertogenbosch.crevecoeur","latestValue":37.0,
 "dateTime":"2026-09-23T19:20:00Z","unitCode":"cm","qualityCode":"NAP","measurementColor":"#39870C","measurementLabel":"Normale waterstand"}]}}]}
```

It has correct UTC timestamps, EPSG:3857 coordinates and Waterinfo's colour class. It is undocumented with no terms, so use it only as inspiration for the colour classes.

---

## 5. Key river stations: codes checked against today's live data

Values are those seen 2026-09-23 around 19:30–19:50Z. "fc" means a forecast exists. Unless stated, level = `WATHTE/NAP/F007` and coordinates are ETRS89 lat, lon.

| River / role | Station | Location code | Lat, Lon | Live series (today's value) | Notes |
|---|---|---|---|---|---|
| **Rhine entry** | Lobith | `lobith.bovenrijn.tolkamer` | 51.8495, 6.1024 | WATHTE 628 cm; **Q F230 ~608–617 m³/s**; fc WATHTE+Q | Main entry gauge. `lobith.bovenrijn.haven` is another level gauge. |
| Bovenrijn / Waal start | Millingen a/d Rijn | `millingenaanderijn` | 51.87296, 6.03484 | Q F230 539 m³/s | |
| Pannerdensche Kop | Millingen, Pannerdense Kop | `millingenaanderijn.pannerdensekop` | 51.872, 6.0417 | WATHTE 600 cm | Use for the level at the split. |
| Pannerdensch Kanaal | Pannerden | `pannerden.pannerdenschkanaal` | 51.87475, 6.03778 | **Q F230 108 m³/s** | Level here is historic only (F029, last 2017). `pannerden.regelwerk.*`: see §3.4.6. |
| Waal | Nijmegen | `nijmegen.waal` | 51.853, 5.854 | WATHTE 417 cm, fc | `nijmegen` = historic daily readings only. |
| Waal | Dodewaard | `dodewaard` | 51.90051, 5.63052 | WATHTE 258–260, fc | |
| Waal | Tiel | `tiel.waal` | 51.88238, 5.44069 | WATHTE 161; **Q F006 543 m³/s**; fc WATHTE+Q | `tiel.sluis.waal` also has Q fc. |
| Waal | Zaltbommel | `zaltbommel` | 51.81515, 5.24465 | WATHTE 45, fc | No Q. |
| Nederrijn | Arnhem | `arnhem.nederrijn` | 51.97541, 5.91202 | WATHTE **stale** (last 07:50+01:00 today, q=25); Q F230 stale since Aug | Has Q fc. Unreliable today. |
| Nederrijn | Driel boven / beneden | `driel.boven` / `driel.beneden` | 51.96584, 5.81064 | WATHTE 583, fc; Q F103 **gap (code 99)** | Q fc exists. |
| Lek | Amerongen boven / beneden | `amerongen.boven` / `amerongen.beneden` | 51.9753, 5.4125 | WATHTE 583 / 163 | |
| Lek | Culemborg; Hagestein | `culemborg`; `hagestein.boven` / `.beneden` | 51.961, 5.214; 51.9895, 5.1352 | WATHTE; Hagestein Q F103 (−9 m³/s) | |
| IJssel split | Westervoort IJsselkop | `westervoort.ijsselkop` | 51.9507, 5.953 | WATHTE 583, fc; Q F230 **stale since 2025-11-27** | |
| IJssel | Westervoort 1 / 2 | `westervoort.1` / `westervoort.2` | 51.9705, 5.962 | **`.1`: Q F006 103.5 m³/s** (IJssel discharge); `.2`: WATHTE 547, fc | |
| IJssel | Doesburg | `doesburg.ijssel` | 52.01953, 6.13049 | WATHTE 338, fc | |
| IJssel | Zutphen | `zutphen.ijssel` | 52.154, 6.182 | WATHTE 136, fc | `zutphen` = historic only. |
| IJssel | Deventer | `deventer` | 52.25119, 6.15325 | WATHTE 38, fc | |
| IJssel | Olst | `olst` | 52.34201, 6.10448 | WATHTE 11; **Q F006 129 m³/s**; fc WATHTE+Q | |
| IJssel | Zwolle | `zwolle.ijssel` | – | WATHTE −10, fc | |
| IJssel mouth | Kampen | `kampen.ijssel` (also `kampen.keteldiep`) | 52.552, 5.9264 | WATHTE −18, fc | `kampen` Q is historic only. |
| **Meuse entry** | Eijsden grens | `eijsden.grens` | 50.758, 5.682 | WATHTE 4406 cm NAP (**plus TAW duplicate 4639**); **Q F216 47.6 m³/s (~75 min late)**; fc WATHTE+Q | |
| Meuse (BE) | Lixhe | `lixhebiefaval` | 50.75964, 5.68089 | WATHTE 4406 (updated 21:00 local) | Belgian site in the RWS network. |
| Meuse | Sint Pieter | `maastricht.sintpieter` | 50.83029, 5.69732 | WATHTE 4406 (+TAW); **Q F103 11.5 m³/s**; fc | `maastricht.sintpieter.zuid` Q F128 (ADCP). |
| Meuse | Borgharen | `maastricht.borgharen.maas.beneden` ("Borgharen Dorp") | 50.8724, 5.691 | WATHTE 3754; **Q F006 11.6–19.3**; fc | `borgharen.boven`/`.beneden` = historic manual readings only. `maastricht.borgharen.julianakanaal` = canal. |
| Meuse (border) | Lanaken | `lanaken` | 50.8895, 5.6831 | WATHTE 3615, fc | |
| Meuse | Stevensweert | `stevensweert` | 51.1311, 5.8417 | WATHTE 2098 (+TAW), fc | |
| Meuse | Roermond | `roermond.boven` | 51.2005, 5.9815 | WATHTE 1695, fc | `roermond.beneden` = historic. `roermond.hambeek` Q = small stream. |
| Meuse | Venlo | `venlo` | 51.36739, 6.15941 | WATHTE 1113; **Q F103 33.7 m³/s**; fc WATHTE+Q | Also `steyl`, `belfeld.boven`, `well` (live). |
| Meuse | Sambeek; Gennep | `sambeek.boven`/`.beneden`; `gennep` | 51.632, 6.004; 51.697, 5.957 | WATHTE, fc | |
| Meuse | Grave | `grave.boven` / `grave.beneden` | 51.761, 5.743 / 51.775, 5.72 | WATHTE 798 / 493, fc | |
| Meuse | Megen | `megen.maas` | 51.82783, 5.56309 | WATHTE 490; **Q F103 88.9 m³/s**; fc | |
| Meuse | Lith | `lith.boven` / `lith.beneden` ("Lith dorp") | 51.81, 5.455 / 51.8104, 5.4329 | WATHTE 491 / 41, fc | `lith` Q = historic only. |
| **Scheldt** (tidal) | Bath | `rilland.bath` | 51.39878, 4.21014 | WATHTE −161; astro; fc; GETET* | `bath.*` codes are sampling points without WATHTE. |
| Scheldt | Hansweert | `hansweert` | 51.44567, 3.99744 | WATHTE −125; astro; fc | |
| Scheldt | Terneuzen | `terneuzen` | 51.33621, 3.81981 | WATHTE −97; astro; fc | |
| Scheldt mouth | Vlissingen | `vlissingen` | 51.442, 3.6 | WATHTE −79; astro; fc | |
| Scheldt (BE) | Antwerpen | `antwerpen` | 51.228, 4.397 | WATHTE −218 (`ZLXXREG_ZEGE`) | |
| **Eems/Dollard** (tidal) | Delfzijl | `delfzijl` | 53.328, 6.931 | WATHTE 105; astro; fc | |
| Eems/Dollard | Nieuwe Statenzijl | `nieuwestatenzijl.dollard` | 53.23156, 7.20742 | WATHTE 96; astro; fc | |
| **Overijsselse Vecht** | Holtheme (Hardenberg) | `holtheme.vecht` | 52.62083, 6.69849 | WATHTE F155 915 cm | Operated by RWS Oost-Nederland. |
| Vecht | Ommen | `ommen.vecht` | 52.5171, 6.42192 | WATHTE F155 262; **Q F103 2.1 m³/s** | |
| Vecht | Dalfsen, Vechterweerd | `dalfsen.vechterweerd` | 52.5181, 6.21165 | WATHTE F007 −21 | |
| Vecht (border entry) | De Haandrik | `dehaandrik.boven` / `.beneden` | – | **historic only (last 2004)** | Current data is from the water board or the German side. |
| Geul | Epen, Cottessen | `epen.geul.cottessen` | 50.75815, 5.9343 | WATHTE 11967 cm NAP; Q F007 0.42 m³/s | Near the BE border. |

Belgian datum offset: at Eijsden and Sint Pieter the paired series gave **TAW − NAP = +233 cm** (4639 vs 4406). This is useful when merging with Belgian data, but I only observed it at those two stations.

Not in RWS: Emmerich, Wesel, Dinkel, Berkel, Roer, Niers, Regge (only historic `archem.benedenregge`), and Swalm.

---

## 6. River versus tidal and sea stations

- **Rivers (non-tidal)**: `WATHTE/NAP/meting/F007`, optionally `Q/NVT/meting/<station-specific method>`, plus a forecast (`verwachting`/`RWSM-F232`). No `astronomisch` series.
- **Tidal estuaries and coast** (Scheldt, Eems-Dollard, and the lower Rhine-Meuse delta such as Dordrecht and Krimpen): the same `WATHTE/NAP/meting/F007` plus `astronomisch/F012`, high/low-water groupings (`GETETM2`, `GETETBRKD2`) and forecasts. The 10-minute level oscillates about 3–5 m (Bath −161 cm today), so a "follow the flood downstream" visual will be dominated by the tide at these stations. Consider showing a tidal-mean or the surge (measured − astronomical) there.
- **Offshore** (Europlatform, K13a, D15, J6): `Hoedanigheid MSL`. Not relevant for rivers.

---

## 7. Regional rivers: water boards (waterschappen)

| River (NL part) | Water board | What I found | Open API? |
|---|---|---|---|
| Overijsselse Vecht | Vechtstromen (upstream, De Haandrik/Hardenberg) and Drents Overijsselse Delta (downstream) | **RWS publishes live Vecht levels** at `holtheme.vecht`, `ommen.vecht` (+Q) and `dalfsen.vechterweerd` (§5). Vechtstromen shows levels only in news items and a HydroNET embed viewer. Its ArcGIS Online account (`services1.arcgis.com/3RkP6F5u2r7jKHC9`) has structures such as "Stuwen" but no measurement feed. | **No documented open API found** (UNVERIFIED that none exists). |
| Dinkel, Regge | Vechtstromen | Same as above. No public time-series endpoint found. | No |
| Berkel, Oude IJssel, Slinge, Schipbeek, Baakse Beek | Rijn en IJssel (WRIJ) | The portal `https://waterdata.wrij.nl` ("KiMare") **reset the connection from this environment and WebFetch got 503**, so it is UNVERIFIED. **Verified**: public ArcGIS FeatureServer `https://opengeo.wrij.nl/arcgis/rest/services/WaterData/Nexus_P/FeatureServer/0/query` (the "Nexus puntenlaag bedoeld voor Hydrologie Dashboard", StellaSpark Nexus). It has 3,622 points with `WS_THEME` values such as `Waterstanden_539` (150), `Afvoeren_534` (81), `Waterstanden_rivier_539`, `Afvoeren_verw_534` and `Waterstandsverw_539`. Fields are `EVENT_VALUE` (m NAP or m³/s) and `EVENT_TIMESTAMP` (epoch ms), synced about every 30 minutes, with hourly values. Examples: `175_BOV` Verdeelwerk Haarlo Berkel, `28_BOV` Verdeelwerk Lochem Berkel, `101_TDB` Stuw De Pol Oude IJssel discharge 0.191 m³/s. RD New (EPSG:28992); `outSR=4326` works. | **Technically open, but no documentation, no licence text and described as an internal dashboard layer.** The timestamp semantics are UNVERIFIED: the RWS-Lobith mirror showed 6.28 m at "16:00Z" when the RWS value 628 cm was at 19:00Z. Ask WRIJ before using it. |
| Roer, Niers, Geul, Swalm, Jeker, Geleenbeek, Worm | Waterschap Limburg | `https://www.waterstandlimburg.nl` (map and app; location pages such as `/Home/Waterstanden/147` Roer Vlodrop, `/LocatieInfo/ONIER06_H` Niers) **returned 403 "The request is blocked"** to both curl and WebFetch. That looks like a WAF or geo-block; UNVERIFIED. Lizard lists an organisation "Waterschap Limburg" but it has **0 public timeseries**. RWS covers only `epen.geul.cottessen`. | **No documented open API found.** |
| Westerwoldse Aa (into the Dollard) | Hunze en Aa's | Not researched in depth. | – |

National standard: the **Digitale Delta API (DD-API v3)**, managed by Informatiehuis Water, won the "Gouden API 2026" on 21 Sep 2026. The endpoints IHW lists are AquaDesk (ecology), `ddapi-rws.ecosys.nl` (birds) and Aquon (sensors). I found **no public DD-API endpoint serving water-board water-quantity data** for these boards.

The Lizard platform (`demo.lizard.net/api/v4/organisations/`) lists all these boards, but anonymous access showed 0–48 old timeseries. It is not usable.

Recommendation: for the border tributaries, use the **German upstream gauges** (Vechte, Dinkel, Berkel, Niers, Rur/Roer on the NLWKN / NRW side, covered by other reports), plus the RWS Vecht stations. Contact Vechtstromen, WRIJ and Waterschap Limburg for a formal feed in a later phase.

---

## 8. Licence and attribution

- **WaterWebservices content: CC0.** Quote from https://rijkswaterstaatdata.nl/waterdata/: *"Op de inhoud van de WaterWebservices is de Creative Commons zero verklaring (CC0) van toepassing. Dit houdt in dat hergebruik van de inhoud van deze service is toegestaan, tenzij bij een bepaald onderdeel staat aangegeven dat een auteursrechtelijke uitzondering van toepassing is."*
- WFS/WMS GetCapabilities: `Fees NONE`, `AccessConstraints NONE`. The related NGR record states "Geen beperkingen" and tags the dataset **HVD (EU High-Value Dataset)**.
- The rijkswaterstaatdata.nl "Verantwoording" page asks, for reuse of **website** information, that you name the site as source and state the date.
- Suggested attribution (not legally required under CC0): **"Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/"**, plus a "not for flood-safety decisions" disclaimer echoing RWS's no-uptime-guarantee statement.
- Thresholds and colours as used on Waterinfo are in `https://rijkswaterstaatdata.nl/publish/pages/223004/grenswaarden-en-legendakleuren-zoals-gebruikt-op-waterinfo-15-4-2026-.xlsx` (495 KB, sheets `Uitleg` and `ParameterLimits`). It has classes such as "Normale / Verhoogde waterstand / Hoogwater / Extreem hoogwater" and "Normale / Verhoogde / Hoge / Extreme afvoer", and includes old and new location codes. This is useful for map colouring; licence as above.

---

## 9. Consolidated pitfalls (observed)

1. The old host and old tutorials (`*_DBO` paths, 4-letter codes like `LOBI`, `WATHTEVERWACHT`) are all dead or invalid.
2. REST sends no CORS headers and no gzip. A backend collector or proxy is mandatory, and the catalogue is 1.6–4.8 MB.
3. REST timestamps are fixed `+01:00` all year. WFS timestamps are local time mislabelled `Z`.
4. `OphalenLaatsteWaarnemingen` returns every historic series (417 series for 40 stations), includes duplicates, and lags 1–2 values. `OphalenActueleWaarnemingen` returned only 204s.
5. The WFS showed an old value with a fresh timestamp (Driel Q), is 941k features unfiltered, and uses lat/lon order in CSV.
6. Quality code `99` is a gap, served with the value `0.0`. Filter on quality code, never on value.
7. Omitting `ProcesType` mixes in forecasts. Omitting `Hoedanigheid` mixes in TAW, MSL and PLAATSLR duplicates.
8. The discharge method code differs per station, so do not filter Q on a single method.
9. Some headline gauges were stale or broken today: Arnhem level and discharge, Westervoort IJsselkop Q, Driel Q gap, and Pannerden regelwerk levels are implausible. Build per-series freshness checks and pick fallback stations (e.g. `westervoort.1` for IJssel Q).
10. Latency is about 20 minutes for levels and about 75 minutes for Eijsden Q, and the whole service had a week-long outage in June 2026.
11. Forecast archives keep only the latest value per timestamp, with no run ID.
12. Resolution of historic data changes over time (hourly in the 1990s at Lobith despite the F007 code).
13. The documentation site moves to "CTD" on 5 Nov 2026, so links may break.

---

## 10. Open questions for the product owner

1. **Discharge in the MVP?** RWS has live Q at only about 109 NL locations, some with stale or gap series. Should the map show Q only where it exists, or water level only in the MVP?
2. **Tidal stations** (Scheldt, Eems-Dollard, lower delta): show raw 10-minute levels, or a smoothed or surge-style value? Raw tidal swings will hide the river signal.
3. **Forecasts:** should the time slider extend into the future (about +34 h from RWS)? If yes, do you want to archive forecast runs, which RWS itself does not keep per run?
4. **Water-board rivers** (Dinkel, Berkel, Roer, Niers): is it acceptable to cover these only via German upstream gauges and RWS Vecht stations at first, and approach the water boards for a formal feed later?
5. **Target refresh rate:** is 10 minutes (with about 20–30 minutes latency) acceptable for "near-real-time"?

---

## 11. Recommendation for phase planning

**MVP (collect from go-live):**
- **Collector (server-side; REST has no CORS).**
  - **Primary: REST `OphalenWaarnemingen`** for a **curated list of about 60–80 river stations**, using the §5 codes. Each run is one request per station per grootheid (WATHTE/NAP/meting, and Q/meting where available) with `Periode = now−3h … now`. Run every 10 minutes and upsert on (code, grootheid, timestamp). That is about 100–150 small requests per 10 minutes, roughly 5 KB each.
  - The rolling window self-heals short collector outages and late-arriving values, has correct timestamps and gives the full 10-minute sequence. Send a stable `X-API-KEY` value identifying the project, which is optional, and consider telling the RWS Servicedesk about the load to stay within fair use.
  - **Secondary and discovery: WFS `locatiesmetlaatstewaarneming`** with the §3.3 CQL, one request of about 235 KB every 10 minutes. It gives all ~320 level and ~110 Q stations with coordinates for the "all stations" map layer. Parse the timestamp as `Europe/Amsterdam` local time, drop quality `99`, and treat any disagreement with REST as REST-wins.
  - **Do not** rely on `OphalenLaatsteWaarnemingen` (stale series, lag) or `OphalenActueleWaarnemingen` (204s) for the core loop.
- **Station registry:** cache `OphalenCatalogus` daily (ETRS89 coordinates). Keep a hand-curated mapping of station, river, downstream order and river-km, which the API does not provide. Classify tidal versus river by hand.
- **Normalisation:** store UTC. Convert cm NAP to m NAP if needed. Discharge is m³/s. Keep `Kwaliteitswaardecode`, `Statuswaarde` and the method code. Drop TAW/MSL/PLAATSLR duplicates.
- **Health monitoring:** alert on per-series staleness (for example over 60 minutes for levels and over 120 minutes for Eijsden Q). Poll the RWS "Updates" section or GitHub Discussions for announced changes.
- **UI:** use the RWS Waterinfo threshold spreadsheet for colour classes. Include the CC0 attribution and the "no guarantees / not for safety decisions" disclaimer.

**Phase 2:**
- **Forecasts:** every 6 hours pull `verwachting` for WATHTE (183 locations) and Q (13), about 34 hours ahead, and store them as runs keyed by your own fetch time.
- **Astronomical tide** for tidal stations, available through the end of 2027, so you can show the surge.

**Phase 3, historical backfill:**
- Use REST `OphalenWaarnemingen` per station in chunks of at most about 2.5 years of 10-minute data, staying under 160k values.
- Probe the start of true 10-minute resolution per station, which varies.
- Throttle, for example one request per second, and run off-peak.
- Alternatively use Waterinfo "Download historische data" (CSV by email).

**Phase 3+, regional data:**
- Negotiate feeds with Vechtstromen, Rijn en IJssel and Waterschap Limburg.
- Until then, use the German upstream gauges for Vechte, Dinkel, Berkel, Niers and Rur, and optionally the undocumented WRIJ ArcGIS feed only with WRIJ's consent.

**Risks:**
- **The API is young (live since Dec 2025) and has had real incidents**: a one-week data stall in June 2026, a July rollback and limit changes. It has no SLA.
- **Docs are moving** (CTD launch on 5 Nov 2026).
- **An undocumented endpoint** (`OphalenActueleWaarnemingen`) may be repaired or changed at any time.
- **Fair-use limits are unquantified.**
- **WFS timestamp and staleness bugs.**
- **Per-station data-quality gaps** (Arnhem, Driel, Westervoort today).
- **Tidal stations need special visual treatment.**
- **Water-board coverage has no open API.**

Mitigations: use REST as the source of truth with a rolling-window collector, keep fallback stations per river reach, add freshness alerts, and keep the collector configurable (endpoint URLs, station list and method codes in config).

---

### Sources
- [RWS Waterdata / WaterWebservices documentation, updates, CC0 statement](https://rijkswaterstaatdata.nl/waterdata/)
- [New API landing page (Wadar webservices)](https://ddapi20-waterwebservices.rijkswaterstaat.nl/), [OpenAPI spec](https://ddapi20-waterwebservices.rijkswaterstaat.nl/webservices-api-docs), [Swagger UI](https://ddapi20-waterwebservices.rijkswaterstaat.nl/swagger-ui/index.html)
- [DDAPI20 WFS GetCapabilities](https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities)
- [RWS WaterWebservices GitHub Discussions](https://github.com/Rijkswaterstaat/WaterWebservices/discussions), [#57 OphalenLaatsteWaarnemingen lag / OphalenActueleWaarnemingen](https://github.com/Rijkswaterstaat/WaterWebservices/discussions/57), [#42 transition issues](https://github.com/Rijkswaterstaat/WaterWebservices/discussions/42)
- [RWS "Preview dataportaal" (CTD launch 5 Nov 2026)](https://rijkswaterstaatdata.nl/preview-dataportaal/)
- [Waterinfo thresholds and colours xlsx (15-4-2026)](https://rijkswaterstaatdata.nl/publish/pages/223004/grenswaarden-en-legendakleuren-zoals-gebruikt-op-waterinfo-15-4-2026-.xlsx)
- [NGR metadata record (HVD, "Geen beperkingen")](https://www.nationaalgeoregister.nl/geonetwork/srv/api/records/68ebd5c9-0ea1-4f22-9907-ec4c06mcd3e2)
- [Informatiehuis Water – Digitale Delta API](https://www.ihw.nl/digitale-delta-api), [Gouden API 2026](https://www.digitaleoverheid.nl/nieuws/gouden-api-voor-slimme-waterdata-uitwisseling/)
- [Waterschap Limburg – Waterstanden in Limburg](https://open.waterschaplimburg.nl/waterstanden-in-limburg), [waterstandlimburg.nl](https://www.waterstandlimburg.nl/Home/Waterstanden) (403 from this environment)
- [WRIJ waterdata portal](https://waterdata.wrij.nl/index-data.html) (unreachable from this environment), [WRIJ Nexus FeatureServer](https://opengeo.wrij.nl/arcgis/rest/services/WaterData/Nexus_P/FeatureServer)
- [Vechtstromen public maps](https://kaarten.vechtstromen.nl/openbaar/), [GPRW data & kaarten](https://gprw.eu/nl/themas/data-en-kaarten)
- [Deltares ddlpy](https://github.com/Deltares/ddlpy), [rws-waterinfo (PyPI)](https://pypi.org/project/rws-waterinfo/)

Raw files from the live calls (catalogue, WFS and REST responses) are in `(research-session scratch files, not kept)`, for example `catalog.json`, `openapi.json`, `wfsall.json`, `last_many.json` and `fc1.json`.