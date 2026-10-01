import type { ApiStation, Snapshot } from '@rws/contracts';
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

// The stations as one `circle` layer whose look comes only from feature-state
// (the P3 pattern: a new `t` never rebuilds the source). No class colours before
// P7: a filled marker has a value at t, a lighter one only an old value (carried
// forward), a hollow one none; the selected one is larger with a dark ring.

export const SOURCE = 'stations';

export interface MarkerState {
  has: boolean;
  stale: boolean;
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

const state = (key: string): ExpressionSpecification => ['boolean', ['feature-state', key], false];

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
      'circle-color': ['case', state('has'), ['case', state('stale'), '#5ab4ac', '#01665e'], '#ffffff'],
      'circle-stroke-color': ['case', state('selected'), '#000000', '#525252'],
      'circle-stroke-width': ['case', state('selected'), 3, 1.5],
    },
  });
}
