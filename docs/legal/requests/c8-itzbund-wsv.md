<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C8 · ITZBund / WSV (DE-1/DE-5): German

*English: courtesy notice of our PEGELONLINE use; asks whether `WV` and the mirrored series are DL-DE Zero, and about scripted use of the history form (DE-5) in 2027.*

**To:** look up: the contact on pegelonline.wsv.de (Impressum/Kontakt). · **Subject:** `Hinweis auf die Nutzung der PEGELONLINE-REST-API durch eine nicht-kommerzielle Informationswebsite, und Fragen zu Lizenz und historischen Daten`

```text
Sehr geehrte Damen und Herren,

mein Name ist <NAME>. Ich entwickle <WEBSITE URL>, eine private, nicht-kommerzielle, öffentliche Informationswebsite (Karte mit Messwerten, Vorhersagen und Meldestufen der Flüsse, die in die Niederlande fließen; ohne Werbung und Tracking; kein amtlicher Warndienst). Damit Sie unseren Verkehr einordnen können, kurz unsere Nutzung der REST-API v2:
- stations.json für die Gewässer RHEIN, MOSEL, SAAR, MAIN, NECKAR, LAHN, RUHR, EMS und DEK mit includeTimeseries und includeCurrentMeasurement: alle 15 Minuten, mit If-None-Match;
- measurements.json (Zeitraum PT6H) für etwa 60 W- und Q-Zeitreihen: stündlich; beim ersten Start einmalig P31D;
- Stationsdetails, Pegelnullpunkt und Kennwerte: einmal täglich;
- WV für sieben Rheinpegel: stündlich (die Quellenangabe und das Belegexemplar klären wir direkt mit der BfG).
Wir nutzen höchstens zwei gleichzeitige Verbindungen, verzögern automatisch bei Fehlern, und unsere Anfragen tragen den User-Agent „rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)“. Als Quellenangabe zeigen wir „Pegeldaten: WSV/GDWS via PEGELONLINE (pegelonline.wsv.de), Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0). Ungeprüfte Rohdaten.“ Die in PEGELONLINE gespiegelten Reihen Dritter (Rijkswaterstaat, BAFU Basel, RP Freiburg Konstanz, Ruhrverband Hattingen) veröffentlichen wir nicht aus PEGELONLINE, sondern beziehen sie beim jeweiligen Betreiber.

Meine Fragen:
a) Fallen die WV-Zeitreihen unter DL-DE Zero 2.0 oder unter die Bedingungen der BfG?
b) Gilt DL-DE Zero auch für die gespiegelten Reihen Dritter?
c) Dürfen wir das Formular „historische Zeitreihen“ (gast/historische-zeitreihen) in einer späteren Phase (2027) skriptgesteuert und langsam nutzen, etwa für 60 Reihen ab 2000, eine Anfrage nach der anderen und nachts? Oder bieten Sie dafür einen Massenexport an?
d) Werden Rohwerte innerhalb der 31 Tage noch korrigiert?
e) Gibt es eine Abfragerate, die Sie als fair ansehen?

Mit freundlichen Grüßen
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
