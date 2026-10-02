# ADR-0012: River graph from OSM, built in CI

- **Status:** Accepted
- **Date:** 2026-09-23
- **Source:** `docs/plan/ARCHITECTURE.md` §13 (recorded as a file in P0b; the plan is the source of truth)

## Context

Bifurcations are needed; the agent sandbox cannot reach Geofabrik or Overpass (research/map-rivers.md).

## Decision

OSM relations → osmium export → TypeScript graph → tippecanoe, run in `geo.yml`. Outputs are release assets, and the derived graph is published under ODbL. Agents develop against a committed fixture PBF. Station chainage comes from official river-km.

## Consequences

A monthly workflow and an ODbL download page.

## Amendment (P6a, 2026-10-02)

The P6a build (issue #21; `docs/plan/PHASES.md` §21) fixed the details the decision left open. Each point below was measured or checked on 2026-10-02.

- **Tool image, built in CI and never distributed.** `tools/geo/Dockerfile` builds libosmium 2.23.1, osmium-tool 1.19.1 and tippecanoe 2.79.0 from tag tarballs on codeload.github.com, each sha256-pinned in the Dockerfile's `ARG`s (`scripts/check-bom.ts` reads them; the BOM has a row each). Both stages start from the BOM's `node:26.10.0-trixie-slim` digest. osmium-tool 1.19.1 is a tag without a GitHub release (commit `18ac055a…`, 2026-04-07) and needs libosmium 2.23.1 or newer, so libosmium is built too (it is header-only). protozero, nlohmann-json, Boost and the compression libraries come from Debian trixie's signed apt and are not version-pinned (R-078). osmium-tool is GPL-3.0: the image is built in the CI job, used there and discarded. It is never pushed, uploaded or released, so no GPL distribution duty arises; the published assets are our own data (ODbL), not the tool. tippecanoe is in the image but unused until P6b. The image runs with `--network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp` as the runner's uid.
- **16 regions, not the plan's two French ones.** Geofabrik has no `grand-est` or `hauts-de-france` extract; the French extracts are the old regions `alsace`, `lorraine`, `champagne-ardenne` and `nord-pas-de-calais`, `picardie`. With NL, BE, LU, CH and the DE states BW, BY, HE, RP, SL, NW and NI that is 16 PBFs (about 7.4 GB). Every run checks the pinned paths against `index-v1-nogeom.json`. Downloads follow at most two same-host https redirects (`-latest` answers 307 to the dated file), check md5 fail-closed and record sha256.
- **No cache.** Each run downloads fresh. `scripts/check-workflows.sh` forbids `actions/cache` and Geofabrik rebuilds every file daily, so a cache would only serve stale or mixed extracts (owner decision, 2026-10-02).
- **Relations come from OPL.** `osmium export` does not export `type=waterway` relations, so membership is read with `osmium cat -t relation -f opl,add_metadata=false` and ways with `osmium export -f geojsonseq -a type,id,way_nodes`. Geofabrik cuts the regions at different moments (on 2026-10-02 Belgium was a day newer than the rest), so a border object can sit in two extracts in two versions: `extract.sh` merges with `osmium merge -H` (all versions) and keeps the newest valid version of each object with `osmium time-filter` (no time given), records each region's replication timestamp in the provenance, and refuses extracts more than 72 h apart (`extract_dates_too_far_apart`); the builder still fails on a duplicate way.
- **Signing and publish.** `rivernet-publish` runs on main only (schedule or dispatch). It is the one job with `contents: write` and `id-token: write`, has no checkout, signs each asset keyless with `cosign sign-blob`, verifies it against the identity `https://github.com/mwijkhuisen/Waterheight/.github/workflows/geo.yml@refs/heads/main` and creates `geo-<UTC date>` as a draft before it publishes. An existing release with the same `SHA256SUMS` is a no-op; different sums fail and nothing is rewritten. There is no environment approval, because nothing consumes the release before P6b's refresh script, which verifies the signature itself (R-080).
- **EU-Hydro is QA only.** The MapServer is EPSG:3857 (not 3035). The QA compares the digitised direction of our reaches with EU-Hydro segments, within a 300-request budget at one request a second, in CI only; it never fails the build and no EU-Hydro geometry is published. `qa-report.json` cites EU-Hydro v1.3 (© EU, Copernicus Land Monitoring Service) and the modification. Direction comes from the geometry, because one `NEXTDOWNID` cannot express a bifurcation; Strahler is not used.
- **Wikidata evidence rule.** A river or canal enters `registry/rivers.yaml` or `sources.yaml` with a QID, a P402 relation where Wikidata has one and the evidence (query date and the mouth, P403, that tells namesakes apart: Nahe is Q168696, Lys is Q208493). The lookup is an opt-in script (refuses under CI, 80 requests at most), never part of a run. Rivers without a P402 (17) select ways by `wikidata` plus `name`, never by name alone, and the builder fails when a relation's `wikidata` tag differs from the registry (`wikidata_mismatch`).
