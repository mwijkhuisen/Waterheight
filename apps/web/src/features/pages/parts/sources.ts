import { attributionText } from '../../../lib/attribution.ts';
import type { WebSource } from '../../../lib/data/contracts.ts';
import { httpsHref } from '../../../lib/href.ts';
import { formatDay, ZONE } from '../../../lib/time/time.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';

// The Sources page's logic (P10b), pure. Nothing here is keyed to a source id: a source that turns public later is
// listed, with its credits, by the same code.

/**
 * A licence kind in words: a static switch over the kinds of the public sources (a computed key is never used on
 * Paraglide's `m`). Any other kind, including the personal-use kinds of the owner site, is shown as the registry
 * spells it, so that their names stay out of the public bundle.
 */
export function licenceLabel(kind: string, locale: Locale): string {
  const o = { locale };
  switch (kind) {
    case 'cc0':
      return m.licence_cc0({}, o);
    case 'dl-de-zero-2.0':
      return m.licence_dl_de_zero_2_0({}, o);
    case 'etalab-2.0':
      return m.licence_etalab_2_0({}, o);
    case 'cc-by':
      return m.licence_cc_by({}, o);
    case 'cc-by-sa-4.0':
      return m.licence_cc_by_sa_4_0({}, o);
    case 'ch-open-use':
      return m.licence_ch_open_use({}, o);
    default:
      return kind;
  }
}

/** The host of an https link: the link text where the data gives none. */
export const hostOf = (href: string): string => new URL(href).host;

/** The licence line: the kind's words (else the host of the terms page) and the terms link, https only. */
export function licenceLine(
  licence: WebSource['licence'],
  locale: Locale,
): { text: string | undefined; href: string | undefined } {
  const href = httpsHref(licence.url);
  const kind = licence.kind === null ? undefined : licenceLabel(licence.kind, locale);
  return { text: kind ?? (href === undefined ? undefined : hostOf(href)), href };
}

export interface AttributionRow {
  lang: 'nl' | 'en' | 'de' | 'fr' | null;
  /** Plain text: the registry's credit with its date (a text node, never HTML). */
  text: string;
  href: string | undefined;
  required: boolean;
}

/** The date a credit shows: the provider's own text (DE-6 "Stand: …"), else the day of the source's date. */
export const sourceDate = (s: Pick<WebSource, 'date' | 'dateText'>, locale: Locale): string | undefined =>
  s.dateText ?? (s.date === null ? undefined : formatDay(Date.parse(s.date), locale, ZONE));

/**
 * Every attribution row of a source, in every language it has. Where the licence asks for a date (`dateKind`) the
 * date takes the place of the placeholder or follows the text; a source that needs one and has none says so.
 */
export function attributionRows(s: WebSource, locale: Locale): AttributionRow[] {
  const needsDate = s.dateKind !== null;
  const date = sourceDate(s, locale) ?? m.src_date_unknown({}, { locale });
  return s.attribution.map((a) => ({
    lang: a.lang,
    text: attributionText(a.text, needsDate, date),
    href: httpsHref(a.url),
    required: a.required,
  }));
}
