<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C1 · HIC (BE-1): Dutch · personal, private viewer

**To:** hic@vlaanderen.be · **Subject:** `Aanvraag TYPE 3-toegang en gebruikersovereenkomst voor een persoonlijke, niet-commerciële viewer van rivierwaterstanden`

```text
Geachte heer, mevrouw,

Mijn naam is <NAME>. Voor mijn eigen gebruik bouw ik een persoonlijke, niet-commerciële viewer van de waterstanden en afvoeren van de rivieren die Nederland binnenstromen (Rijn, Maas, Schelde, Eems, Vecht en hun zijrivieren): een kaart met bijna-realtime metingen, officiële verwachtingen en alarmniveaus, en een datum- en tijdkiezer waarmee ik de toestand op een gekozen moment bekijk en het water stroomafwaarts volg. De viewer heeft één gebruiker, mijzelf: hij draait op mijn eigen server, is alleen bereikbaar via mijn eigen VPN-verbinding en met een wachtwoord, en de gegevens gaan niet naar derden. Daarnaast bouw ik <WEBSITE URL>, een gratis, publieke informatiewebsite met de open databronnen, zonder advertenties of tracking; HIC-gegevens verschijnen daar niet zonder uw uitdrukkelijk akkoord.

Volgens uw "Manual on the use of HIC webservices" (versie 24/07/2026) is ook dit persoonlijke gebruik TYPE 3: automatische, geplande bevraging in een viewer. Ik vraag daarom (1) credentials voor de tokenservice (client ID en secret voor hicwsauth.vlaanderen.be) en (2) een gebruikersovereenkomst voor dit persoonlijke, niet-commerciële, private gebruik. Tot ik de credentials heb, haal ik geen HIC-gegevens op.

Wat ik wil bevragen, uitsluitend vanaf mijn server (nooit vanuit een browser):
- getTimeseriesValueLayer voor groep 156163 (waterstand hoge resolutie) en groep 156170 (afvoer hoge resolutie), met timezone=UTC, elke 10 tot 15 minuten;
- getTimeseriesValues met period=PT2H voor de getijdenreeksen (W, Pv.10), in hetzelfde ritme, omdat de waardelaag voor die reeksen geen waarden geeft;
- de drempelreeksen (DrempelPrewaak/Waak/Alarm), de overschrijdingspercentielen en de metadata (getTimeseriesList, getStationList) één keer per dag;
- als u dat toestaat: de verwachtingen van 48 uur (groepen 506056 en 506057) één keer per uur, en een eenmalige inhaalslag van de metingen vanaf oktober 2026, gespreid en buiten de piekuren.
Het gaat om een selectie: de getijdenketen van de Zeeschelde, de Leie, de Bovenschelde, de Dender, de benedenloop van Demer, Dijle en Nete, en de Grensmaas. Ik volg uw advies (één token per 24 uur, waardelagen per groep, één grote metadatalijst in plaats van veel kleine) en gebruik maximaal twee gelijktijdige verbindingen en een vast credit-budget per ronde. Mijn verzoeken dragen de User-Agent "rivierstanden/<versie> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)".

Weergave en bronvermelding: in de viewer verschijnen de waarden op de kaart, in grafieken per meetpunt en in de tijdkiezer, gemarkeerd als ruwe, niet-gevalideerde gegevens, met de verplichte vermelding "Waterbouwkundig Laboratorium. Metingen en voorspellingen afkomstig uit de databank van het Hydrologisch InformatieCentrum [DATA]. [datum van bevraging: dd/mm/jjjj]." Ik geef de gegevens aan niemand door: zonder uw uitdrukkelijke toestemming geen publieke weergave, API, downloads of exportbestanden. Trekt u de toestemming ooit in, dan verwijder ik uw gegevens uit mijn database.

Mijn vragen:
a) De Engelse disclaimer spreekt van "information and non-commercial purposes" en van downloaden "for personal use". Kunt u bevestigen dat een persoonlijke, niet-commerciële viewer zoals hierboven onder een gebruikersovereenkomst kan vallen, en welke voorwaarden daarbij gelden?
b) Is de vermelding juist als ik bij [DATA] de reeks en bij [datum van bevraging] de datum van mijn laatste bevraging invul? Volstaat een korte bronregel bij de kaart, met de volledige tekst bij elk meetpunt?
c) Welk dagelijks credit-budget krijg ik, en past het gebruik hierboven daarbinnen?
d) Mag ik de opgehaalde waarden bewaren, zodat de tijdkiezer ook het verleden toont, en binnen het credit-budget historische reeksen ophalen (vanaf oktober 2026, en later eventueel oudere jaren)?
e) Zijn de tijdstempels van de Pv.10-reeksen momentane waarden of het einde van een interval, en welke conventie volgen de overschrijdingspercentielen?
f) Facultatief: zou u ook een publieke, niet-commerciële weergave op <WEBSITE URL> toestaan, en onder welke voorwaarden? Zo ja: mogen de waarden dan ook in de JSON-bestanden van onze server staan (technisch publiek bereikbaar), via een kleine, begrensde publieke API en als CSV-download per meetpunt beschikbaar zijn, en mogen we een historisch archief publiek tonen? Zo niet, dan blijven de HIC-gegevens uitsluitend in mijn persoonlijke viewer.

Ik wil de viewer graag vóór het hoogwaterseizoen (december 2026) in gebruik nemen; een eerste reactie op korte termijn stel ik daarom zeer op prijs.

Met vriendelijke groet,
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
