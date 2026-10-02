# Runbook: the river graph refresh

**Trigger:**
- the first run after the P6a merge (issue #21): the owner dispatches `geo.yml` on `main`, and a release `geo-<UTC date>` appears (`docs/plan/PHASES.md` §21, KG-151);
- the monthly schedule (`23 4 3 * *`, 04:23 UTC on the 3rd), and any failed or missed run of it;
- a change of `registry/rivers.yaml` that should reach a release without waiting for the 3rd;
- a failed `rivernet fixture` job on a pull request (§5, §9).

The river graph is a directed graph of the rivers that feed the Netherlands, built from OpenStreetMap in GitHub Actions (ADR-0012). A run downloads 16 Geofabrik extracts, filters them to the waterway relations and the selected ways, builds the graph (`tools/geo/rivernet/build.ts`), checks its direction against EU-Hydro and publishes four signed assets as the release `geo-<date>`: `river_graph.json`, `reaches.geojson`, `qa-report.json` and `SHA256SUMS`. Nothing in production reads the release before P6b (`rws-rivers-refresh`, which verifies the signature). Everything runs on GitHub; there is no VPS step and no secret.

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
| `rivernet build` | dispatch and schedule only | Builds the image; `extract.sh` downloads the 16 regions **one at a time** (md5 first, then the PBF; checks, filters, deletes the PBF), checks that the extracts are at most 72 h apart, merges (newest version of each object), selects, exports; uploads the artifact `rivernet-fixture`; builds the graph; runs the EU-Hydro check; writes `SHA256SUMS`, the job summary and uploads the artifact `geo-assets` (14 days each) | limit 240 min; the real time is not measured yet (KG-151) |
| `rivernet publish` | main only, after `rivernet build` | Checks `sha256sum -c`, signs each of the four assets keyless, verifies each signature, creates the release `geo-<UTC date>` as a draft (`--target $GITHUB_SHA --latest=false`) and publishes it (an existing release of the tag: §7) | minutes |

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
| `cycle <ways>` | The directed graph has a cycle through those ways: a way digitised against the flow, or a canal loop | Find the ways on openstreetmap.org. A way that does not belong to the river: add it to the river's `drop_ways` (`{id, reason}`) in `rivers.yaml`, in a PR. A wrong direction in OSM is fixed in OSM and arrives with the next extract. Never edit the extract or the output |
| `bad_json`, `bad_feature`, `line_too_long`, `bad_utf8`, `input_too_large`, `bad_field`, `bad_escape`, `bad_member`, `bad_tag`, `too_many_*`, `not_relation`, `duplicate_relation` | The reader refused its input (a cap or the shape), with the line number | An osmium version change or a strange object in OSM. Download the `rivernet-fixture` artifact and look at that line (§8); open an issue |
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
sha256sum -c SHA256SUMS                 # the three data files
for f in river_graph.json reaches.geojson qa-report.json SHA256SUMS; do
  cosign verify-blob --bundle "$f.sigstore.json" \
    --certificate-identity https://github.com/mwijkhuisen/Waterheight/.github/workflows/geo.yml@refs/heads/main \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "$f"
done
```

Each `cosign verify-blob` prints `Verified OK`. A different identity (another workflow, a branch) or issuer fails: do not use the release. The release must also be of the tag's commit (`gh release view "$tag" --json targetCommitish`).

## 7. Re-runs on the same day

- A second run of the same UTC day with an equal `SHA256SUMS` is a no-op: it logs `<tag> already published` and exits 0. A draft left by an interrupted run is published then, but only if it is complete: exactly the four assets and their four `.sigstore.json` bundles, each with `state` `uploaded`. Any other set fails with `geo release exists with other assets; delete it to republish`.
- A second run with a different `SHA256SUMS` (Geofabrik published new data in between, or `rivers.yaml` changed) fails with `geo release exists with other assets; delete it to republish` and rewrites nothing. If you want the new result under that tag: delete the release **and its tag** on GitHub (`gh release delete geo-<date> --cleanup-tag --repo mwijkhuisen/Waterheight`), then dispatch again. Otherwise wait for the next day: the tag carries the date.
- Nothing consumes the release before P6b, so deleting it today harms nothing. After P6b, a deleted release is gone for a VPS that has not yet fetched it, and a fetched one is verified once and kept.

## 8. Refresh the fixture

The fixture is what the pull-request job builds from. It is the output of a full run's `extract.sh` (the merged, filtered extract of the rivers in `rivers.yaml` and the canal traps), so the committed files are exactly what the run produced:

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
| `unexpected artifact contents` or `sha256sum -c` fails in `rivernet publish` | The `geo-assets` artifact is not the four files written by the build job | Run again; if it repeats, open an issue. Nothing was published |
| `cosign verify-blob` fails in `rivernet publish` | The signing identity is not the main workflow's: the run was not on `main`, or the workflow file was renamed | Dispatch from `main`. A rename of `geo.yml` changes the identity: every verifier (P6b) must change with it |

## 10. The opt-in tools

`lookup-wikidata.ts` and `euhydro.ts --record` talk to the live providers from a developer machine and refuse to run under `CI`. They need `RWS_DOMAIN` and `RWS_CONTACT_EMAIL` (the User-Agent). The Wikidata lookup makes at most 80 requests, at least 1 s apart, to `query.wikidata.org` over https, and writes the candidates for the owner's review (`--out <file>`; `--record <dir>` stores one response as a fixture). Nothing it prints is a decision: a river is added to `rivers.yaml` by hand with its evidence line.

## What not to do

- Do not edit a Geofabrik extract, the exports or the graph by hand, and do not add a relation to a file to get past `relation_missing`: the fix is `rivers.yaml` or `geo-sources.yaml` in a PR.
- Do not merge regions with a plain `osmium merge` (it keeps both versions of a border object), and do not add a cache to `geo.yml` (`check-workflows.sh` forbids it).
- Do not push, upload or release the tool image or the PBFs: osmium-tool is GPL-3.0 (ADR-0012). The release holds the four assets only.
- Do not run a publish by hand with a personal token, and do not rewrite or re-sign a published release: delete it and run again (§7).
- Do not widen `contents: write` or `id-token: write` beyond `rivernet-publish`, and do not add a checkout or a repository script to it (T-GEO-4).
- Do not raise a request budget (EU-Hydro 300, Wikidata 80) or shorten the delay between requests; both are courtesy limits to providers (T-GEO-5).
- Do not run `lookup-wikidata.ts` or `euhydro.ts --record` in CI or in a loop.
- Do not put an OSM name, a station or a value into the graph outputs (D15).
