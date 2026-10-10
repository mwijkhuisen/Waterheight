import { haversine, type LonLat } from './network.ts';
import { sliceLine } from './reaches.ts';

// Position bins of the reach colouring (#112 item 2, KG-271): each drawn public reach is cut into n equal parts
// along its line, n = ⌊length / 500 m⌋ clamped to 1…8 (a bin is 500 m or 1/8 of the reach, whichever is longer),
// for the `reach_bins` tile layer; the web paints each bin with the span value at its centre. The web holds the
// same rule (apps/web/src/features/flow/reaches/bins.ts), pinned equal by test/reach-bins.test.ts. A bin carries
// a per-feature minzoom: below it the per-reach colouring of the `rivers` layer paints, which keeps the low zooms,
// where all reaches share a few tiles, inside tippecanoe's per-tile limits.

export const BIN_M = 500;
export const BIN_MAX = 8;
export const BIN_MINZOOM = 8;

/** The bins of a reach of `lengthKm` (the reaches file's 3-decimal km): 1…8; a null length is 1. */
export function binCount(lengthKm: number | null): number {
  if (lengthKm === null) return 1;
  return Math.min(BIN_MAX, Math.max(1, Math.floor(Math.round(lengthKm * 1000) / BIN_M)));
}

/** The line of each of `n` equal bins along `coords` (haversine metres along the drawn line). */
export function binLines(coords: readonly LonLat[], n: number): LonLat[][] {
  let total = 0;
  for (let i = 0; i + 1 < coords.length; i++) total += haversine(coords[i] as LonLat, coords[i + 1] as LonLat);
  const line = { coords: coords as LonLat[] };
  return Array.from({ length: n }, (_, i) => sliceLine(line, (i * total) / n, ((i + 1) * total) / n));
}
