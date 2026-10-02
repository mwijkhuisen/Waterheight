import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normaliseSerie } from '../../src/adapters/fr-3/normalise.ts';
import { parseSerie, type Serie } from '../../src/adapters/fr-3/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// FR-3 Vigicrues observations.json: parse + normalise of real recorded
// payloads equals the committed golden files (invariant 9). `UPDATE_GOLDEN=1`
// rewrites them; a golden change is reviewed like code. FR-3 is a twin and a
// gap-fill source: its rows go to the twin series (`obs`) and, copied row for
// row, to the FR-1 series of the same key (`fill`).

const registry = registryOf('FR-3');
const UCKANGE_Q = 'A850061001/Q';
const LAUTERBOURG_H = 'A302009050/H';
const CHOOZ_H = 'B720000001/H';

function ctx(name: string, variant = ''): Context {
  return { registry, fetchedAt: Date.parse(rawFixture('FR-3', name).meta.recorded_at), variant };
}

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('FR-3', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const run = (name: string, variant: string) =>
  normaliseSerie(parseSerie(rawFixture('FR-3', name).body), ctx(name, variant));

describe('golden files (real payloads)', () => {
  it('Uckange Q (5-minute m³/s, the last 600 points): epoch ms → UTC, values as published', () => {
    const out = run('fr-3-obs-uckange-q', UCKANGE_Q);
    expect(out).toEqual(golden('fr-3-obs-uckange-q', out));
    expect(out.obs).toHaveLength(600);
    expect(out.dropped).toEqual({});
    // First raw point [1790595300000, 11.6] is 2026-09-28T11:35:00Z; last [1790775000000, 10.5].
    expect(out.obs[0]).toEqual({ series: UCKANGE_Q, ts: '2026-09-28T11:35:00.000Z', value: 11.6, qc: QC.RAW });
    expect(out.obs.at(-1)).toEqual({ series: UCKANGE_Q, ts: '2026-09-30T13:30:00.000Z', value: 10.5, qc: QC.RAW });
  });

  it('Lauterbourg H (10-minute, m → cm ×100): the stage is relative to the gauge zero', () => {
    const out = run('fr-3-obs-lauterbourg-h', LAUTERBOURG_H);
    expect(out).toEqual(golden('fr-3-obs-lauterbourg-h', out));
    expect(out.obs).toHaveLength(600);
    // First raw point [1790413800000, 2.76] m is 276 cm.
    expect(out.obs[0]).toEqual({ series: LAUTERBOURG_H, ts: '2026-09-26T09:10:00.000Z', value: 276, qc: QC.RAW });
    expect(out.obs.at(-1)).toEqual({ series: LAUTERBOURG_H, ts: '2026-09-30T13:00:00.000Z', value: 265, qc: QC.RAW });
    expect(out.dropped).toEqual({});
  });

  it('`fill` equals `obs` row for row, as copies: the loader gap-fills the FR-1 series of the same key', () => {
    for (const [name, variant] of [
      ['fr-3-obs-uckange-q', UCKANGE_Q],
      ['fr-3-obs-lauterbourg-h', LAUTERBOURG_H],
    ] as const) {
      const out = run(name, variant);
      expect(out.fill).toEqual(out.obs);
      expect(out.fill?.some((r, i) => r === out.obs[i])).toBe(false);
      // The key is the FR-1 series' key (identical on purpose).
      expect(registryOf('FR-1').has(variant)).toBe(true);
    }
  });

  it('an empty series (Strasbourg Q: Vigicrues lists a station without discharge): no twin series, one unknown', () => {
    const out = run('fr-3-obs-empty', 'A061005051/Q');
    expect(out).toEqual(golden('fr-3-obs-empty', out));
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 1 });
    expect(parseSerie(rawFixture('FR-3', 'fr-3-obs-empty').body).ObssHydro).toEqual([]);
  });

  it('Chooz H, the whole 72-day series (15,588 points, no golden: too big): spot checks', () => {
    const out = run('fr-3-obs', CHOOZ_H);
    expect(out.obs).toHaveLength(15_588);
    expect(out.dropped).toEqual({});
    expect(out.fill).toEqual(out.obs);
    // First raw point [1784415600000, 0.6] m is 60 cm at 2026-07-18T23:00Z; last [1790688600000, 0.49].
    expect(out.obs[0]).toEqual({ series: CHOOZ_H, ts: '2026-07-18T23:00:00.000Z', value: 60, qc: QC.RAW });
    expect(out.obs.at(-1)).toEqual({ series: CHOOZ_H, ts: '2026-09-29T13:30:00.000Z', value: 49, qc: QC.RAW });
    // The document holds about 72 days, all of it kept: the seed's point (the age limit is 90 days).
    const days = (Date.parse(out.obs.at(-1)?.ts as string) - Date.parse(out.obs[0]?.ts as string)) / 86_400_000;
    expect(days).toBeGreaterThan(70);
    expect(days).toBeLessThan(75);
  });
});

describe('empty and error payloads', () => {
  it('the JSON bodies of an error are not a series', () => {
    for (const body of ['', '<html>', '{"error_msg":"Station inconnue"}', '{}', '[]', '{"Serie":null}', 'null']) {
      expect(() => parseSerie(Buffer.from(body))).toThrow(SchemaDrift);
    }
  });
});

describe('synthetic payloads [U]', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const serie = (points: [number, number | null][], o: Partial<Serie> = {}): Serie => ({
    CdStationHydro: 'A850061001',
    LbStationHydro: 'Uckange',
    Link: 'services/station.json?CdStationHydro=A850061001',
    GrdSerie: 'Q',
    ObssHydro: points,
    ...o,
  });
  const base: Context = { registry, fetchedAt: at, variant: UCKANGE_Q };
  const T = at - 3_600_000; // 11:00Z, on the 5-minute grid
  const run1 = (points: [number, number | null][], o: Partial<Serie> = {}, c: Context = base) =>
    normaliseSerie(serie(points, o), c);

  it('a payload for another series than its variant is bad_variant drift; an empty variant (a recovered line) is not', () => {
    expect(() => run1([[T, 1]], {}, { ...base, variant: 'A850061001/H' })).toThrow(
      expect.objectContaining({ code: 'bad_variant' }),
    );
    expect(() => run1([[T, 1]], { GrdSerie: 'H' })).toThrow(expect.objectContaining({ code: 'bad_variant' }));
    expect(() => run1([[T, 1]], { CdStationHydro: 'A302009050' })).toThrow(SchemaDrift);
    expect(run1([[T, 1]], {}, { ...base, variant: '' }).obs).toHaveLength(1);
  });

  it('a series the registry does not know is counted, never registered, and fills nothing', () => {
    const out = run1([[T, 1]], { CdStationHydro: 'Z999999999' }, { ...base, variant: '' });
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 1 });
    expect(out.fill).toBeUndefined();
  });

  it('a registered series with no points has empty obs and fill (a value for a replay to find), not unknown', () => {
    expect(run1([])).toEqual({ obs: [], fill: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });

  it("H is m → cm (×100) and Q is m³/s as published; the factor is the twin's registry row", () => {
    const h = run1([[T, 2.76]], { GrdSerie: 'H', CdStationHydro: 'A302009050' }, { ...base, variant: LAUTERBOURG_H });
    expect(h.obs).toEqual([{ series: LAUTERBOURG_H, ts: '2026-09-30T11:00:00.000Z', value: 276, qc: QC.RAW }]);
    expect(run1([[T, 17.3]]).obs[0]).toMatchObject({ value: 17.3 });
    // 0.01 m is 1 cm without binary noise.
    expect(
      run1([[T, 0.07]], { GrdSerie: 'H', CdStationHydro: 'A850061001' }, { ...base, variant: 'A850061001/H' }).obs[0]
        ?.value,
    ).toBe(7);
  });

  it('epoch milliseconds: a number is read as UTC; anything that is not a whole, sane instant is drift', () => {
    expect(run1([[Date.UTC(2026, 8, 30, 11, 0), 1]]).obs[0]?.ts).toBe('2026-09-30T11:00:00.000Z');
    for (const bad of [1e18, 1.5e12 + 0.5, 1e13, Number.MAX_SAFE_INTEGER]) {
      expect(() => run1([[bad, 1]])).toThrow(expect.objectContaining({ code: 'time_out_of_range' }));
    }
  });

  it('null points are gaps; a null never replaces a value that the same instant states', () => {
    const out = run1([
      [T, null],
      [T + 300_000, 5],
      [T + 300_000, null],
      [T + 600_000, null],
      [T + 600_000, 6],
    ]);
    expect(out.obs.map((r) => [r.ts.slice(11, 16), r.value])).toEqual([
      ['11:05', 5],
      ['11:10', 6],
    ]);
    expect(out.dropped).toEqual({ gap: 3 });
  });

  it('a duplicate point is kept once; two values for one instant are both withheld (conflict)', () => {
    expect(
      run1([
        [T, 1],
        [T, 1],
      ]),
    ).toMatchObject({ obs: [{ value: 1 }], dropped: { duplicate: 1 } });
    const conflict = run1([
      [T, 1],
      [T, 2],
    ]);
    expect(conflict.obs).toEqual([]);
    expect(conflict.fill).toEqual([]);
    expect(conflict.dropped).toEqual({ conflict: 2 });
    expect(
      run1([
        [T, 1],
        [T, 2],
        [T, 1],
      ]).dropped,
    ).toEqual({ conflict: 3 });
    expect(
      run1([
        [T, 1],
        [T + 300_000, 2],
        [T, 1],
      ]).obs.map((r) => r.value),
    ).toEqual([1, 2]);
  });

  it('on-grid thinning: a 5-minute payload for a 10-minute series keeps the on-grid samples only, never an average', () => {
    // The Uckange discharge as if it were the Lauterbourg one (a 10-minute twin): 5-minute points, half off the grid.
    const real = parseSerie(rawFixture('FR-3', 'fr-3-obs-uckange-q').body);
    const out = normaliseSerie(
      { ...real, CdStationHydro: 'A302009050' },
      { ...ctx('fr-3-obs-uckange-q'), variant: 'A302009050/Q' },
    );
    const step = registry.get('A302009050/Q')?.expected_step_ms as number;
    expect(step).toBe(600_000);
    expect(out.obs).toHaveLength(300);
    expect(out.dropped).toEqual({ thinned: 300 });
    for (const r of out.obs) expect(Date.parse(r.ts) % step).toBe(0);
    // Each kept row is a published value, unchanged.
    const published = new Map(real.ObssHydro.map(([ms, v]) => [new Date(ms).toISOString(), v]));
    for (const r of out.obs) expect(r.value).toBe(published.get(r.ts));
    expect(out.fill).toEqual(out.obs);
  });

  it('the age limit is 90 days: 89 days are kept, 90 are kept, 91 are too_old', () => {
    const day = 86_400_000;
    const out = run1([
      [at - 91 * day, 1],
      [at - 90 * day - 300_000, 2],
      [at - 90 * day, 3],
      [at - 89 * day, 4],
    ]);
    expect(out.obs.map((r) => r.value)).toEqual([3, 4]);
    expect(out.dropped).toEqual({ too_old: 2 });
    expect(out.fill).toEqual(out.obs);
  });

  it('a point more than 15 minutes ahead of the fetch is dropped; 15 minutes exactly is kept', () => {
    const out = run1([
      [at + 900_000, 1],
      [at + 1_200_000, 2],
    ]);
    expect(out.obs.map((r) => r.value)).toEqual([1]);
    expect(out.dropped).toEqual({ future: 1 });
  });

  it('a negative Q is kept with the range bit, as in FR-1; a negative stage is not marked', () => {
    expect(run1([[T, -2.5]]).obs[0]).toMatchObject({ value: -2.5, qc: QC.RAW | QC.RANGE });
    const h = run1([[T, -0.25]], { GrdSerie: 'H', CdStationHydro: 'A850061001' }, { ...base, variant: 'A850061001/H' });
    expect(h.obs[0]).toMatchObject({ value: -25, qc: QC.RAW });
    // An implausible stage (80 m) is kept with the bit.
    const big = run1([[T, 80]], { GrdSerie: 'H', CdStationHydro: 'A850061001' }, { ...base, variant: 'A850061001/H' });
    expect(big.obs[0]).toMatchObject({ value: 8000, qc: QC.RAW | QC.RANGE });
  });

  it('a raw value that overflows the ×100 factor, or any canonical value over 1e7: value_out_of_range drift', () => {
    const h = { GrdSerie: 'H', CdStationHydro: 'A302009050' } as const;
    const hc = { ...base, variant: LAUTERBOURG_H };
    for (const raw of [1.8e306, -1.8e306, Number.MAX_VALUE, 1e300, 100_001]) {
      expect(() => run1([[T, raw]], h, hc), String(raw)).toThrow(
        expect.objectContaining({ code: 'value_out_of_range' }),
      );
    }
    // A finite ×1 discharge over 1e7 is drift too (review SR-2: it would overflow the real column); 1e7 is kept.
    expect(() => run1([[T, 1e300]])).toThrow(expect.objectContaining({ code: 'value_out_of_range' }));
    expect(run1([[T, 100_000]], h, hc).obs[0]).toMatchObject({ value: 1e7, qc: QC.RAW | QC.RANGE });
    expect(run1([[T, 9_999_999]]).obs[0]).toMatchObject({ value: 9_999_999, qc: QC.RAW | QC.RANGE });
  });

  it('every row is raw: Vigicrues publishes no quality', () => {
    expect(new Set(run('fr-3-obs-uckange-q', UCKANGE_Q).obs.map((r) => r.qc))).toEqual(new Set([QC.RAW]));
  });
});

describe('strict schema', () => {
  const doc = (o: Record<string, unknown> = {}, serie: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        Serie: {
          CdStationHydro: 'A850061001',
          LbStationHydro: 'Uckange',
          Link: 'x',
          GrdSerie: 'Q',
          ObssHydro: [[1, 2]],
          ...serie,
        },
        VersionFlux: 'Beta 0.4b',
        ...o,
      }),
    );
  const drift = (body: Buffer) => {
    try {
      parseSerie(body);
    } catch (err) {
      return err instanceof SchemaDrift ? `${err.code} at ${err.path}` : 'other';
    }
    return 'parsed';
  };

  it('a point is a pair of a number and a number or null; anything else is drift with a path', () => {
    expect(drift(doc())).toBe('parsed');
    expect(drift(doc({}, { ObssHydro: [[1, null]] }))).toBe('parsed');
    expect(drift(doc({}, { ObssHydro: [[1, 2, 3]] }))).toBe('too_big at Serie.ObssHydro.0');
    expect(drift(doc({}, { ObssHydro: [[1]] }))).toBe('too_small at Serie.ObssHydro.0');
    expect(drift(doc({}, { ObssHydro: [['1', 2]] }))).toBe('invalid_type at Serie.ObssHydro.0.0');
    expect(drift(doc({}, { ObssHydro: [[1, '2']] }))).toBe('invalid_type at Serie.ObssHydro.0.1');
    expect(drift(doc({}, { ObssHydro: 'x' }))).toBe('invalid_type at Serie.ObssHydro');
  });

  it('an unknown key, another grandeur or a missing key is drift', () => {
    expect(drift(doc({ extra: 1 }))).toBe('unrecognized_keys at ');
    expect(drift(doc({}, { extra: 1 }))).toBe('unrecognized_keys at Serie');
    expect(drift(doc({}, { GrdSerie: 'Hn' }))).toBe('invalid_value at Serie.GrdSerie');
    expect(drift(doc({}, { CdStationHydro: 'x'.repeat(21) }))).toBe('too_big at Serie.CdStationHydro');
    expect(drift(doc({ VersionFlux: undefined }))).toBe('invalid_type at VersionFlux');
  });
});

describe('bounded parsing', () => {
  // The hostile bodies themselves run in child processes with a small heap: bounded.int.test.ts.
  const wrap = (points: string) =>
    Buffer.from(
      `{"Serie":{"CdStationHydro":"A850061001","LbStationHydro":"x","Link":"x","GrdSerie":"Q","ObssHydro":[${points}]},"VersionFlux":"x"}`,
    );

  it('a series over its point cap is too_big before any point is parsed', () => {
    expect(() => parseSerie(wrap(Array(30_001).fill('0').join(',')))).toThrow(
      expect.objectContaining({ code: 'too_big', path: 'Serie.ObssHydro' }),
    );
  });

  it('a body with more values than the node cap, or nested too deep, is refused by the scan', () => {
    expect(() => parseSerie(wrap(Array(100_001).fill('0').join(',')))).toThrow(
      expect.objectContaining({ code: 'json_too_many_nodes' }),
    );
    expect(() => parseSerie(wrap(`${'['.repeat(6)}${']'.repeat(6)}`))).toThrow(
      expect.objectContaining({ code: 'json_too_deep' }),
    );
  });

  it('the caps admit every recorded payload, the 15,588-point series included', () => {
    expect(parseSerie(rawFixture('FR-3', 'fr-3-obs').body).ObssHydro).toHaveLength(15_588);
    expect(parseSerie(rawFixture('FR-3', 'fr-3-obs-lauterbourg-h').body).ObssHydro).toHaveLength(600);
  });
});

describe('property and fuzz tests', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const base: Context = { registry, fetchedAt: at, variant: UCKANGE_Q };
  const point = fc.tuple(
    fc.integer({ min: -(95 * 288), max: 6 }).chain((step) => fc.constantFrom(step * 300_000, step * 300_000 + 60_000)),
    fc.oneof(fc.integer({ min: -50, max: 5000 }), fc.double({ min: -1e5, max: 1e5, noNaN: true }), fc.constant(null)),
  );
  const points = fc.array(point, { maxLength: 200 });
  const wrap = (p: [number, number | null][]): Serie => ({
    CdStationHydro: 'A850061001',
    LbStationHydro: 'Uckange',
    Link: 'x',
    GrdSerie: 'Q',
    ObssHydro: p.map(([ms, v]) => [Math.floor(at / 300_000) * 300_000 + ms, v]),
  });

  it('normalise yields valid, sorted, unique, on-grid, never-future rows; fill equals obs; idempotent; order-free', () => {
    fc.assert(
      fc.property(points, (p) => {
        const s = wrap(p);
        const out = normaliseSerie(s, base);
        const step = registry.get(UCKANGE_Q)?.expected_step_ms as number;
        for (const r of out.obs) {
          ObsRow.parse(r);
          expect(Date.parse(r.ts) % step).toBe(0);
          expect(Date.parse(r.ts)).toBeLessThanOrEqual(at + 15 * 60_000);
          expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(at - 90 * 86_400_000);
        }
        const times = out.obs.map((r) => r.ts);
        expect(times).toEqual([...new Set(times)].sort());
        expect(out.fill).toEqual(out.obs);
        expect(normaliseSerie(s, base)).toEqual(out);
        expect(normaliseSerie({ ...s, ObssHydro: [...s.ObssHydro, ...s.ObssHydro] }, base).obs).toEqual(out.obs);
        expect(normaliseSerie({ ...s, ObssHydro: [...s.ObssHydro].reverse() }, base).obs).toEqual(out.obs);
      }),
      { numRuns: 200 },
    );
  });

  it('parse never throws anything but SchemaDrift on arbitrary JSON or bytes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue().map((d) => Buffer.from(JSON.stringify(d))),
          fc.uint8Array().map(Buffer.from),
        ),
        (body) => {
          try {
            parseSerie(body);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a mutated real payload is either still valid or a SchemaDrift, never a crash or a wrong row', () => {
    const doc = JSON.parse(rawFixture('FR-3', 'fr-3-obs-uckange-q').body.toString('utf8'));
    doc.Serie.ObssHydro = doc.Serie.ObssHydro.slice(0, 50);
    const mutation = fc.tuple(
      fc.constantFrom('CdStationHydro', 'LbStationHydro', 'Link', 'GrdSerie', 'ObssHydro'),
      fc.jsonValue(),
      fc.integer({ min: 0, max: 49 }),
      fc.boolean(),
    );
    fc.assert(
      fc.property(mutation, ([key, junk, i, inPoint]) => {
        const copy = structuredClone(doc);
        if (key === 'ObssHydro' && inPoint) copy.Serie.ObssHydro[i] = junk;
        else copy.Serie[key] = junk;
        try {
          const out = normaliseSerie(parseSerie(Buffer.from(JSON.stringify(copy))), { ...base, variant: '' });
          for (const r of out.obs) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 200 },
    );
  });
});
