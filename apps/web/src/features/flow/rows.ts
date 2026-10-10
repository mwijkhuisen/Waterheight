import type { ApiStation } from '@rws/contracts';
import type { WebRiver } from '../../lib/data/chain.ts';
import type { ReachTravelData } from '../../lib/data/contracts.ts';
import type { PlayedValue } from '../../lib/data/frames.ts';
import { httpsHref } from '../../lib/href.ts';
import { riverName } from '../../lib/labels/labels.ts';
import type { StationState } from '../../lib/stationStates.ts';
import { travelPriorOf, travelText } from '../../lib/travel.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { LADDER, levelOf } from '../legend/palette.ts';
import { basisKind, stateWord } from '../station/state.ts';
import { formatNumber } from '../station/value.ts';
import type { ChainNode } from './chain.ts';

// The texts of the upstream chain's rows (P11a, issue #26): the name as published, the river, the state word and its
// basis, the section and owner flags, the travel time to the target (only the exact sourced pair, through the one
// formatter lib/travel.ts) with its basis and source. Every string is a React text node (invariant 3). Pure.

type Value = PlayedValue;

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
  /** The target and the stations co-located with it (a pair may name any of them); default: the target alone. */
  targetIds?: readonly string[];
  /** P11b: the values are played-back hourly frames (the state of the hour, no basis or class; #112). */
  played?: boolean;
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

/** The river as the page names it: our label, else the release's own name, else the id. */
function riverText(id: string, ctx: ChainContext): string {
  const r = ctx.rivers.get(id);
  return riverName(id, ctx.locale) ?? (r === undefined ? id : ctx.locale === 'nl' ? r.name_nl : r.name_en);
}

/** The state of a row at t: the highest among its stations' values, with that value's basis. */
function stateOf(ids: readonly string[], ctx: ChainContext): Pick<StationRow, 'state' | 'basis' | 'section'> {
  const none = { state: null, basis: null, section: false };
  // Frames carry the state of the hour (#112) but no basis; a version 1 frame's state is unknown: no data.
  const played = ctx.played === true;
  const recs = ids.flatMap((id) => ctx.states.get(id) ?? []);
  // After now the record holds a forecast's state, and no value of t carries a basis.
  if (!played && recs.some((r) => r.forecast)) {
    const top = recs.reduce((a, r) => (r.has && r.level > a ? r.level : a), -1);
    const state = LADDER[top];
    return state === undefined ? none : { state: stateWord(state, ctx.locale), basis: null, section: false };
  }
  let best: Value | undefined;
  for (const id of ids)
    for (const s of ctx.stations.get(id)?.series ?? []) {
      const v = ctx.values.get(s.id);
      if (v === undefined) continue;
      const level = levelOf(v.state);
      // At an equal level a known state beats an unknown one (a played v1 value: its no_ref is a placeholder).
      if (
        best === undefined ||
        level > levelOf(best.state) ||
        (level === levelOf(best.state) && best.stateUnknown === true && v.stateUnknown !== true)
      )
        best = v;
    }
  if (best === undefined) return none;
  if (played)
    return best.stateUnknown === true
      ? { state: m.reach_nodata({}, { locale: ctx.locale }), basis: null, section: false }
      : { state: stateWord(best.state, ctx.locale), basis: null, section: best.section && levelOf(best.state) > 0 };
  return {
    state: stateWord(best.state, ctx.locale),
    // NL-4 is a basis ("not an official warning"), never a warning of ours: basisKind words it so.
    basis: best.basis === null ? null : `${basisKind(best.basis, ctx.locale)}: ${best.basis.label}`,
    section: best.section && levelOf(best.state) > 0,
  };
}

function stationRow(n: Extract<ChainNode, { kind: 'station' }>, ctx: ChainContext): StationRow {
  const id = n.ids[0] ?? '';
  // Only the exact pair row -> target of the file: no sum of two pairs and no scaling (owner decision D-A).
  const targets = ctx.targetIds ?? [ctx.targetId];
  const pair = ctx.travel.travel_times.find(
    (t) => targets.includes(t.to_station_id) && n.ids.includes(t.from_station_id),
  );
  const text = pair === undefined ? null : travelText(travelPriorOf(pair), ctx.locale);
  const sourced = pair !== undefined && text !== null;
  return {
    kind: 'station',
    key: n.ids.join('+'),
    id,
    name: ctx.stations.get(id)?.name ?? id,
    river: riverText(n.riverId, ctx),
    ...stateOf(n.ids, ctx),
    owner: n.ids.some((i) => ctx.stations.get(i)?.series.some((s) => ctx.ownerSources.has(s.source))),
    travel: text ?? m.travel_no_source({}, { locale: ctx.locale }),
    travelBasis: sourced ? pair.basis : null,
    source: sourced ? pair.source : null,
    href: sourced ? httpsHref(pair.source_url) : undefined,
  };
}

export function chainRows(nodes: readonly ChainNode[], ctx: ChainContext, path = ''): ChainRow[] {
  return nodes.map((n, i): ChainRow => {
    const key = `${path}/${i}`;
    if (n.kind === 'station') return stationRow(n, ctx);
    const river = riverText(n.riverId, ctx);
    if (n.kind === 'gap')
      return {
        kind: 'gap',
        key,
        text: m.chain_gap({ km: formatNumber(Math.round(n.km), ctx.locale), river }, { locale: ctx.locale }),
      };
    return {
      kind: 'group',
      key,
      summary: (n.sameRiver ? m.chain_branch : m.chain_group)(
        { river, count: formatNumber(n.count, ctx.locale) },
        { locale: ctx.locale },
      ),
      children: chainRows(n.children, ctx, key),
    };
  });
}
