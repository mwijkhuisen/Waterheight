import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { slugOf } from '../../src/adapters/_shared/age/slug.ts';
import {
  combineRun,
  FLOORS,
  ForecastRun,
  type Level,
  normalisePart,
  type Part,
  type PartResult,
  PERCENTILES,
  TIME,
  variantOf,
} from '../../src/adapters/lu-3/normalise.ts';
import { parsePercentile } from '../../src/adapters/lu-3/parse.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// LU-3 AGE percentile forecasts (owner audience, catalogue §2.6): parse + normalise of the hand-made synthetic
// files equal their goldens (invariant 9: owner fixtures are synthetic, real structure, generated values), the
// run rules (no issue time, run key, order and floor flags), the slug of the station files, and the property
// tests. `UPDATE_GOLDEN=1` rewrites goldens.

const root = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const stations = StationsFile.parse(parse(root('registry/stations/lu-1.yaml'))).stations;
/** The LU-1 provider_key by slug, from the station ids `lu.age.<slug>` of registry/stations/lu-1.yaml. */
const keys = new Map(stations.map((s) => [s.id.replace(/^lu\.age\./, ''), s.provider_key]));
const keyOf = (slug: string) => keys.get(slug);

function golden(name: string, actual: PartResult): PartResult {
  const url = goldenUrl('LU-3', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const fixture = (station: string, p: Level) => `lu-3-percentile-${station}-p${p}.synthetic`;
const partOf = (name: string, variant: string) =>
  normalisePart(parsePercentile(rawFixture('LU-3', name).body), { variant, keyOf });
const partsOf = (station: string) =>
  PERCENTILES.map((p) => partOf(fixture(station, p), `${station}/${p}`).part as Part);
const FETCHED = Date.parse('2030-03-30T21:20:00Z');
const RUN = { fetchedAt: FETCHED, displayLimitH: 48 } as const;
const at = (i: number) => new Date(Date.parse('2030-03-01T00:00:00Z') + i * 3_600_000).toISOString();
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** A part built by hand: the values from 2030-03-01T00:00Z, hourly. */
const mk = (slug: string, percentile: Level, values: number[], series = slug): Part => ({
  series,
  slug,
  percentile,
  first_valid: at(0),
  values: values.map((value, i) => ({ ts: at(i), value })),
});
/** Five parts from rows of [p10, p30, p50, p70, p90]. */
const five = (slug: string, rows: number[][]): Part[] =>
  PERCENTILES.map((p, j) =>
    mk(
      slug,
      p,
      rows.map((r) => r[j] as number),
    ),
  );

describe('golden files (synthetic: owner audience)', () => {
  const names = ['diekirch', 'perl'].flatMap((s) => PERCENTILES.map((p) => [fixture(s, p), `${s}/${p}`] as const));
  for (const [name, variant] of names) {
    it(`${name}: parse + normalise equals the golden`, () => {
      const out = partOf(name, variant);
      expect(out).toEqual(golden(name, out));
    });
  }

  it('an empty file has no part, only the drop count', () => {
    const out = partOf('lu-3-percentile-empty.synthetic', 'diekirch/50');
    expect(out).toEqual({ part: null, dropped: { empty: 1 }, unknown: 0 });
    expect(out).toEqual(golden('lu-3-percentile-empty.synthetic', out));
  });

  it('the Diekirch run: 46 hourly steps across the spring-forward step, in UTC; no flags', () => {
    const parts = partsOf('diekirch');
    const [p10] = parts as [Part];
    expect(p10.series).toBe('Diekirch');
    expect(p10.first_valid).toBe('2030-03-30T21:00:00.000Z');
    expect(p10.values).toHaveLength(46);
    // 01:00+01:00 is 00:00Z and the next label, 03:00+02:00, is 01:00Z: no step is lost or doubled.
    expect(p10.values.slice(3, 5).map((v) => v.ts)).toEqual(['2030-03-31T00:00:00.000Z', '2030-03-31T01:00:00.000Z']);
    const { run, dropped } = combineRun(parts, RUN);
    expect(dropped).toEqual({});
    expect(ForecastRun.parse(run)).toEqual(run);
    expect(run?.values.every((v) => v.flags.length === 0)).toBe(true);
    expect(run).toMatchObject({
      series: 'Diekirch',
      slug: 'diekirch',
      first_valid: '2030-03-30T21:00:00.000Z',
      issued_at: '2030-03-30T21:20:00.000Z',
      issued_inferred: true,
      step: 'PT1H',
      display_limit_h: 48,
    });
    // The run key is (series, first_valid, content_hash): the hash of the five value arrays in percentile order.
    expect(run?.content_hash).toBe(sha(parts.map((p) => p.values.map((v) => v.value))));
    // Values as published: the first p10 value of the file.
    expect(run?.values[0]).toMatchObject({ ts: '2030-03-30T21:00:00.000Z', p10: 135.2 });
  });

  it('the Perl run: below_floor where any percentile is at or below 250, values untouched', () => {
    const { run, dropped } = combineRun(partsOf('perl'), { fetchedAt: FETCHED, displayLimitH: null });
    expect(dropped).toEqual({});
    expect(ForecastRun.parse(run)).toEqual(run);
    expect(run?.display_limit_h).toBeNull();
    const flagged = run?.values.map((v) => v.flags.includes('below_floor')) ?? [];
    // Flat floor for 18 steps in every percentile, p10 stays on it until step 19.
    expect(flagged.indexOf(false)).toBe(20);
    expect(flagged.slice(0, 20).every(Boolean)).toBe(true);
    expect(flagged.slice(20).some(Boolean)).toBe(false);
    expect(run?.values[0]).toMatchObject({ p10: 250, p30: 250, p50: 250, p70: 250, p90: 250, flags: ['below_floor'] });
    expect(run?.values[19]).toMatchObject({ p10: 250, p30: 257, p50: 262, p70: 268, p90: 277 });
    expect(run?.values.some((v) => v.flags.includes('order'))).toBe(false);
  });

  it('the P1 capture fixture (15-minute steps, generated) still parses: it is a validity fixture', () => {
    const file = parsePercentile(rawFixture('LU-3', 'lu-3-percentile.synthetic').body);
    expect(file.data).toHaveLength(40);
    expect(normalisePart(file, { variant: 'diekirch/50', keyOf }).part?.values).toHaveLength(40);
  });
});

describe('rules (synthetic)', () => {
  it('declares ISO times with their own offset', () => {
    expect(TIME).toEqual({ kind: 'iso-offset' });
  });

  it('slugs: trim, lowercase, strip accents, `/` and spaces → `-`', () => {
    expect(slugOf('Ettelbrück-/-Alzette')).toBe('ettelbruck-alzette');
    expect(slugOf('Gemünd / Our')).toBe('gemund-our');
    expect(slugOf('Gemünd-Our')).toBe('gemund-our');
    expect(slugOf(' Diekirch ')).toBe('diekirch');
  });

  it('every slug of registry/seed/lu-3.csv is an LU-1 station slug and a fixed point of slugOf', () => {
    const slugs = root('registry/seed/lu-3.csv')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .slice(1);
    expect(slugs).toHaveLength(11);
    for (const slug of slugs) {
      expect([slug, stations.some((s) => s.id === `lu.age.${slug}`)]).toEqual([slug, true]);
      expect([slug, slugOf(slug)]).toEqual([slug, slug]);
      expect(variantOf(`${slug}/50`)).toEqual({ slug, percentile: 50 });
    }
  });

  it('the Moselle floors are those of catalogue §2.6, keyed by an LU-1 slug', () => {
    expect(FLOORS).toEqual({ perl: 250, stadtbredimus: 260, wasserbillig: 220, 'mondorf-les-bains': 250 });
    for (const slug of Object.keys(FLOORS))
      expect([slug, stations.some((s) => s.id === `lu.age.${slug}`)]).toEqual([slug, true]);
  });

  it('a manifest variant is `<slug>/<p>` or drift', () => {
    expect(variantOf('ettelbruck-alzette/90')).toEqual({ slug: 'ettelbruck-alzette', percentile: 90 });
    for (const bad of [
      'diekirch',
      'diekirch/20',
      'Diekirch/50',
      '/50',
      'a--b/50',
      'a-/50',
      'diekirch/50/',
      'a/b/50',
      '',
    ])
      expect(() => variantOf(bad)).toThrow(expect.objectContaining({ code: 'bad_variant' }));
  });

  it('a slug the registry does not know is counted, never guessed', () => {
    expect(partOf('lu-3-percentile-diekirch-p50.synthetic', 'nowhere/50')).toEqual({
      part: null,
      dropped: {},
      unknown: 1,
    });
  });

  it('a null value is a gap, never 0; a file of gaps only is empty', () => {
    const file = { rows: null, columns: null, ts_path: null, ts_unitsymbol: null, parametertype_name: null } as const;
    const data = [
      ['2030-03-01T00:00:00.000+01:00', 100.5],
      ['2030-03-01T01:00:00.000+01:00', null],
      ['2030-03-01T02:00:00.000+01:00', 0],
    ] as [string, number | null][];
    const out = normalisePart({ ...file, station_name: 'x', data }, { variant: 'diekirch/10', keyOf });
    expect(out.dropped).toEqual({ gap: 1 });
    expect(out.part?.values).toEqual([
      { ts: '2030-02-28T23:00:00.000Z', value: 100.5 },
      { ts: '2030-03-01T01:00:00.000Z', value: 0 },
    ]);
    expect(out.part?.first_valid).toBe('2030-02-28T23:00:00.000Z');
    const gaps = normalisePart(
      { ...file, station_name: 'x', data: [['2030-03-01T00:00:00.000+01:00', null]] },
      { variant: 'diekirch/10', keyOf },
    );
    expect(gaps).toEqual({ part: null, dropped: { gap: 1, empty: 1 }, unknown: 0 });
  });

  it('steps must be strictly increasing and carry an offset: drift otherwise', () => {
    const file = { rows: null, columns: null, ts_path: null, ts_unitsymbol: null, parametertype_name: null } as const;
    const run = (data: [string, number][]) =>
      normalisePart({ ...file, station_name: 'x', data }, { variant: 'diekirch/10', keyOf });
    const a = '2030-03-01T00:00:00.000+01:00';
    const b = '2030-03-01T01:00:00.000+01:00';
    expect(() =>
      run([
        [b, 1],
        [a, 2],
      ]),
    ).toThrow(expect.objectContaining({ code: 'time_order', path: 'data.1' }));
    expect(() =>
      run([
        [a, 1],
        [a, 2],
      ]),
    ).toThrow(expect.objectContaining({ code: 'time_order' }));
    // The same instant under two offsets is no step.
    expect(() =>
      run([
        ['2030-03-01T01:00:00.000+01:00', 1],
        ['2030-03-01T00:00:00.000Z', 2],
      ]),
    ).toThrow(expect.objectContaining({ code: 'time_order' }));
    expect(() => run([['2030-03-01T00:00:00.000', 1]])).toThrow(expect.objectContaining({ code: 'time_bad_format' }));
    expect(() => run([['soon', 1]])).toThrow(SchemaDrift);
  });

  it('parse: strict schema, fixed codes', () => {
    const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
    const good = JSON.parse(rawFixture('LU-3', 'lu-3-percentile-empty.synthetic').body.toString('utf8'));
    expect(() => parsePercentile(bytes(good))).not.toThrow();
    expect(() => parsePercentile(Buffer.from([0xff, 0xfe, 0x7b]))).toThrow(
      expect.objectContaining({ code: 'encoding' }),
    );
    expect(() => parsePercentile(Buffer.from('{"rows":'))).toThrow(expect.objectContaining({ code: 'not_json' }));
    expect(() => parsePercentile(bytes({ ...good, extra: 1 }))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, rows: [] }))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, parametertype_name: 'Wasserstand' }))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, station_name: 'x'.repeat(201) }))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, data: [['2030-03-01T00:00:00.000Z', '1']] }))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, data: [['2030-03-01T00:00:00.000Z', 1, 2]] }))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, data: [['2030-03-01T00:00:00.000Z']] }))).toThrow(SchemaDrift);
    const many = Array.from({ length: 501 }, (_, i) => [at(i), 1]);
    expect(() => parsePercentile(bytes({ ...good, data: many }))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, data: many.slice(0, 500) }))).not.toThrow();
    expect(() => parsePercentile(bytes([]))).toThrow(SchemaDrift);
    expect(() => parsePercentile(bytes({ ...good, data: [[[[[]]]]] }))).toThrow(
      expect.objectContaining({ code: 'json_too_deep' }),
    );
  });

  it('a run is exactly one part of each of the five percentiles', () => {
    const rows = [[1, 2, 3, 4, 5]];
    const parts = five('diekirch', rows);
    expect(combineRun(parts, RUN).run).not.toBeNull();
    expect(combineRun([], RUN)).toEqual({ run: null, dropped: { incomplete_run: 1 } });
    expect(combineRun(parts.slice(0, 4), RUN).dropped).toEqual({ incomplete_run: 1 });
    expect(combineRun([...parts, parts[0] as Part], RUN).dropped).toEqual({ incomplete_run: 1 });
    // Five parts, one percentile twice and one missing.
    expect(combineRun([...parts.slice(0, 4), parts[0] as Part], RUN).dropped).toEqual({ incomplete_run: 1 });
  });

  it('parts of two series, two first steps or other valid times are no run', () => {
    const parts = five('diekirch', [
      [1, 2, 3, 4, 5],
      [2, 3, 4, 5, 6],
    ]);
    const swap = (i: number, p: Part) => parts.map((x, j) => (j === i ? p : x));
    const p50 = parts[2] as Part;
    const bad = [
      swap(2, { ...p50, series: 'Bissen' }),
      swap(2, { ...p50, slug: 'bissen' }),
      swap(2, { ...p50, first_valid: at(1) }),
      swap(2, { ...p50, values: p50.values.slice(0, 1) }),
      swap(2, {
        ...p50,
        values: [
          { ts: at(0), value: 3 },
          { ts: at(5), value: 4 },
        ],
      }),
    ];
    for (const b of bad) expect(combineRun(b, RUN)).toEqual({ run: null, dropped: { run_mismatch: 1 } });
  });

  it('steps that are not one hour apart are no PT1H run', () => {
    const skip = (p: Part): Part => ({
      ...p,
      values: [p.values[0] as Part['values'][number], { ts: at(2), value: 9 }],
    });
    const parts = five('diekirch', [
      [1, 2, 3, 4, 5],
      [2, 3, 4, 5, 6],
    ]).map(skip);
    expect(combineRun(parts, RUN)).toEqual({ run: null, dropped: { step_mismatch: 1 } });
  });

  it('crossing percentiles are flagged `order` and never reordered; p30 and p70 keep their names', () => {
    const { run } = combineRun(
      five('diekirch', [
        [100, 110, 120, 130, 140],
        [100, 130, 120, 140, 150],
        [100, 110, 120, 130, 125],
        [150, 110, 120, 130, 140],
      ]),
      RUN,
    );
    expect(run?.values.map((v) => v.flags)).toEqual([[], ['order'], ['order'], ['order']]);
    expect(run?.values[1]).toMatchObject({ p10: 100, p30: 130, p50: 120, p70: 140, p90: 150 });
    expect(run?.values[3]).toMatchObject({ p10: 150, p30: 110 });
    expect(ForecastRun.parse(run)).toEqual(run);
  });

  it('equal percentiles are in order; a changed value changes the run key', () => {
    const rows = [
      [100, 100, 100, 100, 100],
      [101, 102, 103, 104, 105],
    ];
    const a = combineRun(five('diekirch', rows), RUN).run;
    const b = combineRun(five('diekirch', [rows[0] as number[], [101, 102, 103, 104, 106]]), RUN).run;
    expect(a?.values.map((v) => v.flags)).toEqual([[], []]);
    expect(a?.content_hash).not.toBe(b?.content_hash);
    expect(a?.first_valid).toBe(b?.first_valid);
    // The fetch time is no part of the key.
    expect(combineRun(five('diekirch', rows), { ...RUN, fetchedAt: FETCHED + 3_600_000 }).run?.content_hash).toBe(
      a?.content_hash,
    );
  });

  it('Moselle floors: perl 250, stadtbredimus 260, wasserbillig 220; an AGE station has none', () => {
    const rows = [[200, 230, 250, 260, 270]];
    const flags = (slug: string, r = rows) => combineRun(five(slug, r), RUN).run?.values.map((v) => v.flags);
    expect(flags('perl')).toEqual([['below_floor']]);
    expect(flags('stadtbredimus')).toEqual([['below_floor']]);
    expect(flags('wasserbillig')).toEqual([['below_floor']]);
    expect(flags('wasserbillig', [[221, 230, 250, 260, 270]])).toEqual([[]]);
    expect(flags('wasserbillig', [[220, 230, 250, 260, 270]])).toEqual([['below_floor']]);
    expect(flags('perl', [[251, 252, 253, 254, 255]])).toEqual([[]]);
    expect(flags('perl', [[250, 252, 253, 254, 255]])).toEqual([['below_floor']]);
    // Both flags at once, in this order.
    expect(flags('perl', [[260, 240, 270, 280, 290]])).toEqual([['order', 'below_floor']]);
    expect(flags('diekirch')).toEqual([[]]);
    expect(flags('constructor')).toEqual([[]]);
  });
});

describe('the archive-derived fixtures (fixtures:synth: real structure, generated values)', () => {
  // Five files of one run (diekirch, p10 … p90): real structure, every value generated, every timestamp shifted years
  // ahead by one constant, so the fetch time of the run is the files' newest instant + 10 minutes.
  const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
  const archive = (p: Level) => `lu-3-percentile-archive-diekirch-p${p}.synthetic`;

  for (const p of PERCENTILES) {
    it(`${archive(p)}: parses and normalises to the LU-1 key of diekirch`, () => {
      const name = archive(p);
      const out = partOf(name, `diekirch/${p}`);
      expect(out).toEqual(golden(name, out));
      expect(out.unknown).toBe(0);
      expect(out.dropped).toEqual({});
      const part = out.part as Part;
      expect(part).toMatchObject({ series: keyOf('diekirch'), slug: 'diekirch', percentile: p });
      expect(part.values.length).toBeGreaterThan(0);
      expect(part.first_valid).toBe(part.values[0]?.ts);
    });
  }

  it('the five parts combine into one run: 5 percentiles per step, a 64-hex content hash', () => {
    const all = PERCENTILES.map((p) => partOf(archive(p), `diekirch/${p}`).part as Part);
    const newest = Math.max(
      ...PERCENTILES.flatMap((p) => rawFixture('LU-3', archive(p)).body.toString('utf8').match(STAMP) ?? []).map((s) =>
        Date.parse(s),
      ),
    );
    const { run, dropped } = combineRun(all, { fetchedAt: newest + 600_000, displayLimitH: 48 });
    // Which steps carry an `order` flag is whatever the generated values give; only the shape of the run is asserted.
    expect(dropped).toEqual({});
    expect(run).not.toBeNull();
    expect(ForecastRun.parse(run)).toEqual(run);
    expect(run?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run?.series).toBe(keyOf('diekirch'));
    expect(run?.values).toHaveLength((all[0] as Part).values.length);
    for (const v of run?.values ?? []) {
      for (const k of ['p10', 'p30', 'p50', 'p70', 'p90'] as const) expect(Number.isFinite(v[k])).toBe(true);
    }
  });
});

describe('property and fuzz', () => {
  const level = fc.integer({ min: 0, max: 100_000 }).map((n) => n / 10);
  const tuple = fc.tuple(level, level, level, level, level);
  const steps = fc.array(tuple, { minLength: 1, maxLength: 40 });
  const sorted = (t: number[]) => t.every((x, i) => i === 0 || x >= (t[i - 1] as number));

  it('`order` exactly when a step is not p10 ≤ p30 ≤ p50 ≤ p70 ≤ p90, values unchanged', () => {
    fc.assert(
      fc.property(steps, (rows) => {
        const { run, dropped } = combineRun(five('diekirch', rows), RUN);
        expect(dropped).toEqual({});
        expect(ForecastRun.parse(run)).toEqual(run);
        expect(run?.values.map((v) => v.flags.includes('order'))).toEqual(rows.map((r) => !sorted(r)));
        expect(run?.values.map((v) => [v.p10, v.p30, v.p50, v.p70, v.p90])).toEqual(rows);
        expect(run?.values.some((v) => v.flags.includes('below_floor'))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('a sorted set is never `order`; `below_floor` exactly when any value is at or below the floor', () => {
    fc.assert(
      fc.property(
        steps,
        fc.constantFrom('perl', 'stadtbredimus', 'wasserbillig', 'mondorf-les-bains'),
        (rows, slug) => {
          const floor = FLOORS[slug] as number;
          const ordered = rows.map((r) => [...r].sort((a, b) => a - b));
          const { run } = combineRun(five(slug, ordered), RUN);
          expect(run?.values.map((v) => v.flags.includes('order'))).toEqual(ordered.map(() => false));
          expect(run?.values.map((v) => v.flags.includes('below_floor'))).toEqual(
            ordered.map((r) => r.some((x) => x <= floor)),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('arbitrary bytes into parsePercentile throw only SchemaDrift', () => {
    const real = rawFixture('LU-3', 'lu-3-percentile-diekirch-p50.synthetic').body;
    const flipped = fc
      .tuple(fc.nat(real.length - 1), fc.integer({ min: 0, max: 255 }))
      .map(([i, b]) => Buffer.concat([real.subarray(0, i), Buffer.from([b]), real.subarray(i + 1)]));
    const truncated = fc.nat(real.length).map((n) => real.subarray(0, n));
    const json = fc.jsonValue().map((v) => Buffer.from(JSON.stringify(v)));
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 300 }), flipped, truncated, json), (bytes) => {
        try {
          parsePercentile(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('slugOf gives a slug and is idempotent', () => {
    const word = fc.stringMatching(/^[a-zA-Z0-9éüöèçäàêñÉÜ]{1,8}$/);
    const sep = fc.constantFrom(' ', '/', ' / ', '-/-', '  ', ' - ', '-');
    const name = fc
      .tuple(word, fc.array(fc.tuple(sep, word), { maxLength: 4 }))
      .map(([w, rest]) => w + rest.map(([s, x]) => s + x).join(''))
      .filter((s) => /[a-zA-Z]/.test(s));
    fc.assert(
      fc.property(name, (s) => {
        const slug = slugOf(` ${s} `);
        expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(slugOf(slug)).toBe(slug);
      }),
      { numRuns: 300 },
    );
  });
});
