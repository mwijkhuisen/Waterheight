import { OfficialLinks } from '../../parts/OfficialLinks.tsx';

export default function Disclaimer() {
  return (
    <>
      <h1>Geen officiële waarschuwingsdienst</h1>
      <p>
        Deze site is geen officiële waarschuwingsdienst. Gebruik de gegevens op deze site nooit voor beslissingen over
        je veiligheid bij hoogwater of overstroming.
      </p>

      <h2>De gegevens zijn ruw en niet gevalideerd</h2>
      <p>
        De waterstanden en afvoeren zijn actuele metingen die de aanbieders zelf publiceren, en die aanbieders
        waarschuwen er zelf voor dat zulke gegevens ruw en niet gevalideerd zijn. Ze kunnen te laat komen, ontbreken of
        onjuist zijn.
      </p>

      <h2>Klassen, niveaus en verwachtingen</h2>
      <p>
        De klassen die Rijkswaterstaat op Waterinfo toont, zoals “verhoogd” of “hoogwater”, zijn weergaveklassen van
        Waterinfo en geen waarschuwingen. De niveaus en kleuren op de kaart volgen de eigen referenties van elke dienst
        en zijn niet strikt gelijkwaardig.
      </p>
      <p>
        Verwachtingen zijn die van de aanbieders zelf. Zet je de tijdkiezer voorbij het nu, dan tonen wij alleen wat zij
        hebben gepubliceerd. Een verwachting kan afwijken van wat er gebeurt.
      </p>

      <h2>Volg de officiële diensten</h2>
      <p>Volg bij hoogwater de officiële dienst van het land waar je bent:</p>
      <OfficialLinks locale="nl" />
      <p>Bel in een noodsituatie 112 en volg de aanwijzingen van de lokale autoriteiten en de hulpdiensten.</p>

      <h2>Aansprakelijkheid</h2>
      <p>
        Wij besteden zorg aan deze site, maar geven geen garantie op de juistheid, de volledigheid of de beschikbaarheid
        ervan. Voor zover de wet het toelaat, zijn wij niet aansprakelijk voor schade die ontstaat doordat je deze site
        of de gegevens erop gebruikt of erop vertrouwt.
      </p>

      <h2>Bèta</h2>
      <p>Deze site is in bèta: hij is nog in ontwikkeling, en gegevens, functies en teksten kunnen veranderen.</p>
    </>
  );
}
