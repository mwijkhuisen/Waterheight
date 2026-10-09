import type { ApiStation, Snapshot } from '@rws/contracts';
import type { MapLayerMouseEvent, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReachGraph } from '../../lib/data/api.ts';
import type { Change } from '../../lib/data/change.ts';
import type { WebForecast as SnapshotForecast } from '../../lib/data/static.ts';
import type { WarningsAt } from '../../lib/data/warnings.ts';
import type { StationState } from '../../lib/stationStates.ts';
import { testHook } from '../../lib/testHook.ts';
import type { Mode } from '../../lib/url/url.ts';
import { RIVER_ID } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { FlowHandle } from '../flow/flowLayer.ts';
import type { ReachHandle } from '../flow/reaches/reachLayer.ts';
import { forecastLine } from '../station/forecast.ts';
import styles from './map.module.css';
import { badgeLine, changeLine, modeLines } from './popup.ts';
import { highlightRiver, RIVERS, RIVERS_HIGHLIGHT, showRivers } from './rivers.ts';
import { SOURCE, setStationMode, showStations } from './stationLayer.ts';
import { useMapLibre } from './useMapLibre.ts';
import { showWarnings, WARNINGS_FILL } from './warnings.ts';

// The map view (A§10 features/map): the self-hosted basemap with the stations
// as a feature-state circle layer. A click selects; the selected station's name
// is shown in a popup as a text node (invariant 3: never setHTML).

const OPTIONS = { center: [7.2, 50.6] as [number, number], zoom: 5.3 };

interface Props {
  locale: Locale;
  /** P10a: the map mode; the marker paint follows it (state, delta, q). */
  mode: Mode;
  stations: readonly ApiStation[];
  /** The feature-state record of every station at t (lib/stationStates.ts). */
  states: ReadonlyMap<string, StationState>;
  /** The 24-hour change by series (undefined after now or while it loads). */
  changes: ReadonlyMap<number, Change> | undefined;
  /** The warning areas valid at t (undefined while they load or after now). */
  warnings: WarningsAt | undefined;
  /** The installed river tile file (`rivers-<ver>.pmtiles`), undefined without a release: no river layer. */
  riverTiles: string | undefined;
  /** The highlighted river id (`?river=`). */
  river: string | undefined;
  /** P11a: the flow animation's pause control; the flow layers come with the river layer (a lazy chunk). */
  flow: boolean;
  /** A click on a river sets `?river=` (plan C17). */
  onRiver: (id: string | undefined) => void;
  values: ReadonlyMap<number, Snapshot['values'][number]>;
  /** After now (P8b): the forecasts at t by series; undefined for a t up to now. */
  forecasts: ReadonlyMap<number, SnapshotForecast> | undefined;
  selected: ApiStation | undefined;
  onSelect: (id: string | undefined) => void;
  /** The popup's own close button: deselect, and put the focus somewhere that stays. */
  onClose: () => void;
  /** The map could not start (no WebGL2 context, no basemap, …): the page shows the table. */
  onFailure: (code: string) => void;
  /** P11b: every station of the site (hidden ones too: they still end a span of the reach colouring). */
  allStations: readonly ApiStation[];
  /** P11b: the values are played-back hourly frames (the popup says so). */
  played: boolean;
}

export function StationsMap({
  locale,
  mode,
  stations,
  states,
  changes,
  warnings,
  riverTiles,
  river,
  flow,
  onRiver,
  values,
  forecasts,
  selected,
  onSelect,
  onClose,
  onFailure,
  allStations,
  played,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useMapLibre(ref, locale, OPTIONS);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const close = useRef(onClose);
  close.current = onClose;
  const centred = useRef(false);
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const riverNow = useRef(onRiver);
  riverNow.current = onRiver;
  const flowNow = useRef(flow);
  flowNow.current = flow;
  const flowLayer = useRef<FlowHandle | null>(null);
  const reachLayer = useRef<ReachHandle | null>(null);
  const [reachesOn, setReachesOn] = useState(false);
  const graph = useReachGraph().data;

  useEffect(() => {
    if (state.status === 'error') onFailure(state.code);
  }, [state, onFailure]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const ready = state.map;
    const click = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.id;
      if (id !== undefined) select.current(String(id));
    };
    // A click on a river line (a few pixels of slack: the line is thin) selects the river, unless a station is there.
    const riverClick = (e: MapMouseEvent) => {
      const { x, y } = e.point;
      const box: [[number, number], [number, number]] = [
        [x - 5, y - 5],
        [x + 5, y + 5],
      ];
      if (ready.getLayer(RIVERS) === undefined || ready.queryRenderedFeatures(box, { layers: [SOURCE] }).length > 0)
        return;
      const id = ready.queryRenderedFeatures(box, { layers: [RIVERS] })[0]?.properties?.river_id;
      if (typeof id === 'string' && RIVER_ID.test(id)) riverNow.current(id);
    };
    const pointer = () => {
      ready.getCanvas().style.cursor = 'pointer';
    };
    const plain = () => {
      ready.getCanvas().style.cursor = '';
    };
    const add = () => {
      showStations(ready, stations, modeNow.current, m.legend_impounded({}, { locale }));
      ready.on('click', riverClick);
      ready.on('click', SOURCE, click);
      ready.on('mouseenter', SOURCE, pointer);
      ready.on('mouseleave', SOURCE, plain);
      if (testHook) testHook.map = ready;
      setMap(ready);
    };
    if (ready.isStyleLoaded()) add();
    else ready.once('load', add);
    return () => {
      ready.off('load', add);
      ready.off('click', SOURCE, click);
      ready.off('click', riverClick);
      ready.off('mouseenter', SOURCE, pointer);
      ready.off('mouseleave', SOURCE, plain);
      if (testHook) testHook.map = null;
      setMap(null);
    };
  }, [state, stations, locale]);

  useEffect(() => {
    if (map === null) return;
    // Feature state merges: every key of the record is always written, so nothing of an earlier t stays. Only the
    // stations in the source: a hidden one (KG-233) has no feature to write to.
    for (const st of stations) {
      const s = states.get(st.id);
      if (s !== undefined)
        map.setFeatureState({ source: SOURCE, id: st.id }, { ...s, selected: st.id === selected?.id });
    }
  }, [map, stations, states, selected]);

  // The paint follows the mode; the warnings and rivers are layers of their own (data changes rarely: setData).
  useEffect(() => {
    if (map !== null) setStationMode(map, mode);
  }, [map, mode]);
  useEffect(() => {
    if (map !== null) showWarnings(map, warnings, SOURCE);
  }, [map, warnings]);
  useEffect(() => {
    if (map === null) return;
    showRivers(map, location.origin, riverTiles, WARNINGS_FILL);
    highlightRiver(map, river);
  }, [map, riverTiles, river]);
  // The flow direction over the river lines (P11a) and the reach colouring under it (P11b): their own chunks, loaded
  // once the river layer exists. The reach layers go under the highlight, the flow dashes over it.
  useEffect(() => {
    if (map === null || riverTiles === undefined) return;
    let gone = false;
    // Two chunks loaded apart, so one that fails never keeps the other off the map (each anchors its own layers).
    void import('../flow/reaches/reachLayer.ts').then(({ addReaches }) => {
      if (gone || map.getLayer(RIVERS) === undefined) return;
      reachLayer.current = addReaches(map, RIVERS_HIGHLIGHT);
      setReachesOn(true);
    });
    void import('../flow/flowLayer.ts').then(({ addFlow }) => {
      if (gone || map.getLayer(RIVERS) === undefined) return;
      flowLayer.current = addFlow(map, WARNINGS_FILL, flowNow.current);
    });
    return () => {
      gone = true;
      reachLayer.current?.dispose();
      reachLayer.current = null;
      flowLayer.current?.dispose();
      flowLayer.current = null;
      setReachesOn(false);
    };
  }, [map, riverTiles]);
  useEffect(() => {
    if (reachesOn && graph !== undefined)
      reachLayer.current?.update({ graph, mode, stations: allStations, values, changes });
  }, [reachesOn, graph, mode, allStations, values, changes]);
  useEffect(() => {
    flowLayer.current?.setEnabled(flow);
  }, [flow]);

  // A deep link with a station opens the map on it, in the part the station drawer leaves free (P10e: from 48rem the
  // drawer is 26rem wide over the right of the map; below that the sheet covers all of it).
  useEffect(() => {
    if (map === null || centred.current) return;
    centred.current = true;
    if (selected?.lon == null || selected.lat == null) return;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const right = matchMedia('(min-width: 48rem)').matches ? 26 * rem : 0;
    // Centred, then moved by half the drawer: the station lands in the middle of the free part. Not by the camera's
    // padding, which would outlive the drawer and shift every later zoom (review round 1).
    map.jumpTo({ center: [selected.lon, selected.lat], zoom: 9 });
    if (right > 0) map.panBy([right / 2, 0], { animate: false });
  }, [map, selected]);

  // The popup's lines: per series the text of the map mode (state and basis, the 24-hour change, the discharge), after
  // now (P8b) its forecast with the agency and the issue time (in the delta mode "not applicable": forecasts and
  // observations never mix), then one line of badges in words (a ring or a hollow marker is never the only cue).
  const lines = useMemo(() => {
    if (selected === undefined) return [];
    const quantityWord = (s: ApiStation['series'][number]) =>
      s.quantity === 'H' ? m.quantity_H({}, { locale }) : m.quantity_Q({}, { locale });
    const body =
      forecasts === undefined
        ? modeLines({ mode, series: selected.series, values, changes, locale, quantityWord })
        : selected.series.map((s) =>
            mode === 'delta'
              ? changeLine(quantityWord(s), s, null, locale)
              : forecastLine(quantityWord(s), forecasts.get(s.id), s, locale),
          );
    const badges = badgeLine(
      {
        state: states.get(selected.id),
        tidal: selected.flags.tidal === true,
        impounded: selected.flags.impounded === true,
      },
      locale,
    );
    const words = played ? [badges, m.played_note({}, { locale })].filter((w) => w !== '').join(' · ') : badges;
    return words === '' ? body : [...body, words];
  }, [selected, values, forecasts, changes, states, mode, locale, played]);
  const linesNow = useRef(lines);
  linesNow.current = lines;
  /** The popup's content element while a popup is open: its lines are replaced in place when `t` moves. */
  const host = useRef<HTMLElement | null>(null);

  // A station hidden from the map (KG-233) still opens its panel by link, but gets no popup over an empty spot.
  const drawn = selected !== undefined && stations.includes(selected);
  useEffect(() => {
    if (map === null || selected === undefined || !drawn || selected.lon === null || selected.lat === null) return;
    const at: [number, number] = [selected.lon, selected.lat];
    const name = selected.name;
    let removed = false;
    let remove: (() => void) | undefined;
    void import('./createMap.ts').then(({ Popup }) => {
      if (removed) return;
      const text = document.createElement('span');
      text.textContent = name; // provider text: a text node, never HTML
      const popup = new Popup({ closeOnClick: false, focusAfterOpen: false, offset: 12 })
        .setLngLat(at)
        .setDOMContent(text)
        .addTo(map);
      host.current = text.parentElement;
      showLines(host.current, linesNow.current);
      // Only the popup's own close button deselects: MapLibre also fires 'close' when the map itself is removed
      // (switching to the table), and that must keep the selection.
      popup
        .getElement()
        ?.querySelector('.maplibregl-popup-close-button')
        ?.addEventListener('click', () => close.current());
      remove = () => popup.remove();
    });
    return () => {
      removed = true;
      host.current = null;
      remove?.();
    };
  }, [map, selected, drawn]);

  // A new snapshot changes the lines only: the popup and its close button (and the keyboard focus on it) stay.
  useEffect(() => {
    if (host.current !== null) showLines(host.current, lines);
  }, [lines]);

  return (
    <>
      {state.status === 'loading' && <p className={styles.status}>{m.map_loading({}, { locale })}</p>}
      <div ref={ref} className={styles.map} />
    </>
  );
}

/** Replaces the popup's `p` lines, each a text node (the basis label is provider text too). */
function showLines(host: HTMLElement | null, lines: readonly string[]): void {
  if (host === null) return;
  for (const old of host.querySelectorAll(':scope > p')) old.remove();
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    host.append(p);
  }
}
