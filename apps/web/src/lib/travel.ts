import type { Locale } from '../paraglide/runtime.js';

// The one travel-time formatter (P11a, issue #26 C1; catalogue §3.7): a sourced prior as "indicatief"/"indicative"
// text in the source's own unit. No conversion, no arithmetic, never relative to now and never an arrival time.
// Pure. STUB (L0): W4 implements it.

export type TravelUnit = 'h' | 'd';

export type TravelPrior =
  | { kind: 'range'; lo: number; hi: number; unit: TravelUnit; derived?: boolean }
  /** `label` names the event or condition the value holds for (required; may hold a "month year"). */
  | { kind: 'single'; value: number; unit: TravelUnit; label: string; derived?: boolean }
  /** A §3.7 figure that is not sourced well enough to show: no text. */
  | { kind: 'unverified' };

/** The text of a prior, or null when it has none to show (the row then says "geen bronwaarde / no sourced value"). */
export function travelText(prior: TravelPrior, locale: Locale): string | null {
  void locale;
  return prior.kind === 'unverified' ? null : null;
}
