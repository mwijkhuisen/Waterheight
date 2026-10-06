import { CrosswalkTable } from '../../parts/CrosswalkTable.tsx';
import { DatumTable } from '../../parts/DatumTable.tsx';
import { ForecastCoverage } from '../../parts/ForecastCoverage.tsx';
import { PageLink } from '../../parts/PageLink.tsx';
import { TravelTimes } from '../../parts/TravelTimes.tsx';

export default function Method() {
  return (
    <>
      <h1>Methode</h1>
      <p>
        Deze pagina legt uit hoe de site waterstanden indeelt, welke hoogtes en referentievlakken ze gebruikt, waar
        officiële verwachtingen bestaan, wat een looptijd is en welke rivieren (nog) ontbreken. De site is geen
        officiële waarschuwingsdienst: lees{' '}
        <PageLink id="disclaimer" locale="nl">
          de disclaimer
        </PageLink>
        .
      </p>

      <h2>Hoe een waarde een toestand krijgt</h2>
      <p>
        Elke waarde krijgt één toestand op een schaal met zes stappen: geen referentie, laag, normaal, verhoogd, hoog en
        extreem. Het stationspaneel laat bij elke toestand de grondslag zien.
      </p>
      <ul>
        <li>
          <strong>Volgorde.</strong> Eerst de officiële drempels en klassen van de instantie die het station beheert (de
          gepubliceerde klasse gaat voor onze eigen vergelijking met de drempels), dan statistische referenties zoals
          het gemiddelde hoogwater, en pas daarna de weergaveklassen van de bron zelf, zoals die van RWS Waterinfo. Een
          gebiedsklasse telt alleen waar het station zelf geen toestand heeft; een klasse van het station zelf gaat
          altijd voor een gebiedsklasse.
        </li>
        <li>
          <strong>Grondslag.</strong> De toestand zegt waarop hij berust: de waterstand bij het station (het peil ten
          opzichte van het nulpunt van de peilschaal), de afvoer of een gebied.
        </li>
        <li>
          <strong>Sectie.</strong> Heeft een station zelf geen toestand maar ligt het in een gebied met een
          waarschuwingsklasse, dan krijgt het de kleur van dat gebied en de aanduiding “sectie”: de toestand is die van
          het gebied, niet van het station.
        </li>
        <li>
          <strong>Grijs: geen referentie.</strong> Een grijs station heeft geen bepalende referentie. We raden nooit: er
          komt geen drempel van een buurstation, geen standaardwaarde en geen interpolatie.
        </li>
        <li>
          <strong>Niet strikt gelijkwaardig.</strong> De klassen volgen de referenties van elke instantie; “verhoogd”
          bij de ene instantie is niet strikt hetzelfde als “verhoogd” bij een andere. De klassen van RWS Waterinfo zijn
          weergaveklassen en nooit waarschuwingen.
        </li>
      </ul>
      <p>
        De tabellen hieronder worden gemaakt uit dezelfde tabellen als de indeling zelf (alleen de openbare bronnen),
        zodat ze er niet van kunnen afwijken. Codes en korte namen staan zoals de instantie ze schrijft.
      </p>
      <CrosswalkTable locale="nl" />

      <h2>Hoogtes en referentievlakken</h2>
      <p>
        Elke waarde staat zoals de bron haar publiceert, met eigen eenheid en nulpunt (peilnul, NAP, NN). Ruwe waarden
        en absolute hoogtes van verschillende meetpunten en landen zijn niet te vergelijken: absolute hoogtes
        weerspiegelen vooral het verhang van de rivier, en de nulpunten van peilschalen verschillen van plaats tot
        plaats.
      </p>
      <p>
        Alleen in het stationspaneel rekent de site om naar “≈ m NAP”, en alleen voor een waterstand met een peilnul in
        een omrekenbaar referentievlak of voor een niveau in zijn eigen referentievlak; nooit op de kaart. De omrekening
        is H_NAP = H_referentievlak + verschil.
      </p>
      <ul>
        <li>TAW (Vlaanderen) en DNG (de Franse naam ervoor): H_NAP = H_TAW − 2,33 m.</li>
        <li>NHN (Duitsland) is binnen enkele centimeters gelijk aan NAP.</li>
        <li>LN02 (Zwitserland): een hoogte in LN02 is bij Bazel ongeveer 0,32 m groter dan dezelfde hoogte in NHN.</li>
        <li>
          Frankrijk: Franse stations tonen alleen hun gepubliceerde peilnul (uit de metadata van Hub’Eau, niet
          geverifieerd) en nooit een omgerekende hoogte. De site geeft geen verschuiving van IGN69 of NGF-1884 naar NAP:
          op de gedeelde stations waar zowel Hub’Eau als PEGELONLINE de peilnul publiceren, verschillen de twee
          nulpunten +0,535 tot +1,57 m, dus de gepubliceerde omrekeningen kloppen daar niet. Hetzelfde geldt voor elke
          peilnul die alleen uit Hub’Eau-metadata komt.
        </li>
      </ul>
      <DatumTable locale="nl" />

      <h2>Verwachtingen</h2>
      <p>
        Officiële verwachtingen staan rechts van “nu” op de tijdlijn. De tijdlijn reikt hooguit 48 uur vooruit en nooit
        verder dan de horizon die de aanbieder voor het gekozen station zelf geeft. Een waarde voorbij het deel dat de
        aanbieder zelf voorspelt, heet “schatting”. Verwachtingen van verschillende aanbieders worden nooit gemengd: per
        reeks en tijdstip toont de site één bron. Alleen officiële verwachtingen tellen; modelverwachtingen zoals GloFAS
        gebruikt de site niet. Daardoor is de toekomst niet overal even ver zichtbaar.
      </p>
      <ForecastCoverage locale="nl" />

      <h2>Looptijden</h2>
      <p>
        Looptijden van hoogwatertoppen zijn typisch en indicatief, nooit een aankomsttijd. Ze hangen sterk af van de
        afvoer: tussen laagwater en hoogwater verschilt een looptijd een factor 1,5 tot 2. De site toont daarom alleen
        bandbreedtes uit bronnen (van–tot, in uren) tussen twee meetpunten, nooit een tijd ten opzichte van nu. Voor de
        getijdenrivieren Schelde en Eems staan geen looptijden: het getij loopt stroomopwaarts, dus een stroomafwaartse
        looptijd geldt daar niet voor waterstanden.
      </p>
      <TravelTimes locale="nl" />

      <h2>Rivieren die niet worden gedekt</h2>
      <p>In de eerste release ontbreken deze rivieren of rivierstukken:</p>
      <ul>
        <li>
          De Kempense rivieren die rechtstreeks Nederland binnenstromen: Mark, Dommel, Aa of Weerijs, Warmbeek, Keersop,
          Merkske en de Voer, totdat gegevens van de Vlaamse Milieumaatschappij (VMM) beschikbaar komen.
        </li>
        <li>
          Ahr, Kyll, Prüm en Nahe in Rijnland-Palts: alleen de klassen van het Länderübergreifendes Hochwasserportal
          (LHP), totdat gegevens van het Landesamt für Umwelt Rheinland-Pfalz (LfU RLP) beschikbaar komen.
        </li>
        <li>
          Oostenrijk en Liechtenstein (Ill, Bregenzerach en het Bodenmeer bij Bregenz): buiten het bereik van de eerste
          release. De Alpenrijn en het Bodenmeer komen uit de gegevens van het Zwitserse BAFU.
        </li>
        <li>
          Trajecten die door Nederlandse waterschappen worden beheerd: daarvan toont de site alleen wat de Duitse
          bovenstroomse meetpunten en Rijkswaterstaat meten; gegevens van de waterschappen zelf staan op een wachtlijst.
        </li>
      </ul>
      <p>
        Welke bronnen de site gebruikt staat op{' '}
        <PageLink id="sources" locale="nl">
          Bronnen en licenties
        </PageLink>
        .
      </p>
    </>
  );
}
