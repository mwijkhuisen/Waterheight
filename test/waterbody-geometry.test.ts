import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LonLat } from '../tools/geo/rivernet/network.ts';
import { contains, prepareArea, shoreDistance } from '../tools/geo/rivernet/polygon.ts';

// P17b: the water-body geometry of tools/geo/rivernet/polygon.ts on shapes small enough to check by hand.

const square = (w: number, s: number, e: number, n: number): LonLat[] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
// A lake with an island (hole), and a second polygon of the same multipolygon 0.1 degree east.
const lake = prepareArea({
  id: 'meer',
  polygons: [
    [square(4.99, 50.99, 5.01, 51.01), square(4.998, 50.998, 5.002, 51.002)],
    [square(5.09, 50.99, 5.11, 51.01)],
  ],
});
// Metres per degree of the local equirectangular metric (snap.ts) at a latitude.
const kx = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
const KY = 110_574;

describe('contains', () => {
  it('is inside the outer ring, outside in a hole, inside the second polygon, outside elsewhere', () => {
    expect(contains(lake, [4.995, 51])).toBe(true);
    expect(contains(lake, [5, 51])).toBe(false); // the island
    expect(contains(lake, [5.1, 51])).toBe(true);
    expect(contains(lake, [5.05, 51])).toBe(false);
    expect(contains(lake, [4.995, 51.05])).toBe(false);
  });

  it('is half-open on the boundary, where the shore distance is 0', () => {
    expect(contains(lake, [4.99, 51])).toBe(true); // the west edge
    expect(contains(lake, [5.01, 51])).toBe(false); // the east edge
    expect(shoreDistance(lake, [4.99, 51])).toBe(0);
    expect(shoreDistance(lake, [5.01, 51])).toBe(0);
  });
});

describe('shoreDistance', () => {
  it('is the metres to the nearest edge, a hole edge or a corner', () => {
    // 0.01 degree east of the first polygon's east edge, 0.07 west of the second's west edge.
    expect(shoreDistance(lake, [5.02, 51])).toBeCloseTo(0.01 * kx(51), 6);
    // On the island, 0.002 degree from its west and east edges (140 m) and 0.002 from north and south (221 m).
    expect(shoreDistance(lake, [5, 51])).toBeCloseTo(0.002 * kx(51), 6);
    // North-east of the first polygon's north-east corner.
    expect(shoreDistance(lake, [5.02, 51.02])).toBeCloseTo(Math.hypot(0.01 * kx(51.02), 0.01 * KY), 6);
  });

  it('skips what lies beyond the limit, and is exact within it', () => {
    const d = 0.01 * kx(51); // about 700.6 m
    expect(shoreDistance(lake, [5.02, 51], 500)).toBeGreaterThan(500);
    expect(shoreDistance(lake, [5.02, 51], 800)).toBeCloseTo(d, 6);
  });

  it('property: the bounded distance equals a brute force over every segment', () => {
    const coord = fc.tuple(
      fc.double({ min: 4.95, max: 5.05, noNaN: true }),
      fc.double({ min: 50.95, max: 51.05, noNaN: true }),
    );
    const ring = fc.array(coord, { minLength: 3, maxLength: 8 }).map((pts) => [...pts, pts[0] as LonLat]);
    fc.assert(
      fc.property(
        fc.array(fc.array(ring, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }),
        coord,
        fc.double({ min: 1, max: 5000, noNaN: true }),
        (polygons, at, limit) => {
          const area = prepareArea({ id: 'x', polygons });
          let brute = Number.POSITIVE_INFINITY;
          for (const r of polygons.flat())
            for (let i = 0; i + 1 < r.length; i++) {
              const [p, q] = [r[i] as LonLat, r[i + 1] as LonLat];
              const [ax, ay] = [(p[0] - at[0]) * kx(at[1]), (p[1] - at[1]) * KY];
              const [vx, vy] = [(q[0] - at[0]) * kx(at[1]) - ax, (q[1] - at[1]) * KY - ay];
              const l2 = vx * vx + vy * vy;
              const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2));
              brute = Math.min(brute, Math.hypot(ax + t * vx, ay + t * vy));
            }
          expect(shoreDistance(area, at)).toBe(brute);
          const bounded = shoreDistance(area, at, limit);
          if (brute <= limit) expect(bounded).toBe(brute);
          else expect(bounded).toBeGreaterThan(limit);
        },
      ),
      { numRuns: 300 },
    );
  });
});
