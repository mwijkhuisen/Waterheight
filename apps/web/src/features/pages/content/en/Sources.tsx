import { MapCredits } from '../../parts/MapCredits.tsx';
import { PageLink } from '../../parts/PageLink.tsx';
import { SourcesList } from '../../parts/SourcesList.tsx';

export default function Sources() {
  return (
    <>
      <h1>Sources and licences</h1>
      <p>
        Every value, forecast and warning class on this site comes from sources that water authorities publish. Below is
        each source the site shows, with its provider, its licence and the credit its provider asks for, in every
        language the provider gives it in. Where a licence asks for a date (of the last update, of the retrieval or the
        provider's reference date), that date is shown; where it is not known, the entry says “date unknown”. A credit
        that the provider only recommends is marked as such.
      </p>
      <p>
        This site is not endorsed by Rijkswaterstaat or any other provider and is not an official warning service: read{' '}
        <PageLink id="disclaimer" locale="en">
          the disclaimer
        </PageLink>
        .
      </p>

      <h2>Sources</h2>
      <SourcesList locale="en" />

      <h2>Notes</h2>
      <ul>
        <li>
          Rijkswaterstaat data are published under CC0 (Creative Commons Zero) and may be used freely. The credit is
          still given above for every source.
        </li>
        <li>
          For Switzerland, the Naturgefahrenbulletin at{' '}
          <a href="https://www.naturgefahren.ch/" rel="noopener noreferrer">
            naturgefahren.ch
          </a>{' '}
          is the authoritative channel. The BAFU data on this site are measurements as the provider publishes them, not
          validated.
        </li>
        <li>
          How classes, heights and forecasts come about is explained on the{' '}
          <PageLink id="method" locale="en">
            Method
          </PageLink>{' '}
          page; how fresh each source's data are is shown on the{' '}
          <PageLink id="status" locale="en">
            Source status
          </PageLink>{' '}
          page.
        </li>
      </ul>

      <h2>Map and river network</h2>
      <MapCredits locale="en" />
    </>
  );
}
