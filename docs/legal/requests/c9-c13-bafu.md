<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C9 + C13 · BAFU (CH-1…CH-8; C13 hydrodaten polling for CH-2/4/5): German (Swiss spelling, no ß)

*English: one e-mail for both rows. C9: courtesy notice of our LINDAS use; `threshold_customer`, the forecast schedule and LINDAS limits. C13: says openly that we already poll the undocumented hydrodaten files CH-2, CH-4 and CH-5 and will stop if asked; asks whether that is acceptable and at what interval, whether the 10-min rule of the 2019 conditions applies to them, and whether thresholds and forecasts are or will be on LINDAS; plus the API/export and history questions. Silence keeps CH-2/4/5 public (BAFU conditions, catalogue §0.8); an objection to public use moves them to the owner view (D22); only a request to stop fetching stops capture. Record C9 and C13 separately in the tracker (C13 go/no-go 10-31 for P7, 11-06 for P8).*

**To:** abfragezentrale@bafu.admin.ch · **Subject:** `Nutzung von LINDAS und hydrodaten.admin.ch durch eine nicht-kommerzielle Informationswebsite – Bitte um Erlaubnis für die hydrodaten-Dateien und Fragen`

```text
Sehr geehrte Damen und Herren

Mein Name ist <NAME>. Ich entwickle <WEBSITE URL>, eine private, nicht-kommerzielle, öffentliche Informationswebsite über Wasserstände und Abflüsse der Flüsse, die in die Niederlande fliessen, darunter der Rhein mit Aare, Reuss, Limmat, Thur und Birs. Eine Karte auf OpenStreetMap-Basis zeigt nahezu aktuelle Messwerte, amtliche Vorhersagen und Gefahrenstufen; mit einer Zeitauswahl kann man dem Wasser flussabwärts folgen. Die Website ist kostenlos, ohne Werbung und ohne Tracking, und sie ist kein amtlicher Warndienst: Bei Warnungen ist das Naturgefahrenbulletin auf www.naturgefahren.ch massgebend, und darauf verweisen wir.

Unsere Nutzung (nur serverseitig, User-Agent „rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)“):
- LINDAS-SPARQL-Endpunkt, Cubes „river“ und „lake“: alle 10 Minuten, nie häufiger, gemäss §6 der Allgemeinen Bedingungen von 2019;
- hydrodaten: web-hydro-maps/hydro_sensor_pq.geojson (mit den Schwellenwerten wl_1 bis wl_4) alle 10 Minuten (If-Modified-Since); plots/q_forecast/{id}_q_forecast_{lang}.json für die 55 Stationen mit Vorhersage einmal pro Stunde (Last-Modified); web-hydro-maps/hydro_warn_levels_{de,en}.geojson alle 30 Minuten;
- einmalig beim Start: plots/p_q_40days für 11 Stationen (2473, 2288, 2044, 2143, 2016, 2018, 2243, 2205, 2091, 2106, 2289).
Die hydrodaten-Dateien fragen wir seit dem <DATUM> in diesem Rhythmus ab und speichern sie, damit keine Vorhersage und keine Gefahrenstufe verloren geht; öffentlich angezeigt werden sie noch nicht. Wünschen Sie das nicht, stellen wir den Abruf sofort ein. Quellenangabe: „Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum)“, mit dem Hinweis auf ungeprüfte Rohdaten. Zu den Vorhersagen zeigen wir eine kurze Leseanleitung, wie in §8 derselben Bedingungen empfohlen.

Meine Fragen:
a) Die Dateien auf hydrodaten.admin.ch mit Schwellenwerten (hydro_sensor_pq.geojson), Vorhersagen (q_forecast) und Warnabschnitten (hydro_warn_levels) sind nicht dokumentiert. Dürfen wir sie wie beschrieben abfragen und die Werte öffentlich anzeigen, und welches Intervall ist Ihnen recht?
b) Gilt die 10-Minuten-Regel aus §6 der Bedingungen von 2019 auch für diese Dateien, oder nur für die Downloads mit Benutzerkonto?
c) Sind Schwellenwerte und Vorhersagen über LINDAS verfügbar, oder ist das geplant?
d) Unsere Karte lädt die Werte als JSON-Dateien von unserem eigenen Server, und wir bieten eine kleine, begrenzte öffentliche API an. Ist das mit Quellenangabe in Ordnung, auch für einen CSV-Download je Station? Dürfen wir die gespeicherten Werte, Vorhersagen und Gefahrenstufen dauerhaft archivieren und später als Verlauf zeigen?
e) Was bedeutet das Feld threshold_customer (bei 16 Stationen vorhanden)?
f) Nach welchem Plan werden die Abflussvorhersagen ausserhalb von Hochwasserlagen ausgegeben?
g) Gibt es Laufzeit- oder Abfragegrenzen für den LINDAS-SPARQL-Endpunkt?

Eine nicht-öffentliche Testversion läuft ab Oktober 2026; der öffentliche Start ist für Anfang Dezember 2026 geplant. Schwellenwerte und Warnabschnitte möchten wir ab Anfang November zeigen, Vorhersagen kurz danach. Nach Ihren Bedingungen („Freie Nutzung“; Vorhersagen „dürfen frei verwendet werden“) halten wir die öffentliche Anzeige für zulässig und zeigen die Werte öffentlich, wenn Sie bis Ende Oktober 2026 nicht widersprechen. Widersprechen Sie der öffentlichen Anzeige, zeigen wir öffentlich nur die Gefahrenstufen aus LINDAS und keine Vorhersagen und nutzen die Dateien nur noch persönlich; auf Ihren Wunsch stellen wir den Abruf ganz ein.

Freundliche Grüsse
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```

**C9, second e-mail. To:** hydrologie@bafu.admin.ch · **Subject:** `Anfrage Datenservice Hydrologie: historische Reihen für eine spätere Bestellung und Zeitzone der CSV-Lieferungen`

*English: prepares the CH-8 order for 2027; asks about a whole-network 10-min delivery from 2000 and whether the CSV is UTC or UTC+1.*

```text
Sehr geehrte Damen und Herren

Für die nicht-kommerzielle Informationswebsite <WEBSITE URL> (Wasserstände und Abflüsse der Flüsse, die in die Niederlande fliessen) möchten wir 2027 historische Abfluss- und Pegelreihen bestellen, vor allem 10-Minuten-Werte ab 2000 für die Stationen im Rheineinzugsgebiet.
a) Ist eine Lieferung des gesamten Netzes als 10-Minuten-Werte von 2000 bis heute in einer Lieferung möglich?
b) Zeitzone: Die Beispiel-CSV enthält Zeitstempel wie „2017-12-01 00:00:00+00:00“, die FAQ nennen dagegen UTC+1 und den Beginn des Intervalls. Was gilt für Lieferungen?
c) Gelten für gelieferte Daten die Liefer- und Nutzungsbedingungen von 2020 (freie Nutzung, Quellenangabe empfohlen), auch für die öffentliche Anzeige?

Freundliche Grüsse
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
