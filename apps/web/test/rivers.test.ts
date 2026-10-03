import { describe, expect, it } from 'vitest';
import { downloadHref } from '../src/lib/data/api.ts';

const file = (name: string, ver: string) => ({ file: name.replace('V', ver), sha256: 'a'.repeat(64), bytes: 1 });
const release = (ver: string) => ({
  version: ver,
  tag: `geo-${ver.slice(0, 4)}-${ver.slice(4, 6)}-${ver.slice(6)}`,
  installed_at: '2026-11-05T05:40:12Z',
  tiles: file('rivers-V.pmtiles', ver),
  reaches: file('reaches-V.json', ver),
  download: file('rivers-V.geojson.gz', ver),
});

describe('downloadHref', () => {
  it('links the current release download', () => {
    const manifest = { schema_version: 1, current: release('20261101'), previous: null };
    expect(downloadHref(manifest)).toBe('/downloads/rivers-20261101.geojson.gz');
  });

  it('gives no link for undefined, a wrong shape or file names that do not carry the version', () => {
    expect(downloadHref(undefined)).toBeUndefined();
    expect(downloadHref({ schema_version: 1 })).toBeUndefined();
    const bad = { ...release('20261101'), download: file('rivers-V.geojson.gz', '20250101') };
    expect(downloadHref({ schema_version: 1, current: bad, previous: null })).toBeUndefined();
  });
});
