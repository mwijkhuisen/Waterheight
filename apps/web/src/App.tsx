import { m } from './paraglide/messages.js';
import type { Locale } from './paraglide/runtime.js';

const other = { nl: { href: '/en/', lang: 'en' }, en: { href: '/', lang: 'nl' } } as const;

// The P1 placeholder: what the site is and that it is not a warning service.
export function App({ locale }: { locale: Locale }) {
  const link = other[locale];
  return (
    <>
      <h1>{m.heading({}, { locale })}</h1>
      <p>{m.intro({}, { locale })}</p>
      <p>{m.not_official({}, { locale })}</p>
      <p>
        <a href={link.href} hrefLang={link.lang} lang={link.lang}>
          {m.other_language({}, { locale })}
        </a>
      </p>
    </>
  );
}
