import { Cdn } from '../../parts/Cdn.tsx';
import { Contact } from '../../parts/Contact.tsx';
import { LogPolicy } from '../../parts/LogPolicy.tsx';

export default function Privacy() {
  return (
    <>
      <h1>Privacy</h1>

      <h2>Who is responsible</h2>
      <Contact locale="en" />

      <h2>No cookies, no trackers</h2>
      <p>
        This site uses no cookies, no trackers and no statistics or analytics services. Your browser asks no other
        server for anything when you visit: every file the page loads, the map included, comes from this site itself. A
        link to another site loads only when you click it.
      </p>

      <h2>Nothing stored in your browser</h2>
      <p>
        We store nothing in your browser: no cookies, no localStorage and no other storage. The view you choose (time,
        station, map mode and river) is kept only in the web address, and your language follows from the address: pages
        with /en/ in the address are English.
      </p>

      <h2>Access log</h2>
      <p>
        Our web server writes a line in an access log for every request: the time, the web address asked for (with a
        chosen time or station, if they are in the address), the status code, the size of the answer, what your browser
        sends by itself (such as the browser name and the language preference) and your IP address in shortened form.
        The Authorization and Cookie headers are never logged.
      </p>
      <LogPolicy locale="en" topic="access" />
      <p>We use the log to monitor how the site works and to keep it secure, for example to spot faults and misuse.</p>

      <h2>Limiting overload</h2>
      <p>
        The site’s API limits how many requests one address may make in a given time. The counters for this are held
        only in the program’s memory: they are never written to disk and disappear when it restarts.
      </p>

      <h2>Reports from your browser</h2>
      <p>
        If your browser blocks something that this site may not load, it can send a report about it to{' '}
        <code>POST /api/v1/beacon</code>. A normal visit sends none.
      </p>
      <LogPolicy locale="en" topic="beacon" />
      <p>
        For such a report our server writes one line in the server log and stores nothing else. The line can say on
        which page it happened, which address was blocked and what your browser says about itself (such as the browser
        name); your IP address and the headers of the request are not in it.
      </p>

      <h2>CDN</h2>
      <Cdn locale="en" />

      <h2>Your rights</h2>
      <p>
        You can ask us, through the contact address above, for access to the data we hold about you, for correction or
        deletion, and you can object to the processing. Because the log holds only shortened addresses, we may not be
        able to link a request to you. If you have a complaint about how we handle your data, you can lodge it with the
        Autoriteit Persoonsgegevens, the Dutch data protection authority.
      </p>
    </>
  );
}
