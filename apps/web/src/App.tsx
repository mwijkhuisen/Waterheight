import { type Meta, ODBL_URL } from '@rws/contracts';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './App.module.css';
import { DegradedBanner } from './features/banner/DegradedBanner.tsx';
import { Legend } from './features/legend/Legend.tsx';
import { ModeControl } from './features/legend/ModeControl.tsx';
import { RiverChip } from './features/legend/RiverChip.tsx';
import { StationsMap } from './features/map/StationsMap.tsx';
import { hasWebGL2 } from './features/map/webgl.ts';
import { StationPanel } from './features/station/StationPanel.tsx';
import { StationTable } from './features/table/StationTable.tsx';
import { Timebar } from './features/timebar/Timebar.tsx';
import { attributionText } from './lib/attribution.ts';
import {
  chartSpan,
  downloadHref,
  useAudience,
  useAudienceQuery,
  useChanges,
  useDebounced,
  useMeta,
  useMode,
  useOwnerSources,
  useRiver,
  useRivers,
  useRiversManifest,
  useSnapshot,
  useSources,
  useStationHorizon,
  useStations,
  useWarnings,
} from './lib/data/api.ts';
import { globalEnd, pageT, sliderEnd } from './lib/forecast.ts';
import { stationStates } from './lib/stationStates.ts';
import { formatDay, quantise, ZONE } from './lib/time/time.ts';
import { otherLanguageHref } from './lib/url/url.ts';
import { useUrlState } from './lib/url/useUrlState.ts';
import { m } from './paraglide/messages.js';
import type { Locale } from './paraglide/runtime.js';

// One page per language (NL at /, EN at /en/): the map or the table of the
// DE-1 and NL-1 stations at the instant `?t=`, the station `?s=` in a panel. After now (P8b) the timeline
// reaches into the forecast, as far as the selected station's forecast does (at most 48 h).
// The language link is a full page load that keeps t and s, so <html lang>
// always matches the page (A§10).

const PAGES = new Set(['/', '/index.html', '/en/', '/en/index.html']);
const FETCH_DEBOUNCE_MS = 150;

// The owner chunk (P10a T12): fetched only on the owner site, never by the public page.
const OwnerBanner = lazy(() => import('./features/owner/index.ts').then((o) => ({ default: o.OwnerBanner })));

export function App({ locale }: { locale: Locale }) {
  const owner = useAudience() === 'owner';
  return (
    <>
      {owner && <OwnerShell locale={locale} />}
      <p className={styles.beta}>{m.beta_banner({}, { locale })}</p>
      {PAGES.has(location.pathname) ? <Viewer locale={locale} /> : <NotFound locale={locale} />}
    </>
  );
}

/** The persistent owner banner on every view of the owner site (T-OWN-5); nothing on the public site. */
function OwnerShell({ locale }: { locale: Locale }) {
  const sources = useSources().data;
  const owned = useMemo(() => sources?.sources.filter((s) => s.audience === 'owner'), [sources]);
  return (
    <Suspense fallback={null}>
      <OwnerBanner locale={locale} sources={owned} />
    </Suspense>
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
  const [url, setUrl] = useUrlState();
  // Live (P10a T7): no `t` in the URL. meta, the current snapshot and the warnings are asked again every minute, and
  // the page's now (so the slider's end and t) follows meta.now.
  const isLive = url.t === undefined;
  const meta = useMeta(isLive);
  const stations = useStations();
  const mode = useMode(url.mode);
  const owner = useAudience() === 'owner';
  const audienceFailed = useAudienceQuery().isError;
  const ownerSources = useOwnerSources();
  const rivers = useRivers();
  const river = useRiver(url.river);
  const [webgl] = useState(hasWebGL2);
  const [mapFailed, setMapFailed] = useState(false);
  const [view, setView] = useState<'map' | 'table'>('map');

  // `now` is the page's now: the API's clock at the load (or this browser's, if behind it), never ahead of it,
  // so the "now" of the page is a t whose snapshot holds observations; `serverNow` is the API's clock itself.
  const range = useMemo(() => {
    if (meta.data === undefined) return undefined;
    const start = Date.parse(meta.data.displayStart);
    const serverNow = Date.parse(meta.data.now);
    const now = Math.max(start, quantise(Math.min(Date.now(), serverNow)));
    return { start, now, epoch: Date.parse(meta.data.dataEpoch), serverNow, ahead: meta.data.forecastHorizons };
  }, [meta.data]);
  const list = useMemo(
    () => [...(stations.data?.stations ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [stations.data, locale],
  );
  const selected = url.s === undefined ? undefined : list.find((st) => st.id === url.s);
  // The slider reaches now + min(48 h, the selected station's horizon): without a selection (or until the
  // horizon is known) the largest horizon of /meta. A `t` beyond it is clamped to it; a `t` before the first day
  // or more than 48 h after now is treated as no `t`: now.
  const horizon = useStationHorizon(selected);
  const end = range && sliderEnd(range.now, globalEnd(range.now, range.ahead), horizon);
  const t = range && end !== undefined ? pageT(url.t, range.start, range.now, end) : undefined;
  // A `?t=` that lands on the page's now (out of range, or clamped to the end of a station without a forecast) is
  // live mode: the URL drops it, so the page refreshes as "Nu" does (review round 1).
  useEffect(() => {
    if (url.t !== undefined && range !== undefined && t === range.now) setUrl({ t: undefined });
  }, [url.t, t, range, setUrl]);

  // The data follows `t` once it has settled: a drag or a held key asks only for where it stops.
  const settled = useDebounced(t, FETCH_DEBOUNCE_MS);
  const snapshot = useSnapshot(settled, meta.data, stations.data?.seriesHash, isLive);
  // Until the values of this very `t` are in, the ones on screen are marked as not current (aria-busy, dimmed).
  // A stand-in for a dead API is the newest bucket under its own t (the banner says so): it is what there is.
  const current =
    snapshot.data !== undefined && t !== undefined && (snapshot.data.standIn || Date.parse(snapshot.data.t) === t);
  // Not after a failed request: the alert says so, and a dimmed page would stay unreadable (review round 2).
  const loading = !current && !snapshot.isError;
  const values = useMemo(() => new Map((snapshot.data?.values ?? []).map((v) => [v.series, v])), [snapshot.data]);
  // The answer for a t after now holds forecasts instead of values (P8b): what is on screen follows the answer, so
  // the marker, panel and table never mix the two.
  const forecasts = useMemo(
    () =>
      snapshot.data?.forecasts === undefined ? undefined : new Map(snapshot.data.forecasts.map((f) => [f.series, f])),
    [snapshot.data],
  );
  const changes = useChanges(
    settled,
    meta.data,
    stations.data?.seriesHash,
    stations.data?.stations,
    current ? snapshot.data : undefined,
  );
  const warnings = useWarnings(settled, meta.data, isLive).data;
  const states = useMemo(
    () => stationStates({ stations: list, values, forecasts, changes, ownerSources }),
    [list, values, forecasts, changes, ownerSources],
  );

  // Choosing the page's now (the slider's end of observations, or "Nu") is live mode again: no `t` in the URL.
  const setT = useCallback(
    (next: number) => setUrl({ t: range !== undefined && next === range.now ? undefined : next }),
    [setUrl, range],
  );
  const setMode = useCallback((next: typeof mode) => setUrl({ mode: next }), [setUrl]);
  const setRiver = useCallback((id: string | undefined) => setUrl({ river: id }), [setUrl]);
  const select = useCallback((id: string | undefined) => setUrl({ s: id }), [setUrl]);
  // Opening a station from the map or the table moves the focus into the panel; choosing one in the list does
  // not (the arrow keys of a list change its value at every press). Closing the panel returns the focus to what
  // opened it (P10a T6): the table's station button while it is still on the page, else the station list (a marker
  // has no focus of its own).
  const [focusPanel, setFocusPanel] = useState(false);
  const listRef = useRef<HTMLSelectElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback(
    (id: string | undefined) => {
      const from = document.activeElement;
      opener.current = from instanceof HTMLButtonElement ? from : null;
      setFocusPanel(true);
      select(id);
    },
    [select],
  );
  const close = useCallback(() => {
    select(undefined);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
    else listRef.current?.focus();
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
        {range === undefined ||
        end === undefined ||
        t === undefined ||
        stations.data === undefined ||
        mode === undefined ? (
          meta.isError || stations.isError || audienceFailed ? (
            <p role="alert">{m.data_unavailable({}, { locale })}</p>
          ) : (
            // While the data loads, what the static shell of index.html says (P10a: the first frame carries the
            // page's text at once, so the largest paint does not wait for the data).
            <>
              <p>{m.intro({}, { locale })}</p>
              <p>{m.not_official({}, { locale })}</p>
              <p role="status">{m.loading({}, { locale })}</p>
            </>
          )
        ) : (
          <>
            <Timebar
              locale={locale}
              t={t}
              start={range.start}
              now={range.now}
              end={end}
              noForecast={horizon === null}
              epoch={range.epoch}
              live={isLive}
              onChange={setT}
            />
            <div className={styles.controls}>
              <ModeControl locale={locale} mode={mode} onChange={setMode} />
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
            {river !== undefined && (
              <RiverChip locale={locale} id={river.id} river={river.river} onClear={() => setRiver(undefined)} />
            )}
            {snapshot.isError && <p role="alert">{m.data_unavailable({}, { locale })}</p>}
            {warnings?.incomplete === true && <p role="status">{m.warnings_incomplete({}, { locale })}</p>}
            {mode === 'delta' && forecasts !== undefined && <p role="status">{m.dh_future_note({}, { locale })}</p>}
            <DegradedBanner
              locale={locale}
              degraded={meta.data?.degraded === true || snapshot.data?.degraded === true}
              standInAt={snapshot.data?.standIn === true ? Date.parse(snapshot.data.t) : undefined}
            />
            <Legend
              locale={locale}
              mode={mode}
              forecast={forecasts !== undefined}
              owner={owner}
              warnings={(warnings?.features.length ?? 0) > 0}
            />
            <div className={loading ? `${styles.body} ${styles.busy}` : styles.body} aria-busy={loading}>
              <div className={styles.view}>
                {canMap && view === 'map' ? (
                  <StationsMap
                    locale={locale}
                    mode={mode}
                    stations={list}
                    states={states}
                    values={values}
                    forecasts={forecasts}
                    changes={changes}
                    warnings={warnings}
                    riverTiles={rivers.data?.manifest.current.tiles.file}
                    river={river?.id}
                    selected={selected}
                    onSelect={open}
                    onRiver={setRiver}
                    onClose={close}
                    onFailure={failed}
                  />
                ) : (
                  <StationTable
                    locale={locale}
                    mode={mode}
                    stations={list}
                    states={states}
                    values={values}
                    forecasts={forecasts}
                    changes={changes}
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
                  forecasts={forecasts}
                  mode={mode}
                  state={states.get(selected.id)}
                  changes={changes}
                  warnings={warnings}
                  ownerSources={ownerSources}
                  live={isLive}
                  serverNow={range.serverNow}
                  t={t}
                  dataEpoch={range.epoch}
                  chartSpan={chartSpan(settled ?? t, range.start, range.serverNow)}
                  focus={focusPanel}
                  onClose={close}
                />
              )}
            </div>
          </>
        )}
      </main>
      <Footer
        locale={locale}
        meta={meta.data}
        t={t === undefined || range === undefined ? t : Math.min(t, range.now)}
      />
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
  // The owner site serves no /downloads (owner.caddy): the river download is offered on the public site only.
  const owner = useAudience() === 'owner';
  const manifest = useRiversManifest().data;
  const download = owner ? undefined : downloadHref(manifest);
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
