import { emptyNormalised, type Normalised } from '@rws/core';
import type { Station } from './parse.ts';

// LU-6 → nothing stored (catalogue §2.6): the station points are registry input. scripts/gen-lu1-stations.ts
// takes each LU-1 station's coordinates from the recorded LU-6 file through an explicit table (LU-1 Name →
// AGE station number), never by fuzzy name matching. In the loader the daily LU-6 payload only reports
// drift against the LU-1 registry: our keys and numbers, never a station name.

export const SOURCE = 'LU-6';

/** A registered LU-1 series (the loader passes its SeriesRow map). */
type Registered = { key: string; lon: number | null; lat: number | null };

export type Drift = {
  /** AGE station numbers of in-service LU-6 points with no registered LU-1 station within MOVED_M. */
  unregistered: string[];
  /** Registered LU-1 series with a position and no LU-6 point within GONE_M. */
  vanished: string[];
  /** Registered LU-1 series whose nearest LU-6 point is between MOVED_M and GONE_M away (`"<lon>,<lat>"`). */
  changed: { key: string; field: 'position'; declared: string; published: string }[];
};

/** A gauge that moved, not the rounding of two services. */
export const MOVED_M = 50;
/** Further than this, the point is another station. */
export const GONE_M = 1000;
const LIMIT = 200;

/** Metres between two WGS84 points (equirectangular; exact enough within a kilometre). */
export function metres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return 6_371_000 * Math.hypot(x, y);
}

/** No rows: the points are registry input (the parse is the check that the payload is what we expect). */
export function normalise(_stations: readonly Station[]): Normalised {
  return emptyNormalised();
}

const position = (p: { lon: number; lat: number }) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;

export function driftReport(registry: ReadonlyMap<string, Registered>, stations: readonly Station[]): Drift {
  const drift: Drift = { unregistered: [], vanished: [], changed: [] };
  const placed = [...registry.values()].filter(
    (r): r is Registered & { lon: number; lat: number } => r.lon !== null && r.lat !== null,
  );
  for (const r of placed) {
    let best: Station | undefined;
    let d = Number.POSITIVE_INFINITY;
    for (const s of stations) {
      const m = metres(r, s);
      if (m < d) {
        d = m;
        best = s;
      }
    }
    if (best === undefined || d > GONE_M) drift.vanished.push(r.key);
    else if (d > MOVED_M)
      drift.changed.push({ key: r.key, field: 'position', declared: position(r), published: position(best) });
  }
  for (const s of stations) {
    if (s.inService && s.code !== null && !placed.some((r) => metres(r, s) <= MOVED_M)) drift.unregistered.push(s.code);
  }
  drift.unregistered = [...new Set(drift.unregistered)].sort().slice(0, LIMIT);
  drift.vanished = drift.vanished.sort().slice(0, LIMIT);
  drift.changed = drift.changed.sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, LIMIT);
  return drift;
}
