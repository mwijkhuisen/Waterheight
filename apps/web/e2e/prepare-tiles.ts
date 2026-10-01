// Writes the e2e tiles directory: the two committed fixtures under the names
// the job gives a build, and the manifest the job would write for it. Used by
// the sandbox test server and by the CI e2e job (served there by Caddy).
// Usage: node apps/web/e2e/prepare-tiles.ts <dir>
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTilesManifest, tileFileNames } from '@rws/core/tiles-manifest';

export const E2E_BUILD = '20261001';
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (dir === undefined || process.argv.length !== 3) {
    console.error('usage: node apps/web/e2e/prepare-tiles.ts <dir>');
    process.exit(64);
  }
  prepareTiles(dir);
}
