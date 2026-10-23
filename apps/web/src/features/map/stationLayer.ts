import type { ApiStation } from '@rws/contracts';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import type { Mode } from '../../lib/url/url.ts';
import { isMsl } from '../../lib/water.ts';
import {
  DH_COLOUR,
  LADDER,
  LAPSED_COLOUR,
  LAPSED_RADIUS,
  Q_COLOUR,
  Q_RADIUS,
  STATE_COLOUR,
  STATE_RADIUS,
  SURGE_COLOURS,
  SURGE_STOPS_CM,
} from '../legend/palette.ts';
import { hatchAreaIcon, hatchIcon, type Icon, triangleIcon } from './icons.ts';
import { showWarnings } from './warnings.ts';

// The stations as `circle` layers whose look comes only from feature-state (the P3 pattern: a new `t` never rebuilds
// the source; P10a: the paint follows the map mode and is replaced with `setPaintProperty` when the mode changes).
// Feature state (lib/stationStates.ts): has, stale, forecast, estimate, level, section, suspect, dhBin, qSize, owner,
// hidden (never drawn: a hidden station is not in the source), coast, surge, plus selected. Layers, bottom to top:
//   stations          the marker: fill by mode (state level, 24 h change bin or discharge size), radius by level or
//                     discharge size; hollow grey ring = nothing to show in this mode; a stale value is fainter; a
//                     small grey dot = no value, the newest one past its staleness limit (`stale` without `has`,
//                     KG-233); selected = larger, black ring.
//   stations-suspect  a second, outer ring (MapLibre circles cannot be dashed): a station with a suspect value.
//   stations-owner    a third, wider purple ring (owner site only: the state is only ever true there).
//   stations-trend-*  the ▲ / ▼ icons of the delta mode (symbol layout cannot use feature-state, so two layers whose
//                     `icon-opacity` does).
//   stations-surge-*  P19a: the ▲ / ▼ of a coast station's surge ≥ +50 / ≤ −50 cm (state mode), the same pattern.
//   stations-tidal    the `hatch` icon on tidal stations; stations-impounded the localised short text.
//   stations-msl      P19a: "MSL" beside a station whose primary H series is in MSL (the platforms).
// #205: far out only tier 1. Every layer above but stations-impounded (minzoom 8) shows tier 2 from TIER2_MINZOOM, and
// the selected station at every zoom (stationFilter); the platforms are tier 2, so they too wait until z8 (owner
// 2026-10-23, KG-450).
// P19a (T2, honest display): in the state mode a coast station is coloured by its surge only, on SURGE_STOPS_CM, at
// one fixed size, and is hollow without a surge, whatever its level (an MSL level never meets a NAP scale or an NL-4
// class). The delta and Q modes are unchanged.
// After now (P8b) the shapes change meaning: a ring is a forecast, a fainter ring an estimate, a grey dot no forecast.

export const SOURCE = 'stations';

/**
 * Points for the stations that have a position; the id, the two registry flags, `msl` (P19a) and the tier (#205) are
 * the only properties, so no name reaches the renderer.
 */
export function stationPoints(stations: readonly ApiStation[]) {
  return {
    type: 'FeatureCollection' as const,
    features: stations.flatMap((st) =>
      st.lon === null || st.lat === null
        ? []
        : [
            {
              type: 'Feature' as const,
              properties: {
                id: st.id,
                tidal: st.flags.tidal === true,
                impounded: st.flags.impounded === true,
                msl: isMsl(st),
                tier: st.tier,
              },
              geometry: { type: 'Point' as const, coordinates: [st.lon, st.lat] },
            },
          ],
    ),
  };
}

/**
 * Tier 2 joins the map at this zoom (#205). It equals BIN_MINZOOM (features/flow/reaches/bins.ts), on purpose and by
 * hand: the stations switch to all tiers where the reaches switch to their 500 m bins, and that file is the lazy flow
 * chunk.
 */
export const TIER2_MINZOOM = 8;

/** The station layers thinned by tier, each with its own filter, if any. */
const TIERED: Record<string, ExpressionSpecification | undefined> = {
  [SOURCE]: undefined,
  'stations-suspect': undefined,
  'stations-owner': undefined,
  'stations-trend-up': undefined,
  'stations-trend-down': undefined,
  'stations-surge-up': undefined,
  'stations-surge-down': undefined,
  'stations-tidal': ['==', ['get', 'tidal'], true],
  'stations-msl': ['==', ['get', 'msl'], true],
};

/**
 * Below TIER2_MINZOOM only tier 1 and the selected station; from it, all. The id is a literal because a filter cannot
 * read feature-state. MapLibre evaluates a filter per tile, at the tile's integer zoom (a GeoJSON tile is 512 px, so
 * that is the map's zoom rounded down): tier 2 appears at exactly z8.0. A zoom `step` may sit inside `all` in a filter
 * (only paint and layout need it at the top).
 */
export function stationFilter(layer: string, selected = ''): ExpressionSpecification {
  const tier: ExpressionSpecification = [
    'step',
    ['zoom'],
    ['any', ['==', ['get', 'tier'], 1], ['==', ['get', 'id'], selected]],
    TIER2_MINZOOM,
    true,
  ];
  const own = TIERED[layer];
  return own === undefined ? tier : ['all', own, tier];
}

/** Puts the selected station (or none) into the filters, so it stays drawn at every zoom; the camera does not move. */
export function setSelectedStation(map: MapLibreMap, selected: string | undefined): void {
  for (const id of Object.keys(TIERED))
    if (map.getLayer(id) !== undefined) map.setFilter(id, stationFilter(id, selected));
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
/** KG-233: no value at t, and a series' newest value is past its limit (under 25 h): a small grey dot. */
const lapsed: ExpressionSpecification = ['all', ['!', state('has')], state('stale')];
/** P19a: a coast station with a surge at t (the surge is null without one, and on every other station). */
const surged: ExpressionSpecification = ['all', state('coast'), ['!=', ['feature-state', 'surge'], null]];
const surge = num('surge', 0);
/** The size of a coast marker with a surge: one size, so the NL-4 ladder never shows through. */
const SURGE_RADIUS = 6.5;

/** Nothing to show in this mode: no value, no state (state mode), no change (delta mode) or no discharge (q mode). */
export function hollow(mode: Mode): ExpressionSpecification {
  const none: ExpressionSpecification =
    mode === 'state'
      ? // A coast station shows its surge or nothing; any other its level (P19a T2).
        ['case', state('coast'), ['!', surged], ['==', level, 0]]
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
      ? [
          'case',
          state('coast'),
          ['case', surged, SURGE_RADIUS, STATE_RADIUS.no_ref],
          ['match', level, ...pairs(LADDER.map((s, i) => [i, STATE_RADIUS[s]] as const)), 5],
        ]
      : mode === 'delta'
        ? ['case', state('has'), 6.5, 4]
        : ['match', num('qSize', 0), ...pairs(([0, 1, 2, 3, 4] as const).map((q) => [q, Q_RADIUS[q]] as const)), 4],
  );
  return ['case', state('forecast'), ['case', state('has'), 6, 4], lapsed, LAPSED_RADIUS, base];
}

function fill(mode: Mode): ExpressionSpecification {
  const coloured: ExpressionSpecification = ex(
    mode === 'state'
      ? [
          'case',
          surged,
          ['interpolate', ['linear'], surge, ...SURGE_STOPS_CM.flatMap((cm, i) => [cm, SURGE_COLOURS[i]])],
          ['match', level, ...pairs(LADDER.map((s, i) => [i, STATE_COLOUR[s]] as const)), STATE_COLOUR.no_ref],
        ]
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
  return ['case', state('forecast'), '#767676', lapsed, LAPSED_COLOUR, hollow(mode), '#ffffff', coloured];
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
  const surgeTri = (up: boolean): ExpressionSpecification =>
    ex([
      'case',
      mode === 'state' ? ['all', state('has'), surged, up ? ['>=', surge, 50] : ['<=', surge, -50]] : false,
      1,
      0,
    ]);
  return {
    [SOURCE]: {
      'circle-radius': ['case', state('selected'), ['+', r, 3], r],
      // BrBG teal (A§10, colour-blind safe). A stale value is fainter (a hollow ring has no fill at all, a lapsed
      // station is a small grey dot); the ring of a forecast has no fill and a teal outline; the selection ring
      // never fades.
      'circle-color': fill(mode),
      'circle-opacity': ['case', ring, 0, state('forecast'), 1, lapsed, 1, hollow(mode), 0, state('stale'), 0.55, 1],
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
    'stations-surge-up': { 'icon-opacity': surgeTri(true) },
    'stations-surge-down': { 'icon-opacity': surgeTri(false) },
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
 * of the impounded label and `msl` the MSL marker's (messages, never provider text).
 */
export function showStations(
  map: MapLibreMap,
  stations: readonly ApiStation[],
  mode: Mode,
  impounded: string,
  msl: string,
): void {
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
    ({
      id,
      type: 'circle',
      source: SOURCE,
      filter: stationFilter(id),
      paint: { ...paints[id], ...extra },
    }) as LayerSpecification;
  const trend = (id: string, icon: string): SymbolLayerSpecification => ({
    id,
    type: 'symbol',
    source: SOURCE,
    filter: stationFilter(id),
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
  map.addLayer(trend('stations-surge-up', 'tri-up'));
  map.addLayer(trend('stations-surge-down', 'tri-down'));
  map.addLayer({
    id: 'stations-tidal',
    type: 'symbol',
    source: SOURCE,
    filter: stationFilter('stations-tidal'),
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
  // Above the marker (the impounded word goes below), with it: the platforms are tier 2, so from z8 (#205; D29's points
  // over the world basemap at low zoom no longer hold, owner 2026-10-23).
  map.addLayer({
    id: 'stations-msl',
    type: 'symbol',
    source: SOURCE,
    filter: stationFilter('stations-msl'),
    layout: {
      'text-field': msl,
      'text-font': TEXT_FONT,
      'text-size': 10,
      'text-offset': [0, -1.4],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#303030', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });
}
