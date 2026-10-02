import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, type Registry, SchemaDrift, type SeriesDecl } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normalisePlot } from '../../src/adapters/ch-3/normalise.ts';
import { parsePlot, type Trace } from '../../src/adapters/ch-3/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// CH-3 hydrodaten 40-day plot JSON (the seed only): parse + normalise of real
// recorded payloads equals the committed golden files (invariant 9).
// `UPDATE_GOLDEN=1` rewrites them; a golden change is reviewed like code. CH-3
// has no series of its own: every row is a gap-fill row (`fill`) of a CH-1
// series, which the loader stores only where CH-1 states no value.

const fillRegistry = registryOf('CH-1');

function ctx(name: string, variant: string): Context {
  return { fillRegistry, fetchedAt: Date.parse(rawFixture('CH-3', name).meta.recorded_at), variant };
}

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('CH-3', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const plot = (name: string) => parsePlot(rawFixture('CH-3', name).body);
const run = (name: string, variant: string) => normalisePlot(plot(name), ctx(name, variant));
const of = (out: Normalised, series: string) => (out.fill ?? []).filter((r) => r.series === series);

describe('golden files (real payloads)', () => {
  it('Basel Rheinhalle (2289): 5-minute plot → the 10-minute grid, fill rows only', () => {
    const out = run('ch-3-40d-2289', '2289');
    expect(out).toEqual(golden('ch-3-40d-2289', out));
    // A gap-fill source: nothing of its own, every row is a fill row of the CH-1 series.
    expect(out.obs).toEqual([]);
    expect(of(out, '2289/W')).toHaveLength(301);
    expect(of(out, '2289/Q')).toHaveLength(301);
    expect(out.fill).toHaveLength(602);
    // Two traces of 600 points each (13:30+02:00 to 16:10+02:00 two days later): 299 off-grid points per trace.
    expect(out.dropped).toEqual({ thinned: 598 });
    expect(out.unknown).toBe(0);
    // First raw points "2026-09-28T13:30:00.000+02:00": 244.787 m ü.M. and 344.009 m³/s.
    expect(of(out, '2289/W')[0]).toEqual({
      series: '2289/W',
      ts: '2026-09-28T11:30:00.000Z',
      value: 24478.7,
      qc: QC.RAW,
    });
    expect(of(out, '2289/Q')[0]).toEqual({
      series: '2289/Q',
      ts: '2026-09-28T11:30:00.000Z',
      value: 344.009,
      qc: QC.RAW,
    });
    expect(of(out, '2289/Q').at(-1)).toEqual({
      series: '2289/Q',
      ts: '2026-09-30T14:10:00.000Z',
      value: 301.836,
      qc: QC.RAW,
    });
    for (const r of out.fill ?? []) expect(Date.parse(r.ts) % 600_000).toBe(0);
  });

  it('Diepoldsau (2473): the same shape on another station, a level far from Basel', () => {
    const out = run('ch-3-40d-2473', '2473');
    expect(out).toEqual(golden('ch-3-40d-2473', out));
    expect(out.obs).toEqual([]);
    expect(out.fill).toHaveLength(602);
    expect(out.dropped).toEqual({ thinned: 598 });
    // First raw points "2026-09-28T12:20:00.000+02:00": 406.894 m ü.M. and 60.79 m³/s.
    expect(of(out, '2473/W')[0]).toEqual({
      series: '2473/W',
      ts: '2026-09-28T10:20:00.000Z',
      value: 40689.4,
      qc: QC.RAW,
    });
    expect(of(out, '2473/Q')[0]).toEqual({
      series: '2473/Q',
      ts: '2026-09-28T10:20:00.000Z',
      value: 60.79,
      qc: QC.RAW,
    });
    expect(of(out, '2473/Q').at(-1)?.value).toBe(60.511);
  });

  it('Rheinfelden (2091), the last 600 points of the recording: the third real golden', () => {
    const out = run('ch-3-40d-2091', '2091');
    expect(out).toEqual(golden('ch-3-40d-2091', out));
    expect(out.obs).toEqual([]);
    expect(of(out, '2091/W')).toHaveLength(301);
    expect(of(out, '2091/Q')).toHaveLength(301);
    expect(out.dropped).toEqual({ thinned: 598 });
    // First raw points "2026-09-27T12:20:00.000+02:00": 261.169 m ü.M. and 331.591 m³/s; last "2026-09-29T15:00:00.000+02:00".
    expect(of(out, '2091/W')[0]).toEqual({
      series: '2091/W',
      ts: '2026-09-27T10:20:00.000Z',
      value: 26116.9,
      qc: QC.RAW,
    });
    expect(of(out, '2091/Q')[0]).toEqual({
      series: '2091/Q',
      ts: '2026-09-27T10:20:00.000Z',
      value: 331.591,
      qc: QC.RAW,
    });
    expect(of(out, '2091/Q').at(-1)).toEqual({
      series: '2091/Q',
      ts: '2026-09-29T13:00:00.000Z',
      value: 307.587,
      qc: QC.RAW,
    });
    // It is the end of the recording: the whole-recording run states the same rows over the same instants.
    const whole = run('ch-3-40d', '2091');
    const wholeAt = new Map((whole.fill ?? []).map((r) => [`${r.series}@${r.ts}`, r]));
    for (const r of out.fill ?? []) expect(wholeAt.get(`${r.series}@${r.ts}`)).toEqual(r);
  });

  it('Rheinfelden (2091), the whole 40 days (11,404 points per trace, no golden: too big): spot checks', () => {
    const out = run('ch-3-40d', '2091');
    expect(out.obs).toEqual([]);
    expect(of(out, '2091/W')).toHaveLength(5703);
    expect(of(out, '2091/Q')).toHaveLength(5703);
    expect(out.dropped).toEqual({ thinned: 11_402 });
    // First raw point "2026-08-21T00:00:00.000+02:00": 261.344 m ü.M.; last "2026-09-29T15:00:00.000+02:00": 307.587 m³/s.
    expect(of(out, '2091/W')[0]).toEqual({
      series: '2091/W',
      ts: '2026-08-20T22:00:00.000Z',
      value: 26134.4,
      qc: QC.RAW,
    });
    expect(of(out, '2091/Q').at(-1)).toEqual({
      series: '2091/Q',
      ts: '2026-09-29T13:00:00.000Z',
      value: 307.587,
      qc: QC.RAW,
    });
    // The 40 days fit inside the 45-day window: nothing is too old.
    expect(out.dropped.too_old).toBeUndefined();
  });

  it('the kept rows are published values, never an average: every fill value is a raw point at the same instant', () => {
    const traces = plot('ch-3-40d-2289');
    const out = run('ch-3-40d-2289', '2289');
    for (const [i, series] of ['2289/W', '2289/Q'].entries()) {
      const trace = traces[i] as Trace;
      const raw = new Map(trace.x.map((x, j) => [new Date(x).toISOString(), trace.y[j]]));
      const factor = i === 0 ? 100 : 1;
      for (const r of of(out, series)) expect(r.value).toBeCloseTo((raw.get(r.ts) as number) * factor, 6);
    }
  });

  it('the plot has exactly two traces: Wasserstand (m ü.M.) and Abfluss (m³/s), in that order', () => {
    for (const name of ['ch-3-40d', 'ch-3-40d-2289', 'ch-3-40d-2473']) {
      expect(plot(name).map((t) => [t.name, t.meta.unit])).toEqual([
        ['Wasserstand', 'm ü.M.'],
        ['Abfluss', 'm³/s'],
      ]);
    }
  });
});

describe('the trimmed fixture is cut from the recording by the committed rule', () => {
  const recording = rawFixture('CH-3', 'ch-3-40d');
  const source = JSON.parse(recording.body.toString('utf8'));
  const trimmed = rawFixture('CH-3', 'ch-3-40d-2091');
  const doc = JSON.parse(trimmed.body.toString('utf8'));

  it('the meta names the recording by its sha256, says how it was cut, and gives the station as the variant', () => {
    expect(trimmed.meta).toMatchObject({
      source: 'CH-3',
      spec: 'ch-3-40d',
      variant: '2091',
      synthetic: false,
      from: 'trimmed',
      source_sha256: createHash('sha256').update(recording.body).digest('hex'),
      trimmed: 'last 600 points of every trace',
      url: recording.meta.url,
    });
    expect(recording.meta.url).toContain('/2091_p_q_40days_de.json');
  });

  it('every trace is the last 600 points of the recorded trace, unchanged; every other field is as recorded', () => {
    expect(doc.plot.data).toHaveLength(2);
    for (const [i, trace] of doc.plot.data.entries()) {
      const full = source.plot.data[i];
      expect(trace.x).toEqual(full.x.slice(-600));
      expect(trace.y).toEqual(full.y.slice(-600));
      expect({ ...trace, x: undefined, y: undefined }).toEqual({ ...full, x: undefined, y: undefined });
    }
    expect(doc.plot.layout).toEqual(source.plot.layout);
    expect(doc.hoverInfo).toEqual(source.hoverInfo);
  });
});

describe('synthetic payloads [U]', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const base: Context = { fillRegistry, fetchedAt: at, variant: '2289' };
  type Point = [string, number | null];
  const trace = (name: string, unit: string, points: Point[]): Trace => ({
    name,
    x: points.map(([x]) => x),
    y: points.map(([, y]) => y),
    meta: { unit },
  });
  const W = (points: Point[]) => trace('Wasserstand', 'm ü.M.', points);
  const Q = (points: Point[]) => trace('Abfluss', 'm³/s', points);
  /** 11:00 + n minutes at +02:00 (that is 09:00Z + n). */
  const t = (min: number) =>
    `2026-09-30T${String(11 + Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00.000+02:00`;
  const series = (n: number, from = 0): Point[] => Array.from({ length: n }, (_, i) => [t(from + i * 5), 244 + i]);
  const norm = (traces: Trace[], c: Context = base) => normalisePlot(traces, c);

  it('the trace rule: Wasserstand (m ü.M.) first, Abfluss (m³/s) second, exactly two; anything else is trace_order drift', () => {
    const w = W(series(2));
    const q = Q(series(2));
    expect(norm([w, q]).fill).toHaveLength(2);
    for (const traces of [
      [q, w],
      [w],
      [w, q, q],
      [],
      [trace("Niveau d'eau", 'm ü.M.', series(2)), trace('Débit', 'm³/s', series(2))],
      [trace('Livello', 'm ü.M.', series(2)), trace('Portata', 'm³/s', series(2))],
      [trace('Wasserstand', 'm', series(2)), q],
      [w, trace('Abfluss', 'm3/s', series(2))],
      [w, trace('Abfluss', 'l/s', series(2))],
      [trace('wasserstand', 'm ü.M.', series(2)), q],
      [trace('Wasserstand ', 'm ü.M.', series(2)), q],
    ]) {
      expect(() => norm(traces)).toThrow(expect.objectContaining({ code: 'trace_order' }));
    }
  });

  it('a payload without a station id as its variant is bad_variant drift (the body does not name the station)', () => {
    const traces = [W(series(2)), Q(series(2))];
    for (const variant of ['', 'abc', '1234567', '12 3', '2289/W', '-2289', '2289\n', '١٢٣']) {
      expect(() => norm(traces, { ...base, variant }), JSON.stringify(variant)).toThrow(
        expect.objectContaining({ code: 'bad_variant' }),
      );
    }
    // The variant is checked before the traces.
    expect(() => norm([], { ...base, variant: '' })).toThrow(expect.objectContaining({ code: 'bad_variant' }));
  });

  it('5-minute points → the 10-minute grid: on-grid samples only, `thinned` counts the rest', () => {
    // 11:00 … 11:30 at +02:00 is 09:00Z … 09:30Z: seven points a trace, four on the grid.
    const out = norm([W(series(7)), Q(series(7))]);
    expect(of(out, '2289/W').map((r) => r.ts.slice(11, 16))).toEqual(['09:00', '09:10', '09:20', '09:30']);
    expect(out.dropped).toEqual({ thinned: 6 });
    expect(out.obs).toEqual([]);
    // Nothing off the grid: no `thinned` key at all.
    expect(
      norm([W(series(7).filter((_, i) => i % 2 === 0)), Q(series(7).filter((_, i) => i % 2 === 0))]).dropped,
    ).toEqual({});
    // Values are untouched: the 09:10 point of the level is the published 246 m → 24,600 cm.
    expect(of(out, '2289/W')[1]).toEqual({
      series: '2289/W',
      ts: '2026-09-30T09:10:00.000Z',
      value: 24600,
      qc: QC.RAW,
    });
  });

  it('fill only: `obs` is empty and `fill` is always present, also when nothing is kept', () => {
    expect(norm([W([]), Q([])])).toEqual({ obs: [], fill: [], gaugeZeros: [], dropped: {}, unknown: 0 });
    expect(norm([W(series(3)), Q(series(3))]).obs).toEqual([]);
  });

  it('a null y is a gap, counted, never stored as zero and never thinned; an off-grid null is a gap too', () => {
    const out = norm([
      W([
        [t(0), null],
        [t(5), null],
        [t(10), 245],
      ]),
      Q([
        [t(0), 100],
        [t(5), null],
        [t(10), null],
      ]),
    ]);
    expect(out.fill?.map((r) => [r.series, r.ts.slice(11, 16), r.value])).toEqual([
      ['2289/W', '09:10', 24500],
      ['2289/Q', '09:00', 100],
    ]);
    expect(out.dropped).toEqual({ gap: 4 });
  });

  it('a repeated x is drift (a trace states one value per instant), whatever its offset', () => {
    const dup = [
      [t(0), 1],
      [t(0), 2],
    ] as Point[];
    expect(() => norm([W(dup), Q(series(2))])).toThrow(
      expect.objectContaining({ code: 'duplicate_time', path: 'plot.data.0.x' }),
    );
    expect(() => norm([W(series(2)), Q(dup)])).toThrow(
      expect.objectContaining({ code: 'duplicate_time', path: 'plot.data.1.x' }),
    );
    // The same instant at two offsets: 11:00+02:00 is 10:00+01:00.
    expect(() =>
      norm([
        W([
          [t(0), 1],
          ['2026-09-30T10:00:00.000+01:00', 1],
        ]),
        Q(series(2)),
      ]),
    ).toThrow(expect.objectContaining({ code: 'duplicate_time' }));
  });

  it('the fall-back night: 02:00–02:59 at +02:00 and at +01:00 are different instants, both kept', () => {
    const out = norm(
      [
        W([
          ['2026-10-25T02:30:00.000+02:00', 245],
          ['2026-10-25T02:30:00.000+01:00', 246],
        ]),
        Q([]),
      ],
      { ...base, fetchedAt: Date.parse('2026-10-25T04:00:00Z') },
    );
    expect(out.fill?.map((r) => [r.ts, r.value])).toEqual([
      ['2026-10-25T00:30:00.000Z', 24500],
      ['2026-10-25T01:30:00.000Z', 24600],
    ]);
  });

  it('an instant without an explicit offset or in another format is drift', () => {
    for (const x of ['2026-09-30T11:00:00.000', '2026-09-30 11:00', '30.09.2026 11:00', '']) {
      expect(() => norm([W([[x, 1]]), Q([])]), x).toThrow(expect.objectContaining({ code: 'time_bad_format' }));
    }
  });

  it('a point more than 15 minutes ahead of the fetch is dropped, one older than 45 days is too_old', () => {
    // fetchedAt 12:00Z: 14:00+02:00 is 12:00Z. Points are on the 10-minute grid.
    const ahead = (min: number) => t(180 + min);
    const out = norm([W([[ahead(10), 1]]), Q([[ahead(20), 1]])]);
    expect(out.fill?.map((r) => r.series)).toEqual(['2289/W']);
    expect(out.dropped).toEqual({ future: 1 });
    const day = (n: number) => new Date(at - n * 86_400_000).toISOString().replace('Z', '+00:00');
    expect(norm([W([[day(45), 1]]), Q([])]).fill).toHaveLength(1);
    expect(norm([W([[day(46), 1]]), Q([])])).toMatchObject({ fill: [], dropped: { too_old: 1 } });
  });

  it('a level never fills a series that CH-1 declares as a relative stage (datum_mismatch); its discharge still fills', () => {
    // 2283 Wasen, Riedbad: stage on LOCAL in the real registry.
    expect(fillRegistry.get('2283/W')?.value_kind).toBe('stage');
    const out = norm([W(series(4)), Q(series(4))], { ...base, variant: '2283' });
    expect(of(out, '2283/W')).toEqual([]);
    expect(of(out, '2283/Q').length).toBeGreaterThan(0);
    // The count is every point of the level trace (a payload for a replay to find), not only the on-grid ones.
    expect(out.dropped.datum_mismatch).toBe(4);
    // And the other way round is no mismatch for a level: a level series fills as usual.
    expect(of(norm([W(series(4)), Q(series(4))]), '2289/W').length).toBeGreaterThan(0);
  });

  it('the datum guard follows the registry: the same payload for a series flipped to stage is withheld', () => {
    const flipped: Registry = new Map(fillRegistry).set('2289/W', {
      ...(fillRegistry.get('2289/W') as SeriesDecl),
      value_kind: 'stage',
    });
    const out = norm([W(series(4)), Q(series(4))], { ...base, fillRegistry: flipped });
    expect(of(out, '2289/W')).toEqual([]);
    expect(out.dropped.datum_mismatch).toBe(4);
    expect(of(out, '2289/Q')).not.toEqual([]);
  });

  it('a station the registry does not know, or no registry at all, fills nothing: one unknown per trace', () => {
    const traces = [W(series(4)), Q(series(4))];
    expect(norm(traces, { ...base, variant: '999999' })).toEqual({
      obs: [],
      fill: [],
      gaugeZeros: [],
      dropped: {},
      unknown: 2,
    });
    expect(norm(traces, { fetchedAt: at, variant: '2289' })).toEqual({
      obs: [],
      fill: [],
      gaugeZeros: [],
      dropped: {},
      unknown: 2,
    });
    // A station with a level only: the missing discharge series is the second unknown.
    const levelOnly: Registry = new Map([...fillRegistry].filter(([k]) => k !== '2289/Q'));
    expect(norm(traces, { ...base, fillRegistry: levelOnly }).unknown).toBe(1);
  });

  it('every row is raw; an implausible level or a negative discharge is kept, the level with the range bit', () => {
    const out = norm([W([[t(0), 9000]]), Q([[t(0), -20_000]])]);
    expect(of(out, '2289/W')[0]).toMatchObject({ value: 900_000, qc: QC.RAW | QC.RANGE });
    expect(of(out, '2289/Q')[0]).toMatchObject({ value: -20_000, qc: QC.RAW | QC.RANGE });
    expect(norm([W([[t(0), 244]]), Q([[t(0), -5]])]).fill?.map((r) => r.qc)).toEqual([QC.RAW, QC.RAW]);
  });

  it('a level that overflows the ×100 factor, or any canonical value over 1e7: value_out_of_range drift', () => {
    for (const raw of [1.8e306, -1.8e306, Number.MAX_VALUE, 1e300, 100_001]) {
      expect(() => norm([W([[t(0), raw]]), Q([])]), String(raw)).toThrow(
        expect.objectContaining({ code: 'value_out_of_range' }),
      );
    }
    // A finite ×1 discharge over 1e7 is drift too (review SR-2: it would overflow the real column); 1e7 is kept.
    expect(() => norm([W([]), Q([[t(0), 1.8e306]])])).toThrow(expect.objectContaining({ code: 'value_out_of_range' }));
    expect(of(norm([W([[t(0), 100_000]]), Q([])]), '2289/W')[0]).toMatchObject({ value: 1e7, qc: QC.RAW | QC.RANGE });
    expect(of(norm([W([]), Q([[t(0), 9_999_999]])]), '2289/Q')[0]).toMatchObject({
      value: 9_999_999,
      qc: QC.RAW | QC.RANGE,
    });
  });

  it('the fill rows come out in time order per series, whatever the order of the points', () => {
    const points: Point[] = [
      [t(20), 3],
      [t(0), 1],
      [t(10), 2],
    ];
    expect(of(norm([W(points), Q([])]), '2289/W').map((r) => r.value)).toEqual([100, 200, 300]);
  });
});

describe('strict schema', () => {
  const trace = (o: Record<string, unknown> = {}) => ({
    name: 'Wasserstand',
    x: ['2026-09-30T11:00:00.000+02:00'],
    y: [244],
    meta: { unit: 'm ü.M.' },
    ...o,
  });
  const doc = (o: Record<string, unknown> = {}, traces: unknown[] = [trace()]) =>
    Buffer.from(JSON.stringify({ plot: { layout: { anything: 1 }, data: traces }, hoverInfo: null, ...o }));
  const drift = (body: Buffer) => {
    try {
      parsePlot(body);
    } catch (err) {
      return err instanceof SchemaDrift ? `${err.code} at ${err.path}` : 'other';
    }
    return 'parsed';
  };

  it('a trace has a name, text x, number or null y and a unit; Plotly styling keys and the layout are not read', () => {
    expect(drift(doc())).toBe('parsed');
    expect(drift(doc({}, [trace({ type: 'scatter', line: { color: 'red' }, hovertemplate: '<b>x</b>' })]))).toBe(
      'parsed',
    );
    expect(drift(doc({}, [trace({ y: [null] })]))).toBe('parsed');
    expect(drift(doc({}, [trace({ name: 5 })]))).toBe('invalid_type at plot.data.0.name');
    expect(drift(doc({}, [trace({ x: [5] })]))).toBe('invalid_type at plot.data.0.x.0');
    expect(drift(doc({}, [trace({ y: ['244'] })]))).toBe('invalid_type at plot.data.0.y.0');
    expect(drift(doc({}, [trace({ meta: {} })]))).toBe('invalid_type at plot.data.0.meta.unit');
    expect(drift(doc({}, [trace({ meta: null })]))).toBe('invalid_type at plot.data.0.meta');
    expect(drift(doc({}, [trace({ x: ['x'.repeat(41)] })]))).toBe('too_big at plot.data.0.x.0');
    expect(drift(doc({}, [{ name: 'Wasserstand', x: [], y: [] }]))).toBe('invalid_type at plot.data.0.meta');
  });

  it('x and y of different lengths are drift (length_mismatch), also when empty on one side', () => {
    expect(drift(doc({}, [trace({ y: [1, 2] })]))).toBe('length_mismatch at plot.data.0');
    expect(drift(doc({}, [trace(), trace({ x: [], y: [1] })]))).toBe('length_mismatch at plot.data.1');
    expect(drift(doc({}, [trace({ x: [], y: [] })]))).toBe('parsed');
  });

  it('a payload of another shape (an error body, another file, another top-level key) is drift', () => {
    expect(drift(doc({ extra: 1 }))).toBe('unrecognized_keys at ');
    expect(drift(doc({ plot: { layout: 1, data: [], extra: 1 } }))).toBe('unrecognized_keys at plot');
    expect(drift(doc({ plot: { layout: 1 } }))).toBe('invalid_type at plot.data');
    expect(drift(Buffer.from('{"error":"not found"}'))).toBe('invalid_type at plot');
    expect(drift(Buffer.from('<html>404</html>'))).toBe('not_json at ');
    expect(drift(Buffer.from('[]'))).toBe('invalid_type at ');
  });
});

describe('bounded parsing', () => {
  // The hostile bodies themselves run in child processes with a small heap: bounded.int.test.ts.
  const wrap = (data: string) => Buffer.from(`{"plot":{"layout":null,"data":[${data}]},"hoverInfo":null}`);
  const one = (x: string, y: string) => `{"name":"Wasserstand","x":[${x}],"y":[${y}],"meta":{"unit":"m"}}`;

  it('more than ten traces is too_big before any is parsed', () => {
    expect(() => parsePlot(wrap(Array(11).fill('0').join(',')))).toThrow(
      expect.objectContaining({ code: 'too_big', path: 'plot.data' }),
    );
  });

  it('a trace over its point cap (20,000) is too_big before any point is parsed', () => {
    expect(() => parsePlot(wrap(one(Array(20_001).fill('"x"').join(','), '0')))).toThrow(
      expect.objectContaining({ code: 'too_big', path: 'plot.data.0.x' }),
    );
    expect(() => parsePlot(wrap(one('"x"', Array(20_001).fill('0').join(','))))).toThrow(
      expect.objectContaining({ code: 'too_big', path: 'plot.data.0.y' }),
    );
  });

  it('a body with more values than the node cap, or nested too deep, is refused by the scan', () => {
    expect(() => parsePlot(wrap(Array(150_001).fill('0').join(',')))).toThrow(
      expect.objectContaining({ code: 'json_too_many_nodes' }),
    );
    expect(() => parsePlot(wrap(`${'['.repeat(11)}${']'.repeat(11)}`))).toThrow(
      expect.objectContaining({ code: 'json_too_deep' }),
    );
  });

  it('the caps admit every recorded payload, the 11,404-point plot included', () => {
    expect(plot('ch-3-40d').map((x) => x.x.length)).toEqual([11_404, 11_404]);
  });
});

describe('property and fuzz tests', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const base: Context = { fillRegistry, fetchedAt: at, variant: '2289' };
  const x = fc
    .tuple(fc.integer({ min: -(50 * 288), max: 6 }), fc.constantFrom('+02:00', '+01:00', 'Z'))
    .map(([step, offset]) => {
      const ms = Math.floor(at / 300_000) * 300_000 + step * 300_000;
      const shift = offset === 'Z' ? 0 : Number(offset.slice(1, 3)) * 3_600_000;
      return `${new Date(ms + shift).toISOString().slice(0, 23)}${offset}`;
    });
  const point = fc.tuple(
    x,
    fc.oneof(
      fc.double({ min: -50, max: 5000, noNaN: true, noDefaultInfinity: true }),
      fc.integer({ min: -50, max: 5000 }),
      fc.constant(null),
    ),
  );
  const traceOf = (name: string, unit: string) =>
    fc
      .array(point, { maxLength: 80 })
      .map((ps): Trace => ({ name, x: ps.map((p) => p[0]), y: ps.map((p) => p[1]), meta: { unit } }));
  const plots = fc.tuple(
    traceOf('Wasserstand', 'm ü.M.'),
    traceOf('Abfluss', 'm³/s'),
    fc.constantFrom('2289', '2473', '2283', '2091', '999999'),
  );

  it('normalise yields valid, sorted, unique, on-grid, never-future fill rows and no obs; idempotent', () => {
    fc.assert(
      fc.property(plots, ([w, q, variant]) => {
        let out: Normalised;
        try {
          out = normalisePlot([w, q], { ...base, variant });
        } catch (err) {
          // Two points at one instant (a repeated x, or two offsets of one instant).
          expect(err).toBeInstanceOf(SchemaDrift);
          expect((err as SchemaDrift).code).toBe('duplicate_time');
          return;
        }
        expect(out.obs).toEqual([]);
        const fill = out.fill ?? [];
        for (const r of fill) {
          ObsRow.parse(r);
          expect(Date.parse(r.ts) % 600_000).toBe(0);
          expect(Date.parse(r.ts)).toBeLessThanOrEqual(at + 15 * 60_000);
          expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(at - 45 * 86_400_000);
        }
        for (const key of new Set(fill.map((r) => r.series))) {
          const times = fill.filter((r) => r.series === key).map((r) => r.ts);
          expect(times).toEqual([...new Set(times)].sort());
        }
        // Every point is a row or a counted drop (for a series the registry knows).
        const dropped = Object.values(out.dropped).reduce((a, b) => a + b, 0);
        if (out.unknown === 0) expect(w.x.length + q.x.length).toBe(fill.length + dropped);
        expect(normalisePlot([w, q], { ...base, variant })).toEqual(out);
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
            parsePlot(body);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a mutated real payload is either still valid or a SchemaDrift, never a crash or a wrong row', () => {
    const doc = JSON.parse(rawFixture('CH-3', 'ch-3-40d-2289').body.toString('utf8'));
    for (const trace of doc.plot.data) {
      trace.x = trace.x.slice(0, 30);
      trace.y = trace.y.slice(0, 30);
    }
    const mutation = fc.tuple(
      fc.integer({ min: 0, max: 1 }),
      fc.constantFrom('name', 'x', 'y', 'meta', 'type'),
      fc.integer({ min: 0, max: 29 }),
      fc.boolean(),
      fc.jsonValue(),
    );
    fc.assert(
      fc.property(mutation, ([t, key, i, inArray, junk]) => {
        const copy = structuredClone(doc);
        if (inArray && (key === 'x' || key === 'y')) copy.plot.data[t][key][i] = junk;
        else copy.plot.data[t][key] = junk;
        try {
          const out = normalisePlot(parsePlot(Buffer.from(JSON.stringify(copy))), ctx('ch-3-40d-2289', '2289'));
          for (const r of out.fill ?? []) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });
});
