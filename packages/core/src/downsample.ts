// A dense series whose provider step is shorter than the step we store
// (PEGELONLINE 1-minute gauges → 15 minutes). The rule is declared per series
// in the registry (native_step, expected_step) and is a pure function of each
// sample, so overlapping windows, in any order, and replays give the same rows.

/**
 * Keeps the on-grid samples only: those whose timestamp is a whole multiple of
 * `stepMs` (UTC epoch). A grid minute the provider did not publish is a gap,
 * which the coverage number shows; it is never filled with a neighbour, because
 * which neighbour a window holds depends on the window. No timestamp or value is
 * ever changed.
 */
export function thin<T extends { ts: number }>(samples: readonly T[], stepMs: number): T[] {
  return samples.filter((s) => s.ts % stepMs === 0);
}
