<!-- Verbatim from issue #14, first comment (id 5807974191, 2026-09-24). Placeholders stay unfilled; the owner fills them when sending. -->

### C3 · SPW Wallonia (BE-3): French · optional, public display only

*Optional (D22): send when convenient, or record it as "deferred"; nothing blocks on it. English: says openly that we already use the data for personal, strictly private use under the mentions légales (owner view, one user, credited, never passed on) and will not show it publicly without consent; asks for the written consent the mentions légales require for public display (10-min polling, storage, later public backfill); asks about frequency, attribution, our JSON/API, NIVCRU, open-licence plans and the Metawal "static image" route.*

**To:** hydrometrie@spw.wallonie.be · **Subject:** `Demande d'accord préalable et écrit – affichage public des données hydrométriques du SPW sur un site d'information non commercial`

```text
Madame, Monsieur,

Je m'appelle <NAME> et je réalise <WEBSITE URL>, un site d'information privé, public et non commercial consacré aux niveaux et aux débits des rivières qui s'écoulent vers les Pays-Bas (Rhin, Meuse, Escaut, Ems, Vecht et leurs affluents). Une carte fondée sur OpenStreetMap affiche les mesures en temps quasi réel, les prévisions officielles et les niveaux d'alerte des gestionnaires. Un sélecteur de date et d'heure permet de voir la situation à un moment donné et de suivre l'eau vers l'aval. Le site est gratuit, sans publicité, sans offre payante, sans compte utilisateur ni traçage. Ce n'est pas un service d'alerte officiel : en cas de crue, nous renvoyons vers hydrometrie.wallonie.be et les autres canaux officiels.

Vos mentions légales autorisent la reproduction des données sans accord préalable, avec la mention de la source, mais précisent : « Sauf accord préalable et écrit du SPW, il est interdit à l'utilisateur de fournir les données à un tiers sous quelque forme que ce soit - fichiers, site web, webservice, etc - ou de diffuser celles-ci au public. » Je consulte donc déjà vos données pour mon usage strictement personnel, dans un outil privé réservé à moi seul (accessible uniquement par mon propre VPN et un mot de passe), avec la mention de la source et sans les fournir à quiconque. Elles ne seront pas diffusées au public sans votre accord. Je sollicite votre accord préalable et écrit pour :
1. afficher les données du SPW sur notre site public (carte, graphiques par station, sélecteur temporel), présentées comme des données brutes non validées ;
2. alimenter cet affichage par l'interrogation côté serveur que nous effectuons déjà toutes les 10 minutes sur le service KiWIS du site hydrometrie.wallonie.be : getTimeseriesValueLayer pour les groupes 1962373 (hauteurs) et 1962340 (débits), avec timezone=UTC, soit deux requêtes d'environ 140 Ko au total, et la liste des stations une fois par jour ;
3. montrer publiquement les valeurs conservées dans notre base de données, afin que le sélecteur temporel puisse montrer le passé ;
4. plus tard (en 2027), récupérer l'historique station par station, par fenêtres d'un an au maximum, en dehors des heures de pointe, et le montrer publiquement.
Sélection prévue : environ 25 à 40 stations, dont la Meuse de Chooz à Lixhe, la Sambre, l'Ourthe, la Vesdre, l'Amblève, la Semois et l'Escaut (Tournai, Kain, Pecq). Sur les biefs régulés par des barrages, nous afficherons de préférence le débit. Nos requêtes s'identifient par le User-Agent « rivierstanden/<version> (+<WEBSITE URL>/over; <CONTACT E-MAIL>) », avec au maximum deux connexions simultanées. Si vous préférez que nous cessions aussi l'usage personnel, dites-le-nous : nous l'arrêterons et supprimerons vos données.

Mention de la source : « Sources des données : Service public de Wallonie (SPW) », avec un lien vers https://hydrometrie.wallonie.be. Nous ne redistribuons pas les données brutes en masse : sans votre accord exprès, aucun téléchargement ni export de vos données n'est proposé. En cas de retrait de votre accord, nous retirons vos données du site public.

Mes questions :
a) Une interrogation toutes les 10 minutes vous convient-elle, ou préférez-vous un autre rythme ?
b) Quelle mention exacte souhaitez-vous voir figurer ?
c) Notre carte charge les valeurs sous forme de fichiers JSON depuis notre propre serveur ; ils sont techniquement accessibles au public, et nous proposons une petite API publique à débit limité. Est-ce acceptable, ou souhaitez-vous que les données du SPW en soient exclues ? Pourrions-nous aussi proposer les séries affichées en téléchargement CSV par station ?
d) L'affichage public des valeurs conservées comme historique (point 3) et la récupération de l'historique (point 4) sont-ils autorisés, et à quelles conditions ?
e) Les seuils d'alerte numériques (NIVCRU) et, le cas échéant, des prévisions peuvent-ils être réutilisés, et par quel moyen ?
f) Une publication de ces données sous licence ouverte (par exemple CC BY 4.0, ou au titre des séries de données de forte valeur) est-elle prévue ?
g) Si vous ne pouviez pas autoriser un affichage dynamique, des graphiques publiés sous forme d'images seraient-ils acceptables ? Les fiches Metawal permettent de « publier les données sur support statique (… pdf ou image sur Internet…) ».

Une version de test non publique fonctionne à partir d'octobre 2026 ; le lancement public est prévu début décembre 2026, avant la saison des crues.

Veuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.
<NAME>
<WEBSITE URL> · <CONTACT E-MAIL>
```
