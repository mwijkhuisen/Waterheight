import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Output, safeRel, writeAtomic } from '../../src/publish/write.ts';

// P9a, T-PUB-1: the publisher writes only known paths under v1/, atomically, with precompressed siblings.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rws-publish-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('safeRel', () => {
  it.each([
    'meta.json',
    'latest.json',
    'recent/2026-10-04/1210.json',
    'settled/2026-10-01/v12/0000.json',
    'frames/recent.json',
    'frames/2026-10-01/v2.json',
    'forecast/latest.json',
    'series/de.wsv.9598e4cb-0849-401e-bba0-689234b27644/recent.json',
    'warnings/latest.geojson',
    'warnings/2026-10-03.json',
  ])('takes %s', (rel) => {
    expect(safeRel(rel)).toBe(rel);
  });
  it.each([
    '',
    '/etc/passwd',
    '../x.json',
    'recent/../../x.json',
    '.tmp/x',
    'recent//1210.json',
    'meta.json.zst',
    'settled/2026-10-01/v0/0000.json',
    'recent/2026-10-04/12100.json',
    `series/de.x.${'a'.repeat(80)}/recent.json`,
    'series/DE.x.y/recent.json',
    'meta.JSON',
  ])('refuses %j', (rel) => {
    expect(() => safeRel(rel)).toThrow('unsafe_path');
  });
});

describe('writeAtomic and Output', () => {
  it('writes the plain file and its .zst and .gz siblings, 0644, leaving nothing in .tmp', async () => {
    const out = new Output(root);
    await out.start();
    const body = { a: 'x'.repeat(1000) };
    expect(await out.put('recent/2026-10-04/1210.json', body)).toBeGreaterThan(0);
    const dir = join(root, 'v1/recent/2026-10-04');
    expect(readdirSync(dir).sort()).toEqual(['1210.json', '1210.json.gz', '1210.json.zst']);
    const plain = readFileSync(join(dir, '1210.json'));
    expect(JSON.parse(plain.toString())).toEqual(body);
    expect(gunzipSync(readFileSync(join(dir, '1210.json.gz')))).toEqual(plain);
    expect(zstdDecompressSync(readFileSync(join(dir, '1210.json.zst')))).toEqual(plain);
    expect(statSync(join(dir, '1210.json')).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);
    // Unchanged bytes are not written again; a remembered file is.
    expect(await out.put('recent/2026-10-04/1210.json', body)).toBe(0);
    expect(await out.put('recent/2026-10-04/1210.json', { a: 1 })).toBeGreaterThan(0);
    // A file put with remember=false is written every time.
    expect(await out.put('settled/2026-10-01/v1/0000.json', body, false)).toBeGreaterThan(0);
    expect(await out.put('settled/2026-10-01/v1/0000.json', body, false)).toBeGreaterThan(0);
    const sizes = ['', '.gz', '.zst'].map((x) => statSync(join(root, `v1/settled/2026-10-01/v1/0000.json${x}`)).size);
    expect(await out.size('settled')).toBe(sizes.reduce((a, b) => a + b));
  });

  it('removes a file with its siblings, and a directory', async () => {
    const out = new Output(root);
    await out.start();
    await out.put('frames/2026-10-01/v1.json', {});
    await out.put('settled/2026-10-01/v1/0000.json', {});
    await out.remove('frames/2026-10-01/v1.json');
    expect(readdirSync(join(root, 'v1/frames/2026-10-01'))).toEqual([]);
    await out.remove('settled/2026-10-01/v1');
    expect(readdirSync(join(root, 'v1/settled/2026-10-01'))).toEqual([]);
    // Forgotten after removal: the same body is written again.
    expect(await out.put('frames/2026-10-01/v1.json', {})).toBeGreaterThan(0);
  });

  it('empties .tmp at start and keeps markers in .state, never under v1', async () => {
    const out = new Output(root);
    await out.start();
    await writeAtomic(root, 'meta.json', Buffer.from('{}'));
    await out.writeMarker({ day: '2026-10-01', version: 2, files: 145, seconds: 30, at: '2026-10-04T12:00:00.000Z' });
    expect(await out.markers()).toEqual([
      { day: '2026-10-01', version: 2, files: 145, seconds: 30, at: '2026-10-04T12:00:00.000Z' },
    ]);
    expect(lstatSync(join(root, '.state')).mode & 0o777).toBe(0o700);
    await out.removeMarker('2026-10-01', 2);
    expect(await out.markers()).toEqual([]);
    await expect(out.writeMarker({ day: '../x', version: 1, files: 0, seconds: 0, at: '' })).rejects.toThrow(
      'unsafe_path',
    );
  });
});
