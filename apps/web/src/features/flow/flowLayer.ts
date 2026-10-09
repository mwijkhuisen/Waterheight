import type { Map as MapLibreMap } from 'maplibre-gl';

// The flow direction on the river lines (P11a, issue #26): a dash layer `rivers-flow` over the non-tidal reaches of
// the `rivers` source, stepped by the animation clock, and a static arrow layer `rivers-flow-arrows` shown while the
// clock is stopped (reduced motion, a hidden tab, the pause control off). A lazy chunk: StationsMap imports it once
// the river layer exists. STUB (L0): W2 implements it.

export interface FlowHandle {
  /** The pause control (FlowToggle). */
  setEnabled(on: boolean): void;
  /** Stops the clock, removes its listeners and both layers. */
  dispose(): void;
}

/** Adds both layers before `beforeId` (when it exists) and starts the clock when `enabled`. */
export function addFlow(map: MapLibreMap, beforeId: string, enabled: boolean): FlowHandle {
  void map;
  void beforeId;
  void enabled;
  return { setEnabled: () => {}, dispose: () => {} };
}
