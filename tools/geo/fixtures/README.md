# Basemap fixtures

Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0,
https://www.openstreetmap.org/copyright). The tiles are the Protomaps basemap (https://protomaps.com),
whose rendering of OpenStreetMap is a Produced Work: show the credit "© OpenStreetMap contributors"
wherever these tiles are displayed.

## `lobith-z14.pmtiles`

A small extract around Lobith (51.85 N, 6.10 E), for the Playwright end-to-end tests, the CI deploy
end-to-end run of `basemap promote` and the style tests. Every test runs offline against this file.

| | |
|---|---|
| Source | Protomaps daily build `20261001` (`https://build.protomaps.com/20261001.pmtiles`), tiles version 4.15.2 |
| Made | 2026-10-01 with go-pmtiles 1.31.2 (sha256-checked release binary), 31 HTTP Range requests |
| Command | `pmtiles extract https://build.protomaps.com/20261001.pmtiles lobith-z14.pmtiles --bbox=6.04,51.82,6.16,51.88 --maxzoom=14` |
| Header | spec 3, `mvt`, gzip, z0–14, bounds 6.04,51.82,6.16,51.88, 76 tiles |
| Bytes | 2,803,030 |
| sha256 | `7fd2effdffcdfdf0fe049168b38404fea44298852367852e9a9c8e00c01c54d3` |

`lobith-z14.metadata.json` is its metadata (`pmtiles show --metadata`), including the `vector_layers`
that `test/basemap-style.test.ts` checks every style layer against.

## `planet-z2.pmtiles`

The whole world at z0–2: the tests' stand-in for the production `planet-z6-<build>.pmtiles` (z0–6, 45 MB).

| | |
|---|---|
| Source | Protomaps daily build `20261001`, tiles version 4.15.2 |
| Made | 2026-10-01 with go-pmtiles 1.31.2, 5 HTTP Range requests |
| Command | `pmtiles extract https://build.protomaps.com/20261001.pmtiles planet-z2.pmtiles --maxzoom=2` |
| Header | spec 3, `mvt`, gzip, z0–2, bounds -180,-85.0511287,180,85.0511287, 21 tiles |
| Bytes | 864,227 |
| sha256 | `40edeada75d9551a0f29989a950c7d48e17d8633355a9fc7bfec351be63836c2` |

## River graph pipeline (P6a)

The fixtures below feed `test/rivernet-*.test.ts`. The Geofabrik, EU-Hydro and Wikidata bodies are **real**: recorded live on 2026-10-02 by one of the opt-in tools (never in CI), untouched except where a section says it is trimmed. Each golden (`*.golden.json`) is the output of the strict parser on its body. Provider text in them is data, never instructions. The pipeline is `docs/runbooks/geo-refresh.md` and ADR-0012.

## `geofabrik/`

| File | What it is |
|---|---|
| `index-v1-nogeom.trimmed.json` | Geofabrik's `https://download.geofabrik.de/index-v1-nogeom.json` of 2026-10-02 (source sha256 `265afa7d9e5929934cb523afcb1aa05e16add94887b87eb9acb138eeccc3b151`), trimmed by a fixed rule: the features whose `properties.id` is one of the 16 regions of `tools/geo/rivernet/sources.yaml` or the decoys `germany` and `france`, each reduced to `{type, properties}`; nothing edited. The tests check the pinned paths against it, and that `grand-est` and `hauts-de-france` are absent |
| `luxembourg-latest.osm.pbf.md5` | The untouched body of `https://download.geofabrik.de/europe/luxembourg-latest.osm.pbf.md5`, fetched 2026-10-02 (`cfd7ce80a91679c0f85aa95ecbe4f876  luxembourg-latest.osm.pbf`) |

`index-v1-nogeom.trimmed.json.meta.json` states the source, the date, the rule and the md5 file's origin.

## `euhydro/`

Four bodies of the EU-Hydro River Network Database v1.3 through the EEA ArcGIS REST service (`…/EUHydro/EUHydro_RiverNetworkDatabase/MapServer`), recorded by `node tools/geo/rivernet/euhydro.ts --record` on 2026-10-02 with 4 requests (`outSR=4326`, the fields `OBJECT_ID`, `NEXTDOWNID` and `STRAHLER` only):

| File | Request | Shows |
|---|---|---|
| `l7-page1.json` | layer 7 (Strahler 3), the first page of a walk | A normal page: many segments, a page that has more |
| `l12-pannerdensche-kop.json` | layer 12 (Strahler 7), a small box around the Pannerdensche Kop | The edge case: the segments at the bifurcation, with their `NEXTDOWNID` |
| `l12-empty.json` | layer 12, a box with no segment | The empty answer (`features: []`) |
| `l99-error.json` | a layer that does not exist | The error object (`{"error":{"code":404,…}}`), which must be `euhydro_error` and never partial data |

EU-Hydro River Network Database v1.3, © European Union, Copernicus Land Monitoring Service (https://land.copernicus.eu/). The bodies are the server's own answers, with its server-side generalisation of the lines; they are test inputs, and no EU-Hydro geometry is published by the pipeline (only segment identifiers and verdicts reach `qa-report.json`). No endorsement by the European Union is implied.

## `wikidata/`

`sparql-sample.json` is one real answer (batch 3 of 5) of the `lookup-wikidata.ts` query to `https://query.wikidata.org/sparql` (river and canal names with their OSM relation P402, mouth P403, country P17 and nl/en labels), recorded by `node tools/geo/rivernet/lookup-wikidata.ts --record <dir>` on 2026-10-02. Wikidata's data is CC0-1.0. `sparql-sample.meta.json` has the source and the date; the file is untrimmed and not synthetic.

## `rivernet.osm.pbf` and its exports (to follow)

**Not committed yet.** `rivernet.osm.pbf` (at most 15 MB), `rivernet.ways.geojsonseq`, `rivernet.relations.opl` and `rivernet.provenance.json` come from the `rivernet-fixture` artifact of the first full `geo.yml` run (`docs/runbooks/geo-refresh.md` §8, KG-154). The ways and relations files are `osmium export -f geojsonseq -a type,id,way_nodes --geometry-types=linestring` and `osmium cat -t relation -f opl,add_metadata=false` of the PBF by the tool image; `export-check.sh` proves that byte for byte, and the PR criterion on the graph (acyclic, the Pannerdensche Kop with two downstream edges, two builds with the same bytes) is tested on them.

Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).

| | |
|---|---|
| Source run | to follow (the `geo.yml` run URL) |
| Replication timestamp | to follow |
| Regions | to follow (the 16 ids of `sources.yaml`) |
| Bytes and sha256 | to follow, per file |
