import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, writePayload } from '../../../../scripts/fixture-archive.ts';
import { ArchiveReader } from '../../src/archive/reader.ts';
import { Archive } from '../../src/archive/writer.ts';
import {
  HOT_WINDOW_DAYS,
  KEEP_UNTIL_PARSED,
  MIXED_SOURCES,
  type ParsedOk,
  type PruneOptions,
  prune,
  prunePlan,
} from '../../src/load/prune.ts';

// The retention pruner (issue #17 †): dry-run by default; forever classes, the
// daily promoted copy of a mixed payload, CH-1/CH-2 payloads, unparsed objects
// and anything outside raw/ are never deleted. The database side of "parsed
// ok" (status ok and n_skipped 0: a unit switch, an unregistered series) is
// tested in drift.int.test.ts.

const NOW = new Date('2027-03-01T00:00:00Z');
const daysAgo = (n: number, second = 0) => new Date(NOW.getTime() - n * 86_400_000 + second * 1000);

let base: string;
let raw: string;
let archive: Archive;
let reader: ArchiveReader;
const key: Record<string, string> = {};
const parsed = new Set<string>();

async function put(
  name: string,
  source: string,
  spec: string,
  at: Date,
  opts: { retention?: 'obs' | 'forever'; parsed?: boolean } = {},
) {
  const line = await writePayload(archive, {
    source,
    spec,
    variant: '',
    at,
    body: Buffer.from(JSON.stringify({ name })),
    url: 'https://example.org/',
    retention: opts.retention ?? 'obs',
  });
  key[name] = line.key as string;
  if (opts.parsed !== false) parsed.add(line.key as string);
}

const exists = (name: string) => existsSync(archive.path(key[name] as string));
/** The ok lookup as the database answers it, recording every call. */
const lookups: string[][] = [];
const parsedOk: ParsedOk = async (keys) => {
  lookups.push([...keys]);
  return new Set(keys.filter((k) => parsed.has(k)));
};
const planOf = async (opts: PruneOptions) => {
  const all: string[] = [];
  for await (const keys of prunePlan(reader, parsedOk, opts)) all.push(...keys);
  return all.sort();
};

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'rws-prune-'));
  raw = join(base, 'raw');
  archive = new Archive(raw);
  reader = new ArchiveReader(raw);
  await put('old-obs', 'DE-1', 'de-1-basin', daysAgo(120));
  await put('old-obs-2', 'DE-1', 'de-1-series', daysAgo(91));
  await put('old-unparsed', 'DE-1', 'de-1-basin', daysAgo(119), { parsed: false });
  await put('old-forever', 'DE-1', 'de-1-meta', daysAgo(118), { retention: 'forever' });
  await put('recent-obs', 'DE-1', 'de-1-basin', daysAgo(89));
  await put('old-still-referenced', 'DE-1', 'de-1-basin', daysAgo(117));
  // The recorder saw the same body again 10 days ago: that object is still that day's data.
  await archive.append(
    bareLine('DE-1', 'de-1-basin', daysAgo(10), {
      dup_of: key['old-still-referenced'] as string,
      sha256: 'a'.repeat(64),
      bytes: 1,
    }),
  );
  await put('old-linked-out', 'DE-1', 'de-1-series', daysAgo(116));
  // Mixed payloads that carry class and threshold state.
  await put('ch1-first-of-day', 'CH-1', 'ch-1-river', daysAgo(115, 0));
  await put('ch1-later-that-day', 'CH-1', 'ch-1-river', daysAgo(115, 600));
  await put('ch2-old', 'CH-2', 'ch-2-sensors', daysAgo(114));
  // An owner-audience spec: captured, never parsed before P5c.
  await put('owner-unparsed', 'BE-3', 'be-3-levels', daysAgo(113), { parsed: false });
  // A line whose key is not a key: it is data, and it is ignored.
  await archive.append(
    bareLine('DE-1', 'de-1-basin', daysAgo(112), {
      key: 'raw/DE-1/de-1-basin/../../../outside.zst',
      sha256: 'b'.repeat(64),
      bytes: 1,
      stored_bytes: 1,
    }),
  );
  parsed.add('raw/DE-1/de-1-basin/../../../outside.zst');
  writeFileSync(join(base, 'outside.zst'), 'outside the archive');
  writeFileSync(join(base, 'secret.txt'), 'outside the archive');
  // A link swapped in for an old object, pointing out of raw/.
  unlinkSync(archive.path(key['old-linked-out'] as string));
  symlinkSync(join(base, 'secret.txt'), archive.path(key['old-linked-out'] as string));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('plan', () => {
  it('lists only parsed obs objects past the hot window that nothing still refers to', async () => {
    expect(HOT_WINDOW_DAYS).toBe(90);
    const plan = await planOf({ now: NOW });
    expect(plan).toEqual([key['old-obs'], key['old-obs-2'], key['old-linked-out'], key['ch1-later-that-day']].sort());
  });

  it('keeps nothing whole since P7a parses the CH-1 and CH-2 class and threshold fields; their daily copy stays', async () => {
    expect([...KEEP_UNTIL_PARSED]).toEqual([]);
    expect([...MIXED_SOURCES]).toEqual(['CH-1', 'CH-2']);
    const plan = await planOf({ now: NOW });
    for (const name of ['ch1-first-of-day', 'ch2-old']) expect(plan).not.toContain(key[name]);
    // A payload whose batch opened a class or threshold row is promoted by parsedOkIn (load/prune-promotion.int).
    const kept = await planOf({ now: NOW, keepWhole: new Set(['CH-1', 'CH-2']) });
    expect(kept).not.toContain(key['ch1-later-that-day']);
  });

  it('even then, the first copy of each spec and UTC day of a mixed payload is promoted to forever', async () => {
    const plan = await planOf({ now: NOW, keepWhole: new Set() });
    expect(plan).toContain(key['ch1-later-that-day']);
    expect(plan).not.toContain(key['ch1-first-of-day']);
    expect(plan).not.toContain(key['ch2-old']);
  });

  it('never lists a forever class, an unparsed object, a recent one, or one a dup_of line still points at', async () => {
    const plan = await planOf({ now: NOW, keepWhole: new Set() });
    for (const name of ['old-forever', 'old-unparsed', 'owner-unparsed', 'recent-obs', 'old-still-referenced']) {
      expect(plan, name).not.toContain(key[name]);
    }
    expect(plan.every((k) => k.startsWith('raw/') && !k.includes('..'))).toBe(true);
    // Once the last reference is older than the hot window too, the object may go.
    const later = await planOf({ now: new Date(NOW.getTime() + 100 * 86_400_000) });
    expect(later).toContain(key['old-still-referenced']);
  });

  it('bounded passes: candidates only from manifest files older than the window, looked up one file at a time', async () => {
    lookups.length = 0;
    const byFile = [];
    for await (const keys of prunePlan(reader, parsedOk, { now: NOW })) byFile.push(keys);
    // Each lookup and each batch of candidates holds the keys of one manifest day, and only past the window.
    const dayOf = (k: string) => k.split('/').slice(3, 6).join('-');
    const cutoff = new Date(NOW.getTime() - HOT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const keys of [...lookups, ...byFile]) {
      expect(new Set(keys.map(dayOf)).size).toBe(1);
      expect(keys.every((k) => dayOf(k) < cutoff)).toBe(true);
    }
    expect(lookups.length).toBeGreaterThan(1);
    // The object named by a dup_of line inside the window was never even looked up.
    expect(lookups.flat()).not.toContain(key['old-still-referenced']);
  });
});

describe('prune', () => {
  it('is a dry run by default: it reports and deletes nothing', async () => {
    const report = await prune(reader, parsedOk, { now: NOW });
    expect(report).toEqual({ applied: false, candidates: 4, deleted: 0, refused: 1 });
    for (const name of Object.keys(key)) if (name !== 'old-linked-out') expect(exists(name), name).toBe(true);
  });

  it('with apply, deletes exactly the planned objects and refuses a link that points out of raw/', async () => {
    const report = await prune(reader, parsedOk, { now: NOW, apply: true });
    expect(report).toMatchObject({ applied: true, deleted: 3, refused: 1 });
    expect(exists('old-obs')).toBe(false);
    expect(exists('old-obs-2')).toBe(false);
    // P7a: a parsed CH-1 payload that is neither the day's copy nor a promoted change can go.
    expect(exists('ch1-later-that-day')).toBe(false);
    for (const name of [
      'old-unparsed',
      'old-forever',
      'recent-obs',
      'old-still-referenced',
      'ch1-first-of-day',
      'ch2-old',
      'owner-unparsed',
    ]) {
      expect(exists(name), name).toBe(true);
    }
    // Nothing outside raw/ was touched: not through the fake key, not through the link.
    expect(readdirSync(base).sort()).toEqual(['outside.zst', 'raw', 'secret.txt']);
    // The manifest itself is never pruned.
    expect(readdirSync(join(raw, '_manifest')).length).toBeGreaterThan(5);
    // Already gone is not an error the second time.
    expect(await prune(reader, parsedOk, { now: NOW, apply: true })).toMatchObject({ deleted: 0, refused: 1 });
  });
});
