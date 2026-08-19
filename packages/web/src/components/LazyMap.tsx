/**
 * Code-split entry point for the map.
 *
 * MapLibre and its stylesheet are roughly nine tenths of the JavaScript on this
 * site, and only two routes render a map. Loading it on demand keeps search,
 * the location pages and the docs off that cost entirely.
 */

import { Suspense, lazy } from 'react';
import type { MapViewProps } from './MapView.js';

const MapView = lazy(() =>
  import('./MapView.js').then((module) => ({ default: module.MapView })),
);

export function LazyMapView(props: MapViewProps) {
  return (
    <Suspense fallback={<p className="map-loading" role="status">Loading map…</p>}>
      <MapView {...props} />
    </Suspense>
  );
}
