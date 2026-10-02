// Sentinels (A§6): values a provider publishes instead of "no data". They are
// dropped before unit conversion and never stored. Only plain numeric
// sentinels live here; the others are part of their adapter's parser (RWS
// quality code 99 with 0.0, KiWIS null/-1, SPW datum 9999.0, NRW "NA", BAFU
// 0.0 at a CH-1 level series).

export const SENTINELS: Readonly<Record<string, readonly number[]>> = {
  'DE-1': [99999],
  'DE-9': [-888],
  'BE-2': [-10000],
};

export function isSentinel(source: string, value: number): boolean {
  return SENTINELS[source]?.includes(value) ?? false;
}
