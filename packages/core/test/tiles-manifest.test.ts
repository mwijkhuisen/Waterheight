import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseTilesManifest,
  referencedFiles,
  TILE_FILE_RE,
  TILES_MANIFEST_MAX_BYTES,
  TilesManifestError,
  tilePaths,
} from '../src/tiles-manifest.ts';

// The basemap manifest (P3): what the job writes is exactly what the web app,
// verify-prod and the job accept; anything else throws a fixed code.

const sha = (c: string) => c.repeat(64);
const entry = (build: string, c: string) => ({
  build,
  version: '4.15.2',
  created_at: '2026-10-01T09:12:00.000Z',
  basemap: { file: `basemap-${build}.pmtiles`, sha256: sha(c), bytes: 4_300_000_000 },
  planet: { file: `planet-z6-${build}.pmtiles`, sha256: sha('f'), bytes: 45_000_000 },
});
const valid = { schema_version: 1, current: entry('20261001', 'a'), previous: entry('20260924', 'b') };

const codeOf = (value: unknown): string => {
  try {
    parseTilesManifest(typeof value === 'string' ? value : JSON.stringify(value));
  } catch (err) {
    if (err instanceof TilesManifestError) return err.message;
    throw err;
  }
  return 'ok';
};

describe('parseTilesManifest', () => {
  it('accepts the job output, with and without a previous version', () => {
    expect(parseTilesManifest(JSON.stringify(valid))).toEqual(valid);
    expect(parseTilesManifest(JSON.stringify({ ...valid, previous: null })).previous).toBeNull();
  });

  it('refuses every deviation with a fixed code', () => {
    const c = valid.current;
    const cases: [unknown, string][] = [
      ['{', 'manifest_not_json'],
      [`"${'x'.repeat(TILES_MANIFEST_MAX_BYTES)}"`, 'manifest_too_large'],
      [[], 'manifest_invalid at manifest'],
      [{ ...valid, extra: 1 }, 'manifest_invalid at manifest'],
      [{ ...valid, schema_version: 2 }, 'manifest_invalid at manifest.schema_version'],
      [{ ...valid, previous: undefined }, 'manifest_invalid at manifest'],
      [{ ...valid, current: { ...c, build: '2026-10-01' } }, 'manifest_invalid at manifest.current.build'],
      [{ ...valid, current: { ...c, version: 'v4' } }, 'manifest_invalid at manifest.current.version'],
      [
        { ...valid, current: { ...c, created_at: '2026-10-01T09:12:00+02:00' } },
        'manifest_invalid at manifest.current.created_at',
      ],
      [
        { ...valid, current: { ...c, basemap: { ...c.basemap, file: '../ops/ops.json' } } },
        'manifest_invalid at manifest.current.basemap.file',
      ],
      [
        { ...valid, current: { ...c, basemap: { ...c.basemap, file: 'basemap-20260924.pmtiles' } } },
        'manifest_invalid at manifest.current.basemap.file',
      ],
      [
        { ...valid, current: { ...c, planet: { ...c.planet, sha256: sha('A') } } },
        'manifest_invalid at manifest.current.planet.sha256',
      ],
      [
        { ...valid, current: { ...c, planet: { ...c.planet, bytes: 0 } } },
        'manifest_invalid at manifest.current.planet.bytes',
      ],
      [
        { ...valid, current: { ...c, planet: { ...c.planet, bytes: 1.5 } } },
        'manifest_invalid at manifest.current.planet.bytes',
      ],
      [
        { ...valid, current: { ...c, planet: { ...c.planet, url: 'x' } } },
        'manifest_invalid at manifest.current.planet',
      ],
      [{ ...valid, previous: entry('20261001', 'b') }, 'manifest_invalid at manifest.previous.build'],
    ];
    for (const [value, code] of cases) expect(codeOf(value)).toBe(code);
  });

  it('never throws anything but TilesManifestError, whatever the text', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.jsonValue().map((v) => JSON.stringify({ ...valid, current: v })),
        ),
        (t) => {
          const code = codeOf(t);
          expect(code === 'ok' || code.startsWith('manifest_')).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('helpers', () => {
  it('builds same-origin paths and lists what retention keeps', () => {
    const m = parseTilesManifest(JSON.stringify(valid));
    expect(tilePaths(m)).toEqual({
      basemap: '/tiles/basemap-20261001.pmtiles',
      planet: '/tiles/planet-z6-20261001.pmtiles',
    });
    expect(referencedFiles(m)).toEqual([
      'basemap-20261001.pmtiles',
      'planet-z6-20261001.pmtiles',
      'basemap-20260924.pmtiles',
      'planet-z6-20260924.pmtiles',
    ]);
    expect(referencedFiles({ ...m, previous: null })).toHaveLength(2);
  });

  it('matches only the two tile file families', () => {
    for (const ok of ['basemap-20261001.pmtiles', 'planet-z6-20261001.pmtiles'])
      expect(TILE_FILE_RE.test(ok)).toBe(true);
    for (const bad of [
      'rivers-20261001.pmtiles',
      'basemap-2026101.pmtiles',
      '.basemap-20261001.pmtiles',
      'basemap-20261001.pmtiles.tmp',
    ])
      expect(TILE_FILE_RE.test(bad)).toBe(false);
  });
});
