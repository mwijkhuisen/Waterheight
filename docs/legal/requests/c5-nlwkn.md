<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C5 · NLWKN (DE-9): German

*English: cites the manual-vs-Impressum conflict; asks for written permission to store and display the Vechte/Dinkel gauges, and about the credit, interval, JSON/API and older data.*

**To:** HWVZ@nlwkn.niedersachsen.de · **Subject:** `Bitte um schriftliche Zustimmung: Speicherung und öffentliche Anzeige der Pegel an Vechte und Dinkel (Pegelonline-Webservice) auf einer nicht-kommerziellen Informationswebsite`

```text
Sehr geehrte Damen und Herren,

mein Name ist <NAME>. Ich entwickle <WEBSITE URL>, eine private, nicht-kommerzielle, öffentliche Informationswebsite über Wasserstände und Abflüsse der Flüsse, die in die Niederlande fließen (Rhein, Maas, Schelde, Ems, Vechte und ihre Nebenflüsse). Eine Karte auf OpenStreetMap-Basis zeigt nahezu aktuelle Messwerte, amtliche Vorhersagen und die Meldestufen der Betreiber. Mit einer Datums- und Zeitauswahl sieht man den Zustand zu einem gewählten Zeitpunkt und kann dem Wasser flussabwärts folgen. Die Website ist kostenlos, ohne Werbung, ohne Bezahlangebote, ohne Benutzerkonten und ohne Tracking. Sie ist kein amtlicher Warndienst: Bei Hochwasser verweisen wir auf die Hochwasservorhersagezentrale des NLWKN und die anderen amtlichen Stellen.

Ihr Webservice kann laut Ihren Hinweisen kostenfrei genutzt werden, und das Benutzerhandbuch (Stand 26.10.2023) verlangt die Quellenangabe www.pegelonline.nlwkn.niedersachsen.de. In Ihrem Impressum heißt es dagegen: „Es ist weder gestattet, die bereitgestellten Daten … zu kommerziellen Zwecken zu nutzen, … an Dritte weiterzugeben oder sie in elektronische Systeme einzuspeichern“, und in der Fußzeile: „Vervielfältigung nur mit unserer Genehmigung“. Wegen dieses Widerspruchs rufen wir bis zu Ihrer Antwort keine Daten ab.

Ich bitte daher um Ihre schriftliche Zustimmung zu Folgendem:
1. Abruf über den dokumentierten öffentlichen Webservice (bis.azure-api.net/PegelonlinePublic/REST/ mit dem Schlüssel aus dem Handbuch): station/{STA_ID}/datenspuren/parameter/1/tage/-1 alle 15 Minuten für die Vechte-Pegel Ohne (465), Wehr Neuenhaus (111) und Emlichheim (258) sowie den Dinkel-Pegel Lage I (388), dazu einmal täglich die Stammdaten. Das sind höchstens sechs Anfragen je 15 Minuten.
2. Speicherung der Wasserstände und Meldestufen in unserer Datenbank. Das ist nötig, damit die Zeitauswahl auch vergangene Zeitpunkte zeigen kann.
3. Öffentliche Anzeige auf der Karte, in Stationsgrafiken und in der Zeitauswahl, gekennzeichnet als ungeprüfte Rohdaten, mit der Quellenangabe „Quelle: www.pegelonline.nlwkn.niedersachsen.de“ (verlinkt).
Unsere Anfragen tragen den User-Agent „rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)“. Wir geben keine Rohdaten in großen Mengen weiter: Ohne Ihre ausdrückliche Zustimmung gibt es keine Downloads oder Exporte Ihrer Daten. Ziehen Sie die Zustimmung später zurück, löschen wir Ihre Daten von der Website und aus unserer Datenbank.

Meine Fragen:
a) Dürfen wir die Daten wie beschrieben speichern und öffentlich anzeigen, und unter welchen Bedingungen?
b) Ist die Quellenangabe so richtig?
c) Ist ein Abruf alle 15 Minuten in Ordnung?
d) Unsere Karte lädt die Werte als JSON-Dateien von unserem eigenen Server; diese sind technisch öffentlich erreichbar, und wir bieten eine kleine, begrenzte öffentliche API an. Ist das zulässig, oder sollen wir Ihre Daten davon ausnehmen? Dürften wir die angezeigten Reihen auch als CSV-Download je Pegel anbieten und die gespeicherten Werte dauerhaft als Verlauf zeigen?
e) Für eine spätere Phase (2027): Können wir ältere bzw. geprüfte Daten über www.wasserdaten.niedersachsen.de beziehen und unter denselben Bedingungen verwenden?

Eine nicht-öffentliche Testversion läuft ab Oktober 2026; der öffentliche Start ist für Anfang Dezember 2026 geplant.

Mit freundlichen Grüßen
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
