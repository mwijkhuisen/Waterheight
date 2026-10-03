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
import { ReachesFile, RiversManifest } from '@rws/contracts';
import { checkTilesManifest, tileFileNames } from '@rws/core/tiles-manifest';

export const E2E_BUILD = '20261001';
export const E2E_RIVERS = '20261003';
const fixtures = fileURLToPath(new URL('../../../tools/geo/fixtures/', import.meta.url));

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
  const reaches = ReachesFile.parse({
    schema_version: 1,
    version: v,
    attribution: '\u00a9 OpenStreetMap contributors',
    attribution_url: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL-1.0',
    licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
    licence_note: 'e2e fixture',
    osm_replication_timestamp: '2026-10-01T20:22:06Z',
    rivers: [],
    nl_entry_nodes: [],
    reaches: [],
    stations: [],
    travel_times: [],
  });
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
    tiles: entry(dataDir, `rivers-${v}.pmtiles`, readFileSync(join(fixtures, 'lobith-z14.pmtiles'))),
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
