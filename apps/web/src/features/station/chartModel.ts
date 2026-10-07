import type { SeriesForecast, StationRecent } from '@rws/contracts';
import { formatLocal } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

// The pure part of the station chart (P10a T6): points and one forecast run with its band (the references are in
// thresholds.ts since P10d). Values arrive in canonical units; `conv` brings one to the native unit the page shows. Nothing here draws.

export type Pt = [number, number | null];
type RecentSeries = StationRecent['series'][number];
type RecentRun = NonNullable<RecentSeries['run']>;
type AsofRun = NonNullable<SeriesForecast['run']>;

const H48 = 48 * 3_600_000;
/** recent.json holds 7 days: a span that starts more than this before its first point asks the API for the gap. */
const GAP_MS = 3_600_000;

/**
 * The span asks the API for the part before recent.json's first point: only when that part is longer than an hour
 * and the series has data from before it (`dataSince`).
 */
export const recentGap = (spanFrom: number, firstRecent: number | undefined, since: number | undefined): boolean =>
  firstRecent !== undefined && since !== undefined && firstRecent - spanFrom > GAP_MS && firstRecent - since > GAP_MS;

/** The chart's time axis: the span, stretched to the end of the run it shows. */
export const xRange = (span: { from: number; to: number }, runEnd: number | undefined) => ({
  min: span.from,
  max: Math.max(span.to, runEnd ?? span.to),
});

/** An instant the axis shows: its vertical line and its legend key exist only then. */
export const onAxis = (at: number, x: { min: number; max: number }): boolean => at >= x.min && at <= x.max;

/** One run in columns, whichever file it came from (recent.json's `run` or `/series/{id}/forecast?asof=`). */
export interface Run {
  source: string;
  agency: string;
  issuedAt: number;
  issuedInferred: boolean;
  providerSegmentEnd: number | null;
  ts: number[];
  value: (number | null)[];
  lo: (number | null)[] | null;
  hi: (number | null)[] | null;
}

export function fromRecentRun(r: RecentRun): Run {
  const b = r.band;
  const [lo, hi] = b === null ? [null, null] : b.kind === 'p10p90' ? [b.p10, b.p90] : [b.p25, b.p75];
  return {
    source: r.source,
    agency: r.agency,
    issuedAt: Date.parse(r.issuedAt),
    issuedInferred: r.issuedInferred,
    providerSegmentEnd: r.providerSegmentEnd === null ? null : Date.parse(r.providerSegmentEnd),
    ts: r.validTs.map((t) => Date.parse(t)),
    value: r.value,
    lo,
    hi,
  };
}

export function fromAsofRun(r: AsofRun): Run {
  const band = r.bandKind !== null;
  return {
    source: r.source,
    agency: r.agency,
    issuedAt: Date.parse(r.issuedAt),
    issuedInferred: r.issuedInferred,
    providerSegmentEnd: r.providerSegmentEnd === null ? null : Date.parse(r.providerSegmentEnd),
    ts: r.points.map((p) => Date.parse(p.ts)),
    value: r.points.map((p) => p.value),
    lo: band ? r.points.map((p) => p.lo) : null,
    hi: band ? r.points.map((p) => p.hi) : null,
  };
}

/** "RWS · issued …" or, when the issue time is our own fetch time, "RWS · fetched …" (C16). */
export const runName = (r: Pick<Run, 'agency' | 'issuedAt' | 'issuedInferred'>, locale: Locale): string =>
  (r.issuedInferred ? m.chart_run_fetched : m.chart_run_issued)(
    { agency: r.agency, time: formatLocal(r.issuedAt, locale) },
    { locale },
  );

export interface ForecastView {
  /** The run's own part, then the estimate part (from `providerSegmentEnd`; both hold the junction point). */
  provider: Pt[];
  estimate: Pt[];
  /** The band as a stack: `lower`, then `spread` = upper − lower (null where either end is). */
  lower: Pt[];
  spread: Pt[];
  hasBand: boolean;
  /** The last instant shown: min(base + 48 h, the run's end). */
  end: number;
}

/**
 * One run as chart data. `base` is now for a t at or after now, else the t of the `asof` run; the run is cut at
 * base + 48 h and never extended (the page never invents a value). A point is kept as null where the run states none.
 */
export function forecastView(run: Run, conv: (v: number) => number, base: number): ForecastView {
  const limit = base + H48;
  const idx = run.ts.flatMap((t, i) => (t <= limit ? [i] : []));
  const at = (col: (number | null)[] | null, i: number): number | null => {
    const v = col?.[i];
    return v === null || v === undefined ? null : conv(v);
  };
  const median: Pt[] = idx.map((i) => [run.ts[i] as number, at(run.value, i)]);
  const cut = run.providerSegmentEnd;
  const provider = cut === null ? median : median.filter(([t]) => t <= cut);
  const estimate = cut === null ? [] : median.filter(([t]) => t >= cut);
  const hasBand = run.lo !== null && run.hi !== null;
  const lower: Pt[] = idx.map((i) => [run.ts[i] as number, at(run.lo, i)]);
  const spread: Pt[] = idx.map((i, k) => {
    const lo = (lower[k] as Pt)[1];
    const hi = at(run.hi, i);
    return [run.ts[i] as number, lo === null || hi === null ? null : hi - lo];
  });
  return { provider, estimate, lower, spread, hasBand, end: median[median.length - 1]?.[0] ?? limit };
}

/** Raw observations inside [from, to] as chart points. */
export function observedPoints(
  ts: readonly (string | number)[],
  value: readonly number[],
  conv: (v: number) => number,
  from: number,
  to: number,
): Pt[] {
  const out: Pt[] = [];
  ts.forEach((t, i) => {
    const ms = typeof t === 'number' ? t : Date.parse(t);
    if (ms >= from && ms <= to) out.push([ms, conv(value[i] as number)]);
  });
  return out;
}

/**
 * The older points of the API followed by recent.json's own: both sorted, and where they meet (the boundary instant,
 * or an overlap) recent.json's point is the one kept (P10d: a span beyond recent.json's 7 days).
 */
export function mergeHistory(older: readonly Pt[], recent: readonly Pt[]): Pt[] {
  const first = recent[0]?.[0];
  return [...(first === undefined ? older : older.filter(([t]) => t < first)), ...recent];
}
