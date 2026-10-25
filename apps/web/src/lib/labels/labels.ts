import type { Locale } from '../../paraglide/runtime.js';
import { LHP_COLOURS, RIVER_LABELS } from './labels-index.gen.ts';

// The label lookup (plan V2, C10) over the generated catalogue: our NL/EN text for a provider class, area class or
// reference kind. The key of a message comes only from a generated null-prototype map (never from data), every lookup
// on data uses Object.hasOwn, and an unknown key is `undefined` (the caller shows the raw provider text only).
// Owner-source labels (BE-3, LU-4) resolve only through the lazy owner chunk (`OwnerLabels`). The basis lookups are in
// basis.ts (O4), out of the entry; this file keeps what the eager legend and river chips use.

/** The BE-3 and LU-4 translations of the owner chunk: `{nl, en}`, each a null-prototype map keyed like the index. */
export type OwnerLabels = {
  /** (source, scale, code) → key: in the owner chunk, so the owner sources' ids are not in the public bundle. */
  readonly keys: Readonly<Record<string, string>>;
  readonly nl: Readonly<Record<string, string>>;
  readonly en: Readonly<Record<string, string>>;
};

export const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/** The LHP legend colour of a DE-6 class (`station` or `alert` scale), from registry/labels/DE-6.yaml `color`. */
export function lhpColour(scale: 'station' | 'alert', code: string): string | undefined {
  return own(LHP_COLOURS, `${scale}\n${code}`);
}

/** A river's name from the generated `river_<id>` message; undefined for an id the catalogue lacks. */
export function riverName(id: string, locale: Locale): string | undefined {
  return own(RIVER_LABELS, id)?.({}, { locale });
}
