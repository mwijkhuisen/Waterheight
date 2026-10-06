import { Contact } from '../../parts/Contact.tsx';

export default function Accessibility() {
  return (
    <>
      <h1>Toegankelijkheid</h1>
      <p>
        We willen dat zoveel mogelijk mensen deze site kunnen gebruiken. Ons doel is WCAG 2.2 niveau AA. De site is in
        bèta en voldoet daar nog niet in alles aan; hieronder staat wat werkt en wat niet.
      </p>

      <h2>De tabel als alternatief voor de kaart</h2>
      <p>
        De kaart is een tekenvlak en niet bedoeld voor schermlezers. De tabel is het alternatief: dezelfde stations en
        dezelfde waarden voor het gekozen tijdstip, te gebruiken met toetsenbord en schermlezer. Kies bij “Weergave” de
        knop “Tabel”. Kan je browser de kaart niet tonen (geen WebGL2), dan krijg je de tabel vanzelf. De tabel toont
        100 regels per keer; met “Vorige” en “Volgende” blader je verder.
      </p>

      <h2>Bediening met het toetsenbord</h2>
      <ul>
        <li>
          Tijdlijn: met de pijltjestoetsen ga je 10 minuten terug of vooruit, met Page Up en Page Down een uur, en met
          Home en End naar het begin en het einde van de tijdlijn. Je kunt ook een datum en een tijd invullen en de
          knoppen “10 minuten terug”, “10 minuten vooruit”, “Nu”, “Afspelen” en “Pauzeren” gebruiken. Afspelen staat uit
          als je apparaat om minder beweging vraagt.
        </li>
        <li>
          Kaartweergave (“Toestand”, “Verandering in 24 uur” en “Afvoer”): drie keuzerondjes, die je met de
          pijltjestoetsen wisselt.
        </li>
        <li>
          Stationslijst: kies een station met de pijltjestoetsen. De focus blijft dan op de lijst, zodat je verder kunt
          kiezen; het paneel met de gegevens van het station staat in de paginavolgorde na de kaart of de tabel.
        </li>
        <li>
          Tabel: de naam van een station is een knop. Activeer je die, dan opent het paneel en gaat de focus naar de kop
          van het paneel. Sluit je het paneel met de knop “Station sluiten”, dan keert de focus terug naar de knop
          waarmee je het opende, of anders naar de stationslijst.
        </li>
        <li>
          Kaart: als de kaart is geladen, kun je hem met het toetsenbord verschuiven (pijltjestoetsen) en zoomen (plus
          en min).
        </li>
      </ul>

      <h2>Bekende beperkingen</h2>
      <ul>
        <li>
          De kaart zelf is niet toegankelijk voor schermlezers, en de stations op de kaart zijn niet een voor een met
          het toetsenbord te kiezen. Gebruik daarvoor de tabel of de stationslijst.
        </li>
        <li>
          De grafiek in het stationspaneel is een plaatje met een korte beschrijving (de periode en de eenheid). Wat de
          grafiek verder laat zien, zoals het verloop over zeven dagen, de drempelwaarden en het verloop van een
          verwachting, staat niet als tekst op de pagina. Het paneel noemt wel de waarde op het gekozen tijdstip, de
          ouderdom ervan, de toestand, de grondslag en de verandering in 24 uur; met de tijdkiezer lees je andere
          momenten af.
        </li>
        <li>
          De kleuren van de kaart zijn gekozen om ook bij kleurenblindheid uit elkaar te blijven. De grootte van een
          markering volgt de toestand en driehoekjes tonen stijgen of dalen. De tabel, de pop-up en het paneel zeggen
          het in woorden. Of dat genoeg is, kan geen automatische toets beoordelen.
        </li>
        <li>
          Namen en teksten van de bronnen, zoals stationsnamen en bronvermeldingen, tonen we zoals de bron ze
          publiceert, vaak in het Duits of Frans. Alleen bronvermeldingen met een bekende taal zijn met die taal
          gemarkeerd.
        </li>
      </ul>

      <h2>Een probleem melden</h2>
      <p>Loop je tegen iets aan dat niet toegankelijk is? Laat het ons weten, met de pagina en wat er misging:</p>
      <Contact locale="nl" />
    </>
  );
}
