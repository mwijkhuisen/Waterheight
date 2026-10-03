import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { delay, HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { checkIndexBody, DownloadError, downloadRegion, parseMd5 } from '../tools/geo/rivernet/download.ts';
import { ROOT, readSources } from '../tools/geo/rivernet/sources.ts';
import { server } from './msw.setup.ts';

const FIX = join(ROOT, 'tools/geo/fixtures/geofabrik');
const UA = 'rivierstanden/0.1.0 (+https://example.org/over; test@example.org)';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'rivernet-dl-'));
  dirs.push(d);
  return d;
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DownloadError ? e.code : `other:${String(e)}`;
  }
  return 'none';
};
const codeAsync = (p: Promise<unknown>) =>
  p.then(
    () => 'none',
    (e) => (e instanceof DownloadError ? e.code : `other:${String(e)}`),
  );

describe('index check', () => {
  const regions = readSources().geofabrik.regions;
  const text = readFileSync(join(FIX, 'index-v1-nogeom.trimmed.json'), 'utf8');
  it('accepts the real index', () => expect(code(() => checkIndexBody(text, regions))).toBe('none'));
  it('names a changed url by region id', () => {
    const bad = regions.map((r) => (r.id === 'bayern' ? { ...r, url: `${r.url}x` } : r));
    expect(() => checkIndexBody(text, bad)).toThrow('region_changed bayern');
  });
  it('names a missing region', () => {
    const j = JSON.parse(text);
    j.features = j.features.filter((f: { properties: { id: string } }) => f.properties.id !== 'picardie');
    expect(() => checkIndexBody(JSON.stringify(j), regions)).toThrow('region_missing picardie');
  });
  it('never throws anything but a fixed code, whatever the JSON', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc.string(),
        ),
        (s) => {
          expect(code(() => checkIndexBody(s, regions))).toMatch(/^(none|bad_index|region_missing|region_changed)$/);
        },
      ),
    );
  });
});

describe('md5 file', () => {
  const body = readFileSync(join(FIX, 'luxembourg-latest.osm.pbf.md5'), 'utf8');
  it('parses the real body (golden)', () => {
    const golden = JSON.parse(readFileSync(join(FIX, 'luxembourg-latest.osm.pbf.md5.golden.json'), 'utf8'));
    expect(parseMd5(body, golden.filename)).toBe(golden.md5);
  });
  it('parses iff the format matches', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.boolean(),
        fc.stringMatching(/^[0-9a-f]{32}$/),
        (junk, wellFormed, hex) => {
          const text = wellFormed ? `${hex}  f.osm.pbf\n` : junk;
          const ok = code(() => parseMd5(text, 'f.osm.pbf')) === 'none';
          expect(ok).toBe(/^[0-9a-f]{32} {2}f\.osm\.pbf\n?$/.test(text));
        },
      ),
    );
    expect(code(() => parseMd5(`${'a'.repeat(32)} f.osm.pbf\n`, 'f.osm.pbf'))).toBe('bad_md5_file');
    expect(code(() => parseMd5(`${'a'.repeat(32)}  other.osm.pbf\n`, 'f.osm.pbf'))).toBe('bad_md5_file');
  });
});

describe('downloadRegion', () => {
  const URL = 'https://download.geofabrik.de/europe/testland-latest.osm.pbf';
  const region = { id: 'testland', url: URL, max_bytes: 1024 };
  const data = Buffer.from('not really a pbf, but bytes'.repeat(5));
  const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
  const serveMd5 = (...hexes: string[]) => {
    let i = 0;
    server.use(
      http.get(
        `${URL}.md5`,
        () => new HttpResponse(`${hexes[Math.min(i++, hexes.length - 1)]}  testland-latest.osm.pbf\n`),
      ),
    );
  };

  it('stores the file, its hashes and the record', async () => {
    serveMd5(md5(data));
    server.use(http.get(URL, () => new HttpResponse(data)));
    const out = tmp();
    const rec = await downloadRegion(region, out, UA);
    expect(rec).toEqual({
      bytes: data.length,
      id: 'testland',
      md5: md5(data),
      sha256: createHash('sha256').update(data).digest('hex'),
      url: URL,
    });
    expect(readFileSync(join(out, 'testland.osm.pbf')).equals(data)).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'testland.download.json'), 'utf8'))).toEqual(rec);
    expect(readdirSync(out).sort()).toEqual(['testland.download.json', 'testland.osm.pbf']);
  });

  it('follows the 307 to the dated file on the same host', async () => {
    serveMd5(md5(data));
    server.use(
      http.get(
        URL,
        () =>
          new HttpResponse(null, {
            status: 307,
            headers: { location: 'https://download.geofabrik.de/europe/testland-261001.osm.pbf' },
          }),
      ),
      http.get('https://download.geofabrik.de/europe/testland-261001.osm.pbf', () => new HttpResponse(data)),
    );
    expect((await downloadRegion(region, tmp(), UA)).bytes).toBe(data.length);
  });

  it('retries once after an md5 mismatch', async () => {
    serveMd5('0'.repeat(32), md5(data));
    server.use(http.get(URL, () => new HttpResponse(data)));
    expect((await downloadRegion(region, tmp(), UA)).md5).toBe(md5(data));
  });

  it('fails after two mismatches and leaves nothing', async () => {
    serveMd5('0'.repeat(32));
    server.use(http.get(URL, () => new HttpResponse(data)));
    const out = tmp();
    expect(await codeAsync(downloadRegion(region, out, UA))).toBe('md5_mismatch');
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses an oversize body', async () => {
    serveMd5(md5(data));
    server.use(http.get(URL, () => new HttpResponse(data)));
    const out = tmp();
    expect(await codeAsync(downloadRegion({ ...region, max_bytes: 10 }, out, UA))).toBe('too_large');
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses a redirect to another host, and a non-200', async () => {
    serveMd5(md5(data));
    server.use(
      http.get(URL, () => new HttpResponse(null, { status: 302, headers: { location: 'https://example.org/x.pbf' } })),
    );
    expect(await codeAsync(downloadRegion(region, tmp(), UA))).toBe('redirect_refused');
    server.use(http.get(URL, () => new HttpResponse(null, { status: 206 })));
    expect(await codeAsync(downloadRegion(region, tmp(), UA))).toBe('http_status');
  });

  it('refuses a bad md5 file before downloading the PBF', async () => {
    server.use(http.get(`${URL}.md5`, () => new HttpResponse('<html>nope</html>')));
    expect(await codeAsync(downloadRegion(region, tmp(), UA))).toBe('bad_md5_file');
  });

  it('times out', async () => {
    serveMd5(md5(data));
    server.use(
      http.get(URL, async () => {
        await delay(500);
        return new HttpResponse(data);
      }),
    );
    const out = tmp();
    expect(await codeAsync(downloadRegion(region, out, UA, 50))).toBe('timeout');
    expect(existsSync(join(out, 'testland.osm.pbf.part'))).toBe(false);
  });
});
