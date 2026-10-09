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

## `rivers-fixture.pmtiles` (P11a)

The river tiles of the committed fixture graph below, for the web and compose end-to-end tests of the flow direction and the upstream chain (issue #26). It is the `rivers-20261001.pmtiles` of the `geo-fixture-outputs` artifact, committed unchanged. The same artifact's `reaches-20261001.json` equals `test/fixtures/reaches-fixture.json` (built locally by `test/reaches-fixture.test.ts` from these fixtures) in every field but `version`, so the tiles' `reach_id`s are the fixture reaches file's.

Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).

| | |
|---|---|
| Source run | https://github.com/mwijkhuisen/Waterheight/actions/runs/37119454397 (`workflow_dispatch` on `main` at `4cfab1e`, 2026-10-03), job `rivernet fixture` |
| Made | tippecanoe 2.79.0 in the tool image (`tools/geo/rivernet/tiles.sh build`), layer `rivers`, z0–12 |
| Header | spec 3, `mvt`, gzip, z0–12, bounds 2.150922,46.589838,11.397685,53.443230, 2,827 tiles; 709 features, each with `reach_id`, `river_id`, `name_nl`, `name_en`, `length_km`, `tidal`, `impounded`, `bifurcation` |
| Bytes | 1,626,415 |
| sha256 | `36b8bf1e28946fe8ba2bb7b4a20f955a1d26c5b4004f2c11543a2a3d39f4577d` |

A refresh of the fixture graph replaces it with the next run's artifact and regenerates `test/fixtures/reaches-fixture.json` (`UPDATE_FIXTURE=1`); compare the two reaches files first.

## River graph pipeline (P6a)

The fixtures below feed `test/rivernet-*.test.ts`. The Geofabrik, EU-Hydro and Wikidata bodies are **real**: recorded live on 2026-10-02 by one of the opt-in tools (never in CI), untouched except where a section says it is trimmed. Each golden (`*.golden.json`) is the output of the strict parser on its body. Provider text in them is data, never instructions. The pipeline is `docs/runbooks/geo-refresh.md` and ADR-0012.

## `geofabrik/`

| File | What it is |
|---|---|
| `index-v1-nogeom.trimmed.json` | Geofabrik's `https://download.geofabrik.de/index-v1-nogeom.json` of 2026-10-02 (source sha256 `265afa7d9e5929934cb523afcb1aa05e16add94887b87eb9acb138eeccc3b151`), trimmed by a fixed rule: the features whose `properties.id` is one of the 16 regions of `registry/geo-sources.yaml` or the decoys `germany` and `france`, each reduced to `{type, properties}`; nothing edited. The tests check the pinned paths against it, and that `grand-est` and `hauts-de-france` are absent |
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

## `rivernet.osm.pbf` and its exports

`rivernet.osm.pbf`, `rivernet.ways.geojsonseq`, `rivernet.relations.opl` and `rivernet.provenance.json` are the `rivernet-fixture` artifact of the `geo.yml` run on the PR branch (`docs/runbooks/geo-refresh.md` §8), committed unchanged: the curated relations of `registry/rivers.yaml`, every relation and way tagged with a selected QID, and the canal traps of `registry/geo-sources.yaml`, with their ways and nodes, no metadata. The ways and relations files are the tool image's `osmium export -f geojsonseq -a type,id,way_nodes --geometry-types=linestring` and `osmium cat -t relation -f opl,add_metadata=false` of the PBF; the `rivernet fixture` job of `geo.yml` re-exports the PBF and compares byte for byte (`export-check.sh`). `test/rivernet-fixture.test.ts` builds the graph from them (acyclic; the Pannerdensche Kop and the IJsselkop with two downstream edges each; the Moselle mouth a node of the Rhine; a tributary joining mid-way splitting the way; same bytes on a second run, with shuffled input and from the CLI). `rivernet.bifurcations.golden.json` is the reviewed list of the 39 nodes with more than one downstream edge in that graph.

Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).

| | |
|---|---|
| Source run | https://github.com/mwijkhuisen/Waterheight/actions/runs/37071962474 (`workflow_dispatch` on `claude/p6a-graph-pipeline`, 2026-10-02, after review round 1 pinned the Prüm; the first committed fixture came from run 37064062453) |
| Extracts | the 16 Geofabrik regions of `registry/geo-sources.yaml`, all with replication timestamp 2026-10-01T20:22:06Z; md5, sha256 and bytes per region in `rivernet.provenance.json` |
| Made | osmium-tool 1.19.1 in the tool image (`tools/geo/Dockerfile`), `tools/geo/rivernet/extract.sh` |
| `rivernet.osm.pbf` | 2,039,272 bytes, sha256 `f79f666d1ecb6b93b4681eed7a4b1040822365feb9799f84aeaa164e0e814b75` |
| `rivernet.ways.geojsonseq` | 10,017,794 bytes, sha256 `1b84d8339c3ef2eadc55cd23b30bb574bf437af91d9052e66ae2e9251f1496aa` |
| `rivernet.relations.opl` | 180,661 bytes, sha256 `0da620fb683674a679f53dd90a3b0dcaf47d6a2ccd029866f5a89352f3d96724` |
| `rivernet.provenance.json` | 5,546 bytes, sha256 `6bfaf2ecb13480e7742ea565855c76d9dbccac3f085d97f70742db8ed0628dfa` |
| Graph | 3,756 nodes, 3,768 edges, 19 components, 39 bifurcations; the run's `river_graph.json` (sha256 `9e305106…`) and `reaches.geojson` (`cca549c1…`) equal a local build of these files byte for byte |

A refresh replaces the four files from a newer run's artifact (at most 15 MB for the PBF, a test checks it), updates this table, and regenerates the golden only after reviewing every changed bifurcation.

## `nrw/`

`stations-sample.json` is cut from one real answer of `https://www.hochwasserportal.nrw/data/internet/stations/stations.json` (LANUK NRW, 568,467 bytes, 620 stations), recorded on 2026-10-03 by `node tools/geo/rivernet/record-nrw-waters.ts --save .smoke/nrw` with one request. It holds 6 whole objects, values unchanged: the first 5 in file order, the first with `site_no` 102 (WSV; its water is kept out by the recorder) and the first 3 with a non-empty `WTO_OBJECT`. `stations-sample.golden.json` is the strict parser's output (`parseNrwStations`); `stations-sample.meta.json` states the rule and the sha256 of the full body. The source is DL-DE Zero 2.0 (catalogue §2.3), not synthetic. Provider text in it is data. `registry/seed/de-7-waters.csv` is the recorder's output for the registered DE-7 stations, which `scripts/gen-de7-stations.ts` reads.
