import { OfficialLinks } from '../../parts/OfficialLinks.tsx';
import { PageLink } from '../../parts/PageLink.tsx';

export default function About() {
  return (
    <>
      <h1>Over deze site</h1>
      <p>
        Deze site toont bijna in real time de waterstanden, de afvoer, officiële verwachtingen en alarmniveaus van de
        rivieren die Nederland binnenstromen. De gegevens komen uit open bronnen in Nederland, Duitsland, België,
        Frankrijk, Luxemburg en Zwitserland en staan op een zelf gehoste kaart. Met de datum- en tijdkiezer kijk je
        terug in de tijd en, waar een bron een verwachting publiceert, ook vooruit.
      </p>
      <p>De site is in bèta: gegevens kunnen ontbreken of onjuist zijn.</p>

      <h2>Geen officiële waarschuwingsdienst</h2>
      <p>
        Deze site is geen officiële waarschuwingsdienst. Lees de{' '}
        <PageLink id="disclaimer" locale="nl">
          disclaimer
        </PageLink>{' '}
        voordat je de gegevens gebruikt, en volg bij hoogwater de officiële diensten hieronder.
      </p>

      <h2>Officiële diensten</h2>
      <p>Voor waarschuwingen en actuele berichten zijn dit de officiële kanalen per land:</p>
      <OfficialLinks locale="nl" />

      <h2>Hoe we gegevens verzamelen</h2>
      <p>
        We halen de gegevens zelf, regelmatig, op bij de openbare gegevensdiensten van de aanbieders. Elke waarde tonen
        we zoals de aanbieder haar publiceert, met de eigen eenheid en het eigen nulpunt van die aanbieder; waarden van
        verschillende stations zijn daardoor niet zonder meer vergelijkbaar.
      </p>
      <p>
        Onze verzoeken aan de aanbieders bevatten een User-Agent die naar deze pagina verwijst. Wil een aanbieder
        contact met ons opnemen, dan vindt die het contactadres op het{' '}
        <PageLink id="colophon" locale="nl">
          colofon
        </PageLink>
        .
      </p>

      <h2>Meer lezen</h2>
      <ul>
        <li>
          <PageLink id="sources" locale="nl">
            Bronnen en licenties
          </PageLink>
          : welke bronnen we gebruiken, onder welke licentie en met welke bronvermelding.
        </li>
        <li>
          <PageLink id="method" locale="nl">
            Methode
          </PageLink>
          : hoe we klassen, hoogtes en verwachtingen tonen en welke rivieren we niet dekken.
        </li>
        <li>
          <PageLink id="status" locale="nl">
            Status van de bronnen
          </PageLink>
          : of elke bron recent gegevens heeft geleverd.
        </li>
      </ul>
    </>
  );
}
