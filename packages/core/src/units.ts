// Units and canonical factors (catalogue §4.5): H is stored in cm, Q in m³/s.
// The unit belongs to the series declaration in the registry, never to a row.

export type Quantity = 'H' | 'Q';

export type UnitDef = {
  quantity: Quantity;
  /** Provider value × factor = canonical value. */
  factor: number;
  /**
   * `level` (an absolute height) or `stage` (above the gauge zero) where the
   * unit itself says so; null where the series declares it, and for Q.
   */
  kind: 'stage' | 'level' | null;
};

export const UNITS = {
  cm: { quantity: 'H', factor: 1, kind: null },
  mm: { quantity: 'H', factor: 0.1, kind: null },
  m: { quantity: 'H', factor: 100, kind: null },
  /** PEGELONLINE: absolute height in m above NN (canal and Ruhr series). */
  'm+NN': { quantity: 'H', factor: 100, kind: 'level' },
  /** PEGELONLINE: metres above the gauge zero (two dam series). */
  'm+PNP': { quantity: 'H', factor: 100, kind: 'stage' },
  'm³/s': { quantity: 'Q', factor: 1, kind: null },
  /** RWS spells it without the superscript. */
  'm3/s': { quantity: 'Q', factor: 1, kind: null },
  'l/s': { quantity: 'Q', factor: 0.001, kind: null },
} as const satisfies Record<string, UnitDef>;

export type Unit = keyof typeof UNITS;

export const isUnit = (unit: string): unit is Unit => Object.hasOwn(UNITS, unit);

/**
 * Seven significant digits: what a PostgreSQL `real` holds. It keeps golden
 * files free of binary noise (1203 mm × 0.1 is 120.3, not 120.30000000000001).
 */
const tidy = (v: number) => Number(v.toPrecision(7));

/** A provider value times the factor its series declares in the registry (`to_canonical`). */
export function scale(factor: number, value: number): number {
  return tidy(value * factor);
}

export function toCanonical(unit: Unit, value: number): number {
  return scale(UNITS[unit].factor, value);
}

export function fromCanonical(unit: Unit, value: number): number {
  return tidy(value / UNITS[unit].factor);
}
