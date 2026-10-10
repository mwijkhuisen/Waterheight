import type { ExpressionSpecification, FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';

// The river lines (P10a T4, C7): one vector layer `rivers` from the installed `rivers-<ver>.pmtiles`, beneath the
// warnings and the stations. No `attribution` on the source (C9: the control shows the style's constant only).
// #112: an archive may also hold `reach_bins` (the position bins of the reach colouring); the source promotes `seg`
// there, and an archive without the layer simply has none.

export const RIVERS = 'rivers';
export const RIVERS_HIGHLIGHT = 'rivers-highlight';
const FILE = /^rivers-[0-9]{8}\.pmtiles$/;

/** The pmtiles URL of the installed file, or undefined for a name that is not `rivers-YYYYMMDD.pmtiles`. */
export const riverUrl = (origin: string, file: string): string | undefined =>
  FILE.test(file) ? `pmtiles://${origin}/tiles/${file}` : undefined;

/** The highlight filter: the tile property `river_id` (tools/geo/rivernet/outputs.ts) equals the chosen id. */
export const riverFilter = (id: string): FilterSpecification => ['==', ['get', 'river_id'], id];

// P11b: where a reach has a paint (feature-state `k`, written by flow/reaches/reachLayer) the reach layers draw the
// line, so the base blue steps aside: it would show through the grey dashes and tint the colours. Without a paint it
// stays as before.
const BASE_OPACITY: ExpressionSpecification = ['case', ['==', ['feature-state', 'k'], null], 0.7, 0];

const width = (scale: number): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['zoom'],
  4,
  0.6 * scale,
  8,
  1.5 * scale,
  12,
  3 * scale,
];

/** Adds the source and both layers once (before `beforeId` when it exists); a missing or odd name adds nothing. */
export function showRivers(map: MapLibreMap, origin: string, file: string | undefined, beforeId: string): void {
  const url = file === undefined ? undefined : riverUrl(origin, file);
  if (url === undefined || map.getSource(RIVERS) !== undefined) return;
  map.addSource(RIVERS, { type: 'vector', url, promoteId: { rivers: 'reach_id', reach_bins: 'seg' } });
  const before = map.getLayer(beforeId) === undefined ? undefined : beforeId;
  map.addLayer(
    {
      id: RIVERS,
      type: 'line',
      source: RIVERS,
      'source-layer': 'rivers',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#2b6f9e', 'line-opacity': BASE_OPACITY, 'line-width': width(1) },
    },
    before,
  );
  map.addLayer(
    {
      id: RIVERS_HIGHLIGHT,
      type: 'line',
      source: RIVERS,
      'source-layer': 'rivers',
      filter: riverFilter(''),
      paint: { 'line-color': '#0b2a66', 'line-width': width(2.2) },
    },
    before,
  );
}

/** Highlights `?river=` (none: a filter that matches no id). */
export function highlightRiver(map: MapLibreMap, id: string | undefined): void {
  if (map.getLayer(RIVERS_HIGHLIGHT) !== undefined) map.setFilter(RIVERS_HIGHLIGHT, riverFilter(id ?? ''));
}

/**
 * Whether the installed archive has the `reach_bins` layer (#112): an archive of before #112 has `rivers` only, and
 * the reach colouring then paints per reach at every zoom. Reads the archive's metadata once, same origin, and takes
 * only the ids of its `vector_layers`, never its credit text (MapLibre's protocol keeps `metadata: false`, invariant
 * 3). pmtiles loads here on demand, so it stays out of the initial chunk. A missing or odd name, or any failure: false.
 */
export async function hasReachBins(origin: string, file: string | undefined): Promise<boolean> {
  const url = file === undefined ? undefined : riverUrl(origin, file);
  if (url === undefined) return false;
  try {
    const { PMTiles } = await import('pmtiles');
    const meta = (await new PMTiles(url.slice('pmtiles://'.length)).getMetadata()) as {
      vector_layers?: unknown;
    } | null;
    const layers = meta?.vector_layers;
    return Array.isArray(layers) && layers.some((l) => typeof l === 'object' && l !== null && l.id === 'reach_bins');
  } catch {
    return false;
  }
}
