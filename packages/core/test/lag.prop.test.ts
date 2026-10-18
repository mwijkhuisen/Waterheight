import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { estimateLag } from '../src/index.ts';
import { follow, PARAMS, prng, walk } from './lag-helpers.ts';

// Property tests of the travel-time lag (invariant 9): a shift is recovered within an hour whatever the signal and
// the lag, a reach's range never leaves the lags tried, and the answer does not depend on a constant added to a
// series or on the unit it is read in.

const N = 168 * 20;

describe('estimateLag properties', () => {
  it('recovers a known lag within one hour', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 3, max: 70 }), (seed, lag) => {
        const rand = prng(seed);
        const up = walk(N, rand);
        const r = estimateLag({
          up,
          down: follow(up, () => lag, rand),
          flow: up,
          lengthKm: 100,
          params: PARAMS,
        });
        expect(r).not.toBeNull();
        expect(r?.h[0]).toBeGreaterThanOrEqual(lag - 1);
        expect(r?.h[1]).toBeLessThanOrEqual(lag + 1);
        expect(r?.h[0]).toBeLessThan(r?.h[1] ?? 0);
      }),
      { numRuns: 25 },
    );
  });

  it('keeps every range inside the lags tried and its windows inside the record', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 120 }), (seed, lag) => {
        const rand = prng(seed);
        const up = walk(N, rand);
        const r = estimateLag({ up, down: follow(up, () => lag, rand), flow: up, lengthKm: 60, params: PARAMS });
        if (r === null) return;
        expect(r.h[0]).toBeGreaterThanOrEqual(PARAMS.min_lag_h);
        expect(r.h[1]).toBeLessThanOrEqual(60);
        expect(r.span[0]).toBeGreaterThanOrEqual(0);
        expect(r.span[1]).toBeLessThanOrEqual(N);
        expect(r.windows).toBeGreaterThanOrEqual(PARAMS.min_windows);
      }),
      { numRuns: 25 },
    );
  });

  it('does not depend on an offset or the scale of either series', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 3, max: 50 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: 1, max: 100 }),
        (seed, lag, offset, scale) => {
          const rand = prng(seed);
          const up = walk(N, rand);
          const down = follow(up, () => lag, rand);
          const base = estimateLag({ up, down, flow: up, lengthKm: 100, params: PARAMS });
          const moved = estimateLag({
            up: up.map((v) => v * scale + offset),
            down: down.map((v) => v / scale - offset),
            flow: up,
            lengthKm: 100,
            params: PARAMS,
          });
          expect(moved?.h).toEqual(base?.h);
        },
      ),
      { numRuns: 15 },
    );
  });
});
