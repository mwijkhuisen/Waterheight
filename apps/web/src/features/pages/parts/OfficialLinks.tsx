import { Fragment } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { OFFICIAL } from '../official.ts';
import { type Country, countryName } from './country.ts';

// The official warning service of each country (About and Disclaimer): its name from the messages, then the links as
// the host they lead to. Plain anchors: no target, no image, no icon (the list is official.ts).

/** What the services of a country are, in a language (a switch: Paraglide's `m` is never indexed by a computed key). */
function describe(country: Country, locale: Locale): string {
  switch (country) {
    case 'NL':
      return m.official_nl({}, { locale });
    case 'DE':
      return m.official_de({}, { locale });
    case 'BE':
      return m.official_be({}, { locale });
    case 'FR':
      return m.official_fr({}, { locale });
    case 'LU':
      return m.official_lu({}, { locale });
    case 'CH':
      return m.official_ch({}, { locale });
  }
}

export function OfficialLinks({ locale }: { locale: Locale }) {
  return (
    <ul>
      {OFFICIAL.map(({ country, hrefs }) => (
        <li key={country}>
          <strong>{countryName(country, locale)}</strong>:{' '}
          {hrefs.map((href, i) => (
            <Fragment key={href}>
              {i > 0 && ', '}
              <a href={href} rel="noopener noreferrer">
                {new URL(href).host}
              </a>
            </Fragment>
          ))}{' '}
          – {describe(country, locale)}.
        </li>
      ))}
    </ul>
  );
}
