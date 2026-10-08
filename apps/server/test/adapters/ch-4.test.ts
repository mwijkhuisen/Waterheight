import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { checkRun, encodeRun, FORECAST_FLAGS, FORECAST_SOURCES, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LAYOUT_DE, type Layout, normalise, SOURCE, TIME } from '../../src/adapters/ch-4/normalise.ts';
import {
  JSON_CAPS,
  MAX_POINTS,
  parseAxisLabel,
  parseBands,
  parseForecast,
  type Trace,
} from '../../src/adapters/ch-4/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// CH-4 BAFU forecast plot (public, catalogue §2.7): parse + normalise of the real recordings equal their goldens
// (invariant 9), the layout rules (position AND name; a missing, extra, reordered or renamed trace is drift), the
// band polygon, the units, the storm-Ciarán capture (the `_it` figure, read with a test-only Italian table) and the
// property tests. `UPDATE_GOLDEN=1` rewrites goldens.

const HOUR = 3_600_000;
const DECL = FORECAST_SOURCES['CH-4'];
const DIR = new URL('../../src/adapters/ch-4/fixtures/', import.meta.url);
const root = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

type Golden = { forecasts: NonNullable<Normalised['forecasts']>; dropped: Normalised['dropped'] };

/** One run per block, its points one per line: a golden of 118 hourly points stays readable and valid JSON. */
function format(g: Golden): string {
  const runs = g.forecasts.map(({ points, ...head }) => {
    const lines = points.map((p) => `  ${JSON.stringify(p)}`).join(',\n');
    return ` ${JSON.stringify(head).slice(0, -1)},"points":[\n${lines}\n ]}`;
  });
  return `{"forecasts":[\n${runs.join(',\n')}\n],"dropped":${JSON.stringify(g.dropped)}}\n`;
}
function golden(name: string, actual: Golden): Golden {
  const url = goldenUrl('CH-4', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, format(actual));
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const read = (name: string) => rawFixture('CH-4', name).body;
/** As the loader runs each spec: a lake figure (`ch-4-forecast-lake`, #78) with its y-axis label as the unit. */
const run = (name: string, variant: string): Normalised => {
  const body = read(name);
  const lake = name.startsWith('ch-4-forecast-lake-');
  return normalise(parseForecast(body), lake ? { variant, axisUnit: parseAxisLabel(body) } : { variant });
};
const projected = (n: Normalised): Golden => ({ forecasts: n.forecasts ?? [], dropped: n.dropped });
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
type Doc = { plot: { data: Record<string, unknown>[]; layout: Record<string, unknown> }; hoverInfo: unknown };
const docOf = (name: string): Doc => JSON.parse(read(name).toString('utf8'));

const FIXTURES = [
  ['ch-4-forecast', '2091'],
  ['ch-4-forecast-2091-20260930t1535z', '2091'],
  ['ch-4-forecast-2091-20260930t1635z', '2091'],
  ['ch-4-forecast-2602-20261004t0535z', '2602'],
  // #78: lake figures (p_forecast), recorded live 2026-10-08 by scripts/smoke-capture.ts.
  ['ch-4-forecast-lake-2209', '2209'],
  ['ch-4-forecast-lake-2032', '2032'],
  ['ch-4-forecast-lake-2642', '2642'],
] as const;
const RUN_A = 'ch-4-forecast-2091-20260930t1535z';
const RUN_B = 'ch-4-forecast-2091-20260930t1635z';

// ---- generated figures ------------------------------------------------------------------------------------------

const T0 = Date.parse('2030-01-07T09:00:00Z');
/** The label of the i-th hour at +01:00, as BAFU writes it. */
const stamp = (i: number) => `${new Date(T0 + (i + 1) * HOUR).toISOString().slice(0, 19)}.000+01:00`;
const stamps = (n: number) => Array.from({ length: n }, (_, i) => stamp(i));

type Cols = Record<'vmax' | 'vmin' | 'p25' | 'p50' | 'p75', (number | null)[]>;
const cols = (n: number): Cols => {
  const col = (base: number) => Array.from({ length: n }, (_, i) => base + i);
  return { vmax: col(120), vmin: col(80), p25: col(90), p50: col(100), p75: col(110) };
};

/** The five traces of a figure over `xs`: the band is the closed 2n + 1 polygon (25 % forward, 75 % backward). */
function build(xs: string[], c: Cols, unit = 'm³/s', names: Layout = LAYOUT_DE): Trace[] {
  const polygon = xs.length === 0 ? { x: [], y: [] } : bandOf(xs, c.p25, c.p75);
  return [
    { name: names[0], x: [...xs], y: [...c.vmax], meta: { unit } },
    { name: names[1], x: [...xs], y: [...c.vmin], meta: { unit } },
    { name: names[2], ...polygon, meta: { unit: '' } },
    { name: names[3], x: [...xs], y: [...c.p50], meta: { unit } },
    { name: names[4], x: xs.slice(0, 3), y: [1, 2, 3].slice(0, xs.length), meta: { unit } },
  ];
}
const bandOf = (xs: string[], p25: (number | null)[], p75: (number | null)[]) => ({
  x: [...xs, ...[...xs].reverse(), xs[0] as string],
  y: [...p25, ...[...p75].reverse(), p25[0] as number | null],
});
const figure = (n = 5, unit = 'm³/s'): Trace[] => build(stamps(n), cols(n), unit);
const variant = { variant: '2091' };
const drift = (code: string, path?: string) => expect.objectContaining(path === undefined ? { code } : { code, path });
const once = (traces: Trace[], ctx = variant) => normalise(traces, ctx).forecasts?.[0];

/** The fetch of a real recording: the meta's own `recorded_at`. */
const fetchedAt = (name: string) => Date.parse(rawFixture('CH-4', name).meta.recorded_at);

describe('golden files (real recordings)', () => {
  for (const [name, v] of FIXTURES) {
    it(`${name}: parse + normalise equals the golden, and the run passes the core bounds whole`, () => {
      const out = projected(run(name, v));
      expect(out).toEqual(golden(name, out));
      for (const r of out.forecasts) {
        const c = checkRun(r, fetchedAt(name), DECL);
        expect(c.dropped).toEqual({});
        expect(c.run?.points).toHaveLength(r.points.length);
        // The envelope and the band are in order at every point: no ORDER flag on a real run.
        expect(c.run?.points.every((p) => (p.flags & FORECAST_FLAGS.ORDER) === 0)).toBe(true);
      }
    });
  }

  it('a normal run: 118 hourly points of the median, its band and its envelope, issued at the fetch (not stated)', () => {
    const out = run(RUN_A, '2091');
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
    expect(out.obs).toEqual([]);
    expect(out.forecasts).toHaveLength(1);
    const [r] = out.forecasts ?? [];
    expect(r).toMatchObject({
      target: 'CH-1',
      series: '2091/Q',
      kind: 'ensemble_summary',
      stepMs: HOUR,
      issuedAt: null,
      providerSegmentEnd: null,
    });
    const pts = r?.points ?? [];
    expect(pts).toHaveLength(118);
    const ms = pts.map((p) => Date.parse(p.ts));
    expect(ms.every((t, i) => i === 0 || t - (ms[i - 1] as number) === HOUR)).toBe(true);
    // 2026-09-30T11:00:00+02:00 … 2026-10-05T08:00:00+02:00 in UTC.
    expect([pts[0]?.ts, pts.at(-1)?.ts]).toEqual(['2026-09-30T09:00:00.000Z', '2026-10-05T06:00:00.000Z']);
    // The run starts at the measured value: the whole spread is one number there; at the end it has opened up.
    expect(pts[0]).toMatchObject({ value: 328.2, p50: 328.2, p25: 328.2, p75: 328.2, vmin: 328.2, vmax: 328.2 });
    expect(pts.at(-1)).toMatchObject({ value: 340.4, p50: 340.4, vmin: 334.8, vmax: 372.1, flags: 0 });
    expect(pts.every((p) => p.value === p.p50 && p.flags === 0)).toBe(true);
    expect(pts.every((p) => (p.vmin as number) <= (p.p50 as number) && (p.p50 as number) <= (p.vmax as number))).toBe(
      true,
    );
    expect(pts.every((p) => (p.p25 as number) <= (p.p50 as number) && (p.p50 as number) <= (p.p75 as number))).toBe(
      true,
    );
  });

  it('every column is the published value at its place: p25 forward, p75 from the reversed half, vmax first, vmin second', () => {
    const doc = docOf(RUN_A);
    const [vmax, vmin, band, median] = doc.plot.data as unknown as [Trace, Trace, Trace, Trace];
    const n = median.x.length;
    const [r] = run(RUN_A, '2091').forecasts ?? [];
    for (const [i, p] of (r?.points ?? []).entries()) {
      expect(p).toMatchObject({
        value: median.y[i],
        p50: median.y[i],
        p25: band.y[i],
        // The second half of the polygon runs back over the median's x: its j-th value belongs to x[n - 1 - j].
        p75: band.y[n + (n - 1 - i)],
        vmax: vmax.y[i],
        vmin: vmin.y[i],
      });
      expect(Date.parse(p.ts)).toBe(Date.parse(median.x[i] as string));
    }
    expect(band.x).toHaveLength(2 * n + 1);
  });

  it('the measured trace, the title and the styling are not stored: they are no part of the run', () => {
    const doc = docOf(RUN_A);
    const [r] = run(RUN_A, '2091').forecasts ?? [];
    // 118 points of the forecast, none of the 25 measured ones that start a day earlier.
    expect(r?.points).toHaveLength(118);
    expect(r?.points[0]?.ts).toBe('2026-09-30T09:00:00.000Z');
    // A second capture of the same run differs in the bytes (title clock, measured values, styling) and in nothing else.
    const again = structuredClone(doc);
    again.plot.layout.title = 'Rhein - Rheinfelden, Messstation QForecastPlot 18:20 (30.09.26)';
    (again.plot.data[4] as { y: number[] }).y = (again.plot.data[4] as { y: number[] }).y.map((v) => v + 1);
    (again.plot.data[3] as { line: unknown }).line = { color: 'green' };
    (again.hoverInfo as { text: string }).text = 'Zeit';
    const a = normalise(parseForecast(read(RUN_A)), variant).forecasts?.[0] as NonNullable<
      Normalised['forecasts']
    >[number];
    const b = normalise(parseForecast(bytes(again)), variant).forecasts?.[0] as NonNullable<
      Normalised['forecasts']
    >[number];
    const canon = (x: typeof a) => encodeRun(checkRun(x, fetchedAt(RUN_A), DECL).run as never);
    expect(Buffer.from(canon(b))).toEqual(Buffer.from(canon(a)));
    expect(Buffer.from(bytes(again)).equals(read(RUN_A))).toBe(false);
  });

  it('the next run of the day is another run: it starts later and its values differ on the overlap', () => {
    const [a] = run(RUN_A, '2091').forecasts ?? [];
    const [b] = run(RUN_B, '2091').forecasts ?? [];
    expect(b?.points).toHaveLength(114);
    expect(b?.points[0]?.ts).toBe('2026-09-30T13:00:00.000Z');
    expect(b?.points.at(-1)?.ts).toBe(a?.points.at(-1)?.ts);
    expect(b?.points.map((p) => p.p50)).not.toEqual(a?.points.slice(4).map((p) => p.p50));
  });

  it('the edge recording: a shorter measured trace (17 points) changes nothing of the run (another station, Q)', () => {
    const doc = docOf('ch-4-forecast-2602-20261004t0535z');
    expect((doc.plot.data[4] as { x: unknown[] }).x).toHaveLength(17);
    const [r] = run('ch-4-forecast-2602-20261004t0535z', '2602').forecasts ?? [];
    expect(r).toMatchObject({ series: '2602/Q', target: 'CH-1', kind: 'ensemble_summary' });
    expect(r?.points).toHaveLength(118);
    // 2026-10-03T23:00:00+02:00.
    expect(r?.points[0]?.ts).toBe('2026-10-03T21:00:00.000Z');
  });

  it('the real figures state `_de` trace names in the declared layout and one unit', () => {
    for (const [name] of FIXTURES) {
      const traces = parseForecast(read(name));
      expect(traces.map((t) => t.name)).toEqual([...LAYOUT_DE]);
      expect(traces.map((t) => t.meta.unit)).toEqual(['m³/s', 'm³/s', '', 'm³/s', 'm³/s']);
    }
  });
});

describe('the storm-Ciarán capture (the `_it` figure of station 2020, Wayback, 2023-11-02)', () => {
  // Trace names are language-specific, and inconsistent inside this one file: "Min. / Max." (the maximum) and
  // "Min / Max" (the minimum), the band in English, the median and the measured trace in Italian. This table exists
  // only here; production fetches `_de` and never reads another language.
  const IT: Layout = ['Min. / Max.', 'Min / Max', '25.-75. percentile', 'Mediana', 'Misurato'];
  const NAME = 'ch-4-forecast-ciaran-it';
  const body = read(NAME);

  it('is a real, third-party recording that is never a golden', () => {
    const meta = rawFixture('CH-4', NAME).meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      spec: 'ch-4-forecast',
      source: 'CH-4',
      synthetic: false,
      status: 200,
      wayback: true,
      trimmed: false,
      url: 'https://web.archive.org/web/20231102103317id_/https://www.hydrodaten.admin.ch/plots/q_forecast/2020_q_forecast_it.json',
    });
    expect(existsSync(new URL(`${NAME}.golden.json`, DIR))).toBe(false);
    // The archive serves it gzip-encoded; fetch decoded that transport encoding, so the file is the plain JSON.
    expect(body.subarray(0, 2).toString()).toBe('{"');
  });

  it('production, which reads `_de` names, refuses it: drift at the first trace that is named otherwise, never mislabelled', () => {
    expect(() => normalise(parseForecast(body), { variant: '2020' })).toThrow(drift('ch4_layout', 'data.1'));
  });

  it('with the Italian table: median up to 476 m³/s, maximum 800 m³/s, in 119 hourly points of one run', () => {
    const out = normalise(parseForecast(body), { variant: '2020' }, IT);
    expect(out.dropped).toEqual({});
    const [r] = out.forecasts ?? [];
    expect(r).toMatchObject({ target: 'CH-1', series: '2020/Q', kind: 'ensemble_summary', stepMs: HOUR });
    const pts = r?.points ?? [];
    expect(pts).toHaveLength(119);
    // 2023-11-02T03:00:00+01:00 … 2023-11-07T01:00:00+01:00.
    expect([pts[0]?.ts, pts.at(-1)?.ts]).toEqual(['2023-11-02T02:00:00.000Z', '2023-11-07T00:00:00.000Z']);
    const peak = Math.max(...pts.map((p) => p.p50 as number));
    const max = Math.max(...pts.map((p) => p.vmax as number));
    expect([peak, Math.round(peak)]).toEqual([476.4, 476]);
    expect([max, Math.round(max)]).toEqual([800.3, 800]);
    // The core accepts it as it was fetched on the day of the capture (the Wayback timestamp), in order everywhere.
    const c = checkRun(r as NonNullable<typeof r>, Date.parse('2023-11-02T10:33:17Z'), DECL);
    expect(c.dropped).toEqual({});
    expect(c.run?.points.every((p) => p.flags === 0)).toBe(true);
    // Nothing of the figure's own text, its measured trace or its thresholds is stored.
    const stored = JSON.stringify(out);
    for (const word of ['Mediana', 'Misurato', 'percentile', 'Min', 'Bellinzona']) expect(stored).not.toContain(word);
  });

  it('the threshold bands of its layout: 700, 1100, 1450 and 1800 m³/s, each band once, read apart from the run', () => {
    const bands = parseBands(body);
    expect(bands.map((b) => b.lower)).toEqual([700, 1100, 1450, 1800]);
    expect(bands.map((b) => b.upper)).toEqual([1100, 1450, 1800, 3600]);
    // The storm's forecast reaches the first band with its maximum only.
    const out = normalise(parseForecast(body), { variant: '2020' }, IT);
    const pts = out.forecasts?.[0]?.points ?? [];
    expect(Math.max(...pts.map((p) => p.p50 as number))).toBeLessThan(700);
    expect(Math.max(...pts.map((p) => p.vmax as number))).toBeGreaterThan(700);
  });
});

describe('layout drift (synthetic and derived from a real figure)', () => {
  it('declares ISO times with their own offset and its source', () => {
    expect(TIME).toEqual({ kind: 'iso-offset' });
    expect(SOURCE).toBe('CH-4');
    expect(LAYOUT_DE).toEqual(['Min. / Max.', 'Min. / Max.', '25.-75. Perzentil', 'Median', 'Gemessen']);
  });

  it('reordered traces (the band and the median traded places) are drift, found at the first misplaced position', () => {
    const traces = parseForecast(read('ch-4-forecast-reordered.synthetic'));
    expect(traces.map((t) => t.name)).toEqual([
      'Min. / Max.',
      'Min. / Max.',
      'Median',
      '25.-75. Perzentil',
      'Gemessen',
    ]);
    expect(() => normalise(traces, variant)).toThrow(drift('ch4_layout', 'data.2'));
  });

  it('a renamed trace (the median called Mediana) is drift at its position', () => {
    const traces = parseForecast(read('ch-4-forecast-renamed.synthetic'));
    expect(() => normalise(traces, variant)).toThrow(drift('ch4_layout', 'data.3'));
  });

  it('each of the five traces renamed, and a name that merely differs in case, space or dot, is drift at its position', () => {
    for (const i of [0, 1, 2, 3, 4])
      for (const name of ['', 'Median ', 'median', 'Min / Max', 'Mediana', LAYOUT_DE[(i + 1) % 5] as string]) {
        if (name === LAYOUT_DE[i]) continue;
        const traces = figure();
        (traces[i] as Trace).name = name;
        expect(() => normalise(traces, variant)).toThrow(drift('ch4_layout', `data.${i}`));
      }
  });

  it('a missing trace and an extra trace are drift of the whole figure', () => {
    for (const i of [0, 1, 2, 3, 4]) {
      const traces = figure();
      traces.splice(i, 1);
      expect(() => normalise(traces, variant)).toThrow(drift('ch4_layout', 'data'));
    }
    expect(() => normalise([...figure(), figure()[4] as Trace], variant)).toThrow(drift('ch4_layout', 'data'));
    expect(() => normalise([], variant)).toThrow(drift('ch4_layout', 'data'));
  });

  it('every pair of traces traded is drift unless the two carry the same name (the envelope), which the core then flags', () => {
    for (const [i, j] of [
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
      [0, 4],
    ] as const) {
      const traces = figure();
      [traces[i], traces[j]] = [traces[j] as Trace, traces[i] as Trace];
      expect(() => normalise(traces, variant)).toThrow(SchemaDrift);
    }
    // The maximum and the minimum carry one name: swapping them cannot be seen by name, so the values show it: the
    // minimum is above the median and the core flags every point `ORDER` instead of storing it as ordered.
    const traces = figure(6);
    [traces[0], traces[1]] = [traces[1] as Trace, traces[0] as Trace];
    const r = once(traces);
    expect(r?.points).toHaveLength(6);
    const checked = checkRun(r as NonNullable<typeof r>, T0 + 3 * HOUR, DECL);
    expect(checked.run?.points.every((p) => p.flags === FORECAST_FLAGS.ORDER)).toBe(true);
    // The values were not reordered by the adapter.
    expect(r?.points.map((p) => p.vmax)).toEqual([80, 81, 82, 83, 84, 85]);
  });

  it('the x values of the maximum, the minimum and the median must be the same (ch4_axis)', () => {
    const edits: [number, (t: Trace) => void][] = [
      [0, (t) => (t.x[2] = stamp(9))],
      [1, (t) => t.x.reverse()],
      [0, (t) => (t.x = t.x.slice(0, 4))],
      [1, (t) => (t.x = [...t.x, stamp(5)])],
    ];
    for (const [i, edit] of edits) {
      const traces = figure();
      edit(traces[i] as Trace);
      traces[i] = { ...(traces[i] as Trace), y: (traces[i] as Trace).x.map(() => 1) };
      expect(() => normalise(traces, variant)).toThrow(drift('ch4_axis', `data.${i}`));
    }
  });

  it('the band must be the closed polygon 25 % forward, 75 % backward, and closed (ch4_band)', () => {
    const wrong: [string, (band: Trace, median: Trace) => void][] = [
      [
        'one point short',
        (b) => {
          b.x.pop();
          b.y.pop();
        },
      ],
      [
        'one point too long',
        (b) => {
          b.x.push(b.x[0] as string);
          b.y.push(b.y[0] as number);
        },
      ],
      [
        'only the first half',
        (b, m) => {
          b.x = [...m.x];
          b.y = [...m.y];
        },
      ],
      [
        'the second half forward',
        (b, m) => {
          b.x.splice(m.x.length, m.x.length, ...m.x);
        },
      ],
      [
        'a wrong x in the first half',
        (b) => {
          b.x[1] = stamp(40);
        },
      ],
      [
        'a wrong x in the second half',
        (b) => {
          b.x[7] = stamp(40);
        },
      ],
      [
        'not closed in x',
        (b) => {
          b.x[b.x.length - 1] = stamp(40);
        },
      ],
      [
        'not closed in y',
        (b) => {
          b.y[b.y.length - 1] = 12345;
        },
      ],
      [
        'empty',
        (b) => {
          b.x = [];
          b.y = [];
        },
      ],
    ];
    for (const [label, edit] of wrong) {
      const traces = figure();
      edit(traces[2] as Trace, traces[3] as Trace);
      expect(() => normalise(traces, variant), label).toThrow(drift('ch4_band', 'data.2'));
    }
  });

  it('a band with its own unit is fine only if it is the median’s (the real band states none)', () => {
    const traces = figure();
    (traces[2] as Trace).meta.unit = 'm³/s';
    expect(once(traces)?.points).toHaveLength(5);
    (traces[2] as Trace).meta.unit = 'cm';
    expect(() => normalise(traces, variant)).toThrow(drift('unit_mismatch', 'data.2'));
  });
});

describe('units, series and values', () => {
  const unitsOf = (u: string, n = 3): Trace[] => build(stamps(n), cols(n), u);

  it('the unit is the median’s own, looked up in the forecast source’s declaration', () => {
    expect(DECL.units).toEqual({
      'm³/s': ['Q', 1],
      'm3/s': ['Q', 1],
      'l/s': ['Q', 0.001],
      'm ü. M.': ['H', 100],
      'm ü.M.': ['H', 100],
    });
    for (const u of ['m³/s', 'm3/s']) expect(once(unitsOf(u))).toMatchObject({ series: '2091/Q', target: 'CH-1' });
    expect(once(unitsOf('m³/s'))?.points.map((p) => p.p50)).toEqual([100, 101, 102]);
  });

  it('litres per second are divided by 1000 and lake levels become centimetres of a W series, without float noise', () => {
    const l = once(
      build(
        stamps(2),
        { ...cols(2), p50: [1234, 0.5], vmax: [1235, 2], vmin: [1, 0], p25: [3, 4], p75: [5, 6] },
        'l/s',
      ),
    );
    expect(l).toMatchObject({ series: '2091/Q' });
    expect(l?.points.map((p) => [p.p50, p.vmax, p.vmin])).toEqual([
      [1.234, 1.235, 0.001],
      [0.0005, 0.002, 0],
    ]);
    for (const u of ['m ü. M.', 'm ü.M.']) {
      const w = once(
        build(
          stamps(2),
          {
            ...cols(2),
            p50: [406.23, 406.3],
            vmax: [406.31, 406.4],
            vmin: [406.1, 406.2],
            p25: [406.2, 406.2],
            p75: [406.25, 406.3],
          },
          u,
        ),
      );
      expect(w).toMatchObject({ series: '2091/W', target: 'CH-1', kind: 'ensemble_summary' });
      expect(w?.points.map((p) => [p.value, p.p25, p.p75, p.vmin, p.vmax])).toEqual([
        [40623, 40620, 40625, 40610, 40631],
        [40630, 40620, 40630, 40620, 40640],
      ]);
    }
  });

  it('an unknown unit is drift, however it is spelt, and so is any name that is a property of an object', () => {
    for (const u of [
      '',
      'cfs',
      'm³/S',
      'M³/s',
      'm³ /s',
      'cm',
      'm',
      'm ü. M',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ])
      expect(() => normalise(unitsOf(u), variant)).toThrow(drift('unknown_unit', 'data.3'));
  });

  it('the maximum and the minimum must state the median’s unit (unit_mismatch)', () => {
    for (const i of [0, 1]) {
      const traces = figure();
      (traces[i] as Trace).meta.unit = 'm3/s';
      expect(() => normalise(traces, variant)).toThrow(drift('unit_mismatch', `data.${i}`));
    }
  });

  it('the series is the station’s CH-1 key by the declared quantity; the variant is ours and must be four digits', () => {
    for (const v of ['2091', '0001', '9999']) expect(once(figure(), { variant: v })?.series).toBe(`${v}/Q`);
    for (const bad of ['', '209', '20911', 'abcd', '2091/Q', ' 2091', '2091 ', '２０９１', '-209', '2.91'])
      expect(() => normalise(figure(), { variant: bad })).toThrow(drift('bad_variant'));
  });

  it('every station of the seed has a CH-1 series (a Q series, or a W series for the lakes), so none is unknown', () => {
    const lines = root('registry/seed/ch-4.csv')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines[0]).toBe('id,plot');
    const rows = lines.slice(1).map((l) => l.split(','));
    expect(rows).toHaveLength(54);
    const ch1 = registryOf('CH-1');
    const kinds = new Map<string, number>();
    for (const row of rows) {
      const [id = '', plot] = row;
      expect([id, row.length]).toEqual([id, 2]);
      expect(id).toMatch(/^\d{4}$/);
      const q = ch1.get(`${id}/Q`);
      const w = ch1.get(`${id}/W`);
      expect([id, q !== undefined || w !== undefined]).toEqual([id, true]);
      // The declared mapping of the two kinds of figure onto the CH-1 quantities, and #78: a lake (no Q) is fetched
      // from p_forecast (plot p), every other station from q_forecast (plot q).
      if (q === undefined) expect([id, w?.quantity, plot]).toEqual([id, 'H', 'p']);
      else expect([id, q.quantity, plot]).toEqual([id, 'Q', 'q']);
      kinds.set(q === undefined ? 'W' : 'Q', (kinds.get(q === undefined ? 'W' : 'Q') ?? 0) + 1);
    }
    expect([...kinds].sort()).toEqual([
      ['Q', 41],
      ['W', 13],
    ]);
  });

  it('a null is an absent column, a point of nulls is a gap and a run of gaps is none; the median null leaves `value` absent', () => {
    const c = cols(4);
    c.p50[1] = null;
    c.p25[2] = null;
    for (const k of ['p50', 'p25', 'p75', 'vmax', 'vmin'] as const) c[k][3] = null;
    const out = normalise(build(stamps(4), c), variant);
    expect(out.dropped).toEqual({ gap: 1 });
    const pts = out.forecasts?.[0]?.points ?? [];
    expect(pts).toHaveLength(3);
    expect(pts[1]).toMatchObject({ value: null, p50: null, p25: 91, p75: 111, vmin: 81, vmax: 121 });
    expect(pts[2]).toMatchObject({ value: 102, p25: null });
    const none = normalise(
      build(stamps(3), {
        vmax: [null, null, null],
        vmin: [null, null, null],
        p25: [null, null, null],
        p50: [null, null, null],
        p75: [null, null, null],
      }),
      variant,
    );
    expect(none.forecasts).toBeUndefined();
    expect(none.dropped).toEqual({ gap: 3, empty_run: 1 });
  });

  it('a figure of no points is no run, only the drop count', () => {
    const out = normalise(build([], cols(0)), variant);
    expect(out.forecasts).toBeUndefined();
    expect(out.dropped).toEqual({ empty_run: 1 });
  });

  it('a timestamp needs an offset and a real date: drift otherwise, with the point’s place', () => {
    const at = (i: number, value: string) => {
      const traces = figure(3);
      // The three traces that share their x must agree, so the edit is made on all of them.
      for (const t of [0, 1, 3]) (traces[t] as Trace).x[i] = value;
      const band = traces[2] as Trace;
      const n = 3;
      band.x[i] = value;
      band.x[2 * n - 1 - i] = value;
      if (i === 0) band.x[2 * n] = value;
      return () => normalise(traces, variant);
    };
    expect(at(1, '2030-01-07T10:00:00')).toThrow(drift('time_bad_format', 'data.3.x.1'));
    expect(at(2, 'soon')).toThrow(drift('time_bad_format', 'data.3.x.2'));
    expect(at(0, '2030-02-30T10:00:00.000+01:00')).toThrow(drift('time_bad_format', 'data.3.x.0'));
    expect(at(1, '9999-01-07T07:00:00.000Z')).toThrow(drift('time_out_of_range'));
  });

  it('across the autumn fall-back the labels change from +02:00 to +01:00 and the run stays hourly in UTC', () => {
    // 2026-10-25: 02:00+02:00 (00:00Z) is followed by 02:00+01:00 (01:00Z), the second 02:00.
    const xs = [
      '2026-10-25T00:00:00.000+02:00',
      '2026-10-25T01:00:00.000+02:00',
      '2026-10-25T02:00:00.000+02:00',
      '2026-10-25T02:00:00.000+01:00',
      '2026-10-25T03:00:00.000+01:00',
      '2026-10-25T04:00:00.000+01:00',
    ];
    const r = once(build(xs, cols(6)));
    expect(r?.points.map((p) => p.ts)).toEqual([
      '2026-10-24T22:00:00.000Z',
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
    ]);
    const c = checkRun(r as NonNullable<typeof r>, Date.parse('2026-10-24T22:30:00Z'), DECL);
    expect(c.dropped).toEqual({});
    expect(c.run?.points).toHaveLength(6);
  });

  it('two points at one instant are drift in the loader’s check, not here', () => {
    const xs = stamps(4);
    xs[3] = xs[1] as string;
    const r = once(build(xs, cols(4)));
    expect(() => checkRun(r as NonNullable<typeof r>, T0, DECL)).toThrow(drift('duplicate_ts'));
  });

  it('a run past the source’s horizon is cut by the core, never here', () => {
    const n = 130;
    const r = once(build(stamps(n), cols(n)));
    expect(r?.points).toHaveLength(n);
    const c = checkRun(r as NonNullable<typeof r>, T0, DECL);
    expect(c.run?.points).toHaveLength(121 + 1);
    expect(c.dropped).toEqual({ beyond_horizon: n - 122 });
  });
});

describe('parse: strict, bounded, fixed codes', () => {
  const good = (): Doc => docOf(RUN_A);
  const parsed = (d: unknown) => () => parseForecast(bytes(d));

  it('reads name, unit and the arrays of each trace, and ignores the styling', () => {
    const traces = parseForecast(read(RUN_A));
    expect(traces).toHaveLength(5);
    expect(traces.map((t) => [t.x.length, t.y.length])).toEqual([
      [118, 118],
      [118, 118],
      [237, 237],
      [118, 118],
      [25, 25],
    ]);
    expect(Object.keys(traces[3] as Trace).sort()).toEqual(['meta', 'name', 'x', 'y']);
    // A styling key that is added or removed is no drift: only what is read is checked.
    const d = good();
    (d.plot.data[3] as Record<string, unknown>).hovertemplate = 'x';
    delete (d.plot.data[3] as Record<string, unknown>).line;
    expect(parseForecast(bytes(d))).toHaveLength(5);
  });

  it('the document and its plot are strict, and each trace has what is read', () => {
    const d = good();
    expect(parsed({ ...d, extra: 1 })).toThrow(SchemaDrift);
    expect(parsed({ ...d, plot: { ...d.plot, extra: 1 } })).toThrow(SchemaDrift);
    expect(parsed({ hoverInfo: d.hoverInfo })).toThrow(SchemaDrift);
    expect(parsed({ ...d, plot: { layout: d.plot.layout } })).toThrow(SchemaDrift);
    expect(parsed({ ...d, plot: { data: d.plot.data } })).toThrow(SchemaDrift);
    expect(parsed({ ...d, plot: { ...d.plot, data: {} } })).toThrow(SchemaDrift);
    for (const key of ['name', 'x', 'y', 'meta']) {
      const bad = good();
      delete (bad.plot.data[3] as Record<string, unknown>)[key];
      expect(parsed(bad)).toThrow(drift('invalid_type', `plot.data.3.${key}`));
    }
    const bad = good();
    (bad.plot.data[2] as { meta: unknown }).meta = { hoverformat: null };
    expect(parsed(bad)).toThrow(drift('invalid_type', 'plot.data.2.meta.unit'));
    for (const edit of [
      { name: 7 },
      { name: 'x'.repeat(101) },
      { x: [1, 2] },
      { x: ['a'.repeat(41)] },
      { y: ['1'] },
      { meta: { unit: 5 } },
      { meta: { unit: 'u'.repeat(41) } },
    ])
      expect(parsed({ ...d, plot: { ...d.plot, data: [{ ...(d.plot.data[3] as object), ...edit }] } })).toThrow(
        SchemaDrift,
      );
  });

  it('x and y of a trace have one length (length_mismatch, with the trace’s place)', () => {
    const d = good();
    (d.plot.data[1] as { y: unknown[] }).y.pop();
    expect(parsed(d)).toThrow(drift('length_mismatch', 'plot.data.1'));
  });

  it('bounded: invalid UTF-8, not JSON, a wrong root, too many traces, points, values or levels, and Infinity', () => {
    expect(() => parseForecast(Buffer.from([0xff, 0xfe, 0x7b]))).toThrow(drift('encoding'));
    expect(() => parseForecast(Buffer.from('{"plot":'))).toThrow(drift('not_json'));
    expect(parsed([])).toThrow(drift('invalid_type'));
    expect(parsed(null)).toThrow(drift('invalid_type'));
    expect(parsed('x')).toThrow(drift('invalid_type'));
    const d = good();
    expect(parsed({ ...d, plot: { ...d.plot, data: Array.from({ length: 11 }, () => d.plot.data[3]) } })).toThrow(
      drift('too_big'),
    );
    expect(
      parseForecast(bytes({ ...d, plot: { ...d.plot, data: Array.from({ length: 10 }, () => d.plot.data[3]) } })),
    ).toHaveLength(10);
    const trace = (n: number) => ({ name: 'a', x: Array(n).fill('a'), y: Array(n).fill(1), meta: { unit: 'u' } });
    expect(parsed({ ...d, plot: { ...d.plot, data: [trace(MAX_POINTS + 1)] } })).toThrow(drift('too_big'));
    expect(parseForecast(bytes({ ...d, plot: { ...d.plot, data: [trace(MAX_POINTS)] } }))).toHaveLength(1);
    expect(parsed({ ...d, plot: { ...d.plot, layout: Array.from({ length: JSON_CAPS.maxNodes }, () => 0) } })).toThrow(
      drift('json_too_many_nodes'),
    );
    expect(parsed({ ...d, plot: { ...d.plot, layout: [[[[[[[]]]]]]] } })).toThrow(drift('json_too_deep'));
    expect(() =>
      parseForecast(
        Buffer.from('{"hoverInfo":1,"plot":{"layout":1,"data":[{"name":"a","x":[],"y":[1e999],"meta":{"unit":"u"}}]}}'),
      ),
    ).toThrow(SchemaDrift);
  });

  it('the real figures are well inside the caps', () => {
    for (const [name] of FIXTURES) expect(read(name).length).toBeLessThan(2 * 1024 * 1024);
    expect(JSON_CAPS).toEqual({ maxNodes: 8000, maxDepth: 8 });
  });

  it('parseBands: the bands of the figure, each once, from the lowest; shapes that are not bands are skipped', () => {
    expect(parseBands(read(RUN_A))).toEqual([
      { lower: 2500, upper: 3000 },
      { lower: 3000, upper: 3600 },
      { lower: 3600, upper: 4500 },
      { lower: 4500, upper: 9000 },
    ]);
    const d = good();
    d.plot.layout.shapes = [
      { type: 'line', yref: 'paper', y0: 0, y1: 1 },
      { type: 'rect', yref: 'y1', y0: 20, y1: 30 },
      { type: 'rect', yref: 'y1', y0: 20, y1: 30 },
      { type: 'rect', yref: 'paper', y0: 0, y1: 1 },
      { type: 'rect', yref: 'y2', y0: 5, y1: 6 },
      { type: 'rect', yref: 'y', y0: 10, y1: 20 },
      { type: 'circle' },
    ];
    expect(parseBands(bytes(d))).toEqual([
      { lower: 10, upper: 20 },
      { lower: 20, upper: 30 },
    ]);
    delete d.plot.layout.shapes;
    expect(parseBands(bytes(d))).toEqual([]);
    d.plot.layout = null as never;
    expect(parseBands(bytes(d))).toEqual([]);
  });

  it('parseBands: a band without numeric edges, a bad shape or a bad layout is drift, with the shape’s place', () => {
    const d = good();
    d.plot.layout.shapes = [{ type: 'rect', yref: 'y1', y0: '20', y1: 30 }];
    expect(() => parseBands(bytes(d))).toThrow(drift('invalid_type', 'plot.layout.shapes.0.y0'));
    d.plot.layout.shapes = [{ type: 'rect', yref: 'y1', y0: 1 }];
    expect(() => parseBands(bytes(d))).toThrow(drift('invalid_type', 'plot.layout.shapes.0.y1'));
    d.plot.layout.shapes = [7];
    expect(() => parseBands(bytes(d))).toThrow(drift('invalid_type', 'plot.layout.shapes.0'));
    d.plot.layout.shapes = Array.from({ length: 201 }, () => ({ type: 'line' }));
    expect(() => parseBands(bytes(d))).toThrow(drift('too_big'));
    d.plot.layout = 'x' as never;
    expect(() => parseBands(bytes(d))).toThrow(drift('invalid_type', 'plot.layout'));
    expect(() => parseBands(Buffer.from('x'))).toThrow(drift('not_json'));
  });
});

describe('lake figures (p_forecast, #78)', () => {
  const LAKE = 'ch-4-forecast-lake-2209';
  const lake = (unit: string, axisUnit: string) =>
    normalise(build(stamps(2), { ...cols(2), p50: [405.26, 405.27] }, unit), { variant: '2209', axisUnit });

  it('the real lake figure: the five traces with BAFU’s `m³/s`, its axis labelled `m ü.M.`; a W run in centimetres', () => {
    const body = read(LAKE);
    const traces = parseForecast(body);
    expect(traces.map((t) => [t.name, t.meta.unit, t.x.length])).toEqual([
      ['Min. / Max.', 'm³/s', 114],
      ['Min. / Max.', 'm³/s', 114],
      ['25.-75. Perzentil', '', 229],
      ['Median', 'm³/s', 114],
      ['Gemessen', 'm³/s', 25],
    ]);
    expect(parseAxisLabel(body)).toBe('m ü.M.');
    const out = run(LAKE, '2209');
    expect(out.dropped).toEqual({});
    const [r] = out.forecasts ?? [];
    expect(r).toMatchObject({ target: 'CH-1', series: '2209/W', kind: 'ensemble_summary', stepMs: HOUR });
    // 114 hourly points of the median; the measured trace (a day before the run) is never stored.
    expect(r?.points).toHaveLength(114);
    expect(r?.points[0]?.ts).toBe(new Date(Date.parse(traces[3]?.x[0] ?? '')).toISOString());
    expect(
      r?.points.every((p, i) => i === 0 || Date.parse(p.ts) - Date.parse(r.points[i - 1]?.ts ?? '') === HOUR),
    ).toBe(true);
    // Zürichsee at about 405.3 m ü.M. (LN02), in centimetres like the CH-1 W series it sits on.
    expect(r?.points.every((p) => (p.value ?? 0) > 40_400 && (p.value ?? 0) < 40_700)).toBe(true);
    // Read by its trace unit alone (the q_forecast way) it would be a discharge: hence the label.
    expect(normalise(traces, { variant: '2209' }).forecasts?.[0]?.series).toBe('2209/Q');
  });

  it('a river figure’s label is its trace unit (`m³/s`), and every real figure has exactly one', () => {
    for (const [name] of FIXTURES)
      expect(parseAxisLabel(read(name))).toBe(name.startsWith('ch-4-forecast-lake-') ? 'm ü.M.' : 'm³/s');
  });

  it('the label is the unit: a declared H unit, with the traces stating it or BAFU’s `m³/s`, else drift', () => {
    for (const label of ['m ü.M.', 'm ü. M.']) {
      for (const unit of [label, 'm³/s']) {
        const r = lake(unit, label).forecasts?.[0];
        expect(r?.series).toBe('2209/W');
        expect(r?.points.map((p) => p.value)).toEqual([40526, 40527]);
      }
      for (const unit of ['m3/s', 'l/s', '', 'cm', label === 'm ü.M.' ? 'm ü. M.' : 'm ü.M.'])
        expect(() => lake(unit, label)).toThrow(drift('unit_mismatch', 'data.3'));
    }
    // A label that is not a declared unit, or a discharge, is never a lake level.
    for (const label of ['m³/s', 'm3/s', 'l/s', '', 'm', 'cm', 'm ü.M', 'constructor', '__proto__'])
      expect(() => lake('m³/s', label)).toThrow(drift('unknown_unit', 'layout'));
    // The envelope keeps its rule: the maximum states the median's unit.
    const traces = build(stamps(2), cols(2), 'm³/s');
    (traces[0] as Trace).meta.unit = 'm ü.M.';
    expect(() => normalise(traces, { variant: '2209', axisUnit: 'm ü.M.' })).toThrow(drift('unit_mismatch', 'data.0'));
  });

  it('parseAxisLabel: exactly one paper-anchored annotation with a text, else drift; bounded and strict', () => {
    const d = docOf(LAKE);
    const label = { text: 'm ü.M.', xref: 'paper', yref: 'paper' };
    const start = { text: 'Vorhersage ab', xref: 'x', yref: 'paper' };
    const withAnn = (annotations: unknown) => bytes({ ...d, plot: { ...d.plot, layout: { annotations } } });
    expect(parseAxisLabel(withAnn([start, label]))).toBe('m ü.M.');
    for (const bad of [[], [start], [label, label], [{ ...label, text: undefined }], [{ xref: 'paper' }]])
      expect(() => parseAxisLabel(withAnn(bad))).toThrow(drift('ch4_axis_label', 'plot.layout'));
    expect(() => parseAxisLabel(bytes({ ...d, plot: { ...d.plot, layout: {} } }))).toThrow(drift('ch4_axis_label'));
    expect(() => parseAxisLabel(withAnn([{ ...label, text: 7 }]))).toThrow(
      drift('invalid_type', 'plot.layout.annotations.0.text'),
    );
    expect(() => parseAxisLabel(withAnn([{ ...label, text: 'm'.repeat(101) }]))).toThrow(drift('too_big'));
    expect(() => parseAxisLabel(withAnn([7]))).toThrow(drift('invalid_type', 'plot.layout.annotations.0'));
    expect(() => parseAxisLabel(withAnn(Array.from({ length: 21 }, () => start)))).toThrow(drift('too_big'));
    expect(parseAxisLabel(withAnn([...Array.from({ length: 19 }, () => start), label]))).toBe('m ü.M.');
    expect(() => parseAxisLabel(withAnn('x'))).toThrow(drift('invalid_type', 'plot.layout.annotations'));
    expect(() => parseAxisLabel(Buffer.from('x'))).toThrow(drift('not_json'));
  });
});

describe('the fixtures', () => {
  it('every real forecast raw has a golden and every golden a raw (the Wayback capture and the stations list are no golden)', () => {
    const goldens = readdirSync(DIR)
      .filter((f) => f.endsWith('.golden.json'))
      .sort();
    expect(goldens).toEqual(FIXTURES.map(([n]) => `${n}.golden.json`).sort());
  });

  it('the synthetic figures are derived from a real recording by one named edit, and say so', () => {
    for (const name of ['ch-4-forecast-reordered.synthetic', 'ch-4-forecast-renamed.synthetic']) {
      const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, DIR), 'utf8'));
      expect(meta).toMatchObject({ synthetic: true, derived_from: RUN_B, source: 'CH-4', variant: '2091' });
      expect(typeof meta.edit).toBe('string');
    }
  });
});

describe('properties', () => {
  const value = fc.option(
    fc.integer({ min: 0, max: 99_999 }).map((v) => v / 10),
    { nil: null },
  );
  const generated = fc.integer({ min: 0, max: 40 }).chain((n) =>
    fc.record({
      n: fc.constant(n),
      vmax: fc.array(value, { minLength: n, maxLength: n }),
      vmin: fc.array(value, { minLength: n, maxLength: n }),
      p25: fc.array(value, { minLength: n, maxLength: n }),
      p50: fc.array(value, { minLength: n, maxLength: n }),
      p75: fc.array(value, { minLength: n, maxLength: n }),
    }),
  );

  it('every point is stored with the published value of each column, or counted as a gap; the run is the median’s x in order', () => {
    fc.assert(
      fc.property(generated, (g) => {
        const out = normalise(build(stamps(g.n), g), variant);
        const stored = out.forecasts?.[0]?.points ?? [];
        const empty = Array.from({ length: g.n }, (_, i) => i).filter((i) =>
          [g.vmax, g.vmin, g.p25, g.p50, g.p75].every((c) => c[i] === null),
        );
        expect(stored.length + (out.dropped.gap ?? 0)).toBe(g.n);
        expect(out.dropped.gap ?? 0).toBe(empty.length);
        const kept = Array.from({ length: g.n }, (_, i) => i).filter((i) => !empty.includes(i));
        expect(stored.map((p) => p.ts)).toEqual(kept.map((i) => new Date(T0 + i * HOUR).toISOString()));
        expect(stored.map((p) => [p.value, p.p25, p.p50, p.p75, p.vmin, p.vmax])).toEqual(
          kept.map((i) => [g.p50[i], g.p25[i], g.p50[i], g.p75[i], g.vmin[i], g.vmax[i]]),
        );
        if (stored.length === 0) expect(out.forecasts).toBeUndefined();
        else {
          // The loader's own check leaves it whole, or flags the order of what it was given (never reorders it).
          const r = out.forecasts?.[0] as NonNullable<Normalised['forecasts']>[number];
          const c = checkRun(r, T0 + 3 * HOUR, DECL);
          expect(c.run?.points).toHaveLength(stored.length);
        }
      }),
    );
  });

  it('a damaged figure is normalised or refused with a SchemaDrift, never another error', () => {
    const edit = fc.oneof(
      fc.record({ op: fc.constant('drop'), i: fc.nat(5) }),
      fc.record({
        op: fc.constant('name'),
        i: fc.nat(5),
        name: fc.constantFrom('', 'Median', 'Mediana', ...LAYOUT_DE),
      }),
      fc.record({ op: fc.constant('swap'), i: fc.nat(5), j: fc.nat(5) }),
      fc.record({ op: fc.constant('cut'), i: fc.nat(5), k: fc.nat(9) }),
      fc.record({
        op: fc.constant('unit'),
        i: fc.nat(5),
        unit: fc.constantFrom('', 'm³/s', 'm3/s', 'l/s', 'm ü. M.', 'x'),
      }),
      fc.record({
        op: fc.constant('x'),
        i: fc.nat(5),
        k: fc.nat(9),
        x: fc.constantFrom('', 'soon', '2030-01-01T00:00:00.000Z', '9999-01-01T00:00:00Z'),
      }),
      fc.record({ op: fc.constant('null'), i: fc.nat(5), k: fc.nat(9) }),
    );
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 4 }), (edits) => {
        const traces = figure(5);
        for (const e of edits) {
          const t = traces[e.i] as Trace | undefined;
          if (e.op === 'drop') traces.splice(e.i, 1);
          else if (e.op === 'swap') {
            const a = traces[e.i];
            const b = traces[e.j];
            if (a && b) [traces[e.i], traces[e.j]] = [b, a];
          } else if (t === undefined) continue;
          else if (e.op === 'name') t.name = e.name;
          else if (e.op === 'cut') {
            t.x = t.x.slice(0, e.k);
            t.y = t.y.slice(0, e.k);
          } else if (e.op === 'unit') t.meta.unit = e.unit;
          else if (e.op === 'x') t.x[e.k % Math.max(t.x.length, 1)] = e.x;
          else t.y[e.k % Math.max(t.y.length, 1)] = null;
        }
        try {
          const out = normalise(traces, variant);
          for (const r of out.forecasts ?? []) expect(r.series).toMatch(/^\d{4}\/[QW]$/);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
    );
  });

  it('any variant is either four digits and names the series, or drift', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 8 }), fc.stringMatching(/^\d{1,6}$/)), (v) => {
        if (/^\d{4}$/.test(v)) expect(once(figure(), { variant: v })?.series).toBe(`${v}/Q`);
        else expect(() => normalise(figure(), { variant: v })).toThrow(drift('bad_variant'));
      }),
    );
  });

  it('the parser answers any bytes with traces or a SchemaDrift, never another error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 300 }),
          fc.json().map((j) => Buffer.from(j)),
          fc.json().map((j) => Buffer.from(`{"hoverInfo":1,"plot":{"layout":${j},"data":[${j}]}}`)),
        ),
        (b) => {
          for (const fn of [parseForecast, parseBands, parseAxisLabel])
            try {
              expect(fn(b).length).toBeLessThanOrEqual(MAX_POINTS * 10);
            } catch (err) {
              expect(err).toBeInstanceOf(SchemaDrift);
            }
        },
      ),
    );
  });
});
