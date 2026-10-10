import type { ApiStation, Snapshot } from '@rws/contracts';
import type { ExpressionSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import type { Change } from '../../../lib/data/change.ts';
import type { ReachGraph } from '../../../lib/data/contracts.ts';
import type { Mode } from '../../../lib/url/url.ts';
import { REACH_CASING_COLOUR, REACH_IMPOUNDED_COLOUR, REACH_NODATA_COLOUR } from '../../legend/palette.ts';
import { reachHatchIcon } from '../../map/icons.ts';
import { BIN_MINZOOM, BINS_LAYER } from './bins.ts';
import { binPaints, type ReachPaint, reachPaints, type Shift } from './colour.ts';
import { type FeatureSpan, spansOf } from './spans.ts';

// The reach colouring on the map (P11b, issue #26): four line layers over the `rivers` source (promoteId
// `reach_id`): `rivers-reach` (the interpolated colour), `rivers-reach-nodata` (grey, dashed), `rivers-reach-impounded`
// (neutral) and `rivers-reach-tidal` (a hatch pattern on the tile's `tidal` flag, static). Each reach's paint is
// feature-state `{k, c, w}`, written only for the reaches whose paint changed. A lazy chunk, loaded with the flow
// layer once the river layer exists (StationsMap). No HTML, no provider text.
// #112: when the installed archive has the `reach_bins` layer (`bins` resolves true), the same five layers are drawn
// from it from zoom BIN_MINZOOM on (`-bin` ids, butt caps so adjacent bins never overlap), each bin painted at its own
// position on its span, and the per-reach layers keep the zooms below; an archive without it keeps today's colouring.

type Value = Snapshot['values'][number];

/** What the paints are computed from; the spans are cached per graph and set of known stations. */
export interface ReachInput {
  /** The site's reaches file graph (the public file, or the owner variant on the owner site). */
  graph: ReachGraph;
  mode: Mode;
  /** Every station of the site's stations.json (hidden ones included: they still end a span). */
  stations: readonly ApiStation[];
  values: ReadonlyMap<number, Value>;
  changes: ReadonlyMap<number, Change> | undefined;
  /** #112: the travel-time shift of the spans a sourced travel time names exactly; none: unshifted. */
  shift?: Shift | undefined;
}

export interface ReachHandle {
  /** Recomputes the paints and writes the feature-states that changed. */
  update(input: ReachInput): void;
  /** Removes the layers and the hatch image. */
  dispose(): void;
}

const SOURCE = 'rivers';
const SOURCE_LAYER = 'rivers';
export const REACH_CASING = 'rivers-reach-casing';
export const REACH = 'rivers-reach';
export const REACH_NODATA = 'rivers-reach-nodata';
export const REACH_IMPOUNDED = 'rivers-reach-impounded';
export const REACH_TIDAL = 'rivers-reach-tidal';
export const REACH_HATCH = 'reach-hatch';

/** Zoom at the top (MapLibre accepts feature-state only inside the stops); `w` multiplies the stop's base width. */
const coloured = (base: readonly [number, number, number]): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['zoom'],
  4,
  ['*', base[0], ['coalesce', ['feature-state', 'w'], 1]],
  8,
  ['*', base[1], ['coalesce', ['feature-state', 'w'], 1]],
  12,
  ['*', base[2], ['coalesce', ['feature-state', 'w'], 1]],
];
/** The casing: the coloured width plus a fixed edge, so a near-white colour (steady, normal) reads on a light map. */
const cased = (base: readonly [number, number, number]): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['zoom'],
  4,
  ['+', ['*', base[0], ['coalesce', ['feature-state', 'w'], 1]], 1.6],
  8,
  ['+', ['*', base[1], ['coalesce', ['feature-state', 'w'], 1]], 1.6],
  12,
  ['+', ['*', base[2], ['coalesce', ['feature-state', 'w'], 1]], 1.6],
];
const kindIs = (k: string): ExpressionSpecification => ['case', ['==', ['feature-state', 'k'], k], 1, 0];
const WIDTH: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 2.4, 12, 4.8];
const THIN: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 4, 0.9, 8, 2, 12, 4];

/** The five layers, bottom to top (pure; the test validates them against the style spec). */
export const reachLayers = (): LayerSpecification[] => [
  {
    id: REACH_CASING,
    type: 'line',
    source: SOURCE,
    'source-layer': SOURCE_LAYER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': REACH_CASING_COLOUR, 'line-opacity': kindIs('v'), 'line-width': cased([1, 2.4, 4.8]) },
  },
  {
    id: REACH,
    type: 'line',
    source: SOURCE,
    'source-layer': SOURCE_LAYER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['to-color', ['coalesce', ['feature-state', 'c'], '#0000']],
      'line-opacity': kindIs('v'),
      'line-width': coloured([1, 2.4, 4.8]),
    },
  },
  {
    id: REACH_NODATA,
    type: 'line',
    source: SOURCE,
    'source-layer': SOURCE_LAYER,
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': REACH_NODATA_COLOUR,
      'line-opacity': kindIs('nodata'),
      'line-width': THIN,
      'line-dasharray': [2, 2],
    },
  },
  {
    id: REACH_IMPOUNDED,
    type: 'line',
    source: SOURCE,
    'source-layer': SOURCE_LAYER,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': REACH_IMPOUNDED_COLOUR, 'line-opacity': kindIs('impounded'), 'line-width': WIDTH },
  },
  {
    // Static on the tile's flag: a tidal reach is never interpolated, so it needs no state. >= 3 px so the stripes read.
    id: REACH_TIDAL,
    type: 'line',
    source: SOURCE,
    'source-layer': SOURCE_LAYER,
    filter: ['==', ['get', 'tidal'], true],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-pattern': REACH_HATCH, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3, 8, 3.5, 12, 5] },
  },
];

/** The bin copies of the five layers (#112): source-layer `reach_bins`, from BIN_MINZOOM, butt caps. */
export const binLayers = (): LayerSpecification[] =>
  reachLayers().map((l) => {
    const line = l as Extract<LayerSpecification, { type: 'line' }>;
    return {
      ...line,
      id: `${line.id}-bin`,
      'source-layer': BINS_LAYER,
      minzoom: BIN_MINZOOM,
      layout: { ...line.layout, 'line-cap': 'butt' },
    };
  });

const stateOf = (p: ReachPaint) => (p.k === 'v' ? { k: 'v', c: p.colour, w: p.width } : { k: p.k, c: '#0000', w: 1 });

interface Spans {
  graph: ReachGraph;
  by: Map<string, ApiStation>;
  out: Map<string, FeatureSpan>;
}

/** Writes the feature-states of `paints` whose key changed against `written` and removes the gone ones. */
function write(
  map: MapLibreMap,
  sourceLayer: string,
  paints: ReadonlyMap<string, ReachPaint>,
  written: ReadonlyMap<string, string>,
): Map<string, string> {
  const target = (id: string) => ({ source: SOURCE, sourceLayer, id });
  const next = new Map<string, string>();
  for (const [id, paint] of paints) {
    const st = stateOf(paint);
    const key = `${st.k}|${st.c}|${st.w}`;
    next.set(id, key);
    if (written.get(id) !== key) map.setFeatureState(target(id), st);
  }
  for (const id of written.keys()) if (!next.has(id)) map.removeFeatureState(target(id));
  return next;
}

/**
 * Adds the five layers before `beforeId` (when it exists); once `bins` resolves true (the archive has `reach_bins`),
 * their bin copies too, the per-reach ones limited to the zooms below BIN_MINZOOM.
 */
export function addReaches(
  map: MapLibreMap,
  beforeId: string,
  bins: Promise<boolean> = Promise.resolve(false),
): ReachHandle {
  const before = map.getLayer(beforeId) === undefined ? undefined : beforeId;
  if (!map.hasImage(REACH_HATCH)) map.addImage(REACH_HATCH, reachHatchIcon(), { pixelRatio: 1 });
  for (const layer of reachLayers()) map.addLayer(layer, before);

  let disposed = false;
  let spans: Spans | undefined;
  let written = new Map<string, string>();
  let binsOn = false;
  let writtenBins = new Map<string, string>();
  let last: ReachInput | undefined;

  const handle: ReachHandle = {
    update(input) {
      last = input;
      if (disposed || map.getSource(SOURCE) === undefined) return;
      // The spans depend on the graph and the set of station ids only; the lookup keeps the newest station objects.
      const same =
        spans !== undefined &&
        spans.graph === input.graph &&
        spans.by.size === input.stations.length &&
        input.stations.every((s) => spans?.by.has(s.id));
      if (spans === undefined || !same) {
        const by = new Map(input.stations.map((s) => [s.id, s]));
        spans = { graph: input.graph, by, out: spansOf(input.graph, new Set(by.keys())) };
      } else for (const s of input.stations) spans.by.set(s.id, s);
      // With bins the per-reach layers are drawn below BIN_MINZOOM and the bins from it on: each set is written only
      // near its zooms (thousands of writes an hour of playback for nothing otherwise), and a zoom across catches up
      // (`onZoom`).
      const zoom = map.getZoom();
      if (!binsOn || zoom < BIN_MINZOOM + 0.5)
        written = write(
          map,
          SOURCE_LAYER,
          reachPaints(spans.out, input.mode, input.values, input.changes, spans.by, input.shift),
          written,
        );
      if (binsOn && zoom >= BIN_MINZOOM - 0.5)
        writtenBins = write(
          map,
          BINS_LAYER,
          binPaints(spans.out, input.mode, input.values, input.changes, spans.by, input.shift),
          writtenBins,
        );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      map.off('zoomend', onZoom);
      // StationsMap disposes on unmount, which may run after map.remove(): a removed map has no style to ask.
      try {
        for (const l of [...binLayers(), ...reachLayers()]) if (map.getLayer(l.id) !== undefined) map.removeLayer(l.id);
        if (map.hasImage(REACH_HATCH)) map.removeImage(REACH_HATCH);
      } catch {
        // the map is already gone, and its layers with it
      }
    },
  };
  function onZoom() {
    if (last !== undefined) handle.update(last);
  }
  // The archive's layers are known a moment later (a metadata read): until then, and for an archive without bins,
  // the per-reach layers paint at every zoom.
  void bins.then((has) => {
    if (!has || disposed || map.getSource(SOURCE) === undefined) return;
    try {
      for (const layer of binLayers()) map.addLayer(layer, before);
      for (const l of reachLayers()) map.setLayerZoomRange(l.id, 0, BIN_MINZOOM);
      binsOn = true;
      map.on('zoomend', onZoom);
      if (last !== undefined) handle.update(last);
    } catch {
      // the map went away meanwhile
    }
  });
  return handle;
}
