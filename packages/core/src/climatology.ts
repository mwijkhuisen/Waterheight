import type { ClimatologyConfig } from '@rws/contracts';

// Our own day-of-year (DOY) climatology of one series (P14f, plan §3.2; issue #29): the P10, P50 and P90 of the
// daily means in a window of ± window_days around each day of the year, pooled over the complete UTC years of the
// series' history. Pure: the climatology command reads the daily means through the family's views and stores
// P10_DOY and P90_DOY (registry/climatology.yaml holds the parameters). UTC throughout: a day is a UTC day and a day
// key is a UTC month and day, never a local zone (invariant 4).

export type DoyParams = Pick<ClimatologyConfig, 'min_years' | 'window_days' | 'min_day_hours' | 'min_year_share'>;
/** One UTC day of a series: the mean of its hourly means and how many of its 24 hours had a sample. */
export type DailyMean = { date: string /* YYYY-MM-DD, UTC */; mean: number; hours: number };
/** md = MMDD as an integer (101 … 1231), never 229. */
export type DoyRow = { md: number; p10: number; p50: number; p90: number };
export type DoySet = {
  period: readonly [number, number]; // first and last complete UTC year used
  years: number; // complete years used (>= min_years)
  rows: readonly DoyRow[]; // ascending md; a key with p10 >= p90 has no row
  basisLabel: string; // "DOY P10-P90, 1991-2000, 31 d/yr" (window = 2 × window_days + 1)
};

const DAY_MS = 86_400_000;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** The UTC day number (days since 1970-01-01) of a YYYY-MM-DD date; a malformed or impossible date throws. */
function dayNumber(date: string): number {
  const m = DATE.exec(date);
  if (m === null) throw new RangeError('climatology: bad date');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new RangeError('climatology: bad date');
  }
  return ms / DAY_MS;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Hyndman and Fan type 7 (linear between order statistics, R's default) of an ascending, non-empty array. */
function quantile7(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = sorted[lo] as number;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] as number;
  return a + (h - lo) * (b - a);
}

/** MMDD of an instant in UTC; 29 Feb → 228 (the 0228 key serves the leap day: 365 keys, plan §1b). */
export function utcMonthDay(t: number): number {
  const d = new Date(t);
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return md === 229 ? 228 : md;
}

/**
 * The DOY set of one series' daily means, or null when the series is not eligible (fewer than `min_years` complete
 * UTC years: never a guess). A complete day has a sample in at least `min_day_hours` hours; a complete year has at
 * least `min_year_share` of its days complete. The pool of a key is, for every complete year, the real dates of
 * that year's key ± `window_days` (a window may reach into the year before or after, and a 29 February inside it
 * counts like any date), each only when that day is complete. The output depends only on the set of days, never on
 * their order; a malformed, impossible or repeated date throws.
 */
export function doyClimatology(days: readonly DailyMean[], p: DoyParams): DoySet | null {
  const complete = new Map<number, number>();
  const seen = new Set<number>();
  for (const d of days) {
    const n = dayNumber(d.date);
    // one row per day (the command groups by UTC day): a second one would make the result depend on the order
    if (seen.has(n)) throw new RangeError('climatology: duplicate date');
    seen.add(n);
    if (d.hours >= p.min_day_hours && Number.isFinite(d.mean)) complete.set(n, d.mean);
  }
  const perYear = new Map<number, number>();
  for (const n of complete.keys()) {
    const y = new Date(n * DAY_MS).getUTCFullYear();
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
  }
  const years = [...perYear]
    .filter(([y, count]) => count >= p.min_year_share * (isLeap(y) ? 366 : 365))
    .map(([y]) => y)
    .sort((a, b) => a - b);
  if (years.length < p.min_years) return null;
  const rows: DoyRow[] = [];
  // The 365 keys of a common year (2001): no 0229 key.
  for (let k = Date.UTC(2001, 0, 1); k < Date.UTC(2002, 0, 1); k += DAY_MS) {
    const key = new Date(k);
    const [month, date] = [key.getUTCMonth(), key.getUTCDate()];
    const pool: number[] = [];
    for (const y of years) {
      const centre = Date.UTC(y, month, date) / DAY_MS;
      for (let off = -p.window_days; off <= p.window_days; off++) {
        const v = complete.get(centre + off);
        if (v !== undefined) pool.push(v);
      }
    }
    if (pool.length === 0) continue;
    pool.sort((a, b) => a - b);
    const [p10, p50, p90] = [quantile7(pool, 0.1), quantile7(pool, 0.5), quantile7(pool, 0.9)];
    // A degenerate key (a constant or almost constant pool) has no normal band: no row, never a guess.
    if (p10 >= p90) continue;
    rows.push({ md: (month + 1) * 100 + date, p10, p50, p90 });
  }
  const first = years[0] as number;
  const last = years[years.length - 1] as number;
  return {
    period: [first, last],
    years: years.length,
    rows,
    basisLabel: `DOY P10-P90, ${first}-${last}, ${2 * p.window_days + 1} d/yr`,
  };
}
