import { Contact } from '../../parts/Contact.tsx';

export default function Accessibility() {
  return (
    <>
      <h1>Accessibility</h1>
      <p>
        We want as many people as possible to be able to use this site. Our aim is WCAG 2.2 level AA. The site is in
        beta and does not yet meet it in every respect; below is what works and what does not.
      </p>

      <h2>The table as an alternative to the map</h2>
      <p>
        The map is a drawing surface and is not meant for screen readers. The table is the alternative: the same
        stations and the same values for the selected time, usable with a keyboard and a screen reader. Under “View”,
        choose the button “Table”. If your browser cannot show the map (no WebGL2), you get the table automatically. The
        table shows 100 rows at a time; use “Previous” and “Next” to move on.
      </p>

      <h2>Using the keyboard</h2>
      <ul>
        <li>
          Timeline: the arrow keys move 10 minutes back or forward, Page Up and Page Down move an hour, and Home and End
          go to the start and the end of the timeline. You can also type a date and a time and use the buttons “10
          minutes back”, “10 minutes forward”, “Now”, “Play” and “Pause”. Play is off if your device asks for reduced
          motion.
        </li>
        <li>
          Map mode (“State”, “Change over 24 hours” and “Discharge”): three radio buttons, which you switch with the
          arrow keys.
        </li>
        <li>
          Station list: choose a station with the arrow keys. The focus then stays on the list, so you can keep
          choosing; the panel with the station’s data comes after the map or the table in the page order.
        </li>
        <li>
          Table: a station’s name is a button. When you activate it, the panel opens and the focus moves to the panel’s
          heading. If you close the panel with the button “Close station”, the focus returns to the button you opened it
          with, or otherwise to the station list.
        </li>
        <li>
          Map: once the map has loaded, you can pan it with the keyboard (arrow keys) and zoom it (plus and minus).
        </li>
      </ul>

      <h2>Known limitations</h2>
      <ul>
        <li>
          The map itself is not accessible to screen readers, and the stations on the map cannot be chosen one by one
          with the keyboard. Use the table or the station list for that.
        </li>
        <li>
          The chart in the station panel is a picture with a short description (the period and the unit). What else it
          shows, such as the course over seven days, the thresholds and the course of a forecast, is not given as text
          on the page. The panel does give the value at the selected time, its age, the state, the basis and the change
          over 24 hours; use the time selector to read other moments.
        </li>
        <li>
          The colours of the map were chosen to stay apart for people with colour blindness. The size of a marker
          follows the state, and small triangles show rising or falling. The table, the pop-up and the panel say it in
          words. Whether that is enough is something no automatic test can judge.
        </li>
        <li>
          Names and texts from the sources, such as station names and credits, are shown as the source publishes them,
          often in German or French. Only credits whose language is known are marked with that language.
        </li>
      </ul>

      <h2>Report a problem</h2>
      <p>Did you run into something that is not accessible? Tell us, with the page and what went wrong:</p>
      <Contact locale="en" />
    </>
  );
}
