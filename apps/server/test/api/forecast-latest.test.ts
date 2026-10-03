import { readFileSync } from 'node:fs';
import { FORECAST_FLAG_BITS, ForecastLatest, OwnerForecastLatest } from '@rws/contracts';
import { FORECAST_FLAGS } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AGENCY, buildForecastLatest, lu3Limits, type PointRow, type RunRow } from '../../src/api/forecast-latest.ts';

// The pure builder of forecast/latest.json on hand-made rows (the database read has its own integration test): the
// columnar shape, C4 (a superseded DE-2 run is "no forecast", never the held run), the LU-3 display limit, the
// below-floor nulling, the estimate flags and the contract. The values are made up (no provider data).

const H = 3_600_000;
const T = (s: string) => Date.parse(s);
const FLAGS = FORECAST_FLAGS;

let n = 0;
const run = (o: Partial<RunRow> & { firstValid: number; lastValid: number }): RunRow => ({
  id: String(++n),
  series: 1,
  station: 'nl.rws.test',
  source: 'NL-1',
  issued: null,
  issuedInferred: true,
  fetched: o.firstValid + 5 * 60_000,
  kind: 'deterministic',
  stepS: 600,
  segmentEnd: null,
  ...o,
});
/** Points every `stepMs` from the run's first valid time to its last; `at` makes the other columns. */
const points = (
  r: RunRow,
  stepMs: number,
  at: (i: number) => Partial<PointRow> = () => ({}),
  to = r.lastValid,
): PointRow[] => {
  const out: PointRow[] = [];
  for (let ts = r.firstValid, i = 0; ts <= to; ts += stepMs, i++) {
    out.push({ run: r.id, ts, value: 100 + i, p10: null, p30: null, p70: null, p90: null, flags: 0, ...at(i) });
  }
  return out;
};
const build = (
  runs: RunRow[],
  pts: PointRow[],
  now: string,
  rest: { ruhrortCm?: number | null; limitsH?: Map<string, number> } = {},
) =>
  buildForecastLatest(
    { runs, points: pts },
    {
      now: T(now),
      ruhrortCm: rest.ruhrortCm ?? null,
      ...(rest.limitsH === undefined ? {} : { limitsH: rest.limitsH }),
    },
  );

describe('buildForecastLatest: shape', () => {
  it('writes one run in columns: ordered times, one entry per column, values cut at now + 48 h, no band for a point forecast', () => {
    const r = run({ firstValid: T('2026-10-03T05:20:00Z'), lastValid: T('2026-10-05T05:00:00Z') });
    const doc = build([r], points(r, 600_000), '2026-10-03T12:00:00Z');
    expect(ForecastLatest.safeParse(doc).success).toBe(true);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.now).toBe('2026-10-03T12:00:00.000Z');
    expect(doc.runs).toHaveLength(1);
    const [x] = doc.runs;
    expect(x).toMatchObject({
      series: 1,
      source: 'NL-1',
      agency: 'RWS',
      issuedAt: '2026-10-03T05:25:00.000Z',
      issuedInferred: true,
      fetchedAt: '2026-10-03T05:25:00.000Z',
      providerSegmentEnd: null,
      kind: 'deterministic',
      stepSeconds: 600,
      band: null,
    });
    expect(x?.validTs[0]).toBe('2026-10-03T05:20:00.000Z');
    // the run ends (05:00Z on the 5th) before now + 48 h (12:00Z on the 5th): all of it is shown
    expect(x?.validTs.at(-1)).toBe('2026-10-05T05:00:00.000Z');
    expect(x?.value).toHaveLength(x?.validTs.length ?? -1);
    expect(x?.flags).toHaveLength(x?.validTs.length ?? -1);
    // an earlier now cuts the run at now + 48 h
    const cut = build([r], points(r, 600_000), '2026-10-03T04:00:00Z').runs[0];
    expect(cut?.validTs.at(-1)).toBe('2026-10-05T04:00:00.000Z');
  });

  it('takes the stated issue time over the fetch time, and an unstated one is inferred', () => {
    const r = run({
      firstValid: T('2026-10-03T05:00:00Z'),
      lastValid: T('2026-10-04T05:00:00Z'),
      issued: T('2026-10-03T05:00:00Z'),
      issuedInferred: false,
      fetched: T('2026-10-03T05:12:00Z'),
    });
    const stated = build([r], points(r, 3_600_000), '2026-10-03T12:00:00Z').runs[0];
    expect(stated).toMatchObject({
      issuedAt: '2026-10-03T05:00:00.000Z',
      issuedInferred: false,
      fetchedAt: '2026-10-03T05:12:00.000Z',
    });
    const unstated = build(
      [{ ...r, issued: null, issuedInferred: false }],
      points(r, 3_600_000),
      '2026-10-03T12:00:00Z',
    ).runs[0];
    expect(unstated).toMatchObject({ issuedAt: '2026-10-03T05:12:00.000Z', issuedInferred: true });
  });

  it('orders runs by series then source, sorts points by time, and leaves out a run with no points', () => {
    const a = run({ series: 7, firstValid: T('2026-10-03T10:00:00Z'), lastValid: T('2026-10-03T14:00:00Z') });
    const b = run({
      series: 3,
      source: 'DE-2',
      firstValid: T('2026-10-03T07:00:00Z'),
      lastValid: T('2026-10-05T07:00:00Z'),
      issued: T('2026-10-03T05:00:00Z'),
    });
    const c = run({
      series: 3,
      source: 'CH-4',
      firstValid: T('2026-10-03T10:00:00Z'),
      lastValid: T('2026-10-03T14:00:00Z'),
    });
    const empty = run({ series: 1, firstValid: T('2026-10-03T10:00:00Z'), lastValid: T('2026-10-03T14:00:00Z') });
    const pts = [...points(a, 3_600_000), ...points(c, 3_600_000), ...points(b, 7_200_000)].reverse();
    // 2026-10-03 is a holiday (Saturday) and the run is from the same day: nothing is due yet, so DE-2 is current
    const doc = build([a, b, c, empty], pts, '2026-10-03T12:00:00Z');
    expect(doc.runs.map((x) => [x.series, x.source])).toEqual([
      [3, 'CH-4'],
      [3, 'DE-2'],
      [7, 'NL-1'],
    ]);
    for (const x of doc.runs) expect(x.validTs).toEqual([...x.validTs].sort());
    expect(ForecastLatest.safeParse(doc).success).toBe(true);
  });

  it('names an agency of ours for each forecast source and falls back to the source id', () => {
    expect(AGENCY['NL-1']).toBe('RWS');
    expect(AGENCY['DE-2']).toBe('BfG');
    expect(AGENCY['LU-3']).toBe('AGE');
    const r = run({ source: 'CH-9', firstValid: T('2026-10-03T10:00:00Z'), lastValid: T('2026-10-03T14:00:00Z') });
    expect(build([r], points(r, 3_600_000), '2026-10-03T12:00:00Z').runs[0]?.agency).toBe('CH-9');
  });
});

describe('buildForecastLatest: C4, a superseded DE-2 run is no forecast', () => {
  // A run initialised Friday 2026-10-02 07:00 local (05:00Z): 49 points two hours apart to Tuesday 05:00Z. The
  // 2026-10-03 holiday falls on a Saturday; Monday the 5th is due by 12:00 local (10:00Z).
  const issued = T('2026-10-02T05:00:00Z');
  const de2 = () =>
    run({
      source: 'DE-2',
      series: 5,
      firstValid: issued,
      lastValid: issued + 96 * H,
      issued,
      issuedInferred: false,
      fetched: T('2026-10-02T05:12:00Z'),
      stepS: 7200,
      segmentEnd: issued + 48 * H,
    });
  const drop = (now: string, ruhrortCm: number | null) => {
    const r = de2();
    return build([r], points(r, 2 * H), now, { ruhrortCm }).runs;
  };

  it('keeps the run while no due day has passed its deadline, whatever the weekend', () => {
    expect(drop('2026-10-05T09:59:00Z', null)).toHaveLength(1);
    // Ruhrort above 4 m: weekends and holidays are not due
    expect(drop('2026-10-05T09:59:00Z', 450)).toHaveLength(1);
  });

  it('drops the whole run once Monday 12:00 local has passed without a newer one', () => {
    expect(drop('2026-10-05T10:00:00Z', null)).toEqual([]);
    expect(drop('2026-10-05T10:00:00Z', 450)).toEqual([]);
  });

  it('drops it earlier, over the weekend, while Ruhrort is below 4 m', () => {
    expect(drop('2026-10-03T10:00:00Z', 350)).toEqual([]);
    expect(drop('2026-10-03T10:00:00Z', 450)).toHaveLength(1);
    // an unknown Ruhrort stage is silence, not a false drop
    expect(drop('2026-10-03T10:00:00Z', null)).toHaveLength(1);
  });

  it('applies to DE-2 only: another source with an old run is shown while it reaches now', () => {
    const r = run({ source: 'NL-1', firstValid: issued, lastValid: issued + 96 * H, issued });
    expect(build([r], points(r, 2 * H), '2026-10-05T11:00:00Z').runs).toHaveLength(1);
  });

  it('keeps the estimate flags and the provider segment end of a DE-2 run that is shown', () => {
    const r = de2();
    const pts = points(r, 2 * H, (i) => ({ flags: i > 24 ? FLAGS.ESTIMATE : 0 }));
    const x = build([r], pts, '2026-10-03T05:00:00Z').runs[0];
    expect(x?.providerSegmentEnd).toBe('2026-10-04T05:00:00.000Z');
    expect(x?.stepSeconds).toBe(7200);
    expect(x?.flags.filter((f) => f === FLAGS.ESTIMATE).length).toBeGreaterThan(0);
    expect(x?.flags.every((f) => f === 0 || f === FLAGS.ESTIMATE)).toBe(true);
    // the estimate points are the ones after the segment end
    const after = x?.validTs.filter((t) => Date.parse(t) > issued + 48 * H).length;
    expect(x?.flags.filter((f) => f === FLAGS.ESTIMATE).length).toBe(after);
  });
});

describe('buildForecastLatest: the LU-3 display limit and the band', () => {
  const first = T('2026-10-03T08:00:00Z');
  const lu3 = (station: string) =>
    run({
      source: 'LU-3',
      station,
      series: 11,
      kind: 'quantiles',
      firstValid: first,
      lastValid: first + 45 * H,
      stepS: 3600,
    });
  const band = (i: number) => ({ p10: 90 + i, p30: 95 + i, p70: 105 + i, p90: 110 + i });
  const now = '2026-10-03T10:00:00Z';

  it('cuts values after first_valid + limit_h: 24 h keeps 25 hourly points, 48 h keeps all 46, no limit none cut', () => {
    const limits = new Map([
      ['lu.age.cut', 24],
      ['lu.age.wide', 48],
    ]);
    for (const [station, expected] of [
      ['lu.age.cut', 25],
      ['lu.age.wide', 46],
      ['lu.age.free', 46],
    ] as const) {
      const r = lu3(station);
      const x = build([r], points(r, H, band), now, { limitsH: limits }).runs[0];
      expect(x?.validTs, station).toHaveLength(expected);
      expect(x?.validTs.at(-1), station).toBe(new Date(first + (expected - 1) * H).toISOString());
    }
  });

  it('applies the limit to LU-3 runs only, even on a station of the same id', () => {
    const r = run({ source: 'NL-1', station: 'lu.age.cut', firstValid: first, lastValid: first + 45 * H });
    const x = build([r], points(r, H), now, { limitsH: new Map([['lu.age.cut', 24]]) }).runs[0];
    expect(x?.validTs).toHaveLength(46);
  });

  it('writes the quantile band and keeps p30 and p70 only where they exist', () => {
    const r = lu3('lu.age.free');
    const x = build([r], points(r, H, band), now).runs[0];
    expect(x?.band?.p10?.[0]).toBe(90);
    expect(x?.band?.p90?.[2]).toBe(112);
    expect(x?.band?.p30?.[1]).toBe(96);
    expect(x?.band?.p70?.[1]).toBe(106);
    const thin = build(
      [r],
      points(r, H, (i) => ({ p10: 90 + i, p90: 110 + i })),
      now,
    ).runs[0];
    expect(thin?.band).toMatchObject({ p30: null, p70: null });
    expect(thin?.band?.p10).toHaveLength(thin?.validTs.length ?? -1);
    expect(ForecastLatest.safeParse(build([r], points(r, H, band), now)).success).toBe(true);
  });
});

describe('buildForecastLatest: below the forecastable range', () => {
  it('turns every number of a below_floor point to null and keeps its flags (order and estimate bits too)', () => {
    const first = T('2026-10-03T08:00:00Z');
    const r = run({
      source: 'LU-3',
      station: 'lu.age.free',
      series: 11,
      kind: 'quantiles',
      firstValid: first,
      lastValid: first + 5 * H,
      stepS: 3600,
    });
    const pts = points(r, H, (i) => ({
      p10: 90 + i,
      p30: 95 + i,
      p70: 105 + i,
      p90: 110 + i,
      flags: i === 2 ? FLAGS.BELOW_FLOOR : i === 3 ? FLAGS.BELOW_FLOOR | FLAGS.ORDER : i === 4 ? FLAGS.ORDER : 0,
    }));
    const doc = build([r], pts, '2026-10-03T10:00:00Z');
    expect(ForecastLatest.safeParse(doc).success).toBe(true);
    const x = doc.runs[0];
    expect(x?.flags).toEqual([0, 0, 1024, 1040, 16, 0]);
    for (const i of [2, 3]) {
      expect(x?.value[i]).toBeNull();
      expect(x?.band?.p10[i]).toBeNull();
      expect(x?.band?.p90[i]).toBeNull();
      expect(x?.band?.p30?.[i]).toBeNull();
      expect(x?.band?.p70?.[i]).toBeNull();
    }
    // the neighbours (an order flag is not a floor) keep their numbers
    expect(x?.value[1]).toBe(101);
    expect(x?.value[4]).toBe(104);
    expect(x?.band?.p90[4]).toBe(114);
  });

  it('drops the band altogether when every band number is null, and the contract refuses a number under the flag', () => {
    const first = T('2026-10-03T08:00:00Z');
    const r = run({
      source: 'LU-3',
      station: 'lu.age.free',
      series: 11,
      kind: 'quantiles',
      firstValid: first,
      lastValid: first + 2 * H,
      stepS: 3600,
    });
    const pts = points(r, H, (i) => ({ p10: 90 + i, p90: 110 + i, flags: FLAGS.BELOW_FLOOR }));
    const doc = build([r], pts, '2026-10-03T10:00:00Z');
    expect(doc.runs[0]?.band).toBeNull();
    expect(doc.runs[0]?.value).toEqual([null, null, null]);
    const bad = structuredClone(doc);
    (bad.runs[0] as { value: (number | null)[] }).value[1] = 4;
    expect(ForecastLatest.safeParse(bad).success).toBe(false);
  });
});

describe('the ForecastLatest contract', () => {
  const r = run({ firstValid: T('2026-10-03T10:00:00Z'), lastValid: T('2026-10-03T12:00:00Z') });
  const good = () => structuredClone(build([r], points(r, 3_600_000), '2026-10-03T11:00:00Z'));

  it('is strict, bounded and column-aligned', () => {
    expect(ForecastLatest.safeParse(good()).success).toBe(true);
    const extra = { ...good(), extra: 1 };
    expect(ForecastLatest.safeParse(extra).success).toBe(false);
    const short = good();
    (short.runs[0] as { flags: number[] }).flags.pop();
    expect(ForecastLatest.safeParse(short).success).toBe(false);
    const unordered = good();
    (unordered.runs[0] as { validTs: string[] }).validTs.reverse();
    expect(ForecastLatest.safeParse(unordered).success).toBe(false);
    const flag = good();
    (flag.runs[0] as { flags: number[] }).flags[0] = 2;
    expect(ForecastLatest.safeParse(flag).success).toBe(false);
    const canary = good();
    (canary.runs[0] as { source: string }).source = 'CANARY-OWNER';
    expect(ForecastLatest.safeParse(canary).success).toBe(false);
    // only the owner schema takes the canary's source, and nothing but a catalogue id or that one
    expect(OwnerForecastLatest.safeParse(canary).success).toBe(true);
    (canary.runs[0] as { source: string }).source = 'XX-1';
    expect(OwnerForecastLatest.safeParse(canary).success).toBe(false);
  });

  it('names the flag bits the core stores, and imports nothing but zod (the web bundle rule)', () => {
    expect(FORECAST_FLAG_BITS).toEqual({
      order: FLAGS.ORDER,
      censored: FLAGS.CENSORED,
      estimate: FLAGS.ESTIMATE,
      below_floor: FLAGS.BELOW_FLOOR,
    });
    const text = readFileSync(new URL('../../../../packages/contracts/src/forecast.ts', import.meta.url), 'utf8');
    const modules = [...text.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    for (const m of modules) expect(['zod', './units.ts']).toContain(m);
  });
});

describe('lu3Limits', () => {
  it('reads limit_h of the seed defensively: only a positive whole number, keyed by station id', () => {
    for (const [station, hours] of lu3Limits()) {
      expect(station).toMatch(/^lu\.age\.[a-z-]+$/);
      expect(Number.isInteger(hours) && hours > 0 && hours < 1000).toBe(true);
    }
  });
});

describe('buildForecastLatest: property', () => {
  it('always gives aligned columns that the contract accepts', () => {
    const point = fc.record({
      value: fc.option(fc.double({ min: -1000, max: 10_000, noNaN: true }), { nil: null }),
      p10: fc.option(fc.double({ min: -1000, max: 10_000, noNaN: true }), { nil: null }),
      p90: fc.option(fc.double({ min: -1000, max: 10_000, noNaN: true }), { nil: null }),
      flags: fc.constantFrom(0, 16, 128, 256, 1024, 1040),
    });
    fc.assert(
      fc.property(fc.array(point, { minLength: 1, maxLength: 60 }), fc.integer({ min: 0, max: 100 }), (rows, limit) => {
        const first = T('2026-10-03T08:00:00Z');
        const r = run({
          source: 'LU-3',
          station: 'lu.age.p',
          kind: 'quantiles',
          firstValid: first,
          lastValid: first + 80 * H,
          stepS: 3600,
        });
        const pts = rows.map((p, i) => ({ run: r.id, ts: first + i * H, p30: null, p70: null, ...p }));
        const doc = buildForecastLatest(
          { runs: [r], points: pts },
          { now: first + H, ruhrortCm: null, limitsH: new Map([['lu.age.p', limit]]) },
        );
        expect(ForecastLatest.safeParse(doc).success).toBe(true);
        for (const x of doc.runs) expect(x.validTs.length).toBeLessThanOrEqual(Math.min(rows.length, limit + 1));
      }),
      { numRuns: 100 },
    );
  });
});
