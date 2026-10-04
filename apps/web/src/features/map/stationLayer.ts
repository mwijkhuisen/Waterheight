import type { ApiStation, Snapshot, SnapshotForecast } from '@rws/contracts';
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

// The stations as one `circle` layer whose look comes only from feature-state
// (the P3 pattern: a new `t` never rebuilds the source). No class colours before
// P7: a filled marker has a value at t, a lighter one only an old value (carried
// forward), a hollow one none; the selected one is larger with a dark ring.
// After now (P8b) the shapes change meaning: a hollow ring is a forecast, a fainter ring an estimate (beyond the
// part the source forecasts itself), a grey dot no forecast. The panel, popup and table say the same in words.

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

/** Points for the stations that have a position; the id is the only property, so no name reaches the renderer. */
export function stationPoints(stations: readonly ApiStation[]) {
  return {
    type: 'FeatureCollection' as const,
    features: stations.flatMap((st) =>
      st.lon === null || st.lat === null
        ? []
        : [
            {
              type: 'Feature' as const,
              properties: { id: st.id },
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
/** A station with a forecast at t: a ring. */
const ring: ExpressionSpecification = ['all', state('forecast'), state('has')];

/** Adds the source and the layer, or only replaces the points when they exist. */
export function showStations(map: MapLibreMap, stations: readonly ApiStation[]): void {
  const existing = map.getSource<GeoJSONSource>(SOURCE);
  if (existing !== undefined) {
    existing.setData(stationPoints(stations));
    return;
  }
  map.addSource(SOURCE, { type: 'geojson', data: stationPoints(stations), promoteId: 'id' });
  map.addLayer({
    id: SOURCE,
    type: 'circle',
    source: SOURCE,
    paint: {
      'circle-radius': ['case', state('selected'), 9, state('has'), 6, 4],
      // BrBG teal (A§10, colour-blind safe): dark = a value at t, light = only an older value; white = none.
      // After now: no fill and a teal ring = a forecast, grey = none (#767676 is 4.5:1 on white).
      'circle-color': [
        'case',
        state('forecast'),
        '#767676',
        state('has'),
        ['case', state('stale'), '#5ab4ac', '#01665e'],
        '#ffffff',
      ],
      'circle-opacity': ['case', ring, 0, 1],
      'circle-stroke-color': ['case', state('selected'), '#000000', ring, '#01665e', '#525252'],
      'circle-stroke-width': ['case', state('selected'), 3, ['all', ring, state('estimate')], 2, ring, 3, 1.5],
      // A fainter ring still has 3:1 against white (teal at 65 %); the selection ring never fades.
      'circle-stroke-opacity': ['case', state('selected'), 1, ['all', ring, state('estimate')], 0.65, 1],
    },
  });
}
