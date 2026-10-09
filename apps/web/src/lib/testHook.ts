import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Cell } from '../features/flow/hovmoller/grid.ts';
import type { HovPathId } from './url/url.ts';

/** What the Playwright tests read from the page (apps/web/e2e). */
export interface RwsHook {
  map?: MapLibreMap | null;
  /** The live ECharts instances of the station panel. */
  charts?: Set<{ getOption(): unknown }>;
}

declare global {
  interface Window {
    __rws?: RwsHook;
    /** P11a: the flow ticks so far, counted in the e2e build only (features/flow/flowLayer.ts). */
    __rwsFlowFrames?: number;
    /** P11a: set by a spec before the page loads to start the e2e build with the flow animation on (App.tsx). */
    __rwsFlow?: boolean;
    /** P11b: set by a spec before the page loads to hold playback on its first hour (frames on screen, no tick). */
    __rwsPlayHold?: boolean;
    /**
     * P11c: the "Langs de rivier" panel's columns, rows and cells, e2e build only (hovmoller/HovmollerPanel.tsx). Not in
     * `__rws.charts`: the station panels' idle check counts those against `aside div[role="img"]`.
     */
    __rwsHov?:
      | {
          /** The ECharts instance; null until the chart chunk has loaded (and in the table view). */
          chart: { getOption(): unknown } | null;
          path: HovPathId;
          columns: readonly { id: string; x: number }[];
          /** ISO UTC of each row hour, ascending. */
          rows: readonly string[];
          cellAt(id: string, iso: string): Cell | undefined;
          /** Viewport (client) pixels of the cell centre. */
          pixelOf(id: string, iso: string): [number, number] | undefined;
        }
      | undefined;
  }
}

function install(): RwsHook {
  const hook: RwsHook = { map: null, charts: new Set() };
  window.__rws = hook;
  return hook;
}

/**
 * The test hook exists only in the e2e build (`vite build --mode e2e`, never
 * deployed): the condition is a build-time constant, so the production bundle
 * holds no trace of it (apps/web/test/build.test.ts).
 */
export const testHook: RwsHook | undefined = import.meta.env.MODE === 'e2e' ? install() : undefined;
