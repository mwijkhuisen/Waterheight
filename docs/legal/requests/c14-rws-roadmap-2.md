<!-- Verbatim from issue #62, first comment (id 5967875338, 2026-10-03). Placeholders stay unfilled; the owner fills them when sending. -->

### C14 · Rijkswaterstaat: wider scope and request budget

**To:** the "Servicedesk Data" contact form on rijkswaterstaatdata.nl (or its CTD successor page). Optionally, also https://github.com/Rijkswaterstaat/WaterWebservices/discussions, **without** the `X-API-KEY` value. · **Subject:** `Uitbreiding van ons gebruik van de WaterWebservices (DDAPI20): meer locaties en een hogere aanvraagfrequentie` · **When:** ≥ 10 working days before P16a deploys.

```text
Geachte heer, mevrouw,

Mijn naam is <NAAM>; ik beheer <WEBSITE URL>, een particuliere, niet-commerciële, publieke informatiewebsite (geen reclame, geen tracking, geen officiële waarschuwingsdienst) over de waterstanden van de rivieren die Nederland binnenstromen. Sinds <DATUM> halen we server-side waarnemingen en verwachtingen op via de WaterWebservices (DDAPI20), met de X-API-KEY "<X-API-KEY>" en de User-Agent "rivierstanden/<versie> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)", en we vermelden Rijkswaterstaat als bron.

Vanaf <DATUM, ten vroegste 10 werkdagen na deze e-mail> willen we ook de meren (IJsselmeer, Markermeer, Randmeren, de Zeeuwse en Zuid-Hollandse meren), de getijdenrivieren, de kanalen, de kust, de Waddenzee en de offshoreplatforms tonen: ongeveer 250 extra locaties via OphalenWaarnemingen, één locatie per verzoek. Daarmee stijgt onze belasting van ten hoogste 400 naar ten hoogste 900 verzoeken per uur (ongeveer 20.000 per dag), gespreid over het uur: belangrijke kust- en deltameetpunten elke 10 minuten, de overige getijde- en riviermeetpunten elke 30 minuten, meren en kanalen elk uur. Daarnaast halen we maandelijks het astronomisch getij en dagelijks de gemeten hoog- en laagwaters op. Bij een foutmelding of overbelasting (429, 5xx) vertragen we automatisch.

Mijn vragen:
1. Is deze belasting voor u acceptabel? Zo niet, welk maximum of welke frequentie heeft uw voorkeur? We passen het direct aan.
2. Is er (of komt er) een manier om meerdere locaties in één verzoek op te halen? OphalenLaatsteWaarnemingen loopt één à twee waarden achter en negeert ProcesType, dus die gebruiken we niet.
3. Welke meetpunten zijn constructie-interne meters (sluiskolken, schuiven, gemalen) die we beter niet als waterstand van het open water tonen?
4. Wat is precies het referentievlak "MSL" bij de offshoreplatforms (bijvoorbeeld K14, Europlatform en F3)?
5. Is de stormvloedwaarschuwing (WMCN Kust) als machineleesbare data beschikbaar, of alleen als bericht?
6. Wanneer wordt het astronomisch getij voor 2028 gepubliceerd?

Met vriendelijke groet,
<NAAM>
<WEBSITE URL> · <CONTACT E-MAIL>
```
