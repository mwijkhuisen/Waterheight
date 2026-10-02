import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { VALUE_WITH_UNIT, VERBATIM } from '../../../../scripts/synthesize-fixture.ts';
import { extractDataToJson } from '../../src/http/guards.ts';

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

// Owner-audience sources are read from the registry, never listed here: a source added later is covered at once.
const OwnerSources = z.object({
  sources: z.array(z.looseObject({ id: z.string(), audience: z.enum(['public', 'owner', 'off']) })),
});
const ownerSources = OwnerSources.parse(
  parseYaml(readFileSync(new URL('../../../../registry/sources.yaml', import.meta.url), 'utf8')),
)
  .sources.filter((s) => s.audience === 'owner')
  .map((s) => s.id.toLowerCase());
const ownerAdapters = adapters.filter((a) => ownerSources.includes(a));

/**
 * What is wrong with the fixtures in a folder of an owner-audience adapter (invariants 9 and 11: the repository is
 * public, so only synthetic payloads are committed). Every entry is a regular file named *.synthetic.raw,
 * *.synthetic.meta.json or *.synthetic.golden.json (P5c review CR-2: a real payload under any other name, or in a
 * subdirectory, would pass a rule that looks only at known suffixes). Names and rules only, never content.
 */
function ownerFixtureProblems(dir: URL): string[] {
  const problems: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const f = e.name;
    if (!e.isFile()) {
      problems.push(`${f}: not a regular file (a subdirectory or a link)`);
      continue;
    }
    if (!/\.synthetic\.(raw|meta\.json|golden\.json)$/.test(f))
      problems.push(`${f}: not named *.synthetic.raw, *.synthetic.meta.json or *.synthetic.golden.json`);
    if (!f.endsWith('.raw')) continue;
    const metaFile = new URL(f.replace(/\.raw$/, '.meta.json'), dir);
    let m: Record<string, unknown> | null = null;
    try {
      m = JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch {
      problems.push(`${f}: no readable meta.json`);
    }
    if (m === null || typeof m !== 'object') continue;
    if (m.synthetic !== true) problems.push(`${f}: meta is not synthetic: true`);
    if ('from' in m) problems.push(`${f}: meta has a from (a cut of a real payload)`);
    if ('recorded_at' in m) problems.push(`${f}: meta has recorded_at (a recording)`);
    if (m.source_sha256 !== undefined && m.source_sha256 === sha256(readFileSync(new URL(f, dir))))
      problems.push(`${f}: the raw file is its own source (source_sha256)`);
  }
  return problems;
}

/**
 * Kept (VERBATIM) keys whose values are identifiers or codes that hold digits: ids, station numbers, `ts_path` and the
 * series names built from it, file names, the KiWIS row count, coordinate system, time zone and offset codes, and
 * AGE's forecast horizon codes. Any other kept key holds no run of two digits.
 */
const KEPT_WITH_DIGITS = new Set([
  'ts_id',
  'station_no',
  'site_no',
  'stationparameter_no',
  'ts_path',
  'ts_name',
  'ts_spacing',
  'rows',
  'station_georefsystem',
  'timezone',
  'station_timezone',
  'station_utcoffset',
  'id',
  'jsonFile',
  'forecastsFileName',
  'stationPath',
  'forecastsLimit',
  'legend',
]);

/** Every leaf under a kept key or table column of a payload, with that key: what the fixture tool copied as is. */
function* keptLeaves(v: unknown, kept: ReadonlySet<string>, under: string | null = null): Generator<[string, unknown]> {
  if (Array.isArray(v)) {
    const header =
      under === null && v.length > 1 && Array.isArray(v[0]) && v[0].every((x) => typeof x === 'string')
        ? (v[0] as string[])
        : null;
    for (const [i, x] of v.entries())
      if (header !== null && i > 0 && Array.isArray(x))
        for (const [j, cell] of x.entries()) {
          const col = header[j];
          yield* keptLeaves(cell, kept, col !== undefined && kept.has(col) ? col : null);
        }
      else if (header === null || i > 0) yield* keptLeaves(x, kept, under);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) yield* keptLeaves(x, kept, under ?? (kept.has(k) ? k : null));
  } else if (under !== null) yield [under, v];
}

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

  it('every adapter that has a parse.ts has at least three real goldens (pinned exceptions below three; owner sources have synthetic ones)', () => {
    const withParse = adapters.filter(
      (a) => existsSync(new URL(`${a}/parse.ts`, ADAPTERS)) && !ownerAdapters.includes(a),
    );
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

  it('the owner-audience sources are read from the registry', () => {
    expect(ownerAdapters).toEqual(expect.arrayContaining(['be-3', 'de-2', 'de-3', 'lu-2', 'lu-3', 'lu-4']));
    for (const a of ownerAdapters) expect([a, ownerSources.includes(a)]).toEqual([a, true]);
  });

  it('every fixture of an owner-audience adapter is synthetic: *.synthetic.*, synthetic: true, no from, no recorded_at, not its own source', () => {
    for (const adapter of ownerAdapters)
      expect([adapter, ownerFixtureProblems(fixturesOf(adapter))]).toEqual([adapter, []]);
  });

  it('every owner-audience adapter that has a parse.ts has at least three synthetic goldens', () => {
    for (const adapter of ownerAdapters.filter((a) => existsSync(new URL(`${a}/parse.ts`, ADAPTERS)))) {
      const synthetic = files(adapter, '.golden.json').filter((f) => isSynthetic(f.name)).length;
      expect([adapter, synthetic >= REAL_GOLDENS]).toEqual([adapter, true]);
    }
  });

  it('an archive-derived owner fixture keeps under its kept keys no value with a unit and no digits but identifiers and codes (P5c review SR-2)', () => {
    let fixtures = 0;
    let leaves = 0;
    for (const adapter of ownerAdapters)
      for (const f of files(adapter, '.meta.json').filter((x) => meta(x).source_sha256 !== undefined)) {
        const raw = read(f, '.raw');
        let doc: unknown;
        try {
          doc = JSON.parse(raw.toString('utf8'));
        } catch {
          doc = extractDataToJson(raw);
        }
        fixtures += 1;
        for (const [key, v] of keptLeaves(doc, new Set(VERBATIM[meta(f).source] ?? []))) {
          leaves += 1;
          const text = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
          expect([f.name, key, VALUE_WITH_UNIT.test(text)]).toEqual([f.name, key, false]);
          if (!KEPT_WITH_DIGITS.has(key)) expect([f.name, key, /\d{2}/.test(text)]).toEqual([f.name, key, false]);
        }
      }
    // Not vacuous: the 16 archive-derived fixtures of BE-3, LU-2, LU-3 and LU-4, and their kept identifiers.
    expect(fixtures).toBeGreaterThanOrEqual(16);
    expect(leaves).toBeGreaterThan(100);
    // The walk finds kept keys at any depth, kept table columns and everything under a kept key (invented data).
    const doc = [
      ['station_no', 'station_name'],
      ['5902', 'Mijn Station'],
    ];
    const label = { label: 'Cote de vigilance orange 321 cm', levels: [{ label: 'x' }], value: 3 };
    expect([...keptLeaves(doc, new Set(['station_no']))]).toEqual([['station_no', '5902']]);
    expect([...keptLeaves([label], new Set(['label']))]).toEqual([
      ['label', 'Cote de vigilance orange 321 cm'],
      ['label', 'x'],
    ]);
  });

  it('the owner rule fails on a planted real payload, a cut of one and a synthetic copy of its own source', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'owner-fixtures-'));
    try {
      const put = (name: string, body: string) => writeFileSync(join(tmp, name), body);
      const meta = (m: object) => JSON.stringify({ spec: 'x-1', source: 'BE-3', status: 200, ...m });
      // A good one first: the rule must not flag it.
      put('good.synthetic.raw', '[1]');
      put('good.synthetic.meta.json', meta({ synthetic: true, source_sha256: sha256(Buffer.from('[2]')) }));
      // 1: a real payload (not named *.synthetic.raw, not marked synthetic).
      put('real.raw', '[3]');
      put('real.meta.json', meta({ synthetic: false, recorded_at: '2026-09-29T10:00:00Z' }));
      // 2: a synthetic raw whose meta says it is its own source.
      put('copy.synthetic.raw', '[4]');
      put('copy.synthetic.meta.json', meta({ synthetic: true, source_sha256: sha256(Buffer.from('[4]')) }));
      // 3: a synthetic name over a cut of an archived payload.
      put('cut.synthetic.raw', '[5]');
      put('cut.synthetic.meta.json', meta({ synthetic: true, from: 'archive', archive_key: 'raw/x.zst' }));
      // 4: a real payload under another name, and in a subdirectory (P5c review CR-2).
      put('b.json', '[6]');
      put('c.csv', 'Datum;W\n');
      mkdirSync(join(tmp, 'sub'));
      put('sub/d.synthetic.raw', '[7]');
      const problems = ownerFixtureProblems(pathToFileURL(`${tmp}/`));
      const of = (file: string) => problems.filter((p) => p.startsWith(`${file}:`));
      expect(of('good.synthetic.raw')).toEqual([]);
      expect(of('real.raw').length).toBeGreaterThanOrEqual(2);
      expect(of('real.meta.json')).toHaveLength(1);
      expect(of('copy.synthetic.raw')).toHaveLength(1);
      expect(of('cut.synthetic.raw')).toHaveLength(1);
      expect(of('b.json')).toHaveLength(1);
      expect(of('c.csv')).toHaveLength(1);
      expect(of('sub')).toHaveLength(1);
      expect(of('good.synthetic.meta.json')).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
