import type { LagParams } from '../src/index.ts';

// Shared by lag.test.ts and lag.prop.test.ts: a seeded random walk and its delayed, noisy copy.

export const PARAMS: LagParams = {
  window_h: 168,
  step_h: 168,
  smooth_h: 6,
  r_min: 0.5,
  min_windows: 3,
  max_lag_h: 96,
  min_lag_h: 1,
};

/** mulberry32: a seeded PRNG, so a failing case replays. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random walk (steps of sd about 1) of n hours. */
export function walk(n: number, rand: () => number): number[] {
  const out: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    x += rand() + rand() + rand() - 1.5;
    out.push(x);
  }
  return out;
}

/** `down` is `up` seen `lag(i)` hours later at hour i, plus a little noise. */
export function follow(up: readonly number[], lag: (i: number) => number, rand: () => number, noise = 0.05): number[] {
  return up.map((_, i) => (up[Math.max(0, i - lag(i))] as number) + (rand() - 0.5) * 2 * noise);
}
