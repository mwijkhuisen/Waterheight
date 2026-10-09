import type { ApiStation, AttributionEntry, Snapshot } from '@rws/contracts';

// The hourly frames of playback (P11b, issue #26; A§9.1 frames/, A§9.2 /api/v1/frames). Pure. A public range is
// read as one file per settled UTC day (`frames/<day>/v<n>.json`, an absent day is v1), the unsettled days together
// as `frames/recent.json`, and a day with version 0 or a failed file through /api/v1/frames, one call per contiguous
// range of ≤ 14 days. The owner host has no static frames: API ranges only. URLs come only from the regex-checked
// day, the integer version and whole UTC hours. Every series id must be one of the site's stations.json; an unknown
// id is never mapped, it is dropped and counted (frames carry no series hash, R2).

type Value = Snapshot['values'][number];

/** What one request covers. */
export type FramesUnit =
  | { kind: 'day'; day: string; v: number }
  | { kind: 'recent' }
  | { kind: 'api'; from: number; to: number };

/** The fields of meta the plan needs (WebMeta, or the owner's meta.json). */
export interface FramesMeta {
  now: string;
  displayStart: string;
  dayVersions: Readonly<Record<string, number>>;
}

/**
 * The requests that cover the whole hours [from, to) for `audience`. `failed` holds the settled days whose file
 * failed (404, schema): they join the API ranges.
 */
export function framesPlan(
  _from: number,
  _to: number,
  _meta: FramesMeta,
  _audience: 'public' | 'owner',
  _failed: ReadonlySet<string> = new Set(),
): FramesUnit[] {
  // L0 stub (W4 builds it).
  return [];
}

/** The relative URL of a unit (same origin). */
export function framesUrl(_unit: FramesUnit): string {
  // L0 stub (W4 builds it).
  return '';
}

/** One parsed answer (a file or the API), before the series check. */
export interface FramesChunk {
  from: string;
  to: string;
  series: readonly number[];
  vlast: readonly (readonly (number | null)[])[];
  attribution: readonly AttributionEntry[];
}

export interface FrameStore {
  /** The bucket that the hour `t` shows (t − 1 h, R12) has answered: loaded, or known to have no data. */
  ready(t: number): boolean;
  /**
   * The values at the whole hour `t` in the Snapshot's shape: the value of bucket t − 1 h, else the last non-null
   * bucket before it, while younger than the series' stalenessLimitSeconds (ageSeconds from t); `ts` is the end of
   * the bucket it came from; `state` 'no_ref', `basis` null, `qc` 0, `section` false. An absent series has no entry.
   */
  valuesAt(t: number): Map<number, Value>;
  /** The union of the loaded answers' attribution rows. */
  attribution(): readonly AttributionEntry[];
  /** Series ids dropped by the check (unknown ids, misaligned rows). */
  readonly dropped: number;
}

/**
 * A store over the chunks loaded so far. `answered` lists the hour ranges [from, to) that have answered, with or
 * without data; `stations` are the site's stations.json (the known ids and their staleness limits).
 */
export function buildFrameStore(
  _chunks: readonly FramesChunk[],
  _answered: readonly { from: number; to: number }[],
  _stations: readonly ApiStation[],
): FrameStore {
  // L0 stub (W4 builds it).
  return { ready: () => false, valuesAt: () => new Map(), attribution: () => [], dropped: 0 };
}
