import { dayOf, floorBucket, type WarningsFile } from '@rws/contracts';

// Warning areas at a quantised t (P10a T5). Pure: "now" is meta.now, never the browser's clock. Each family's publisher
// writes, every cycle, warnings/latest.geojson (the areas valid at its generation time) and warnings/today.json (every
// area valid at some time of the current UTC day, as loaded so far, #86), and warnings/YYYY-MM-DD.json (every area
// valid during that UTC day) once, after the day ended. So:
// - t in the current bucket: latest.geojson;
// - t earlier today: today.json, when its `day` is t's (at midnight it may already hold the next day);
// - t in an ended UTC day: the dated file (areas issued on an earlier day and still valid are in it by overlap).
// A missing file (or today.json of another day) falls back to latest.geojson filtered to t, which lacks the areas that
// ended before it was written: the page then says "may be incomplete".

export type WarningFeature = WarningsFile['features'][number];
export interface WarningsAt {
  /** The areas valid at t, one per (source, area): the row whose validity holds t, the latest `from` on a tie. */
  features: WarningFeature[];
  /** Areas that ended before the file was written may be missing for this t. */
  incomplete: boolean;
}

/** A warnings file as read for every t of it (O3): its rows of the visible sources; `incomplete` for the fallback. */
export interface WarningsRead {
  features: WarningFeature[];
  incomplete: boolean;
}

/** latest.geojson, or the file of t's UTC day (`path`), whose `day` must be `day`. */
export type WarningsSource = { kind: 'latest' } | { kind: 'dated'; day: string; path: string };

export function warningsSource(t: number, now: number): WarningsSource {
  if (t >= floorBucket(now)) return { kind: 'latest' };
  const day = dayOf(t);
  return { kind: 'dated', day, path: day < dayOf(now) ? `${day}.json` : 'today.json' };
}

/** `from ≤ t < to` (an open `to` never ends). */
export const validAt = (p: Pick<WarningFeature['properties'], 'from' | 'to'>, t: number): boolean =>
  Date.parse(p.from) <= t && (p.to === null || t < Date.parse(p.to));

/** The areas of one file valid at t, one row per (source, area). */
export function warningsAt(file: Pick<WarningsFile, 'features'>, t: number, incomplete: boolean): WarningsAt {
  const best = new Map<string, WarningFeature>();
  for (const f of file.features) {
    if (!validAt(f.properties, t)) continue;
    const key = `${f.properties.source}\n${f.properties.area}`;
    const held = best.get(key);
    if (held === undefined || Date.parse(f.properties.from) > Date.parse(held.properties.from)) best.set(key, f);
  }
  return { features: [...best.values()], incomplete };
}

/**
 * O3 (#219): the query key of the file a t up to now reads, never t itself, so every t of a file shares one read:
 * latest.geojson per 10-minute bucket (its t is that bucket), a day file per path and day, and the day of now (after
 * midnight UTC a fallback held for today.json, already of the next day, is read again).
 */
export const warningsFileKey = (choice: WarningsSource, now: number): readonly (string | number)[] =>
  choice.kind === 'latest' ? ['latest', floorBucket(now)] : [choice.path, choice.day, dayOf(now)];

/**
 * `prev` when `next` holds the same rows in the same order (the same objects, of one file) and the same `incomplete`,
 * else `next` (O3): an unchanged set keeps its identity, so the map skips its setData.
 */
export function stableWarnings(prev: WarningsAt | undefined, next: WarningsAt): WarningsAt {
  return prev !== undefined &&
    prev.incomplete === next.incomplete &&
    prev.features.length === next.features.length &&
    prev.features.every((f, i) => f === next.features[i])
    ? prev
    : next;
}
