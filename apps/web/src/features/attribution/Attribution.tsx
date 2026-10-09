import type { Meta } from '@rws/contracts';
import { type FocusEvent, type KeyboardEvent, useId, useRef, useState } from 'react';
import { attributionText } from '../../lib/attribution.ts';
import { httpsHref } from '../../lib/href.ts';
import { pathOf } from '../../lib/routes.ts';
import { formatDay, ZONE } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { MapCredits } from '../pages/parts/MapCredits.tsx';
import styles from './attribution.module.css';

// The credits of the map (P10e D1): what the footer of the map showed until P10d, in a disclosure next to
// MapLibre's own attribution button. Licences require them with the displayed data (invariant 8), so they are moved,
// not dropped: the attribution of every source /meta lists for this instant (a source that fills another's series
// included: FR-3, CH-3), the map credits (OpenStreetMap, Protomaps, the ODbL river graph), the disclaimer line and
// the links to the sources page and the third-party notices. Provider text is only ever a text node here (never
// MapLibre's `customAttribution` or an HTML string), a link only through httpsHref. `MapCredits` is imported
// statically, so the licence text stays in the entry chunk (verify-prod's "rivers attribution").

export interface AttributionProps {
  locale: Locale;
  meta: Meta | undefined;
  /** The instant on screen: where a row needs a date, it is the Amsterdam date of t in the page's language. */
  t: number | undefined;
  /** P11b: while playing, the credits of the loaded frames (FrameStore.attribution), as text. */
  played?: readonly { source: string; lang: string | null; text: string }[] | undefined;
}

export function Attribution({ locale, meta, t }: AttributionProps) {
  const o = { locale };
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const date = t === undefined ? undefined : formatDay(t, locale, ZONE);
  const shown = new Set<string>();

  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
  };
  // Focus leaving the control closes the panel; the panel itself takes the focus when its text is clicked.
  const leave = (e: FocusEvent<HTMLElement>) => {
    if (open && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the control closes it
    <div className={styles.root} onKeyDown={keys} onBlur={leave}>
      <button
        type="button"
        ref={button}
        className={styles.button}
        aria-expanded={open}
        aria-controls={open ? `${id}-p` : undefined}
        // Focus the button on the press itself: where a click does not focus a button (WebKit, Firefox on macOS),
        // the press would blur the panel to nothing, close it, and the click would open it again.
        onMouseDown={(e) => {
          e.preventDefault();
          e.currentTarget.focus();
        }}
        onClick={() => setOpen((v) => !v)}
      >
        {m.sources_heading({}, o)}
      </button>
      {open && (
        <section id={`${id}-p`} className={styles.panel} aria-label={m.attribution_panel_label({}, o)} tabIndex={-1}>
          {meta !== undefined && date !== undefined && meta.sources.length > 0 && (
            <>
              <h2>{m.sources_heading({}, o)}</h2>
              <ul>
                {meta.sources.flatMap((source) =>
                  source.attribution.flatMap((a) => {
                    const text = attributionText(a.text, a.needsDate, date);
                    const href = httpsHref(a.url);
                    const seen = `${a.lang}|${href}|${text}`;
                    if (shown.has(seen)) return [];
                    shown.add(seen);
                    return [
                      <li key={`${source.id}|${a.text}`} lang={a.lang ?? undefined}>
                        {href === undefined ? text : <a href={href}>{text}</a>}
                      </li>,
                    ];
                  }),
                )}
              </ul>
            </>
          )}
          <MapCredits locale={locale} />
          <p className={styles.disclaimer}>{m.disclaimer({}, o)}</p>
          <p>
            <a href={pathOf('sources', locale)}>{m.page_sources_title({}, o)}</a>
            {' · '}
            <a href="/third-party-notices.txt">{m.notices_link({}, o)}</a>
          </p>
        </section>
      )}
    </div>
  );
}
