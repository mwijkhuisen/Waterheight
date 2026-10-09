import type { WebRiver } from '../../lib/data/chain.ts';
import type { ReachGraph } from '../../lib/data/contracts.ts';
import { coLocated, type GReach, type GStation, type Index, indexOf, upstreamStarts } from '../station/neighbours.ts';

// The upstream chain of a station (P11a, issue #26 C3): every station upstream of it, in walk order, on the graph of
// reaches-<ver>.json (public, or the owner variant on the owner site). Audience-agnostic: `known` (the station ids
// of the site's stations.json) decides which rows exist. Pure. The walk is the one of neighbours.ts (same index,
// same co-location and sink rules); here it keeps going, and a confluence becomes a collapsed tributary group.

export type ChainNode =
  /** A row: co-located stations share one (`ids`, the first is the one the file names); `distKm` is upstream of the target. */
  | { kind: 'station'; ids: readonly string[]; riverId: string; distKm: number }
  /**
   * A tributary collapsed at its confluence with the main stem; `count` station rows inside, recursively. `sameRiver`:
   * an arm of the river it joins (a source branch), not a tributary.
   */
  | { kind: 'group'; riverId: string; children: readonly ChainNode[]; count: number; sameRiver?: true }
  /** More than GAP_KM of main stem without a station row. */
  | { kind: 'gap'; riverId: string; km: number };

// ponytail: 120 km. On the fixture the longest stretch between two Rhine rows upstream of Lobith is 104.6 km
// (Lake Constance to Basel) and Eijsden to Chooz on the Meuse is 139.2 km; one number between them. A river with
// sparser gauges than the Rhine shows more gaps, a denser release fewer; per-river ceilings if that ever matters.
export const GAP_KM = 120;
/** A gap shorter than this, cut off by a tributary, is not worth a row. */
const MIN_PIECE_KM = 1;
/** Reaches walked per chain and tributary levels: a cycle or a huge delta ends the walk instead of the tab. */
const REACH_CAP = 20_000;
const GROUP_DEPTH_CAP = 12;

interface Item {
  node: ChainNode;
  /** Km upstream of the target where the item sits (a group: at its confluence). */
  at: number;
  /** The river of the main stem there. */
  river: string;
}

interface Walk {
  ix: Index;
  rivers: ReadonlyMap<string, WebRiver>;
  known: ReadonlySet<string>;
  target: GStation;
  seen: Set<string>;
  budget: number;
  /** Stations by place (reach and chainage) of the graph; built once per call. */
  places: Map<string, GStation[]>;
}

const placeKey = (s: GStation) => `${s.reach_id}|${s.km_graph}`;

const lengthOf = (r: GReach): number =>
  r.length_km ?? (r.km_graph_from !== null && r.km_graph_to !== null ? Math.abs(r.km_graph_to - r.km_graph_from) : 0);

/** The main stem at a confluence: the reach on the same river, else on the river this one flows into, else the first. */
function pickMain(w: Walk, cands: readonly GReach[], river: string): GReach {
  const parent = w.rivers.get(river)?.parent_river_id ?? null;
  return (
    cands.find((c) => c.river_id === river) ??
    (parent === null ? undefined : cands.find((c) => c.river_id === parent)) ??
    (cands[0] as GReach)
  );
}

/** The row of the station a reach starts at: it and its co-located stations that the page knows, the file's one first. */
function rowAt(w: Walk, id: string | null, dist: number): ChainNode | undefined {
  const s = id === null ? undefined : w.ix.stations.get(id);
  if (s === undefined || s.reach_id === null || s.km_graph === null) return undefined;
  const ids = [s, ...(w.places.get(placeKey(s)) ?? []).filter((o) => o !== s)]
    .filter((o) => w.known.has(o.id) && !coLocated(w.target, o))
    .map((o) => o.id);
  return ids.length === 0 ? undefined : { kind: 'station', ids, riverId: s.river_id, distKm: dist };
}

const countRows = (nodes: readonly ChainNode[]): number =>
  nodes.reduce((n, c) => n + (c.kind === 'station' ? 1 : c.kind === 'group' ? c.count : 0), 0);

/**
 * One stem of the walk, upstream from `starts` (reaches that end `d0` km from the target): its rows and the
 * tributaries that join it, in walk order.
 */
function stem(w: Walk, starts: readonly GReach[], d0: number, river: string, depth: number): Item[] {
  const items: Item[] = [];
  let cands = starts;
  let d = d0;
  let cur = river;
  for (;;) {
    cands = cands.filter((c) => !w.seen.has(c.id));
    if (cands.length === 0 || w.budget <= 0) return items;
    const main = pickMain(w, cands, cur);
    if (depth < GROUP_DEPTH_CAP) {
      for (const other of cands) {
        if (other === main || w.seen.has(other.id)) continue;
        const kids = stem(w, [other], d, other.river_id, depth + 1).map((i) => i.node);
        const count = countRows(kids);
        // A tributary that only holds another group (a river arm with no gauge of its own) shows just that group.
        const only = kids.length === 1 && kids[0]?.kind === 'group' ? kids[0] : undefined;
        if (count > 0)
          items.push({
            node: only ?? {
              kind: 'group',
              riverId: other.river_id,
              children: kids,
              count,
              ...(other.river_id === cur ? { sameRiver: true as const } : {}),
            },
            at: d,
            river: cur,
          });
      }
    }
    if (w.seen.has(main.id)) return items;
    w.seen.add(main.id);
    w.budget -= 1;
    d += lengthOf(main);
    cur = main.river_id;
    const row = rowAt(w, main.up_station_id, d);
    if (row !== undefined) items.push({ node: row, at: d, river: cur });
    cands = branches(w, main);
  }
}

const branches = (w: Walk, r: GReach): GReach[] =>
  r.upstream.flatMap((id) => {
    const found = w.ix.reaches.get(id);
    return found === undefined ? [] : [found];
  });

/** Gaps in the main stem: rows more than GAP_KM apart, the tributaries between them splitting the gap in pieces. */
function withGaps(items: readonly Item[]): ChainNode[] {
  const out: ChainNode[] = [];
  let pending: Item[] = [];
  let prev = 0;
  for (const it of items) {
    if (it.node.kind === 'group') {
      pending.push(it);
      continue;
    }
    if (it.at - prev > GAP_KM) {
      let cursor = prev;
      for (const g of [...pending, it]) {
        if (g.at - cursor >= MIN_PIECE_KM) out.push({ kind: 'gap', riverId: g.river, km: g.at - cursor });
        if (g !== it) out.push(g.node);
        cursor = Math.max(cursor, g.at);
      }
    } else {
      out.push(...pending.map((g) => g.node));
    }
    pending = [];
    out.push(it.node);
    prev = it.at;
  }
  out.push(...pending.map((g) => g.node));
  return out;
}

/** The upstream chain of `targetId`, nearest first; empty for a station the file does not place. */
export function chain(
  graph: ReachGraph,
  rivers: readonly WebRiver[],
  targetId: string,
  known: ReadonlySet<string>,
): ChainNode[] {
  const ix = indexOf(graph);
  const target = ix.stations.get(targetId);
  if (target === undefined || target.reach_id === null || target.km_graph === null) return [];
  const own = ix.reaches.get(target.reach_id);
  if (own === undefined) return [];
  const places = new Map<string, GStation[]>();
  for (const s of graph.stations) {
    if (s.reach_id === null || s.km_graph === null) continue;
    const k = placeKey(s);
    places.set(k, [...(places.get(k) ?? []), s]);
  }
  const w: Walk = {
    ix,
    rivers: new Map(rivers.map((r) => [r.id, r])),
    known,
    target,
    seen: new Set(),
    budget: REACH_CAP,
    places,
  };
  const { starts, sink } = upstreamStarts(ix, target, own);
  // Past a station that is not at a sink the target's own reach lies downstream: a cycle must not walk it.
  if (!sink) w.seen.add(own.id);
  return withGaps(stem(w, starts, 0, own.river_id, 0));
}
