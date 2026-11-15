import { Cdn } from '../../parts/Cdn.tsx';
import { Contact } from '../../parts/Contact.tsx';
import { LogPolicy } from '../../parts/LogPolicy.tsx';

export default function Privacy() {
  return (
    <>
      <h1>Privacy</h1>

      <h2>CDN</h2>
      <Cdn locale="en" />

      <h2>Who is responsible</h2>
      <Contact locale="en" />

      <h2>Visit statistics</h2>
      <p>
        To know how many people use this site and which pages they read, each page you open sends one short message to{' '}
        <code>stats.waterradar.io</code>: our own statistics server (Umami), which runs on the same machine as this
        site. The message passes through Cloudflare’s network, so Cloudflare receives it with your IP address. It is the
        only request your browser makes beyond this site: every file the page loads, the map included, comes from this
        site itself, and a link to another site loads only when you click it.
      </p>
      <p>
        The message holds the address of the page without the part after the question mark (so not the time or station
        you chose), the page title, the site and page you came from (also without that part), the language of your
        browser and the size of your screen. From the request, the statistics server works out the browser, the
        operating system, the kind of device and the country, and the region and city where Cloudflare supplies them. It
        stores no IP address and sets no cookie. To count a visitor once, it makes a code from your IP address and
        browser, a secret key and the current month that cannot be turned back into your IP address; from the next month
        you count as a new visitor.
      </p>
      <p>
        If your browser sends Do Not Track, no message is sent. The statistics are for us alone, are shared with no one
        and are kept until we delete them.
      </p>

      <h2>Nothing stored in your browser</h2>
      <p>
        We store nothing in your browser: no cookies, no localStorage and no other storage. The view you choose (time,
        station, map mode and river) is kept only in the web address, and your language follows from the address: pages
        with /en/ in the address are English. The statistics script writes nothing either: it only checks whether the
        setting <code>umami.disabled</code> is there, and then sends nothing.
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

      <h2>Your rights</h2>
      <p>
        You can ask us, through the contact address above, for access to the data we hold about you, for correction or
        deletion, and you can object to the processing. Because the log holds only shortened addresses and the
        statistics hold no address at all, we may not be able to link a request or a visit to you. If you have a
        complaint about how we handle your data, you can lodge it with the Autoriteit Persoonsgegevens, the Dutch data
        protection authority.
      </p>
    </>
  );
}
