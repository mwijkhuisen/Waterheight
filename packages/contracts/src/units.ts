// Units and datums (catalogue §4.5): plain constants with no schema, so the
// API contract (api.ts) and the web bundle can use them without the registry.

export const DATUMS = ['NAP', 'TAW', 'NHN', 'NN', 'IGN69', 'NGF1884', 'LN02', 'NG95', 'DNG', 'LOCAL', 'MSL'] as const;

/** The unit a provider publishes a series in ("m+NN" and "m+PNP" are metres above that datum). */
export const NATIVE_UNITS = ['cm', 'mm', 'm', 'm+NN', 'm+PNP', 'm³/s', 'l/s'] as const;
export type NativeUnit = (typeof NATIVE_UNITS)[number];

/** Discharge units; every other native unit is a water level. */
export const DISCHARGE_UNITS: readonly NativeUnit[] = ['m³/s', 'l/s'];

/** Factor from the native unit to the canonical one (H in cm, Q in m³/s). */
export const TO_CANONICAL: Readonly<Record<NativeUnit, number>> = {
  cm: 1,
  mm: 0.1,
  m: 100,
  'm+NN': 100,
  'm+PNP': 100,
  'm³/s': 1,
  'l/s': 0.001,
};
