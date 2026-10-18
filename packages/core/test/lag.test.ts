import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changeSignal, estimateLag, type LagInput, type LagParams, maxLag } from '../src/index.ts';
import { follow, PARAMS, prng, walk } from './lag-helpers.ts';

// The empirical travel time (P14f, plan section 3.6): a known shift is recovered, the rules of the window (interior
// lag, 90 % presence, flow classes) hold, and a real pair (Lobith and Zaltbommel, the January 1995 flood) is a golden.

const input = (up: number[], down: number[], over: Partial<LagInput> = {}): LagInput => ({
  up,
  down,
  flow: up,
  lengthKm: 100,
  params: PARAMS,
  ...over,
});

const N = 168 * 30;

describe('maxLag', () => {
  it('is the length in hours, at least 12 and at most the configured maximum', () => {
    expect(maxLag(3, PARAMS)).toBe(12);
    expect(maxLag(40.2, PARAMS)).toBe(41);
    expect(maxLag(500, PARAMS)).toBe(96);
  });
});

describe('changeSignal', () => {
  it('is the first difference of the centred rolling mean, and a gap stays a gap', () => {
    const ramp = Array.from({ length: 30 }, (_, i) => 2 * i);
    const d = changeSignal(ramp, 6);
    // a ramp of slope 2 per hour: every difference is 2 where both means exist
    expect([...d].filter(Number.isFinite).every((v) => Math.abs(v - 2) < 1e-9)).toBe(true);
    const gap = [...ramp];
    gap[15] = Number.NaN;
    const g = changeSignal(gap, 6);
    // the missing hour is in six means, so in seven differences
    expect([...g].filter((v, i) => Number.isNaN(v) && !Number.isNaN(d[i]))).toHaveLength(7);
  });
});

describe('estimateLag', () => {
  it('recovers a known shift', () => {
    const rand = prng(7);
    const up = walk(N, rand);
    const r = estimateLag(
      input(
        up,
        follow(up, () => 17, rand),
      ),
    );
    expect(r).not.toBeNull();
    expect(r?.h[0]).toBeGreaterThanOrEqual(16);
    expect(r?.h[0]).toBeLessThanOrEqual(17);
    expect(r?.h[1]).toBeGreaterThanOrEqual(17);
    expect(r?.h[1]).toBeLessThanOrEqual(18);
    expect(r?.windows).toBeGreaterThanOrEqual(PARAMS.min_windows);
    expect(r?.span[0]).toBe(0);
  });

  it('is deterministic', () => {
    const rand = prng(11);
    const up = walk(N, rand);
    const down = follow(up, () => 9, rand);
    expect(estimateLag(input(up, down))).toEqual(estimateLag(input(up, down)));
  });

  it('throws on series of different lengths', () => {
    expect(() => estimateLag(input([1, 2, 3], [1, 2]))).toThrow(RangeError);
  });

  it('is null for a record shorter than one window, and for noise', () => {
    const rand = prng(3);
    expect(estimateLag(input(walk(100, rand), walk(100, rand)))).toBeNull();
    expect(estimateLag(input(walk(N, rand), walk(N, rand)))).toBeNull();
  });

  it('is null for a lag range with no interior lag', () => {
    const rand = prng(5);
    const up = walk(N, rand);
    expect(
      estimateLag(
        input(
          up,
          follow(up, () => 1, rand),
          { params: { ...PARAMS, min_lag_h: 10, max_lag_h: 11 } },
        ),
      ),
    ).toBeNull();
  });

  describe('the interior rule', () => {
    // 5 km: L = 12 hours
    const short = (lag: number) => {
      const rand = prng(21);
      const up = walk(N, rand);
      return estimateLag(
        input(
          up,
          follow(up, () => lag, rand),
          { lengthKm: 5 },
        ),
      );
    };

    it('refuses a maximum at the longest lag tried', () => {
      expect(short(12)).toBeNull();
      expect(short(11)).not.toBeNull();
    });

    it('refuses a maximum at the shortest lag tried', () => {
      expect(short(1)).toBeNull();
      expect(short(2)).not.toBeNull();
    });

    it('refuses a shift beyond the range, where the best r sits at an end or is low', () => {
      expect(short(30)).toBeNull();
    });
  });

  describe('the presence rule', () => {
    const blank = (x: number[], every: number) => x.map((v, i) => (i % every === every - 1 ? Number.NaN : v));
    const base = () => {
      const rand = prng(33);
      const up = walk(N, rand);
      return { up, down: follow(up, () => 12, rand) };
    };

    it('keeps a window with a few missing hours (one in a hundred is 7 % of the differences)', () => {
      const { up, down } = base();
      expect(estimateLag(input(up, blank(down, 100)))).not.toBeNull();
    });

    it('drops a window with more than 10 % of the differences missing (one hour in forty is 17 %)', () => {
      const { up, down } = base();
      expect(estimateLag(input(up, blank(down, 40)))).toBeNull();
      expect(estimateLag(input(blank(up, 40), down))).toBeNull();
    });

    it('drops a window whose flow is mostly missing', () => {
      const { up, down } = base();
      expect(estimateLag(input(up, down, { flow: blank(up, 5) }))).toBeNull();
    });
  });

  it('sorts windows into terciles of the upstream flow and gives each class its own range', () => {
    const rand = prng(99);
    const third = N / 3;
    const lags = [5, 20, 40];
    const up = walk(N, rand);
    const down = follow(up, (i) => lags[Math.floor(i / third)] as number, rand);
    // flow rises through the record in three steps: low, mid and high weeks
    const flow = up.map((_, i) => 100 + 100 * Math.floor(i / third));
    const r = estimateLag(input(up, down, { flow }));
    expect(r?.classes.low?.[0]).toBeGreaterThanOrEqual(4);
    expect(r?.classes.low?.[1]).toBeLessThanOrEqual(7);
    expect(r?.classes.mid?.[0]).toBeGreaterThanOrEqual(19);
    expect(r?.classes.mid?.[1]).toBeLessThanOrEqual(22);
    expect(r?.classes.high?.[0]).toBeGreaterThanOrEqual(39);
    expect(r?.classes.high?.[1]).toBeLessThanOrEqual(42);
    // the reach's range is the envelope of the three
    expect(r?.h).toEqual([r?.classes.low?.[0], r?.classes.high?.[1]]);
  });

  it('leaves out a class with fewer windows than min_windows, and reports none when no class has enough', () => {
    const rand = prng(41);
    const up = walk(N, rand);
    const down = follow(up, () => 10, rand);
    const few = estimateLag(input(up, down, { params: { ...PARAMS, min_windows: 11 } }));
    expect(few).toBeNull(); // 30 windows, ten a class, none reaches eleven
    const some = estimateLag(input(up, down, { params: { ...PARAMS, min_windows: 10 } }));
    expect(Object.keys(some?.classes ?? {})).toHaveLength(3);
  });

  it('widens a range of one hour by one hour and keeps lo at min_lag_h or above', () => {
    const rand = prng(8);
    const up = walk(N, rand);
    const r = estimateLag(
      input(
        up,
        follow(up, () => 6, rand),
        { params: { ...PARAMS, min_lag_h: 6, max_lag_h: 40 } },
      ),
    );
    // lag 6 is the lower end of this range, so it is refused; the widening is covered by the next case
    expect(r).toBeNull();
    const ok = estimateLag(
      input(
        up,
        follow(up, () => 7, rand),
        { params: { ...PARAMS, min_lag_h: 6, max_lag_h: 40 } },
      ),
    );
    expect(ok?.h[0]).toBeGreaterThanOrEqual(6);
    expect((ok?.h[1] ?? 0) - (ok?.h[0] ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

// The 1995 Rhine flood at Lobith and Zaltbommel, recorded from RWS (NL-1 OphalenWaarnemingen), 20 January to 1 March.
// The two stations are not one reach, so the length is a stated test value and the params are relaxed: 40 days give too
// few windows for the configured min_windows (6) and window_h (336).
const FX = new URL('./fixtures/travel/', import.meta.url);
const GOLDEN_PARAMS: LagParams = {
  window_h: 240,
  step_h: 72,
  smooth_h: 6,
  r_min: 0.5,
  min_windows: 3,
  max_lag_h: 96,
  min_lag_h: 1,
};
const GOLDEN_LENGTH_KM = 100;
const START = Date.UTC(1995, 0, 20);
const HOURS = 41 * 24;

/** Hourly means of an RWS answer (a record in cm); RWS sentinels are huge numbers and are dropped. */
function hourly(name: string): number[] {
  const body = JSON.parse(readFileSync(new URL(name, FX), 'utf8')) as {
    WaarnemingenLijst: { MetingenLijst: { Tijdstip: string; Meetwaarde: { Waarde_Numeriek: number } }[] }[];
  };
  const sum = new Float64Array(HOURS);
  const n = new Float64Array(HOURS);
  for (const w of body.WaarnemingenLijst)
    for (const m of w.MetingenLijst) {
      const v = m.Meetwaarde.Waarde_Numeriek;
      const i = Math.floor((Date.parse(m.Tijdstip) - START) / 3_600_000);
      if (!Number.isFinite(v) || Math.abs(v) > 1e5 || i < 0 || i >= HOURS) continue;
      sum[i] = (sum[i] as number) + v;
      n[i] = (n[i] as number) + 1;
    }
  return Array.from(sum, (s, i) => ((n[i] as number) > 0 ? s / (n[i] as number) : Number.NaN));
}

describe('Lobith to Zaltbommel, January to March 1995 (real RWS data)', () => {
  const up = hourly('nl-1-backfill-lobith-h-19950120.raw');
  const down = hourly('nl-1-backfill-zaltbommel-h-19950120.raw');
  const golden = JSON.parse(readFileSync(new URL('lobith-zaltbommel-1995.golden.json', FX), 'utf8')) as unknown;

  it('has hourly means for all but a day of the 41 days at both ends', () => {
    expect(up.filter(Number.isFinite).length).toBeGreaterThan(HOURS - 48);
    expect(down.filter(Number.isFinite).length).toBeGreaterThan(HOURS - 48);
  });

  it('matches the golden result with the stated relaxed parameters', () => {
    const r = estimateLag({ up, down, flow: up, lengthKm: GOLDEN_LENGTH_KM, params: GOLDEN_PARAMS });
    expect({ params: GOLDEN_PARAMS, length_km: GOLDEN_LENGTH_KM, result: r }).toEqual(golden);
  });

  it('puts the lag where the flood wave travelled (about 15 hours, flat from 10 to 20)', () => {
    const r = estimateLag({ up, down, flow: up, lengthKm: GOLDEN_LENGTH_KM, params: GOLDEN_PARAMS });
    expect(r?.h[0]).toBeGreaterThanOrEqual(8);
    expect(r?.h[1]).toBeLessThanOrEqual(22);
  });

  it('finds nothing with the configured window and min_windows (40 days are too few)', () => {
    const configured: LagParams = { ...GOLDEN_PARAMS, window_h: 336, step_h: 168, min_windows: 6 };
    expect(estimateLag({ up, down, flow: up, lengthKm: GOLDEN_LENGTH_KM, params: configured })).toBeNull();
  });
});
