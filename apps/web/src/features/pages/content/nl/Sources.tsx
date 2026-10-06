import { MapCredits } from '../../parts/MapCredits.tsx';
import { PageLink } from '../../parts/PageLink.tsx';
import { SourcesList } from '../../parts/SourcesList.tsx';

export default function Sources() {
  return (
    <>
      <h1>Bronnen en licenties</h1>
      <p>
        Alle waarden, verwachtingen en waarschuwingsklassen op deze site komen van bronnen die waterbeheerders
        publiceren. Hieronder staat elke bron die de site toont, met aanbieder, licentie en de bronvermelding die de
        aanbieder vraagt, in elke taal waarin hij die geeft. Vraagt de licentie een datum (van de laatste update, van
        het ophalen of de peildatum van de aanbieder), dan staat die datum erbij; is hij niet bekend, dan staat er
        “datum onbekend”. Een vermelding die de aanbieder alleen aanbeveelt, is als zodanig gemarkeerd.
      </p>
      <p>
        Deze site is niet door Rijkswaterstaat of een andere aanbieder goedgekeurd of onderschreven en is geen officiële
        waarschuwingsdienst: lees{' '}
        <PageLink id="disclaimer" locale="nl">
          de disclaimer
        </PageLink>
        .
      </p>

      <h2>Bronnen</h2>
      <SourcesList locale="nl" />

      <h2>Opmerkingen</h2>
      <ul>
        <li>
          De gegevens van Rijkswaterstaat vallen onder CC0 (Creative Commons Zero): ze mogen vrij worden gebruikt. De
          bronvermelding staat hierboven toch bij elke bron.
        </li>
        <li>
          Voor Zwitserland is het Naturgefahrenbulletin op{' '}
          <a href="https://www.naturgefahren.ch/" rel="noopener noreferrer">
            naturgefahren.ch
          </a>{' '}
          het gezaghebbende kanaal. De BAFU-gegevens op deze site zijn meetgegevens zoals de aanbieder ze publiceert,
          niet gevalideerd.
        </li>
        <li>
          Hoe de klassen, hoogtes en verwachtingen tot stand komen staat op de pagina{' '}
          <PageLink id="method" locale="nl">
            Methode
          </PageLink>
          ; hoe vers de gegevens van elke bron zijn op de pagina{' '}
          <PageLink id="status" locale="nl">
            Status van de bronnen
          </PageLink>
          .
        </li>
      </ul>

      <h2>Kaart en rivierennet</h2>
      <MapCredits locale="nl" />
    </>
  );
}
