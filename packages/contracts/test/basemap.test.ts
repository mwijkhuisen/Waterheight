import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { basemapAssetsPath, validateBasemap } from '../src/index.ts';

// registry/basemap.yaml (P3): the basemap job's fetch targets and the pinned style assets.

const repoRoot = new URL('../../../', import.meta.url);
const committed = parse(readFileSync(new URL('registry/basemap.yaml', repoRoot), 'utf8'));
const problems = (doc: unknown) => validateBasemap(doc).problems.join('\n');
const clone = () => structuredClone(committed);

describe('registry/basemap.yaml', () => {
  it('validates, and its style version is the pinned @protomaps/basemaps', () => {
    expect(problems(committed)).toBe('');
    const pkg = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));
    expect(committed.style.version).toBe(pkg.devDependencies['@protomaps/basemaps']);
    expect(basemapAssetsPath(committed)).toBe('/assets/map/028c18f/');
  });

  it('names exactly the two Protomaps hosts and extracts what the plan says', () => {
    expect(committed.protomaps.hosts).toEqual(['build-metadata.protomaps.dev', 'build.protomaps.com']);
    expect(committed.extracts.basemap).toMatchObject({ bbox: [1.5, 45.8, 12.5, 54.0], minzoom: 0, maxzoom: 14 });
    expect(committed.extracts.planet).toMatchObject({ minzoom: 0, maxzoom: 6 });
  });

  it('fails a URL on an unlisted host, http, a foreign archive, a bad bbox or zoom range and an extra key', () => {
    const cases: [(d: ReturnType<typeof clone>) => void, RegExp][] = [
      [(d) => (d.protomaps.builds_url = 'https://example.org/builds.json'), /builds_url: host is not/],
      [(d) => (d.protomaps.tiles_base_url = 'http://build.protomaps.com/'), /tiles_base_url/],
      [(d) => (d.protomaps.tiles_base_url = 'https://build.protomaps.com'), /must end with/],
      [(d) => (d.assets.archive_url = 'https://codeload.github.com/x/y/tar.gz/main'), /not the pinned commit/],
      [(d) => (d.extracts.basemap.bbox = [12.5, 45.8, 1.5, 54.0]), /bbox/],
      [(d) => (d.extracts.planet.minzoom = 7), /planet: minzoom > maxzoom/],
      [(d) => (d.style.regional_minzoom = 15), /regional_minzoom/],
      [(d) => (d.style.flavour = 'muted'), /flavour/],
      [(d) => (d.assets.commit = 'main'), /commit/],
      [(d) => (d.extra = 1), /extra/],
      [(d) => (d.disk_max_pct = 99), /disk_max_pct/],
    ];
    for (const [mutate, want] of cases) {
      const d = clone();
      mutate(d);
      expect(problems(d)).toMatch(want);
    }
  });
});
