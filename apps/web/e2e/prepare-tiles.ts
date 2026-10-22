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
// test/reaches-fixture.test.ts) and tools/geo/fixtures/rivers-fixture.pmtiles (1,829 reaches; layers `rivers`,
// `reach_bins` and, from P17b, `waterbodies` and `canals`, which P19a draws).
const reachesFixture = fileURLToPath(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url));

/**
 * The reaches file as the e2e site serves it: the committed release plus two e2e stations on the Rhine above Lobith
 * (P11a, issue #26), so that their names render in a chain row. The hostile one (nl.e2e.xss) sits at the head of
 * rhine.58, between Koeln and Bonn; the ordinary one (nl.e2e.dst) at the head of rhine.55, between Andernach and
 * Remagen. Both reaches have no station of their own in the release (a confluence starts them), so the stations
 * become their `up_station_id`: the chain names a row by the station a reach starts at. Every other row is as built.
 * P11c: each also has its `km_to_nl_entry` (the Rhine's km_graph + km_to_nl_entry is the constant 1069.59 in the
 * release), so the stations are columns of the "Langs de rivier" Rhine paths and the hostile name reaches its axis.
 */
export const E2E_CHAIN: readonly [station: string, reach: string, kmToNlEntry: number][] = [
  ['nl.e2e.xss', 'rhine.58', 204.1],
  ['nl.e2e.dst', 'rhine.55', 234.27],
];
/**
 * P19a (issue #67): the e2e stations of the water bodies (apps/server/test/e2e/api.ts P19A_STATIONS), added to the
 * release's `stations` of their body: a second lake gauge and the D27 reference of the IJsselmeer (replacing the
 * release's real krabbersgat), a lake without a reference (the Veluwemeer has none), a Wadden Sea point and an offshore
 * MSL platform. [body, stations, reference station or undefined to keep the release's].
 */
const E2E_BODIES: readonly [body: string, stations: readonly string[], reference?: string][] = [
  ['ijsselmeer', ['nl.e2e.lake-gauge', 'nl.e2e.lake-ref'], 'nl.e2e.lake-ref'],
  ['veluwemeer', ['nl.e2e.lake-noref']],
  ['waddenzee', ['nl.e2e.coast']],
  ['noordzee', ['nl.e2e.platform']],
];
/** P19a: the Gooimeer's name in both languages, HTML-looking (payload 5: 1 to 3 are the xss station's and its class); it must render as text. */
export const E2E_HOSTILE_LAKE = '<img src=x onerror=alert(5)>Gooimeer';
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
  if (release.waterbodies === undefined) throw new Error('e2e reaches: the release has no waterbodies');
  const waterbodies = release.waterbodies.map((w) => {
    const extra = E2E_BODIES.find(([body]) => body === w.id);
    const name = w.id === 'gooimeer' ? { name_nl: E2E_HOSTILE_LAKE, name_en: E2E_HOSTILE_LAKE } : {};
    if (extra === undefined) return { ...w, ...name };
    // Default sort order is the UTF-16 order of checkReaches' `<`.
    return {
      ...w,
      ...name,
      stations: [...new Set([...w.stations, ...extra[1]])].sort(),
      reference_station_id: extra[2] ?? w.reference_station_id,
    };
  });
  for (const [body] of E2E_BODIES)
    if (!waterbodies.some((w) => w.id === body)) throw new Error(`e2e reaches: no water body ${body}`);
  const out = ReachesFile.parse({ ...release, reaches, stations, waterbodies });
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
