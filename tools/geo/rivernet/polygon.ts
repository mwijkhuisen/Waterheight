import type { LonLat } from './network.ts';
import type { WaterbodyArea } from './waterbodies.ts';

// P17b: the geometry of a water-body polygon for the station placement, pure and without a dependency. Inside is
// even-odd per polygon (inside its outer ring and in none of its holes; half-open on the boundary, where the shore
// distance is 0 anyway). Distances are local equirectangular metres around the station, as nearestOnRiver in
// snap.ts: exact enough within a few kilometres.

/** [west, south, east, north] in degrees. */
type Box = [number, number, number, number];

interface Ring {
  box: Box;
  coords: readonly LonLat[];
}

export interface PreparedArea {
  id: string;
  box: Box;
  /** Per polygon its rings, the outer ring first. */
  polygons: Ring[][];
}

function boxOf(coords: readonly LonLat[]): Box {
  const b: Box = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const [x, y] of coords) {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  return b;
}

/** The bounding boxes of an area and of each of its rings, computed once. */
export function prepareArea(area: WaterbodyArea): PreparedArea {
  const polygons = area.polygons.map((rings) => rings.map((coords) => ({ box: boxOf(coords), coords })));
  return { id: area.id, box: boxOf(polygons.flatMap((p) => p.flatMap((r) => [...r.coords]))), polygons };
}

const inBox = (b: Box, [x, y]: LonLat) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

function inRing(r: Ring, at: LonLat): boolean {
  if (!inBox(r.box, at)) return false;
  const [x, y] = at;
  let inside = false;
  for (let i = 0, j = r.coords.length - 1; i < r.coords.length; j = i++) {
    const [xi, yi] = r.coords[i] as LonLat;
    const [xj, yj] = r.coords[j] as LonLat;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside one of the area's polygons: in its outer ring and in none of its holes. */
export function contains(a: PreparedArea, at: LonLat): boolean {
  if (!inBox(a.box, at)) return false;
  return a.polygons.some(
    ([outer, ...holes]) => outer !== undefined && inRing(outer, at) && !holes.some((h) => inRing(h, at)),
  );
}

/**
 * Metres from `at` to the nearest segment of any ring. Exact when that is at most `maxM`; rings and segments whose
 * bounding box lies farther than `maxM` are skipped, so a larger result only says "farther than maxM" (Infinity
 * when nothing is near). With the default it is always exact.
 */
export function shoreDistance(a: PreparedArea, at: LonLat, maxM = Number.POSITIVE_INFINITY): number {
  const [lon0, lat0] = at;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_574;
  const dLon = (maxM + 100) / kx;
  const dLat = (maxM + 100) / ky;
  const far = (w: number, s: number, e: number, n: number) =>
    w - dLon > lon0 || e + dLon < lon0 || s - dLat > lat0 || n + dLat < lat0;
  let best = Number.POSITIVE_INFINITY;
  for (const rings of a.polygons)
    for (const { box, coords } of rings) {
      if (far(...box)) continue;
      for (let i = 0; i + 1 < coords.length; i++) {
        const p = coords[i] as LonLat;
        const q = coords[i + 1] as LonLat;
        if (far(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]))) continue;
        const ax = (p[0] - lon0) * kx;
        const ay = (p[1] - lat0) * ky;
        const vx = (q[0] - lon0) * kx - ax;
        const vy = (q[1] - lat0) * ky - ay;
        const len2 = vx * vx + vy * vy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2));
        best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
      }
    }
  return best;
}
