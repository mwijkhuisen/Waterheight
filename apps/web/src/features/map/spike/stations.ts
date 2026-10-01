import type { Map as MapLibreMap } from 'maplibre-gl';

// 200 fixture stations for the spike: a seeded pseudo-random spread over the
// Lobith fixture's bbox, drawn as one `circle` layer whose colour comes only
// from feature-state (the P4+ pattern: data changes never rebuild the source).

export const STATION_COUNT = 200;
const BBOX = [6.04, 51.82, 6.16, 51.88] as const;
// Five levels, colour-blind safe (BrBG, A§10): low → high.
const LEVEL_COLOURS = ['#8c510a', '#d8b365', '#c7c7c7', '#5ab4ac', '#01665e'] as const;

/** mulberry32: deterministic, so every run and every browser draws the same stations. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stationFeatures() {
  const next = random(18);
  const [w, s, e, n] = BBOX;
  return {
    type: 'FeatureCollection' as const,
    features: Array.from({ length: STATION_COUNT }, (_, id) => ({
      type: 'Feature' as const,
      id,
      properties: {},
      geometry: { type: 'Point' as const, coordinates: [w + next() * (e - w), s + next() * (n - s)] },
    })),
  };
}

/** Adds the stations and sets every station's level through feature-state; returns how many were set. */
export function addStations(map: MapLibreMap): number {
  map.addSource('stations', { type: 'geojson', data: stationFeatures() });
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': 5,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#202020',
      'circle-color': [
        'match',
        ['coalesce', ['feature-state', 'level'], -1],
        0,
        LEVEL_COLOURS[0],
        1,
        LEVEL_COLOURS[1],
        2,
        LEVEL_COLOURS[2],
        3,
        LEVEL_COLOURS[3],
        4,
        LEVEL_COLOURS[4],
        '#ff00ff',
      ],
    },
  });
  for (let id = 0; id < STATION_COUNT; id++) map.setFeatureState({ source: 'stations', id }, { level: id % 5 });
  return STATION_COUNT;
}
