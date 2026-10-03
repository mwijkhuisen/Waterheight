import { type Meta, ODBL_URL } from '@rws/contracts';
import { useCallback, useMemo, useRef, useState } from 'react';
import styles from './App.module.css';
import { StationsMap } from './features/map/StationsMap.tsx';
import { markerStates } from './features/map/stationLayer.ts';
import { hasWebGL2 } from './features/map/webgl.ts';
import { StationPanel } from './features/station/StationPanel.tsx';
import { StationTable } from './features/table/StationTable.tsx';
import { Timebar } from './features/timebar/Timebar.tsx';
import { attributionText } from './lib/attribution.ts';
import {
  chartSpan,
  downloadHref,
  useDebounced,
  useMeta,
  useRiversManifest,
  useSnapshot,
  useStations,
} from './lib/data/api.ts';
import { formatDay, quantise, ZONE } from './lib/time/time.ts';
import { otherLanguageHref } from './lib/url/url.ts';
import { useUrlState } from './lib/url/useUrlState.ts';
import { m } from './paraglide/messages.js';
import type { Locale } from './paraglide/runtime.js';

// One page per language (NL at /, EN at /en/): the map or the table of the
// DE-1 and NL-1 stations at the instant `?t=`, the station `?s=` in a panel.
// The language link is a full page load that keeps t and s, so <html lang>
// always matches the page (A§10).

const PAGES = new Set(['/', '/index.html', '/en/', '/en/index.html']);
/** The API refuses a `t` more than 5 minutes ahead of its clock. */
const SKEW_MS = 5 * 60_000;
const FETCH_DEBOUNCE_MS = 150;

export function App({ locale }: { locale: Locale }) {
  return (
    <>
      <p className={styles.beta}>{m.beta_banner({}, { locale })}</p>
      {PAGES.has(location.pathname) ? <Viewer locale={locale} /> : <NotFound locale={locale} />}
    </>
  );
}

function NotFound({ locale }: { locale: Locale }) {
  return (
    <>
      <main className={styles.main}>
        <h1>{m.not_found_heading({}, { locale })}</h1>
        <p>
          <a href={locale === 'nl' ? '/' : '/en/'}>{m.not_found_link({}, { locale })}</a>
        </p>
      </main>
      <Footer locale={locale} meta={undefined} t={undefined} />
    </>
  );
}

function Viewer({ locale }: { locale: Locale }) {
  const meta = useMeta();
  const stations = useStations();
  const [url, setUrl] = useUrlState();
  const [webgl] = useState(hasWebGL2);
  const [mapFailed, setMapFailed] = useState(false);
  const [view, setView] = useState<'map' | 'table'>('map');

  const range = useMemo(() => {
    if (meta.data === undefined) return undefined;
    const start = Date.parse(meta.data.displayStart);
    const now = Date.parse(meta.data.now);
    const end = quantise(Math.min(Date.now(), now + SKEW_MS));
    return { start, end: Math.max(start, end), epoch: Date.parse(meta.data.dataEpoch), now };
  }, [meta.data]);
  // A `t` outside [displayStart, now] is treated as no `t`: now.
  const t = range && (url.t !== undefined && url.t >= range.start && url.t <= range.end ? url.t : range.end);
  const list = useMemo(
    () => [...(stations.data?.stations ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [stations.data, locale],
  );
  const selected = url.s === undefined ? undefined : list.find((st) => st.id === url.s);

  // The data follows `t` once it has settled: a drag or a held key asks only for where it stops.
  const settled = useDebounced(t, FETCH_DEBOUNCE_MS);
  const snapshot = useSnapshot(settled);
  // Until the values of this very `t` are in, the ones on screen are marked as not current (aria-busy, dimmed).
  const current = snapshot.data !== undefined && t !== undefined && Date.parse(snapshot.data.t) === t;
  // Not after a failed request: the alert says so, and a dimmed page would stay unreadable (review round 2).
  const loading = !current && !snapshot.isError;
  const values = useMemo(() => new Map((snapshot.data?.values ?? []).map((v) => [v.series, v])), [snapshot.data]);
  const states = useMemo(() => markerStates(list, values), [list, values]);

  const setT = useCallback((next: number) => setUrl({ t: next }), [setUrl]);
  const select = useCallback((id: string | undefined) => setUrl({ s: id }), [setUrl]);
  // Opening a station from the map or the table moves the focus into the panel; choosing one in the list does
  // not (the arrow keys of a list change its value at every press), and closing the panel returns to the list.
  const [focusPanel, setFocusPanel] = useState(false);
  const listRef = useRef<HTMLSelectElement>(null);
  const open = useCallback(
    (id: string | undefined) => {
      setFocusPanel(true);
      select(id);
    },
    [select],
  );
  const close = useCallback(() => {
    select(undefined);
    listRef.current?.focus();
  }, [select]);
  const failed = useCallback(() => setMapFailed(true), []);

  const canMap = webgl && !mapFailed;
  const notice = !webgl ? m.map_no_webgl({}, { locale }) : mapFailed ? m.map_unavailable({}, { locale }) : undefined;

  return (
    <>
      <header className={styles.header}>
        <h1>{m.heading({}, { locale })}</h1>
        <a
          href={otherLanguageHref(locale, url)}
          hrefLang={locale === 'nl' ? 'en' : 'nl'}
          lang={locale === 'nl' ? 'en' : 'nl'}
        >
          {m.other_language({}, { locale })}
        </a>
      </header>
      <main className={styles.main}>
        {range === undefined || t === undefined || stations.data === undefined ? (
          meta.isError || stations.isError ? (
            <p role="alert">{m.data_unavailable({}, { locale })}</p>
          ) : (
            <p role="status">{m.loading({}, { locale })}</p>
          )
        ) : (
          <>
            <Timebar locale={locale} t={t} start={range.start} end={range.end} epoch={range.epoch} onChange={setT} />
            <div className={styles.controls}>
              {canMap && (
                <fieldset className={styles.toggle}>
                  <legend>{m.view_label({}, { locale })}</legend>
                  <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
                    {m.view_map({}, { locale })}
                  </button>
                  <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
                    {m.view_table({}, { locale })}
                  </button>
                </fieldset>
              )}
              <label className={styles.select}>
                {m.station_select_label({}, { locale })}
                <select
                  ref={listRef}
                  value={selected?.id ?? ''}
                  onChange={(e) => {
                    setFocusPanel(false);
                    select(e.currentTarget.value || undefined);
                  }}
                >
                  <option value="">{m.station_select_none({}, { locale })}</option>
                  {list.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.waterName === null ? st.name : `${st.name} (${st.waterName})`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {notice !== undefined && (
              <p role="status" className={styles.notice}>
                {notice} {m.map_fallback({}, { locale })}
              </p>
            )}
            {snapshot.isError && <p role="alert">{m.data_unavailable({}, { locale })}</p>}
            <div className={loading ? `${styles.body} ${styles.busy}` : styles.body} aria-busy={loading}>
              <div className={styles.view}>
                {canMap && view === 'map' ? (
                  <StationsMap
                    locale={locale}
                    stations={list}
                    states={states}
                    values={values}
                    selected={selected}
                    onSelect={open}
                    onClose={close}
                    onFailure={failed}
                  />
                ) : (
                  <StationTable
                    locale={locale}
                    stations={list}
                    values={values}
                    t={t}
                    selected={selected?.id}
                    onSelect={open}
                  />
                )}
              </div>
              {selected !== undefined && (
                <StationPanel
                  key={selected.id}
                  locale={locale}
                  station={selected}
                  values={values}
                  t={t}
                  dataEpoch={range.epoch}
                  chartSpan={chartSpan(settled ?? t, range.start, range.now)}
                  focus={focusPanel}
                  onClose={close}
                />
              )}
            </div>
          </>
        )}
      </main>
      <Footer locale={locale} meta={meta.data} t={t} />
    </>
  );
}

/** Only an https link from the registry becomes an anchor; anything else stays text. */
const httpsUrl = (url: string | null): string | undefined => {
  if (url === null) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The sources from /meta, a source that fills another's series included (FR-3, CH-3). Where a row needs a date, it
 * is the Amsterdam date of `t` in the page's language; a text that another source already showed is not repeated
 * (CH-3 says what CH-1 says).
 */
function Footer({ locale, meta, t }: { locale: Locale; meta: Meta | undefined; t: number | undefined }) {
  const date = t === undefined ? undefined : formatDay(t, locale, ZONE);
  const download = downloadHref(useRiversManifest().data);
  const shown = new Set<string>();
  return (
    <footer className={styles.footer}>
      <p className={styles.disclaimer}>{m.disclaimer({}, { locale })}</p>
      {meta !== undefined && date !== undefined && meta.sources.length > 0 && (
        <>
          <h2>{m.sources_heading({}, { locale })}</h2>
          <ul>
            {meta.sources.flatMap((source) =>
              source.attribution.flatMap((a) => {
                const text = attributionText(a.text, a.needsDate, date);
                const href = httpsUrl(a.url);
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
      <p>
        <a href="https://www.openstreetmap.org/copyright">{m.osm_credit({}, { locale })}</a> ·{' '}
        {m.protomaps_credit({}, { locale })}
      </p>
      <p>
        {m.rivers_licence_lead({}, { locale })} <a href={ODBL_URL}>{m.rivers_licence_link({}, { locale })}</a>.{' '}
        {m.rivers_collective({}, { locale })}
        {download !== undefined && (
          <>
            {' '}
            <a href={download}>{m.rivers_download({}, { locale })}</a>
          </>
        )}
      </p>
      <p>
        <a href="/third-party-notices.txt">{m.notices_link({}, { locale })}</a>
      </p>
    </footer>
  );
}
