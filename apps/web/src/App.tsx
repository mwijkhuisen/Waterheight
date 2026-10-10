import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './App.module.css';
import { Attribution } from './features/attribution/Attribution.tsx';
import { DegradedBanner } from './features/banner/DegradedBanner.tsx';
import { FlowToggle } from './features/flow/FlowToggle.tsx';
import { playRange, type Speed } from './features/flow/playback/engine.ts';
import { usePlayback } from './features/flow/playback/usePlayback.ts';
import type { HourValues, Shift } from './features/flow/reaches/colour.ts';
import { maxShift, spanShift } from './features/flow/reaches/shift.ts';
import { spansOf } from './features/flow/reaches/spans.ts';
import toggleStyles from './features/flow/toggle.module.css';
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
  useFrames,
  useMeta,
  useMode,
  useOwnerSources,
  useReachGraph,
  useReachTravel,
  useRiver,
  useRivers,
  useSnapshot,
  useStationHorizon,
  useStations,
  useWarnings,
} from './lib/data/api.ts';
import { changesAt } from './lib/data/change.ts';
import type { FrameStore } from './lib/data/frames.ts';
import { globalEnd, pageT, sliderEnd } from './lib/forecast.ts';
import { pathOf, routeOf } from './lib/routes.ts';
import { hiddenKey, lapses, stationStates, visibleStations } from './lib/stationStates.ts';
import { ceilHour, DAY_MS, floorHour, HOUR_MS, quantise } from './lib/time/time.ts';
import { searchOf } from './lib/url/url.ts';
import { useUrlState } from './lib/url/useUrlState.ts';
import { m } from './paraglide/messages.js';
import type { Locale } from './paraglide/runtime.js';

// One shell per language (NL at /, EN at /en/; P10b: the pages of lib/routes.ts, and the 404 shells for any other
// path). The map is the table or map of the stations at the instant `?t=`, the station `?s=` in a panel. After now
// (P8b) the timeline reaches into the forecast, as far as the selected station's forecast does (at most 48 h).
// The language link is a full page load that keeps t and s, so <html lang> always matches the page (A§10).

const FETCH_DEBOUNCE_MS = 150;

type HovmollerPanel = typeof import('./features/flow/hovmoller/HovmollerPanel.tsx').HovmollerPanel;

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
  // P11a: the flow animation's pause control (WCAG 2.2.2); the page's own state, no URL key (A§10). The e2e build
  // starts with it off unless a spec sets window.__rwsFlow first: an animating map keeps a software renderer busy
  // and never idle. A build-time constant, so the production bundle holds no trace of it.
  const [flow, setFlow] = useState(() => import.meta.env.MODE !== 'e2e' || window.__rwsFlow === true);

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
  // P11b: a deep link with `play` restores the whole hour of its `t` when that hour is inside the playback range.
  const playable = range === undefined ? undefined : playRange(range.start, range.now);
  const hour = url.play !== undefined && url.t !== undefined ? floorHour(url.t) : undefined;
  const urlT =
    hour !== undefined && playable !== undefined && hour >= playable.start && hour <= playable.end ? hour : url.t;
  const t = range && end !== undefined ? pageT(urlT, range.start, range.now, end) : undefined;
  // A `?t=` that lands on the page's now (out of range, or clamped to the end of a station without a forecast) is
  // live mode: the URL drops it, so the page refreshes as "Nu" does (review round 1).
  useEffect(() => {
    if (url.t !== undefined && range !== undefined && t === range.now) setUrl({ t: undefined });
  }, [url.t, t, range, setUrl]);

  // Choosing the page's now (the slider's end of observations, or "Nu") is live mode again: no `t` in the URL. Live
  // and a t after now drop the playback speed (P11b).
  const setT = useCallback(
    (next: number) =>
      setUrl(
        range !== undefined && next === range.now
          ? { t: undefined, play: undefined }
          : range !== undefined && next > range.now
            ? { t: next, play: undefined }
            : { t: next },
      ),
    [setUrl, range],
  );
  const setPlay = useCallback((speed: Speed) => setUrl({ play: speed }), [setUrl]);

  // P11b: hourly frames playback (every mode since #112: each hour carries its state). While it plays, the values come from the frames (bucket
  // t − 1 h, R12) and no snapshot, change or warnings file is asked; paused, the snapshot path returns.
  const framesNow = useRef<FrameStore | undefined>(undefined);
  // The e2e build holds play on its first hour when a spec sets window.__rwsPlayHold first (the visual scenes): a
  // build-time constant, so the production bundle holds no trace of it.
  const ready = useCallback(
    (h: number) =>
      !(import.meta.env.MODE === 'e2e' && window.__rwsPlayHold === true) && (framesNow.current?.ready(h) ?? false),
    [],
  );
  // #112 item 3: the spans a sourced travel time names exactly are shifted; the frames then reach `shiftMax` hours
  // further back (0: none shifted, nothing more is asked).
  const graph = useReachGraph().data;
  const travel = useReachTravel().data;
  const { shiftMax, shiftSeries } = useMemo(() => {
    if (graph === undefined || stations.data === undefined) return { shiftMax: 0, shiftSeries: new Set<number>() };
    const spans = spansOf(graph, new Set(stations.data.stations.map((s) => s.id)));
    // The series of the shifted spans' up ends: the only ones read at an earlier hour.
    const ups = new Set<string>();
    for (const fs of spans.values())
      for (const span of [fs.span, ...fs.bins])
        if (span !== null && spanShift(span, travel) !== null) for (const id of span.up) ups.add(id);
    const series = new Set(
      stations.data.stations.filter((st) => ups.has(st.id)).flatMap((st) => st.series.map((x) => x.id)),
    );
    return { shiftMax: maxShift(spans, travel), shiftSeries: series };
  }, [graph, stations.data, travel]);
  const playback = usePlayback({
    t: url.t === undefined ? undefined : t,
    displayStart: range?.start ?? 0,
    now: range?.now ?? 0,
    speed: url.play,
    ready,
    onT: setT,
    onSpeed: setPlay,
    extraLeadHours: shiftMax,
  });
  const playing = playback.playing;
  const frames = useFrames(playback.window, meta.data, stations.data?.stations);
  framesNow.current = frames;
  // Until the frames of the first hour are in, the paused snapshot stays on screen (no blank map at the start).
  const played = playing && frames !== undefined && t !== undefined && frames.ready(t);

  // The data follows `t` once it has settled: a drag or a held key asks only for where it stops.
  const settled = useDebounced(t, FETCH_DEBOUNCE_MS);
  const asked = playing ? undefined : settled;
  const snapshot = useSnapshot(asked, meta.data, stations.data?.seriesHash, isLive);
  // Until the values of this very `t` are in, the ones on screen are marked as not current (aria-busy, dimmed).
  // A stand-in for a dead API is the newest bucket under its own t (the banner says so): it is what there is.
  const current =
    snapshot.data !== undefined && t !== undefined && (snapshot.data.standIn || Date.parse(snapshot.data.t) === t);
  // Not after a failed request: the alert says so, and a dimmed page would stay unreadable (review round 2).
  const loading = !playing && !current && !snapshot.isError;
  const snapValues = useMemo(() => new Map((snapshot.data?.values ?? []).map((v) => [v.series, v])), [snapshot.data]);
  const playedValues = useMemo(
    () => (played && frames !== undefined && t !== undefined ? frames.valuesAt(t) : undefined),
    [played, frames, t],
  );
  const values = playedValues ?? snapValues;
  // The answer for a t after now holds forecasts instead of values (P8b): what is on screen follows the answer, so
  // the marker, panel and table never mix the two.
  const forecasts = useMemo(
    () =>
      playing || snapshot.data?.forecasts === undefined
        ? undefined
        : new Map(snapshot.data.forecasts.map((f) => [f.series, f])),
    [playing, snapshot.data],
  );
  const snapChanges = useChanges(
    asked,
    meta.data,
    stations.data?.seriesHash,
    stations.data?.stations,
    current ? snapshot.data : undefined,
  );
  // While playing, Δh is value(t) − value(t − 24 h) of the frames (the window starts 24 h before the first hour).
  const quantity = useMemo(
    () => new Map(sorted.flatMap((st) => st.series.map((s) => [s.id, s.quantity] as const))),
    [sorted],
  );
  const playedChanges = useMemo(
    () =>
      playedValues === undefined || frames === undefined || t === undefined
        ? undefined
        : changesAt(quantity, [...playedValues.values()], [...frames.valuesAt(t - DAY_MS).values()]),
    [playedValues, frames, t, quantity],
  );
  const changes = playedValues === undefined ? snapChanges : playedChanges;
  // #112 item 3: the hours before t that a shifted span's up end is read at: from the playback frames while they play,
  // else from a frames read of [t − shiftMax − 25 h, t) around the settled t. Paused, the down end is the snapshot's
  // value at t and the up end the frames' value of its hour. Nothing is read when no span is shifted, when no reach is
  // coloured (the table, no WebGL2, no river tiles) or for a t after now (forecasts: no observed value to shift). The
  // window is whole UTC days (framesPlan reads whole day files anyway), so a scrubbed t rebuilds no frame store until
  // its day changes; its end stays at or before now (the owner's API refuses a later one).
  const reachesShown = webgl && !mapFailed && view === 'map' && rivers.data?.manifest.current.tiles.file !== undefined;
  const shiftDay = asked === undefined ? undefined : Math.floor(asked / DAY_MS) * DAY_MS;
  const shiftWindow = useMemo(
    () =>
      asked === undefined ||
      shiftDay === undefined ||
      shiftMax === 0 ||
      range === undefined ||
      !reachesShown ||
      asked > range.now
        ? undefined
        : {
            from: Math.max(ceilHour(range.start), Math.floor((shiftDay - (shiftMax + 25) * HOUR_MS) / DAY_MS) * DAY_MS),
            to: Math.min(shiftDay + DAY_MS, floorHour(range.now)),
          },
    [asked, shiftDay, shiftMax, range, reachesShown],
  );
  const shiftFrames = useFrames(
    shiftWindow !== undefined && shiftWindow.from < shiftWindow.to ? shiftWindow : undefined,
    meta.data,
    stations.data?.stations,
  );
  const pastStore = playing ? frames : shiftFrames;
  // The t the values on screen are of: the played hour, or the settled t of the snapshot (a scrub between two settled
  // t keeps both ends at the same instant). While the earlier hours load, a shifted end has none: "no data".
  const shiftT = playing ? t : asked;
  const shift = useMemo((): Shift | undefined => {
    if (shiftMax === 0 || shiftT === undefined) return undefined;
    if (pastStore === undefined) return { travel, past: () => undefined };
    const store = pastStore;
    const hours = new Map<number, HourValues | undefined>();
    const past = (k: number): HourValues | undefined => {
      if (hours.has(k)) return hours.get(k);
      const at = shiftT - k * HOUR_MS;
      let out: HourValues | undefined;
      if (store.ready(at)) {
        const values = store.valuesAt(at, shiftSeries);
        const before = store.valuesAt(at - DAY_MS, shiftSeries);
        out = { values, changes: changesAt(quantity, [...values.values()], [...before.values()]) };
      }
      hours.set(k, out);
      return out;
    };
    return { travel, past };
  }, [shiftMax, shiftSeries, shiftT, pastStore, travel, quantity]);
  const warnings = useWarnings(asked, meta.data, isLive).data;
  // KG-233: latest.json's age of the newest value of a series with none at t; a station with nothing newer than
  // 25 hours is hidden (map, table, search), and the selected one stays open by its link.
  // Live, the previous bucket's latest.json stays on screen while the next one loads (keepPreviousData): its ages go
  // with its values, so hidden stations do not flash back. Off live only the snapshot of this very t has ages.
  const lastAges = !playing && (current || isLive) ? snapshot.data?.lastAge : undefined;
  const lapsed = useMemo(() => lapses(sorted, values, lastAges), [sorted, values, lastAges]);
  const states = useMemo(
    () => stationStates({ stations: sorted, values, forecasts, changes, ownerSources, lapsed }),
    [sorted, values, forecasts, changes, ownerSources, lapsed],
  );
  // A new array only when the hidden set changes: the map rebuilds its source (and popup) on a new list.
  const hidden = hiddenKey(states);
  const list = useMemo(() => visibleStations(sorted, hidden), [sorted, hidden]);

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
  // P11c: the Hovmöller panel opens on the Meuse when the river chip says so, else on Rhine–Waal; closing it returns
  // the focus to its toggle.
  const hovToggle = useRef<HTMLButtonElement>(null);
  const toggleHov = useCallback(
    () => setUrl({ hov: url.hov === undefined ? (url.river === 'meuse' ? 'meuse' : 'rhine-waal') : undefined }),
    [setUrl, url.hov, url.river],
  );
  const closeHov = useCallback(() => {
    setUrl({ hov: undefined });
    hovToggle.current?.focus();
  }, [setUrl]);
  // The panel is a lazy chunk (ECharts and the grid stay out of the entry chunk), asked for only once `?hov=` is set.
  // A chunk that fails (offline, a tab older than the deploy) is an alert in the panel's place, never a blank page
  // (review round 1): no React.lazy, which throws into a viewer without an error boundary.
  const hovOpen = url.hov !== undefined;
  const [hov, setHov] = useState<{ Panel: HovmollerPanel } | 'failed' | undefined>();
  useEffect(() => {
    if (!hovOpen || hov !== undefined) return;
    let gone = false;
    import('./features/flow/hovmoller/HovmollerPanel.tsx')
      .then((x) => !gone && setHov({ Panel: x.HovmollerPanel }))
      .catch(() => !gone && setHov('failed'));
    return () => {
      gone = true;
    };
  }, [hovOpen, hov]);

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
        reaches={onMap && riverTiles !== undefined}
        shifted={shiftMax > 0}
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
          className={`${styles.stage} ${onMap ? styles.onMap : styles.onTable} ${selected !== undefined ? styles.withPanel : ''}${url.hov !== undefined ? ` ${styles.hovOpen}` : ''}`}
        >
          <div className={styles.top}>
            <div className={styles.controls}>
              <MapControls locale={locale} mode={mode} onMode={setMode} view={view} onView={setView} canMap={canMap} />
              {onMap && riverTiles !== undefined && <FlowToggle locale={locale} on={flow} onChange={setFlow} />}
              <button
                type="button"
                ref={hovToggle}
                className={toggleStyles.toggle}
                aria-pressed={url.hov !== undefined}
                onClick={toggleHov}
              >
                {m.hov_toggle({}, { locale })}
              </button>
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
                  allStations={sorted}
                  played={played}
                  shift={shift}
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
                  played={played}
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
                played={played}
              />
            )}
          </div>
          {url.hov !== undefined &&
            (hov === undefined || hov === 'failed' ? (
              // Its box is kept while the chunk loads, so the view above and the corner do not jump.
              <div className={styles.hovPending}>
                {hov === 'failed' && (
                  <p role="alert">
                    {m.data_unavailable({}, { locale })}{' '}
                    <a href={`${pathOf('home', locale)}${searchOf(url)}`}>{m.page_reload({}, { locale })}</a>
                  </p>
                )}
              </div>
            ) : (
              <hov.Panel
                locale={locale}
                meta={meta.data}
                stations={sorted}
                ownerSources={ownerSources}
                playback={playback}
                t={t}
                setT={setT}
                selected={url.s}
                open={open}
                path={url.hov}
                onPath={(next) => setUrl({ hov: next })}
                onClose={closeHov}
              />
            ))}
          <div className={styles.corner}>
            {legend}
            <Attribution
              locale={locale}
              meta={meta.data}
              t={Math.min(t, range.now)}
              played={played ? frames?.attribution() : undefined}
            />
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
            playback={playback}
          />
        </div>
      )}
    </Layout>
  );
}
