import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import {
  type CanonRun,
  checkRun,
  encodeRun,
  FORECAST_FLAGS,
  FORECAST_SOURCES,
  type ForecastRunIn,
  SchemaDrift,
  type StagedPart,
} from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { slugOf } from '../../src/adapters/_shared/age/slug.ts';
import {
  combineRun,
  combineStaged,
  FLOORS,
  type Level,
  normalisePart,
  type Part,
  PartData,
  type PartResult,
  PERCENTILES,
  TIME,
  variantOf,
} from '../../src/adapters/lu-3/normalise.ts';
import { parsePercentile } from '../../src/adapters/lu-3/parse.ts';
import { REGISTRY_DIR, readSeed } from '../../src/capture/specs.ts';
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
const at = (i: number) => new Date(Date.parse('2030-03-01T00:00:00Z') + i * 3_600_000).toISOString();
const { ORDER, BELOW_FLOOR } = FORECAST_FLAGS;
/** What the loader's pipeline does to a run before it stores it: the core bounds (nothing dropped, no drift). */
function checked(run: ForecastRunIn | null | undefined, fetchedAt = FETCHED): CanonRun {
  expect(run).toBeTruthy();
  const out = checkRun(run as ForecastRunIn, fetchedAt, FORECAST_SOURCES['LU-3']);
  expect(out.dropped).toEqual({});
  return out.run as CanonRun;
}
/** The content the server hashes (`runHash` is sha256 over this encoding). */
const sha = (run: CanonRun) => createHash('sha256').update(encodeRun(run)).digest('hex');
/** The files of one station as the loader stages them: through the app_meta JSON round trip. */
const staged = (parts: readonly Part[], fetchedAt = FETCHED): StagedPart[] =>
  parts.map((p) => ({ part: String(p.percentile), fetchedAt, data: JSON.parse(JSON.stringify(p)) }));

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
    const { run, dropped } = combineRun(parts);
    expect(dropped).toEqual({});
    // One quantiles run of the LU-1 series, no issue time (the loader infers it), no provider segment.
    expect(run).toMatchObject({
      target: 'LU-1',
      series: 'Diekirch',
      kind: 'quantiles',
      stepMs: 3_600_000,
      issuedAt: null,
      providerSegmentEnd: null,
    });
    expect(run?.points).toHaveLength(46);
    expect(run?.points.every((v) => v.flags === 0)).toBe(true);
    // Values as published: the first p10 value of the file; `value` is p50.
    expect(run?.points[0]).toMatchObject({ ts: '2030-03-30T21:00:00.000Z', p10: 135.2 });
    for (const v of run?.points ?? []) expect(v.value).toBe(v.p50);
    // The core bounds accept it as it stands (horizon 48 h, hourly quantiles).
    expect(checked(run).points).toHaveLength(46);
  });

  it('the Perl run: below_floor where any percentile is at or below 250, values untouched', () => {
    const { run, dropped } = combineRun(partsOf('perl'));
    expect(dropped).toEqual({});
    expect(checked(run).points).toHaveLength(46);
    const flagged = run?.points.map((v) => (v.flags & BELOW_FLOOR) !== 0) ?? [];
    // Flat floor for 18 steps in every percentile, p10 stays on it until step 19.
    expect(flagged.indexOf(false)).toBe(20);
    expect(flagged.slice(0, 20).every(Boolean)).toBe(true);
    expect(flagged.slice(20).some(Boolean)).toBe(false);
    expect(run?.points[0]).toMatchObject({
      value: 250,
      p10: 250,
      p30: 250,
      p50: 250,
      p70: 250,
      p90: 250,
      flags: BELOW_FLOOR,
    });
    expect(run?.points[19]).toMatchObject({ p10: 250, p30: 257, p50: 262, p70: 268, p90: 277, flags: BELOW_FLOOR });
    expect(run?.points[20]?.flags).toBe(0);
    expect(run?.points.some((v) => (v.flags & ORDER) !== 0)).toBe(false);
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
    const slugs = readSeed(REGISTRY_DIR, 'lu-3').map((r) => r.slug as string);
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
    expect(combineRun(parts).run).not.toBeNull();
    expect(combineRun([])).toEqual({ run: null, dropped: { incomplete_run: 1 } });
    expect(combineRun(parts.slice(0, 4)).dropped).toEqual({ incomplete_run: 1 });
    expect(combineRun([...parts, parts[0] as Part]).dropped).toEqual({ incomplete_run: 1 });
    // Five parts, one percentile twice and one missing.
    expect(combineRun([...parts.slice(0, 4), parts[0] as Part]).dropped).toEqual({ incomplete_run: 1 });
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
    for (const b of bad) expect(combineRun(b)).toEqual({ run: null, dropped: { run_mismatch: 1 } });
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
    expect(combineRun(parts)).toEqual({ run: null, dropped: { step_mismatch: 1 } });
  });

  it('crossing percentiles get the ORDER flag and are never reordered; p30 and p70 keep their names', () => {
    const { run } = combineRun(
      five('diekirch', [
        [100, 110, 120, 130, 140],
        [100, 130, 120, 140, 150],
        [100, 110, 120, 130, 125],
        [150, 110, 120, 130, 140],
      ]),
    );
    expect(run?.points.map((v) => v.flags)).toEqual([0, ORDER, ORDER, ORDER]);
    expect(run?.points[1]).toMatchObject({ value: 120, p10: 100, p30: 130, p50: 120, p70: 140, p90: 150 });
    expect(run?.points[3]).toMatchObject({ p10: 150, p30: 110 });
    expect(checked(run).points).toHaveLength(4);
  });

  it('equal percentiles are in order; a changed value changes the run bytes, the fetch time is no part of them', () => {
    const rows = [
      [100, 100, 100, 100, 100],
      [101, 102, 103, 104, 105],
    ];
    const a = checked(combineRun(five('diekirch', rows)).run);
    const b = checked(combineRun(five('diekirch', [rows[0] as number[], [101, 102, 103, 104, 106]])).run);
    expect(a.points.map((v) => v.flags)).toEqual([0, 0]);
    expect(sha(a)).not.toBe(sha(b));
    expect(a.points[0]?.ms).toBe(b.points[0]?.ms);
    // The same parts staged at another fetch time are the same run (no issue time: the loader infers it).
    const later = combineStaged(staged(five('diekirch', rows), FETCHED + 3_600_000)).runs[0];
    expect(sha(checked(later, FETCHED))).toBe(sha(a));
  });

  it('Moselle floors: perl 250, stadtbredimus 260, wasserbillig 220; an AGE station has none', () => {
    const rows = [[200, 230, 250, 260, 270]];
    const flags = (slug: string, r = rows) => combineRun(five(slug, r)).run?.points.map((v) => v.flags);
    expect(flags('perl')).toEqual([BELOW_FLOOR]);
    expect(flags('stadtbredimus')).toEqual([BELOW_FLOOR]);
    expect(flags('wasserbillig')).toEqual([BELOW_FLOOR]);
    expect(flags('wasserbillig', [[221, 230, 250, 260, 270]])).toEqual([0]);
    expect(flags('wasserbillig', [[220, 230, 250, 260, 270]])).toEqual([BELOW_FLOOR]);
    expect(flags('perl', [[251, 252, 253, 254, 255]])).toEqual([0]);
    expect(flags('perl', [[250, 252, 253, 254, 255]])).toEqual([BELOW_FLOOR]);
    // Both flags at once: two bits of one mask.
    expect(flags('perl', [[260, 240, 270, 280, 290]])).toEqual([ORDER | BELOW_FLOOR]);
    expect(flags('diekirch')).toEqual([0]);
    expect(flags('constructor')).toEqual([0]);
  });

  it('a gap in all five files at the first step starts the run one step later; a gap in one file is no run', () => {
    // The synthetic gap file: a null first step, then hourly values. Five copies state the same steps.
    const file = parsePercentile(rawFixture('LU-3', 'lu-3-percentile-gap.synthetic').body);
    const out = (p: Level) => normalisePart(file, { variant: `diekirch/${p}`, keyOf });
    expect(out(10)).toEqual(golden('lu-3-percentile-gap.synthetic', out(10)));
    expect(out(10).dropped).toEqual({ gap: 1 });
    const parts = PERCENTILES.map((p) => out(p).part as Part);
    expect(parts[0]?.first_valid).toBe('2030-02-28T23:00:00.000Z');
    expect(parts[0]?.values[0]?.ts).toBe('2030-03-01T00:00:00.000Z');
    const { run, dropped } = combineRun(parts);
    expect(dropped).toEqual({});
    expect(run?.points[0]?.ts).toBe('2030-03-01T00:00:00.000Z');
    // One file with another gap than the rest: the five do not state the same steps.
    const short = { ...(parts[2] as Part), values: (parts[2] as Part).values.slice(1) };
    expect(combineRun(parts.map((p, i) => (i === 2 ? short : p)))).toEqual({
      run: null,
      dropped: { run_mismatch: 1 },
    });
  });
});

describe('combineStaged (the loader hands the staged parts back through app_meta JSON)', () => {
  const diekirch = () => partsOf('diekirch');

  it('five staged parts are the run combineRun makes of the parts, in any staging order', () => {
    const { runs, dropped } = combineStaged(staged(diekirch()));
    expect(dropped).toEqual({});
    expect(runs).toEqual([combineRun(diekirch()).run]);
    expect(combineStaged(staged(diekirch()).reverse())).toEqual({ runs, dropped });
  });

  it('an incomplete group (four files) is no run, counted incomplete_run; the loader normally never asks', () => {
    expect(combineStaged(staged(diekirch().slice(0, 4)))).toEqual({ runs: [], dropped: { incomplete_run: 1 } });
    expect(combineStaged([])).toEqual({ runs: [], dropped: { incomplete_run: 1 } });
  });

  it('files that are not one run are no run (counted), whatever the staging says', () => {
    const parts = diekirch();
    const p50 = parts[2] as Part;
    const cut = parts.map((p, i) => (i === 2 ? { ...p50, values: p50.values.slice(1) } : p));
    expect(combineStaged(staged(cut))).toEqual({ runs: [], dropped: { run_mismatch: 1 } });
  });

  it('a staged part that is no Part, or states another percentile than its slot, is drift', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaDrift);
        return (err as SchemaDrift).code;
      }
      return 'no throw';
    };
    const good = staged(diekirch());
    const data = good[1]?.data as object;
    const bad = (patch: Partial<StagedPart>) => combineStaged(good.map((p, j) => (j === 1 ? { ...p, ...patch } : p)));
    expect(PartData.safeParse(good[0]?.data).success).toBe(true);
    expect(code(() => bad({ data: null }))).toBe('invalid_type');
    expect(code(() => bad({ data: 'x' }))).toBe('invalid_type');
    expect(code(() => bad({ data: { ...data, extra: 1 } }))).toBe('unrecognized_keys');
    expect(code(() => bad({ data: { ...data, series: '' } }))).toBe('too_small');
    expect(code(() => bad({ data: { ...data, percentile: 20 } }))).toBe('invalid_union');
    expect(code(() => bad({ data: { ...data, values: [] } }))).toBe('too_small');
    expect(code(() => bad({ data: { ...data, first_valid: '2030-03-01T00:00:00Z' } }))).toBe('invalid_format');
    expect(code(() => bad({ data: { ...data, values: [{ ts: at(0), value: '1' }] } }))).toBe('invalid_type');
    // The slot says 50 but the data is the p30 file.
    expect(code(() => bad({ part: '50' }))).toBe('part_mismatch');
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

  it('the five parts combine into one run: 5 percentiles per step, accepted by the core bounds', () => {
    const all = PERCENTILES.map((p) => partOf(archive(p), `diekirch/${p}`).part as Part);
    const newest = Math.max(
      ...PERCENTILES.flatMap((p) => rawFixture('LU-3', archive(p)).body.toString('utf8').match(STAMP) ?? []).map((s) =>
        Date.parse(s),
      ),
    );
    const { run, dropped } = combineRun(all);
    // Which steps carry an ORDER flag is whatever the generated values give; only the shape of the run is asserted.
    expect(dropped).toEqual({});
    expect(run).not.toBeNull();
    expect(run?.series).toBe(keyOf('diekirch'));
    expect(run?.points).toHaveLength((all[0] as Part).values.length);
    for (const v of run?.points ?? []) {
      for (const k of ['value', 'p10', 'p30', 'p50', 'p70', 'p90'] as const) expect(Number.isFinite(v[k])).toBe(true);
    }
    // The run passes the core bounds at the fetch time of the newest file (+ 10 minutes), nothing dropped.
    expect(sha(checked(run, newest + 600_000))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('property and fuzz', () => {
  const level = fc.integer({ min: 0, max: 100_000 }).map((n) => n / 10);
  const tuple = fc.tuple(level, level, level, level, level);
  const steps = fc.array(tuple, { minLength: 1, maxLength: 40 });
  const sorted = (t: number[]) => t.every((x, i) => i === 0 || x >= (t[i - 1] as number));

  it('ORDER exactly when a step is not p10 ≤ p30 ≤ p50 ≤ p70 ≤ p90, values unchanged, `value` is p50', () => {
    fc.assert(
      fc.property(steps, (rows) => {
        const { run, dropped } = combineRun(five('diekirch', rows));
        expect(dropped).toEqual({});
        expect(checked(run).points).toHaveLength(rows.length);
        expect(run?.points.map((v) => (v.flags & ORDER) !== 0)).toEqual(rows.map((r) => !sorted(r)));
        expect(run?.points.map((v) => [v.p10, v.p30, v.p50, v.p70, v.p90])).toEqual(rows);
        expect(run?.points.map((v) => v.value)).toEqual(rows.map((r) => r[2]));
        expect(run?.points.some((v) => (v.flags & BELOW_FLOOR) !== 0)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('a sorted set is never ORDER; BELOW_FLOOR exactly when any value is at or below the floor', () => {
    fc.assert(
      fc.property(
        steps,
        fc.constantFrom('perl', 'stadtbredimus', 'wasserbillig', 'mondorf-les-bains'),
        (rows, slug) => {
          const floor = FLOORS[slug] as number;
          const ordered = rows.map((r) => [...r].sort((a, b) => a - b));
          const { run } = combineRun(five(slug, ordered));
          expect(run?.points.map((v) => (v.flags & ORDER) !== 0)).toEqual(ordered.map(() => false));
          expect(run?.points.map((v) => (v.flags & BELOW_FLOOR) !== 0)).toEqual(
            ordered.map((r) => r.some((x) => x <= floor)),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the staged JSON round trip never changes the run', () => {
    fc.assert(
      fc.property(steps, fc.constantFrom('diekirch', 'perl'), (rows, slug) => {
        const parts = five(slug, rows);
        expect(combineStaged(staged(parts))).toEqual({ runs: [combineRun(parts).run], dropped: {} });
      }),
      { numRuns: 200 },
    );
  });

  it('arbitrary staged data throws only SchemaDrift', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.constantFrom('10', '30', '50', '70', '90'), (data, part) => {
        try {
          combineStaged([{ part, fetchedAt: FETCHED, data }]);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
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
