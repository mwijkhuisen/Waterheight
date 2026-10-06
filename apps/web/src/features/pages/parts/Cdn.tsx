import { useSiteConfig } from '../../../lib/data/api.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';

// Whether a CDN stands in front of this site (privacy page): the name Caddy fills in from RWS_CDN_NAME, as text;
// an empty one is "no CDN". A missing one is not "no CDN": the config parse drops a malformed value to missing, and a
// privacy page must not then say there is none. Nothing while the file is loading.

export function Cdn({ locale }: { locale: Locale }) {
  const config = useSiteConfig();
  if (config === undefined) return null;
  const { cdn } = config;
  return (
    <p>
      {cdn === undefined
        ? m.privacy_cdn_unknown({}, { locale })
        : cdn === ''
          ? m.privacy_cdn_none({}, { locale })
          : m.privacy_cdn_named({ name: cdn }, { locale })}
    </p>
  );
}
