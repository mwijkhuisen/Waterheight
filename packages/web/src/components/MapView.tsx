/**
 * The map itself: a clustered point layer over an OpenStreetMap basemap.
 *
 * Clustering is done by MapLibre's own GeoJSON source rather than a plugin.
 * The markers are drawn as a single GPU circle layer, so a few thousand points
 * cost one draw call instead of a few thousand DOM nodes.
 *
 * Which basemap, and why it is fetched rather than declared, is in
 * `basemap.ts`.
 */

import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type IControl, type LngLatBounds } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection, Point } from 'geojson';
import type { Location } from '@rws/shared';
import { FRESHNESS_COLOR, freshnessOf } from '../freshness.js';
import {
  BASEMAP_STYLE_URL,
  BOOTSTRAP_STYLE,
  DATA_ATTRIBUTION,
  LABEL_FONT,
  fetchBasemapStyle,
  keepLayersOf,
} from '../basemap.js';

/**
 * The view the map opens on: roughly the Netherlands, including the North Sea
 * measurement platforms. It is a starting point and not a limit -- the basemap
 * covers the world now, so a source upstream of the border plots fine, just
 * off-screen at this zoom. Fitting the opening view to the data instead would
 * make the Dutch stations unreadable the day one arrives, so the way to the
 * rest of it is the explicit control below rather than a wider box here.
 */
const INITIAL_BOUNDS: [number, number, number, number] = [3.0, 50.6, 7.3, 53.7];

const SOURCE_ID = 'locations';

function toFeatureCollection(locations: Location[]): FeatureCollection {
  const now = Date.now();
  return {
    type: 'FeatureCollection',
    features: locations
      // A location with no coordinates cannot be placed; the sidebar still lists it.
      .filter((l) => l.lon !== null && l.lat !== null)
      .map((l) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [l.lon!, l.lat!] },
        properties: {
          code: l.code,
          name: l.name,
          freshness: freshnessOf(l.lastSeenAt, now),
        },
      })),
  };
}

export interface MapViewProps {
  locations: Location[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
  /** Set to fly the map to a location, e.g. from a search result. */
  flyTo: Location | null;
  /**
   * Offer a control that frames every plotted location. Worth it where the map
   * shows a set and pointless where it shows one station, so it is a choice the
   * page makes. Read once, when the map mounts.
   */
  fitControl?: boolean;
}

export function MapView({ locations, selectedCode, onSelect, flyTo, fitControl }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Kept in refs so the map's callbacks never close over stale props, and so
  // the layer setup can seed itself with whatever data has already arrived.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const locationsRef = useRef(locations);
  locationsRef.current = locations;
  const selectedCodeRef = useRef(selectedCode);
  selectedCodeRef.current = selectedCode;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const abort = new AbortController();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BOOTSTRAP_STYLE,
      bounds: INITIAL_BOUNDS,
      fitBoundsOptions: { padding: 40 },
      attributionControl: false,
    });
    mapRef.current = map;

    // Without this, a failing tile source or a bad style expression fails
    // silently and the map just renders empty.
    map.on('error', (event) => {
      console.error('[map]', event.error?.message ?? event);
    });

    if (import.meta.env.DEV) {
      (window as unknown as { __map?: maplibregl.Map }).__map = map;
    }

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      // The basemap credits itself through its source's TileJSON; the
      // measurement data has nowhere else to be credited from.
      new maplibregl.AttributionControl({ compact: true, customAttribution: DATA_ATTRIBUTION }),
      'bottom-right',
    );
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

    if (fitControl) {
      map.addControl(
        new FitToDataControl(() => {
          const bounds = boundsOf(locationsRef.current);
          // maxZoom: a filter that leaves one location would otherwise frame
          // it at street level, which says nothing about where it is.
          if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 11, duration: 700 });
        }),
        'top-right',
      );
    }

    // Deliberately NOT map.on('load'): that waits for the initial basemap
    // tiles, so a slow or unreachable tile provider would take the whole data
    // layer down with it and leave an empty map. 'style.load' fires as soon as
    // the style spec is parsed, which is all we need to add sources and layers.
    // The markers are the product; the basemap is decoration.
    const addDataLayers = () => {
      if (map.getSource(SOURCE_ID)) return;
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: 48,
        // Past this zoom the individual stations are far enough apart to read.
        clusterMaxZoom: 12,
        // Carried through so a cluster can report how many of its members are
        // behind schedule, rather than hiding that until you zoom in.
        clusterProperties: {
          delayed: ['+', ['case', ['==', ['get', 'freshness'], 'delayed'], 1, 0]],
        },
      });

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          // Neutral, so cluster colour is never mistaken for a freshness state.
          'circle-color': '#31465f',
          'circle-opacity': 0.9,
          'circle-radius': [
            'step', ['get', 'point_count'],
            16, 10, 21, 50, 27, 200, 34,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 13,
          'text-font': LABEL_FONT,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#ffffff' },
      });

      map.addLayer({
        id: 'points',
        type: 'circle',
        source: SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match', ['get', 'freshness'],
            'fresh', FRESHNESS_COLOR.fresh,
            FRESHNESS_COLOR.delayed,
          ],
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            6, 5,
            10, 7,
            14, 9,
          ],
          // A dark ring on every marker: it lifts both fills off a light
          // basemap, and the delayed colour is below 3:1 on its own.
          'circle-stroke-color': '#1a1a19',
          'circle-stroke-width': 1.25,
          'circle-stroke-opacity': 0.75,
        },
      });

      // Selection ring, drawn above everything so it reads at any zoom.
      map.addLayer({
        id: 'selected',
        type: 'circle',
        source: SOURCE_ID,
        // Seeded, not empty: the location page mounts with its station already
        // selected, and the effect that maintains this filter runs before the
        // style has loaded and finds no layer to set it on.
        filter: ['==', ['get', 'code'], selectedCodeRef.current ?? ''],
        paint: {
          'circle-radius': 14,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#cb3837',
          'circle-stroke-width': 3,
        },
      });

      // Seed with whatever has already loaded. The alternative -- signalling
      // readiness and letting the data effect respond -- races on remount: the
      // signal can fire before the effect subscribes, and the map stays empty.
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(toFeatureCollection(locationsRef.current));
    };

    // The map is usable from here on. This only replaces the flat background
    // with a real one, so every failure path is a console line and a plain grey
    // map, never a missing data layer.
    const swapInBasemap = async () => {
      const style = await fetchBasemapStyle(BASEMAP_STYLE_URL, abort.signal).catch(
        (error: unknown) => {
          if (!abort.signal.aborted) {
            console.error('[map] basemap unavailable, keeping the flat background', error);
          }
          return null;
        },
      );
      if (!style || abort.signal.aborted) return;

      map.setStyle(style, { diff: false, transformStyle: keepLayersOf(SOURCE_ID) });
      // `transformStyle` carries the source and the layers across as MapLibre
      // serialised them, which today includes the features and the selection
      // filter. Reapplying both from the props costs one parse of a collection
      // the browser already holds, and covers the gap between the swap starting
      // and the new style committing, during which the effects below find no
      // layer to write to and give up.
      map.once('style.load', () => {
        const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
        source?.setData(toFeatureCollection(locationsRef.current));
        map.setFilter('selected', ['==', ['get', 'code'], selectedCodeRef.current ?? '']);
      });
    };

    // Adding the layers first, so the swap has something to carry over. The
    // fetch takes a round trip and the bootstrap style parses synchronously, so
    // in practice the order is never in doubt -- but "in practice" is how the
    // layer setup lost its race the first time.
    const ready = () => {
      addDataLayers();
      void swapInBasemap();
    };

    if (map.isStyleLoaded()) ready();
    else map.once('style.load', ready);

    map.on('click', 'points', (event) => {
      const feature = event.features?.[0];
      const code = feature?.properties?.['code'];
      if (typeof code === 'string') onSelectRef.current(code);
    });

    // Clicking a cluster zooms into it, which is the expected affordance.
    map.on('click', 'clusters', (event) => {
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.['cluster_id'];
      if (clusterId === undefined) return;
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      void source?.getClusterExpansionZoom(Number(clusterId)).then((zoom) => {
        const geometry = feature!.geometry as Point;
        map.easeTo({ center: geometry.coordinates as [number, number], zoom });
      });
    });

    for (const layer of ['points', 'clusters']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }

    return () => {
      abort.abort();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Push data whenever the filtered set changes. If the source does not exist
  // yet, layer setup will seed it from locationsRef instead -- no signalling,
  // so no ordering to get wrong.
  useEffect(() => {
    const source = mapRef.current?.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(toFeatureCollection(locations));
  }, [locations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('selected')) return;
    map.setFilter('selected', ['==', ['get', 'code'], selectedCode ?? '']);
  }, [selectedCode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo || flyTo.lon === null || flyTo.lat === null) return;
    map.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: 13, speed: 1.4 });
  }, [flyTo]);

  return <div className="map" ref={containerRef} data-testid="map" />;
}

/** The box around everything plottable, or null if nothing is. */
function boundsOf(locations: Location[]): LngLatBounds | null {
  let bounds: LngLatBounds | null = null;
  for (const location of locations) {
    if (location.lon === null || location.lat === null) continue;
    const point: [number, number] = [location.lon, location.lat];
    bounds = bounds ? bounds.extend(point) : new maplibregl.LngLatBounds(point, point);
  }
  return bounds;
}

/**
 * A "fit to the data" button, under the zoom controls.
 *
 * The map opens on the Netherlands and the data does not have to stay there:
 * once a source upstream of the border is ingested, its stations are plotted
 * correctly and entirely off-screen. Framing whatever is actually loaded, rather
 * than a hardcoded basin box, means that day needs no edit here -- and it is the
 * more useful button in the meantime too, since a filter that leaves four
 * stations frames those four.
 */
class FitToDataControl implements IControl {
  private container: HTMLElement | null = null;

  constructor(private readonly fit: () => void) {}

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    const button = document.createElement('button');
    button.type = 'button';
    // The icon is a background image, which is how MapLibre draws its own.
    button.className = 'maplibregl-ctrl-icon map-fit';
    button.title = 'Fit to all locations';
    button.setAttribute('aria-label', 'Fit to all locations');
    button.addEventListener('click', this.fit);

    container.append(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}
