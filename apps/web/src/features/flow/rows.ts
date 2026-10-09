import type { ApiStation, Snapshot } from '@rws/contracts';
import type { WebRiver } from '../../lib/data/chain.ts';
import type { ReachTravelData } from '../../lib/data/contracts.ts';
import type { StationState } from '../../lib/stationStates.ts';
import type { Locale } from '../../paraglide/runtime.js';
import type { ChainNode } from './chain.ts';

// The texts of the upstream chain's rows (P11a, issue #26): the name as published, the river, the state word and its
// basis, the section and owner flags, the travel time to the target (only the exact sourced pair, through the one
// formatter lib/travel.ts) with its basis and source. Every string is a React text node (invariant 3). Pure.
// STUB (L0): W1 implements it.

type Value = Snapshot['values'][number];

export interface ChainContext {
  locale: Locale;
  /** The station whose chain this is. */
  targetId: string;
  /** The site's stations by id (stations.json, audience-filtered). */
  stations: ReadonlyMap<string, ApiStation>;
  /** The release's rivers by id (names, parent river). */
  rivers: ReadonlyMap<string, WebRiver>;
  /** The feature-state record of every station at t (App: stationStates). */
  states: ReadonlyMap<string, StationState>;
  /** The values at t by series (the basis of a state). */
  values: ReadonlyMap<number, Value>;
  /** Owner-audience source ids (empty on the public site). */
  ownerSources: ReadonlySet<string>;
  /** The release's sourced travel times. */
  travel: ReachTravelData;
}

export interface StationRow {
  kind: 'station';
  key: string;
  /** The id a click opens. */
  id: string;
  name: string;
  river: string;
  /** "Verhoogd" etc.; null without a value at t. */
  state: string | null;
  /** The basis kind and label ("Operationele grens: …"); null without one. NL-4 is a basis, never a warning. */
  basis: string | null;
  section: boolean;
  owner: boolean;
  /** The travel text (always "indicatief"/"indicative") or the "no sourced value" text. */
  travel: string;
  /** The pair's basis or condition; null without a sourced pair. */
  travelBasis: string | null;
  /** The pair's source as published; null without a sourced pair. */
  source: string | null;
  /** The source's link when it is an https URL (httpsHref), else undefined. */
  href: string | undefined;
}

export interface GroupRow {
  kind: 'group';
  key: string;
  /** The summary: the tributary's name and its station count. */
  summary: string;
  children: readonly ChainRow[];
}

export interface GapRow {
  kind: 'gap';
  key: string;
  /** "{km} km {river} zonder meetpunt" / "… without a station". */
  text: string;
}

export type ChainRow = StationRow | GroupRow | GapRow;

export function chainRows(nodes: readonly ChainNode[], ctx: ChainContext): ChainRow[] {
  void nodes;
  void ctx;
  return [];
}
