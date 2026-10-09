// Writes the e2e tiles directory: the two committed fixtures under the names
// the job gives a build, and the manifest the job would write for it. Used by
// the sandbox test server and by the CI e2e job (served there by Caddy).
// P6b: with two more directories (the rivers data directory, which also holds
// the overlay served as /tiles/rivers-<ver>.pmtiles, and the downloads
// directory) it also writes the river files of one release, as
// rws-rivers-refresh would install them, with their manifest.
// Usage: node apps/web/e2e/prepare-tiles.ts <dir> [<rivers data dir> <downloads dir>]
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { checkReaches, ReachesFile, RiversManifest } from '@rws/contracts';
import { checkTilesManifest, tileFileNames } from '@rws/core/tiles-manifest';

export const E2E_BUILD = '20261001';
export const E2E_RIVERS = '20261003';
const fixtures = fileURLToPath(new URL('../../../tools/geo/fixtures/', import.meta.url));
// P11a (issue #26): the river release is the committed fixture one, whose reach ids the tiles carry (read by path, no
// tools/geo import): test/fixtures/reaches-fixture.json (version 20261003, regenerated and compared by
// test/reaches-fixture.test.ts) and tools/geo/fixtures/rivers-fixture.pmtiles (709 reaches, layer `rivers`).
const reachesFixture = fileURLToPath(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url));

/**
 * The reaches file as the e2e site serves it: the committed release plus two e2e stations on the Rhine above Lobith
 * (P11a, issue #26), so that their names render in a chain row. The hostile one (nl.e2e.xss) sits at the head of
 * rhine.47, between Koeln and Bonn; the ordinary one (nl.e2e.dst) at the head of rhine.44, between Andernach and
 * Remagen. Both reaches have no station of their own in the release (a confluence starts them), so the stations
 * become their `up_station_id`: the chain names a row by the station a reach starts at. Every other row is as built.
 * P11c: each also has its `km_to_nl_entry` (the Rhine's km_graph + km_to_nl_entry is the constant 1069.59 in the
 * release), so the stations are columns of the "Langs de rivier" Rhine paths and the hostile name reaches its axis.
 */
export const E2E_CHAIN: readonly [station: string, reach: string, kmToNlEntry: number][] = [
  ['nl.e2e.xss', 'rhine.47', 204.1],
  ['nl.e2e.dst', 'rhine.44', 234.27],
];
function e2eReaches(release: ReachesFile): ReachesFile {
  const stations = [...release.stations];
  const reaches = release.reaches.map((r) => ({ ...r }));
  for (const [id, reachId, kmToNlEntry] of E2E_CHAIN) {
    const reach = reaches.find((r) => r.id === reachId);
    if (reach === undefined || reach.up_station_id !== null) throw new Error(`e2e reaches: ${reachId} is not free`);
    reach.up_station_id = id;
    stations.push({
      id,
      river_id: reach.river_id,
      reach_id: reach.id,
      km_official: null,
      km_official_system: null,
      km_graph: reach.km_graph_from,
      km_to_nl_entry: kmToNlEntry,
      nl_entry_node: null,
    });
  }
  const out = ReachesFile.parse({ ...release, reaches, stations });
  const problems = checkReaches(out);
  if (problems.length > 0) throw new Error(`e2e reaches: ${problems[0]}`);
  return out;
}

export function prepareTiles(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const names = tileFileNames(E2E_BUILD);
  const file = (fixture: string, name: string) => {
    const bytes = readFileSync(join(fixtures, fixture));
    copyFileSync(join(fixtures, fixture), join(dir, name));
    return { file: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const manifest = checkTilesManifest({
    schema_version: 1,
    current: {
      build: E2E_BUILD,
      version: '4.15.2',
      created_at: '2026-10-01T00:00:00.000Z',
      basemap: file('lobith-z14.pmtiles', names.basemap),
      planet: file('planet-z2.pmtiles', names.planet),
    },
    previous: null,
  });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The river files of one release: tiles, reaches json and manifest into `dataDir`, the ODbL download into `downloadsDir`. */
export function prepareRivers(dataDir: string, downloadsDir: string): void {
  for (const d of [dataDir, downloadsDir]) mkdirSync(d, { recursive: true });
  const v = E2E_RIVERS;
  const entry = (dir: string, name: string, bytes: Buffer) => {
    writeFileSync(join(dir, name), bytes);
    return { file: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const reaches = e2eReaches(ReachesFile.parse(JSON.parse(readFileSync(reachesFixture, 'utf8'))));
  if (reaches.version !== v) throw new Error(`the reaches fixture is version ${reaches.version}, not ${v}`);
  const download = gzipSync(
    `${JSON.stringify({
      type: 'FeatureCollection',
      attribution: '\u00a9 OpenStreetMap contributors',
      licence: 'ODbL-1.0',
      features: [],
    })}\n`,
  );
  const release = {
    version: v,
    tag: 'geo-2026-10-03',
    installed_at: '2026-10-05T05:40:00Z',
    tiles: entry(dataDir, `rivers-${v}.pmtiles`, readFileSync(join(fixtures, 'rivers-fixture.pmtiles'))),
    reaches: entry(dataDir, `reaches-${v}.json`, Buffer.from(`${JSON.stringify(reaches)}\n`)),
    download: entry(downloadsDir, `rivers-${v}.geojson.gz`, download),
  };
  const manifest = RiversManifest.parse({ schema_version: 1, current: release, previous: null });
  writeFileSync(join(dataDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, data, downloads] = process.argv.slice(2);
  if (dir === undefined || (process.argv.length !== 3 && process.argv.length !== 5)) {
    console.error('usage: node apps/web/e2e/prepare-tiles.ts <dir> [<rivers data dir> <downloads dir>]');
    process.exit(64);
  }
  prepareTiles(dir);
  if (data !== undefined && downloads !== undefined) prepareRivers(data, downloads);
}
