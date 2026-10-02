// How well two series of one gauge agree when one is shifted in time: the twin check's lag (A§7.4 step 7) and
// the LU-1 label offset (step 8) both ask it. Pure; the callers read the rows.

export type Point = { ts: number; value: number };

export type ShiftScore = {
  /** Minutes added to a's timestamps to meet b's. */
  shift: number;
  /** a's points that have a b point at a.ts + shift. */
  n: number;
  /** The share of those whose a − b is within `tolerance` of `expected` (0 when n is 0). */
  share: number;
};

/** One score per shift (minutes), on exact timestamps: a's points against b's at a.ts + shift. */
export function scoreShifts(
  a: readonly Point[],
  b: readonly Point[],
  shifts: readonly number[],
  { expected = 0, tolerance }: { expected?: number; tolerance: number },
): ShiftScore[] {
  const at = new Map(b.map((p) => [p.ts, p.value]));
  return shifts.map((shift) => {
    let n = 0;
    let within = 0;
    for (const p of a) {
      const v = at.get(p.ts + shift * 60_000);
      if (v === undefined) continue;
      n += 1;
      // A float tolerance: the stored values are `real`.
      if (Math.abs(p.value - v - expected) <= tolerance + 1e-6) within += 1;
    }
    return { shift, n, share: n === 0 ? 0 : within / n };
  });
}

/** −max … +max in steps of `step` minutes. */
export const shiftsWithin = (max: number, step: number): number[] =>
  Array.from({ length: (2 * max) / step + 1 }, (_, i) => i * step - max);
