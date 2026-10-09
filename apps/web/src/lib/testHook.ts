import type { Map as MapLibreMap } from 'maplibre-gl';

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
