import { Contact } from '../../parts/Contact.tsx';
import { MapCredits } from '../../parts/MapCredits.tsx';
import { PageLink } from '../../parts/PageLink.tsx';

export default function Colophon() {
  return (
    <>
      <h1>Colofon</h1>

      <h2>Wie beheert deze site</h2>
      <Contact locale="nl" />

      <h2>Broncode</h2>
      <p>
        De broncode is inzichtelijk onder de{' '}
        <a href="https://polyformproject.org/licenses/strict/1.0.0" rel="noopener noreferrer">
          PolyForm Strict License 1.0.0
        </a>
        : lezen en niet-commercieel gebruik, geen herdistributie of wijzigingen.
      </p>

      <h2>Kaart en rivieren</h2>
      <MapCredits locale="nl" />

      <h2>Bronnen en software van derden</h2>
      <p>
        Welke bronnen we gebruiken en onder welke licentie, staat op de pagina{' '}
        <PageLink id="sources" locale="nl">
          Bronnen en licenties
        </PageLink>
        . De licenties van de software van derden in deze site staan in een tekstbestand:{' '}
        <a href="/third-party-notices.txt">Licenties van software van derden</a>.
      </p>

      <h2>Zonder trackers</h2>
      <p>
        Deze site is gebouwd zonder trackers en zonder diensten van derden: alle bestanden, ook de kaarttegels, komen
        van deze site zelf. Meer daarover staat op de pagina{' '}
        <PageLink id="privacy" locale="nl">
          Privacy
        </PageLink>
        .
      </p>
    </>
  );
}
