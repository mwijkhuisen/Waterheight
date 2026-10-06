import type { Mode } from '../../lib/url/url.ts';
import type { Locale } from '../../paraglide/runtime.js';

// STUB (lead, P10a): S3 builds the legend (plan T2): per mode, collapsible (<details>/<summary>), over the map and
// above the table, with the honesty note, the NL-4 note and the stale/suspect/tidal/impounded/section/owner keys.

export interface LegendProps {
  locale: Locale;
  mode: Mode;
  /** t is after now: the forecast marker key replaces the value keys. */
  forecast: boolean;
  /** Owner site: the "owner only" key is shown. */
  owner: boolean;
  /** Warning areas are on the map at t (their key is shown). */
  warnings: boolean;
}

export function Legend(_: LegendProps) {
  return null;
}
