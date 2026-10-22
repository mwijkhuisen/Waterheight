import type { ExpressionSpecification, FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { WATER_CANALS, WATER_LAKES, WATER_LAKES_LINE, WATER_LAKES_TIDAL } from '../../lib/water.ts';
import { LADDER, STATE_COLOUR } from '../legend/palette.ts';

// The lakes and canals (P19a T3, issue #67): layers of the `rivers` source's `waterbodies` and `canals` layers, under
// the river lines. A lazy chunk, DOM-free (tsconfig.tooling.json): StationsMap reaches it only through `import()`,
// once the river source exists, and takes the layer ids from lib/water.ts (a value import of this file would pull it
// into the initial bundle). The lake fill's colour is the feature-state `lv` (the reference gauge's LADDER index,
// water.ts `lakeLevels`); a pattern cannot read feature-state, so the tidal hatch is a filter on an id list.

const SOURCE = 'rivers';
const LAYERS = [WATER_LAKES, WATER_LAKES_TIDAL, WATER_LAKES_LINE, WATER_CANALS] as const;
/** A lake without a class ("geen klasse"): a neutral grey. */
const NO_CLASS = '#c8ccd0';
const POLYGON: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon'];

export interface WaterHandle {
  /** Writes each lake's `lv` feature-state (null: "geen klasse", the neutral grey). */
  update(levels: ReadonlyMap<string, { level: number | null }>): void;
  /** The ids of the lakes whose reference gauge is tidal (`LakeView.tidal`): the hatch layer's filter. */
  setTidal(ids: readonly string[]): void;
  /** Removes the layers; safe after `map.remove()`. */
  dispose(): void;
}

/** Adds the water layers before `beforeId` (the river base line, so lines and points stay on top). */
export function addWater(map: MapLibreMap, beforeId: string): WaterHandle {
  const before = map.getLayer(beforeId) === undefined ? undefined : beforeId;
  // A fill or line layer draws no point (a vertex-less ring), but the guard keeps it true of any tile: the lake layers
  // take polygons only (the tile geometry type is Polygon for a MultiPolygon too).
  const lakes: FilterSpecification = ['all', POLYGON, ['in', ['get', 'kind'], ['literal', ['lake', 'closed_estuary']]]];
  const lv = ['coalesce', ['feature-state', 'lv'], -1];
  map.addLayer(
    {
      id: WATER_LAKES,
      type: 'fill',
      source: SOURCE,
      'source-layer': 'waterbodies',
      filter: lakes,
      paint: {
        'fill-color': [
          'match',
          lv,
          ...LADDER.flatMap((s, i) => (i === 0 ? [] : [i, STATE_COLOUR[s]])),
          NO_CLASS,
        ] as unknown as ExpressionSpecification,
        'fill-opacity': 0.45,
      },
    },
    before,
  );
  // The tidal hatch over the fill: a pattern cannot read feature-state, so the ids come by setFilter (setTidal). The
  // `hatch-area` image is drawn by showStations with the station source, which StationsMap adds before this chunk loads.
  map.addLayer(
    {
      id: WATER_LAKES_TIDAL,
      type: 'fill',
      source: SOURCE,
      'source-layer': 'waterbodies',
      filter: ['all', POLYGON, ['in', ['id'], ['literal', []]]],
      paint: { 'fill-pattern': 'hatch-area', 'fill-opacity': 0.8 },
    },
    before,
  );
  // The edge in the river blue: the lake is told from the land by its outline, not by its fill colour alone.
  map.addLayer(
    {
      id: WATER_LAKES_LINE,
      type: 'line',
      source: SOURCE,
      'source-layer': 'waterbodies',
      filter: lakes,
      paint: { 'line-color': '#2b6f9e', 'line-width': 0.8 },
    },
    before,
  );
  // No state and no animation: the flow layers read the `rivers` source-layer only, so a canal never flows. Thinner
  // than the river line (features/map/rivers.ts: 0.6, 1.5, 3 at zoom 4, 8, 12) at every zoom.
  map.addLayer(
    {
      id: WATER_CANALS,
      type: 'line',
      source: SOURCE,
      'source-layer': 'canals',
      layout: { 'line-cap': 'butt' },
      paint: {
        'line-color': '#5b7f95',
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 8, 0.8, 12, 1.6],
        'line-dasharray': [2, 1.5],
      },
    },
    before,
  );
  return {
    update(levels) {
      if (map.getLayer(WATER_LAKES) === undefined) return;
      for (const [id, { level }] of levels)
        map.setFeatureState({ source: SOURCE, sourceLayer: 'waterbodies', id }, { lv: level });
    },
    setTidal(ids) {
      if (map.getLayer(WATER_LAKES_TIDAL) !== undefined)
        map.setFilter(WATER_LAKES_TIDAL, ['in', ['id'], ['literal', [...ids]]]);
    },
    dispose() {
      // StationsMap disposes on unmount, which may run after map.remove(): a removed map has no style to ask.
      try {
        for (const id of LAYERS) if (map.getLayer(id) !== undefined) map.removeLayer(id);
      } catch {
        // the map is already gone, and its layers with it
      }
    },
  };
}
