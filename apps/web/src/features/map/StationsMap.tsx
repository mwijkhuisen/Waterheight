import type { ApiStation, Snapshot, SnapshotForecast } from '@rws/contracts';
import type { MapLayerMouseEvent, Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { testHook } from '../../lib/testHook.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { forecastLine } from '../station/forecast.ts';
import { popupLine } from '../station/state.ts';
import styles from './map.module.css';
import { type MarkerState, SOURCE, showStations } from './stationLayer.ts';
import { useMapLibre } from './useMapLibre.ts';

// The map view (A§10 features/map): the self-hosted basemap with the stations
// as a feature-state circle layer. A click selects; the selected station's name
// is shown in a popup as a text node (invariant 3: never setHTML).

const OPTIONS = { center: [7.2, 50.6] as [number, number], zoom: 5.3 };

interface Props {
  locale: Locale;
  stations: readonly ApiStation[];
  states: ReadonlyMap<string, MarkerState>;
  values: ReadonlyMap<number, Snapshot['values'][number]>;
  /** After now (P8b): the forecasts at t by series; undefined for a t up to now. */
  forecasts: ReadonlyMap<number, SnapshotForecast> | undefined;
  selected: ApiStation | undefined;
  onSelect: (id: string | undefined) => void;
  /** The popup's own close button: deselect, and put the focus somewhere that stays. */
  onClose: () => void;
  /** The map could not start (no WebGL2 context, no basemap, …): the page shows the table. */
  onFailure: (code: string) => void;
}

export function StationsMap({
  locale,
  stations,
  states,
  values,
  forecasts,
  selected,
  onSelect,
  onClose,
  onFailure,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useMapLibre(ref, locale, OPTIONS);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const close = useRef(onClose);
  close.current = onClose;
  const centred = useRef(false);

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
    const pointer = () => {
      ready.getCanvas().style.cursor = 'pointer';
    };
    const plain = () => {
      ready.getCanvas().style.cursor = '';
    };
    const add = () => {
      showStations(ready, stations);
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
      ready.off('mouseenter', SOURCE, pointer);
      ready.off('mouseleave', SOURCE, plain);
      if (testHook) testHook.map = null;
      setMap(null);
    };
  }, [state, stations]);

  useEffect(() => {
    if (map === null) return;
    // Feature state merges: the forecast keys are always written, so a return to a t up to now clears them.
    for (const [id, s] of states)
      map.setFeatureState(
        { source: SOURCE, id },
        { forecast: false, estimate: false, ...s, selected: id === selected?.id },
      );
  }, [map, states, selected]);

  // A deep link with a station opens the map on it.
  useEffect(() => {
    if (map === null || centred.current) return;
    centred.current = true;
    if (selected?.lon != null && selected.lat != null) map.jumpTo({ center: [selected.lon, selected.lat], zoom: 9 });
  }, [map, selected]);

  // One line per value of the selected station: quantity, state and basis, all as text (P7b). After now (P8b) one
  // line per series: its forecast with the agency and the issue time, or "no forecast"; a hollow or grey marker
  // is never the only cue.
  const lines = useMemo(
    () =>
      (selected?.series ?? []).flatMap((series) => {
        const quantity = series.quantity === 'H' ? m.quantity_H({}, { locale }) : m.quantity_Q({}, { locale });
        if (forecasts !== undefined) return [forecastLine(quantity, forecasts.get(series.id), series, locale)];
        const v = values.get(series.id);
        return v === undefined ? [] : [popupLine(quantity, v, locale)];
      }),
    [selected, values, forecasts, locale],
  );
  const linesNow = useRef(lines);
  linesNow.current = lines;
  /** The popup's content element while a popup is open: its lines are replaced in place when `t` moves. */
  const host = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (map === null || selected === undefined || selected.lon === null || selected.lat === null) return;
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
  }, [map, selected]);

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
