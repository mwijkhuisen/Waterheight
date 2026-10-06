import { CrosswalkTable } from '../../parts/CrosswalkTable.tsx';
import { DatumTable } from '../../parts/DatumTable.tsx';
import { ForecastCoverage } from '../../parts/ForecastCoverage.tsx';
import { PageLink } from '../../parts/PageLink.tsx';
import { TravelTimes } from '../../parts/TravelTimes.tsx';

export default function Method() {
  return (
    <>
      <h1>Method</h1>
      <p>
        This page explains how the site classifies water levels, which heights and datums it uses, where official
        forecasts exist, what a travel time is and which rivers are (not yet) covered. The site is not an official
        warning service: read{' '}
        <PageLink id="disclaimer" locale="en">
          the disclaimer
        </PageLink>
        .
      </p>

      <h2>How a value gets a state</h2>
      <p>
        Every value gets one state on a scale of six steps: no reference, low, normal, elevated, high and extreme. The
        station panel shows the basis of every state.
      </p>
      <ul>
        <li>
          <strong>Priority.</strong> First the official thresholds and classes of the agency that operates the station
          (the published class comes before our own comparison with the thresholds), then statistical references such as
          the mean high water level, and only then the display classes of the provider itself, such as those of RWS
          Waterinfo. An area class counts only where the station has no state of its own; a class of the station itself
          always beats an area class.
        </li>
        <li>
          <strong>Basis.</strong> The state says what it rests on: the stage at the station (the level relative to the
          gauge zero), the discharge, or an area.
        </li>
        <li>
          <strong>Section.</strong> A station with no state of its own that lies in an area with a warning class takes
          the colour of that area and the badge “section”: the state is the area's, not the station's.
        </li>
        <li>
          <strong>Grey: no reference.</strong> A grey station has no deciding reference. We never guess: no threshold
          from a neighbouring station, no default and no interpolation.
        </li>
        <li>
          <strong>Not strictly equivalent.</strong> The classes follow each agency's own references; “elevated” at one
          agency is not strictly the same as “elevated” at another. The classes of RWS Waterinfo are display classes and
          never warnings.
        </li>
      </ul>
      <p>
        The tables below are built from the same tables as the classification itself (public sources only), so they
        cannot drift from it. Codes and short names are written as the agency writes them.
      </p>
      <CrosswalkTable locale="en" />

      <h2>Heights and datums</h2>
      <p>
        Every value is shown as its source publishes it, with its own unit and zero (gauge zero, NAP, NN). Raw readings
        and absolute heights from different gauges and countries cannot be compared: absolute heights mostly reflect the
        slope of the river, and gauge zeros differ from place to place.
      </p>
      <p>
        Only in the station panel does the site convert to “≈ m NAP”, and only for a stage with a gauge zero in a
        convertible datum or a level in its own datum; never on the map. The conversion is H_NAP = H_datum + offset.
      </p>
      <ul>
        <li>TAW (Flanders) and DNG (the French name for it): H_NAP = H_TAW − 2.33 m.</li>
        <li>NHN (Germany) equals NAP within a few centimetres.</li>
        <li>LN02 (Switzerland): at Basel a height in LN02 is about 0.32 m larger than the same height in NHN.</li>
        <li>
          France: French stations show only their published gauge zero (from Hub’Eau metadata, unverified) and never a
          converted height. The site states no offset from IGN69 or NGF-1884 to NAP: at the shared gauges where both
          Hub’Eau and PEGELONLINE publish the gauge zero, the two zeros differ by +0.535 to +1.57 m, so the published
          conversions do not hold there. The same applies to any gauge zero that comes only from Hub’Eau metadata.
        </li>
      </ul>
      <DatumTable locale="en" />

      <h2>Forecasts</h2>
      <p>
        Official forecasts are on the timeline to the right of “now”. The timeline reaches at most 48 hours ahead and
        never beyond the horizon that the provider itself gives for the selected station. A value beyond the part the
        provider forecasts itself is called an “estimate”. Forecasts from different providers are never blended: for
        each series and time the site shows one source. Only official forecasts count; the site does not use model
        outlooks such as GloFAS. As a result the future is not visible equally far everywhere.
      </p>
      <ForecastCoverage locale="en" />

      <h2>Travel times</h2>
      <p>
        Travel times of flood peaks are typical and indicative, never an arrival time. They depend strongly on the
        discharge: between low water and flood a travel time differs by a factor of 1.5 to 2. The site therefore shows
        only sourced ranges (from–to, in hours) between two stations, never a time relative to now. The tidal rivers
        Scheldt and Ems have no travel times: the tide runs upstream, so a downstream travel time does not apply to
        water levels there.
      </p>
      <TravelTimes locale="en" />

      <h2>Rivers that are not covered</h2>
      <p>The first release lacks these rivers or river stretches:</p>
      <ul>
        <li>
          The Kempen rivers that flow straight into the Netherlands: Mark, Dommel, Aa or Weerijs, Warmbeek, Keersop,
          Merkske and Voer, until data from the Flemish Environment Agency (VMM) become available.
        </li>
        <li>
          Ahr, Kyll, Prüm and Nahe in Rhineland-Palatinate: only the classes of the Länderübergreifendes
          Hochwasserportal (LHP), until data from the Landesamt für Umwelt Rheinland-Pfalz (LfU RLP) become available.
        </li>
        <li>
          Austria and Liechtenstein (Ill, Bregenzerach and Lake Constance at Bregenz): outside the first release. The
          Alpine Rhine and Lake Constance come from the data of the Swiss BAFU.
        </li>
        <li>
          Stretches managed by Dutch water boards: of these the site shows only what the German upstream gauges and
          Rijkswaterstaat measure; data from the water boards themselves are on a waiting list.
        </li>
      </ul>
      <p>
        Which sources the site uses is listed on{' '}
        <PageLink id="sources" locale="en">
          Sources and licences
        </PageLink>
        .
      </p>
    </>
  );
}
