import { dayOf, floorBucket, type WarningsFile } from '@rws/contracts';

// Warning areas at a quantised t (P10a T5). Pure: "now" is meta.now, never the browser's clock. The publisher writes
// warnings/latest.geojson (the areas valid at its generation time) every cycle and warnings/YYYY-MM-DD.json (every
// area valid during that ended UTC day) once, for the public family only. So:
// - t in an ended UTC day: the dated file (areas issued on an earlier day and still valid are in it by overlap);
// - t in the current bucket: latest.geojson;
// - t earlier today, or any past t on the owner site: latest.geojson filtered to t, which lacks the areas that ended
//   before it was written: the page says "may be incomplete" (a contract gap recorded in docs/known-gaps.md).

export type WarningFeature = WarningsFile['features'][number];
export interface WarningsAt {
  /** The areas valid at t, one per (source, area): the row whose validity holds t, the latest `from` on a tie. */
  features: WarningFeature[];
  /** Areas that ended before the file was written may be missing for this t. */
  incomplete: boolean;
}

export type WarningsSource = { kind: 'latest'; incomplete: boolean } | { kind: 'dated'; path: string };

export function warningsSource(t: number, now: number, dated: boolean): WarningsSource {
  if (t >= floorBucket(now)) return { kind: 'latest', incomplete: false };
  const day = dayOf(t);
  if (dated && day < dayOf(now)) return { kind: 'dated', path: `${day}.json` };
  return { kind: 'latest', incomplete: true };
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
