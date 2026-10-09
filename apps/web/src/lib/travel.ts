import { numberText } from '../features/pages/parts/numbers.ts';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';

// The one travel-time formatter (P11a, issue #26 C1; catalogue §3.7): a sourced prior as "indicatief"/"indicative"
// text in the source's own unit. No conversion, no arithmetic, never relative to now and never an arrival time.
// Pure. Messages are called by name with parameters (never indexed by a computed key).

export type TravelUnit = 'h' | 'd';

/** A sourced label, one string or one per language (a "month year" is allowed in it). */
export type TravelLabel = string | Readonly<Record<Locale, string>>;

export type TravelPrior =
  /** `label` names a sourced rounder figure or condition shown beside the range (e.g. "about 1.5 days"). */
  | { kind: 'range'; lo: number; hi: number; unit: TravelUnit; derived?: boolean; label?: TravelLabel }
  /** `label` names the event or condition the value holds for (required; may hold a "month year"). */
  | { kind: 'single'; value: number; unit: TravelUnit; label: TravelLabel; derived?: boolean }
  /** A §3.7 figure that is not sourced well enough to show: no text. */
  | { kind: 'unverified' };

/** The text of a prior, or null when it has none to show (the row then says "geen bronwaarde / no sourced value"). */
export function travelText(prior: TravelPrior, locale: Locale): string | null {
  if (prior.kind === 'unverified') return null;
  const o = { locale };
  const label = (l: TravelLabel): string => (typeof l === 'string' ? l : l[locale]);
  let text: string;
  if (prior.kind === 'range') {
    const p = { lo: numberText(prior.lo, locale), hi: numberText(prior.hi, locale) };
    text = prior.unit === 'h' ? m.travel_range(p, o) : m.travel_range_d(p, o);
    if (prior.label !== undefined) text = m.travel_labelled({ text, label: label(prior.label) }, o);
  } else {
    const p = { value: numberText(prior.value, locale) };
    text = prior.unit === 'h' ? m.travel_single_h(p, o) : m.travel_single_d(p, o);
    text = m.travel_labelled({ text, label: label(prior.label) }, o);
  }
  return prior.derived ? m.travel_derived({ text }, o) : text;
}
