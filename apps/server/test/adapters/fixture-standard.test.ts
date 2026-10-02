import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// The P5a fixture standard (CLAUDE.md, invariants 9 and 11): every fixture has a
// .meta.json that says where it comes from, `synthetic: true` marks exactly the
// files named `*.synthetic.*`, a golden belongs to the raw file of its name, a
// body cut from an archive or a recording says what it was cut from, and every
// adapter has real goldens. Reads the files, runs no adapter.

const ADAPTERS = new URL('../../src/adapters/', import.meta.url);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Fixture = { adapter: string; name: string; dir: URL };
const adapters = readdirSync(ADAPTERS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/fixtures/`, ADAPTERS)))
  .map((d) => d.name)
  .sort();
const fixturesOf = (adapter: string) => new URL(`${adapter}/fixtures/`, ADAPTERS);
const files = (adapter: string, suffix: string): Fixture[] =>
  readdirSync(fixturesOf(adapter))
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => ({ adapter, name: f.slice(0, -suffix.length), dir: fixturesOf(adapter) }));
const all = (suffix: string) => adapters.flatMap((a) => files(a, suffix));
const read = (f: Fixture, suffix: string) => readFileSync(new URL(`${f.name}${suffix}`, f.dir));
const isSynthetic = (name: string) => name.endsWith('.synthetic');

const Meta = z.looseObject({
  spec: z.string().min(1),
  source: z.string().regex(/^[A-Z]{2}-\d+$/),
  synthetic: z.boolean(),
  status: z.number().int(),
  recorded_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    .optional(),
  from: z.enum(['archive', 'trimmed']).optional(),
  archive_key: z.string().min(1).optional(),
  source_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  trimmed: z.union([z.boolean(), z.string().min(1)]).optional(),
});
type Meta = z.infer<typeof Meta>;
const meta = (f: Fixture): Meta => Meta.parse(JSON.parse(read(f, '.meta.json').toString('utf8')));

/**
 * Adapters with fewer than three real goldens, pinned at their count so that none can lose one, and each entry
 * deleted once it reaches three: NL-2 and NL-4 predate the standard (one real payload each, the rest synthetic).
 */
const BELOW_STANDARD: Readonly<Record<string, number>> = { 'nl-2': 1, 'nl-4': 1 };
const REAL_GOLDENS = 3;

describe('the fixture standard', () => {
  it('there are fixtures to check (a moved folder would otherwise pass everything)', () => {
    expect(all('.meta.json').length).toBeGreaterThan(70);
    expect(adapters).toEqual(expect.arrayContaining(['ch-1', 'ch-2', 'ch-3', 'de-1', 'fr-1', 'fr-3', 'nl-1']));
  });

  it('every .meta.json parses, names its own adapter as its source, and has a raw file beside it', () => {
    for (const f of all('.meta.json')) {
      const m = meta(f);
      expect([f.adapter, f.name, m.source]).toEqual([f.adapter, f.name, f.adapter.toUpperCase()]);
      expect([f.name, existsSync(new URL(`${f.name}.raw`, f.dir))]).toEqual([f.name, true]);
      // A recording says when it was recorded; only a synthetic payload has no such time.
      if (!m.synthetic) expect([f.name, m.recorded_at === undefined]).toEqual([f.name, false]);
    }
    for (const f of all('.raw'))
      expect([f.name, existsSync(new URL(`${f.name}.meta.json`, f.dir))]).toEqual([f.name, true]);
  });

  it('`synthetic: true` exactly for the files named *.synthetic.*', () => {
    for (const f of all('.meta.json'))
      expect([f.adapter, f.name, meta(f).synthetic]).toEqual([f.adapter, f.name, isSynthetic(f.name)]);
  });

  it('a golden belongs to the raw file of its name: a real one to a real payload, a *.synthetic one to a synthetic payload', () => {
    const goldens = all('.golden.json');
    expect(goldens.length).toBeGreaterThan(30);
    for (const f of goldens) {
      expect([f.adapter, f.name, existsSync(new URL(`${f.name}.raw`, f.dir))]).toEqual([f.adapter, f.name, true]);
      expect([f.adapter, f.name, meta(f).synthetic]).toEqual([f.adapter, f.name, isSynthetic(f.name)]);
      // A golden is JSON: an object that holds what the adapter produced.
      const golden = JSON.parse(read(f, '.golden.json').toString('utf8'));
      expect([f.adapter, f.name, typeof golden, Array.isArray(golden)]).toEqual([f.adapter, f.name, 'object', false]);
    }
  });

  it('a payload cut from an archive or a recording names its source by a 64-hex sha256; an uncut one is that source', () => {
    const cut = all('.meta.json').filter((f) => meta(f).from !== undefined);
    expect(cut.length).toBeGreaterThanOrEqual(12);
    for (const f of cut) {
      const m = meta(f);
      expect([f.name, m.source_sha256 !== undefined]).toEqual([f.name, true]);
      if (m.from === 'archive') expect([f.name, m.archive_key !== undefined]).toEqual([f.name, true]);
      if (m.from === 'trimmed') expect([f.name, typeof m.trimmed]).toEqual([f.name, 'string']);
      // Not cut: the raw file is the archived object, byte for byte.
      if (m.trimmed === false) expect([f.name, sha256(read(f, '.raw'))]).toEqual([f.name, m.source_sha256]);
      // Cut: it is not the source, and the meta says by which rule.
      if (typeof m.trimmed === 'string')
        expect([f.name, sha256(read(f, '.raw')) === m.source_sha256]).toEqual([f.name, false]);
      expect(m.synthetic).toBe(false);
    }
  });

  it('every adapter that has a parse.ts has at least three real goldens (pinned exceptions below three)', () => {
    const withParse = adapters.filter((a) => existsSync(new URL(`${a}/parse.ts`, ADAPTERS)));
    expect(withParse).toEqual(
      expect.arrayContaining(['ch-1', 'ch-2', 'ch-3', 'de-1', 'fr-1', 'fr-3', 'nl-1', 'nl-2', 'nl-4']),
    );
    for (const adapter of withParse) {
      const real = files(adapter, '.golden.json').filter((f) => !isSynthetic(f.name)).length;
      const floor = BELOW_STANDARD[adapter] ?? REAL_GOLDENS;
      expect([adapter, real >= floor]).toEqual([adapter, true]);
    }
  });

  it('an exception is deleted as soon as its adapter reaches the standard', () => {
    for (const [adapter, floor] of Object.entries(BELOW_STANDARD)) {
      expect(floor).toBeLessThan(REAL_GOLDENS);
      const real = files(adapter, '.golden.json').filter((f) => !isSynthetic(f.name)).length;
      expect([adapter, real < REAL_GOLDENS]).toEqual([adapter, true]);
    }
  });
});
