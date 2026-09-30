// A dense series whose provider step is shorter than the step we store
// (PEGELONLINE 1-minute gauges → 15 minutes). The rule is declared per series
// in the registry (native_step, expected_step) and is a pure function of the
// payload, so overlapping windows and replays give the same rows.

/**
 * Keeps the earliest sample of every UTC bucket of `stepMs`. That is the
 * on-grid sample whenever the provider has it; a missing grid minute falls
 * back to the next sample instead of opening a false gap. A leading bucket
 * whose first sample is off the grid is dropped: the window started inside
 * it, so its earliest sample is not the bucket's. No timestamp or value is
 * ever changed. `samples` must be sorted by `ts` ascending.
 */
export function thin<T extends { ts: number }>(samples: readonly T[], stepMs: number): T[] {
  const kept: T[] = [];
  let bucket = Number.NaN;
  for (const [i, s] of samples.entries()) {
    const b = Math.floor(s.ts / stepMs);
    if (b === bucket) continue;
    bucket = b;
    if (i === 0 && s.ts % stepMs !== 0) continue;
    kept.push(s);
  }
  return kept;
}
