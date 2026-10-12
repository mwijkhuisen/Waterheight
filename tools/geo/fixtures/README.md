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

The river tiles of the committed fixture graph below, for the web and compose end-to-end tests of the flow direction and the upstream chain (issue #26). It is the `rivers-20261001.pmtiles` of the `geo-fixture-outputs` artifact, committed unchanged. The same artifact's `reaches-20261001.json` equals `test/fixtures/reaches-fixture.json` (built locally by `test/reaches-fixture.test.ts` from these fixtures) in every field but `version`, so the tiles' `reach_id`s are the fixture reaches file's. Replaced twice for #110: PR 1 (the Ourthe join splits the Meuse reach at Liège: Meuse `seq` from there on is one higher) and PR 2 (the refreshed fixture, OSM 2026-10-09, with the Vesdre and the Amblève; the Ourthe cut at their confluences). Replaced for #112 PR B: the same graph with the second layer `reach_bins` (the reach position bins, from zoom 8). Replaced for #100 (the 31 tier-1 tributaries). Replaced for #126 (the 36 two-gauge tributaries). Replaced for #125 (the Linth, the Kander and the Simme).

Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).

| | |
|---|---|
| Source run | https://github.com/mwijkhuisen/Waterheight/actions/runs/38212139095 (`workflow_dispatch` on `claude/fix-125-lake-tributaries` at `05ed261`, 2026-10-12), job `rivernet fixture` |
| Made | tippecanoe 2.79.0 in the tool image (`tools/geo/rivernet/tiles.sh build` with the bins input), layers `rivers` and `reach_bins`, z0–12 |
| Header | spec 3, `mvt`, gzip, z0–12, bounds 2.150922,46.330476,11.397685,53.443230, 3,521 tiles. Layer `rivers`: one feature per drawn reach (1,092 reaches in the file), each with `reach_id`, `river_id`, `name_nl`, `name_en`, `length_km`, `tidal`, `impounded`, `bifurcation`. Layer `reach_bins`: 6,634 bins (1 to 8 per reach; the file's tilestats, equal to the sum of `binCount` over the 1,092 reaches of the fixture), each with `reach_id`, `bin`, `seg` and `tidal`, in the tiles of zoom 8 and up only (a z5 or z7 tile holds `rivers` alone) |
| Bytes | 3,567,801 |
| sha256 | `2c4411b35ed9998c6469b5678d7e24e72a65d2a0cbdf61b323e3ad1b360168d7` |

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

`rivernet.osm.pbf`, `rivernet.ways.geojsonseq`, `rivernet.relations.opl` and `rivernet.provenance.json` are the `rivernet-fixture` artifact of the `geo.yml` run on the PR branch (`docs/runbooks/geo-refresh.md` §8), committed unchanged: the curated relations of `registry/rivers.yaml`, every relation and way tagged with a selected QID, and the canal traps of `registry/geo-sources.yaml`, with their ways and nodes, no metadata. The ways and relations files are the tool image's `osmium export -f geojsonseq -a type,id,way_nodes --geometry-types=linestring` and `osmium cat -t relation -f opl,add_metadata=false` of the PBF; the `rivernet fixture` job of `geo.yml` re-exports the PBF and compares byte for byte (`export-check.sh`). `test/rivernet-fixture.test.ts` builds the graph from them (acyclic; the Pannerdensche Kop and the IJsselkop with two downstream edges each; the Moselle mouth a node of the Rhine; a tributary joining mid-way splitting the way; same bytes on a second run, with shuffled input and from the CLI). `rivernet.bifurcations.golden.json` is the reviewed list of the 56 nodes with more than one downstream edge in that graph.

Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).

| | |
|---|---|
| Source run | https://github.com/mwijkhuisen/Waterheight/actions/runs/38209008630 (`workflow_dispatch` on `claude/fix-125-lake-tributaries` at head `28b8f50`, 2026-10-12; #125, which added the relations of the Linth, the Kander and the Simme). Earlier: run 38127563889 (`claude/fix-126-two-gauge-tier` at head `58f51ec`, 2026-10-11; #126, which added the 36 two-gauge tributaries and the relations of 21 of them; the review round put the Eisch back), run 38072080277 (`claude/fix-100-river-tiers` at head `37f2eed`, 2026-10-10; #100, which added the 31 tier-1 tributaries and the 13 tier-1 relations), run 38006225186 (`claude/fix-110-vesdre-ambleve`, 2026-10-09; #110 PR 2, which added the Vesdre and the Amblève), run 37071962474 (`claude/p6a-graph-pipeline`, 2026-10-02, OSM 2026-10-01, after review round 1 pinned the Prüm), and the first committed fixture came from run 37064062453. The distances in the `reason`s of `registry/snap-overrides.yaml` were measured on the 2026-10-01 fixture, except the two #110 `waters` rows (Vesdre, Amblève) and the #100 rows marked OSM 2026-10-10 (Wark, Syre, Helpe Majeure, Murgenthal), measured on this one |
| Extracts | the 16 Geofabrik regions of `registry/geo-sources.yaml`, with replication timestamps all 2026-10-11T20:21:06Z (the #125 run downloaded all 16 extracts again, so every region's md5, sha256 and bytes differ from the #126 fixture, whose extracts were from 2026-10-08 and 2026-10-09; the #126 run had downloaded the same extracts as the #100 run, and only the Baden-Württemberg and Bayern extracts had changed against the #110 fixture); md5, sha256 and bytes per region in `rivernet.provenance.json`. The new extract also carries the OSM edits of those days: 10 ways of the earlier fixture moved (Hinterrhein, Ruhr, Sieg, Alme and Wark), and the list of bifurcations is unchanged |
| Made | osmium-tool 1.19.1 in the tool image (`tools/geo/Dockerfile`), `tools/geo/rivernet/extract.sh` |
| `rivernet.osm.pbf` | 2,956,997 bytes, sha256 `df91f95e6243e8e9240a5c8ac237f0dca93766c4553096d03a82f5004afa454a` |
| `rivernet.ways.geojsonseq` | 14,541,124 bytes, sha256 `ee04ce5a8d1d2007e53f6fc6fbdbcaf71ce0a49f5c1a344c79dbb44e7500e130` |
| `rivernet.relations.opl` | 237,438 bytes, sha256 `11912498c9e237db68312a29e7ca6380bdfeeae90aca29343777f42f307553de` |
| `rivernet.provenance.json` | 5,546 bytes, sha256 `6ce530d7129cbf44b4ec352538f9a4efc640539e7812f844097cb097d8cf8b34` |
| Graph | 5,710 nodes, 5,724 edges, 32 components, 56 bifurcations (the #126 fixture: 5,671 nodes, 5,686 edges, 31 components, 56 bifurcations; the #100 fixture: 4,779 nodes, 4,793 edges, 25 components, 48 bifurcations; the #110 fixture: 3,808 nodes, 3,820 edges, 19 components, 39 bifurcations; the first one, OSM 2026-10-01: 3,756 nodes, 3,768 edges); the 56 bifurcations are the same nodes as in the #126 fixture (the three new rivers add none: the Linth is detached, the Kander ends on a node of the Aare and the Simme on one of the Kander) and the golden is unchanged; the 8 that #126 added against the #100 fixture are in new rivers (side channels in Zorn 2, Nied française, Mouzon 2, Hessel and Clarence, and a 47 m dead-end stub in the Yron), and two Moder bifurcations only renumber an outgoing way split; the run's `river_graph.json` (sha256 `29cf8fc0…`) equals a local build of these files byte for byte (`reaches.geojson`: `37df8c8b…`) |

A refresh replaces the four files from a newer run's artifact (at most 15 MB for the PBF, a test checks it), updates this table, and regenerates the golden only after reviewing every changed bifurcation.

## `nrw/`

`stations-sample.json` is cut from one real answer of `https://www.hochwasserportal.nrw/data/internet/stations/stations.json` (LANUK NRW, 568,467 bytes, 620 stations), recorded on 2026-10-03 by `node tools/geo/rivernet/record-nrw-waters.ts --save .smoke/nrw` with one request. It holds 6 whole objects, values unchanged: the first 5 in file order, the first with `site_no` 102 (WSV; its water is kept out by the recorder) and the first 3 with a non-empty `WTO_OBJECT`. `stations-sample.golden.json` is the strict parser's output (`parseNrwStations`); `stations-sample.meta.json` states the rule and the sha256 of the full body. The source is DL-DE Zero 2.0 (catalogue §2.3), not synthetic. Provider text in it is data. `registry/seed/de-7-waters.csv` is the recorder's output for the registered DE-7 stations, which `scripts/gen-de7-stations.ts` reads.
