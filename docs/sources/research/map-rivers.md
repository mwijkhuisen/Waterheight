# Research report: map stack, basemap, river network geometry and flow visualisation


Everything below marked "LIVE" was checked with curl on 2026-09-23 between 20:12 and 20:35 UTC. Anything I could not check live is marked **UNVERIFIED**, with the reason.

---

## 0. Key findings

- **OSM Standard tiles (`tile.openstreetmap.org`)** work (LIVE), but they are not suitable as the primary basemap for a public site:
  - The policy says there is no SLA and access can be blocked without notice.
  - A request with a default library User-Agent (plain curl) got a **"403 Access blocked" PNG with HTTP status 200** and the header `x-blocked`.
- **OpenFreeMap** works (LIVE): vector tiles with no API key, CORS `*`, planet build from 2026-09-13, maxzoom 14. The terms say "no limits", but also "no SLA" and "may discontinue at any time without notice".
- **Protomaps PMTiles:**
  - The daily planet build `20260923.pmtiles` is **138.2 GB** (z0–15, LIVE).
  - I measured regional extracts with `pmtiles extract --dry-run` (LIVE). The study area bbox is **2.9 GB at z0–14** and 6.5 GB at z0–15. The full Rhine basin (including Switzerland and the Main) is **4.3 GB at z0–14** and 9.2 GB at z0–15.
- **Recommended basemap:** primary is a self-hosted Protomaps PMTiles regional extract; fallback is the public OpenFreeMap instance.
- **Recommended map library:** MapLibre GL JS (v6.11.1, BSD-3, now **ESM-only**, about 300 KB gzipped). Add deck.gl 9.4 (MIT) as an overlay for the heavy time animation.
- **River geometry:**
  - OSM waterway ways point downstream (LIVE check on the Boven-Rijn). OSM also has per-river `type=waterway` relations with `main_stream`/`side_stream` roles (LIVE: Rhein 123924, Meuse 1075197, Escaut 324288, Moselle 390416, Ems 370068).
  - **EU-Hydro** has explicit directed topology (`NEXTDOWNID`, `NEXTUPID`, `FNODE`, `TNODE`, `STRAHLER`). I confirmed this live through the EEA ArcGIS REST service.
  - HydroRIVERS is connected, but its geometry is coarse (15″), it has no bifurcations and its licence passes obligations on to end users.
  - Recommendation: build from OSM and publish the derived graph under ODbL. Use EU-Hydro for topology QA and as the licence-clean fallback.
- **Official river-km for chainage:** PEGELONLINE returns a `km` for every German federal gauge (LIVE, e.g. Maxau 362.327, Kaub 546.23, Koblenz 591.49, Emmerich 851.9, Lobith 862.0). Dutch Meuse river-km are published by RWS (Eijsden-grens 2.56, Borgharen-dorp 16.00, Venlo 107.47).
- **Travel times** depend strongly on flow:
  - Flood peaks, from RWS (1985): Andernach→Lobith 28–48 h (about 39 h), Köln→Lobith about 30 h, Emmerich→Lobith about 3 h.
  - My own cross-correlation at extreme low water (Aug–Sep 2026, Kaub at 9–77 cm) gives Kaub→Lobith about **64 h** and Koblenz→Lobith about **55 h**.
  - Meuse, July 2021 peak: Eijsden→Borgharen 3.5 h, Eijsden→Venlo 38 h, Eijsden→Megen 82 h.

---

## 1. Basemap options (live checks, terms, verdict)

### 1.1 OSM Standard raster tiles, `https://tile.openstreetmap.org/{z}/{x}/{y}.png`

**Live check, with a custom User-Agent:**
```
GET https://tile.openstreetmap.org/6/33/21.png   (UA: "RiverLevelsPlanningResearch/0.1 (...)")
HTTP/2 200
content-type: image/png
cache-control: max-age=520469, stale-while-revalidate=604800, stale-if-error=604800
access-control-allow-origin: *
x-tilerender: orm.openstreetmap.org
content-length: 56878
```

**Pitfall observed, with the default curl User-Agent:** the server returned HTTP **200** with a 6,987-byte PNG that reads "403 Access blocked – App is not following the tile usage policy…", plus these headers:
```
cache-control: no-cache
x-blocked: Access denied. See https://operations.osmfoundation.org/policies/tiles/
```
Monitoring that only looks at status codes will not notice this block.

**Policy** ([operations.osmfoundation.org/policies/tiles](https://operations.osmfoundation.org/policies/tiles/)):
- Clear attribution is required, usually bottom-right.
- Send "a clear, unique User-Agent… Do not use a library default User-Agent". Browsers must send a valid Referer.
- Honour caching headers, or cache for at least 7 days.
- No bulk download or prefetch, and no offline use.
- "We may block access, without notice, if your usage degrades the service."
- "Availability is best-effort: there is no SLA or guarantee."
- "Commercial services should note: access may be withdrawn at any point."

**Verdict:** acceptable only for prototypes or as a last-resort fallback. It is raster, so it cannot be restyled to mute colours behind the data layer.

### 1.2 OpenFreeMap (public instance)

**LIVE checks:**
```
GET https://tiles.openfreemap.org/planet        -> 200 application/json (TileJSON 3.0.0)
{"tilejson":"3.0.0","tiles":["https://tiles.openfreemap.org/planet/20260913_164504_pt/{z}/{x}/{y}.pbf"],
 "attribution":"<a href=\"https://openfreemap.org\">OpenFreeMap</a> <a href=\"https://www.openmaptiles.org/\">&copy; OpenMapTiles</a> Data from <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a>",
 "maxzoom":14,"minzoom":0,"name":"OpenFreeMap","version":"3.16.0", ...}
layers: aerodrome_label, aeroway, boundary, building, housenumber, landcover, landuse, mountain_peak,
        park, place, poi, transportation, transportation_name, water, water_name, waterway
GET .../planet/20260913_164504_pt/8/133/84.pbf  -> 200 application/vnd.mapbox-vector-tile,
    content-encoding: gzip (152 KB gz / 221 KB raw), cache-control: public, max-age=315360000,
    access-control-allow-origin: *, server: cloudflare
Styles (all 200 JSON): /styles/liberty (43 KB), /styles/bright, /styles/positron, /styles/dark, /styles/fiord
Glyphs: https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf ; sprite: https://tiles.openfreemap.org/sprites/ofm_f384/ofm
```
- The tile URL contains a **weekly build version**. Do not hard-code it; reference the TileJSON `url` in the style.
- How long old versions stay available is **UNVERIFIED** (not documented).
- The z8 tile contained only 2 `waterway` features (Ems and Lippe, class `river`). Basemap waterways are clipped, merged and simplified, so they **cannot be used as a network**.

**Terms** ([openfreemap.org](https://openfreemap.org/), [openfreemap.org/tos](https://openfreemap.org/tos/)):
- "no limits on the number of map views or requests"; no registration, no API keys, no cookies.
- Commercial use is allowed. "Attribution is required" (MapLibre adds it automatically from the TileJSON).
- "I don't offer SLA guarantees". The service is provided "as-is" and "may discontinue it at any time without notice".
- Automated collection without permission is forbidden.
- The software is MIT licensed and can be self-hosted (weekly planet in Btrfs/MBTiles).

### 1.3 Protomaps / PMTiles (self-hosted regional extract)

**LIVE checks:**
```
GET https://build-metadata.protomaps.dev/builds.json  -> 200, 62 builds listed; latest:
{"key":"20260923.pmtiles","size":138242597731,"uploaded":"2026-09-23T09:09:59.501Z","version":"4.15.2"}
HEAD https://build.protomaps.com/20260923.pmtiles -> 200, content-length: 138242597731, accept-ranges: bytes
GET (Range: bytes=0-126) -> 206, content-range: bytes 0-126/138242597731   (no Access-Control-Allow-Origin header returned)
pmtiles show: spec v3, tile type mvt, zoom 0-15, clustered, gzip; attribution "© OpenStreetMap";
              planetiler:osm:osmosisreplicationtime 2026-09-23T04:00:00Z  (same-day OSM data)
```

**Extract sizes**, measured with `go-pmtiles extract <planet> out.pmtiles --bbox=… [--maxzoom=N] --dry-run` against the 20260923 build (LIVE):

| Extract | bbox (W,S,E,N) | Zooms | Tiles in region | Archive size |
|---|---|---|---|---|
| Study area (NL, BE, LU, western DE, northern/eastern FR) | 1.5,47.3,10.5,54.0 | 0–15 | 1,055,674 | **6.5 GB** |
| same | same | 0–14 | 264,374 | **2.9 GB** |
| same | same | 0–12 | 16,734 | 698 MB |
| Whole Rhine basin incl. CH Alps and Main | 1.5,45.8,12.5,54.0 | 0–15 | 1,554,724 | 9.2 GB |
| same | same | 0–14 | 389,398 | **4.3 GB** |
| NL-ish only | 3.2,50.7,7.3,53.6 | 0–15 | 216,115 | 2.0 GB |
| World context layer | planet | 0–6 | 5,461 | 45 MB |
| Europe mid-zoom | -10,35,30,60 | 0–9 | 4,338 | 339 MB |

**Terms** ([docs.protomaps.com/basemaps/downloads](https://docs.protomaps.com/basemaps/downloads)):
- Builds are kept for 1 week, plus the latest build of each patch version.
- "hotlinking to these downloads are discouraged… copy the tileset to your own Cloud Storage". The missing CORS header on build.protomaps.com also blocks browser hotlinking in practice.
- Licence: ODbL Produced Work; OSM attribution required.
- Style package `@protomaps/basemaps` 5.7.2 (BSD-3); JS decoder `pmtiles` 4.5.0 (BSD-3, about 8 KB gzipped).

**Hosting:** any static host or object store that supports HTTP Range and CORS. Whether a CDN caches range requests on multi-GB files depends on the vendor. The known workaround is the serverless PMTiles→z/x/y proxy (Cloudflare Worker or Lambda). **UNVERIFIED** for a specific vendor; I did not test it.

### 1.4 Other options (live status)

- **VersaTiles** (`https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}`): 200, Shortbread schema, maxzoom 14, no key.
  - Pitfall: the TileJSON reports OSM replication time `2026-06-07`, so the data was **about 3.5 months old**.
  - Usable as another fallback. Its terms were not reviewed (**UNVERIFIED**).
- **CARTO basemaps** (`basemaps.cartocdn.com/light_all/…`): 200. The terms restrict commercial and high-volume use. Not reviewed in detail (**UNVERIFIED**); not recommended.
- **OSM-FR/HOT raster** (`a.tile.openstreetmap.fr/hot/…`): 200. Volunteer server with the same kind of risk as OSM Standard.
- **PDOK BRT Achtergrondkaart** (`service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:3857/6/33/21.png`): 200, but it only covers the Netherlands.
- **BKG basemap.de vector**: my guessed tile URL returned 404 (**UNVERIFIED**). It is Germany-only anyway.
- **Self-generated tiles:** run Planetiler (OpenMapTiles or Shortbread profile) over Geofabrik extracts and serve them as PMTiles or MBTiles via Martin or tileserver-gl. This gives full control, but it is a build pipeline to own.
  - Geofabrik sizes (WebFetch; direct curl was reset by the proxy): NL 1.3 GB, BE 662 MB, LU 45 MB, DE 4.5 GB, FR 4.7 GB, CH 521 MB. Data as of 2026-09-22.

### 1.5 Recommendation

- **Primary:** self-hosted Protomaps PMTiles. Use a region extract at z0–14 (2.9 GB for the study area, or 4.3 GB for the full Rhine basin) plus a planet z0–6 extract (45 MB) for world context. Serve both from your own object storage or CDN. Style with a muted `@protomaps/basemaps` flavour (light or grayscale) so the data colours stand out. Refresh monthly or quarterly with `pmtiles extract`.
- **Fallback:** the OpenFreeMap public `positron` style. Switch in the client if PMTiles loading fails. It is also a good zero-ops choice during development.
- **Attribution:**
  - Protomaps setup: "© OpenStreetMap contributors" linking to https://www.openstreetmap.org/copyright, plus "Protomaps".
  - OpenFreeMap: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap", exactly as given in the TileJSON.
- OSMF attribution rules ([Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)): the credit goes in a corner of the map. On mobile it may collapse after interaction or after 5 seconds, as long as it stays findable.

---

## 2. Map library

Versions and licences are LIVE from the npm registry; bundle sizes are LIVE from jsDelivr, gzip -9.

| | MapLibre GL JS | Leaflet | OpenLayers | deck.gl (overlay) |
|---|---|---|---|---|
| Version (2026-09-23) | 6.11.1 (published 2026-09-23) | 1.9.4 (2023); 2.0.0-alpha.1 on the `alpha` tag | 10.10.0 | 9.4.0 |
| Licence | BSD-3-Clause | BSD-2-Clause | BSD-2-Clause | MIT |
| Size (gzip) | main 148.9 KB + shared 146.5 KB + worker 6.1 KB ≈ **300 KB**; CSS 83 KB raw | **42 KB** | full `ol.js` 289 KB (tree-shakeable) | `dist.min.js` 575 KB (modular imports are smaller) |
| Rendering | WebGL, vector tiles and PMTiles (`addProtocol`) | DOM/SVG/Canvas, raster; vector only via plugins | Canvas plus WebGL vector layers; strong on projections and OGC WMS/WMTS | WebGL2, GPU attributes, binary data |
| 2–5k markers | Trivial as a `circle`/`symbol` layer (not DOM markers); `feature-state` for per-feature colour | OK with `preferCanvas` and `circleMarker`; DOM markers are too slow | OK with WebGL points | Trivial (ScatterplotLayer; per-frame colour buffer updates) |
| Time animation | `setFeatureState` or `setData` per frame (works at a few fps for 5k features); `global-state` expression (GL JS ≥ 5.6) | Manual; limited | Manual; WebGL styles | Built-in: TripsLayer `currentTime`, `trailLength`; binary attributes |
| Animated lines | `line-dasharray` animation (data-driven since 5.8.0); `line-gradient` needs a GeoJSON source with `lineMetrics:true`, **is not data-driven and does not support feature-state** | Plugins only | Custom | TripsLayer; PathLayer (per-vertex colour through binary attributes); PathStyleExtension dashes |

- **Pitfall:** MapLibre **v6 ships ESM only**. The package `exports` has only `import: ./dist/maplibre-gl.mjs`, and `dist/maplibre-gl.js` returns 404 on jsDelivr; v5.9.0 still had a UMD `main`. This matters for plain `<script>` pages and some bundlers.
- `@deck.gl/mapbox` 9.4.0 peer dependencies are only `@deck.gl/core`, `@luma.gl/core` and `@math.gl/web-mercator`. `MapboxOverlay` is the usual way to combine deck.gl with MapLibre, but I did not test interleaving with MapLibre v6 (**UNVERIFIED**; prototype it early).

**Recommendation:** MapLibre GL JS v6 for the basemap, stations and static river layers. Add deck.gl through `MapboxOverlay` for the animated river and trips layers when the animation phase starts. Leaflet is too limited for WebGL line animation. OpenLayers is capable, but the vector-tile styling ecosystem (Protomaps and OpenFreeMap styles) is MapLibre-native.

---

## 3. River network geometry and licences

| Dataset | Licence | Topology / direction | Resolution & currency | Access | Verdict |
|---|---|---|---|---|---|
| **OSM** `waterway=river` ways plus `type=waterway` relations | ODbL 1.0 (share-alike on derivative databases) | Ways point **downstream** by convention (LIVE check). Connectivity comes from shared nodes; bifurcations are allowed (DAG). Relations have `main_stream`/`side_stream`/`spring`/`mouth` roles | Best geometry; matches the basemap exactly; updated continuously | Geofabrik PBF extracts (direct curl reset by the proxy; sizes via WebFetch); OSM API LIVE; **Overpass UNVERIFIED** (overpass-api.de reset, kumi timed out, mail.ru 504) | **Recommended primary** |
| **EU-Hydro River Network Database v1.3** (Nov 2020, CLMS/EEA) | CLMS full, free, open access (Reg. 1159/2013): cite the source, state modifications, imply no EU endorsement | **Explicit:** `NEXTDOWNID`, `NEXTUPID`, `FNODE`, `TNODE`, `STRAHLER`, `LONGPATH`, `CUM_LEN`, `nameText`; lines digitised downstream (LIVE) | 1:50,000, MMU 1 ha, imagery 2006–2012, EPSG:3035; EU-Hydro 2.0 in production (EGU26 abstract) | Per-basin GDB/GPKG download "requires authentication" (EU Login); ArcGIS REST query is anonymous (LIVE) | **Recommended QA/fallback**; licence-clean (no share-alike) |
| **HydroRIVERS v1.0** (HydroSHEDS) | Custom WWF licence: free commercial use, but redistribution needs an EULA "at least as protective", plus mandatory Exhibit B notice | Fully connected, **single `NEXT_DOWN`** (no bifurcations); `DIST_DN_KM`, `DIST_UP_KM`, `UPLAND_SKM`, `DIS_AV_CMS` | 15″ DEM-derived (about 300–450 m); weak in flat polder NL | Direct download (LIVE: `HydroRIVERS_v10_eu_shp.zip`, 67,648,957 B) | Internal analysis only (upstream area, discharge priors); do **not** serve its geometry. v2 (CC-BY 4.0) covers only the Americas so far |
| **CCM2 v2.1** (JRC, 2008) | "freely available for non-commercial use" (search result) | Strahler/Pfafstetter hierarchy, connected | 100 m DEM, 2008 | ccm.jrc.ec.europa.eu returned **502** through the proxy; data.jrc.ec.europa.eu said "Request Rejected" (**UNVERIFIED**) | Exclude: dated, non-commercial, unreachable |
| **Natural Earth 10 m** rivers + Europe supplement | Public domain | None (no topology or direction fields) | 1:10M; Rhine has only about 500 vertices total; many tributaries missing (Sambre, Ourthe, Lahn, Nahe, Rur, Dender) | LIVE: `ne_10m_rivers_lake_centerlines.zip` 2.08 MB, `ne_10m_rivers_europe.zip` 0.6 MB (2021) | Low-zoom overview only |
| **EuroGlobalMap** (EuroGeographics) | Open data with attribution: "This product includes Intellectual Property from European National Mapping and Cadastral Authorities and is licensed on behalf of these by EuroGeographics…". Exact licence (CC BY 4.0?) **UNVERIFIED**: mapsforeurope.org is a JS single-page app and the API returned 502 | Watercourse lines; flow direction not verified | 1:1M | **UNVERIFIED** | Too coarse; not needed |
| EuroRegionalMap | Not checked (**UNVERIFIED**) | – | 1:250k | – | Not evaluated |

**LIVE excerpts:**

OSM API (`GET https://api.openstreetmap.org/api/0.6/map.json?bbox=6.105,51.848,6.115,51.853`):
```
way 74917953 {'waterway':'river','name':'Boven-Rijn','CEMT':'VIc','boat':'yes'}
     first (6.1665582, 51.8407212)  last (6.1055999, 51.8481526)   # east -> west = downstream
way 662657942 {'waterway':'river','name':'Bijlandsch Kanaal','wikidata':'Q568819'} first (6.1056,51.8482) last (6.0573,51.8676)
rel 123924 {'type':'waterway','waterway':'river','name':'Rhein','name:nl':'Rijn','name:en':'Rhine','distance':'1233','wikidata':'Q584'}
     members 269  roles {'main_stream':168,'side_stream':101}
```
The first way ends at the exact node where the next one starts, which shows how the connectivity works.

Relation IDs via Wikidata property P402 (LIVE SPARQL) and the OSM API:
- Meuse 1075197: 351 members, including `spring`
- Escaut 324288: 111 members; **one member has an empty role**
- Moselle 390416: 270 members; **13 with empty role and 18 with `tributary`**. Roles are inconsistent, so clean them up.
- Ems 370068, Main 412876, Neckar 123881, Sambre 1600647, Ourthe 2246211, Rur 384594, Lahn 412935, Saar 390393, Sieg 409090, Ruhr 364754, Lippe 379691
- Wikidata returns two candidates each for Nahe and Lys. Check that you have the right one.

EU-Hydro (`GET https://image.discomap.eea.europa.eu/arcgis/rest/services/EUHydro/EUHydro_RiverNetworkDatabase/MapServer/12/query?geometry=6.0,51.8,6.3,51.9&geometryType=esriGeometryEnvelope&inSR=4326&outFields=…&outSR=4326&f=json`):
- Layers 5–13 are Strahler 1–9. `maxRecordCount` is 1000.
```
{"OBJECT_ID":"RL26021212","nameText":"BOVENRIJN, WAAL","STRAHLER":8,"NEXTDOWNID":"RL26021204","NEXTUPID":"RL26026307",
 "FNODE":"NO26021119","TNODE":"NO26021093","LENGTH":9362.43,"LONGPATH":244200.2,"CUM_LEN":72728416}
  first pt [6.0444,51.8711] last pt [5.9446,51.8649]  (downstream)
{"OBJECT_ID":"RL26021253","nameText":"LINGE EN KANALEN OVERBETUWE","STRAHLER":8, ...}   <- implausible Strahler in the delta
```

**ODbL implications (OSM):**
- The rendered map is a *Produced Work*, so only attribution is needed.
- A river graph extracted from OSM is a *Derivative Database*. If it is publicly used (for example, served to browsers as GeoJSON), it must be offered under ODbL.
- Station and measurement data is a different feature type from a non-OSM source, so it forms a *Collective Database* and is not caught by share-alike ([OSMF Horizontal Map Layers guideline](https://osmfoundation.org/w/index.php?title=Licence%2FCommunity_Guidelines%2FHorizontal_Map_Layers_-_Guideline&mobileaction=toggle_view_desktop); [Collective Database guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)).
- Mitigations:
  1. Publish the river graph as an ODbL download.
  2. Keep station chainage from official river-km (agency data), not computed from OSM geometry, so station attributes stay non-OSM.

**Recommendation:** use OSM waterway relations for the roughly 40–60 target rivers as the geometry and graph backbone. It is current, matches the basemap exactly, has multilingual names and Wikidata IDs, and handles delta bifurcations. Use EU-Hydro River_Net_l for QA of connectivity and Strahler hierarchy, and as the licence-clean fallback if share-alike becomes a problem. Use HydroRIVERS only internally, for upstream area and discharge priors.

---

## 4. Building the directed river graph

### 4.1 Pipeline (offline, re-run monthly)

1. **Pick the rivers.** Make a curated list of OSM relation IDs (for example from Wikidata P402, as above): the Rhine and its branches (Bovenrijn/Waal/Pannerdensch Kanaal/Nederrijn-Lek/IJssel), Main, Neckar, Moselle, Saar, Sauer, Lahn, Nahe, Sieg, Ruhr, Lippe, Erft, Meuse with Sambre/Ourthe/Semois/Rur/Niers, Scheldt/Escaut with Leie/Lys and Dender, Ems, Overijsselse Vecht, and the smaller border rivers.
2. **Extract the geometry** from Geofabrik PBFs with osmium or pyosmium (Overpass was unreachable here; **UNVERIFIED**). Keep only `main_stream` ways, or empty-role ways that connect, for each relation.
3. **Build the graph.** Nodes are shared OSM node IDs at way ends and confluences; edges are ways, directed as drawn.
   - Check for cycles.
   - Flag "reversed" ways where the downstream elevation is higher (optional, using an EU-DEM sample) or where the way direction conflicts with EU-Hydro `NEXTDOWNID` (buffer-match within about 200 m).
   - Allow **multiple downstream edges** at bifurcations: Pannerdensche Kop and IJsselkop, where Lobith splits about 2/3 Waal and 1/3 Pannerdensch Kanaal, then Nederrijn and IJssel. HydroRIVERS cannot represent these (single `NEXT_DOWN`), and EU-Hydro needs `FNODE`/`TNODE` rather than `NEXTDOWNID`.
4. **Simplify for display** per zoom (for example Douglas–Peucker at 5 m, 50 m and 500 m). Keep the unsimplified version for snapping.
5. **Snap stations.** For each gauge, take candidate edges within 300–500 m whose river name or Wikidata ID matches the station's water body. Most APIs give it: PEGELONLINE `water.longname`, for example `RHEIN` or `MOSEL`. Take the nearest point on those edges.
   - Do **not** snap on distance alone. Canals and side channels run alongside the main rivers (Juliana Canal and Albert Canal along the Meuse, Bijlandsch Kanaal, Grand Canal d'Alsace along the Rhine).
   - Keep a manual override table.
6. **Chainage and ordering:**
   - Prefer **official river-km**:
     - PEGELONLINE `km` (LIVE: Konstanz 0.5 … Basel-Rheinhalle 164.3, Maxau 362.327, Mainz 498.27, Kaub 546.23, Koblenz 591.49, Andernach 613.78, Köln 688.0, Düsseldorf 744.2, Ruhrort 780.8, Wesel 814.0, Emmerich 851.9, **Lobith 862.0**, Pannerdense Kop 867.3; Moselle Koblenz 1.3 … Cochem 51.6 … Trier UP 195.3)
     - RWS river-km for the Dutch Meuse (Eijsden-grens 2.56 … Megen 190.75) and the Rhine branches (continuing the German Rhine-km)
     - Belgian and French PK where published (**UNVERIFIED**; not checked)
   - Where there is no official km, use the distance along the graph to the Dutch entry point (Lobith, Eijsden-grens, the Scheldt border) computed from OSM geometry. The Rhine relation tag `distance=1233` is a sanity check.
   - Order stations upstream→downstream by chainage within each river path, then place tributary stations through the confluence node.
   - Pitfall: different km systems count in different directions and some restart per country. Store `(river_id, km_official, km_system, km_to_NL_entry)`.
7. **Travel-time priors:** give each edge a celerity, using the published or measured table below and the flow regime (low/mean/flood). Accumulate hours along the path to Lobith, Eijsden or the Scheldt border.
8. **Calibrate empirically once data is flowing.** Cross-correlate level changes between consecutive stations (hourly, smoothed). I tested this below; it works well for free-flowing reaches.

### 4.2 Published and measured travel times

**Rhine to Lobith.** Flood-peak values come from [RWS nota GWIO 85.006 "Looptijden hoogwatergolven op de Rijn"](https://open.rijkswaterstaat.nl/@87627/looptijden-hoogwatergolven-rijn/) (L.P.M. de Vrees, Aug 1985; 24 flood waves 1965–1983 with Q_Lobith > 5000 m³/s; PDF appendix 1 read). Ranges are the observed spread; the ≈ values are medians I computed from that table.

| From (PEGELONLINE km) | Distance to Lobith | Flood peak → Lobith (RWS 1985) | Low water Aug–Sep 2026 (this study) |
|---|---|---|---|
| Maxau (362.3) | 500 km | Not in RWS 1985. In the Feb and May 1999 floods, peak dates were Maxau 21.02 / 14.05 → Kaub 24.02 / 17.05 ([LfW RLP report 212/99, Tabelle 3](https://www.hochwasser.rlp.de/static/shared/documents/rhein_1999.pdf); daily resolution; peaks confounded by retention and the Neckar/Main). That implies **about 4–5 days to Lobith** (derived) | Maxau→Kaub 11 h, r = 0.29 (**unreliable**) |
| Kaub (546.2) | 316 km | **About 2 days** (derived: Kaub→Andernach about 0.5 day, plus Andernach→Lobith) | **About 64 h** (9 + 16 + 37 + 2) |
| Koblenz (591.5) | 271 km | **About 40–45 h** (derived: 22 km upstream of Andernach) | **About 55 h** |
| Andernach (613.8) | 248 km | 28–48 h, ≈ **39 h** | – |
| Bonn (654.8) | 207 km | 24–49 h, ≈ 35 h | – |
| Köln (688.0) | 174 km | 22–46 h, ≈ **30 h** | About 39 h |
| Düsseldorf (744.2) | 118 km | 11–34 h, ≈ 23 h | – |
| Ruhrort (780.8) | 81 km | 13–27 h, ≈ 19 h | – |
| Wesel (814.0) | 48 km | 6–19 h, ≈ 11 h | – |
| Emmerich (851.9) | 10 km | 1–8 h, ≈ **3 h** | **2 h** (r = 0.78) |

*Correction, 2026-10-10 (#110): the scan of appendix 1 gives Andernach 28¾–48¾, Köln 22½–40¾ (no 46 in the column; the 22–46 above is a misread), Wesel 6½–19½ and Emmerich ¼–8½ h. Every bound above was floored; the registry rounds outward to whole hours (Emmerich floor 1 h): Andernach 28–49, Köln 22–41, Wesel 6–20, Emmerich 1–9. See catalogue §3.7 and §8 C1.*

The same note gives times from Lobith onward (appendix 2): Nijmegen about 5 h, Tiel about 13 h, Zaltbommel about 19 h, IJsselkop about 5 h, Driel about 12 h, Amerongen about 25 h, Olst about 40 h, Katerveer (IJssel) about 48 h, with large spread. It says travel time depends strongly on floodplain storage; the floodplains start conveying water at about 7000 m³/s at Lobith.

**How the low-water values were measured:** LIVE PEGELONLINE requests, `GET https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/{uuid}/W/measurements.json?start=P30D`, 8 stations, 24 Aug–23 Sep 2026. Kaub was at 9–77 cm, below its NW of 25 cm (`stateMnwMhw: "low"`). I resampled hourly, applied a 6 h rolling mean and cross-correlated first differences. Measured legs:

| Leg | Lag | r |
|---|---|---|
| Kaub→Koblenz | 9 h | 0.57 |
| Koblenz→Köln | 16 h | 0.67 |
| Köln→Emmerich | 37 h | 0.57 |
| Emmerich→Lobith | 2 h | 0.78 |
| Cochem→Koblenz | 5 h | 0.45 |
| Trier UP→Cochem | – | 0.22 (useless: weir-regulated Moselle) |

**Moselle.** Trier (Moselle km about 195) → Koblenz: no published figure found. I estimate **about 20–30 h at flood** from distance and celerity (**UNVERIFIED**). A secondary search summary said "Moselle water takes about 3 days to reach the Netherlands" and "Upper Rhine water about 5 days to Lobith" (attributed to waterpeilen.nl / RWS pages). The exact wording and page are **UNVERIFIED**, because the RWS page is JS-rendered. Both figures are consistent with the table.

**Meuse:**

| Reach | Travel time | Source |
|---|---|---|
| Namur (Jambes) and Ourthe (Comblain-au-Pont) → Borgharen | **About 7 h**. This was the old RWS forecasting relation (levels there against Borgharen 7 h later) | [Lodder 1983, TU Delft thesis](https://repository.tudelft.nl/islandora/object/uuid:5f974fa8-3ed6-4d93-8824-fadeaeb3cae2), via WebFetch summary |
| Namur → Eijsden | Implied about 4–6 h from the line above. No direct figure found; **UNVERIFIED**, calibrate empirically | – |
| Chooz → Borgharen | **About 16 h**. From a search-engine summary with an unidentified source (**UNVERIFIED**); plausible for about 145 km at about 9–10 km/h | – |
| Eijsden-grens (rkm 2.56) → St. Pieter (10.80) | About 1 h under normal conditions | [RWS "Topafvoeren hoogwater Maas juli 2021" v2.0, 16-12-2021](https://edepot.wur.nl/568220) |
| July 2021 peak times (MEZT) | Eijsden-grens 15-7 21:50 (3195 m³/s) → St. Pieter 23:10 → Borgharen-dorp (16.00) 16-7 01:20 (**3.5 h**) → Venlo (107.47) 17-7 11:50 (**38 h**) → Megen (190.75) 19-7 07:30 (**82 h**) | Same report |
| French Meuse (Chalaines to the Chiers confluence, 230 km) | Floods propagate in 4–5 days | [Tailliez et al. 2000, Rev. Géogr. Est](https://journals.openedition.org/rge/4185) |

**Scheldt and Ems:** the reaches at the Dutch border are **tidal**. Levels there are dominated by the tide, which runs *upstream*, so "downstream travel time" does not apply to levels. Show these reaches differently (see §5).

---

## 5. Visualisation techniques ("see the water flow")

1. **Time slider replay (MVP).**
   - Hourly frames over a sliding window (7 days, growing from go-live), played back in about 10–20 s.
   - Colour stations by anomaly class relative to per-station reference values, never by absolute level, because gauge zeros differ. PEGELONLINE has the references (LIVE, Kaub): `gaugeZero 67.669 m ü. NHN (validFrom 2019-11-01)`, `NW 25`, `MW 208`, `HSW 640`, `HW 719`, `GlW 77`, `M_I 460`, and `currentMeasurement.stateMnwMhw: "low"`. Percentiles come later, once history has been backfilled.
   - For 5k points in MapLibre, use a `circle` layer with `feature-state` colours, or rebuild a GeoJSON per frame (a few fps).
   - For smooth 30–60 fps, use a deck.gl ScatterplotLayer and update a Uint8Array colour buffer of 5k × 4 bytes per frame.
2. **River segments coloured between stations.** Split each main stem at station snap points.
   - Simple version: colour each segment by interpolating its upstream and downstream stations. Optionally *time-shift* the upstream value by the edge travel time, so the colour band visibly travels.
   - Smooth version: a deck.gl PathLayer with per-vertex colours through binary attributes. MapLibre `line-gradient` cannot do per-feature gradients (not data-driven, no feature-state) unless every segment is its own layer.
3. **Flow-direction animation.**
   - MapLibre: cycle `line-dasharray` in `requestAnimationFrame` ("animate a line" pattern). Data-driven dash arrays are supported since GL JS 5.8.
   - deck.gl TripsLayer: one "trip" per river path, `timestamps` = cumulative travel hours from chainage and celerity, `currentTime` advanced by the app, `trailLength` a few hours. Moving pulses show direction and relative speed; colour them by anomaly.
   - These only work because OSM and EU-Hydro geometry is already downstream-oriented.
4. **Flood-crest tracking (later).** Detect peaks per station series, link successive peaks along the graph, and animate a crest marker with an "ETA at Lobith/Eijsden" band. Always label this as indicative, not a forecast.
5. **Space-time (Hovmöller) panel per river (strongly recommended, cheap).** x = river-km upstream→downstream, y = time, colour = anomaly. A flood wave appears as a diagonal band whose slope is the celerity. Canvas-rendered, linked to the map slider.
6. **Custom WebGL (later, most scalable).** Pack all station×time values into a data texture. Give each river vertex attributes (upstream station index, downstream station index, fraction, travel-time offset). A shader samples `value(t − offset)` using one uniform per frame. Build it as a deck.gl layer extension or a MapLibre custom layer.
   - MapLibre `global-state` (GL JS ≥ 5.6; not in Native) is another way to drive per-frame expressions without resending data. Performance is **UNVERIFIED**; prototype it.
7. **Colour and accessibility.**
   - Use a diverging, colour-blind-safe anomaly palette: low = brown/orange, normal = light neutral, high = blue→purple (ColorBrewer BrBG or PuOr, or Crameri "vik"/"roma", which are perceptually uniform). Avoid red/green.
   - Add redundant encodings: trend arrows (▲/▼), size for magnitude, and hatching for tidal reaches and stale data (for example no value for more than 2 h).
   - Leave the scale open-ended: the 2026 low water (Kaub 9 cm) is **below the recorded NW**.
   - Respect `prefers-reduced-motion` by stopping continuous animation and keeping step buttons. Make the slider keyboard-operable.
   - Check with a colour-vision-deficiency simulator (Chrome DevTools "Emulate vision deficiencies").
8. **Mobile performance.**
   - Cap the device pixel ratio (MapLibre `pixelRatio`, deck.gl `useDevicePixels`) at about 1.5–2.
   - Throttle animation to 20–30 fps and pause on `visibilitychange`.
   - Serve pre-aggregated hourly frames as compact binary (Int16 or Float32) instead of JSON.
   - Keep the basemap at z ≤ 14 with a muted style and few labels. Lazy-load deck.gl (about 575 KB gzipped for the full build).

---

## 6. Pitfalls observed

- OSM tile server: the "blocked" tile comes back with **HTTP 200** (header `x-blocked`) when the User-Agent is a default one.
- OpenFreeMap tile URLs contain a weekly version (`20260913_164504_pt`); resolve them through the TileJSON.
- VersaTiles OSM data was about 3.5 months old (2026-06-07).
- build.protomaps.com sends no CORS header, and hotlinking is discouraged; builds are kept for about a week.
- MapLibre v6 has no UMD bundle (`dist/maplibre-gl.js` returns 404).
- PEGELONLINE **LOBITH**:
  - 10-minute interval, while German gauges are 15-minute.
  - Contains **sentinel `99999.0`** values: 16 in 30 days, for example 2026-09-09T10:10+02:00.
  - `W` "WASSERSTAND ROHDATEN" with **no `gaugeZero`** field (values about 627–662 cm, presumably cm relative to NAP; the datum is **UNVERIFIED**).
- PEGELONLINE timestamps carry a local offset (`2026-08-24T22:30:00+02:00`); normalise to UTC.
- Moselle gauges come in weir pairs ("Trier UP"/"Trier OP"). Weir control destroys the propagation signal (r = 0.22).
- OSM relation roles are inconsistent (empty, `tributary`, `spring`/`mouth` nodes). Wikidata gives two relations each for Nahe and Lys.
- EU-Hydro: implausible Strahler values in the delta (Linge = 8), mixed-language names ("BOVENRIJN, WAAL"), EU Login needed for the bulk download, 2006–2012 base imagery.
- HydroRIVERS cannot represent the Rhine bifurcations, and its licence passes obligations on to end users.
- Overpass (all 3 instances), Geofabrik direct downloads, ccm.jrc.ec.europa.eu and api.mapsforeurope.org were unreachable through this sandbox's proxy. This is environmental and does not mean the services are down.

## 7. UNVERIFIED items (and why)

- Overpass API queries: all instances unreachable from the sandbox.
- Geofabrik file sizes: from WebFetch only, not HEAD.
- CCM2 access and licence: site returned 502 through the proxy.
- EuroGlobalMap and EuroRegionalMap exact licence: JavaScript single-page site, API unreachable.
- EU-Hydro bulk download size and procedure: requires EU Login.
- CARTO and VersaTiles terms: not reviewed.
- BKG basemap.de URL: returned 404 on my guessed path.
- OpenFreeMap retention of old tile versions: undocumented.
- CDN caching of PMTiles range requests: not tested.
- deck.gl `MapboxOverlay` with MapLibre v6, and MapLibre `global-state` animation performance: not prototyped.
- Travel times Maxau→Lobith, Trier→Koblenz, Chooz→Borgharen and Namur→Eijsden: no primary tables found. The values given are derived or secondary as marked.
- Belgian and French river-km systems: not checked.
- Dutch Lobith PEGELONLINE datum: not documented in the API response.

---

## Recommendation for phase planning

**MVP**
1. **Basemap:** MapLibre GL JS v6 with a Protomaps PMTiles regional extract at z0–14 (2.9 GB study area, or 4.3 GB full Rhine basin) plus planet z0–6 (45 MB), self-hosted on object storage or a CDN with a muted style. OpenFreeMap positron is the automatic fallback and the development default. Put the attribution strings in place from day one.
2. **Stations:** a MapLibre `circle` layer (≤ 5k points) coloured by anomaly class against per-station reference levels (for example PEGELONLINE MNW/MW/MHW), with a stale-data style.
3. **Time slider:** hourly frames over a rolling window that grows from go-live, with play/pause/step and reduced-motion support.
4. **River network:** main stems of about 40–60 rivers from OSM relations (osmium over Geofabrik), split at stations, coloured by interpolation between stations, with direction shown by an animated dash. Publish the derived river GeoJSON under ODbL. Keep station data as a separate collective layer.
5. **Graph and chainage:** a directed DAG with bifurcations. Chainage from official river-km (PEGELONLINE `km`, RWS rkm), with graph distance as fallback. Snap stations by water-body name plus distance, with a manual override table.
6. **Static travel-time priors** from §4.2, shown only as "typical, indicative" text. Do not show ETAs.

**Later phases**
- deck.gl overlay: TripsLayer pulses, per-vertex gradient rivers, and eventually a data-texture shader.
- Space-time (Hovmöller) panel per river. It is cheap and very effective, so it is a candidate for an early post-MVP release.
- Empirical, regime-dependent travel-time calibration (cross-correlation per edge per flow class, which needs weeks to months of data). Then flood-crest tracking with indicative ETAs at Lobith and Eijsden.
- Historical backfill, which enables percentile-based anomalies.
- EU-Hydro-based QA (and possibly EU-Hydro 2.0). HydroRIVERS upstream area and discharge priors, for internal use only.
- Dedicated rendering for tidal reaches (Scheldt, Ems estuary, lower Rhine and Meuse branches).

**Risks**
- **Dependencies without an SLA:** OpenFreeMap and OSM tiles, hence self-hosted PMTiles as primary.
- **Licences:** ODbL share-alike on the OSM-derived graph, which is manageable by publishing it. HydroSHEDS passes licence terms on to end users, so do not redistribute it. CCM2 is non-commercial, so exclude it.
- **Travel times vary 1.5–2×** between low water and flood, and floodplain storage and weirs distort them. Present them as indicative and add a "not an official warning service" disclaimer.
- **Weir-regulated reaches** (Moselle, Main, Neckar, Walloon Meuse, the Upper Rhine barrages) show stepped levels that do not propagate cleanly. Anomaly colouring and the choice of stations must account for this.
- **Data quality:** sentinel values (99999), mixed time intervals (10 vs 15 minutes), local-offset timestamps, differing datums.
- **Frontend:** MapLibre v6 is ESM-only, and deck.gl/MapLibre versions are coupled. Prototype the overlay early.
- **Mobile:** battery and performance under continuous animation. Throttle, cap the pixel ratio, and pause when the page is hidden.

**Files and sources**
- Local scratch data: `(research-session scratch files, not kept)` (PEGELONLINE 30-day series in `po/`, RWS PDFs `gwio85006.pdf` and `maas2021.pdf`, the `go-pmtiles` binary in `bin/`).
- Web sources:
  - [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  - [OSMF attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
  - [OpenFreeMap](https://openfreemap.org/) and its [terms](https://openfreemap.org/tos/)
  - [Protomaps downloads](https://docs.protomaps.com/basemaps/downloads) and [layers](https://docs.protomaps.com/basemaps/layers)
  - [HydroRIVERS](https://www.hydrosheds.org/products/hydrorivers), [HydroSHEDS tech doc and licence](https://data.hydrosheds.org/file/technical-documentation/HydroSHEDS_TechDoc_v1_4.pdf), [HydroSHEDS v2](https://www.hydrosheds.org/products/hydrosheds-v2)
  - [EU-Hydro metadata (EEA)](https://sdi.eea.europa.eu/catalogue/copernicus/api/records/393359a7-7ebd-4a52-80ac-1a18d5f3db9c)
  - [MapLibre style spec](https://maplibre.org/maplibre-style-spec/layers/) and [expressions](https://maplibre.org/maplibre-style-spec/expressions/)
  - [deck.gl TripsLayer](https://deck.gl/docs/api-reference/geo-layers/trips-layer) and [PathLayer](https://deck.gl/docs/api-reference/layers/path-layer)
  - [RWS looptijden Rijn 1985](https://open.rijkswaterstaat.nl/@87627/looptijden-hoogwatergolven-rijn/), [RWS looptijden Maas 1967](https://open.rijkswaterstaat.nl/zoeken/@91286/looptijden-hoogwatergolven-maas/), [RWS topafvoeren Maas juli 2021](https://edepot.wur.nl/568220)
  - [LfW RLP Hochwasser 1999](https://www.hochwasser.rlp.de/static/shared/documents/rhein_1999.pdf), [BfG Undine 1993](https://undine.bafg.de/rhein/extremereignisse/rhein_hw1993.html)
  - [Lodder 1983](https://repository.tudelft.nl/islandora/object/uuid:5f974fa8-3ed6-4d93-8824-fadeaeb3cae2), [Tailliez et al. 2000](https://journals.openedition.org/rge/4185)
  - [CHR Rhine Alarm Model brochure](https://www.chr-khr.org/sites/default/files/chrpublications/brochure_ram_e.pdf)
  - [Geofabrik Europe](https://download.geofabrik.de/europe.html)