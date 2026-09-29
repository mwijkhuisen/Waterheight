<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C4 · AGE Luxembourg (LU-2/3/4/7): French · optional, public display only

*Optional (D22): send when convenient, or record it as "deferred"; nothing blocks on it. English: says openly that we already read the JSON, forecasts and thresholds for personal, strictly private use under the Aspects légaux (owner view, one user, values unmodified) and do not fetch the LfU RLP-origin files; asks for CC0 confirmation or written permission for public display; reports the CSV bugs (15-min label offset, no UTC offset, 404s); asks about third-party and LfU RLP data and the 2002–2024 archive.*

**To:** hydrometrie@eau.etat.lu · **Cc:** Service de la navigation (Moselle; address not researched, look it up). · **Subject:** `Affichage public des données d'inondations.public.lu (JSON, prévisions, seuils) : confirmation CC0 ou autorisation écrite, et signalement d'anomalies`

```text
Madame, Monsieur,

Je m'appelle <NAME> et je réalise <WEBSITE URL>, un site d'information privé, public et non commercial consacré aux niveaux et aux débits des rivières qui s'écoulent vers les Pays-Bas (Rhin avec la Moselle et la Sûre, Meuse, Escaut et leurs affluents). Une carte fondée sur OpenStreetMap affiche les mesures en temps quasi réel, les prévisions officielles et les niveaux d'alerte ; un sélecteur de date et d'heure permet de suivre l'eau vers l'aval. Le site est gratuit, sans publicité, sans offre payante, sans compte ni traçage, et n'est pas un service d'alerte officiel : nous renvoyons vers inondations.lu.

Nous utilisons, avec mention de la source, le jeu de données CC0 « Niveau d'eau » (Water-Levels-LocalTime.csv, toutes les 15 minutes) et les alertes LU-Alert (CC BY). Les fichiers suivants ne figurent pas sur data.public.lu, et les Aspects légaux du site (05.08.2026) indiquent : « Sauf indication contraire… aucune reproduction… n'est permise sans l'autorisation écrite préalable » :
A. les fichiers JSON par station https://inondations.public.lu/content/dam/inondations/ctie/datas/<fichier>.json (39 fichiers, une lecture par heure) ;
B. les prévisions https://inondations.public.lu/percentile/<station>-p{10,30,50,70,90}.json (11 stations, une lecture par heure) ;
C. les seuils et métadonnées des pages de station (attribut data-to-json : niveaux de vigilance, niveaux équivalents HQ2 à HQ100, zéro de l'échelle), une lecture par semaine.
Conformément aux Aspects légaux, nous les consultons déjà à ce rythme à titre personnel, pour information et dans un cadre strictement privé : un outil réservé à moi seul (accessible uniquement par mon propre VPN et un mot de passe), valeurs non modifiées, rien n'est diffusé en dehors de cet usage. Nous ne consultons pas les fichiers de Bollendorf et de Gemünd ni les prévisions de Perl, Stadtbredimus et Wasserbillig, qui proviennent du LfU Rheinland-Pfalz (question b). Pourriez-vous confirmer que A, B et C sont réutilisables sous CC0 comme « Niveau d'eau », ou nous accorder une autorisation écrite de les afficher publiquement et de conserver ces valeurs pour un historique public ? Sans cette autorisation, elles ne quittent pas notre usage personnel. Si vous souhaitez que nous cessions aussi cet usage personnel, dites-le-nous : nous l'arrêterons.

Affichage public envisagé : carte, graphiques par station et sélecteur temporel, avec la mention « Source : Administration de la gestion de l'eau (AGE), Luxembourg – inondations.lu ; stations de la Moselle : Service de la navigation ». Les prévisions sont affichées comme bandes p10–p90, limitées à l'horizon de 24 ou 48 heures que vous affichez vous-mêmes ; les valeurs au plancher de prévision de la Moselle (Perl 250 cm, Stadtbredimus 260 cm, Wasserbillig 220 cm) sont signalées « sous la plage prévisible ». Nos requêtes s'identifient par le User-Agent « rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>) », sans paramètre de requête ajouté. Sans votre accord, aucun téléchargement ni export de vos données n'est proposé. En cas de retrait de votre accord, nous supprimons vos données.

Anomalies constatées (23.09.2026) :
1. Dans Water-Levels-LocalTime.csv, les horodatages ont 15 minutes de retard : la valeur sous l'étiquette T est celle que les fichiers JSON et PEGELONLINE donnent pour T−15 min (vérifié à Diekirch, Stadtbredimus et Perl).
2. Ce CSV est en heure locale sans décalage UTC ; l'heure répétée le 25 octobre 2026 (02:00–03:00) sera ambiguë. Serait-il possible d'ajouter le décalage ou une colonne UTC ?
3. SN_Remich.json, Water-Levels-Localstation.csv (listé sur data.public.lu) et les prévisions « bollendorf » et « grevenmacher » renvoient une erreur 404.

Mes questions :
a) Confirmez-vous CC0, ou nous accordez-vous une autorisation écrite, pour A, B et C ? Qui est compétent (les Aspects légaux mentionnent la Bibliothèque nationale) ?
b) Certaines séries viennent d'autres exploitants (Bollendorf et Gemünd, LfU Rheinland-Pfalz ; Perl, WSV ; Moselle, Service de la navigation ; prévisions de Perl, Stadtbredimus et Wasserbillig calculées par le LfU RLP). La licence CC0 de « Niveau d'eau », vos Aspects légaux et votre réponse couvrent-ils aussi ces séries (y compris les fichiers JSON de Bollendorf et de Gemünd et ces prévisions), ou devons-nous nous adresser à ces exploitants ?
c) Un flux documenté et stable est-il prévu ?
d) Pour une phase ultérieure (2027) : comment demander les données validées 2002–2024 (hauteurs et débits), sous quel format et quelle licence ?
e) La mention de la source ci-dessus vous convient-elle ?
f) Notre carte charge les valeurs sous forme de fichiers JSON depuis notre serveur, et nous proposons une petite API publique à débit limité. Est-ce acceptable pour A, B et C ? Pouvons-nous aussi proposer un téléchargement CSV par station, et conserver ces valeurs (y compris les prévisions) pour les montrer plus tard comme historique ?

Une version de test non publique fonctionne à partir d'octobre 2026 ; le lancement public est prévu début décembre 2026.

Veuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
