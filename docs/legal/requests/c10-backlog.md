<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C10 · Backlog templates (after launch)

*English: a consent request for the German state services whose Impressum requires consent (LfU RLP and LUBW now have their own drafts, C11 and C12), and a feed request to the Dutch water boards. Both ask the API/export and history questions.*

**German template. To:** HLNUG and LfU Bayern: look up the address in the Impressum of hlnug.de and gkd.bayern.de. · **Subject:** `Bitte um Zustimmung zur öffentlichen Anzeige von Pegeldaten auf einer nicht-kommerziellen Informationswebsite`

```text
Sehr geehrte Damen und Herren,

mein Name ist <NAME>; ich betreibe <WEBSITE URL>, eine private, nicht-kommerzielle, öffentliche Informationswebsite (ohne Werbung, ohne Tracking, kein amtlicher Warndienst) über Wasserstände der Flüsse, die in die Niederlande fließen. Ihr Impressum verlangt für öffentliche Wiedergaben Ihre Zustimmung und die Angabe „<BEHÖRDE>“ als Quelle. Ich bitte um Ihre schriftliche Zustimmung, <DATEN> für die Pegel <PEGELLISTE> serverseitig alle <INTERVALL> Minuten abzurufen (<ENDPUNKT>), zu speichern und mit der Quellenangabe „<QUELLENANGABE>“ auf Karte, Stationsgrafik und Zeitauswahl anzuzeigen. User-Agent: „rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)“. Ohne Ihre Zustimmung keine Downloads oder Exporte Ihrer Daten; bei Widerruf löschen wir sie.
Gibt es eine dokumentierte Schnittstelle, die wir nutzen sollen? Welches Intervall ist Ihnen recht? Ist die Weitergabe über unsere kleine, begrenzte öffentliche API und als CSV-Download zulässig, und dürfen wir die Werte archivieren und später als Verlauf zeigen?

Mit freundlichen Grüßen
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```

**Dutch template. To:** Vechtstromen, Rijn en IJssel, Waterschap Limburg and the Brabant boards De Dommel, Brabantse Delta and Aa en Maas (look up the data or open-data contact on each water board's website). · **Subject:** `Vraag over een datafeed van waterstanden voor een niet-commerciële publieke website`

```text
Geachte heer, mevrouw,

Mijn naam is <NAME>; ik beheer <WEBSITE URL>, een particuliere, niet-commerciële, publieke informatiewebsite over de waterstanden van de rivieren die Nederland binnenstromen. Voor <RIVIEREN, bijv. Dinkel, Berkel, Regge / Roer, Niers, Swalm / Dommel, Aa, Mark> tonen we nu bovenstroomse (Duitse of Belgische) en RWS-meetpunten, voor zover beschikbaar, maar we zouden graag ook uw meetpunten tonen. Bestaat er een officiële, machineleesbare feed (of kan die worden afgesproken), en onder welke licentie en bronvermelding? We halen server-side hoogstens elke 15 minuten op, met een User-Agent met ons contactadres, en bieden zonder uw akkoord geen downloads of exports van uw gegevens aan. Mogen we uw gegevens ook via onze kleine, begrensde publieke API en als CSV-download aanbieden, en mogen we ze bewaren en later als historie tonen? <Alleen Rijn en IJssel: zijn de tijdstempels in de ArcGIS-laag Nexus_P UTC of lokale tijd?>

Met vriendelijke groet,
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
