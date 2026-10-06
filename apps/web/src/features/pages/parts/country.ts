import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';

/** The countries of the site's rivers, as the data files name them (stations.json, status.json). */
export const COUNTRIES = ['NL', 'DE', 'BE', 'FR', 'LU', 'CH'] as const;
export type Country = (typeof COUNTRIES)[number];

/** A country's name in a language (a switch: Paraglide's `m` is never indexed by a computed key). */
export function countryName(country: Country, locale: Locale): string {
  switch (country) {
    case 'NL':
      return m.country_nl({}, { locale });
    case 'DE':
      return m.country_de({}, { locale });
    case 'BE':
      return m.country_be({}, { locale });
    case 'FR':
      return m.country_fr({}, { locale });
    case 'LU':
      return m.country_lu({}, { locale });
    case 'CH':
      return m.country_ch({}, { locale });
  }
}
