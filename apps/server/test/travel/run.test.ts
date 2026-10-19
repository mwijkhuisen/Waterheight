import type { CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  type Counts,
  commonSpan,
  coveredSpan,
  type Reach,
  sliceYears,
  travelPairs,
  type Years,
} from '../../src/travel/run.ts';
import { fakeDb } from '../api/fake-db.ts';

// P14f review R1-1 and S1: the travel-times read keeps one reach in memory, trimmed to the hours both ends cover,
// and a series-year whose query hits the statement timeout (57014) is left empty and counted, not fatal. The pure
// span helpers on hand-made years; the read on a Kysely without a database.

const H = 3_600_000;
const O = Date.UTC(2024, 0, 1); // the origin: 2024 is a leap year (8,784 hours)
const yearOf = (year: number, values: Record<number, number>): Float64Array => {
  const a = new Float64Array((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / H).fill(Number.NaN);
  for (const [i, v] of Object.entries(values)) a[Number(i)] = v;
  return a;
};

describe('coveredSpan, sliceYears and commonSpan', () => {
  const up: Years = new Map([
    [2024, yearOf(2024, { 10: 1, 8783: 2 })],
    [2025, yearOf(2025, { 0: 3, 50: 8, 99: 4 })],
  ]);
  const down: Years = new Map([[2025, yearOf(2025, { 0: 5, 50: 6, 200: 7 })]]);

  it('the span runs from the first to one past the last hour with a value, on the origin index', () => {
    expect(coveredSpan(up, O)).toEqual([10, 8784 + 100]);
    expect(coveredSpan(down, O)).toEqual([8784, 8784 + 201]);
    expect(coveredSpan(new Map(), O)).toBeNull();
    expect(coveredSpan(new Map([[2024, yearOf(2024, {})]]), O)).toBeNull();
  });

  it('slices across a year end and leaves NaN where nothing is stated', () => {
    const s = sliceYears(up, O, [8783, 8786]);
    expect([...s]).toEqual([2, 3, Number.NaN]);
    // a span that reaches past every year
    expect([...sliceYears(down, O, [8784 + 199, 8784 + 202])]).toEqual([Number.NaN, 7, Number.NaN]);
  });

  it('trims both ends to the hours both cover, and refuses fewer shared hours than the minimum', () => {
    // up covers [10, 8884), down [8784, 8985): the common span is [8784, 8884), and two of its hours (8784 and
    // 8834) have a value at both ends
    const c = commonSpan(up, down, O, 2);
    expect(c?.span).toEqual([8784, 8784 + 100]);
    expect(c?.up).toHaveLength(100);
    expect(c?.down).toHaveLength(100);
    expect([c?.up[0], c?.down[0], c?.up[50], c?.down[50], c?.up[99], c?.down[99]]).toEqual([3, 5, 8, 6, 4, Number.NaN]);
    expect(commonSpan(up, down, O, 3)).toBeNull();
    // a span long enough but with fewer shared hours than the minimum
    expect(commonSpan(up, new Map([[2025, yearOf(2025, { 0: 5, 98: 6 })]]), O, 2)).toBeNull();
    // a common span shorter than the minimum is refused before anything is sliced
    expect(commonSpan(up, down, O, 101)).toBeNull();
    // no overlap at all, or one end empty
    expect(commonSpan(new Map([[2024, yearOf(2024, { 0: 1, 9: 1 })]]), down, O, 1)).toBeNull();
    expect(commonSpan(up, new Map(), O, 1)).toBeNull();
  });
});

describe('travelPairs on a fake database', () => {
  const params = {
    window_h: 336,
    step_h: 168,
    smooth_h: 6,
    r_min: 0.5,
    min_windows: 6,
    max_lag_h: 96,
    min_lag_h: 1,
  };
  const reach: Reach & { up_station: string; down_station: string } = {
    id: 'alpha.1',
    river: 'alpha',
    seq: 1,
    up_station: 'a',
    down_station: 'b',
    length_km: 30,
    flags: { tidal: false, impounded: false, bifurcation: false },
    travel_time_h: null,
    travel_time_source: null,
  } as Reach & { up_station: string; down_station: string };
  // 2025: a deterministic walk at A, B the same 7 hours later
  const start = Date.UTC(2025, 0, 1);
  const n = 8760;
  const walk: number[] = [];
  let x = 300;
  let seed = 2026;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; // a fixed LCG: the same walk every run
    x += seed / 2_147_483_648 - 0.5;
    walk.push(x);
  }
  const rowsOf = (series: number) =>
    Array.from({ length: n }, (_, i) => ({
      h: String((start + i * H) / 1000),
      v: series === 1 ? (walk[i] as number) : (walk[Math.max(0, i - 7)] as number),
    }));
  const counts = (): Counts => ({
    reaches: 1,
    eligible: 1,
    no_series: 0,
    no_common: 0,
    short: 0,
    queries: 0,
    timeouts: 0,
  });
  /** Answers the station query, and each series-year: 2025 with the walk, `fail` with that error, else empty. */
  const db = (fail: { series: number; year: number; code: string }) =>
    fakeDb(async (q: CompiledQuery) => {
      if (q.sql.includes('station_id = ANY'))
        return {
          rows: [
            { id: 1, station_id: 'a', quantity: 'H' },
            { id: 2, station_id: 'b', quantity: 'H' },
          ],
        };
      const [series, lo] = q.parameters as [number, string];
      const year = new Date(lo).getUTCFullYear();
      if (series === fail.series && year === fail.year) throw Object.assign(new Error('x'), { code: fail.code });
      return { rows: year === 2025 ? rowsOf(series) : [] };
    });

  it('a series-year that times out (57014) is empty and counted; the reach is still estimated', async () => {
    const c = counts();
    const pairs = await travelPairs(
      db({ series: 2, year: 2024, code: '57014' }),
      [reach],
      params,
      { from: 2024, to: 2026 },
      c,
    );
    expect(c.timeouts).toBe(1);
    expect(c.queries).toBe(6);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.h[0]).toBeLessThanOrEqual(7);
    expect(pairs[0]?.h[1]).toBeGreaterThanOrEqual(7);
    expect(pairs[0]?.years).toEqual([2025, 2025]);
  });

  it('any other error ends the run', async () => {
    await expect(
      travelPairs(db({ series: 2, year: 2024, code: '42501' }), [reach], params, { from: 2024, to: 2026 }, counts()),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a reach whose ends share too few hours is counted and not estimated; an empty upstream end reads no downstream', async () => {
    const c = counts();
    const short = { ...params, min_windows: 27 }; // 27 × 336 = 9,072 hours > one year
    expect(
      await travelPairs(db({ series: 0, year: 0, code: '' }), [reach], short, { from: 2025, to: 2025 }, c),
    ).toEqual([]);
    expect(c).toMatchObject({ short: 1, queries: 2 });
    const empty = counts();
    expect(
      await travelPairs(db({ series: 0, year: 0, code: '' }), [reach], params, { from: 2026, to: 2026 }, empty),
    ).toEqual([]);
    expect(empty).toMatchObject({ short: 1, queries: 1 });
  });
});
