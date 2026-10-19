import type { ClimatologyConfig } from '@rws/contracts';

// Empirical travel time of a reach (P14f, plan section 3.6; catalogue section 3.7): the lag at which the changes at its
// upstream station best predict the changes at its downstream one, by flow class. Pure and deterministic: no clock,
// no randomness, no I/O. The command (`main.js travel-times`) feeds it hourly means; the registry file it writes is
// reviewed before the geo build reads it.
//
// Per window of `window_h` hours (stepped by `step_h`): the signal of each station is the first difference of a
// centred `smooth_h` rolling mean (a level that rises slowly on both ends correlates at every lag, its changes do
// not); the Pearson r of the two signals is taken at every lag from `min_lag_h` to L, and the window counts only if
// the best r reaches `r_min` at an interior lag (a maximum at either end of the range is a trend still rising, not a
// lag). The lags of the counting windows are then summarised per flow class (a tercile of the window's mean
// up-station flow) as [floor(P25), ceil(P75)], and the reach's range is the envelope of the classes that have enough
// windows. A reach with none has no empirical travel time.

export type LagParams = ClimatologyConfig['travel'];
export const FLOW_CLASSES = ['low', 'mid', 'high'] as const;
export type FlowClass = (typeof FLOW_CLASSES)[number];

export type LagInput = {
  /** Hourly means of the upstream station's series (one entry per UTC hour, NaN where missing). */
  up: ArrayLike<number>;
  /** The downstream station's, on the same hour index and with the same length. */
  down: ArrayLike<number>;
  /** The upstream station's flow (Q, or H where it has no Q) on the same index: only the classes read it. */
  flow: ArrayLike<number>;
  lengthKm: number;
  params: LagParams;
};

export type LagResult = {
  /** The envelope of the qualifying classes, [lo, hi] hours, lo < hi, lo >= max(1, min_lag_h). */
  h: [number, number];
  classes: Partial<Record<FlowClass, [number, number]>>;
  /** Windows behind the qualifying classes. */
  windows: number;
  /** Hour index of the first start and of the last end (exclusive) among those windows. */
  span: [number, number];
};

/** A window needs this share of its hours present in each signal, and of its hours paired at a lag. */
export const MIN_PRESENT = 0.9;
export const MIN_PAIRED = 0.8;

/** The longest lag tried for a reach: about 1 km/h at least, never above the configured maximum. */
export const maxLag = (lengthKm: number, p: Pick<LagParams, 'max_lag_h'>): number =>
  Math.min(p.max_lag_h, Math.max(12, Math.ceil(lengthKm)));

/** Type 7 percentile (linear between order statistics) of an ascending array. */
function percentile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const i = Math.floor(at);
  const lo = sorted[i] as number;
  return lo + ((sorted[Math.min(i + 1, sorted.length - 1)] as number) - lo) * (at - i);
}

/**
 * First difference of the centred rolling mean of `smooth` hours (the window [i - floor(smooth / 2), + smooth)); NaN
 * wherever a hour of either mean is missing, so a gap never becomes a step.
 */
export function changeSignal(x: ArrayLike<number>, smooth: number): Float64Array {
  const n = x.length;
  const half = Math.floor(smooth / 2);
  const mean = new Float64Array(n).fill(Number.NaN);
  for (let i = half; i + smooth - half <= n; i++) {
    let sum = 0;
    for (let k = i - half; k < i - half + smooth; k++) sum += x[k] as number;
    mean[i] = sum / smooth; // NaN if any hour is missing
  }
  const d = new Float64Array(n).fill(Number.NaN);
  for (let i = 1; i < n; i++) d[i] = (mean[i] as number) - (mean[i - 1] as number);
  return d;
}

const present = (x: ArrayLike<number>, from: number, to: number): number => {
  let n = 0;
  for (let i = from; i < to; i++) if (Number.isFinite(x[i] as number)) n++;
  return n;
};

/**
 * The best lag of one window: the maximum of the Pearson r over lo..hi (the smallest lag on a tie), or null when no
 * lag has enough pairs or the maximum sits at either end of the range.
 */
function windowLag(
  a: Float64Array,
  b: Float64Array,
  start: number,
  length: number,
  lo: number,
  hi: number,
  rMin: number,
): number | null {
  let best = Number.NEGATIVE_INFINITY;
  let at = -1;
  for (let lag = lo; lag <= hi; lag++) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = start; i < start + length && i + lag < b.length; i++) {
      const x = a[i] as number;
      const y = b[i + lag] as number;
      if (!(Number.isFinite(x) && Number.isFinite(y))) continue;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    if (n < MIN_PAIRED * length) continue;
    const vx = sxx - (sx * sx) / n;
    const vy = syy - (sy * sy) / n;
    if (!(vx > 0 && vy > 0)) continue;
    const r = (sxy - (sx * sy) / n) / Math.sqrt(vx * vy);
    if (r > best) {
      best = r;
      at = lag;
    }
  }
  return at > lo && at < hi && best >= rMin ? at : null;
}

/** The empirical travel time of a reach, or null when no flow class has `min_windows` qualifying windows. */
export function estimateLag(input: LagInput): LagResult | null {
  const { up, down, flow, params: p } = input;
  const n = up.length;
  if (down.length !== n || flow.length !== n) throw new RangeError('lag: the three series differ in length');
  const lo = Math.max(1, p.min_lag_h);
  const hi = maxLag(input.lengthKm, p);
  if (hi - lo < 2) return null; // no interior lag

  const a = changeSignal(up, p.smooth_h);
  const b = changeSignal(down, p.smooth_h);
  const windows: { start: number; flow: number; lag: number | null }[] = [];
  for (let start = 0; start + p.window_h <= n; start += p.step_h) {
    const end = start + p.window_h;
    // A window with too many missing hours in either signal, or in the flow, has no class and counts nowhere.
    if (present(a, start, end) < MIN_PRESENT * p.window_h || present(b, start, end) < MIN_PRESENT * p.window_h)
      continue;
    if (present(flow, start, end) < MIN_PRESENT * p.window_h) continue;
    let sum = 0;
    for (let i = start; i < end; i++) if (Number.isFinite(flow[i] as number)) sum += flow[i] as number;
    windows.push({
      start,
      flow: sum / present(flow, start, end),
      lag: windowLag(a, b, start, p.window_h, lo, hi, p.r_min),
    });
  }
  if (windows.length === 0) return null;

  // Terciles of the windows' mean flow over the whole record, so each class is a third of the windows.
  const sortedFlow = windows.map((w) => w.flow).sort((x, y) => x - y);
  const t1 = percentile(sortedFlow, 1 / 3);
  const t2 = percentile(sortedFlow, 2 / 3);
  const classOf = (f: number): FlowClass => (f <= t1 ? 'low' : f <= t2 ? 'mid' : 'high');

  const classes: Partial<Record<FlowClass, [number, number]>> = {};
  let counted = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const c of FLOW_CLASSES) {
    const mine = windows.filter((w) => w.lag !== null && classOf(w.flow) === c);
    if (mine.length < p.min_windows) continue;
    const lags = mine.map((w) => w.lag as number).sort((x, y) => x - y);
    const from = Math.max(lo, Math.floor(percentile(lags, 0.25)));
    const to = Math.ceil(percentile(lags, 0.75));
    classes[c] = [from, to > from ? to : from + 1];
    counted += mine.length;
    for (const w of mine) {
      first = Math.min(first, w.start);
      last = Math.max(last, w.start + p.window_h);
    }
  }
  const ranges = Object.values(classes);
  if (ranges.length === 0) return null;
  return {
    h: [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))],
    classes,
    windows: counted,
    span: [first, last],
  };
}
