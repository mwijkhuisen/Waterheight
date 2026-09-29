<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C2 · VMM (BE-2): Dutch · personal, private viewer

**To:** hydrometrie@waterinfo.be · **Subject:** `Aanvraag token voor geautomatiseerde bevraging van waterinfo.be (KiWIS) – persoonlijke, niet-commerciële viewer`

```text
Geachte heer, mevrouw,

Mijn naam is <NAME>. Voor mijn eigen gebruik bouw ik een persoonlijke, niet-commerciële viewer van de waterstanden en afvoeren van de rivieren die Nederland binnenstromen (Rijn, Maas, Schelde, Eems, Vecht en hun zijrivieren): een kaart met bijna-realtime metingen, officiële verwachtingen en alarmniveaus, met een datum- en tijdkiezer. De viewer heeft één gebruiker, mijzelf: hij draait op mijn eigen server en is alleen bereikbaar via mijn eigen VPN-verbinding en met een wachtwoord. Daarnaast bouw ik <WEBSITE URL>, een gratis, publieke informatiewebsite met de open databronnen, zonder advertenties of tracking; het is geen officiële waarschuwingsdienst en verwijst naar waterinfo.be.

VMM vraagt om bij geautomatiseerde databevraging steeds token-toegang te gebruiken. Ik vraag daarom een token (client credentials voor download.waterinfo.be/kiwis-auth/token) voor deze persoonlijke viewer. Tot ik het token heb, haal ik geen VMM-gegevens op.

Wat ik wil bevragen, uitsluitend vanaf mijn server:
- datasource=1, getTimeseriesValues in porties van hoogstens 100 ts_id's, met returnfields=Timestamp,Absolute Value,Quality Code, period=PT2H en timezone=UTC, elke 10 tot 15 minuten, voor een selectie van de 15-minutenreeksen waterstand (groep 192780) en afvoer (groep 192786) op de onbevaarbare waterlopen in het Schelde- en Maasbekken, onder meer de bovenloop van Demer, Dijle en Nete en de Kempense waterlopen die Nederland binnenstromen (Mark, Dommel, Warmbeek, Kleine Aa/Weerijs, Noordermark);
- de drempelreeksen (DrempelWaak/DrempelAlarm) en de metadata één keer per dag;
- als dat kan: de verwachtingen (H_voorspeld/Q_voorspeld) en een eenmalige inhaalslag vanaf oktober 2026, binnen het credit-budget.
Ik vraag één token per 24 uur aan, gebruik maximaal twee gelijktijdige verbindingen, en mijn verzoeken dragen de User-Agent "rivierstanden/<versie> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)".

Weergave en bronvermelding: in de viewer verschijnen de waarden op de kaart, in grafieken per meetpunt en in de tijdkiezer, gemarkeerd als ruwe, niet-gevalideerde gegevens, met de vermelding "Bron: VMM – waterinfo.vlaanderen.be (Modellicentie Gratis Hergebruik v1.0)" en een link naar waterinfo.vlaanderen.be.

Mijn vragen:
a) Is deze bronvermelding juist?
b) Welk credit-budget hoort bij het token, en past dit gebruik daarbinnen?
c) Heeft u liever dat ik de waardelaag gebruik (getTimeseriesValueLayer, groep 192780, valuecolumn=absolute) in plaats van getTimeseriesValues? Uw handleiding meldt dat getTimeseriesValues niet vooraf in de cache staat en meer credits kan kosten.
d) Is er een tabel met de betekenis van de kwaliteitscodes (ik zie onder meer 110, 130 en 220)?
e) Voor welke meetpunten zijn de drempel- en verwachtingsreeksen gevuld, en leveren de Kempense meetpunten live waarden?
f) Ik bewaar de reeksen, zodat de tijdkiezer ook het verleden toont. Is dat in orde?
g) Facultatief: kunt u bevestigen dat ik de gegevens onder de Modellicentie, met het token, ook publiek op <WEBSITE URL> mag tonen, met de bronvermelding? Mogen ze dan ook in de JSON-bestanden van onze server, via een kleine, begrensde publieke API, als CSV-download per meetpunt en als historisch archief beschikbaar zijn? Tot ik dat weet, blijven de VMM-gegevens in mijn persoonlijke viewer.

Ik wil de viewer graag vóór het hoogwaterseizoen (december 2026) in gebruik nemen.

Met vriendelijke groet,
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
