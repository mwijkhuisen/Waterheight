import type { ApiStation } from '@rws/contracts';
import type { MapLayerMouseEvent, Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { testHook } from '../../lib/testHook.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
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
  selected: ApiStation | undefined;
  onSelect: (id: string | undefined) => void;
  /** The map could not start (no WebGL2 context, no basemap, …): the page shows the table. */
  onFailure: (code: string) => void;
}

export function StationsMap({ locale, stations, states, selected, onSelect, onFailure }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useMapLibre(ref, locale, OPTIONS);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
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
    for (const [id, s] of states) map.setFeatureState({ source: SOURCE, id }, { ...s, selected: id === selected?.id });
  }, [map, states, selected]);

  // A deep link with a station opens the map on it.
  useEffect(() => {
    if (map === null || centred.current) return;
    centred.current = true;
    if (selected?.lon != null && selected.lat != null) map.jumpTo({ center: [selected.lon, selected.lat], zoom: 9 });
  }, [map, selected]);

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
      // Only the popup's own close button deselects: MapLibre also fires 'close' when the map itself is removed
      // (switching to the table), and that must keep the selection.
      popup
        .getElement()
        ?.querySelector('.maplibregl-popup-close-button')
        ?.addEventListener('click', () => select.current(undefined));
      remove = () => popup.remove();
    });
    return () => {
      removed = true;
      remove?.();
    };
  }, [map, selected]);

  return (
    <>
      {state.status === 'loading' && <p className={styles.status}>{m.map_loading({}, { locale })}</p>}
      <div ref={ref} className={styles.map} />
    </>
  );
}
