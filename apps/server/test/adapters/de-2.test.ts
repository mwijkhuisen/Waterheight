import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { checkRun, FORECAST_FLAGS, FORECAST_SOURCES, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { normalise, SOURCE, TIME } from '../../src/adapters/de-2/normalise.ts';
import { JSON_CAPS, MAX_POINTS, type Point, parseForecast } from '../../src/adapters/de-2/parse.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// DE-2 BfG water-level forecast (owner audience, catalogue §2.2): parse + normalise of the synthetic fixtures equal
// their goldens (invariant 9: owner fixtures are synthetic, real structure, generated values), the run rules (one
// `initialized`, the 48 h estimate flag, sentinel, gap), and the property tests. `UPDATE_GOLDEN=1` rewrites goldens.

const root = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const HOUR = 3_600_000;
const STEP = 2 * HOUR;
const KAUB = '1d26e504-7f9e-480a-b52c-5932be6549ab';
const KOBLENZ = '4c7d796a-39f2-4f26-97a9-3aad01713e29';
const DECL = FORECAST_SOURCES['DE-2'];

type Golden = { forecasts: Normalised['forecasts']; dropped: Normalised['dropped'] };
function golden(name: string, actual: Golden): Golden {
  const url = goldenUrl('DE-2', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const read = (name: string) => rawFixture('DE-2', name).body;
const run = (name: string, variant: string): Normalised => normalise(parseForecast(read(name)), { variant });
const projected = (n: Normalised): Golden => ({ forecasts: n.forecasts, dropped: n.dropped });
/** The fetch of a run, 12 minutes after its issue (the recorder asks at :12). */
const fetchedAfter = (iso: string) => Date.parse(iso) + 12 * 60_000;

const FIXTURES = [
  ['de-2-wv-oestrich.synthetic', '665be0fe-5e38-43f6-8b04-02a93bdbeeb4'],
  ['de-2-wv-kaub.synthetic', KAUB],
  ['de-2-wv-ruhrort.synthetic', 'c0f51e35-d0e8-4318-afaf-c5fcbc29f4c1'],
  ['de-2-wv-dst-fall-back.synthetic', KOBLENZ],
  ['de-2-wv-weekend.synthetic', 'a6ee8177-107b-47dd-bcfd-30960ccc6e9c'],
  ['de-2-wv-truncated.synthetic', '9598e4cb-0849-401e-bba0-689234b27644'],
  ['de-2-wv-empty.synthetic', KAUB],
] as const;

/** A document of `n` points two hours apart from `from` (UTC), all stating `init`; values 100, 101, … */
const doc = (n: number, from = '2030-01-07T05:00:00Z', init = '2030-01-07T07:00:00+02:00'): Point[] =>
  Array.from({ length: n }, (_, i) => ({
    initialized: init,
    timestamp: new Date(Date.parse(from) + i * STEP).toISOString(),
    value: 100 + i,
    type: i * 2 > 48 ? 'estimate' : 'forecast',
  }));
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));

describe('golden files (synthetic: owner audience)', () => {
  for (const [name, variant] of FIXTURES) {
    it(`${name}: parse + normalise equals the golden, and the run passes the core bounds`, () => {
      const out = projected(run(name, variant));
      expect(out).toEqual(golden(name, out));
      // The loader's own check of a run (packages/core checkRun) leaves it whole: nothing beyond the horizon, no gap.
      for (const r of out.forecasts ?? []) {
        const c = checkRun(r, fetchedAfter(r.issuedAt as string), DECL);
        expect(c.dropped).toEqual({});
        expect(c.run?.points).toHaveLength(r.points.length);
      }
    });
  }

  it('the P1 capture fixture (regenerated from an archived payload) still parses', () => {
    expect(parseForecast(read('de-2-wv.synthetic'))).toHaveLength(49);
  });

  it('a normal run: 49 points two hours apart, 25 forecast then 24 estimate flagged, issued as stated', () => {
    const out = run('de-2-wv-oestrich.synthetic', '665be0fe-5e38-43f6-8b04-02a93bdbeeb4');
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
    expect(out.obs).toEqual([]);
    const [r] = out.forecasts ?? [];
    expect(out.forecasts).toHaveLength(1);
    expect(r).toMatchObject({
      target: 'DE-1',
      series: '665be0fe-5e38-43f6-8b04-02a93bdbeeb4/W',
      kind: 'deterministic',
      stepMs: STEP,
    });
    const pts = r?.points ?? [];
    expect(pts).toHaveLength(49);
    const ms = pts.map((p) => Date.parse(p.ts));
    expect(ms.every((t, i) => i === 0 || t - (ms[i - 1] as number) === STEP)).toBe(true);
    // Issued at the first valid time (the run starts at its own `initialized`); the segment ends at +48 h.
    expect(r?.issuedAt).toBe(pts[0]?.ts);
    expect(Date.parse(r?.providerSegmentEnd as string) - Date.parse(r?.issuedAt as string)).toBe(48 * HOUR);
    expect(pts.map((p) => p.flags)).toEqual([...Array(25).fill(0), ...Array(24).fill(FORECAST_FLAGS.ESTIMATE)]);
    // Values as published: centimetres, no rounding (only the integers of the file).
    expect(pts.every((p) => Number.isInteger(p.value))).toBe(true);
  });

  it('the DST run: 49 points across the 2026-10-25 fall-back, +02:00 then +01:00, in UTC two hours apart', () => {
    const text = read('de-2-wv-dst-fall-back.synthetic').toString('utf8');
    expect(text).toContain('+02:00"');
    expect(text).toContain('+01:00"');
    const [r] = run('de-2-wv-dst-fall-back.synthetic', KOBLENZ).forecasts ?? [];
    const pts = r?.points ?? [];
    expect(pts).toHaveLength(49);
    // 01:00+02:00 is 23:00Z and the next label, 02:00+01:00, is 01:00Z: no step is lost or doubled.
    expect(pts.slice(9, 13).map((p) => p.ts)).toEqual([
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
      '2026-10-25T05:00:00.000Z',
    ]);
    const ms = pts.map((p) => Date.parse(p.ts));
    expect(ms.every((t, i) => i === 0 || t - (ms[i - 1] as number) === STEP)).toBe(true);
    expect(r?.issuedAt).toBe('2026-10-24T05:00:00.000Z');
    // +48 h of real time is 2026-10-26T05:00Z: the last forecast point, and the first estimate two hours later.
    expect(r?.providerSegmentEnd).toBe('2026-10-26T05:00:00.000Z');
    const firstEstimate = pts.find((p) => p.flags === FORECAST_FLAGS.ESTIMATE);
    expect(firstEstimate?.ts).toBe('2026-10-26T07:00:00.000Z');
  });

  it('a run that ends early has no estimate, a segment end at its last point and is never extended', () => {
    const [r] = run('de-2-wv-truncated.synthetic', '9598e4cb-0849-401e-bba0-689234b27644').forecasts ?? [];
    expect(r?.points).toHaveLength(13);
    expect(r?.points.every((p) => p.flags === 0)).toBe(true);
    expect(r?.providerSegmentEnd).toBe(r?.points.at(-1)?.ts);
  });

  it('an empty document is no run, only the drop count', () => {
    const out = run('de-2-wv-empty.synthetic', KAUB);
    expect(out.forecasts).toBeUndefined();
    expect(out.dropped).toEqual({ empty_run: 1 });
  });
});

describe('rules (synthetic)', () => {
  it('declares ISO times with their own offset', () => {
    expect(TIME).toEqual({ kind: 'iso-offset' });
    expect(SOURCE).toBe('DE-2');
  });

  it('a point beyond 48 h is flagged estimate, one at 48 h is not', () => {
    const [r] = normalise(doc(49), { variant: KAUB }).forecasts ?? [];
    expect(r?.points[24]?.flags).toBe(0);
    expect(r?.points[25]?.flags).toBe(FORECAST_FLAGS.ESTIMATE);
    expect(r?.points[48]?.flags).toBe(FORECAST_FLAGS.ESTIMATE);
    expect(r?.providerSegmentEnd).toBe(r?.points[24]?.ts);
  });

  it('the two statements of an estimate disagree: stored, flagged, counted', () => {
    const points = doc(49);
    // A `forecast` past 48 h, and an `estimate` inside it.
    (points[30] as Point).type = 'forecast';
    (points[3] as Point).type = 'estimate';
    const out = normalise(points, { variant: KAUB });
    expect(out.dropped).toEqual({ estimate_mismatch: 2 });
    const [r] = out.forecasts ?? [];
    expect(r?.points).toHaveLength(49);
    expect(r?.points[30]?.flags).toBe(FORECAST_FLAGS.ESTIMATE);
    expect(r?.points[3]?.flags).toBe(FORECAST_FLAGS.ESTIMATE);
    // The provider's segment ends at its last `forecast` point, whatever our 48 h rule says.
    expect(r?.providerSegmentEnd).toBe(r?.points[30]?.ts);
  });

  it('99999 is a sentinel and a null is a gap: neither is stored, neither is 0', () => {
    const points = doc(49);
    (points[2] as Point).value = 99999;
    (points[5] as Point).value = null;
    (points[6] as Point).value = 0;
    const out = normalise(points, { variant: KAUB });
    expect(out.dropped).toEqual({ sentinel: 1, gap: 1 });
    const [r] = out.forecasts ?? [];
    expect(r?.points).toHaveLength(47);
    expect(r?.points.some((p) => p.value === 99999)).toBe(false);
    expect(r?.points.find((p) => p.value === 0)?.ts).toBe(
      new Date(Date.parse('2030-01-07T05:00:00Z') + 6 * STEP).toISOString(),
    );
    // The last forecast point is a gap: the segment ends at the last point that is stored.
    const tail = doc(49);
    (tail[24] as Point).value = null;
    expect(normalise(tail, { variant: KAUB }).forecasts?.[0]?.providerSegmentEnd).toBe(
      new Date(Date.parse('2030-01-07T05:00:00Z') + 23 * STEP).toISOString(),
    );
  });

  it('a document of gaps and sentinels only is no run', () => {
    const points = doc(3).map((p, i) => ({ ...p, value: i === 0 ? 99999 : null }));
    expect(normalise(points, { variant: KAUB })).toMatchObject({ dropped: { sentinel: 1, gap: 2, empty_run: 1 } });
    expect(normalise(points, { variant: KAUB }).forecasts).toBeUndefined();
  });

  it('one `initialized` per document, the same instant under another offset included; any other is drift', () => {
    const points = doc(5);
    (points[4] as Point).initialized = '2030-01-07T05:00:00Z';
    expect(normalise(points, { variant: KAUB }).forecasts?.[0]?.points).toHaveLength(5);
    (points[3] as Point).initialized = '2030-01-07T08:00:00+02:00';
    expect(() => normalise(points, { variant: KAUB })).toThrow(
      expect.objectContaining({ code: 'run_mismatch', path: '3.initialized' }),
    );
  });

  it('the run is the stated issue time on the station’s DE-1 stage series, in the forecast source’s own unit', () => {
    const [r] = normalise(doc(3), { variant: KAUB }).forecasts ?? [];
    expect(r).toMatchObject({
      target: 'DE-1',
      series: `${KAUB}/W`,
      issuedAt: '2030-01-07T05:00:00.000Z',
      kind: 'deterministic',
      stepMs: 7_200_000,
    });
    // Centimetres of stage, factor 1: declared by the forecast source, never read from the DE-1 series.
    expect(DECL.units).toEqual({ cm: ['H', 1] });
    expect(r?.points.map((p) => p.value)).toEqual([100, 101, 102]);
  });

  it('the seven stations of the seed are DE-1 primary stage series in centimetres (what the declared unit presumes)', () => {
    const seed = root('registry/seed/de-2.csv')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .slice(1)
      .map((l) => l.split(',')[0] as string);
    expect(seed).toHaveLength(7);
    const rows = StationsFile.parse(parse(root('registry/stations/de-1.yaml'))).stations;
    for (const uuid of seed) {
      const row = rows.find((r) => r.provider_key === `${uuid}/W`);
      expect([uuid, row?.role, row?.quantity, row?.native_unit, row?.to_canonical]).toEqual([
        uuid,
        'primary',
        'H',
        'cm',
        1,
      ]);
    }
  });

  it('a variant that is no station uuid is drift (the variant is ours, never provider text)', () => {
    for (const bad of ['', 'kaub', KAUB.toUpperCase(), `${KAUB}/W`, KAUB.slice(1)])
      expect(() => normalise(doc(1), { variant: bad })).toThrow(expect.objectContaining({ code: 'bad_variant' }));
  });

  it('a timestamp needs an offset and a real date: drift otherwise, with the point’s place', () => {
    const at = (i: number, field: 'initialized' | 'timestamp', value: string) => {
      const points = doc(3);
      (points[i] as Point)[field] = value;
      return () => normalise(points, { variant: KAUB });
    };
    expect(at(0, 'initialized', '2030-01-07T07:00:00')).toThrow(
      expect.objectContaining({ code: 'time_bad_format', path: '0.initialized' }),
    );
    expect(at(2, 'timestamp', 'soon')).toThrow(
      expect.objectContaining({ code: 'time_bad_format', path: '2.timestamp' }),
    );
    expect(at(1, 'timestamp', '9999-01-07T07:00:00Z')).toThrow(expect.objectContaining({ code: 'time_out_of_range' }));
  });

  it('two points at one instant are drift in the loader’s check, whatever the order of the document', () => {
    const points = doc(4);
    (points[3] as Point).timestamp = (points[1] as Point).timestamp;
    const [r] = normalise(points, { variant: KAUB }).forecasts ?? [];
    expect(() => checkRun(r as NonNullable<typeof r>, fetchedAfter('2030-01-07T05:00:00Z'), DECL)).toThrow(
      expect.objectContaining({ code: 'duplicate_ts' }),
    );
    // A document in reverse order is the same run once sorted.
    const forward = normalise(doc(6), { variant: KAUB }).forecasts?.[0];
    const backward = normalise(doc(6).reverse(), { variant: KAUB }).forecasts?.[0];
    const f = checkRun(forward as NonNullable<typeof forward>, fetchedAfter('2030-01-07T05:00:00Z'), DECL);
    const b = checkRun(backward as NonNullable<typeof backward>, fetchedAfter('2030-01-07T05:00:00Z'), DECL);
    expect(b.run).toEqual(f.run);
  });

  it('parse: strict schema, bounded, fixed codes', () => {
    const good = doc(2);
    expect(parseForecast(bytes(good))).toEqual(good);
    expect(parseForecast(bytes([]))).toEqual([]);
    expect(() => parseForecast(Buffer.from([0xff, 0xfe, 0x5b]))).toThrow(expect.objectContaining({ code: 'encoding' }));
    expect(() => parseForecast(Buffer.from('[{"initialized":'))).toThrow(expect.objectContaining({ code: 'not_json' }));
    expect(() => parseForecast(bytes({ points: good }))).toThrow(expect.objectContaining({ code: 'invalid_type' }));
    const p = good[0] as Point;
    for (const bad of [
      { ...p, extra: 1 },
      { ...p, type: 'Forecast' },
      { ...p, type: 'synthetic-1' },
      { ...p, value: '100' },
      { ...p, value: undefined },
      { ...p, initialized: 7 },
      { ...p, timestamp: 'x'.repeat(41) },
      { initialized: p.initialized, timestamp: p.timestamp, value: p.value },
    ])
      expect(() => parseForecast(bytes([bad]))).toThrow(SchemaDrift);
    expect(parseForecast(bytes([{ ...p, value: null }]))).toHaveLength(1);
    expect(() => parseForecast(bytes(doc(MAX_POINTS + 1)))).toThrow(expect.objectContaining({ code: 'too_big' }));
    expect(parseForecast(bytes(doc(MAX_POINTS)))).toHaveLength(MAX_POINTS);
    expect(() => parseForecast(bytes(Array.from({ length: JSON_CAPS.maxNodes }, () => 0)))).toThrow(
      expect.objectContaining({ code: 'json_too_many_nodes' }),
    );
    expect(() => parseForecast(bytes([[[[]]]]))).toThrow(expect.objectContaining({ code: 'json_too_deep' }));
    // Infinity and NaN have no JSON spelling; 1e999 reads as Infinity and is refused.
    expect(() =>
      parseForecast(Buffer.from(`[{"initialized":"a","timestamp":"b","value":1e999,"type":"forecast"}]`)),
    ).toThrow(SchemaDrift);
  });
});

describe('properties', () => {
  const ints = fc.oneof(fc.integer({ min: -50, max: 900 }), fc.constant(99999), fc.constant(null));
  const document = fc.record({
    n: fc.integer({ min: 1, max: 49 }),
    values: fc.array(ints, { minLength: 49, maxLength: 49 }),
    estimate: fc.array(fc.boolean(), { minLength: 49, maxLength: 49 }),
  });
  const build = (d: { n: number; values: (number | null)[]; estimate: boolean[] }): Point[] =>
    doc(d.n).map((p, i) => ({
      ...p,
      value: d.values[i] ?? null,
      type: d.estimate[i] ? 'estimate' : 'forecast',
    }));

  it('every point is stored, dropped as a sentinel or a gap, or counted; flags follow the 48 h rule', () => {
    fc.assert(
      fc.property(document, (d) => {
        const points = build(d);
        const out = normalise(points, { variant: KAUB });
        const stored = out.forecasts?.[0]?.points ?? [];
        const sentinel = out.dropped.sentinel ?? 0;
        const gap = out.dropped.gap ?? 0;
        expect(stored.length + sentinel + gap).toBe(points.length);
        // Stored values are the published ones, in order, flagged by the rule: past 48 h or an estimate.
        const kept = points.filter((p) => p.value !== null && p.value !== 99999);
        expect(stored.map((p) => p.value)).toEqual(kept.map((p) => p.value));
        expect(stored.map((p) => p.flags)).toEqual(
          kept.map((p) =>
            p.type === 'estimate' || Date.parse(p.timestamp) - Date.parse('2030-01-07T05:00:00Z') > 48 * HOUR ? 256 : 0,
          ),
        );
        expect(out.dropped.estimate_mismatch ?? 0).toBe(
          kept.filter(
            (p) => (p.type === 'estimate') !== Date.parse(p.timestamp) - Date.parse('2030-01-07T05:00:00Z') > 48 * HOUR,
          ).length,
        );
        // Every stored run is one the loader's bounds accept (a run left with no point is none).
        if (out.forecasts !== undefined) {
          const r = out.forecasts[0] as NonNullable<Normalised['forecasts']>[number];
          expect(checkRun(r, fetchedAfter(r.issuedAt as string), DECL).run?.points).toHaveLength(stored.length);
        } else expect(stored).toHaveLength(0);
      }),
    );
  });

  it('the parser answers any bytes with a document or a SchemaDrift, never another error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 300 }),
          fc.json().map((j) => Buffer.from(j)),
        ),
        (b) => {
          try {
            const points = parseForecast(b);
            expect(points.length).toBeLessThanOrEqual(MAX_POINTS);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
    );
  });
});
