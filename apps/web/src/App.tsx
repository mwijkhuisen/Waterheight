import { m } from './paraglide/messages.js';
import type { Locale } from './paraglide/runtime.js';

const other = { nl: { href: '/en/', lang: 'en' }, en: { href: '/', lang: 'nl' } } as const;

export function App({ locale }: { locale: Locale }) {
  const link = other[locale];
  return (
    <>
      <h1>{m.hello({}, { locale })}</h1>
      <p>
        <a href={link.href} hrefLang={link.lang} lang={link.lang}>
          {m.other_language({}, { locale })}
        </a>
      </p>
    </>
  );
}
