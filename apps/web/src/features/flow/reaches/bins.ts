// The position bins of the reach colouring (#112 item 2, KG-271): the tile layer `reach_bins` (tools/geo/rivernet/
// bins.ts) cuts each drawn reach into n equal bins, n = ⌊length / 500 m⌋ clamped to 1…8, from zoom BIN_MINZOOM on;
// the same rule here (the web cannot import tools/geo), pinned equal by test/reach-bins.test.ts. Bin i's feature id is
// `<reach_id>/<i>` (promoteId `seg`).

export const BIN_M = 500;
export const BIN_MAX = 8;
export const BIN_MINZOOM = 8;
export const BINS_LAYER = 'reach_bins';

/** The bins of a reach of `lengthKm` (the reaches file's 3-decimal km): 1…8; a null length is 1. */
export function binCount(lengthKm: number | null): number {
  if (lengthKm === null) return 1;
  return Math.min(BIN_MAX, Math.max(1, Math.floor(Math.round(lengthKm * 1000) / BIN_M)));
}

/** The feature id of bin `i` of a reach. */
export const segOf = (reachId: string, i: number): string => `${reachId}/${i}`;
