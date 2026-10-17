import type { ExpressionSpecification, FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { createFlowAnimation, DASH_SEQ, type FlowHost } from './animation.ts';

// The flow direction on the river lines (P11a, issue #26): dash layers over the non-tidal reaches of the `rivers`
// source, stepped by the animation clock, and a static arrow layer `rivers-flow-arrows` shown while the clock is
// stopped (reduced motion, a hidden tab, the pause control off). A lazy chunk: StationsMap imports it once the river
// layer exists. The tile lines run in the flow direction (the reaches run up to down).

const FLOW = 'rivers-flow';
// One dash layer per step of DASH_SEQ (`rivers-flow`, `rivers-flow-1`, …), each with its own fixed pattern; a step only
// moves `line-opacity` from one to the next (#177). Setting `line-dasharray` instead, a cross-faded property, makes
// MapLibre 6 reload every tile of the source on each step; a constant opacity is a plain paint change, a line layer
// at opacity 0 is not drawn, and the layers share one layout (same source, filter and layout), so the tiles are laid
// out once.
const PHASES = DASH_SEQ.map((_, i) => (i === 0 ? FLOW : `${FLOW}-${i}`));
const OPACITY = 0.9;
const ARROWS = 'rivers-flow-arrows';
const ARROW = 'flow-arrow';
const SOURCE = 'rivers';

// P6's per-reach tidal flag rides on every tile line (outputs.ts `lineFeatures`): tidal reaches have no one-way flow
// to show, and a line without a `reach_id` is not a reach of the release.
const FILTER: FilterSpecification = ['all', ['has', 'reach_id'], ['!=', ['get', 'tidal'], true]];

// The width of the blue river line (features/map/rivers.ts), so that the dashes sit on it.
const WIDTH: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 4, 0.6, 8, 1.5, 12, 3];

export interface FlowHandle {
  /** The pause control (FlowToggle). */
  setEnabled(on: boolean): void;
  /** Stops the clock, removes its listeners and every flow layer. */
  dispose(): void;
}

/** The arrow icon, drawn at run time into RGBA (no file, no request, no data: or blob: URL): white, dark outline, pointing along +x (the line's direction). */
export function arrowIcon(): { width: number; height: number; data: Uint8ClampedArray } {
  const width = 16;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  // A chevron-less triangle: apex at the right middle, base at the left; `inset` shrinks it for the white fill.
  const inside = (x: number, y: number, inset: number) => {
    const px = x + 0.5 - 1 - inset;
    const half = height / 2 - 1 - inset;
    const run = width - 2 - 2 * inset;
    return px >= 0 && px <= run && Math.abs(y + 0.5 - height / 2) <= half * (1 - px / run);
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rgba = inside(x, y, 2) ? [255, 255, 255, 255] : inside(x, y, 0) ? [11, 42, 102, 255] : null;
      if (rgba) data.set(rgba, (y * width + x) * 4);
    }
  return { width, height, data };
}

/** Adds both layers before `beforeId` (when it exists) and starts the clock when `enabled`. */
export function addFlow(map: MapLibreMap, beforeId: string, enabled: boolean): FlowHandle {
  const before = map.getLayer(beforeId) === undefined ? undefined : beforeId;
  if (!map.hasImage(ARROW)) map.addImage(ARROW, arrowIcon(), { pixelRatio: 1 });
  for (const [i, id] of PHASES.entries())
    map.addLayer(
      {
        id,
        type: 'line',
        source: SOURCE,
        'source-layer': 'rivers',
        filter: FILTER,
        layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-color': '#e6f3fb',
          'line-opacity': i === 0 ? OPACITY : 0,
          // A step is a hard cut: no blend between two patterns.
          'line-opacity-transition': { duration: 0, delay: 0 },
          'line-width': WIDTH,
          'line-dasharray': [...(DASH_SEQ[i] as readonly number[])],
        },
      },
      before,
    );
  map.addLayer(
    {
      id: ARROWS,
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'rivers',
      filter: FILTER,
      minzoom: 7,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 120,
        'icon-image': ARROW,
        'icon-size': 0.9,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        visibility: 'none',
      },
    },
    before,
  );

  const show = (id: string, visible: boolean) => {
    if (map.getLayer(id) !== undefined) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let shown = 0;
  const host: FlowHost = {
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
    now: () => performance.now(),
    reducedMotion: {
      matches: () => reduced.matches,
      onChange(cb) {
        reduced.addEventListener('change', cb);
        return () => reduced.removeEventListener('change', cb);
      },
    },
    visibility: {
      hidden: () => document.visibilityState === 'hidden',
      onChange(cb) {
        document.addEventListener('visibilitychange', cb);
        return () => document.removeEventListener('visibilitychange', cb);
      },
    },
    onTick(step) {
      if (step !== shown && map.getLayer(FLOW) !== undefined) {
        map.setPaintProperty(PHASES[shown] as string, 'line-opacity', 0);
        map.setPaintProperty(PHASES[step] as string, 'line-opacity', OPACITY);
        shown = step;
      }
      // The e2e build counts the steps (apps/web/e2e); the production bundle holds no trace of this.
      if (import.meta.env.MODE === 'e2e') window.__rwsFlowFrames = (window.__rwsFlowFrames ?? 0) + 1;
    },
    onRunning(running) {
      for (const id of PHASES) show(id, running);
      show(ARROWS, !running);
    },
  };
  const animation = createFlowAnimation(host, enabled);
  return {
    setEnabled: (on) => animation.setEnabled(on),
    dispose() {
      animation.dispose();
      // StationsMap disposes on unmount, which may run after map.remove(): a removed map has no style to ask.
      try {
        for (const id of [ARROWS, ...PHASES]) if (map.getLayer(id) !== undefined) map.removeLayer(id);
      } catch {
        // the map is already gone, and its layers with it
      }
    },
  };
}
