/**
 * The map itself: a clustered point layer over a Dutch basemap.
 *
 * Clustering is done by MapLibre's own GeoJSON source rather than a plugin.
 * The markers are drawn as a single GPU circle layer, so a few thousand points
 * cost one draw call instead of a few thousand DOM nodes.
 */

import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import type { Location } from '@rws/shared';
import { FRESHNESS_COLOR, freshnessOf } from '../freshness.js';

/** Roughly the Netherlands, including the North Sea measurement platforms. */
const INITIAL_BOUNDS: [number, number, number, number] = [3.0, 50.6, 7.3, 53.7];

const SOURCE_ID = 'locations';

/**
 * PDOK's BRT achtergrondkaart: the Dutch national basemap, free and keyless.
 * Deliberately grey so the data layer carries the colour.
 */
const BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  // Required for the cluster-count symbol layer; without a glyph source the
  // counts silently fail to render.
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    pdok: {
      type: 'raster',
      tiles: [
        'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 17,
      attribution:
        '<a href="https://www.pdok.nl/">PDOK</a> / ' +
        '<a href="https://rijkswaterstaatdata.nl/waterdata/">Rijkswaterstaat</a>',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#eceae5' } },
    { id: 'pdok', type: 'raster', source: 'pdok' },
  ],
};

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
}

export function MapView({ locations, selectedCode, onSelect, flyTo }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Kept in refs so the map's callbacks never close over stale props, and so
  // the layer setup can seed itself with whatever data has already arrived.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const locationsRef = useRef(locations);
  locationsRef.current = locations;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
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
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

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
          'circle-stroke-color': '#fcfcfb',
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
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
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
        filter: ['==', ['get', 'code'], ''],
        paint: {
          'circle-radius': 14,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#2a78d6',
          'circle-stroke-width': 3,
        },
      });

      // Seed with whatever has already loaded. The alternative -- signalling
      // readiness and letting the data effect respond -- races on remount: the
      // signal can fire before the effect subscribes, and the map stays empty.
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      source?.setData(toFeatureCollection(locationsRef.current));
    };

    if (map.isStyleLoaded()) addDataLayers();
    else map.once('style.load', addDataLayers);

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
