import { useSiteConfig } from '../../../lib/data/api.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { contactHref } from './contact.ts';

// The operator and the contact address of this site (colophon, privacy, accessibility), from /runtime-config.json:
// Caddy fills them in from its environment, so neither is in the repository or the build. Both are text; the address
// is a mailto link only when it is a plain address (contact.ts). Nothing while the file is loading; an alert when it
// failed for good (review round 1), never a page that silently lacks its operator.

export function Contact({ locale }: { locale: Locale }) {
  const query = useSiteConfig();
  if (query.isError) return <p role="alert">{m.data_unavailable({}, { locale })}</p>;
  const config = query.data;
  if (config === undefined) return null;
  const { operator, contact } = config;
  const href = contactHref(contact);
  const unset = m.colophon_not_configured({}, { locale });
  return (
    <>
      <p>
        {m.colophon_operator({}, { locale })}: {operator ?? unset}
      </p>
      <p>
        {m.colophon_contact({}, { locale })}:{' '}
        {contact === undefined ? unset : href === undefined ? contact : <a href={href}>{contact}</a>}
      </p>
    </>
  );
}
