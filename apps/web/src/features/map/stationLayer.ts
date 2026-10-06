import type { ApiStation, Snapshot, SnapshotForecast } from '@rws/contracts';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import type { Mode } from '../../lib/url/url.ts';
import { DH_COLOUR, LADDER, Q_COLOUR, Q_RADIUS, STATE_COLOUR, STATE_RADIUS } from '../legend/palette.ts';
import { hatchAreaIcon, hatchIcon, type Icon, triangleIcon } from './icons.ts';
import { showWarnings } from './warnings.ts';

// The stations as `circle` layers whose look comes only from feature-state (the P3 pattern: a new `t` never rebuilds
// the source; P10a: the paint follows the map mode and is replaced with `setPaintProperty` when the mode changes).
// Feature state (lib/stationStates.ts): has, stale, forecast, estimate, level, section, suspect, dhBin, qSize, owner,
// plus selected. Layers, bottom to top:
//   stations          the marker: fill by mode (state level, 24 h change bin or discharge size), radius by level or
//                     discharge size; hollow grey ring = nothing to show in this mode; selected = larger, black ring.
//   stations-suspect  a second, outer ring (MapLibre circles cannot be dashed): a station with a suspect value.
//   stations-owner    a third, wider purple ring (owner site only: the state is only ever true there).
//   stations-trend-*  the ▲ / ▼ icons of the delta mode (symbol layout cannot use feature-state, so two layers whose
//                     `icon-opacity` does).
//   stations-tidal    the `hatch` icon on tidal stations; stations-impounded the localised short text.
// After now (P8b) the shapes change meaning: a ring is a forecast, a fainter ring an estimate, a grey dot no forecast.

export const SOURCE = 'stations';

export interface MarkerState {
  /** A value at t, or after now a forecast at t. */
  has: boolean;
  stale: boolean;
  /** t is after now: `has` means a forecast. */
  forecast?: boolean;
  /** Every forecast of the station is an estimate. */
  estimate?: boolean;
}

type Value = Snapshot['values'][number];

/** Points for the stations that have a position; the id and the two registry flags are the only properties, so no name reaches the renderer. */
export function stationPoints(stations: readonly ApiStation[]) {
  return {
    type: 'FeatureCollection' as const,
    features: stations.flatMap((st) =>
      st.lon === null || st.lat === null
        ? []
        : [
            {
              type: 'Feature' as const,
              properties: { id: st.id, tidal: st.flags.tidal === true, impounded: st.flags.impounded === true },
              geometry: { type: 'Point' as const, coordinates: [st.lon, st.lat] },
            },
          ],
    ),
  };
}

/** Per station: a value at t in any series, and whether each of its values is older than twice its series' step. */
export function markerStates(
  stations: readonly ApiStation[],
  values: ReadonlyMap<number, Value>,
): Map<string, MarkerState> {
  const out = new Map<string, MarkerState>();
  for (const st of stations) {
    let has = false;
    let fresh = false;
    for (const s of st.series) {
      const v = values.get(s.id);
      if (v === undefined) continue;
      has = true;
      if (v.ageSeconds <= 2 * s.expectedStepSeconds) fresh = true;
    }
    out.set(st.id, { has, stale: has && !fresh });
  }
  return out;
}

/** After now, per station: a forecast at t in any series, and whether each one is an estimate. */
export function forecastStates(
  stations: readonly ApiStation[],
  forecasts: ReadonlyMap<number, Pick<SnapshotForecast, 'estimate'>>,
): Map<string, MarkerState> {
  const out = new Map<string, MarkerState>();
  for (const st of stations) {
    const found = st.series.flatMap((s) => forecasts.get(s.id) ?? []);
    out.set(st.id, {
      has: found.length > 0,
      stale: false,
      forecast: true,
      estimate: found.length > 0 && found.every((f) => f.estimate),
    });
  }
  return out;
}

const state = (key: string): ExpressionSpecification => ['boolean', ['feature-state', key], false];
/** A numeric feature-state; `null` (no change, no discharge) is skipped by `coalesce`, never read as 0. */
const num = (key: string, fallback: number): ExpressionSpecification => [
  'number',
  ['coalesce', ['feature-state', key], fallback],
];
const level = num('level', 0);
const NO_BIN = 99;
/** A station with a forecast at t: a ring. */
const ring: ExpressionSpecification = ['all', state('forecast'), state('has')];

/** Nothing to show in this mode: no value, no state (state mode), no change (delta mode) or no discharge (q mode). */
export function hollow(mode: Mode): ExpressionSpecification {
  const none: ExpressionSpecification =
    mode === 'state'
      ? ['==', level, 0]
      : mode === 'delta'
        ? ['==', num('dhBin', NO_BIN), NO_BIN]
        : ['<=', num('qSize', 0), 0];
  return ['any', ['!', state('has')], none];
}

/** The `match` expressions are built from tables, which the spec's tuple types cannot follow. */
const ex = (e: unknown): ExpressionSpecification => e as ExpressionSpecification;
const pairs = (entries: readonly (readonly [number, unknown])[]) => entries.flat();

/** The marker radius by mode (before the selected bonus). */
function radius(mode: Mode): ExpressionSpecification {
  const base: ExpressionSpecification = ex(
    mode === 'state'
      ? ['match', level, ...pairs(LADDER.map((s, i) => [i, STATE_RADIUS[s]] as const)), 5]
      : mode === 'delta'
        ? ['case', state('has'), 6.5, 4]
        : ['match', num('qSize', 0), ...pairs(([0, 1, 2, 3, 4] as const).map((q) => [q, Q_RADIUS[q]] as const)), 4],
  );
  return ['case', state('forecast'), ['case', state('has'), 6, 4], base];
}

function fill(mode: Mode): ExpressionSpecification {
  const coloured: ExpressionSpecification = ex(
    mode === 'state'
      ? ['match', level, ...pairs(LADDER.map((s, i) => [i, STATE_COLOUR[s]] as const)), STATE_COLOUR.no_ref]
      : mode === 'delta'
        ? [
            'match',
            num('dhBin', NO_BIN),
            ...pairs(([-3, -2, -1, 0, 1, 2, 3] as const).map((b) => [b, DH_COLOUR[b]] as const)),
            '#ffffff',
          ]
        : Q_COLOUR,
  );
  // After now a grey dot is "no forecast"; a ring (opacity 0) is a forecast.
  return ['case', state('forecast'), '#767676', hollow(mode), '#ffffff', coloured];
}

/** The paint of every mode-dependent layer; `showStations` adds them and `setStationMode` replaces them. */
export function layerPaints(mode: Mode): Record<string, Record<string, unknown>> {
  const r = radius(mode);
  const tri = (up: boolean): ExpressionSpecification =>
    ex([
      'case',
      mode === 'delta' ? ['all', state('has'), ['!', state('forecast')], [up ? '>' : '<', num('dhBin', 0), 0]] : false,
      1,
      0,
    ]);
  return {
    [SOURCE]: {
      'circle-radius': ['case', state('selected'), ['+', r, 3], r],
      // BrBG teal (A§10, colour-blind safe). A stale value is fainter (a hollow ring has no fill at all); the ring
      // of a forecast has no fill and a teal outline; the selection ring never fades.
      'circle-color': fill(mode),
      'circle-opacity': ['case', ring, 0, state('forecast'), 1, hollow(mode), 0, state('stale'), 0.55, 1],
      'circle-stroke-color': [
        'case',
        state('selected'),
        '#000000',
        ring,
        '#01665e',
        ['all', hollow(mode), ['!', state('forecast')]],
        '#767676',
        '#525252',
      ],
      'circle-stroke-width': [
        'case',
        state('selected'),
        3,
        ['all', ring, state('estimate')],
        2,
        ring,
        3,
        hollow(mode),
        2,
        1.5,
      ],
      // A fainter ring still has 3:1 against white (teal at 65 %).
      'circle-stroke-opacity': ['case', state('selected'), 1, ['all', ring, state('estimate')], 0.65, 1],
    },
    'stations-suspect': {
      'circle-radius': ['+', r, 3.5],
      'circle-stroke-opacity': ['case', state('suspect'), 1, 0],
    },
    'stations-owner': {
      'circle-radius': ['+', r, 6.5],
      'circle-stroke-opacity': ['case', state('owner'), 1, 0],
    },
    'stations-trend-up': { 'icon-opacity': tri(true) },
    'stations-trend-down': { 'icon-opacity': tri(false) },
  };
}

/** Replaces the mode-dependent paint (the source and the feature states stay). */
export function setStationMode(map: MapLibreMap, mode: Mode): void {
  for (const [id, paint] of Object.entries(layerPaints(mode)))
    if (map.getLayer(id) !== undefined)
      for (const [name, value] of Object.entries(paint)) map.setPaintProperty(id, name as never, value as never);
}

const ICONS: Record<string, () => Icon> = {
  hatch: hatchIcon,
  'hatch-area': hatchAreaIcon,
  'tri-up': () => triangleIcon(true),
  'tri-down': () => triangleIcon(false),
};

const TEXT_FONT = ['Noto Sans Regular'];

/**
 * Adds the sources and layers, or only replaces the points when they exist. `impounded` is the localised short word
 * of the impounded label (a message, never provider text).
 */
export function showStations(map: MapLibreMap, stations: readonly ApiStation[], mode: Mode, impounded: string): void {
  const existing = map.getSource<GeoJSONSource>(SOURCE);
  if (existing !== undefined) {
    existing.setData(stationPoints(stations));
    return;
  }
  // Drawn at run time into RGBA: no file, no request, no data: or blob: URL (the CSP is unchanged).
  for (const [name, icon] of Object.entries(ICONS))
    if (!map.hasImage(name)) map.addImage(name, icon(), { pixelRatio: 1 });
  map.addSource(SOURCE, { type: 'geojson', data: stationPoints(stations), promoteId: 'id' });
  const paints = layerPaints(mode);
  const circle = (id: string, extra: Record<string, unknown>): LayerSpecification =>
    ({ id, type: 'circle', source: SOURCE, paint: { ...paints[id], ...extra } }) as LayerSpecification;
  const trend = (id: string, icon: string): SymbolLayerSpecification => ({
    id,
    type: 'symbol',
    source: SOURCE,
    layout: { 'icon-image': icon, 'icon-size': 0.8, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: paints[id] as NonNullable<SymbolLayerSpecification['paint']>,
  });
  map.addLayer(circle(SOURCE, {}));
  // The warnings go under the stations; the rivers are added beneath the warnings (rivers.ts).
  showWarnings(map, undefined, SOURCE);
  map.addLayer(
    circle('stations-suspect', { 'circle-opacity': 0, 'circle-stroke-color': '#000000', 'circle-stroke-width': 1.5 }),
  );
  map.addLayer(
    circle('stations-owner', { 'circle-opacity': 0, 'circle-stroke-color': '#6a3d9a', 'circle-stroke-width': 2 }),
  );
  map.addLayer(trend('stations-trend-up', 'tri-up'));
  map.addLayer(trend('stations-trend-down', 'tri-down'));
  map.addLayer({
    id: 'stations-tidal',
    type: 'symbol',
    source: SOURCE,
    filter: ['==', ['get', 'tidal'], true],
    layout: { 'icon-image': 'hatch', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-opacity': ['case', state('has'), 1, 0] },
  });
  map.addLayer({
    id: 'stations-impounded',
    type: 'symbol',
    source: SOURCE,
    minzoom: 8,
    filter: ['==', ['get', 'impounded'], true],
    layout: {
      'text-field': impounded,
      'text-font': TEXT_FONT,
      'text-size': 10,
      'text-offset': [0, 1.4],
      'text-optional': true,
    },
    paint: { 'text-color': '#303030', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });
}
