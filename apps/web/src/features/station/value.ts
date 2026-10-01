import { type SeriesMeta as Meta, TO_CANONICAL } from '@rws/contracts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

// The API sends canonical values (H in cm, Q in m³/s); the page shows each
// value as its provider publishes it (catalogue §4.2, §4.7): back in the native
// unit, with the unit verbatim and the zero it is measured from. A DE-1 stage is
// cm above the gauge zero (PNP, the German Pegelnullpunkt), an NL-1 level is cm
// NAP, a few DE-1 levels are m+NN: they are never put on one scale.

/** canonical = native × TO_CANONICAL (catalogue §4.5), so native = canonical ÷ it. */
export const nativeValue = (value: number, series: Pick<Meta, 'nativeUnit'>): number =>
  value / TO_CANONICAL[series.nativeUnit];

/**
 * The unit as published plus what it is measured from: "cm NAP", "cm boven peilnul (PNP)", "m+NN", "m³/s".
 * "PNP" is the German name of a gauge zero, so only a German source's stage carries it.
 */
export function unitLabel(series: Pick<Meta, 'nativeUnit' | 'valueKind' | 'datum' | 'source'>, locale: Locale): string {
  if (series.valueKind === 'stage') {
    const zero = series.source.startsWith('DE-') ? m.stage_ref_pnp({}, { locale }) : m.stage_ref({}, { locale });
    return `${series.nativeUnit} ${zero}`;
  }
  // "m+NN" already names its datum.
  if (series.datum === null || series.nativeUnit.includes('+')) return series.nativeUnit;
  return `${series.nativeUnit} ${series.datum}`;
}

/** A number as the page shows it: at most two decimals, in the page's locale. */
export const formatNumber = (n: number, locale: Locale): string =>
  new Intl.NumberFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { maximumFractionDigits: 2 }).format(n);

/** A canonical value from the API, shown in its native unit. */
export const formatValue = (value: number, series: Pick<Meta, 'nativeUnit'>, locale: Locale): string =>
  formatNumber(nativeValue(value, series), locale);
