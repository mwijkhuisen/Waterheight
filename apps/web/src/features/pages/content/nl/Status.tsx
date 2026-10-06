import { PageLink } from '../../parts/PageLink.tsx';
import { StatusTables } from '../../parts/StatusTables.tsx';

export default function Status() {
  return (
    <>
      <h1>Status van de bronnen</h1>
      <p>
        Deze pagina laat zien hoe vers de gegevens van elke bron zijn, uit het statusbestand van de site. De bron-ID’s
        zijn die van{' '}
        <PageLink id="sources" locale="nl">
          de pagina Bronnen en licenties
        </PageLink>
        . Alle tijden zijn Nederlandse tijd. De gegevens worden zoals de aanbieder ze publiceert getoond en zijn niet
        gevalideerd; de site is geen officiële waarschuwingsdienst (
        <PageLink id="disclaimer" locale="nl">
          disclaimer
        </PageLink>
        ).
      </p>

      <h2>Wat de kolommen betekenen</h2>
      <ul>
        <li>
          <strong>Status.</strong> “In orde”: de gegevens van de bron komen op tijd binnen. “Verminderd”: er is een
          bestand afgekeurd, de laatste gegevens zijn ouder dan twee ophaalintervallen, of van minder dan 95 % van de
          hoofdreeksen (tier 1) is de waarde vers (een waarde die de bron zelf niet vernieuwt telt als vers). “Storing”:
          de laatste geslaagde ophaalactie is ouder dan drie intervallen, of er zijn vijf of meer mislukte pogingen op
          rij. “Onbekend”: de bron is nog niet opgehaald.
        </li>
        <li>
          <strong>Laatst opgehaald</strong> is het moment van de laatste geslaagde ophaalactie en{' '}
          <strong>nieuwste waarde</strong> het tijdstip van de nieuwste waarde die we van de bron hebben.
        </li>
        <li>
          <strong>Vertraging</strong> is de tijd tussen ophalen en opslaan: 95 % van de opgehaalde bestanden staat
          binnen die tijd in de database.
        </li>
        <li>
          <strong>Dekking</strong> is het aandeel van de verwachte waarden van de hoofdreeksen dat is opgeslagen, vanaf
          het eerste uur met gegevens.
        </li>
        <li>
          <strong>Verwachtingsrun</strong> is hoe oud de nieuwste verwachting van de bron is. Voor een bron met een vast
          schema staat er “te laat” als een verwachte run is uitgebleven; dat verandert de status niet.
        </li>
      </ul>

      <h2>Bronnen en controles</h2>
      <p>
        Eigenaarsbronnen worden op de openbare site niet getoond; daar staat alleen hun aantal. Tweelingcontroles
        vergelijken ieder uur twee reeksen van hetzelfde water (bijvoorbeeld hetzelfde peil bij twee aanbieders) over de
        laatste 24 uur: “mislukt” betekent dat ze meer afwijken dan de toegestane marge.
      </p>
      <p>
        Tier-1-stations zijn de stations die voor de kaart zijn uitgekozen; stations van de eerste release zijn de
        tier-1-stations met een openbare hoofdreeks. Een station “met een toestand” heeft een andere toestand dan “geen
        referentie” (zie{' '}
        <PageLink id="method" locale="nl">
          Methode
        </PageLink>
        ); een verwachting is actueel zolang ze nog tot nu reikt.
      </p>
      <StatusTables locale="nl" />
    </>
  );
}
