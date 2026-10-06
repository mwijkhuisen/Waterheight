import { Contact } from '../../parts/Contact.tsx';
import { MapCredits } from '../../parts/MapCredits.tsx';
import { PageLink } from '../../parts/PageLink.tsx';

export default function Colophon() {
  return (
    <>
      <h1>Colophon</h1>

      <h2>Who runs this site</h2>
      <Contact locale="en" />

      <h2>Source code</h2>
      <p>
        The source code is available under the{' '}
        <a href="https://polyformproject.org/licenses/strict/1.0.0" rel="noopener noreferrer">
          PolyForm Strict License 1.0.0
        </a>
        : reading and non-commercial use, no redistribution or changes.
      </p>

      <h2>Map and rivers</h2>
      <MapCredits locale="en" />

      <h2>Sources and third-party software</h2>
      <p>
        Which sources we use and under which licence is on the page{' '}
        <PageLink id="sources" locale="en">
          Sources and licences
        </PageLink>
        . The licences of the third-party software in this site are in a text file:{' '}
        <a href="/third-party-notices.txt">Third-party software licences</a>.
      </p>

      <h2>No trackers</h2>
      <p>
        This site is built without trackers and without third-party services: every file, the map tiles included, comes
        from this site itself. More on the page{' '}
        <PageLink id="privacy" locale="en">
          Privacy
        </PageLink>
        .
      </p>
    </>
  );
}
