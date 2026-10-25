import { intlLocale, perLocale } from '../../../lib/intl.ts';
import type { Locale } from '../../../paraglide/runtime.js';

// Numbers and fractions for the data tables of the Sources, Status and Method pages (P10b): always through Intl, in
// the page's own language. Pure.

export { intlLocale };

const NUMBER = perLocale((l) => new Intl.NumberFormat(intlLocale(l)));
const PERCENT = perLocale((l) => new Intl.NumberFormat(intlLocale(l), { style: 'percent', maximumFractionDigits: 1 }));
const LIST = perLocale((l) => new Intl.ListFormat(intlLocale(l), { style: 'long', type: 'conjunction' }));

export const numberText = (n: number, locale: Locale): string => NUMBER(locale).format(n);

/**
 * A share as a percentage, cut down (never rounded up) to one decimal, so that a coverage of 99.96 % is not shown
 * as 100 %. The 1e-9 keeps a float such as 0.29 * 1000 = 289.99999999999994 from losing a tenth.
 */
export const percentText = (ratio: number, locale: Locale): string =>
  PERCENT(locale).format(Math.floor(ratio * 1000 + 1e-9) / 1000);

/** "8/10 (80%)"; no percentage when there is nothing to divide by. */
export function fractionText(part: number, whole: number, locale: Locale): string {
  const counts = `${numberText(part, locale)}/${numberText(whole, locale)}`;
  return whole === 0 ? counts : `${counts} (${percentText(part / whole, locale)})`;
}

/** "A, B and C" in the page's language. */
export const listText = (items: readonly string[], locale: Locale): string => LIST(locale).format(items);
