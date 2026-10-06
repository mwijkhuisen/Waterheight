import type { WebSource } from '../../lib/data/contracts.ts';
import { httpsHref } from '../../lib/href.ts';
import { formatDay } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

// The basis on which an owner-audience source may be shown to the owner (catalogue §0.8), on the Sources page of the
// owner site: the clause verbatim, a link to the terms and the day they were read. It lives in the owner chunk (the
// one the layout loads for the banner), so the public build never contains it; provider text is text only.

export function OwnerBasis({ locale, basis }: { locale: Locale; basis: NonNullable<WebSource['privateBasis']> }) {
  const o = { locale };
  const href = httpsHref(basis.url);
  return (
    <p>
      <strong>{m.src_basis_heading({}, o)}</strong> {basis.clause}{' '}
      {href === undefined ? (
        basis.url
      ) : (
        <a href={href} rel="noopener noreferrer">
          {m.owner_terms_link({}, o)}
        </a>
      )}{' '}
      ({m.owner_retrieved({ date: formatDay(Date.parse(basis.retrieved), locale) }, o)})
    </p>
  );
}
