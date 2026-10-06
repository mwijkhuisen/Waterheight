import type { ExpressionSpecification, GeoJSONSource, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import type { WarningsAt } from '../../lib/data/warnings.ts';
import { LADDER, STATE_COLOUR } from '../legend/palette.ts';

// Warning areas at t (P10a T5): one GeoJSON source whose properties are source, area, level and levelRaw only, so no
// name or label reaches the renderer (invariant 3). Layers sit under the stations and above the rivers. A
// `fill-pattern` cannot use feature-state (V7), so the hatched areas are a layer of their own, filtered on properties.

export const WARNINGS = 'warnings';
export const WARNINGS_FILL = 'warnings-fill';

export function warningsGeoJson(w: WarningsAt | undefined) {
  return {
    type: 'FeatureCollection' as const,
    features: (w?.features ?? []).flatMap((f) =>
      f.geometry === null
        ? []
        : [
            {
              type: 'Feature' as const,
              geometry: f.geometry,
              properties: {
                source: f.properties.source,
                area: f.properties.area,
                level: f.properties.level,
                levelRaw: f.properties.levelRaw,
              },
            },
          ],
    ),
  };
}

/** The colour of a warning level on the state palette (LADDER); an unmapped level is the grey of `no_ref`. */
const colour = [
  'match',
  ['number', ['coalesce', ['get', 'level'], 0]],
  ...[1, 2, 3, 4, 5].flatMap((l) => [l, STATE_COLOUR[LADDER[l] ?? 'no_ref']]),
  STATE_COLOUR.no_ref,
] as unknown as ExpressionSpecification;
/** DE-6 LHP class "2" is hatched and has no colour. */
const hatched: ExpressionSpecification = ['all', ['==', ['get', 'source'], 'DE-6'], ['==', ['get', 'levelRaw'], '2']];
const lines: ExpressionSpecification = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const areas: ExpressionSpecification = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];

export const warningLayers: LayerSpecification[] = [
  {
    id: WARNINGS_FILL,
    type: 'fill',
    source: WARNINGS,
    filter: ['all', areas, ['!', hatched]],
    paint: { 'fill-color': colour, 'fill-opacity': 0.35 },
  },
  {
    id: 'warnings-hatched',
    type: 'fill',
    source: WARNINGS,
    filter: ['all', areas, hatched],
    paint: { 'fill-pattern': 'hatch-area', 'fill-opacity': 0.8 },
  },
  {
    id: 'warnings-line',
    type: 'line',
    source: WARNINGS,
    filter: lines,
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': colour, 'line-width': 3, 'line-opacity': 0.85 },
  },
];

/** Creates the source and layers under `beforeId` on first use, then only replaces the data (warnings change rarely). */
export function showWarnings(map: MapLibreMap, w: WarningsAt | undefined, beforeId: string): void {
  const data = warningsGeoJson(w);
  const existing = map.getSource<GeoJSONSource>(WARNINGS);
  if (existing !== undefined) {
    existing.setData(data);
    return;
  }
  map.addSource(WARNINGS, { type: 'geojson', data });
  for (const layer of warningLayers) map.addLayer(layer, beforeId);
}
