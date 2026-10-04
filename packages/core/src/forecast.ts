import { SchemaDrift } from './errors.ts';
import { FUTURE_SLACK_MS } from './time.ts';

// Forecast runs (A§6, A§7.4 item 9, ADR-0010): what a forecast normaliser returns and the loader stores as an
// immutable bi-temporal run (issue time × valid time). Pure: the server hashes `encodeRun` with sha256 (core has
// no node: imports), reads the stored runs and applies `mergeDecision`.

export const FORECAST_KINDS = ['deterministic', 'quantiles', 'ensemble_summary'] as const;
export type ForecastKind = (typeof FORECAST_KINDS)[number];

/** The value columns of forecast_value, in the fixed order of the canonical encoding. */
export const FORECAST_COLUMNS = [
  'value',
  'p05',
  'p10',
  'p25',
  'p30',
  'p50',
  'p70',
  'p75',
  'p90',
  'p95',
  'vmin',
  'vmax',
] as const;
export type ForecastColumn = (typeof FORECAST_COLUMNS)[number];

/**
 * forecast_value.flags, a bitmask of its own (never the observation qc, whose QC_MAX is 1023). 16 is the
 * quantile order check (obs: RANGE), 128 and 256 match the obs bits, 1024 is new: a value below the provider's
 * floor ("below forecastable range", LU-3 Moselle), stored as published and never shown as a level.
 */
export const FORECAST_FLAGS = { ORDER: 16, CENSORED: 128, ESTIMATE: 256, BELOW_FLOOR: 1024 } as const;
const FLAGS_ALL = FORECAST_FLAGS.ORDER | FORECAST_FLAGS.CENSORED | FORECAST_FLAGS.ESTIMATE | FORECAST_FLAGS.BELOW_FLOOR;

/** One valid time of a run: canonical units (H cm, Q m³/s), a column left out or null is absent. */
export type ForecastPoint = { ts: string; flags: number } & Partial<Record<ForecastColumn, number | null>>;

/** A run as a normaliser returns it. `issuedAt` only when the provider states it (else the loader infers it). */
export type ForecastRunIn = {
  /** The source whose registry holds `series`, when it is not the payload's own (DE-2 → DE-1, LU-3 → LU-1). */
  target?: string;
  /** The series' provider key in that registry. */
  series: string;
  kind: ForecastKind;
  stepMs: number | null;
  issuedAt: string | null;
  providerSegmentEnd: string | null;
  points: ForecastPoint[];
};

/**
 * One percentile file of a run that spans several payloads (LU-3: five files per station), staged by the loader in
 * app_meta until the run is complete (`SpecLoader.combine`). `slot` names the station, `group` the fetch hour.
 */
export type ForecastPart = {
  target?: string;
  series: string;
  slot: string;
  group: string;
  part: string;
  data: unknown;
};

/** A staged part as the loader hands it back to `SpecLoader.combine`: its data and its manifest fetch time (UTC ms). */
export type StagedPart = { part: string; fetchedAt: number; data: unknown };

export type ForecastSourceDecl = {
  /** Native unit → quantity and factor to the canonical unit: declared per forecast source, never borrowed. */
  units: Readonly<Record<string, readonly ['H' | 'Q', number]>>;
  /** The provider's longest horizon; a valid time past issue (or fetch) + horizon + 1 h is dropped. */
  horizonMs: number;
  /** Where the provider's own forecast segment ends (DE-2: 48 h; estimate beyond), null when it has none. */
  segmentMs: number | null;
  /** The provider's step; null when it has none (FR-4: the step differs from run to run). */
  stepMs: number | null;
  kind: ForecastKind;
  /**
   * Successive captures of one run drop its leading values (NL-1 asks T−10 min … T+48 h each hour): a capture
   * whose points are the tail of a stored run is that run, never a new one (`mergeDecision`).
   */
  headDrops: boolean;
};

const HOUR = 3_600_000;

export const FORECAST_SOURCES = {
  'NL-1': {
    units: { cm: ['H', 1], 'm3/s': ['Q', 1], 'm³/s': ['Q', 1] },
    horizonMs: 48 * HOUR,
    segmentMs: null,
    stepMs: 10 * 60_000,
    kind: 'deterministic',
    headDrops: true,
  },
  'DE-2': {
    units: { cm: ['H', 1] },
    horizonMs: 96 * HOUR,
    segmentMs: 48 * HOUR,
    stepMs: 2 * HOUR,
    kind: 'deterministic',
    headDrops: false,
  },
  'LU-3': {
    units: { cm: ['H', 1] },
    horizonMs: 48 * HOUR,
    segmentMs: null,
    stepMs: HOUR,
    kind: 'quantiles',
    headDrops: false,
  },
  // P8b. CH-4 BAFU: about 115 h ahead; lake levels in metres above sea level (LN02), spelt both ways by BAFU.
  'CH-4': {
    units: { 'm³/s': ['Q', 1], 'm3/s': ['Q', 1], 'l/s': ['Q', 0.001], 'm ü. M.': ['H', 100], 'm ü.M.': ['H', 100] },
    horizonMs: 120 * HOUR,
    segmentMs: null,
    stepMs: HOUR,
    kind: 'ensemble_summary',
    headDrops: false,
  },
  // FR-4 Vigicrues: its own units (metres of stage, m³/s), never FR-1's millimetres and l/s. Runs reach 72 h ahead
  // of DtProdSimul with irregular steps (10 min, 1 h, gaps of half a day; archive 2026-09-30/10-01).
  'FR-4': {
    units: { m: ['H', 100], 'm3/s': ['Q', 1] },
    horizonMs: 72 * HOUR,
    segmentMs: null,
    stepMs: null,
    kind: 'quantiles',
    headDrops: false,
  },
  // DE-3 BfG 14-day forecast: daily means, one row per day.
  'DE-3': {
    units: { cm: ['H', 1] },
    horizonMs: 15 * 24 * HOUR,
    segmentMs: null,
    stepMs: 24 * HOUR,
    kind: 'quantiles',
    headDrops: false,
  },
} as const satisfies Record<string, ForecastSourceDecl>;
export type ForecastSource = keyof typeof FORECAST_SOURCES;

/** Bounds of one payload (review: every array a loader builds is capped). */
export const MAX_RUN_POINTS = 2000;
export const MAX_PAYLOAD_RUNS = 50;
const MAX_ABS = 1e7;
/**
 * A valid time more than this before (issue ?? fetch) is dropped as `before_window` (review SEC-1: a stamp years back
 * would make the loader's partition call create every month in between). NL-1 starts about 10 minutes before its
 * fetch, LU-3 about 105 minutes, DE-2 at its issue.
 */
export const MAX_LEAD_MS = 2 * 24 * HOUR;
/**
 * A provider-stated issue time more than this before the fetch is drift (`stale_issue`, review SEC-1 of P8b): a stale
 * or epoch-zero stamp would otherwise move the run's valid-time bounds with it into the past. FR-4's `DtProdSimul`
 * was at most a day before its fetch in the archive.
 */
export const MAX_ISSUE_AGE_MS = 30 * 24 * HOUR;

/** A run in canonical form: UTC ms, float32 values in FORECAST_COLUMNS order, sorted by valid time. */
export type CanonPoint = { ms: number; flags: number; v: readonly (number | null)[] };
export type CanonRun = {
  kind: ForecastKind;
  stepMs: number | null;
  /** Provider-stated issue time only (null when inferred). */
  issuedAt: number | null;
  segmentEnd: number | null;
  points: readonly CanonPoint[];
};

export const firstValid = (r: CanonRun): number => (r.points[0] as CanonPoint).ms;
export const lastValid = (r: CanonRun): number => (r.points.at(-1) as CanonPoint).ms;

/** float32 as stored (`real`), with -0 as 0, so a hash recomputed from stored rows matches. */
export const float32 = (x: number): number => {
  const r = Math.fround(x);
  return r === 0 ? 0 : r;
};

const instant = (raw: string, code: string): number => {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new SchemaDrift(code);
  return ms;
};

export type Checked = { run: CanonRun | null; dropped: Record<string, number> };

/** The quantile columns in the order their values may not decrease (A§6). */
const ORDERED = ['p05', 'p10', 'p25', 'p30', 'p50', 'p70', 'p75', 'p90', 'p95'].map((c) =>
  FORECAST_COLUMNS.indexOf(c as ForecastColumn),
);
const [P50, VMIN, VMAX] = (['p50', 'vmin', 'vmax'] as const).map((c) => FORECAST_COLUMNS.indexOf(c)) as [
  number,
  number,
  number,
];

/**
 * The quantile order check of every source (A§6, FORECAST_FLAGS.ORDER): the present columns among p05 … p95 do not
 * decrease, and vmin ≤ p50 ≤ vmax where present. Over the stored (float32) values; the values are never reordered.
 */
export function orderBroken(v: readonly (number | null)[]): boolean {
  const q = ORDERED.map((i) => v[i] as number | null).filter((x) => x !== null);
  if (q.some((x, i) => i > 0 && x < (q[i - 1] as number))) return true;
  const [lo, mid, hi] = [v[VMIN], v[P50], v[VMAX]] as (number | null)[];
  if (mid === null || mid === undefined) return lo != null && hi != null && lo > hi;
  return (lo != null && lo > mid) || (hi != null && mid > hi);
}

/**
 * The bounds every forecast run passes before it is stored: a provider issue time more than 15 minutes after the
 * fetch is drift (`future_issue`), one more than MAX_ISSUE_AGE_MS before it too (`stale_issue`), a non-finite or absurd value is drift (`bad_value`), two points at one valid time
 * are drift (the adapter resolves conflicts), a point past (issue ?? fetch) + horizon + 1 h is dropped as
 * `beyond_horizon` and one before (issue ?? fetch) − MAX_LEAD_MS as `before_window` (both retained and alerted), a
 * point with no value is a `gap` unless it is CENSORED, a point whose quantiles are out of order gets ORDER
 * (`orderBroken`), and a run left without points is none.
 */
export function checkRun(run: ForecastRunIn, fetchedAtMs: number, decl: ForecastSourceDecl): Checked {
  const dropped: Record<string, number> = {};
  const count = (code: string) => {
    dropped[code] = (dropped[code] ?? 0) + 1;
  };
  if (run.points.length > MAX_RUN_POINTS) throw new SchemaDrift('forecast_points');
  const issuedAt = run.issuedAt === null ? null : instant(run.issuedAt, 'bad_issue');
  if (issuedAt !== null && issuedAt > fetchedAtMs + FUTURE_SLACK_MS) throw new SchemaDrift('future_issue');
  if (issuedAt !== null && issuedAt < fetchedAtMs - MAX_ISSUE_AGE_MS) throw new SchemaDrift('stale_issue');
  const segmentEnd = run.providerSegmentEnd === null ? null : instant(run.providerSegmentEnd, 'bad_segment');
  if (run.stepMs !== null && !(Number.isInteger(run.stepMs) && run.stepMs > 0)) throw new SchemaDrift('bad_step');
  const limit = (issuedAt ?? fetchedAtMs) + decl.horizonMs + HOUR;
  const floor = (issuedAt ?? fetchedAtMs) - MAX_LEAD_MS;
  const points: CanonPoint[] = [];
  for (const p of run.points) {
    const ms = instant(p.ts, 'bad_time');
    if (!Number.isInteger(p.flags) || p.flags < 0 || (p.flags & ~FLAGS_ALL) !== 0) throw new SchemaDrift('bad_flags');
    const v = FORECAST_COLUMNS.map((c) => {
      const x = p[c];
      if (x === undefined || x === null) return null;
      if (!Number.isFinite(x) || Math.abs(x) > MAX_ABS) throw new SchemaDrift('bad_value');
      return float32(x);
    });
    // A point with no value is a gap, unless the provider censored it (DE-3 `---`: above its forecastable range).
    if (ms > limit) count('beyond_horizon');
    else if (ms < floor) count('before_window');
    else if (v.every((x) => x === null) && (p.flags & FORECAST_FLAGS.CENSORED) === 0) count('gap');
    else points.push({ ms, flags: orderBroken(v) ? p.flags | FORECAST_FLAGS.ORDER : p.flags, v });
  }
  points.sort((a, b) => a.ms - b.ms);
  if (points.some((p, i) => i > 0 && p.ms === (points[i - 1] as CanonPoint).ms)) throw new SchemaDrift('duplicate_ts');
  if (points.length === 0) {
    count('empty_run');
    return { run: null, dropped };
  }
  return { run: { kind: run.kind, stepMs: run.stepMs, issuedAt, segmentEnd, points }, dropped };
}

/** A payload holds at most MAX_PAYLOAD_RUNS runs (drift otherwise). */
export function checkRunCount(runs: readonly unknown[]): void {
  if (runs.length > MAX_PAYLOAD_RUNS) throw new SchemaDrift('forecast_runs');
}

const HEADER_BYTES = 2 + 3 * 9;
const POINT_BYTES = 8 + FORECAST_COLUMNS.length * 5 + 2;

/**
 * The canonical encoding the content hash is taken over, never raw bytes: a header (encoding version, kind, step,
 * the provider issue time (absent when inferred), the provider segment end), then per point in valid-time order
 * int64 UTC ms, each value column as a presence byte and its float32 bits, and int16 flags. Re-expressing the same
 * instants with another offset, or reading the run back from its `real` rows, gives the same bytes.
 */
export function encodeRun(run: CanonRun): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES + run.points.length * POINT_BYTES);
  const dv = new DataView(buf.buffer);
  let o = 0;
  const opt = (x: number | null) => {
    dv.setUint8(o, x === null ? 0 : 1);
    if (x !== null) dv.setBigInt64(o + 1, BigInt(x));
    o += 9;
  };
  dv.setUint8(o++, 1);
  dv.setUint8(o++, FORECAST_KINDS.indexOf(run.kind));
  opt(run.stepMs);
  opt(run.issuedAt);
  opt(run.segmentEnd);
  for (const p of [...run.points].sort((a, b) => a.ms - b.ms)) {
    dv.setBigInt64(o, BigInt(p.ms));
    o += 8;
    for (const x of p.v) {
      dv.setUint8(o, x === null ? 0 : 1);
      if (x !== null) dv.setFloat32(o + 1, x);
      o += 5;
    }
    dv.setInt16(o, p.flags);
    o += 2;
  }
  return buf;
}

/** A stored run with its points (same series and source), as the loader reads it back. */
export type StoredRun = CanonRun & { id: string; hash: string };

/**
 * `same`: the incoming run is the stored one (lower its fetched_at and an inferred issued_at to the earlier
 * capture); `extend`: the stored run is the tail of the incoming one (an earlier capture loaded later): insert the
 * leading points, set first_valid and the hash over the union, lower fetched_at; `insert`: a new run; `ambiguous`:
 * the tail matches more than one stored run, so nothing changes.
 */
export type MergeDecision =
  | { kind: 'insert' }
  | { kind: 'same'; id: string }
  | { kind: 'extend'; id: string; add: CanonPoint[] }
  | { kind: 'ambiguous' };

const sameHeader = (a: CanonRun, b: CanonRun) =>
  a.kind === b.kind && a.stepMs === b.stepMs && a.issuedAt === b.issuedAt && a.segmentEnd === b.segmentEnd;

const samePoint = (a: CanonPoint, b: CanonPoint) =>
  a.ms === b.ms && a.flags === b.flags && a.v.length === b.v.length && a.v.every((x, i) => x === b.v[i]);

/** `short` is `long` without its leading values: the same header and end, identical points from its first on. */
export function isTail(long: CanonRun, short: CanonRun): boolean {
  if (!sameHeader(long, short) || lastValid(long) !== lastValid(short)) return false;
  const from = firstValid(short);
  if (firstValid(long) >= from) return false;
  const tail = long.points.filter((p) => p.ms >= from);
  return tail.length === short.points.length && tail.every((p, i) => samePoint(p, short.points[i] as CanonPoint));
}

/**
 * The identity of a run (A§7.4 item 9): the key (series, first valid time, content hash). For a source whose
 * captures drop the head (`headDrops`: NL-1) a capture that is the tail of a stored run with the same end is that
 * run, and a stored run that is the tail of the incoming one is extended by the leading points it lacks; two runs
 * that differ anywhere on their overlap, or end differently, are never merged. Whatever the load order, the stored
 * run is the earliest capture, keyed by its first valid time and hash. `stored` holds the runs of the same series
 * and source; existing values never change.
 */
export function mergeDecision(
  stored: readonly StoredRun[],
  incoming: CanonRun,
  hash: string,
  headDrops: boolean,
): MergeDecision {
  const first = firstValid(incoming);
  const exact = stored.find((s) => s.hash === hash && firstValid(s) === first);
  if (exact !== undefined) return { kind: 'same', id: exact.id };
  if (!headDrops) return { kind: 'insert' };
  const longer = stored.filter((s) => isTail(s, incoming));
  if (longer.length > 1) return { kind: 'ambiguous' };
  if (longer.length === 1) return { kind: 'same', id: (longer[0] as StoredRun).id };
  const shorter = stored.filter((s) => isTail(incoming, s));
  if (shorter.length > 1) return { kind: 'ambiguous' };
  if (shorter.length === 1) {
    const s = shorter[0] as StoredRun;
    return { kind: 'extend', id: s.id, add: incoming.points.filter((p) => p.ms < firstValid(s)) };
  }
  return { kind: 'insert' };
}

export type CurrentRun = { source: string; lastValid: number; issued: number };

/**
 * Whether a run (the latest known as of `now`, A§8 Q2) still forecasts `t`: it reaches `t`, and no rule of its
 * source says it was superseded by a run that did not come (DE-2: a due day past its deadline; a held run is never
 * shown). `superseded` is the source's schedule rule.
 */
export function isCurrent(
  run: CurrentRun,
  t: number,
  now: number,
  superseded?: (run: CurrentRun, now: number) => boolean,
): boolean {
  return run.lastValid >= t && !(superseded?.(run, now) ?? false);
}
