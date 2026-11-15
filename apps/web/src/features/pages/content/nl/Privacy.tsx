import { Cdn } from '../../parts/Cdn.tsx';
import { Contact } from '../../parts/Contact.tsx';
import { LogPolicy } from '../../parts/LogPolicy.tsx';

export default function Privacy() {
  return (
    <>
      <h1>Privacy</h1>

      <h2>CDN</h2>
      <Cdn locale="nl" />

      <h2>Wie is verantwoordelijk</h2>
      <Contact locale="nl" />

      <h2>Bezoekstatistieken</h2>
      <p>
        Om te weten hoeveel mensen deze site gebruiken en welke pagina’s ze lezen, stuurt elke pagina die je opent één
        kort bericht naar <code>stats.waterradar.io</code>: onze eigen statistiekserver (Umami), die op dezelfde machine
        draait als deze site. Het bericht gaat via het netwerk van Cloudflare, dat het dus met je IP-adres ontvangt. Het
        is het enige verzoek dat je browser buiten deze site doet: elk bestand dat de pagina laadt, ook de kaart, komt
        van deze site zelf, en een link naar een andere site laadt pas als je erop klikt.
      </p>
      <p>
        Het bericht bevat het adres van de pagina zonder het deel na het vraagteken (dus niet het tijdstip of station
        dat je koos), de paginatitel, de site en pagina waar je vandaan kwam (ook zonder dat deel), de taal van je
        browser en de grootte van je scherm. Uit het verzoek leidt de statistiekserver de browser, het
        besturingssysteem, het soort apparaat en het land af, en de regio en plaats als Cloudflare die meestuurt. Hij
        slaat geen IP-adres op en plaatst geen cookie. Om een bezoeker één keer te tellen, maakt hij uit je IP-adres en
        browser, een geheime sleutel en de huidige maand een code. Alleen met die sleutel is de code aan een IP-adres te
        koppelen, en dat doen wij nooit; vanaf de volgende maand tel je als nieuwe bezoeker.
      </p>
      <p>
        Stuurt je browser Do Not Track mee, dan gaat er geen bericht. De statistieken zijn alleen voor ons, worden met
        niemand gedeeld en blijven bewaard tot wij ze verwijderen.
      </p>

      <h2>Niets opgeslagen in je browser</h2>
      <p>
        Wij slaan niets op in je browser: geen cookies, geen localStorage en geen andere opslag. De weergave die je
        kiest (tijdstip, station, kaartweergave en rivier) staat alleen in het webadres, en je taal volgt uit het adres:
        pagina’s met /en/ in het adres zijn Engels. Ook het statistiekscript schrijft niets: het kijkt alleen of de
        instelling <code>umami.disabled</code> bestaat, en stuurt dan niets.
      </p>

      <h2>Toegangslogboek</h2>
      <p>
        Onze webserver schrijft voor elk verzoek een regel in een toegangslogboek: het tijdstip, het opgevraagde
        webadres (met een gekozen tijdstip of station, als die in het adres staan), de statuscode, de grootte van het
        antwoord, de gegevens die je browser zelf meestuurt (zoals de browsernaam en de taalvoorkeur) en je IP-adres in
        verkorte vorm. De koppen Authorization en Cookie worden nooit gelogd.
      </p>
      <LogPolicy locale="nl" topic="access" />
      <p>
        Wij gebruiken het logboek om de werking en de veiligheid van de site te bewaken, bijvoorbeeld om storingen en
        misbruik te signaleren.
      </p>

      <h2>Beperking van overbelasting</h2>
      <p>
        De API van de site beperkt hoeveel verzoeken één adres per tijdseenheid mag doen. De tellers hiervoor staan
        alleen in het werkgeheugen van het programma: ze worden nooit naar schijf geschreven en verdwijnen bij een
        herstart.
      </p>

      <h2>Meldingen van je browser</h2>
      <p>
        Als je browser iets blokkeert wat deze site niet mag laden, kan hij daar een melding van sturen naar{' '}
        <code>POST /api/v1/beacon</code>. Bij een gewoon bezoek gebeurt dat niet.
      </p>
      <LogPolicy locale="nl" topic="beacon" />
      <p>
        Onze server schrijft voor zo’n melding één regel in het serverlogboek en slaat verder niets op. In die regel kan
        staan op welke pagina het gebeurde, welk adres werd geblokkeerd en wat je browser over zichzelf meldt (zoals de
        browsernaam); je IP-adres en de koppen van het verzoek staan er niet in.
      </p>

      <h2>Je rechten</h2>
      <p>
        Je kunt ons via het contactadres hierboven vragen om inzage in gegevens die wij van je hebben, om correctie of
        verwijdering, en je kunt bezwaar maken tegen de verwerking. Omdat het logboek alleen verkorte adressen bevat en
        de statistieken geen enkel adres, kunnen we een verzoek of bezoek soms niet aan jou koppelen. Heb je een klacht
        over hoe wij met je gegevens omgaan, dan kun je die indienen bij de Autoriteit Persoonsgegevens.
      </p>
    </>
  );
}
