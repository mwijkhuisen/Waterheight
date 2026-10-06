import { OfficialLinks } from '../../parts/OfficialLinks.tsx';
import { PageLink } from '../../parts/PageLink.tsx';

export default function About() {
  return (
    <>
      <h1>About this site</h1>
      <p>
        This site shows, in near real time, the water levels, discharge, official forecasts and alert levels of the
        rivers that flow into the Netherlands. The data come from open data sources in the Netherlands, Germany,
        Belgium, France, Luxembourg and Switzerland and are shown on a self-hosted map. With the date and time selector
        you look back in time and, where a source publishes a forecast, ahead as well.
      </p>
      <p>The site is in beta: data may be missing or wrong.</p>

      <h2>Not an official warning service</h2>
      <p>
        This site is not an official warning service. Read the{' '}
        <PageLink id="disclaimer" locale="en">
          disclaimer
        </PageLink>{' '}
        before you use the data, and during high water follow the official services below.
      </p>

      <h2>Official services</h2>
      <p>For warnings and current bulletins, these are the official channels in each country:</p>
      <OfficialLinks locale="en" />

      <h2>How we collect data</h2>
      <p>
        We fetch the data ourselves, regularly, from the providers’ public data services. We show each value as the
        provider publishes it, with that provider’s own unit and zero; values from different stations are therefore not
        directly comparable.
      </p>
      <p>
        Our requests to the providers carry a User-Agent that refers to this page. A provider that wants to reach us
        finds the contact address on the{' '}
        <PageLink id="colophon" locale="en">
          colophon
        </PageLink>
        .
      </p>

      <h2>Read more</h2>
      <ul>
        <li>
          <PageLink id="sources" locale="en">
            Sources and licences
          </PageLink>
          : which sources we use, under which licence and with which credit.
        </li>
        <li>
          <PageLink id="method" locale="en">
            Method
          </PageLink>
          : how we show classes, heights and forecasts, and which rivers we do not cover.
        </li>
        <li>
          <PageLink id="status" locale="en">
            Source status
          </PageLink>
          : whether each source has delivered data recently.
        </li>
      </ul>
    </>
  );
}
