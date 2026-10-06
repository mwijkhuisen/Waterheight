import type { StateBasis } from '@rws/contracts';
import type { Locale } from '../../paraglide/runtime.js';

// STUB (lead, P10a): S4 builds the label lookup (plan T-i18n, V2, C10) over the generated catalogue
// (`lbl_<source>_<scale>_<code>` messages, labels-index.gen.ts) and, on the owner site, the lazy owner labels
// (features/owner/labels.gen.ts, through useOwnerLabels). Every lookup on data goes through a null-prototype map with
// Object.hasOwn; an unknown key is `undefined` (the caller shows the raw provider text only).

/** The BE-3 and LU-4 translations of the owner chunk: `{nl, en}`, each a null-prototype map keyed like the index. */
export type OwnerLabels = { readonly nl: Readonly<Record<string, string>>; readonly en: Readonly<Record<string, string>> };

/**
 * Our NL/EN text for a state basis (V2): a gauge class by CLASS_SCALE with its `XX:` prefix stripped (exact code,
 * else the `*` row), NL-4 by (`stem`, ref), an area by AREA_SCALE and the area feature's `levelRaw`, a single-part
 * operational or statistical ref by (`reference`, kind). Undefined when there is none (raw only).
 */
export function basisLabel(
  _basis: Pick<StateBasis, 'source' | 'kind' | 'ref'>,
  _locale: Locale,
  _ctx: { areaLevelRaw?: string | null | undefined; owner?: OwnerLabels | undefined } = {},
): string | undefined {
  return undefined;
}

/** Our text for a recent.json reference (source, `reference`, kind; FR-5 `CRUE_*` → `CRUE`); undefined when none. */
export function referenceLabel(_source: string, _kind: string, _locale: Locale, _owner?: OwnerLabels): string | undefined {
  return undefined;
}

/** The LHP legend colour of a DE-6 class (`station` or `alert` scale), from registry/labels/DE-6.yaml `color`. */
export function lhpColour(_scale: 'station' | 'alert', _code: string): string | undefined {
  return undefined;
}

/** A river's name from the generated `river_<id>` message; undefined for an id the catalogue lacks. */
export function riverName(_id: string, _locale: Locale): string | undefined {
  return undefined;
}

/** The owner labels once the owner chunk has loaded (owner site only); undefined on the public site. */
export function useOwnerLabels(): OwnerLabels | undefined {
  return undefined;
}
