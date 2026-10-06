import { OfficialLinks } from '../../parts/OfficialLinks.tsx';

export default function Disclaimer() {
  return (
    <>
      <h1>Not an official warning service</h1>
      <p>
        This site is not an official warning service. Never use the data on this site for decisions about your safety
        during high water or flooding.
      </p>

      <h2>The data are raw and unvalidated</h2>
      <p>
        The water levels and discharges are live measurements that the providers publish themselves, and those providers
        themselves warn that such data are raw and unvalidated. They can arrive late, be missing or be wrong.
      </p>

      <h2>Classes, levels and forecasts</h2>
      <p>
        The classes that Rijkswaterstaat shows on Waterinfo, such as “elevated” or “high water”, are Waterinfo display
        classes and not warnings. The levels and colours on the map follow each agency’s own references and are not
        strictly equivalent.
      </p>
      <p>
        Forecasts are the providers’ own. If you move the time selector past now, we only show what they have published.
        A forecast can differ from what happens.
      </p>

      <h2>Follow the official services</h2>
      <p>During high water, follow the official service of the country you are in:</p>
      <OfficialLinks locale="en" />
      <p>In an emergency, call 112 and follow the instructions of the local authorities and the emergency services.</p>

      <h2>Liability</h2>
      <p>
        We take care over this site, but we give no guarantee that it is correct, complete or available. As far as the
        law allows, we are not liable for any loss that arises because you use this site or its data, or rely on them.
      </p>

      <h2>Beta</h2>
      <p>This site is in beta: it is still under development, and data, features and texts may change.</p>
    </>
  );
}
