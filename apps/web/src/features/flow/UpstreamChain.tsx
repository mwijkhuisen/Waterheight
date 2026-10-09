import type { ApiStation, Snapshot } from '@rws/contracts';
import type { StationState } from '../../lib/stationStates.ts';
import type { Locale } from '../../paraglide/runtime.js';

// "Stroomopwaarts / Upstream" (P11a, issue #26): the upstream chain of the open station in its panel, after the
// nearby stations. A lazy chunk of StationPanel. It reads the graph, the rivers and the travel times itself
// (useReachGraph, useRivers, useReachTravel). STUB (L0): W1 implements it.

export interface UpstreamChainProps {
  locale: Locale;
  station: ApiStation;
  /** Every station of the site (stations.json, audience-filtered): names, series and the `known` set. */
  stations: readonly ApiStation[];
  /** The feature-state record of every station at t. */
  states: ReadonlyMap<string, StationState>;
  values: ReadonlyMap<number, Snapshot['values'][number]>;
  /** Owner-audience source ids (empty on the public site). */
  ownerSources: ReadonlySet<string>;
  /** Open another station. */
  onSelect: (id: string) => void;
}

export function UpstreamChain(props: UpstreamChainProps) {
  void props;
  return null;
}
