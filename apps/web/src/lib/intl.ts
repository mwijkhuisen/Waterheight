import type { Locale } from '../paraglide/runtime.js';

// The page's Intl objects (O3, issue #219): building a formatter costs far more than a format call, and a table row or
// a chart axis formats on every time step. Each use keeps one object per page language, made on first call; its output
// is that of a fresh object with the same options.

/** The tag of the page's language for Intl: Dutch, and English as written in Britain. */
export const intlLocale = (locale: Locale): string => (locale === 'nl' ? 'nl-NL' : 'en-GB');

/** `make(locale)` once per page language. */
export function perLocale<T>(make: (locale: Locale) => T): (locale: Locale) => T {
  const made = new Map<Locale, T>();
  return (locale) => {
    let value = made.get(locale);
    if (value === undefined) {
      value = make(locale);
      made.set(locale, value);
    }
    return value;
  };
}
