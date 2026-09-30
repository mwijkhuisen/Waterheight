import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePayload } from '../../../../scripts/fixture-archive.ts';
import { ArchiveError, ArchiveReader, KEY_RE, MAX_LINE_BYTES } from '../../src/archive/reader.ts';
import { Archive } from '../../src/archive/writer.ts';

// The read side of the archive: manifest keys are data, so every path is
// checked and confined to the archive root, and every read is capped.

let base: string;
let raw: string;
let reader: ArchiveReader;
let key: string;

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ArchiveError) return err.code;
    throw err;
  }
  return 'ok';
};

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'rws-reader-'));
  raw = join(base, 'raw');
  reader = new ArchiveReader(raw);
  const line = await writePayload(new Archive(raw), {
    source: 'DE-1',
    spec: 'de-1-series',
    variant: 'v',
    at: new Date('2026-10-01T10:00:00Z'),
    body: Buffer.from('[{"timestamp":"2026-10-01T12:00:00+02:00","value":1.0}]'),
    url: 'https://example.org/',
  });
  key = line.key as string;
  writeFileSync(join(base, 'secret'), 'outside');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('objects', () => {
  it('reads an object back', async () => {
    expect(KEY_RE.test(key)).toBe(true);
    expect((await reader.readObject(key)).toString()).toBe('[{"timestamp":"2026-10-01T12:00:00+02:00","value":1.0}]');
  });

  it.each([
    'raw/DE-1/de-1-series/2026/10/01/../../../../../secret',
    '/etc/passwd',
    'raw/DE-1/de-1-series/2026/10/01/100000Z-0123456789abcdef.zst/../x',
    'raw/de-1/de-1-series/2026/10/01/100000Z-0123456789abcdef.zst',
    'raw/DE-1/De-1-Series/2026/10/01/100000Z-0123456789abcdef.zst',
    'raw/DE-1/de-1-series/2026/10/01/100000Z-0123456789abcdef.zst\n',
    'raw/DE-1/de-1-series/2026/10/01/100000Z-0123456789ABCDEF.zst',
    'raw/_manifest/2026-10-01.jsonl',
    '',
  ])('refuses the key %j before touching the file system', async (bad) => {
    expect(await codeOf(reader.resolve(bad))).toBe('bad_key');
  });

  it('refuses a well-formed key whose file is a link out of the archive, or a directory', async () => {
    const dir = join(raw, 'DE-1', 'de-1-series', '2026', '10', '02');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(base, 'secret'), join(dir, '100000Z-0123456789abcdef.zst'));
    expect(await codeOf(reader.readObject('raw/DE-1/de-1-series/2026/10/02/100000Z-0123456789abcdef.zst'))).toBe(
      'not_a_file',
    );
    mkdirSync(join(dir, '110000Z-0123456789abcdef.zst'));
    expect(await codeOf(reader.readObject('raw/DE-1/de-1-series/2026/10/02/110000Z-0123456789abcdef.zst'))).toBe(
      'not_a_file',
    );
    // A linked DIRECTORY on the way that leaves the root is caught by the resolved path.
    symlinkSync(base, join(raw, 'DE-1', 'de-1-series', '2026', '11'));
    writeFileSync(join(base, '01'), '');
    mkdirSync(join(base, '03'));
    writeFileSync(join(base, '03', '100000Z-0123456789abcdef.zst'), zstdCompressSync(Buffer.from('outside')));
    expect(await codeOf(reader.readObject('raw/DE-1/de-1-series/2026/11/03/100000Z-0123456789abcdef.zst'))).toBe(
      'outside_root',
    );
    expect(await codeOf(reader.readObject('raw/DE-1/de-1-series/2026/10/09/100000Z-0123456789abcdef.zst'))).toBe(
      'missing',
    );
  });

  // Review C4: only "no such file" is `missing` (which the loader skips); any other error is `unreadable` (tried
  // again, then quarantined with an alert). Root can read anything, so this cannot be shown as root.
  it.skipIf(process.getuid?.() === 0)('an object it may not read is unreadable, not missing', async () => {
    const dir = join(raw, 'DE-1', 'de-1-series', '2026', '10', '04');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '100000Z-0123456789abcdef.zst');
    writeFileSync(file, zstdCompressSync(Buffer.from('[]')));
    const key = 'raw/DE-1/de-1-series/2026/10/04/100000Z-0123456789abcdef.zst';
    chmodSync(file, 0o000);
    expect(await codeOf(reader.readObject(key))).toBe('unreadable');
    chmodSync(file, 0o640);
    // A directory on the way that cannot be searched: before, every lstat error counted as missing.
    chmodSync(dir, 0o000);
    try {
      expect(await codeOf(reader.readObject(key))).toBe('unreadable');
    } finally {
      chmodSync(dir, 0o750);
    }
    expect((await reader.readObject(key)).toString()).toBe('[]');
    // The archive root itself missing is not one object's problem: it is thrown as it is.
    await expect(new ArchiveReader(join(base, 'no-such-root')).readObject(key)).rejects.not.toBeInstanceOf(
      ArchiveError,
    );
  });

  it('caps the decoded size (a zstd bomb) and reports a damaged object', async () => {
    const dir = join(raw, 'DE-1', 'de-1-series', '2026', '10', '03');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '100000Z-0123456789abcdef.zst'), zstdCompressSync(Buffer.alloc(8 * 1024 * 1024)));
    const bomb = 'raw/DE-1/de-1-series/2026/10/03/100000Z-0123456789abcdef.zst';
    expect(await codeOf(reader.readObject(bomb, 1024 * 1024))).toBe('too_large');
    expect((await reader.readObject(bomb, 8 * 1024 * 1024)).length).toBe(8 * 1024 * 1024);
    writeFileSync(join(dir, '110000Z-0123456789abcdef.zst'), 'not zstd at all');
    expect(await codeOf(reader.readObject('raw/DE-1/de-1-series/2026/10/03/110000Z-0123456789abcdef.zst'))).toBe(
      'corrupt',
    );
  });
});

describe('manifest lines', () => {
  it('returns whole lines only, with the byte offset after each', async () => {
    const [m] = await reader.manifests();
    expect(m?.file).toBe('2026-10-01.jsonl');
    const lines = await reader.lines('2026-10-01.jsonl', 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.end).toBe(m?.size);
    expect(JSON.parse(lines[0]?.text ?? '').key).toBe(key);
    const file = join(raw, '_manifest', '2026-10-01.jsonl');
    appendFileSync(file, '{"torn":');
    expect(await reader.lines('2026-10-01.jsonl', 0)).toHaveLength(1);
    expect(await reader.lines('2026-10-01.jsonl', lines[0]?.end ?? 0)).toEqual([]);
    appendFileSync(file, '1}\nübër\n');
    const more = await reader.lines('2026-10-01.jsonl', lines[0]?.end ?? 0);
    expect(more.map((l) => l.text)).toEqual(['{"torn":1}', 'übër']);
    // Offsets are bytes, not characters.
    expect(more[1]?.end).toBe((more[0]?.end ?? 0) + Buffer.byteLength('übër\n'));
  });

  it('steps over a "line" that is too long to be one, and reads in windows', async () => {
    const file = join(raw, '_manifest', '2026-10-02.jsonl');
    writeFileSync(file, `${'x'.repeat(MAX_LINE_BYTES + 1)}\n{"a":1}\n${'y'.repeat(300_000)}\n{"b":2}\n`);
    const all = await reader.lines('2026-10-02.jsonl', 0);
    expect(all.map((l) => l.text.length)).toEqual([0, 7, 0, 7]);
    // A window smaller than one line still makes progress.
    const small = await reader.lines('2026-10-02.jsonl', 0, 1024);
    expect(small).toEqual([{ text: '', end: MAX_LINE_BYTES + 2 }]);
    expect((await reader.lines('2026-10-02.jsonl', small[0]?.end ?? 0, 1024)).map((l) => l.text)).toEqual(['{"a":1}']);
    expect(await codeOf(reader.lines('../x.jsonl', 0))).toBe('bad_key');
    // Only daily manifest files are listed.
    writeFileSync(join(raw, '_manifest', 'notes.txt'), 'x');
    expect((await reader.manifests()).map((m) => m.file)).toEqual(['2026-10-01.jsonl', '2026-10-02.jsonl']);
  });
});
