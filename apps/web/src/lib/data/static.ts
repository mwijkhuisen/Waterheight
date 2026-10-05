import type { Snapshot, SnapshotForecast } from '@rws/contracts';
import { dayOf, floorBucket, isSettled, recentPath, settledPath } from '@rws/contracts';

// Static-first data (P9a): which file holds the snapshot of a quantised t. Pure; "now" is meta.now, never the
// browser's clock. A URL is built only from the validated, quantised t and the integer version of meta.

/** The bucket the snapshot asks for is served by... */
export type SnapshotSource =
  | { kind: 'latest' }
  | { kind: 'recent'; path: string }
  | { kind: 'settled'; path: string; version: number }
  | { kind: 'api' };

type MetaClock = { now: string; dayVersions: Readonly<Record<string, number>> };

export function snapshotSource(t: number, meta: MetaClock): SnapshotSource {
  const now = Date.parse(meta.now);
  // Unknown (not on the grid, not a time), the future, and a day without a complete settled file: the API.
  if (!Number.isFinite(t) || !Number.isFinite(now) || floorBucket(t) !== t || t > floorBucket(now))
    return { kind: 'api' };
  if (t === floorBucket(now)) return { kind: 'latest' };
  const day = dayOf(t);
  if (!isSettled(day, now)) return { kind: 'recent', path: recentPath(t) };
  const version = meta.dayVersions[day] ?? 1;
  return version === 0 ? { kind: 'api' } : { kind: 'settled', path: settledPath(t, version), version };
}

/** The version part of the snapshot's query key: what the answer depends on besides t. */
export const versionKey = (s: SnapshotSource, t: number): string =>
  s.kind === 'latest' ? `latest:${t}` : s.kind === 'settled' ? `v${s.version}` : s.kind;

/** A forecast without a state: the fallback for a future t computes values, never classes (API: state non-null). */
export type WebForecast = Omit<SnapshotForecast, 'state'> & { state: SnapshotForecast['state'] | null };

/** What the page shows for a t: the API's Snapshot, its forecasts possibly without state, and how it was got. */
export type WebSnapshot = {
  t: string;
  values: Snapshot['values'];
  forecasts?: WebForecast[] | undefined;
  /** Caddy's answer for the API being down: the newest bucket, shown under its own `t`. */
  standIn: boolean;
  /** The forecast fallback or a stand-in: the page says so. */
  degraded: boolean;
};
