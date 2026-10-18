import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type DailyMean, type DoyParams, doyClimatology, utcMonthDay } from '../src/index.ts';

// The day-of-year climatology (P14f, plan §3.2): eligibility (N complete UTC years), the ± window pool across year
// ends, leap years, the degenerate key, determinism, an independent reference implementation over generated
// histories, and a real golden: ten years of Hub'Eau daily mean discharge at Uckange (Moselle, FR-2 QmnJ, open
// data). `UPDATE_GOLDEN=1` rewrites the golden file; a change of it is reviewed like code.

const P: DoyParams = { min_years: 10, window_days: 15, min_day_hours: 20, min_year_share: 0.9 };
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Every UTC day of [from, to] (years), with a mean from `f` (day ms → value) and 24 hours. */
function history(from: number, to: number, f: (ms: number) => number, hours = 24): DailyMean[] {
  const out: DailyMean[] = [];
  for (let t = Date.UTC(from, 0, 1); t < Date.UTC(to + 1, 0, 1); t += DAY)
    out.push({ date: iso(t), mean: f(t), hours });
  return out;
}
/** A wavy value with a seasonal cycle and a per-day wobble, so that every key has P10 < P90. */
const wave = (t: number) => 100 + 50 * Math.sin((2 * Math.PI * t) / (365.25 * DAY)) + ((t / DAY) % 7);
const keyOf = <R extends { md: number }>(rows: readonly R[], md: number) => rows.find((r) => r.md === md);

/** Type 7 written out (R's default): for 1..10, P10 1.9, P50 5.5, P90 9.1. */
const q7 = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const f = Math.floor(h);
  return (s[f] as number) + (h - f) * ((s[Math.ceil(h)] as number) - (s[f] as number));
};

/** An independent reference: ISO strings, Date.UTC day overflow for the window, February's length for leap years. */
function reference(days: readonly DailyMean[], p: DoyParams) {
  const complete = new Map<string, number>();
  for (const d of days) if (d.hours >= p.min_day_hours) complete.set(d.date, d.mean);
  const count = new Map<number, number>();
  for (const k of complete.keys()) count.set(Number(k.slice(0, 4)), (count.get(Number(k.slice(0, 4))) ?? 0) + 1);
  const leap = (y: number) => new Date(Date.UTC(y, 1, 29)).getUTCMonth() === 1;
  const years = [...count]
    .filter(([y, c]) => c >= p.min_year_share * (leap(y) ? 366 : 365))
    .map(([y]) => y)
    .sort((a, b) => a - b);
  if (years.length < p.min_years) return null;
  const LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const rows: { md: number; p10: number; p50: number; p90: number }[] = [];
  LEN.forEach((len, m) => {
    for (let d = 1; d <= len; d++) {
      const pool: number[] = [];
      const from = new Set<number>();
      for (const y of years)
        for (let off = -p.window_days; off <= p.window_days; off++) {
          const v = complete.get(iso(Date.UTC(y, m, d + off)));
          if (v !== undefined) {
            pool.push(v);
            from.add(y);
          }
        }
      if (from.size < p.min_years || 2 * pool.length < p.min_years * (2 * p.window_days + 1)) continue;
      const [p10, p50, p90] = [q7(pool, 0.1), q7(pool, 0.5), q7(pool, 0.9)];
      if (p10 < p90) rows.push({ md: (m + 1) * 100 + d, p10, p50, p90 });
    }
  });
  return { years, rows };
}

describe('utcMonthDay', () => {
  it('is the UTC month and day, with 29 February as 0228', () => {
    expect(utcMonthDay(Date.UTC(2024, 1, 29, 12))).toBe(228);
    expect(utcMonthDay(Date.UTC(2024, 1, 28, 12))).toBe(228);
    expect(utcMonthDay(Date.UTC(2024, 2, 1))).toBe(301);
    expect(utcMonthDay(Date.UTC(2026, 0, 1))).toBe(101);
    expect(utcMonthDay(Date.UTC(2026, 11, 31, 23, 59))).toBe(1231);
    // UTC, never Europe/Amsterdam: 23:30Z on 31 December is 00:30 local on 1 January
    expect(utcMonthDay(Date.UTC(2026, 11, 31, 23, 30))).toBe(1231);
    expect(utcMonthDay(Date.UTC(2026, 5, 30, 22, 30))).toBe(630);
  });
});

describe('doyClimatology', () => {
  it('N − 1 complete years give no set, N give a set of 365 keys', () => {
    expect(doyClimatology(history(2001, 2009, wave), P)).toBeNull();
    const set = doyClimatology(history(2001, 2010, wave), P);
    expect(set).not.toBeNull();
    expect(set?.years).toBe(10);
    expect(set?.period).toEqual([2001, 2010]);
    expect(set?.rows).toHaveLength(365);
    expect(set?.rows.map((r) => r.md)).toEqual([...(set?.rows.map((r) => r.md) ?? [])].sort((a, b) => a - b));
    expect(set?.rows.some((r) => r.md === 229)).toBe(false);
    expect(set?.basisLabel).toBe('DOY P10-P90, 2001-2010, 31 d/yr');
    expect(doyClimatology([], P)).toBeNull();
  });

  it('a year short of min_year_share complete days does not count (1900 is a common year, 2000 a leap year)', () => {
    // 0.9 × 365 = 328.5 → 329 days; 0.9 × 366 = 329.4 → 330 days. Each history keeps exactly 329 days of its
    // test year (the rest dropped from the end), with nine full years beside it.
    const cut = (days: DailyMean[], year: number, keep: number) => {
      let n = 0;
      return days.filter((d) => !d.date.startsWith(`${year}-`) || ++n <= keep);
    };
    const c1900 = doyClimatology(cut(history(1896, 1905, wave), 1900, 329), P);
    expect(c1900?.years).toBe(10); // a common year: 329 ≥ 328.5
    expect(doyClimatology(cut(history(1896, 1905, wave), 1900, 328), P)).toBeNull();
    expect(doyClimatology(cut(history(1996, 2005, wave), 2000, 329), P)).toBeNull(); // leap: 329 < 329.4
    expect(doyClimatology(cut(history(1996, 2005, wave), 2000, 330), P)?.years).toBe(10);
  });

  it('a day under min_day_hours is not complete: it neither counts for its year nor enters a pool', () => {
    const base = history(2001, 2010, wave);
    // 19 of 24 hours: the day is dropped; one such day makes no difference to a 365-day year, 40 do
    const thin = base.map((d) => (d.date.startsWith('2005-0') && d.date < '2005-02-10' ? { ...d, hours: 19 } : d));
    expect(doyClimatology(thin, P)).toBeNull();
    expect(doyClimatology(thin, { ...P, min_day_hours: 19 })?.years).toBe(10);
    // an outlier on a day of 19 hours does not reach the pool; on a day of 20 hours it does
    const at0615 = (hours: number, mean?: number) =>
      keyOf(
        doyClimatology(
          base.map((d) => (d.date.slice(5) === '06-15' ? { ...d, mean: mean ?? d.mean, hours } : d)),
          P,
        )?.rows ?? [],
        615,
      );
    expect(at0615(19, 1e6)).toEqual(at0615(19));
    expect(at0615(20, 1e6)).not.toEqual(at0615(20));
    expect(at0615(20)).toEqual(keyOf(doyClimatology(base, P)?.rows ?? [], 615));
  });

  it('pools exactly window_days on each side, across year ends', () => {
    // A single value per day that is its distance from the key: the pool of 0101 holds 0..15 from each side.
    const p = { ...P, min_years: 2 };
    const days = history(2001, 2003, (t) => t / DAY);
    const set = doyClimatology(days, p);
    expect(set?.years).toBe(3);
    // 0101: 2001's window has no 2000 days (16 values), 2002's and 2003's have 31 each
    const pool0101 = [2001, 2002, 2003].flatMap((y) =>
      Array.from({ length: 31 }, (_, i) => Date.UTC(y, 0, 1 + i - 15) / DAY).filter(
        (n) => n >= Date.UTC(2001, 0, 1) / DAY,
      ),
    );
    expect(pool0101).toHaveLength(78);
    expect(keyOf(set?.rows ?? [], 101)).toEqual({
      md: 101,
      p10: q7(pool0101, 0.1),
      p50: q7(pool0101, 0.5),
      p90: q7(pool0101, 0.9),
    });
    // 1231 of 2003 reaches into 2004, which has no data: 16 values that year
    const pool1231 = [2001, 2002, 2003].flatMap((y) =>
      Array.from({ length: 31 }, (_, i) => Date.UTC(y, 11, 31 + i - 15) / DAY).filter(
        (n) => n < Date.UTC(2004, 0, 1) / DAY,
      ),
    );
    expect(pool1231).toHaveLength(78);
    expect(keyOf(set?.rows ?? [], 1231)?.p50).toBe(q7(pool1231, 0.5));
    // one day more or less on either side changes the key
    expect(keyOf(doyClimatology(days, { ...p, window_days: 14 })?.rows ?? [], 101)).not.toEqual(
      keyOf(set?.rows ?? [], 101),
    );
    expect(keyOf(doyClimatology(days, { ...p, window_days: 16 })?.rows ?? [], 101)).not.toEqual(
      keyOf(set?.rows ?? [], 101),
    );
  });

  it('a 29 February inside a window counts like any date, and has no key of its own', () => {
    const days = history(2001, 2012, wave); // 2004 and 2008 and 2012 are leap years
    const spiked = days.map((d) => (d.date.endsWith('-02-29') ? { ...d, mean: 1e6 } : d));
    const a = doyClimatology(days, P);
    const b = doyClimatology(spiked, P);
    expect(a?.rows).toHaveLength(365);
    // within 15 days of 29 February the pool holds the spikes (0214 … 0315); 0213 and 0316 do not reach it
    expect(keyOf(b?.rows ?? [], 301)).not.toEqual(keyOf(a?.rows ?? [], 301));
    for (const md of [213, 316, 101, 1231]) expect(keyOf(b?.rows ?? [], md)).toEqual(keyOf(a?.rows ?? [], md));
    expect(b?.rows.some((r) => r.md === 229)).toBe(false);
  });

  it('a key whose P10 is not below its P90 has no row (a constant series has none at all)', () => {
    const flat = doyClimatology(
      history(2001, 2010, () => 42),
      P,
    );
    expect(flat).not.toBeNull();
    expect(flat?.rows).toEqual([]);
    // constant in June only: the June keys far from either month end have no row, the others do
    const june = doyClimatology(
      history(2001, 2010, (t) => (new Date(t).getUTCMonth() === 5 ? 42 : wave(t))),
      P,
    );
    expect(keyOf(june?.rows ?? [], 615)).toBeUndefined();
    expect(keyOf(june?.rows ?? [], 815)).toBeDefined();
  });

  it('a key whose pool is thin or from too few years has no row (a gauge out in the same weeks every year)', () => {
    // March missing in every year (334 of 365 days: still a complete year). 0316's window is March alone (no day),
    // 0310 reaches six or seven February days a year (60 < 155), 0220 holds 24 a year (240): a row.
    const noMarch = history(2001, 2010, wave).filter((d) => d.date.slice(5, 7) !== '03');
    const set = doyClimatology(noMarch, P);
    expect(set?.years).toBe(10);
    for (const md of [305, 310, 316, 325]) expect(keyOf(set?.rows ?? [], md), String(md)).toBeUndefined();
    for (const md of [101, 210, 220, 415, 1231]) expect(keyOf(set?.rows ?? [], md), String(md)).toBeDefined();
    // August missing in three of twelve years: 0816's window is August alone, so its pool is 9 × 31 = 279 days
    // (over 155), but from nine years
    const twelve = history(2001, 2012, wave).filter((d) => !(d.date.slice(5, 7) === '08' && d.date < '2004'));
    const t = doyClimatology(twelve, P);
    expect(t?.years).toBe(12);
    expect(keyOf(t?.rows ?? [], 816)).toBeUndefined();
    expect(keyOf(t?.rows ?? [], 615)).toBeDefined();
    expect(keyOf(doyClimatology(twelve, { ...P, min_years: 9 })?.rows ?? [], 816)).toBeDefined();
  });

  it('type 7 on the pool: 1 … 10 give P10 1.9, P50 5.5, P90 9.1', () => {
    // ten years, 0 on every day but 15 June, which is the year's number 1 … 10; with no window (0 days, below the
    // registry's minimum of 1, to isolate the percentile) the pool of 0615 is exactly 1 … 10, every other key is
    // all zeros and has no row
    const days = Array.from({ length: 10 }, (_, i) =>
      history(2001 + i, 2001 + i, (t) => (iso(t).endsWith('06-15') ? i + 1 : 0)),
    ).flat();
    const set = doyClimatology(days, { ...P, window_days: 0 });
    expect(set?.rows).toHaveLength(1);
    const row = keyOf(set?.rows ?? [], 615);
    expect(row?.p10).toBeCloseTo(1.9, 12);
    expect(row?.p50).toBe(5.5);
    expect(row?.p90).toBeCloseTo(9.1, 12);
    expect(set?.basisLabel).toBe('DOY P10-P90, 2001-2010, 1 d/yr');
  });

  it('refuses a malformed, impossible or repeated date', () => {
    for (const date of ['2001-1-01', '2001-02-30', '2001-13-01', '', '2001-01-01T00:00Z'])
      expect(() => doyClimatology([{ date, mean: 1, hours: 24 }], P), date).toThrow(RangeError);
    // a day twice (even an incomplete copy) would make the result depend on the order
    const twice = [...history(2001, 2010, wave), { date: '2005-06-15', mean: 1, hours: 3 }];
    expect(() => doyClimatology(twice, P)).toThrow('duplicate date');
  });

  it('skips a non-finite mean', () => {
    const days = history(2001, 2010, wave);
    const nan = days.map((d) => (d.date.slice(5) === '06-15' ? { ...d, mean: Number.NaN } : d));
    expect(doyClimatology(nan, P)?.rows.every((r) => Number.isFinite(r.p10) && Number.isFinite(r.p90))).toBe(true);
  });
});

// --- properties ------------------------------------------------------------------------------------------------

const historyArb = fc
  .record({
    start: fc.integer({ min: 1895, max: 2030 }),
    years: fc.integer({ min: 1, max: 3 }),
    params: fc.record({
      min_years: fc.integer({ min: 1, max: 3 }),
      window_days: fc.integer({ min: 1, max: 20 }),
      min_day_hours: fc.integer({ min: 18, max: 24 }),
      min_year_share: fc.constantFrom(0.5, 0.9, 1),
    }),
    seed: fc.array(fc.tuple(fc.integer({ min: 15, max: 24 }), fc.integer({ min: -50, max: 50 })), {
      minLength: 1,
      maxLength: 50,
    }),
  })
  .map(({ start, years, params, seed }) => {
    const days: DailyMean[] = [];
    let i = 0;
    for (let t = Date.UTC(start, 0, 1); t < Date.UTC(start + years, 0, 1); t += DAY, i++) {
      const [hours, mean] = seed[(i * 7 + Math.floor(i / seed.length)) % seed.length] as [number, number];
      days.push({ date: iso(t), mean: mean + (i % 3) / 4, hours });
    }
    return { days, params };
  });

describe('doyClimatology properties', () => {
  it('equals an independent reference implementation', () => {
    fc.assert(
      fc.property(historyArb, ({ days, params }) => {
        const got = doyClimatology(days, params);
        const want = reference(days, params);
        if (want === null) return got === null;
        expect(got?.period).toEqual([want.years[0], want.years[want.years.length - 1]]);
        expect(got?.years).toBe(want.years.length);
        expect(got?.rows).toEqual(want.rows);
        return true;
      }),
      { numRuns: 60 },
    );
  });

  it('p10 < p90 and p10 <= p50 <= p90 on every row, 365 keys at most, never 0229', () => {
    fc.assert(
      fc.property(historyArb, ({ days, params }) => {
        const set = doyClimatology(days, params);
        if (set === null) return true;
        return (
          set.rows.length <= 365 &&
          set.years >= params.min_years &&
          set.rows.every((r) => r.p10 < r.p90 && r.p10 <= r.p50 && r.p50 <= r.p90 && r.md !== 229)
        );
      }),
      { numRuns: 60 },
    );
  });

  it('is deterministic: the same days in any order give the same bytes', () => {
    fc.assert(
      fc.property(historyArb, fc.integer(), ({ days, params }, k) => {
        const shuffled = [...days].sort((a, b) => ((a.date.charCodeAt(9) * k) % 7) - ((b.date.charCodeAt(9) * k) % 7));
        return JSON.stringify(doyClimatology(days, params)) === JSON.stringify(doyClimatology(shuffled, params));
      }),
      { numRuns: 40 },
    );
  });
});

// --- the real golden ---------------------------------------------------------------------------------------------

const FX = new URL('./fixtures/climatology/', import.meta.url);
const GOLDEN = new URL('uckange-qmnj-1991-2000.golden.json', FX);
/** The golden's day keys: the year ends, the leap day's key and one a month. */
const KEYS = [101, 115, 201, 228, 301, 401, 501, 601, 701, 801, 901, 1001, 1101, 1201, 1231];

describe("the real golden: Uckange (Moselle), Hub'Eau QmnJ 1991–2000", () => {
  const body = JSON.parse(readFileSync(new URL('uckange-qmnj-1991-2000.raw', FX), 'utf8')) as {
    count: number;
    data: { date_obs_elab: string; resultat_obs_elab: number }[];
  };
  // QmnJ is a daily mean in l/s (no adapter: the test reads the two fields itself); m³/s as the canonical unit
  const days: DailyMean[] = body.data.map((d) => ({
    date: d.date_obs_elab,
    mean: d.resultat_obs_elab / 1000,
    hours: 24,
  }));
  const set = doyClimatology(days, P);
  const actual = {
    period: set?.period,
    years: set?.years,
    rows: set?.rows.length,
    basisLabel: set?.basisLabel,
    keys: KEYS.map((md) => keyOf(set?.rows ?? [], md)),
  };
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);

  it('is ten complete years, every day present', () => {
    expect(body.count).toBe(3653);
    expect(days).toHaveLength(3653);
    expect(new Set(days.map((d) => d.date)).size).toBe(3653);
  });

  it('N = 10 gives a set of 365 keys equal to the golden', () => {
    if (!existsSync(GOLDEN)) throw new Error('no golden: run with UPDATE_GOLDEN=1 and review it');
    expect(set?.years).toBe(10);
    expect(set?.rows).toHaveLength(365);
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('N = 11 gives no set', () => {
    expect(doyClimatology(days, { ...P, min_years: 11 })).toBeNull();
  });

  it('winter is wetter than late summer at Uckange (a sanity check on the units and the keys)', () => {
    const jan = keyOf(set?.rows ?? [], 115);
    const sep = keyOf(set?.rows ?? [], 901);
    expect((jan?.p50 ?? 0) > (sep?.p50 ?? 0)).toBe(true);
  });
});
