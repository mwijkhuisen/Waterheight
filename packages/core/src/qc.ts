// The QC bitmask (A§6; catalogue §4.8). Bits 1–8 and 128–512 come from the
// provider or the loader's context; 16–64 are our own checks.

export const QC = {
  RAW: 1,
  VALIDATED: 2,
  PROVIDER_SUSPECT: 4,
  ESTIMATED: 8,
  RANGE: 16,
  /** Defined, not evaluated before P5 (needs the stored neighbourhood to stay idempotent). */
  SPIKE: 32,
  /** Defined, not evaluated before P6 (needs a linked neighbour gauge). */
  FROZEN: 64,
  CENSORED: 128,
  FORECAST_ESTIMATE: 256,
  BACKFILLED: 512,
} as const;

export const QC_MAX = 1023;

/** QC bits that make a value suspect (A§6): provider-suspect, our range, spike and frozen checks. */
export const SUSPECT_BITS = QC.PROVIDER_SUSPECT | QC.RANGE | QC.SPIKE | QC.FROZEN;

export type ValueClass = 'stage' | 'level' | 'Q';

/**
 * Plausible canonical values. A stage is a reading above a gauge zero (cm); a
 * level is an absolute height (cm; Swiss lakes reach 1,800 m); Q is m³/s
 * (negative Q and negative stages are legitimate, catalogue §0.3).
 */
const RANGE: Readonly<Record<ValueClass, readonly [number, number]>> = {
  stage: [-2000, 5000],
  level: [-2000, 500_000],
  Q: [-10_000, 100_000],
};

/** The range bit for a canonical value: 0 when plausible, `QC.RANGE` otherwise. The value is kept either way. */
export function rangeBit(kind: ValueClass, value: number): number {
  const [min, max] = RANGE[kind];
  return value >= min && value <= max ? 0 : QC.RANGE;
}
