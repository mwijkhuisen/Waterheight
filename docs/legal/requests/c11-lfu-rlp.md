<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C11 · LfU Rheinland-Pfalz (DE-10): German · send now

*English: asks for the consent the Impressum requires to fetch, store and publicly show the forecasts at 66 gauges (p10–p90), the 46 alert regions and the W/Q values, credited "LfU" with the Bearbeitungsdatum; asks about the interval, the CSV export (Referer check), the API/export and history questions, the RLP-operated gauges in the Luxembourg CC0 file, and flood-state behaviour. Until consent DE-10 stays `off` and every RLP forecast run is lost.*

**To:** poststelle@lfu.rlp.de (Landesamt für Umwelt Rheinland-Pfalz, Kaiser-Friedrich-Straße 7, 55116 Mainz) · **Subject:** `Bitte um Zustimmung: Abruf, Speicherung und öffentliche Anzeige der Hochwasservorhersagen, Warnregionen und Pegelwerte von hochwasser.rlp.de auf einer nicht-kommerziellen Informationswebsite`

```text
Sehr geehrte Damen und Herren,

mein Name ist <NAME>. Ich entwickle <WEBSITE URL>, eine private, nicht-kommerzielle, öffentliche Informationswebsite über Wasserstände und Abflüsse der Flüsse, die in die Niederlande fließen (Rhein mit Mosel, Saar, Sauer, Nahe, Lahn und Ahr, Maas, Schelde, Ems, Vechte). Eine Karte auf OpenStreetMap-Basis zeigt nahezu aktuelle Messwerte, amtliche Vorhersagen und die Warnstufen der Betreiber; mit einer Datums- und Zeitauswahl kann man dem Wasser flussabwärts folgen und in die nahe Zukunft blicken. Die Website ist kostenlos, ohne Werbung, ohne Bezahlangebote, ohne Benutzerkonten und ohne Tracking. Sie ist kein amtlicher Warndienst: Bei Hochwasser verweisen wir auf hochwasser.rlp.de und die anderen amtlichen Stellen.

Ihr Impressum sagt: „Sie dürfen nur mit Zustimmung des LfU verändert, vervielfältigt, in Vervielfältigungen an Dritte abgegeben oder zu öffentlichen Wiedergaben verwendet werden. Als Quelle ist das LfU zu nennen, soweit möglich mit Angabe des Bearbeitungsdatums.“ Deshalb rufen wir bis zu Ihrer Antwort keine Daten von hochwasser.rlp.de ab.

Ich bitte um Ihre schriftliche Zustimmung zu Folgendem:
1. Abruf, nur serverseitig: die Übersicht www.hochwasser.rlp.de/api/v1/index (Wasserstände, Warnregionen, Vorhersagen; etwa 2,9 MB) alle 15 Minuten oder in dem Rhythmus, den Sie vorgeben, und /api/v1/config einmal täglich; nach einer Unterbrechung zum Nachholen einzelne Seiten /api/v1/measurement-site/{Nummer}.
2. Speicherung jedes Vorhersagelaufs (p10 bis p90 an den 66 Vorhersagepegeln), jedes Stands der 46 Warnregionen und der Messwerte in unserer Datenbank, damit die Zeitauswahl auch vergangene Zeitpunkte und frühere Vorhersagen zeigen kann.
3. Öffentliche Anzeige auf der Karte, in Stationsgrafiken und in der Zeitauswahl: Wasserstand und Abfluss als ungeprüfte Rohdaten; die Vorhersagen als Band p10–p90, nur so weit, wie Sie sie selbst veröffentlichen, und deutlich als Vorhersage gekennzeichnet; die Warnstufen als Flächen der Warnregionen. Quellenangabe: „Quelle: Landesamt für Umwelt Rheinland-Pfalz (LfU), hochwasser.rlp.de, Stand: <Bearbeitungsdatum>“ (verlinkt).
Es geht vor allem um den Rhein von Maxau bis Emmerich (20 Vorhersagepegel), die Mosel mit Perl, Stadtbredimus, Wasserbillig, Trier und Cochem, die Saar (Fremersdorf), Sauer und Our, Nahe, Lahn, Ahr, Kyll, Prüm, Sieg, Wied und Nette. Reihen anderer Betreiber in Ihrer Übersicht (WSV, LANUK, DREAL, AGE, SPW) übernehmen wir nicht von Ihnen. Unsere Anfragen tragen den User-Agent „rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>)“, mit höchstens zwei gleichzeitigen Verbindungen und automatischer Verzögerung bei Fehlern. Ohne Ihre ausdrückliche Zustimmung gibt es keine Downloads oder Exporte Ihrer Daten. Ziehen Sie die Zustimmung zurück, löschen wir Ihre Daten von der Website und aus unserer Datenbank.

Meine Fragen:
a) Stimmen Sie der Nutzung wie beschrieben zu, und unter welchen Bedingungen?
b) Ist die Quellenangabe so richtig, und welches Datum sollen wir als Bearbeitungsdatum zeigen (den Zeitpunkt des Vorhersagelaufs bzw. des Messwerts)?
c) Ist ein Abruf der Übersicht alle 15 Minuten in Ordnung, oder gibt es eine dokumentierte Schnittstelle, die wir stattdessen nutzen sollen? Der CSV-Export auf geodaten-wasser.rlp-umwelt.de antwortet ohne Referer mit 403: Dürfen wir ihn zum Nachholen nutzen, und wenn ja, wie?
d) Unsere Karte lädt die Werte als JSON-Dateien von unserem eigenen Server; diese sind technisch öffentlich erreichbar, und wir bieten eine kleine, begrenzte öffentliche API an. Ist die Weitergabe Ihrer Daten darüber zulässig, auch als CSV-Download je Pegel, oder sollen wir sie davon ausnehmen?
e) Dürfen wir die gespeicherten Messwerte, Vorhersageläufe und Warnstufen dauerhaft archivieren und später öffentlich als Verlauf zeigen, etwa um Vorhersage und Beobachtung zu vergleichen?
f) Die Pegel Bollendorf und Gemünd erscheinen auch in der CC0-Datei „Niveau d'eau“ der luxemburgischen Wasserwirtschaftsverwaltung, und inondations.lu zeigt Ihre Vorhersagen für Perl, Stadtbredimus und Wasserbillig. Dürfen wir diese Werte über die luxemburgische Quelle zeigen, oder gilt dafür Ihre Zustimmung?
g) Ändern sich bei Hochwasser der Rhythmus der Vorhersageläufe oder das Format? Gibt es Beispieldaten im Hochwasserzustand, mit denen wir unsere Darstellung testen können?

Eine nicht-öffentliche Testversion läuft ab Oktober 2026; der öffentliche Start ist für Anfang Dezember 2026 geplant, vor der Hochwassersaison. Da jeder Vorhersagelauf überschrieben wird, geht bis zu Ihrer Antwort jeder Lauf für den späteren Vergleich verloren. Für eine baldige Antwort wäre ich Ihnen daher sehr dankbar.

Mit freundlichen Grüßen
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
