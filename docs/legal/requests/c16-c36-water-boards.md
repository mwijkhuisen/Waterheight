<!-- Verbatim from issue #62, first comment (id 5967875338, 2026-10-03). Placeholders stay unfilled; the owner fills them when sending. -->

### C16–C36 · Water boards: one template, filled in per board

**To:** see the table below. · **Subject:** `Verzoek om toestemming: waterstanden van <WATERSCHAP> tonen op een niet-commerciële publieke website` · **When:** wave 1 (C16–C26) now or right after launch; wave 2 (C27–C36) optional.

```text
Geachte heer, mevrouw,

Mijn naam is <NAAM>; ik beheer <WEBSITE URL>, een particuliere, niet-commerciële, publieke informatiewebsite (geen reclame, geen tracking, geen officiële waarschuwingsdienst) met een kaart van de actuele waterstanden en afvoeren in Nederland en van de rivieren die Nederland binnenstromen. We gebruiken open data van onder meer Rijkswaterstaat, PEGELONLINE (Duitsland) en Hub'Eau (Frankrijk), altijd met bronvermelding.

Voor <WATEREN> tonen we nu alleen meetpunten van Rijkswaterstaat of bovenstrooms in Duitsland of België. We zouden graag ook uw meetpunten tonen en vragen daarom uw toestemming. <ALINEA A of B, zie de tabel; anders weglaten>

Concreet willen we:
- de actuele waterstanden (en waar beschikbaar de afvoeren) van uw meetpunten server-side ophalen, hoogstens eens per 10 tot 15 minuten, met een User-Agent met ons contactadres: "rivierstanden/<versie> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)";
- ze tonen op de kaart, in een grafiek per meetpunt en bij de tijdkiezer, met de bronvermelding die u voorschrijft;
- ze bewaren, zodat bezoekers ook kunnen terugkijken.

Mijn vragen:
1. Mogen we uw meetgegevens zo publiek tonen? Onder welke licentie (bij voorkeur CC0 of CC-BY 4.0) en met welke bronvermelding?
2. Welke bron moeten we gebruiken, en met welke frequentie? <BRONZIN, zie de tabel>
3. Mogen de gegevens ook via onze kleine, begrensde publieke API en als CSV-download worden aangeboden, en mogen we een historisch archief bewaren en tonen? Zonder uw akkoord doen we dat niet.
4. Zijn de tijdstempels in UTC of in Nederlandse lokale tijd?
5. Als publiek tonen niet mogelijk is: mag ik de gegevens dan uitsluitend voor eigen, persoonlijk en niet-commercieel gebruik ophalen en bekijken in een afgeschermde weergave die alleen ikzelf gebruik en met niemand deel?

Zonder uw toestemming halen we niets op. Trekt u uw toestemming later in, dan stoppen we en verwijderen we de gegevens.

Met vriendelijke groet,
<NAAM>
<WEBSITE URL> · <CONTACT E-MAIL>
```

**Paragraph A** (the board's site says its data may be reused):
```text
Op uw website lezen we dat uw gegevens hergebruikt mogen worden ("<CITAAT>", <URL>). Omdat daar geen licentie bij staat<, en uw proclaimer persoonlijk gebruik noemt,> vragen we dit graag schriftelijk na.
```
**Paragraph B** (the board's site asks for permission for reuse):
```text
Uw website vraagt toestemming voor hergebruik van informatie van de site; daarom deze vraag.
```

**Source sentences:**
- **S-none:** `Bestaat er een machineleesbare bron (bijvoorbeeld een API, een ArcGIS-dienst of een CSV), of kan die worden afgesproken?`
- **S-arcgis-notime:** `We zagen uw ArcGIS-laag met actuele waterstanden; daarin staat de laatste waarde zonder tijdstip of achter grafiek-URL's. Is er een bron met tijdstempels die we mogen gebruiken?`
- **S-lizard:** `We zagen dat uw meetreeksen publiek in Lizard staan (<board>.lizard.net). Mogen we die API gebruiken, en met welke frequentie?`

| # | Water board | To | `<WATEREN>` | Paragraph | Source sentence |
|---|---|---|---|---|---|
| C16 | Waterschap Limburg | form https://www.waterschaplimburg.nl/contact/contactformulier/ | de Roer, Niers, Geul, Swalm, Worm, Jeker en Geleenbeek | – | `We zagen waterstandlimburg.nl, maar geen machineleesbare bron. Bestaat die, of kan die worden afgesproken?` |
| C17 | Waterschap Rijn en IJssel | `info@wrij.nl` | de Oude IJssel, Berkel, Bocholter Aa, Slinge, Baakse Beek en Schipbeek | B | `We zagen de ArcGIS-laag WaterData/Nexus_P op opengeo.wrij.nl. Mogen we die gebruiken, en zijn de tijdstempels daarin UTC of lokale tijd?` |
| C18 | Waterschap Vechtstromen | `info@vechtstromen.nl` | de Vecht (vanaf De Haandrik), Dinkel en Regge | B | S-none |
| C19 | Waterschap De Dommel | `info@dommel.nl` | de Dommel, Tongelreep, Keersop, Reusel, Beerze en Run | A, with the proclaimer clause; quote "Iedereen kan en mag deze gebruiken." from dommel.nl/waterdata-openbare-gegevens-over-water | S-arcgis-notime |
| C20 | Waterschap Brabantse Delta | form https://formulieren.brabantsedelta.nl/form/contact-opnemen/uw-gegevens-1 | de Mark, Aa of Weerijs, Donge en Dintel | A; quote the "open, tenzij" sentence of brabantsedelta.nl/actueel/kaarten-en-data/open-data-portaal/ | `In uw open-dataportaal vonden we geen actuele waterstanden van het oppervlaktewater. Kunnen die worden gepubliceerd, of is er een andere bron?` |
| C21 | Waterschap Aa en Maas | `info@aaenmaas.nl` | de Aa, Raam, Hertogswetering, Leijgraaf en Peelse Loop | – | `We zagen de MapServer EXTERN/Stuwinstellingen_waterstanden op gisservices.aaenmaas.nl. Mogen we die gebruiken, en met welke frequentie?` |
| C22 | Waterschap Hunze en Aa's | `gis_info@hunzeenaas.nl` | de Westerwoldse Aa, Hunze en Drentsche Aa | A; quote the "open, tenzij" sentence of hunzeenaas.nl/open-data/ | S-none |
| C23 | Waterschap Drents Overijsselse Delta | `info@wdodelta.nl` | de Overijsselse Vecht, Reest en Sallandse Weteringen | – | S-none |
| C24 | Hoogheemraadschap De Stichtse Rijnlanden | `post@hdsr.nl` | de Kromme Rijn, Hollandse IJssel en Leidsche Rijn | A; quote "Iedereen die dat wil kan deze gegevens gebruiken en er toepassingen, zoals apps, voor ontwikkelen." (hdsr.nl, news of 2012-06-14) | S-lizard (hdsr) |
| C25 | Waterschap Rivierenland | `info@wsrl.nl` | de Linge, Giessen en Alblas | – | S-arcgis-notime |
| C26 | Waterschap Vallei en Veluwe | `info@vallei-veluwe.nl` | de Eem, Grift, het Valleikanaal en de Veluwse beken | – | S-arcgis-notime |
| C27 | Waterschap Noorderzijlvest | `info@noorderzijlvest.nl` | het Reitdiep en Winsumerdiep | – | S-none |
| C28 | Wetterskip Fryslân | information-request form at mijn.wetterskipfryslan.nl (linked from wetterskip.frl/contact) | de Friese boezem | – | S-none |
| C29 | Waterschap Zuiderzeeland | `waterschap@zuiderzeeland.nl` | de Flevolandse polders | – | S-lizard (zuiderzeeland) |
| C30 | Hoogheemraadschap Hollands Noorderkwartier | form hhnk.nl/form/e-mailformulier | de Noord-Hollandse boezem | – | S-lizard (hhnk) |
| C31 | Waterschap Amstel, Gooi en Vecht | form agv.nl/contact/contactformulier/ | de Amstel en de Utrechtse Vecht | – | S-none |
| C32 | Hoogheemraadschap van Rijnland | form rijnland.nl/contact/contactformulier/ | de Oude Rijn en de Rijnlandse boezem | – | S-none |
| C33 | Hoogheemraadschap van Delfland | `loket@hhdelfland.nl` | de Delflandse boezem | – | S-none |
| C34 | Hoogheemraadschap van Schieland en de Krimpenerwaard | `info@hhsk.nl` | de Rotte | – | `We zagen uw kaart "Actuele metingen water". Bestaat er een machineleesbare bron achter, en mogen we die gebruiken?` |
| C35 | Waterschap Hollandse Delta | `info@wshd.nl` | de wateren op de Zuid-Hollandse eilanden | – | S-none |
| C36 | Waterschap Scheldestromen | `info@scheldestromen.nl` | de Zeeuwse wateren en de beken uit België in Zeeuws-Vlaanderen | – | S-none |

Record every send and answer in `docs/permissions.md` once P15 has added the rows; until then, comment here.
