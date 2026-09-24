# France: Hub'Eau Hydrométrie v2 and Vigicrues. Research report


All endpoints below were called live with curl on 2026-09-23 between 20:12 and 20:25 UTC, unless marked UNVERIFIED.

---

## 1. Hub'Eau Hydrométrie API v2 (main source for France)

### 1.1 General

| Item | Value (verified) |
|---|---|
| Base URL | `https://hubeau.eaufrance.fr/api/v2/hydrometrie/` |
| API version reported | `"api_version":"2.0.1"` |
| OpenAPI (Swagger 2.0) spec | `GET https://hubeau.eaufrance.fr/api/v2/hydrometrie/api-docs` (200, JSON, 117 kB) |
| Auth | None. Open access. CORS `Access-Control-Allow-Origin: *` |
| v1 | `https://hubeau.eaufrance.fr/api/v1/hydrometrie/...` returns **HTTP 403**. v1 was shut down on 05/05/2025 (the doc says "05/05/2025 : arrêt de la version 1") |
| Compression | gzip is supported (`Accept-Encoding: gzip` gives `content-encoding: gzip`) |
| Upstream | PHyC (Plateforme HYDRO Centrale), run by the Service Central Vigicrues (SCV). The doc says: "bancarisées toutes les 5 à 60 minutes dans la plateforme PHyC. L'API est mise à jour à partir de la plateforme PHyC toutes les 5 minutes et maintient un historique d'un mois." |
| Units | H in **mm**, Q in **l/s** (doc: "mm pour les hauteurs d'eau (diviser par 1000…) ; l/s pour les débits (diviser par 1000 pour convertir en m3/s)"). Checked live: Chooz H=491 mm matches Vigicrues 0.49 m. Uckange Q=11200 l/s matches Vigicrues 11.2 m³/s |
| Time | UTC, ISO 8601 with `Z` (doc: "Les dates sont exprimées en Temps Universel Coordonné (UTC)"). Station comments such as "A partir du 23/03/2007, les données sont en TU" mean that older archives may be in local time |
| Status page | `https://hubeau.eaufrance.fr/status` (linked from the doc; not called) |
| Rate limit | **No documented quota**, and I saw no rate-limit headers. The only figure in the doc is "05/03/2020 : Passage sur serveur dédié pour tenir la charge (10 appels/s en moyenne)", which is historical capacity, not a quota. The terms of use (CGU) say: "L'Editeur se réserve la possibilité de refuser l'accès aux API en cas d'usage abusif". They also ask users to filter requests and to use bulk exports instead of the API for full downloads. There is no SLA: "Les API sont donc mises à disposition sans garantie sur leur disponibilité et leur performance". |
| License | Licence Ouverte / Etalab (CGU: "La réutilisation des Jeux de données est régie par la licence ouverte Etalab … L'utilisateur de ces données doit néanmoins veiller à citer l'auteur des Jeux de données"). data.gouv.fr lists the dataservice under "Licence Ouverte 2.0", access "Ouvert". |
| Suggested attribution | "Données hydrométriques : Hub'Eau / SCV – réseau Vigicrues (PHyC), Licence Ouverte Etalab 2.0 – https://hubeau.eaufrance.fr/page/api-hydrometrie", plus the date of last update. Licence text: https://www.etalab.gouv.fr/licence-ouverte-open-licence/ |

### 1.2 Endpoints and parameters (from the live OpenAPI spec)

| Endpoint | Formats | Default and max page size | Pagination | Default sort |
|---|---|---|---|---|
| `GET /referentiel/sites` | json, geojson; `/referentiel/sites.csv`, `.xml` | 1000 / **10000**; depth limit 20000 (page×size) | `page` + `size` | code_site asc |
| `GET /referentiel/stations` | json, geojson; `.csv`, `.xml` | 1000 / **10000**; depth limit 20000 | `page` + `size` | code_station asc |
| `GET /observations_tr` | json, geojson; `.csv`, `.xml` | 1000 / **20000** (size=20001 returns 400 `"size must be less than or equal to 20000"`) | **cursor only**; "Il n'y a pas de limitation sur la profondeur d'accès" | **date_obs desc**; `sort=asc|desc` |
| `GET /obs_elab` | json, geojson; `.csv` | 1000 / 20000; depth limit 20000 | cursor (the `next` link carries `cursor=`) | code_station, date_obs_elab asc |

Note: the Swagger `default` field says 20 for `size`, but the endpoint descriptions and the live `first` links show 1000.

**observations_tr filters:** `code_entite` (station or site code, comma-separated, **wildcard prefixes work**, e.g. `A*,B*,D*,E1*`), `grandeur_hydro=H|Q|H,Q`, `date_debut_obs` / `date_fin_obs` (UTC, ISO 8601; **cannot be more than 1 month in the past**, otherwise 400 `"date can't be < 1 month from now"`), `bbox=minLon,minLat,maxLon,maxLat` (WGS84), `latitude`/`longitude`/`distance` (km), `code_statut` (0 no validation, 4 raw, 8 corrected, 12 pre-validated, 16 validated), `fields=` (marked "experimental" but works), `sort`, `size`, `cursor`, `timestep` (10–60 min, single code_entite only, no pagination).

observations_tr has **no river filter** (`code_cours_eau`). Filter by river in the station catalogue (`referentiel/stations?code_cours_eau=B---0000` or `libelle_cours_eau=`), then pass the station codes.

**referentiel/stations filters:** bbox, code_cours_eau, libelle_cours_eau, code_departement, code_region, code_site, code_station (wildcard), `en_service=true|false`, date_ouverture_station, date_fermeture_station, code_sandre_reseau_station, libelle_station, fields, format.

### 1.3 Station catalogue: verified call and excerpt

```
GET https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations?code_station=B540001001&format=json
```
```json
{"code_site":"B5400010","code_station":"B540001001","libelle_station":"La Meuse à Charleville-Mézières",
 "type_station":"STD","coordonnee_x_station":823706.0,"coordonnee_y_station":6963646.0,"code_projection":26,
 "longitude_station":4.715855889,"latitude_station":49.75966562,
 "commentaire_station":"A partir du 23/03/2007, les données sont en TU.",
 "altitude_ref_alti_station":140.43,"code_systeme_alti_site":3,
 "code_cours_eau":"B---0000","libelle_cours_eau":"La Meuse",
 "commentaire_influence_locale_station":"Sous influence barrage et court-cicuité par 2 dérivations",
 "date_debut_ref_alti_station":"1993-09-01T00:00:00Z","date_activation_ref_alti_station":"2013-11-18T00:00:00Z",
 "en_service":true, ...}
```
Geometry is returned as GeoJSON in CRS84 (lon/lat). `code_projection` 26 is Lambert-93 (EPSG:2154) for the x/y fields.

### 1.4 Real-time observations: verified calls and excerpts

**Single station, latest first:**
```
GET https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=B720000001&grandeur_hydro=H&size=5
```
Returns **HTTP 206 Partial Content** when more pages exist, with an RFC 5988 `Link:` header (first/prev/next):
```json
{"count":6592,"next":"https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=B720000001&grandeur_hydro=H&cursor=AoJw9Jfr...&size=5",
 "api_version":"2.0.1","data":[{"code_site":"B7200000","code_station":"B720000001","grandeur_hydro":"H",
 "date_debut_serie":"2026-09-23T00:05:00Z","date_fin_serie":"2026-09-23T19:30:00Z","code_systeme_alti_serie":31,
 "date_obs":"2026-09-23T19:30:00Z","resultat_obs":491.0,"code_methode_obs":0,"libelle_methode_obs":"Mesurée",
 "code_qualification_obs":16,"libelle_qualification_obs":"Non qualifiée","longitude":4.782579717,"latitude":50.089049099,
 "code_statut":4,"libelle_statut":"Brute","code_continuite":0,"libelle_continuite":"Continue"}, ...]}
```

**History depth (checked):** with `sort=asc`, the oldest H/Q for Chooz was `2026-08-24T21:40:00Z`, about 30 days before the call. This matches "historique d'un mois".

**Bulk poll for all relevant basins in one request (checked):**
```
GET https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=A*,B*,D*,E*&date_debut_obs=<now-3h>&size=20000&fields=code_site,code_station,grandeur_hydro,date_obs,resultat_obs,code_statut,code_qualification_obs,code_methode_obs
```
This returned 200, 19,099 rows, 3.66 MB uncompressed, in 9.3 s, all on one page. The narrower `code_entite=A*,B*,D*,E1*,E2*,E3*` with a 20-minute window returned 155 rows in 0.8 s.

**Formats (checked):**
- CSV: `observations_tr.csv?...` gives `text/csv;charset=UTF-8`, `;`-separated and fully quoted:
  `"B5400010";"B540001001";"H";"2026-09-23T16:15:00Z";"2026-09-23T20:00:00Z";"31";"2026-09-23T20:00:00Z";"2608.0";"0";"Mesurée";"16";"Non qualifiée";...`
- GeoJSON: `format=geojson` gives a FeatureCollection with a CRS84 `crs` member and each observation as a Point feature.
- bbox: `bbox=4.6,49.6,5.0,50.2` works (count 75818 for H over the month).

**timestep (checked):** `...code_entite=B540001001&grandeur_hydro=H&date_debut_obs=<now-3h>&timestep=30` returned 6 values: `17:50, 19:20, 18:50, 19:50, 20:00, 18:20`. It **samples** values; it does not average them. The grid is aligned to `date_debut_obs`, not to clock time, the latest value is appended, results are **unsorted**, and paging is page-based.

**Method, quality and status codes seen live:** H is `code_methode_obs=0 "Mesurée"`. Q is mostly `8 "Calculée"` (derived from a rating curve), with some `0`. Qualification is `16 "Non qualifiée"` or `12 "Douteuse"`. All real-time rows had `code_statut=4 "Brute"`. **Real-time data is raw.**

**Timestep and latency (sample from 20:14 UTC, basins A/B/D/E):**
- Main native H steps: 5 min at 186 stations, 10 min at 118, 15 min at 20, 6 min at 10. Belgian partner stations run at 60 min.
- Latest `date_obs` per series: about 338 series at 20:0x and about 332 at 19:0x. **Many stations send data once an hour, so the delay is often 15–75 min.** Basel (A021005050) was at 18:45Z, about 1.5 h behind.

### 1.5 Vertical reference (H)

- Every real-time H series had `code_systeme_alti_serie = 31` (3,270 rows checked). Sandre nomenclature 76 (`https://api.sandre.eaufrance.fr/referentiels/v1/nsa/76.json`, checked) defines **31 = "Système local - hauteur relative"**. H is the stage above the gauge zero, and **negative values are normal** (Épinal −255 mm, Toul −415 mm, Stenay −44 mm).
- **The altitude of the gauge zero is published** in `referentiel/stations.altitude_ref_alti_station`, in metres, with `code_systeme_alti_site` (nsa/76 codes: **3 = IGN 1969 (NGF-IGN69)**, 2 = NGF 1884 (Lallemand), 1 = Bourdeloue 1857, 0 = unknown). Validity dates are in `date_debut_ref_alti_station`, `date_activation_ref_alti_station` and `date_maj_ref_alti_station`.
  - Example: Charleville zero 140.43 m IGN69 + 2.608 m = **143.04 m NGF-IGN69**.
- **Data quality of the zero altitude** (294 relevant real-time H stations checked):
  - 206 plausible IGN69 values
  - 28 in NGF-1884, which needs an offset of roughly 0.3–0.4 m that varies by region
  - 40 null
  - 14 implausible, for example `0.17361` (A220000101), `13318.0` (E364121002), `0.20627` (A920107050), `24.694` (B134001002), `-0.509` (A060005051, sys 0)
  - Absolute levels in metres NAP-comparable form therefore need a curated per-station table.
- Belgian partner station E381126601 (Lys at Menen) reports H=10020 mm "relative". Its zero is clearly on a different datum (probably TAW), even though its series code is also 31.

### 1.6 Elaborated observations (obs_elab): history for a later backfill

```
GET https://hubeau.eaufrance.fr/api/v2/hydrometrie/obs_elab?code_entite=B720000001,B7200000&grandeur_hydro_elab=QmnJ&size=2
```
```json
{"count":62060,"data":[{"code_site":"B7200000","code_station":"B720000001","date_obs_elab":"2004-04-22",
 "resultat_obs_elab":70642.0,"date_prod":"2026-08-18T08:26:11Z","code_statut":16,"libelle_statut":"Donnée validée",
 "code_methode":10,"libelle_methode":"Expertisée","code_qualification":20,"libelle_qualification":"Bonne","grandeur_hydro_elab":"QmnJ"}]}
```

- **Available quantities (checked):** QmnJ (daily mean Q), QmM (monthly mean Q), HIXnJ and HIXM (daily and monthly maximum instantaneous H), QIXnJ, QINnJ, QIXM and QINM (max and min instantaneous Q). The case in the spec is inconsistent: "QixM" versus "QIXM".
- **There is no daily-mean H.** For levels you only get the daily or monthly maximum.
- **History checked:**
  - Chooz Île Graviat (B720000002) QmnJ from **1953-01-01**; Chooz Trou du Diable from 2004-04-22
  - Uckange (A850061001) from 1981-10-02
  - Charleville, Metz, Maulde, Hanweiler and Strasbourg have nothing before 2000
  - The doc says "depuis 1900 pour certaines stations"
- **Timeliness:** recent days are published about 1–4 days after the fact as raw data (`"date_obs_elab":"2026-09-14","date_prod":"2026-09-18T21:45:14Z","code_statut":4`). The doc says the data is updated daily.
- **Paging:** 20,000-row depth cap. Filters are `date_debut_obs_elab`/`date_fin_obs_elab` and `date_debut_prod`/`date_fin_prod`. The `prod` filters give **incremental sync by ingestion date**, which observations_tr lacks. Max 100 codes per call; wildcards are allowed.
- **Gotcha:** passing a **site** code (B7200000) also returns every station under that site, so the count is inflated.

### 1.7 Pitfalls I actually hit

1. **HTTP 206** is returned for any page that has a `next`. Clients that only accept 200 will fail.
2. **Site-level duplicate Q series:** Q rows with `code_station: null` (site-level Q) sit next to station-level Q. Over 3 h there were 284 site-level and 287 station-level Q series. Deduplicate, or use station-level only.
3. **Late-arriving data:** `date_debut_obs` filters on observation time. Hourly-transmitting stations deliver past timestamps late, so a 20-minute sliding window misses them. Poll with a **2–3 h overlapping window and upsert** on (station, grandeur, date_obs).
4. **Hard 1-month limit** on observations_tr. If the collector is down for more than 30 days, 5-minute data is lost for good (Vigicrues keeps about 2 months; see below).
5. **Negative Q** occurs, e.g. Trith-Saint-Léger E172751201 Q=−1200 l/s (canalised Escaut, flow reversal or regulation). Some canalised or partner stations have no H, or no Q.
6. **GeoJSON property typo:** `"code_slibelle_statuttatut":"Brute"` appears in place of `libelle_statut`. Use JSON for ingestion.
7. **Unsorted `timestep` output**, aligned to the start time.
8. **Station "en_service" is not the same as "delivering real-time data".** Some active stations sent nothing in 6 h: B720000003 Chooz Petit, D021000101 Solre/Erquelinnes, A694102001 Malzéville débitmètre, E131000201 Iwuy, E240041201 Tournai.
9. **Foreign stations are mirrored:** Rhine at Basel (A021005050), Breisach (A040000101), Kehl (A060005050), Plittersdorf (A355005050) and Maxau (A375005050); Belgian Semois, Chiers (Torgny), Sambre (Erquelinnes), Escaut (Tournai) and Lys (Menen). Deduplicate against the German and Belgian source reports.
10. Metadata inconsistencies: the zero-altitude units (above), and `libelle_cours_eau` is null on some stations.

---

## 2. Vigicrues (SCV) services

All of these are "unofficially official". They are documented at https://www.vigicrues.gouv.fr/services/v1.1, which marks several items "TODO", and the payloads report versions like `"VersionFlux":"Beta 0.4f"` and `"Version":"1beta"`. Responses are served through a CDN with `cache-control: max-age=120`. There is no auth and no documented quota. **Several `/services/v1.1/...` URLs now return 302 to `/services/...`**, so clients must follow redirects.

### 2.1 Observations (checked)
```
GET https://www.vigicrues.gouv.fr/services/observations.json/index.php?CdStationHydro=B720000001&GrdSerie=H&FormatSortie=simple
```
```json
{"Serie":{"CdStationHydro":"B720000001","LbStationHydro":"Chooz [Trou du Diable]","GrdSerie":"H",
 "ObssHydro":[[1784415600000,0.6],[1784419200000,0.62], ... ,[1790191800000,0.49]]}}
```
- Units: **H in m, Q in m³/s** (`GrdSerie=Q`). Timestamps are epoch **milliseconds UTC** by default. `FormatDate=iso` gives `"DtObsHydro":"2026-09-23T20:00:00+00:00","ResObsHydro":11.2`.
- **History is about 2 months**, longer than Hub'Eau's 1 month: Chooz H from 2026-07-18T23:00Z (13,934 points at 5 min); Uckange Q from 2026-07-27.
- The last value matched Hub'Eau exactly (19:30Z, 0.49 m = 491 mm). **The station codes are the same Sandre codes as Hub'Eau.**
- There is no time-range parameter, so you always get the full series (Uckange Q was 752 kB per call).
- `GET https://www.vigicrues.gouv.fr/services/observations.json` without parameters returns only `{"CdStationHydro","DtObsHydro"}`, the **latest observation timestamp**, for 2,352 stations (140 kB, 9 s). It carries no values, so it only works as a freshness index.
- XML variant: `observations.xml` (documented, not called).

### 2.2 Forecasts (checked)
- National list: `GET https://www.vigicrues.gouv.fr/services/v1.1/prevision.json?FormatDate=iso` returned 18 simulations nationally at the time; `GrdSimul=Q` gives discharge.
- Per station, v1.1 (returns local-time offsets): `.../v1.1/prevision.json?CdEntVigiCru=K490003010&TypEntVigiCru=7&FormatDate=iso`
  ```json
  {"Simul":{"CdEntVigiCru":"K490003010","GrdSimul":"H","DtProdSimul":"2026-09-23T08:26:26+02:00",
   "CommentSimul":"… la tendance basse a 9 chances sur 10 d'être dépassée …",
   "Prevs":[{"DtPrev":"2026-09-23T23:00:00+02:00","ResMinPrev":0.42,"ResMoyPrev":0.43,"ResMaxPrev":0.44}, ...]}}
  ```
  The horizon was about 21 h (23:00 to 19:00 next day, hourly), with P10, P50 and P90 bands. The v1.1 route **uses +02:00 local offsets**.
- Per station, legacy route (returns UTC offsets): `.../services/previsions.json/index.php?CdStationHydro=K490003010&GrdSerie=H&FormatDate=iso` gives `"DtPrev":"2026-09-23T20:00:00+00:00"`.
- A non-forecast station returns `{"error_msg":"Cette station n'est pas une station de prévisions","code":400}` with HTTP 200.
- Territory 2 (Meuse-Moselle) had **no active forecasts**: `{"message":"Problème dans l'exécution de la requête : toutes prévisions","code":204}` with HTTP 200. Charleville, Metz and Uckange returned empty `Prevs`. **Forecasts are only published during events.**

### 2.3 Vigilance levels and reference data (checked)
- `GET https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson` (the v1.1 `/services/1/...` path redirects here): 2.2 MB, 337 MultiLineString features in WGS84. Properties include `CdEntCru` (e.g. `LO18` "Meuse frontalière - Semoy", `SA15` "Rhin canalisé aval", `AP1` "Sambre", `AP13` "Lys amont - Laquette"), `cdensup_1` (territory) and **`NivInfViCr` (1 green, 2 yellow, 3 orange, 4 red)**. Top-level fields: `DtHrInfoVigiCru` (e.g. `2026-09-23T13:57:13+00:00`) and `RefInfoVigiCru`. Everything was at level 1 at call time.
- Territories: `GET https://www.vigicrues.gouv.fr/services/TerEntVigiCru.json`. Relevant ones: **2 Meuse-Moselle, 3 Rhin-Sarre, 29 Bassins du Nord**.
- Stations: `GET https://www.vigicrues.gouv.fr/services/StaEntVigiCru.json` gives 2,376 stations, 1.7 MB. Detail: `…/v1.1/StaEntVigiCru.json?CdEntVigiCru=B540001001&TypEntVigiCru=7`. Many fields hold the placeholder "A renseigner obligatoirement", so the metadata is poor.
- Station page data: `GET https://www.vigicrues.gouv.fr/services/station.json/index.php?CdStationHydro=B540001001` gives `StationPrevision` (true/false), `CruesHistoriques` (historic flood stages, e.g. `{"LbUsuel":"Crue de janvier 1991","ValHauteur":5.47}`), neighbouring stations, and coordinates in Lambert-93.
- Bulletin: `GET https://www.vigicrues.gouv.fr/services/bulletin.json?CdEntVigiCru=2` redirects to `/services/bulletin.json/index.php?...` and lists the child sections.
- **Station vigilance thresholds: not published in any machine-readable service I found (UNVERIFIED that none exists).** The only reference lines available are `CruesHistoriques`.
- Coverage: in the relevant basins (A, B, D, E1–E3) Vigicrues has **263 stations. All 263 are in the Hub'Eau catalogue, and 259 appeared in Hub'Eau real-time data**. Hub'Eau is therefore a superset for observations.

### 2.4 License and attribution
- Site footer: "Sauf mention contraire, tous les contenus de ce site sont sous licence etalab-2.0".
- Mentions légales (https://www.vigicrues.gouv.fr/categorie/2): "la réutilisation des informations publiques est soumise à la condition que ces dernières ne soient pas altérées, que leur sens ne soit pas dénaturé et que leurs sources (**© VIGICRUES**) et la date de leur dernière mise à jour soient mentionnées". Content is provided "en l'état … sans autre garantie". The page also says there is no technical support and that information is updated "au moins deux fois par jour".
- The VIGICRUES trademark and logo are registered at INPI (no. 4151833). **Do not use the logo.**
- Required text: "Source : © VIGICRUES – www.vigicrues.gouv.fr, [date de mise à jour], Licence Ouverte Etalab 2.0".

### 2.5 HydroPortail
- https://www.hydro.eaufrance.fr/ returns 200 (v3.5 installed 19/05/2026). Station pages such as `/stationhydro/B720000001/fiche` and `/sitehydro/B7200000/fiche` work, and the UI has export pages (`/export/donnees-hydro/station/selection`, `/export/series-hydro/selection`).
- **It has no documented public API.** The exports are UI-driven, and I did not check whether they need an account. Hub'Eau is the official programmatic channel to the same PHyC data. Use HydroPortail exports only as a manual backfill source for long 5–60-minute history (UNVERIFIED).

---

## 3. Key stations (code_station; checked live, latest values around 20:00Z on 2026-09-23)

Legend: Zero = gauge-zero altitude, m IGN69 unless noted. VC = Vigicrues station (F = forecast station). Step = native step in minutes.

| River / place | code_station | H/Q live | Step | Zero | VC | Notes |
|---|---|---|---|---|---|---|
| **Meuse** Saint-Mihiel | B222001001 | H 296 mm, Q 1.17 m³/s | 5 | 218.95 | yes | |
| Meuse Stenay | B315002001 | H −44, Q 3.36 | 5 | 162.17 | F | |
| Meuse Sedan | B502001001 | H 2650, Q 13.3 | 5 | 146.26 | F | |
| Meuse Charleville-Mézières | B540001001 | H 2608, no real-time Q | 5 | 140.43 | F | weir-influenced |
| Meuse Monthermé (limnimètre) | B700001002 | H 3550 only | 5 | 133.03 | yes | |
| Meuse Chooz Trou du Diable (DREAL) | B720000001 | H 491, Q 17.3 | 5 | 101.34 | yes | **last French station before BE**. Separate "EDF" series B720000004 |
| Meuse Chooz Île Graviat | B720000002 | H 60 | 5 | 99.0 (**NGF-1884**) | yes | QmnJ back to 1953 |
| Meuse Givet | — | — | — | — | — | **No Hub'Eau or Vigicrues station** (Chooz is the border proxy) |
| **Chiers** Longwy / Montigny / Chauvency / Carignan / Brévilly | B402101001 / B403101001 / B460101001 / B463101001 / B466010101 | H+Q (Brévilly H only) | 5 | 249.98 / 219.66 / 173.73 / 158.59 / 157.07 | Brévilly F | Belgian Torgny B422431101 is a 60-min partner station |
| **Semoy** Haulmé | B611101001 | H 301, Q 1.19 | 5 | 143.0 (NGF-1884) | F | Belgian partner stations B6100002xx–08xx (Membre, Bouillon, …) at 60 min |
| **Sambre** Berlaimont | D016221001 | H 274 | 5 | 126.876 | | |
| Sambre Maubeuge aval écluse | D019801101 | H 207 | 5 | 122.237 | F | |
| Sambre Marpent (near Jeumont) | D019223001 | H 178, Q 2.15 | 5 | 122.24 | | last FR station before BE. Solre/Erquelinnes D021000101 had no data |
| **Moselle** Épinal | A443064001 | H −255, Q 2.06 | 5 | 324.27 | F | |
| Moselle Toul | A573061001 | H −415, Q 3.44 | 5 | 200.74 | F | |
| Moselle Custines (upstream of Pont-à-Mousson) | A701061001 | H 546, Q 7.82 | 5 | 183.6 | F | **No Pont-à-Mousson station** (Blénod A703062001 closed). Corny A740000102 H only |
| Moselle Metz Pont des Morts | A743061001 | H 2079 only | 5 | 159.01 | yes | |
| Moselle Hagondange | A793061002 | H 237, Q 9.09 | 5 | 153.91 | | |
| Moselle Uckange | A850061001 | H 250, Q 11.2 | 5 | 150.28 | F | **most downstream French Moselle station in Hub'Eau**. No Thionville Moselle station (Vigicrues "Thionville" = Veymerange A860304001). **No Apach, Sierck or Perl station** |
| **Meurthe** Laneuveville-devant-Nancy | A692101001 | H 206, Q 6.03 | 5 | 200.41 | | |
| Meurthe Malzéville (limni) | A694102004 | H 1242 | 5 | 188.08 | | débitmètre A694102001 had no real-time data |
| **Sarre** Sarralbe centre | A920107050 | H 1048, Q 1.88 | 10 | **0.20627 (bad)** | yes | |
| Sarre Wittring | A930108040 | H 558, Q 1.96 | 10 | 200.0 | yes | |
| Sarre Hanweiler (DE border) | A940000101 | H 2347 | 10 | 191.3 | F | Sarreguemines stations A931108060 and A931109050 are **closed** |
| **Rhin** Strasbourg sémaphore nord | A061005051 | H 1203 | 10 | 134.21 | yes | |
| Rhin Kehl-Kronenhof (DE) | A060005050 | H 1850 | 15 | 133.6 | yes | |
| Rhin Lauterbourg | A302009050 | H 2656, Q 363 m³/s | 10 | 103.24 | yes | **last French Rhine station** |
| Rhin Basel / Plittersdorf / Maxau (foreign mirrors) | A021005050 / A355005050 / A375005050 | H+Q | 15 | null | | deduplicate with CH/DE sources |
| **Ill** Strasbourg Chasseur-Froid | A228003001 | H 1612, Q 38.7 | 10 | 131.0 | yes | Montagne Verte A226032002 (débitmètre) |
| **Escaut** Iwuy (Cambrai area) | E131000202 | H 292, Q 2.47 | 15 | null | | no station named Cambrai |
| Escaut Neuville-sur-Escaut | E171551101 | H 126, Q 8.19 | 5 | null | | |
| Escaut Trith-Saint-Léger (Valenciennes) | E172751201 | H 24, **Q −1.2** | 5 | null | | Condé E183041001 **closed** |
| Escaut Maulde (BE border, near Mortagne) | E240041101 | H 154, Q 23.4 | 5 | 14.5 | yes | Tournai E240041201 had no data |
| **Scarpe** Anzin-Saint-Aubin / Courchelettes / Brebières (VNF) / Mortagne-du-Nord | E201000501 / E223000101 / E207111003 / E237110501 | H (+Q) | 5–15 | 57.473 / 27.39 / null / 13.29 | Mortagne yes | |
| **Lys** Merville DREAL / VNF | E364121002 / E364121001 | H 125 / 130 | 5 / 15 | **13318.0 (bad)** / 13.27 | DREAL yes | |
| Lys Armentières (VNF) | E367125002 | H 200, Q 7.54 | 15 | **0.01267 (bad)** | yes | |
| Lys Bousbecque (border) | E381126501 | H 83, Q 1.68 | 5 | 9.913 | yes | **No Halluin or Comines station**. Menen (BE) E381126601 H=10020 on a different datum |

### 3.1 Station counts for NL-bound basins

Counts come from the Hub'Eau catalogue and the 3-hour real-time window. They exclude E4 (Aa/Yser), E5 and E6 (Canche, Somme), which do not drain to the Netherlands.

| Basin (Sandre zone) | Catalogue total | en_service | Real-time H | Real-time Q (station) |
|---|---|---|---|---|
| Rhin + Ill + Alsace (A0–A3) | 222 | 93 | 79 | 67 |
| Moselle (A4, A5, A7, A8) | 101 | 60 | 49 | 43 |
| Meurthe (A6) | 44 | 28 | 21 | 19 |
| Sarre + Nied (A9) | 42 | 32 | 27 | 25 |
| Meuse (B, excluding B4 and B6) | 43 | 33 | 30 | 22 |
| Chiers (B4) | 18 | 14 | 14 | 11 |
| Semoy (B6) | 7 | 7 | 5 | 7 |
| Sambre (D) | 25 | 21 | 18 | 15 |
| Escaut (E1) | 21 | 13 | 12 | 11 |
| Scarpe (E2) | 16 | 9 | 8 | 7 |
| Lys / Deûle / Marque (E3) | 46 | 36 | 31 | 18 |
| **Total** | **585** | **346** | **294** | **245** |

About 298 stations deliver any real-time series. Vigicrues covers 263 of them.

---

## 4. Suggested ingestion design (France)

- **Station catalogue** (daily): `referentiel/stations?code_station=A*` (and B*, D*, E1*, E2*, E3*) `&size=10000&format=json`. Keep a curated per-station zero offset and datum, and hand-fix the 14 bad and 40 null values. Record the source as "Sandre code".
- **Real-time poll** every 10–15 min: `observations_tr?code_entite=A*,B*,D*,E1*,E2*,E3*&date_debut_obs=<now-3h>&size=20000&fields=code_site,code_station,grandeur_hydro,date_obs,resultat_obs,code_qualification_obs,code_statut`. Follow `next` if present, and send `Accept-Encoding: gzip`. Upsert on (code_station, grandeur, date_obs), drop `code_station == null` rows, and convert mm to m and l/s to m³/s. That is about 5–7k rows per call, well within fair use (about 100–150 calls per day).
- **Gap safety:** if downtime is under 30 days, re-pull from Hub'Eau. Between 30 and about 60 days, per-station Vigicrues `observations.json` (about 2 months, 5 min, m) can fill the gap. Beyond that, only obs_elab daily aggregates (HIXnJ/QmnJ) or HydroPortail exports remain.
- **Optional overlays:** `InfoVigiCru.geojson` (vigilance colours per river section, every 15–60 min) and Vigicrues forecasts for flagged stations (event-driven).

---

## 5. Recommendation for phase planning

**MVP**
- Use Hub'Eau `observations_tr` as the only French observation source. It is stable, versioned, has an OpenAPI spec, needs no auth, and is under Licence Ouverte 2.0. One wildcard request covers every NL-bound basin.
- Show **H relative to the gauge zero** plus **Q in m³/s** where it exists. Q is the better quantity for "following water downstream" across borders, because stage is not comparable between stations.
- Use a curated set of about 40 key stations along the main stems (table above), with the rest as optional markers. Key border stations:
  - Meuse at Chooz B720000001
  - Chiers at Brévilly B466010101
  - Semoy at Haulmé B611101001
  - Sambre at Marpent D019223001
  - Moselle at Uckange A850061001
  - Sarre at Hanweiler A940000101
  - Rhin at Lauterbourg A302009050
  - Escaut at Maulde E240041101
  - Lys at Bousbecque E381126501
- Store raw 5–15-minute data from day one. Hub'Eau's 1-month window means anything not collected is lost.
- Attribution text: "Hub'Eau / SCV – réseau Vigicrues, Licence Ouverte Etalab 2.0" (plus "© VIGICRUES" and the update date if Vigicrues data is shown).

**Later phases**
- Absolute water levels (m NGF-IGN69 converted to a common datum with NAP/DHHN/TAW). This needs a curated zero table and handling of NGF-1884 stations.
- Vigicrues vigilance-section overlay and P10/P50/P90 forecasts. The service is beta and undocumented in places, redirects have changed, and forecasts are event-only.
- Backfill: obs_elab QmnJ, HIXnJ and QIXnJ, which go back decades (1953 for Chooz, 1981 for Uckange); HydroPortail exports for sub-daily history (UNVERIFIED how).
- `CruesHistoriques` from Vigicrues as reference lines.

**Risks**
- Real-time data is raw and unvalidated (status 4, some flagged "Douteuse"), with outliers and negative Q at canalised or tidal-regulated sites.
- Delay of up to about 75 min for hourly-transmitting stations (Basel was about 1.5 h behind). The UI must show "last updated" per station.
- There is no quota, but abusive use can be blocked. There is no SLA for Hub'Eau or Vigicrues, and Vigicrues offers no support.
- Metadata errors in the zero altitudes and in Vigicrues placeholder fields.
- Some requested border points have no French gauge: Givet, Thionville (Moselle), Apach/Perl, Sarreguemines (closed), Pont-à-Mousson, Condé (closed), Halluin. Rely on the Belgian, Luxembourg and German sources, or on the nearest French proxy.
- Foreign stations mirrored in Hub'Eau (CH/DE Rhine, BE Semois/Chiers/Sambre/Escaut/Lys) must be deduplicated against the other country reports, and their datum or zero may differ (Menen reads about 10 m).
- If Hub'Eau changes version again, expect endpoint breakage: v1 was shut down on 2025-05-05 and now returns 403.

Sources: [Hub'Eau Hydrométrie doc](https://hubeau.eaufrance.fr/page/api-hydrometrie), [Hub'Eau CGU](https://hubeau.eaufrance.fr/page/conditions-generales), [data.gouv.fr Hub'Eau Hydrométrie dataservice](https://www.data.gouv.fr/dataservices/hubeau-hydrometrie), [Licence Ouverte 2.0](https://www.data.gouv.fr/pages/legal/licences/etalab-2.0), [Vigicrues API doc v1.1](https://www.vigicrues.gouv.fr/services/v1.1), [Vigicrues mentions légales](https://www.vigicrues.gouv.fr/categorie/2), [Sandre nomenclature 76](http://id.eaufrance.fr/nsa/76), [HydroPortail](https://hydro.eaufrance.fr/)

Raw responses are saved in `(research-session scratch files, not kept)`.