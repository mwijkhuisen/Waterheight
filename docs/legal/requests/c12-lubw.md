<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C12 · LUBW (DE-12): German · send now

*English: asks for the consent the Impressum requires to fetch, store and show the Murg and Kinzig gauges, credited "LUBW"; asks for a documented interface and interval, whether forecasts exist as data, the time zone ("MESZ" vs "MEZ"), and the API/export and history questions. Not needed for the first release.*

**To:** Pegelinfo@lubw.bwl.de · **Subject:** `Bitte um Zustimmung: Abruf, Speicherung und öffentliche Anzeige von Pegeldaten der HVZ Baden-Württemberg auf einer nicht-kommerziellen Informationswebsite`

```text
Sehr geehrte Damen und Herren,

mein Name ist <NAME>. Ich entwickle <WEBSITE URL>, eine private, nicht-kommerzielle, öffentliche Informationswebsite über Wasserstände und Abflüsse der Flüsse, die in die Niederlande fließen, darunter der Rhein mit seinen Nebenflüssen am Oberrhein. Eine Karte auf OpenStreetMap-Basis zeigt nahezu aktuelle Messwerte, amtliche Vorhersagen und die Warnstufen der Betreiber; mit einer Zeitauswahl kann man dem Wasser flussabwärts folgen. Die Website ist kostenlos, ohne Werbung, ohne Bezahlangebote und ohne Tracking, und sie ist kein amtlicher Warndienst: Bei Hochwasser verweisen wir auf die Hochwasservorhersagezentrale Baden-Württemberg.

Ihr Impressum verlangt für Vervielfältigung und öffentliche Wiedergabe Ihre Zustimmung und die Angabe der LUBW als Quelle. Bis zu Ihrer Antwort rufen wir keine Daten der HVZ ab. Ich bitte um Ihre schriftliche Zustimmung zu Folgendem:
1. Abruf, nur serverseitig, von www.hvz.baden-wuerttemberg.de: jf-data-db-peg.js (aktuelle Wasserstände und Abflüsse) alle 15 Minuten, jf-data-stm-peg.js und jf-data-def-peg.js (Stammdaten) einmal täglich;
2. Speicherung der Werte in unserer Datenbank, damit die Zeitauswahl auch vergangene Zeitpunkte zeigen kann;
3. öffentliche Anzeige für die Pegel an der Murg (Baiersbronn, Schwarzenberg, Forbach, Bad Rotenfels, Rastatt) und an der Kinzig (Schenkenzell, Wolfach, Hausach, Biberach, Schwaibach) als ungeprüfte Rohdaten, mit der Quellenangabe „Quelle: LUBW, hvz.baden-wuerttemberg.de“ (verlinkt).
Unsere Anfragen tragen den User-Agent „rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)“. Ohne Ihre ausdrückliche Zustimmung gibt es keine Downloads oder Exporte Ihrer Daten. Ziehen Sie die Zustimmung zurück, löschen wir Ihre Daten von der Website und aus unserer Datenbank.

Meine Fragen:
a) Stimmen Sie der Nutzung wie beschrieben zu, und unter welchen Bedingungen? Ist die Quellenangabe so richtig?
b) Gibt es eine dokumentierte Schnittstelle, die wir statt der JavaScript-Dateien nutzen sollen, und welches Abrufintervall ist Ihnen recht?
c) Veröffentlichen Sie Ihre Hochwasservorhersagen (etwa für Murg, Kinzig oder den Rhein bis Maxau) auch als Daten, und dürften wir sie unter denselben Bedingungen zeigen?
d) Die Zeitangaben in den Dateien enden auf „MESZ“, der Dateikopf nennt „MEZ“. Welche Zeitzone gilt?
e) Unsere Karte lädt die Werte als JSON-Dateien von unserem eigenen Server, und wir bieten eine kleine, begrenzte öffentliche API an. Ist die Weitergabe Ihrer Daten darüber zulässig, auch als CSV-Download je Pegel, oder sollen wir sie davon ausnehmen?
f) Dürfen wir die gespeicherten Werte dauerhaft archivieren und später öffentlich als Verlauf zeigen?

Eine nicht-öffentliche Testversion läuft ab Oktober 2026; der öffentliche Start ist für Anfang Dezember 2026 geplant.

Mit freundlichen Grüßen
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
