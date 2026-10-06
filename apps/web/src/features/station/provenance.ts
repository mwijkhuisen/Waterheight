import { attributionText } from '../../lib/attribution.ts';
import { formatDay } from '../../lib/time/time.ts';
import type { Locale } from '../../paraglide/runtime.js';

// Provenance of a series in the panel: the credit lines of its source (sources.json) and the Δh text. Pure.
// Credit text is the registry's, shown as a text node; a link only when it is https.

interface CreditSource {
  attribution: readonly { lang: 'nl' | 'en' | 'de' | 'fr' | null; text: string; url: string | null }[];
  dateKind: string | null;
  date: string | null;
  dateText: string | null;
}

export const httpsUrl = (url: string | null): string | undefined => {
  if (url === null) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

/** The credit lines in the page's language (else the language-neutral ones, else all), with the licence's own date. */
export function creditLines(
  source: CreditSource,
  locale: Locale,
): { lang: string | null; text: string; href: string | undefined }[] {
  const own = source.attribution.filter((a) => a.lang === locale);
  const neutral = source.attribution.filter((a) => a.lang === null);
  const rows = own.length > 0 ? own : neutral.length > 0 ? neutral : source.attribution;
  const date =
    source.dateText ??
    (source.date === null ? undefined : formatDay(Date.parse(source.date), locale, 'Europe/Amsterdam'));
  return rows.map((a) => ({
    lang: a.lang,
    text: date === undefined ? a.text : attributionText(a.text, source.dateKind !== null, date),
    href: httpsUrl(a.url),
  }));
}

export type Trend = 'rising' | 'falling' | 'steady';

/** "+12 cm" / "-0,5 m³/s": a signed change in the canonical unit of its quantity. */
export function dhValue(dh: number, quantity: 'H' | 'Q', locale: Locale): string {
  const n = new Intl.NumberFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', {
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
  }).format(dh);
  return `${n} ${quantity === 'H' ? 'cm' : 'm³/s'}`;
}

/** The glyph of a trend (decorative: the word always follows it). */
export const trendGlyph = (trend: Trend): string => (trend === 'rising' ? '▲' : trend === 'falling' ? '▼' : '►');
