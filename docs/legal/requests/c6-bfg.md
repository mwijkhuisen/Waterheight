<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C6 · BfG (DE-2/DE-3): German

*English: accepts the credit and Belegexemplar terms (URL + screenshot at launch); asks whether `WV` is BfG data, whether a URL suffices, how WV behaves in floods, and about the API and showing stored runs later.*

**To:** vorhersage@bafg.de · **Subject:** `Nutzung der BfG-Wasserstandsvorhersagen (WV in PEGELONLINE, 14-Tage-Vorhersage) auf einer nicht-kommerziellen Informationswebsite – Quellenangabe und Belegexemplar`

```text
Sehr geehrte Damen und Herren,

mein Name ist <NAME>. Ich entwickle <WEBSITE URL>, eine private, nicht-kommerzielle, öffentliche Informationswebsite über Wasserstände und Abflüsse der Flüsse, die in die Niederlande fließen (Rhein, Maas, Schelde, Ems, Vechte und ihre Nebenflüsse). Eine Karte auf OpenStreetMap-Basis zeigt nahezu aktuelle Messwerte, amtliche Vorhersagen und die Meldestufen der Betreiber; mit einer Zeitauswahl kann man auch in die nahe Zukunft blicken. Die Website ist kostenlos, ohne Werbung, ohne Bezahlangebote und ohne Tracking, und sie ist kein amtlicher Warndienst.

Wir möchten folgende Vorhersagen der BfG nutzen:
1. die Zeitreihen „WV“ in PEGELONLINE für die sieben Rheinpegel Oestrich, Kaub, Koblenz, Köln, Düsseldorf, Duisburg-Ruhrort und Emmerich: stündlicher Abruf von measurements.json; jeder Vorhersagelauf (erkennbar an „initialized“) wird einmal gespeichert;
2. die 14-Tage-Quantildateien (vorhersage.bafg.de/14-Tage-Vorhersage/) und die 6-Wochen-Vorhersage: einmal täglich, mit bedingter Anfrage (Last-Modified).
Da jeder Lauf überschrieben wird, speichern wir die Läufe ab Oktober 2026 intern (nicht öffentlich), um später Vorhersage und Beobachtung vergleichen zu können. Öffentlich zeigen wir zum Start (geplant Anfang Dezember 2026) nur die WV-Vorhersage, höchstens für die ersten 48 Stunden und deutlich als Vorhersage gekennzeichnet. Die 14-Tage- und 6-Wochen-Produkte zeigen wir erst später. Werte über 640 cm, die in den CSV-Dateien als „---“ erscheinen, veröffentlichen wir entsprechend Ihrem Hinweis nicht.

Ihre Bedingungen verlangen, „die BfG als Datenquelle zu nennen und der BfG ein entsprechendes Belegexemplar unentgeltlich zur Verfügung zu stellen“. Beides sagen wir zu. Als Quellenangabe schlagen wir „Wasserstandsvorhersage: Bundesanstalt für Gewässerkunde (BfG)“ vor. Da es sich um eine Website handelt, würden wir Ihnen zum Start die URL mit einem Bildschirmfoto der Darstellung als Belegexemplar zusenden.

Meine Fragen:
a) Gelten für die WV-Zeitreihen in PEGELONLINE Ihre Bedingungen, oder fallen sie wie die übrigen PEGELONLINE-Daten unter die Datenlizenz Deutschland – Zero 2.0? Wir behandeln sie vorsorglich als BfG-Daten.
b) Ist die Quellenangabe so richtig?
c) Genügen URL und Bildschirmfoto als Belegexemplar?
d) Wie verhält sich WV bei Hochwasser, etwa oberhalb von HSW oder Marke II: Wird die Vorhersage fortgeführt oder zugunsten der Produkte der Hochwasservorhersagezentralen der Länder eingestellt?
e) Unsere Karte lädt die Werte als JSON-Dateien von unserem eigenen Server, und wir bieten eine kleine, begrenzte öffentliche API an. Ist das mit Quellenangabe in Ordnung, auch für einen CSV-Download der angezeigten Vorhersage? Dürfen wir die gespeicherten Läufe später auch öffentlich zeigen, etwa im Vergleich mit den Messwerten?

Mit freundlichen Grüßen
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
