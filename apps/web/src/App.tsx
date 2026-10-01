import type { Meta } from '@rws/contracts';
import { useCallback, useMemo, useRef, useState } from 'react';
import styles from './App.module.css';
import { StationsMap } from './features/map/StationsMap.tsx';
import { markerStates } from './features/map/stationLayer.ts';
import { hasWebGL2 } from './features/map/webgl.ts';
import { StationPanel } from './features/station/StationPanel.tsx';
import { StationTable } from './features/table/StationTable.tsx';
import { Timebar } from './features/timebar/Timebar.tsx';
import { chartSpan, useDebounced, useMeta, useSnapshot, useStations } from './lib/data/api.ts';
import { quantise } from './lib/time/time.ts';
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
      <Footer locale={locale} meta={undefined} />
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
    const end = quantise(Math.min(Date.now(), Date.parse(meta.data.now) + SKEW_MS));
    return { start, end: Math.max(start, end), epoch: Date.parse(meta.data.dataEpoch) };
  }, [meta.data]);
  // A `t` outside [displayStart, now] is treated as no `t`: now.
  const t = range && (url.t !== undefined && url.t >= range.start && url.t <= range.end ? url.t : range.end);
  const list = useMemo(
    () => [...(stations.data?.stations ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [stations.data, locale],
  );
  const selected = url.s === undefined ? undefined : list.find((st) => st.id === url.s);

  const snapshot = useSnapshot(useDebounced(t, FETCH_DEBOUNCE_MS));
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
            <div className={styles.body}>
              <div className={styles.view}>
                {canMap && view === 'map' ? (
                  <StationsMap
                    locale={locale}
                    stations={list}
                    states={states}
                    selected={selected}
                    onSelect={open}
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
                  chartSpan={chartSpan(t, range.start, range.end)}
                  focus={focusPanel}
                  onClose={() => {
                    select(undefined);
                    listRef.current?.focus();
                  }}
                />
              )}
            </div>
          </>
        )}
      </main>
      <Footer locale={locale} meta={meta.data} />
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

function Footer({ locale, meta }: { locale: Locale; meta: Meta | undefined }) {
  return (
    <footer className={styles.footer}>
      <p className={styles.disclaimer}>{m.disclaimer({}, { locale })}</p>
      {meta !== undefined && meta.sources.length > 0 && (
        <>
          <h2>{m.sources_heading({}, { locale })}</h2>
          <ul>
            {meta.sources.flatMap((source) =>
              source.attribution.map((a) => {
                const href = httpsUrl(a.url);
                return (
                  <li key={`${source.id}|${a.text}`} lang={a.lang ?? undefined}>
                    {href === undefined ? a.text : <a href={href}>{a.text}</a>}
                  </li>
                );
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
        <a href="/third-party-notices.txt">{m.notices_link({}, { locale })}</a>
      </p>
    </footer>
  );
}
