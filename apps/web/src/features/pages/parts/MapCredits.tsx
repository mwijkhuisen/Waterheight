import { ODBL_URL } from '@rws/contracts';
import { downloadHref, useAudience, useRiversManifest } from '../../../lib/data/api.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';

// The credits of the map itself (the footer of every page, and the Sources page): OpenStreetMap and Protomaps for
// the basemap, and the river network under the ODbL with its download. The footer imports this statically, so the
// licence text is in the entry chunk (scripts/verify-prod.ts `rivers attribution`, plan C9).

export function MapCredits({ locale }: { locale: Locale }) {
  // The owner site serves no /downloads (owner.caddy): the river download is offered on the public site only.
  const owner = useAudience() === 'owner';
  const manifest = useRiversManifest().data;
  const download = owner ? undefined : downloadHref(manifest);
  return (
    <>
      <p>
        <a href="https://www.openstreetmap.org/copyright">{m.osm_credit({}, { locale })}</a> ·{' '}
        {m.protomaps_credit({}, { locale })}
      </p>
      <p>
        {m.rivers_licence_lead({}, { locale })} <a href={ODBL_URL}>{m.rivers_licence_link({}, { locale })}</a>.{' '}
        {m.rivers_collective({}, { locale })}
        {download !== undefined && (
          <>
            {' '}
            <a href={download}>{m.rivers_download({}, { locale })}</a>
          </>
        )}
      </p>
    </>
  );
}
