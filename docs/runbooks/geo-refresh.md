# Runbook: the river graph refresh

**Trigger:**
- the first run after the P6a merge (issue #21): the owner dispatches `geo.yml` on `main`, and a release `geo-<UTC date>` appears (`docs/plan/PHASES.md` §21, KG-151);
- the monthly schedule (`23 4 3 * *`, 04:23 UTC on the 3rd), and any failed or missed run of it;
- a change of `registry/rivers.yaml` that should reach a release without waiting for the 3rd;
- a failed `rivernet fixture` job on a pull request (§5, §9).

The river graph is a directed graph of the rivers that feed the Netherlands, built from OpenStreetMap in GitHub Actions (ADR-0012). A run downloads 16 Geofabrik extracts, filters them to the waterway relations and the selected ways, builds the graph (`tools/geo/rivernet/build.ts`), checks its direction against EU-Hydro and publishes nine signed assets as the release `geo-<date>`: `river_graph.json`, `reaches.geojson`, `qa-report.json`, `rivers-<ver>.pmtiles`, `reaches-<ver>.json`, `rivers-<ver>.geojson.gz`, `snap-report.json`, `VERSION` and `SHA256SUMS` (the first three are the P6a graph assets, the next five P6b's). Since P17b the run also extracts the water bodies of `registry/waterbodies.yaml`, and the tiles and the download carry the bodies and the canals (§11). Nothing in production reads the release before P6b (`rws-rivers-refresh`, which verifies the signature). Everything runs on GitHub; there is no VPS step and no secret.

## 1. The rules it keeps

| Rule | Consequence |
|---|---|
| Fetch targets come only from `registry/geo-sources.yaml` (invariant 1) | The 16 Geofabrik URLs, the EU-Hydro MapServer and the Wikidata endpoint are constants of that file. A run takes no input from outside: a new region or host is a reviewed change |
| Geofabrik has no Grand-Est or Hauts-de-France extract | The French regions are the old `alsace`, `lorraine`, `champagne-ardenne`, `nord-pas-de-calais` and `picardie`. `download.ts --check-index` compares every pinned path with `index-v1-nogeom.json` at the start of each run |
| No cache (owner decision, 2026-10-02) | Geofabrik rebuilds every `-latest` file daily and `scripts/check-workflows.sh` forbids `actions/cache`. Every run downloads about 7.4 GB again. A failed download costs the run |
| Newest version wins | Geofabrik cuts the regions at different moments (on 2026-10-02 Belgium was a day newer than the rest), so a border object can sit in two extracts in two versions: `extract.sh` merges with `osmium merge -H` (all versions) and keeps the newest valid version of each object with `osmium time-filter` (no time given), records each region's replication timestamp in the provenance, and refuses extracts more than 72 h apart (`extract_dates_too_far_apart`). The builder fails on a duplicate way |
| Never edit an extract | The only ways to change what a run builds are `registry/rivers.yaml` (a river, an `osm_relation_id`, `drop_ways`) and `registry/geo-sources.yaml`, both through a reviewed PR |
| The tool image is built in the run and never leaves it | osmium-tool is GPL-3.0; the image is not pushed, uploaded or released. It runs with no network, no capabilities, a read-only root and the runner's uid (T-GEO-2) |
| Only `rivernet-publish` writes, and only on main | It has no checkout and runs no repository code. A branch run builds and uploads artifacts and publishes nothing (T-GEO-4) |
| A published release is never rewritten | The same day with the same `SHA256SUMS` is a no-op; different sums fail (§7) |
| EU-Hydro never fails the build | It is a QA of direction (§4); no EU-Hydro geometry is published. A budget of 300 requests, at least 1 s apart, a 20-minute deadline (`max_minutes`) and at most 400,000 segments (T-GEO-5) |
| The release holds no OSM name, no station and no value (D15) | `river_graph.json` and `reaches.geojson` carry way and node IDs, coordinates, lengths and river slugs of `registry/rivers.yaml`; `qa-report.json` adds counts, our own IDs and EU-Hydro segment IDs. All three carry the ODbL-1.0 licence and the attribution "© OpenStreetMap contributors". Only `build-report.json` holds OSM name strings (the curated relations' `name` tags, for review), and it is not published (§4) |

## 2. Dispatch a run (the owner, after the merge)

`geo.yml` publishes only from `main`. A dispatch on any other ref builds and uploads the artifacts and skips `rivernet-publish`.

1. GitHub → Actions → **geo** → *Run workflow* → branch `main`; or:

   ```bash
   gh workflow run geo.yml --ref main
   gh run list --workflow geo.yml --limit 3
   gh run watch <run id>
   ```
2. The Actions variables `RWS_DOMAIN` and `RWS_CONTACT_EMAIL` must be set (Settings → Secrets and variables → Actions → Variables): they make the User-Agent that Geofabrik and the EU-Hydro server see. Without them `extract.sh` and `euhydro.ts` stop with exit 78 before a request.
3. Do not start two runs on `main` together: the concurrency group `geo-<ref>` queues the second one, but a second dispatch the same day only ends in the no-op of §7.

## 3. What the jobs do

| Job | When | Does | Time |
|---|---|---|---|
| `style` | pull request, dispatch, schedule | The P3 basemap checks: the generated styles and one download of the pinned `basemaps-assets` commit | minutes |
| `rivernet fixture` | pull request, dispatch, schedule | Builds the tool image; re-exports the committed fixture PBF and compares the two exports byte for byte (`export-check.sh`); builds the fixture graph twice and compares the sha256 of the three outputs. Offline once the image is built (the build itself downloads three tarballs from codeload.github.com and Debian packages). Passes with "no fixture yet" until the first full run's fixture is committed | limit 45 min |
| `rivernet build` | dispatch and schedule only | Builds the image; `extract.sh` downloads the 16 regions **one at a time** (md5 first, then the PBF; checks, filters, deletes the PBF), checks that the extracts are at most 72 h apart, merges (newest version of each object), selects, exports; uploads the artifact `rivernet-fixture` (P17b: seven files, the water-body ones included; with the dispatch input `probe` also the artifact `rivernet-probe`, §11); builds the graph; runs the EU-Hydro check; writes `SHA256SUMS`, the job summary and uploads the artifact `geo-assets` (14 days each) | limit 240 min; the real time is not measured yet (KG-151) |
| `rivernet publish` | main only, after `rivernet build` | Checks `sha256sum -c`, signs each of the nine assets keyless, verifies each signature, creates the release `geo-<UTC date>` as a draft (`--target $GITHUB_SHA --latest=false`) and publishes it (an existing release of the tag: §7) | minutes |

The artifacts of one run are the ones that run publishes: `rivernet-publish` downloads `geo-assets` of its own run, never another run's.

## 4. Reading the result

The **job summary** of `rivernet build` ("Graph pipeline") lists the size of `river_graph.json`, `reaches.geojson` and `qa-report.json` and `agreement_pct`. The build step's own line is `build: <n> nodes, <n> edges, <n> components, <n> bifurcations`; the EU-Hydro step prints `euhydro: <n> agree, <n> disagree, <n> unmatched, <n> requests, complete <true|false>`.

`qa-report.json` (an asset of the release; `jq . qa-report.json`):

| Field | Meaning |
|---|---|
| `attribution`, `attribution_url`, `licence` | The ODbL head ("© OpenStreetMap contributors", ODbL-1.0), as on the other two data assets |
| `build` | `build-report.json` without the relation tags of each river: the counts, `ways_kept`, `qid_relations`, `components` and the `graph` section. No OSM name string |
| `euhydro.source`, `modifications`, `endorsement` | The citation (EU-Hydro v1.3, © European Union, Copernicus Land Monitoring Service), what we changed (our own reach geometry compared with its segments; nothing of its geometry is kept) and the no-endorsement text |
| `euhydro.agree`, `disagree`, `unmatched`, `agreement_pct`, `agreement_basis` | Per reach: our digitised direction against EU-Hydro's. `agreement_pct` is agree ÷ (agree + disagree), the edges matched within 200 m (`agreement_basis` says so); a tie counts as a disagreement. P6b's criterion is 98% or more (KG-152) |
| `euhydro.unscored`, `unscored_count` | (P17a) The edges with direction `none` (the tidal zone and the canals), which have no direction to compare: listed (sorted) and counted, not in `agreement_pct`, within the same bounding box and budget |
| `euhydro.unmatched_edges` | The edges (sorted) with less than half their length within 200 m of a segment, or with no length: not in the percentage |
| `euhydro.requests`, `complete`, `layers`, `error` | The budget used. `complete: false` with an `error` code (`euhydro_http`, `euhydro_error`, `euhydro_body_too_large`, `euhydro_bad_json`, `euhydro_bad_shape`, `euhydro_timeout` past `max_minutes`, `euhydro_too_many_segments` past 400,000 segments) means the QA stopped early: the build still passed and the percentage covers less. Run again later |
| `euhydro.disagreements` | `edge` (our `w<way>.<k>`), `OBJECT_ID` and `NEXTDOWNID` of the EU-Hydro segment. Look at the edge on openstreetmap.org (the way id is in the name): a way digitised against the flow shows up here. A real river flowing the other way in OSM is fixed in OSM, not in our extract |

Direction is read from the matched piece of the digitised geometry (catalogue §5.3): each sample's tangent is compared with the straight piece of the segment it matched, never with the segment's chord (a meander's chord can point against the river). It is not read from `NEXTDOWNID`, which cannot express a bifurcation (`docs/sources/research/map-rivers.md`), and Strahler is not used (the Linge pitfall). EU-Hydro's layers 5 to 12 are Strahler 1 to 8; layer 13 is empty in our area; the server answers in EPSG:3857 and the QA asks `outSR=4326`.

`build-report.json` (per-river counts, drops by role, the curated relation's tags with its `name` tags as the seed for reviewed names, sources, sinks, components, the bifurcations with their out edges, and the relations in the extract that carry a river's QID) is written next to the assets on the runner but is not an asset or an artifact. To read it, download the `rivernet-fixture` artifact and run the builder on it (§8, first command): the rebuild gives the same bytes as the run.

## 5. When the build fails

A fatal build error stops the job, the artifact `rivernet-fixture` is already uploaded (it is uploaded before the build for this reason), and nothing is published. The builder's line is `build: <code> <ids>` with way or relation IDs, never provider text.

| Code | Meaning | Do |
|---|---|---|
| `extract_dates_too_far_apart` (from `extract.sh`) | The oldest and the newest of the 16 extracts are more than 72 h apart: a Geofabrik region has not been rebuilt for days | Run again later; if it persists, check Geofabrik's status page. Different dates within 72 h are normal and merged by newest version |
| `md5_mismatch` (from `download.ts`) | The streamed bytes differ from the `.md5` file, twice (one retry): a file rebuilt during the download, or a damaged transfer | Run again. Repeating three days running: open an issue; the md5 comes from the same host as the file, so it proves integrity against corruption only (R-079) |
| `redirect_refused`, `http_status`, `too_large`, `timeout`, `network`, `bad_md5_file` (from `download.ts`) | A redirect to another host or more than two hops, a status other than 200, a file over its `max_bytes` (about twice its size of 2026-10-02), 45 minutes exceeded, a transport error, a body that is not an md5 line. While Geofabrik publishes a region (its evening update, about 20:00 to 23:00 UTC) a `-latest` URL can briefly answer with a redirect that is refused: run 37070456458 hit it for `niedersachsen` at 22:18 UTC: run again later | A network or provider problem: run again. `too_large` for a region that really grew means a reviewed raise of `max_bytes` in `registry/geo-sources.yaml`; `redirect_refused` means Geofabrik moved the file |
| `region_missing`, `region_changed`, `bad_index` (`--check-index`) | A pinned region is not in `index-v1-nogeom.json` or its URL changed | A reviewed change of `registry/geo-sources.yaml`; check the index by hand (`curl -s https://download.geofabrik.de/index-v1-nogeom.json`) |
| `relation_missing <ids>` | A relation of `rivers.yaml` (`osm_relation_id`) or of the canal traps is not in the extract: deleted, merged or renumbered in OSM, or outside the 16 regions | Find it on openstreetmap.org and in Wikidata (P402 of the river's item). Then a reviewed change of `osm_relation_id` (and its `evidence`); never add the relation by hand to a file |
| `relation_not_waterway <ids>` | A relation of `rivers.yaml` is not `type=waterway`: a multipolygon water area or another relation that carries the river's QID (Wikidata P402 points at such areas, PHASES §21) | Find the river's `type=waterway` relation on openstreetmap.org and fix `osm_relation_id` (and its `evidence`) in a PR; never accept the area |
| `wikidata_mismatch <ids>` | A relation's `wikidata` tag differs from the river's `wikidata` in `rivers.yaml` | Someone retagged the relation, or the registry has the wrong item. Compare the item's mouth (P403) and the relation; fix `rivers.yaml` in a PR. Do not change the QID without the evidence line |
| `river_without_edges <ids>` | A river of `rivers.yaml` kept no way: its relation has no `main_stream` or empty-role members, or its way selection (`osm_way_name` with its `wikidata`) matched nothing | Open the relation in OSM; check `osm_way_name`. Fix `rivers.yaml` in a PR |
| `duplicate_way <way>` | The same way twice in the merged input: a region overlap that `osmium merge` did not reduce | Normally a mixed-version merge that the timestamp check should have caught. Run again; if it repeats, open an issue with the way ID |
| `cycle <ways>` | The directed graph has a cycle through those ways: a way digitised against the flow, or a canal loop. Cycles are allowed inside the declared tidal zone (edges with direction `none`); outside it they are fatal | Find the ways on openstreetmap.org. A way that does not belong to the river: add it to the river's `drop_ways` (`{id, reason}`) in `rivers.yaml`, in a PR. A wrong direction in OSM is fixed in OSM and arrives with the next extract. Never edit the extract or the output. Never widen the tidal zone to make a cycle pass: find the stray way and add `drop_ways` |
| `mouth_unplaced <ids>` | (P17a) No node of the mouth's river lies within `max_m` of its `at`: the river lost its end ways, or the point is wrong | Check the river's last ways on openstreetmap.org and the point in `mouths`; fix `rivers.yaml` in a PR (`max_m` is at most 2000) |
| `bad_json`, `bad_feature`, `line_too_long`, `bad_utf8`, `input_too_large`, `bad_field`, `bad_escape`, `bad_member`, `bad_tag`, `too_many_*`, `not_relation`, `duplicate_relation` | The reader refused its input (a cap or the shape), with the line number | An osmium version change or a strange object in OSM. Download the `rivernet-fixture` artifact and look at that line (§8); open an issue |
| `waterbody_*`, `waterbodies_*`, `reference_station_not_public`, `by_km_on_canal`, `canal_edge_without_canal` and the polygon reader's input codes | The water bodies and canal stations of P17b | §11 has one row for each |
| `rivers_invalid <problems>` | `registry/rivers.yaml` fails `validateRivers` | A PR changed it badly: fix the file; `pnpm check` runs the same validator |
| `provenance_invalid` | `rivernet.provenance.json` fails its strict schema (`schema_version` 1, the osmium version, UTC timestamps with `Z`, per region an https URL, bytes, md5 and sha256 in lower-case hex) | `extract.sh` or a download record changed: compare with the committed fixture's provenance; open an issue |

Drops are counted, not fatal: a relation member that is not a `main_stream` way (or an empty-role way connected to one) is dropped, and `build-report.json` counts every drop per river. A way that is wrongly kept or dropped is `drop_ways`.

The first run: 17 rivers have no P402 in Wikidata, so their ways are selected by `wikidata` plus `name`. `build-report.json` lists the relations in the extract that carry their QID. Review that list; a relation that really is the river becomes its `osm_relation_id` in a PR (KG-153).

## 6. Verify a release by hand

Anyone can check a release against the workflow identity. No account is needed. Get cosign 3.1.3 (the sha256-pinned download is in `docs/runbooks/bootstrap.md`), then:

```bash
tag=geo-2026-10-03                      # the release's tag
mkdir "$tag" && cd "$tag"
gh release download "$tag" --repo mwijkhuisen/Waterheight
sha256sum -c SHA256SUMS                 # every data file
for f in river_graph.json reaches.geojson qa-report.json SHA256SUMS; do   # and the other five assets and VERSION the same way
  cosign verify-blob --bundle "$f.sigstore.json" \
    --certificate-identity https://github.com/mwijkhuisen/Waterheight/.github/workflows/geo.yml@refs/heads/main \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "$f"
done
```

Each `cosign verify-blob` prints `Verified OK`. A different identity (another workflow, a branch) or issuer fails: do not use the release. The release must also be of the tag's commit (`gh release view "$tag" --json targetCommitish`).

## 7. Re-runs on the same day

- A second run of the same UTC day with an equal `SHA256SUMS` is a no-op: it logs `<tag> already published` and exits 0. A draft left by an interrupted run is published then, but only if it is complete: exactly the nine assets and their nine `.sigstore.json` bundles, each with `state` `uploaded`. Any other set fails with `geo release exists with other assets; delete it to republish`.
- A second run with a different `SHA256SUMS` (Geofabrik published new data in between, or `rivers.yaml` changed) fails with `geo release exists with other assets; delete it to republish` and rewrites nothing. If you want the new result under that tag: delete the release **and its tag** on GitHub (`gh release delete geo-<date> --cleanup-tag --repo mwijkhuisen/Waterheight`), then dispatch again. Otherwise wait for the next day: the tag carries the date.
- Nothing consumes the release before P6b, so deleting it today harms nothing. After P6b, a deleted release is gone for a VPS that has not yet fetched it, and a fetched one is verified once and kept.

## 8. Refresh the fixture

The fixture is what the pull-request job builds from. It is the output of a full run's `extract.sh` (the merged, filtered extract of the rivers in `rivers.yaml` and the canal traps), so the committed files are exactly what the run produced:

P17a grew the fixture with the delta and the canals: the PBF of `geo.yml` run 39154893388 is 4,153,442 bytes, far under the limit.

Since P17b the artifact also holds the three water-body files; they are refreshed on their own, never with the river files (§11, "Refresh only the water-body fixture").

1. Download the artifact (14 days) of a successful or failed `rivernet build` run:

   ```bash
   gh run download <run id> -n rivernet-fixture -D /tmp/rivernet-fixture
   ls -l /tmp/rivernet-fixture      # rivernet.osm.pbf, rivernet.ways.geojsonseq, rivernet.relations.opl, rivernet.provenance.json
   ```
2. The PBF must be **15 MB or less** (`tools/geo/fixtures` is committed; the plan's limit). The ways file stays plain text unless it exceeds 50 MB (then a `.gz`, compared decompressed by `export-check.sh`). If the extract is larger than the limit, the cut is a reviewed change of `extract.sh` (a bbox or a smaller selection), not a hand edit.
3. Check it builds: `node tools/geo/rivernet/build.ts --ways /tmp/rivernet-fixture/rivernet.ways.geojsonseq --relations /tmp/rivernet-fixture/rivernet.relations.opl --provenance /tmp/rivernet-fixture/rivernet.provenance.json --out /tmp/rivernet-build`, and read `build-report.json` (§4).
4. Copy the four files into `tools/geo/fixtures/`, and write the provenance (the run URL, the replication timestamp, the sha256 of the four files, the region ids and the licence line) into the README of that folder (`tools/geo/fixtures/README.md`, section `rivernet.osm.pbf`).
5. The pull request's job `rivernet fixture` then proves that the committed exports equal the tool image's export of the committed PBF (`export-check.sh`) and that two builds of the fixture graph have the same bytes. Until the fixture is committed that job passes with "no fixture yet" (KG-154).

## 9. Failures that are not the build

| Symptom | Meaning | Do |
|---|---|---|
| `docker build` of the tool image fails | A source tarball sha256 mismatch, a Debian package that moved (the apt packages are not pinned, R-078), or the Boost version check (`libboost_program_options.so.1.83.0`) | Read the failing `RUN` step. A moved Boost is a reviewed change of the runtime stage's package name. A tarball mismatch: do not change the sha256 without checking the tag on github.com |
| `export-check: <file> differs` in `rivernet fixture` | The committed export is not the tool image's output for the committed PBF: an osmium change, or the PBF was changed without its exports | Regenerate the exports with the same command (`osmium export … -a type,id,way_nodes --geometry-types=linestring`) in the image and commit them with the PBF |
| `not byte-identical: <file>` | The builder is not deterministic | A bug: open an issue with the file name. Do not publish |
| `euhydro: … complete false` | The EU-Hydro server was slow or answered an error | Not a failure; run again for a full QA |
| `unexpected artifact contents` or `sha256sum -c` fails in `rivernet publish` | The `geo-assets` artifact is not the nine files written by the build job | Run again; if it repeats, open an issue. Nothing was published |
| `cosign verify-blob` fails in `rivernet publish` | The signing identity is not the main workflow's: the run was not on `main`, or the workflow file was renamed | Dispatch from `main`. A rename of `geo.yml` changes the identity: every verifier (P6b) must change with it |

## 10. The opt-in tools

`lookup-wikidata.ts` and `euhydro.ts --record` talk to the live providers from a developer machine and refuse to run under `CI`. They need `RWS_DOMAIN` and `RWS_CONTACT_EMAIL` (the User-Agent). The Wikidata lookup makes at most 80 requests, at least 1 s apart, to `query.wikidata.org` over https, and writes the candidates for the owner's review (`--out <file>`; `--record <dir>` stores one response as a fixture). Nothing it prints is a decision: a river is added to `rivers.yaml` by hand with its evidence line. P17b: `--kind waterbody --labels <file>` runs the water-body query (also coordinate, instance and outflow) over `waterbody-labels.txt`; the budget of a run is set by the owner (30 requests in P17b), and §11 says how a body is added.

## Outputs, fixture refresh and the generated registry file (P6b)

**What `geo.yml` adds.** After the graph, `rivernet build` runs `node tools/geo/rivernet/outputs.ts --graph <dir> --version <YYYYMMDD> --out <dir>` and `tools/geo/rivernet/tiles.sh build`, which write `reaches-<ver>.json`, `rivers-<ver>.geojson.gz`, `rivers-<ver>.pmtiles`, `snap-report.json` and `VERSION` beside the P6a assets (nine assets with `SHA256SUMS`, each with a bundle). `outputs.ts` reads `river_graph.json` and `reaches.geojson` and the repository's `registry/` (stations, `rivers.yaml`, `snap-overrides.yaml`), and writes `rivers.geojsonseq` (the tiles input, not an asset); `--nonpublic <file>` lists every non-public station id for a grep and is never uploaded. `tiles.sh build|decode` runs tippecanoe 2.79.0 in the tool image (`--network none`, read-only, no capabilities) over fixed in-container paths; the output name must be `rivers-YYYYMMDD.pmtiles`. `VERSION` (8 digits and a newline) is made once, in the build job; the publish job derives the tag `geo-YYYY-MM-DD` and the asset list from it. The pull-request job `rivernet fixture` builds the outputs and the tiles twice from the fixture and fails if the JSON, the download, the snap report, the tiles input or the decoded tiles differ, if the PMTiles file is 40 MB or more (30 MB until P17b), or if a non-public station id occurs in any public output; the PMTiles bytes are compared and reported only. Read the sizes and the PMTiles equality in the job summary (§4).

**The bins layer (#112 PR B).** `outputs.ts` also writes `reach-bins.geojsonseq` (per drawn reach 1 to 8 equal parts of about 500 m: `reach_id`, `bin`, `seg`, `tidal`, feature-level minzoom 8) and `tiles.sh build <rivers> <out> [<bins>]` builds both layers into `rivers-<ver>.pmtiles` (`rivers` and `reach_bins`; bins only in tiles of zoom 8 and above). On the national release the archive is about 2.5 MB (2,471,390 bytes on 2026-10-10, was 1.65 MB), far under the gate (40 MB since P17b, §11). Check a release with `pmtiles show --metadata rivers-<ver>.pmtiles`: `vector_layers` must list both ids.

**Deploy order for the bins.** (1) Merge: the web deploys and, with the old archive installed, colours per reach as before (no error). (2) The owner dispatches `geo.yml` on `main`; first check for a same-day `geo-*` release (a geo release is never rewritten, so a second run the same day needs a new day or a reviewed change). (3) `sudo rws-rivers-refresh` installs the new archive; the web reads its metadata once per page load and switches to per-bin colours from zoom 8. A tiles rollback (`sudo rws-rivers-refresh --rollback`) falls back to per-reach colours.

**The generated registry file.** `registry/rivernet.yaml` holds the placement of every registry station and the public reaches, built from the **committed fixture** with the same code (`node scripts/gen-rivernet.ts`; `--check` diffs and exits 1). The registry sync in `migrate` stores it. Production serves the **latest release**, so the two can differ until the fixture is refreshed; nothing reads the reaches before P9 (KG-164). **The database reaches mirror this file, not a release:** a reach id `<river>.<seq>` is renumbered by every new graph, so `station.reach_id` and the `reach` rows match the fixture build only, and nothing may join them to a release's `reaches-<ver>.json` (a reader of that file uses its own `reach_id`s). Without the file the sync leaves the reaches, `station.reach_id`, `km_to_nl_entry` and `nl_entry_node` as they are. It is never edited by hand and CI regenerates and diffs it.

**Joins (`joins` in `registry/rivers.yaml`).** A join bridges a gap between a tributary and its parent for routing only (never drawn). A join onto another river lands on that river's vertex nearest `at`: before the ways are split, the vertex of a kept way that carries `to_river` but not `river`, nearest `at` and within `max_m`, becomes a graph node (`tools/geo/rivernet/build.ts`). A join within one river (Scheldt) splits nothing. The Ourthe join (`ourthe → meuse`, `max_m` 150) lands on a Meuse vertex 97 m away and splits that way, so the Meuse reaches after it are renumbered (#110, KG-265); beyond `max_m` no node is added and the join does not connect (check `graph.detached` of the build report). The Ill, Lys, Schwalm, Dieze and Aa of Weerijs stay detached (KG-161).

**Adopt a newer release.** When a release changes the graph, or a new station or override should be placed on it:

1. Refresh the fixture from that run's `rivernet-fixture` artifact (§8; it is kept for 14 days, so do it soon after the run).
2. Set `FIXTURE_RUN` in `scripts/gen-rivernet.ts` to that run's URL.
3. Run `node scripts/gen-rivernet.ts`.
4. Review the diff of `registry/rivernet.yaml`: stations that changed river, reach or rule (`override`, `name`, `official_km`, `canal_edge`, `canal`, `unsnapped`, `water_not_in_rivers`, `no_coordinates`, `no_edge_within_500m`) or water body (`waterbody_contains`, `waterbody_shore`, `waterbody_named`, `waterbody_too_far`), new `no_entry_path` stations, the reach count. A station that falls out of its river needs a reviewed entry in `registry/snap-overrides.yaml`, not a looser match.
5. Commit the fixture, `FIXTURE_RUN`, `rivernet.yaml` and any override together in one pull request.

A station-registry change (a regenerated station file) also changes `rivernet.yaml`: run the script and commit it.

**The DE-7 water bodies.** `registry/seed/de-7-waters.csv` comes from one opt-in request (a tool like those of §10): `RWS_DOMAIN=… RWS_CONTACT_EMAIL=… node tools/geo/rivernet/record-nrw-waters.ts [--save <dir>]` (refuses under `CI`, exactly one GET to LANUK's station list at the URL in `registry/geo-sources.yaml`); `--from <dir>/stations.json` rebuilds the CSV offline from a saved body. Then run `node scripts/gen-de7-stations.ts` and `node scripts/gen-rivernet.ts` and commit all three.

## Serving the rivers (P6b)

A signed `geo-YYYY-MM-DD` release carries `rivers-<ver>.pmtiles`, `reaches-<ver>.json`, `rivers-<ver>.geojson.gz`, `VERSION` and `SHA256SUMS` (each with a `.sigstore.json` bundle). `deploy/bin/rws-rivers-refresh` (a host script, run as root; no container, no compose, no ping) installs them on the VPS. Nothing is served from the release directly.

**What it does, in this order** (nothing outside `/var/lib/rws/rivers/work` changes until every check has passed):

1. Takes the lock `rws-rivers` (never the deploy lock; a second run logs it and exits 0).
2. Picks the tag: `--tag geo-YYYY-MM-DD`, else the newest published (not draft, not prerelease) tag of that shape in `https://api.github.com/repos/mwijkhuisen/Waterheight/releases?per_page=30`. The automatic path never goes back (step 6).
3. Fetches `SHA256SUMS` and `VERSION` with their bundles and runs `cosign verify-blob` against the identity `https://github.com/mwijkhuisen/Waterheight/.github/workflows/geo.yml@refs/heads/main` and the Actions issuer (`GEO_IDENTITY` and `RWS_ISSUER`; never a regexp). `VERSION` must be exactly 8 digits and a newline.
4. Derives the three file names from `VERSION` alone (never from the release listing or from `SHA256SUMS`), fetches each with its bundle under a size cap (reaches 32 MiB, tiles 64 MiB, download 128 MiB, bundles 1 MiB), verifies each with cosign, and compares its sha256 with its one exact line of `SHA256SUMS`.
5. Content checks: the PMTiles magic and version 3, `gzip -t`, and `schema_version` 1 or 2 (2 from P17b) and the same `version` in the reaches file. **Do not roll the server release back past P17b while a schema 2 release is installed** (review R1-8): an older publisher and web strict-parse schema 1 only and would refuse the installed reaches file; `rws-rivers-refresh --rollback` to a schema 1 `previous` first, or keep the server release.
6. A version that is already `current` in the manifest exits 0 here. Without `--tag`, a `VERSION` older than `current` stops the run (`refusing a downgrade`: a stale or manipulated release list), and a `VERSION` equal to `previous` (the version a `--rollback` left) logs and exits 0, so a rollback stays until a `--tag` run. `--tag` installs any signed version.
7. Installs root:root 0644 through a temp name in the target directory and a rename: `/srv/rws/public/data/v1/rivers/rivers-<ver>.pmtiles` (Caddy serves it as `/tiles/rivers-<ver>.pmtiles`), `/srv/rws/public/data/v1/rivers/reaches-<ver>.json`, `/srv/rws/public/downloads/rivers-<ver>.geojson.gz`. Root never writes under `/srv/rws/tiles` (the promote job owns it; a link it swapped in could redirect a root write). A name that exists as anything but a regular file (a symlink included), or with other bytes, stops the run (names are immutable); the same bytes are accepted (a run that died before the manifest).
8. Writes `/srv/rws/public/data/v1/rivers/manifest.json` atomically (`current` with `installed_at`, `previous` = the former current or null; the `RiversManifest` contract), then deletes only files with the three exact name patterns that are neither current nor previous.

It never touches `/srv/rws/owner` or anything under `/srv/rws/tiles`. The manifest entries (sha256, size) come from the verified bytes, not from the installed path.

**First run.** `sudo rws-rivers-refresh --dry-run` first: it fetches and verifies everything and prints what it would install, and writes nothing outside the work directory. Then `sudo rws-rivers-refresh` (or `--tag geo-YYYY-MM-DD`), then `scripts/verify-prod.sh <domain>`: `rivers manifest`, `rivers tiles`, `rivers layers`, `rivers reaches`, `rivers download` and `rivers attribution` must pass (all but the last fail until the first install). `rivers layers` (P19b, P20b) checks that the tiles carry the four layer ids `rivers`, `reach_bins`, `waterbodies` and `canals`, and runs the owner-term grep over the PMTiles metadata (the tile blobs themselves are not grepped, KG-474). Two more checks need no live data and must pass beside them: `status specs` (every public spec with a cadence is in `/status/capture.json`) and `method uncovered` (the Method page's `UncoveredBoards-*.js` chunk names all 21 boards of `registry/uncovered.yaml`, and no owner term). `registry/uncovered.yaml` belongs to the Method page (D32), not to the geo release.

**Rollback.** `sudo rws-rivers-refresh --rollback` (it takes no other flag) checks that the previous version is 8 digits and that each of its three file names is exactly `rivers-<ver>.pmtiles`, `reaches-<ver>.json` and `rivers-<ver>.geojson.gz` for that version, re-checks that the files exist as regular files and match the sha256 in the manifest, then swaps `current` and `previous` atomically. With no previous it fails. A third install prunes the oldest version, so a rollback is one step deep. The timer then leaves the rolled-back version alone (step 6); to go forward again, run `sudo rws-rivers-refresh --tag geo-YYYY-MM-DD` with the release you want.

**A run that died after installing.** The files are installed before the manifest is written. A run stopped in between (a reboot, `systemctl stop`) leaves up to three new files under their final names while `manifest.json` still names the old current (or does not exist yet): visitors see nothing new, because the web and `verify-prod` read only what the manifest names. The next run of the same release accepts the identical bytes and writes the manifest; the next install of another version prunes them (they are neither current nor previous). If the same `VERSION` comes back with other bytes (a release deleted and rebuilt on the same day; `geo.yml` itself refuses a same-day republish, §7), the run stops with `exists with other bytes`. Then check that this version is neither `current` nor `previous` in the manifest (`jq '.current.version, .previous.version' /srv/rws/public/data/v1/rivers/manifest.json`), remove that version's three files by hand (`rivers-<ver>.pmtiles` and `reaches-<ver>.json` in `/srv/rws/public/data/v1/rivers/`, `rivers-<ver>.geojson.gz` in `/srv/rws/public/downloads/`) and run again. Never remove a file the manifest names.

**The timer.** `rws-rivers-refresh.timer` (the 5th of every month at 05:40 UTC, `Persistent`, up to 30 minutes of random delay: after `geo.yml`'s run on the 3rd) is installed by `bootstrap.sh` but not enabled. After one good manual run: `sudo systemctl enable --now rws-rivers-refresh.timer`. A failed run is a failed unit (`journalctl -u rws-rivers-refresh`).

**New host files.** The script, its two units and the new directories (`/srv/rws/public/data/v1/rivers`, `/srv/rws/public/downloads`, `/var/lib/rws/rivers`) arrive with the release that brings them: after that deploy, re-run `deploy/host/bootstrap.sh` from the release (until then `rws-update` pings `host_files_changed`), or the script exits at its first directory check. Caddy mounts exactly those two public directories read-only (`deploy/compose.yaml`), never all of `/srv/rws/public`; `deploy/web/site.caddy` serves the overlay at `/tiles/rivers-<ver>.pmtiles` from the rivers directory (one range, immutable), `manifest.json` (`max-age=60`), `reaches-<ver>.json` (immutable) and the download (immutable, `application/gzip`, never a `Content-Encoding`), and answers every other path under `/data/v1/rivers` and `/downloads` with a 404.

**P9.** The publisher will write `public/data/v1/*` later. `public/data/v1/rivers/` belongs to this script; P9 must not write there, and must mount its own directory in Caddy rather than all of `public`.

## 11. Water bodies, canal stations and the new tile layers (P17b)

`PHASES.md` §54 "P17b as built" and ADR-0012's P17b amendment have the decisions. In short: `registry/waterbodies.yaml` (hand-curated, reviewed, no generator) lists the lakes, closed estuaries, estuaries and seas that stations lie in and rivers end in; a station's body comes from identity (a `waterbody:` override of `registry/snap-overrides.yaml` or an exact published `water_name` in the body's `names`) and then geometry, never geometry alone; a canal station snaps to its canal's edge (rule `canal_edge`).

**The extraction.** `sources.ts --selection` writes `waterbodies.txt` (`r<id>` or `w<id>` for each body with an `osm` object; point-only bodies have none) beside `relations.txt` and `qids.txt`, and `extract.sh` checks it against `^[rw][1-9][0-9]*$`. The waterway filter drops lakes, so the bodies are taken from each region's download, before it is deleted: `osmium getid -r` per region (exit 1, "an id is not in this region", is normal), then all regions merged with `-H`, `time-filter`, and `getid -r --remove-tags` once more. `--remove-tags` keeps the tags of the requested objects only, so a referenced way (an island ring, a stretch of shore) is no area of its own. Only here is a missing id an error (`waterbody_missing`). The export is `osmium export -a type,id --geometry-types=polygon` into `rivernet.waterbodies.geojsonseq`, with `waterbodies.osm.pbf` and `waterbodies.provenance.json` (`{schema_version, osmium, replication_timestamp}`). The river files are copied out first, so a failure in the water-body part still leaves them in the artifact `rivernet-fixture`, which now lists seven files.

**The name probe (one-off).** For an OSM object no Wikidata P402 names, the dispatch input `probe` (or `RWS_GEO_PROBE=1`; default off, never in a scheduled or pull-request run) makes `extract.sh` also run `osmium tags-filter -R` for the objects whose `name` equals a body's `name_nl` or a published spelling (`probe-names.txt`, written by `sources.ts` from `waterbodies.yaml`). The names are checked against a byte pattern first (ASCII letters, space, hyphen, apostrophe, or the bytes of a UTF-8 character) because each becomes a value of the osmium filter expression. The artifact `rivernet-probe` (14 days) holds `<region>.opl`, one line per object: the OSM id, then its tags as percent-escaped `k=v` pairs after a `T`, and a node's `x` and `y`; the node and member lists are dropped, so the files are small. To read it: `grep -h 'natural=water' *.opl`, then look for the line whose `wikidata=` is the body's own QID (a `water=lake` or `water=reservoir` multipolygon or closed way; a `place=sea` or `place=locality` object is not a water polygon), and take its id into `osm`. A body found by name only (no `wikidata` tag) is a [U] for the owner.

**Adding or changing a water body** (a reviewed PR; CODEOWNERS covers `registry/`):

1. Add its label to `tools/geo/rivernet/waterbody-labels.txt` and, with the owner's go-ahead for the request count, run `RWS_DOMAIN=… RWS_CONTACT_EMAIL=… node tools/geo/rivernet/lookup-wikidata.ts --kind waterbody --labels tools/geo/rivernet/waterbody-labels.txt --out <file>` (opt-in, never in CI; the budget of the run is the owner's, 30 requests in P17b). Take the QID with its coordinate (P625), instance (P31) and, where there is one, P402 and the outflow (P201); namesakes exist (a street item per lake name).
2. The OSM object: Wikidata P402 where it has one, else the probe above. A body with no usable polygon is point-only: `osm: null`, a `point` (the OSM label node or Wikidata P625; the source in `evidence`) and a reviewed `bbox`, which only rejects an implausible station and is never drawn.
3. Edit `registry/waterbodies.yaml`: `id`, `kind`, `name_nl`/`name_en`, `wikidata`, `osm` or `point` and `bbox`, `names` (the exact spellings a source publishes, for example the NL-1 `water_name`; a pair `(source, spelling)` belongs to one body only), `managed_level`, `outflows` and `evidence` (https URLs). `reference_station` is a public primary station of the lake (D27, P18b; see `docs/runbooks/tide.md` §8: 14 lakes have a gauge, the 9 other bodies are explicitly `null`), or `null` where no placed gauge exists. `registry/uncovered.yaml` is a different file: it lists the water boards for the Method page, not bodies.
4. Map the stations: an exact `names` match needs no override; any other station gets a `waterbody:` entry in `registry/snap-overrides.yaml` with a reason (the identity evidence and the measured distance), `waterbody_max_m` only where the gauge lies 500 m to 2 km off the shore.
5. Run the extract on a branch (§2, a dispatch on the branch), refresh the water-body fixture (below), run `node scripts/gen-rivernet.ts` and review the diff of `registry/rivernet.yaml`.

**Refresh only the water-body fixture.** The four river files in `tools/geo/fixtures` are not refreshed with it (R-6): the reach ids of the committed reaches and tiles fixtures and the bifurcation golden stay as they are.

1. `gh run download <run id> -n rivernet-fixture -D /tmp/rivernet-fixture` (14 days).
2. Copy only `waterbodies.osm.pbf`, `rivernet.waterbodies.geojsonseq` and `waterbodies.provenance.json` into `tools/geo/fixtures/`. Gzip the export (`rivernet.waterbodies.geojsonseq.gz`) if it is over about 20 MB; `export-check.sh` compares a `.gz` decompressed, and `loadWaterbodyInput` reads either.
3. Write the run URL, the replication timestamp and the sha256 of the three files into `tools/geo/fixtures/README.md` (section `waterbodies.osm.pbf`).
4. `node scripts/gen-rivernet.ts` pins the export's sha256 as `fixture.waterbodies_sha256`; commit the three files, the README, `registry/rivernet.yaml` and any override together. The `rivernet fixture` job then re-exports the PBF and compares (`export-check.sh`), builds the outputs and the tiles twice and compares.

**The outputs.** `outputs.ts --waterbodies <export>` is required (the job passes the fixture's, or `$out/rivernet.waterbodies.geojsonseq`). It writes `waterbodies.geojsonseq` (each body's polygon, or its point when point-only; properties `waterbody_id`, `kind`, `name_nl`, `name_en`) and `canals.geojsonseq` (one line per canal edge: `river_id`, `name_nl`, `name_en`, `kind: canal`), and `tiles.sh build <out.pmtiles> rivers:… reach_bins:… waterbodies:… canals:…` makes the four layers (`pmtiles show --metadata` must list `rivers`, `reach_bins`, `waterbodies` and `canals`). Neither new layer holds a station, a station id or a value. `rivers-<ver>.geojson.gz` appends the bodies (`layer: waterbody`) and then the canal lines (`layer: canal`) after the reach lines, and its head (attribution, licence, `licence_note`) is unchanged. `reaches-<ver>.json` is schema 2: `waterbodies[]` lists each body with its public stations only, and `mouths[]`. The gate is **under 40,000,000 bytes** for the PMTiles file, in the fixture job and in the build job (the job fails with "is 40 MB or more"; a per-tile size failure from tippecanoe is a reviewed change of `tiles.sh`, not a hand edit). The leak grep of the fixture job covers `waterbodies.geojsonseq` and `canals.geojsonseq` too.

**Failure codes of P17b.** Fixed codes with our own ids only, never OSM text.

| Code | Meaning | Do |
|---|---|---|
| `waterbody_missing <ids>` (from `extract.sh`) | An OSM object of `waterbodies.yaml` is in none of the 16 regions after the merge: deleted, renumbered, or outside the regions | Find the object on openstreetmap.org and in Wikidata (P402). Then a reviewed change of `osm` (and its `evidence`); never add the object by hand |
| `waterbody_unassembled <body ids>` | A body with `osm` has no polygon in the export: the relation is not a closed multipolygon (an open ring, a missing member) or is not an area | Open the object in OSM and look at the ring. A reviewed change to another object, or to a point-only body; never draw one by hand |
| `waterbody_unexpected <osm key>` | The export holds an area that no body declares, for example a tagged way inside a body that `--remove-tags` should have stripped | Check the key (`r123`, `w123`) in the artifact. Either the body belongs in `waterbodies.yaml`, or the extract changed: open an issue with the key |
| `waterbody_duplicate <osm key>` | One OSM object assembled twice in the export | A merge that did not reduce to one version: run again; if it repeats, open an issue with the key |
| `waterbodies_invalid <problems>` | `registry/waterbodies.yaml` fails `validateWaterbodies` (a duplicate id, QID or OSM object, `osm` null without `point` and `bbox`, an unknown outflow, a mouth naming an unknown body, a spelling in two bodies) | Fix the file; `pnpm check` runs the same validator |
| `waterbodies_missing` | An output writer was called without water-body input (fail closed) | Pass `--waterbodies` (a code bug if the job did) |
| `waterbody_area_missing <body id>`, `waterbody_unknown <station>` | The placement found no area for a polygon body, or an override names a body that is not in the file | The override or the input is wrong: fix `snap-overrides.yaml` (`overrides_invalid` also names an unknown `waterbody`) or the fixture |
| `waterbody_outside_bbox <station>` | A station is named into a point-only body (by `names` or by override) but lies outside the body's `bbox` | A wrong name or override: fix it, or widen the reviewed `bbox` with evidence |
| `waterbody_without_coordinates <station>` | A `waterbody:` override on a station with no coordinates | Remove the override: a body needs the station's coordinates (a name match without coordinates gives no body and no error) |
| `reference_station_not_public <body id>` | A body's `reference_station` is not a public station of the reaches build (the registry sync refuses one that is not a public primary with its own message) | Set it to a public primary station of the lake, or null (D27 lists the 14 gauges). An owner or `off` station is never a body's gauge |
| `by_km_on_canal <station>` | A `by_km` override whose river is a canal: a canal has no chainage | Use a `river:` override naming the canal (rule `canal_edge`), a `canal:` entry or `unsnapped` |
| `canal_edge_without_canal <edge>` | A canal edge whose rivers hold no `kind: canal` row, seen when `canals.geojsonseq` is written | `rivers.yaml` and the graph disagree: open an issue with the edge id |
| `override_unplaced <station>` | A `river:` override (a canal included) has no edge of that river within `max_m`; a canal too far by name is `no_edge_within_500m` | Fix the override or raise `max_m` (at most 2000) with evidence |
| `bad_json`, `bad_feature`, `bad_utf8`, `line_too_long`, `input_too_large`, `too_many_vertices`, `too_many_rings` (the polygon reader `readAreaSeq`, with the line number) | The export broke a cap or its shape: a line over 64 MiB, a file over 256 MiB, an area over 2,000,000 vertices or 20,000 rings, over 1,000 tags, a ring that is not closed or has fewer than 4 positions, a coordinate out of range, a feature that is not a Polygon or MultiPolygon | An osmium change or a strange object. Download the `rivernet-fixture` artifact and look at that line; open an issue. A cap is raised only after measuring, in a reviewed change of `AREA_CAPS` |

## What not to do

- Do not edit a Geofabrik extract, the exports or the graph by hand, and do not add a relation to a file to get past `relation_missing`: the fix is `rivers.yaml` or `geo-sources.yaml` in a PR.
- Do not merge regions with a plain `osmium merge` (it keeps both versions of a border object), and do not add a cache to `geo.yml` (`check-workflows.sh` forbids it).
- Do not push, upload or release the tool image or the PBFs: osmium-tool is GPL-3.0 (ADR-0012). The release holds the nine assets only.
- Do not run a publish by hand with a personal token, and do not rewrite or re-sign a published release: delete it and run again (§7).
- Do not widen `contents: write` or `id-token: write` beyond `rivernet-publish`, and do not add a checkout or a repository script to it (T-GEO-4).
- Do not raise a request budget (EU-Hydro 300, Wikidata 80) or shorten the delay between requests; both are courtesy limits to providers (T-GEO-5).
- Do not run `lookup-wikidata.ts` or `euhydro.ts --record` in CI or in a loop.
- Do not put an OSM name, a station or a value into the graph outputs (D15).
