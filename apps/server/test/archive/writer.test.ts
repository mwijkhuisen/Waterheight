import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { keptHeaders, ManifestLine, redactUrl } from '../../src/archive/manifest.ts';
import { Archive, objectKey, sha256 } from '../../src/archive/writer.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'rws-archive-'));
const at = new Date('2026-10-02T12:01:07Z');

export const line = (over: Partial<ManifestLine> = {}): ManifestLine => ({
  v: 1,
  source: 'NL-1',
  spec: 'nl-1-obs-key',
  spec_version: 1,
  variant: 'lobith.bovenrijn.tolkamer/H',
  request: { method: 'POST', url: 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/x', body: '{"a":1}' },
  fetched_at: { start: at.toISOString(), end: at.toISOString() },
  status: 200,
  headers: { 'content-type': 'application/json' },
  sha256: 'a'.repeat(64),
  bytes: 10,
  stored_bytes: 5,
  key: null,
  dup_of: null,
  gate: { kind: 'hash', key: null, open: true },
  shape: 'abcd',
  shape_changed: false,
  validity: { ok: true, reason: null, count: 3 },
  retention: 'obs',
  error: null,
  ...over,
});

describe('object keys and objects', () => {
  it('builds the A§7.1 key in UTC', () => {
    expect(objectKey('NL-1', 'nl-1-obs-key', at, 'ab'.repeat(32))).toBe(
      'raw/NL-1/nl-1-obs-key/2026/10/02/120107Z-abababababababab.zst',
    );
  });

  it.each([
    ['../NL-1', 'x'],
    ['NL-1', '../x'],
    ['NL-1', 'X/Y'],
    ['nl-1', 'x'],
  ])('refuses the key parts %s / %s', (source, spec) => {
    expect(() => objectKey(source, spec, at, 'ab'.repeat(32))).toThrow();
  });

  it('stores zstd(decoded body): sha256 of the decompressed object equals the manifest sha256', async () => {
    const root = tmp();
    const a = new Archive(root);
    const body = Buffer.from('{"x":1}');
    const { key, stored } = await a.put('NL-1', 'nl-1-obs-key', at, body, sha256(body));
    const object = readFileSync(a.path(key));
    expect(object.length).toBe(stored);
    expect(sha256(zstdDecompressSync(object))).toBe(sha256(body));
    expect(statSync(a.path(key)).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(root, '.tmp'))).toEqual([]);
    // The same content in the same second is not rewritten.
    expect(await a.put('NL-1', 'nl-1-obs-key', at, body, sha256(body))).toEqual({ key, stored, created: false });
  });
});

describe('manifest', () => {
  it('round-trips its Zod schema through the daily JSONL file', async () => {
    const root = tmp();
    const a = new Archive(root);
    const written = [
      line(),
      line({ variant: 'b', dup_of: 'raw/NL-1/nl-1-obs-key/2026/10/02/120107Z-aaaaaaaaaaaaaaaa.zst' }),
    ];
    for (const l of written) await a.append(l);
    const text = readFileSync(join(root, '_manifest', '2026-10-02.jsonl'), 'utf8');
    const read = text
      .trim()
      .split('\n')
      .map((l) => ManifestLine.parse(JSON.parse(l)));
    expect(read).toEqual(written);
  });

  it('refuses a line outside the schema (unknown key, bad hash, provider text as an error)', async () => {
    const a = new Archive(tmp());
    expect(() => a.append({ ...line(), extra: 1 } as never)).toThrow();
    expect(() => a.append(line({ sha256: 'nope' }))).toThrow();
    expect(() => a.append(line({ error: 'Service Unavailable' as never }))).toThrow();
  });

  it('keeps only allowlisted headers, never Set-Cookie, and redacts secret query values', () => {
    expect(
      keptHeaders({
        'set-cookie': 'session=1',
        etag: '"x"',
        'x-api-key': 'secret',
        authorization: 'Bearer y',
        'last-modified': `a\r\nb${'z'.repeat(400)}`,
      }),
    ).toEqual({ etag: '"x"', 'last-modified': `a  b${'z'.repeat(252)}` });
    expect(redactUrl('https://u:p@bis.azure-api.net/x?key=abc&token=t&CdEntVigiCru=2')).toBe(
      'https://bis.azure-api.net/x?key=REDACTED&token=REDACTED&CdEntVigiCru=2',
    );
  });
});

describe('start-up recovery', () => {
  it('repairs a torn last line and records objects that have no line', async () => {
    const root = tmp();
    const a = new Archive(root);
    const body = Buffer.from('payload');
    const kept = await a.put('NL-1', 'nl-1-obs-key', at, body, sha256(body));
    await a.append(line({ key: kept.key }));
    const orphanBody = Buffer.from('orphan');
    const orphan = await a.put(
      'NL-1',
      'nl-1-obs-key',
      new Date('2026-10-02T12:11:07Z'),
      orphanBody,
      sha256(orphanBody),
    );
    const file = join(root, '_manifest', '2026-10-02.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"source":"NL-1","spec`);
    writeFileSync(join(root, '.tmp', 'left.tmp'), 'x');

    const n = await a.recover(() => ({ retention: 'obs', version: 3 }), new Date('2026-10-02T13:00:00Z'));
    expect(n).toBe(1);
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => ManifestLine.parse(JSON.parse(l)));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      recovered: true,
      key: orphan.key,
      sha256: sha256(orphanBody),
      bytes: orphanBody.length,
      spec_version: 3,
      retention: 'obs',
    });
    expect(existsSync(join(root, '.tmp'))).toBe(false);
    // Idempotent: a second recovery finds nothing new.
    expect(await a.recover(() => ({ retention: 'obs', version: 3 }), new Date('2026-10-02T13:00:00Z'))).toBe(0);
  });
});
