<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C7 · RWS (NL-1): Dutch

**To:** the "Servicedesk Data" contact form on rijkswaterstaatdata.nl (it may move with the CTD after 11-05). · **Subject:** `Melding gebruik WaterWebservices (ddapi20) door een niet-commerciële publieke website – ca. 9.000 verzoeken per dag`

```text
Geachte heer, mevrouw,

Mijn naam is <NAME>. Ik bouw <WEBSITE URL>: een particuliere, niet-commerciële, publieke informatiewebsite over de waterstanden en afvoeren van de rivieren die Nederland binnenstromen (Rijn, Maas, Schelde, Eems, Vecht en hun zijrivieren). Een kaart op basis van OpenStreetMap toont bijna-realtime metingen, officiële verwachtingen en de alarmniveaus van de waterbeheerders; met een datum- en tijdkiezer bekijkt een bezoeker de toestand op een gekozen moment en volgt hij het water stroomafwaarts naar Nederland. De site is gratis, zonder advertenties of tracking, en is geen officiële waarschuwingsdienst: we verwijzen naar Waterinfo en de officiële kanalen.

Graag meld ik vooraf hoe we de WaterWebservices gebruiken, zodat u ons verkeer herkent:
- OphalenWaarnemingen op ddapi20-waterwebservices.rijkswaterstaat.nl, één locatie per verzoek (WATHTE/NAP en Q, meting): circa 25 hoofdmeetpunten elke 10 minuten en circa 45 overige meetpunten elke 30 minuten, telkens met een venster van enkele uren;
- verwachtingen (ProcesType verwachting) voor alle verwachtingslocaties (WATHTE op 183 en Q op 13 locaties): circa 40 locaties elk uur, de overige elke 3 uur;
- OphalenCatalogus één keer per dag;
- de WFS-laag locatiesmetlaatstewaarneming elke 10 minuten, en het bestand met grenswaarden en legendakleuren en de pagina met de downloadlinks één keer per week.
Samen is dat hoogstens 400 verzoeken per uur (circa 9.000 per dag), met maximaal twee gelijktijdige verbindingen en automatische vertraging bij fouten. Elk verzoek draagt X-API-KEY "<X-API-KEY>" en de User-Agent "rivierstanden/<versie> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)". De gegevens verschijnen met de vermelding "Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/", een disclaimer dat ze niet geschikt zijn voor veiligheidsbeslissingen, en zonder de suggestie van goedkeuring door Rijkswaterstaat.

Mijn vragen:
a) Is deze belasting aanvaardbaar, of heeft u liever een andere werkwijze (bijvoorbeeld meerdere locaties per verzoek)?
b) Hoe vaak en op welke tijdstippen worden de verwachtingen (RWSM-F232) herberekend? De documentatie noemt "elke 6 uur".
c) Veranderen de hostnamen van de API (ddapi20-waterwebservices.rijkswaterstaat.nl en geo.rijkswaterstaat.nl) bij de overgang naar het Centraal Toegangspunt Data op 5 november 2026?
d) Wat betekent Kwaliteitswaardecode 25?
e) Komen de klassen in het bestand met grenswaarden (15-4-2026) overeen met de waarschuwingsniveaus van het WMCN, en zijn die niveaus ook machineleesbaar beschikbaar?
f) Zijn de langere verwachtingen die Waterinfo als waaier toont ergens als data beschikbaar?
g) Meet de afvoerreeks van locatie kanne de Jeker/Geer of een kanaal?
h) Waar wordt de volgende editie van het bestand met grenswaarden gepubliceerd, en blijft het huidige pad op rijkswaterstaatdata.nl na 5 november bereikbaar?

Een niet-openbare testversie draait vanaf oktober 2026; de publieke lancering is gepland voor begin december 2026.

Met vriendelijke groet,
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
