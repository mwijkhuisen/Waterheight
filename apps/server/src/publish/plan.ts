import { BUCKET_MS, DAY_MS, dayOf, floorBucket, isSettled } from '@rws/contracts';
import type { BumpReason } from '../load/dirty.ts';

// P9a: the publisher's planning, pure (A§9.1). A UTC day is settled when D + 1 d ≤ now − 48 h; its snapshots are
// then settled/D/v{n}/ files (public only), and the buckets of the days not yet settled are recent/ files.

export type FileClass = 'latest' | 'recent' | 'settled' | 'future';

/** Which file serves the bucket `t`: the current bucket is latest.json (it also has a recent file). */
export function classify(t: number, nowMs: number): FileClass {
  const current = floorBucket(nowMs);
  if (t > current) return 'future';
  if (t === current) return 'latest';
  return isSettled(dayOf(t), nowMs) ? 'settled' : 'recent';
}

/** The start of the first day that is not settled: recent files cover [this, now]. */
export function unsettledStart(nowMs: number): number {
  let d = Math.floor(nowMs / DAY_MS) * DAY_MS;
  while (!isSettled(dayOf(d - DAY_MS), nowMs)) d -= DAY_MS;
  return d;
}

/** Every bucket of the unsettled days up to the current one. */
export function recentBuckets(nowMs: number): number[] {
  const out: number[] = [];
  for (let t = unsettledStart(nowMs); t <= floorBucket(nowMs); t += BUCKET_MS) out.push(t);
  return out;
}

export type DirtyRow = { id: string; kind: string; from_ts: Date; to_ts: Date; stations: string[] };

/** The recent buckets a dirty row reaches: from its floored start to min(its end, now), inside the unsettled days. */
export function dirtyBuckets(rows: readonly DirtyRow[], nowMs: number): Set<number> {
  const out = new Set<number>();
  const lo = unsettledStart(nowMs);
  const hi = floorBucket(nowMs);
  for (const r of rows) {
    if (r.kind === 'forecast') continue; // a run changes no past bucket, only station files
    const from = Math.max(floorBucket(r.from_ts.getTime()), lo);
    const to = Math.min(r.to_ts.getTime(), hi);
    for (let t = from; t <= to; t += BUCKET_MS) out.add(t);
  }
  return out;
}

/** The settled days of the display window, oldest first. */
export function settledDays(displayStartMs: number, nowMs: number): string[] {
  const out: string[] = [];
  for (let d = Math.floor(displayStartMs / DAY_MS) * DAY_MS; isSettled(dayOf(d), nowMs); d += DAY_MS)
    out.push(dayOf(d));
  return out;
}

/** A series' channel facts, as the family's series view has them. */
export type HistoryFacts = { lic_history_export: boolean; history_window_s: number | null; staleness_s: number };

/**
 * §9 C5: no file but latest.json carries a series whose effective history_export is off; latest.json carries it
 * only when its history window exceeds its staleness limit + 1 h (so its value is inside the window).
 */
export function historyExcluded(s: HistoryFacts, file: 'latest' | 'other'): boolean {
  if (s.lic_history_export) return false;
  if (file === 'other') return true;
  return s.history_window_s === null || s.history_window_s <= s.staleness_s + 3600;
}

export type Version = { v: number; reason: BumpReason };
/** day → its versions with a completion marker, and when each completed. */
export type Complete = ReadonlyMap<string, ReadonlyMap<number, number>>;

/** The current version of a day: absent is 1. */
export const versionOf = (versions: ReadonlyMap<string, Version>, day: string): number => versions.get(day)?.v ?? 1;

/**
 * The public meta.dayVersions: for each settled day the newest complete version it may name (the current one, or
 * while that renders an older complete one unless the bump was a narrowing), 0 when there is none; sparse (1 is the
 * default and left out).
 */
export function metaDayVersions(
  versions: ReadonlyMap<string, Version>,
  complete: Complete,
  settled: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const day of settled) {
    const n = versionOf(versions, day);
    const done = complete.get(day);
    let named = done?.has(n) ? n : 0;
    if (named === 0 && versions.get(day)?.reason !== 'narrowed')
      for (const k of done?.keys() ?? []) if (k < n && k > named) named = k;
    if (named !== 1) out[day] = named;
  }
  return out;
}

/** The owner meta.dayVersions: the family's version map, sparse, never 0 (no settled files; P9b's cache key). */
export function ownerDayVersions(versions: ReadonlyMap<string, Version>): Record<string, number> {
  return Object.fromEntries([...versions].filter(([, x]) => x.v !== 1).map(([day, x]) => [day, x.v]));
}

/** The settled day to render next (newest first): its current version has no marker. */
export function nextSettled(
  versions: ReadonlyMap<string, Version>,
  complete: Complete,
  settled: readonly string[],
): string | undefined {
  return [...settled].reverse().find((day) => complete.get(day)?.has(versionOf(versions, day)) !== true);
}

/** What exists on disk, by directory listing. */
export type OnDisk = {
  recentDays: readonly string[];
  settled: ReadonlyMap<string, readonly number[]>;
  frames: ReadonlyMap<string, readonly number[]>;
  stationDirs: readonly string[];
};

export const RECENT_KEEP_MS = 6 * 3_600_000;
export const SUPERSEDED_KEEP_MS = 3_600_000;

/**
 * What to delete (paths under v1/), and the markers that go with them:
 * - a settled day's recent files 6 h after its current version completed (the owner family, which has no settled
 *   files, as soon as the day settles);
 * - a superseded settled version and its frames 1 h after the current one completed, or at once after a narrowing;
 * - the station files of stations no longer in the family (when the station list is known).
 */
export function prunePlan(
  input: {
    nowMs: number;
    family: 'public' | 'owner';
    versions: ReadonlyMap<string, Version>;
    complete: Complete;
    stations: ReadonlySet<string> | undefined;
  } & OnDisk,
): { paths: string[]; markers: [string, number][] } {
  const { nowMs, versions, complete } = input;
  const paths: string[] = [];
  const markers: [string, number][] = [];
  const doneAt = (day: string) => complete.get(day)?.get(versionOf(versions, day));
  for (const day of input.recentDays) {
    if (!isSettled(day, nowMs)) continue;
    const at = doneAt(day);
    if (input.family === 'owner' || (at !== undefined && at + RECENT_KEEP_MS <= nowMs)) paths.push(`recent/${day}`);
  }
  const superseded = (day: string, k: number) => {
    if (k === versionOf(versions, day)) return false;
    if (versions.get(day)?.reason === 'narrowed' && k < versionOf(versions, day)) return true;
    const at = doneAt(day);
    return at !== undefined && at + SUPERSEDED_KEEP_MS <= nowMs;
  };
  for (const [day, list] of input.settled)
    for (const k of list)
      if (superseded(day, k)) {
        paths.push(`settled/${day}/v${k}`);
        markers.push([day, k]);
      }
  for (const [day, list] of input.frames)
    for (const k of list) if (superseded(day, k)) paths.push(`frames/${day}/v${k}.json`);
  const { stations } = input;
  if (stations !== undefined) for (const s of input.stationDirs) if (!stations.has(s)) paths.push(`series/${s}`);
  return { paths, markers };
}
