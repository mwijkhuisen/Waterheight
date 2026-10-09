import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './App.module.css';
import { Attribution } from './features/attribution/Attribution.tsx';
import { DegradedBanner } from './features/banner/DegradedBanner.tsx';
import { FlowToggle } from './features/flow/FlowToggle.tsx';
import { Layout } from './features/layout/Layout.tsx';
import { Legend } from './features/legend/Legend.tsx';
import { MapControls } from './features/legend/MapControls.tsx';
import { RiverChip } from './features/legend/RiverChip.tsx';
import { StationsMap } from './features/map/StationsMap.tsx';
import { hasWebGL2 } from './features/map/webgl.ts';
import { Page } from './features/pages/Page.tsx';
import { StationSearch } from './features/search/StationSearch.tsx';
import { StationPanel } from './features/station/StationPanel.tsx';
import { StationTable } from './features/table/StationTable.tsx';
import { Timebar } from './features/timebar/Timebar.tsx';
import {
  useAudience,
  useAudienceQuery,
  useChanges,
  useDebounced,
  useMeta,
  useMode,
  useOwnerSources,
  useRiver,
  useRivers,
  useSnapshot,
  useStationHorizon,
  useStations,
  useWarnings,
} from './lib/data/api.ts';
import { globalEnd, pageT, sliderEnd } from './lib/forecast.ts';
import { pathOf, routeOf } from './lib/routes.ts';
import { hiddenKey, lapses, stationStates, visibleStations } from './lib/stationStates.ts';
import { quantise } from './lib/time/time.ts';
import { useUrlState } from './lib/url/useUrlState.ts';
import { m } from './paraglide/messages.js';
import type { Locale } from './paraglide/runtime.js';

// One shell per language (NL at /, EN at /en/; P10b: the pages of lib/routes.ts, and the 404 shells for any other
// path). The map is the table or map of the stations at the instant `?t=`, the station `?s=` in a panel. After now
// (P8b) the timeline reaches into the forecast, as far as the selected station's forecast does (at most 48 h).
// The language link is a full page load that keeps t and s, so <html lang> always matches the page (A§10).

const FETCH_DEBOUNCE_MS = 150;

export function App({ locale }: { locale: Locale }) {
  const route = routeOf(location.pathname);
  if (route?.id === 'home') return <Viewer locale={locale} />;
  return (
    <Layout locale={locale} route={route}>
      {route === null ? <NotFound locale={locale} /> : <Page id={route.id} locale={locale} />}
    </Layout>
  );
}

/** Any path that is no page (Caddy answers it with a 404 and the 404 shell). The path itself is never shown. */
function NotFound({ locale }: { locale: Locale }) {
  return (
    <>
      <h1>{m.not_found_heading({}, { locale })}</h1>
      <p>
        <a href={pathOf('home', locale)}>{m.not_found_link({}, { locale })}</a>
      </p>
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
  // P11a: the flow animation's pause control (WCAG 2.2.2); the page's own state, no URL key (A§10).
  const [flow, setFlow] = useState(true);

  // `now` is the page's now: the API's clock at the load (or this browser's, if behind it), never ahead of it,
  // so the "now" of the page is a t whose snapshot holds observations; `serverNow` is the API's clock itself.
  const range = useMemo(() => {
    if (meta.data === undefined) return undefined;
    const start = Date.parse(meta.data.displayStart);
    const serverNow = Date.parse(meta.data.now);
    const now = Math.max(start, quantise(Math.min(Date.now(), serverNow)));
    return { start, now, epoch: Date.parse(meta.data.dataEpoch), serverNow, ahead: meta.data.forecastHorizons };
  }, [meta.data]);
  const sorted = useMemo(
    () => [...(stations.data?.stations ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [stations.data, locale],
  );
  const selected = url.s === undefined ? undefined : sorted.find((st) => st.id === url.s);
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
  // KG-233: latest.json's age of the newest value of a series with none at t; a station with nothing newer than
  // 25 hours is hidden (map, table, search), and the selected one stays open by its link.
  // Live, the previous bucket's latest.json stays on screen while the next one loads (keepPreviousData): its ages go
  // with its values, so hidden stations do not flash back. Off live only the snapshot of this very t has ages.
  const lastAges = current || isLive ? snapshot.data?.lastAge : undefined;
  const lapsed = useMemo(() => lapses(sorted, values, lastAges), [sorted, values, lastAges]);
  const states = useMemo(
    () => stationStates({ stations: sorted, values, forecasts, changes, ownerSources, lapsed }),
    [sorted, values, forecasts, changes, ownerSources, lapsed],
  );
  // A new array only when the hidden set changes: the map rebuilds its source (and popup) on a new list.
  const hidden = hiddenKey(states);
  const list = useMemo(() => visibleStations(sorted, hidden), [sorted, hidden]);

  // Choosing the page's now (the slider's end of observations, or "Nu") is live mode again: no `t` in the URL.
  const setT = useCallback(
    (next: number) => setUrl({ t: range !== undefined && next === range.now ? undefined : next }),
    [setUrl, range],
  );
  const setMode = useCallback((next: typeof mode) => setUrl({ mode: next }), [setUrl]);
  const setRiver = useCallback((id: string | undefined) => setUrl({ river: id }), [setUrl]);
  const select = useCallback((id: string | undefined) => setUrl({ s: id }), [setUrl]);
  // Opening a station from the map, the table, the search or the nearby list moves the focus into the panel
  // (P10e D6). Closing the panel returns the focus to what opened it (P10a T6): the table's station button while it
  // is still on the page, else the search magnifier in the bar (a marker has no focus of its own).
  const [focusPanel, setFocusPanel] = useState(false);
  const searchRef = useRef<HTMLButtonElement>(null);
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
  // The focus moves once the panel is gone: below 48rem the view under the sheet is hidden until then, and a hidden
  // button takes no focus (review round 1).
  const closing = useRef(false);
  const close = useCallback(() => {
    closing.current = true;
    select(undefined);
  }, [select]);
  useEffect(() => {
    if (selected !== undefined || !closing.current) return;
    closing.current = false;
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
    else searchRef.current?.focus();
  }, [selected]);
  const failed = useCallback(() => setMapFailed(true), []);

  const canMap = webgl && !mapFailed;
  const riverTiles = rivers.data?.manifest.current.tiles.file;
  const onMap = canMap && view === 'map';
  const notice = !webgl ? m.map_no_webgl({}, { locale }) : mapFailed ? m.map_unavailable({}, { locale }) : undefined;

  const legend =
    mode === undefined ? null : (
      <Legend
        key="legend"
        locale={locale}
        mode={mode}
        forecast={forecasts !== undefined}
        owner={owner}
        warnings={(warnings?.features.length ?? 0) > 0}
      />
    );

  return (
    <Layout
      locale={locale}
      route={{ id: 'home', locale }}
      search={
        stations.data === undefined ? undefined : (
          <StationSearch locale={locale} stations={list} onPick={open} buttonRef={searchRef} />
        )
      }
    >
      {range === undefined ||
      end === undefined ||
      t === undefined ||
      stations.data === undefined ||
      mode === undefined ? (
        <div className={styles.plain}>
          {meta.isError || stations.isError || audienceFailed ? (
            <p role="alert">{m.data_unavailable({}, { locale })}</p>
          ) : (
            // While the data loads, what the static shell of index.html says (P10a: the first frame carries the
            // page's text at once, so the largest paint does not wait for the data).
            <>
              <p>{m.intro({}, { locale })}</p>
              <p>{m.not_official({}, { locale })}</p>
              <p role="status">{m.loading({}, { locale })}</p>
            </>
          )}
        </div>
      ) : (
        // P10e: the view is the stage, as tall as the window under the bar. On the map the mode and view disclosures
        // and the status lines float over its top, the legend and the credits over its bottom right, the timebar over
        // its bottom centre and the station panel is a drawer on its right; in the table view the top is a band above
        // the table, which then scrolls inside the stage.
        <div
          className={`${styles.stage} ${onMap ? styles.onMap : styles.onTable} ${selected !== undefined ? styles.withPanel : ''}`}
        >
          <div className={styles.top}>
            <div className={styles.controls}>
              <MapControls locale={locale} mode={mode} onMode={setMode} view={view} onView={setView} canMap={canMap} />
              {onMap && riverTiles !== undefined && <FlowToggle locale={locale} on={flow} onChange={setFlow} />}
            </div>
            <div className={styles.status}>
              {notice !== undefined && (
                <p role="status">
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
            </div>
          </div>
          <div className={loading ? `${styles.body} ${styles.busy}` : styles.body} aria-busy={loading}>
            <div className={styles.view}>
              {onMap ? (
                <StationsMap
                  locale={locale}
                  mode={mode}
                  stations={list}
                  states={states}
                  values={values}
                  forecasts={forecasts}
                  changes={changes}
                  warnings={warnings}
                  riverTiles={riverTiles}
                  flow={flow}
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
                  lapsed={lapsed}
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
                states={states}
                forecasts={forecasts}
                changes={changes}
                lapsed={lapsed}
                warnings={warnings}
                ownerSources={ownerSources}
                live={isLive}
                serverNow={range.serverNow}
                t={t}
                dataEpoch={range.epoch}
                displayStart={range.start}
                chartAt={settled ?? t}
                stations={list}
                focus={focusPanel}
                onClose={close}
                onSelect={open}
              />
            )}
          </div>
          <div className={styles.corner}>
            {legend}
            <Attribution locale={locale} meta={meta.data} t={Math.min(t, range.now)} />
          </div>
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
        </div>
      )}
    </Layout>
  );
}
