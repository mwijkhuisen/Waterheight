import { PageLink } from '../../parts/PageLink.tsx';
import { StatusTables } from '../../parts/StatusTables.tsx';

export default function Status() {
  return (
    <>
      <h1>Source status</h1>
      <p>
        This page shows how fresh each source's data are, read from the site's status file. The source IDs are those of{' '}
        <PageLink id="sources" locale="en">
          the Sources and licences page
        </PageLink>
        . All times are Netherlands time. Data are shown as the provider publishes them and are not validated; the site
        is not an official warning service (
        <PageLink id="disclaimer" locale="en">
          disclaimer
        </PageLink>
        ).
      </p>

      <h2>What the columns mean</h2>
      <ul>
        <li>
          <strong>Status.</strong> “ok”: the source's data arrive on time. “Degraded”: a payload was rejected, the
          latest data are older than two fetch intervals, or fewer than 95 % of the main series (tier 1) have a fresh
          value (a value that the provider itself does not renew counts as fresh). “Down”: the last successful fetch is
          older than three intervals, or five or more attempts in a row have failed. “Unknown”: the source has not been
          fetched yet.
        </li>
        <li>
          <strong>Last fetch</strong> is the moment of the last successful fetch and <strong>newest value</strong> the
          time of the newest value we hold from the source.
        </li>
        <li>
          <strong>Delay</strong> is the time between fetching and storing: 95 % of the fetched files are in the database
          within that time.
        </li>
        <li>
          <strong>Coverage</strong> is the share of the expected values of the main series that has been stored, from
          the first hour with data.
        </li>
        <li>
          <strong>Forecast run</strong> is how old the source's newest forecast is. For a source with a fixed schedule,
          “late” means that a due run is missing; that does not change the status.
        </li>
      </ul>

      <h2>Sources and checks</h2>
      <p>
        Owner sources are not shown on the public site; there only their number appears. Twin checks compare every hour
        two series of the same water (for example the same level at two providers) over the last 24 hours: “failing”
        means they differ by more than the allowed margin.
      </p>
      <p>
        Tier-1 stations are the stations chosen for the map; first-release stations are the tier-1 stations with a
        public main series. A station “with a state” has a state other than “no reference” (see{' '}
        <PageLink id="method" locale="en">
          Method
        </PageLink>
        ); a forecast is current as long as it still reaches now.
      </p>
      <StatusTables locale="en" />
    </>
  );
}
