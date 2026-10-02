import { describe, expect, it } from 'vitest';
import { judgeTwin } from '../../src/load/twins.ts';

// The pure twin judgement (A§7.4 step 7): a − b against the relation, and the lag of b against a.

const T0 = Date.parse('2026-10-01T00:00:00Z');
/** A varying signal at 15-minute steps (a river rising and falling), so a wrong shift disagrees. */
const signal = (n: number, shiftMin = 0, add = 0) =>
  Array.from({ length: n }, (_, i) => ({
    ts: T0 + i * 900_000 + shiftMin * 60_000,
    value: 200 + 10 * Math.sin(i / 3) + add,
  }));
const relation = { kind: 'offset' as const, expected: 0, tolerance: 0.05 };

describe('judgeTwin', () => {
  it('equal series: ok, lag 0', () => {
    expect(judgeTwin(signal(96), signal(96), relation)).toMatchObject({
      n_aligned: 96,
      lag_min: 0,
      ok: true,
      max_delta: 0,
    });
  });

  it('b stating each value 15 minutes later: the lag is found (a(t) = b(t + 15)), not ok', () => {
    const out = judgeTwin(signal(96), signal(96, 15), relation);
    expect(out).toMatchObject({ lag_min: 15, ok: false });
  });

  it('a constant bias fails the relation at every shift: not ok, and no lag is invented', () => {
    const out = judgeTwin(signal(96), signal(96, 0, 2), relation);
    expect(out).toMatchObject({ n_aligned: 96, lag_min: 0, ok: false, median_delta: -2 });
  });

  it('no aligned point: n_aligned 0, no deltas, no lag, not ok (no data is never ok)', () => {
    expect(judgeTwin(signal(10), signal(10, 7), relation)).toEqual({
      n_aligned: 0,
      median_delta: null,
      max_delta: null,
      lag_min: null,
      ok: false,
    });
  });

  it('min_share lets a few disagreeing points pass, never a lag', () => {
    const b = signal(100);
    (b[3] as { value: number }).value += 5;
    expect(judgeTwin(signal(100), b, relation).ok).toBe(false);
    expect(judgeTwin(signal(100), b, { ...relation, min_share: 0.99 })).toMatchObject({ ok: true, lag_min: 0 });
  });
});
