import type { WebMouth, WebWaterbody } from '../../lib/data/chain.ts';
import type { ReachGraph } from '../../lib/data/contracts.ts';
import { branches, type GReach, indexOf } from '../station/neighbours.ts';
import { type ChainNode, GROUP_DEPTH_CAP, lengthOf, placesOf, REACH_CAP, rowAt } from './chain.ts';

// The downstream chain of a station (P19b T3, issue #67): the stations below it, in walk order, to where its water
// leaves the mapped rivers. Pure and DOM-free. The walk starts on the station's own reach (as neighbours() does, no
// sink rule) and follows `downstream` outside the tidal zone only: inside it the edges have no flow direction
// (ADR-0022 §1), so a branch that reaches a tidal reach ends there ("delta"), and the walk lists the sea exits of the
// tidal zone it reached once: the mouths of every river with a reach in that zone, found without direction
// (upstream ∪ downstream). A river that ends outside the zone ends at its mouth, and the water bodies' outflows carry
// it on, body to body (IJssel → Ketelmeer → IJsselmeer → Waddenzee). A bifurcation keeps the branch on the same river
// (else the file's first) and makes the other arms child branches. Rows only for the stations in `known` (the visible
// list); ids only, the caller names them (text nodes).

/** A row: co-located stations share one (`ids`, the file's one first); `distKm` is downstream of the station. */
export type DownstreamRow = Extract<ChainNode, { kind: 'station' }>;
/** One step of the water-body outflows: body ids (reaches-file `waterbodies[].id`). */
export interface Outflow {
  from: string;
  to: string;
}
/** A river mouth and the outflows that carry its water on from the body it ends in (none for the sea). */
export interface Exit {
  mouth: WebMouth;
  outflows: readonly Outflow[];
}
export type End =
  /** The branch reached the tidal zone (or started in it): its exits are the walk's `exits`. */
  | { kind: 'delta' }
  /** The river ends in a water body. */
  | ({ kind: 'mouth' } & Exit)
  /** A child arm runs back into a reach the walk already took (the other side of an island): no end of its own. */
  | { kind: 'joins' }
  /** The end of the mapped network (no mouth, a schema 1 file, or a cap). */
  | { kind: 'end' };
export interface Branch {
  /** The river of the branch's first reach. */
  riverId: string;
  /** A child: the number of its parent's rows above the split (the root: 0). */
  at: number;
  rows: DownstreamRow[];
  end: End;
  /** The other arms of the bifurcations on this branch, in walk order. */
  children: Branch[];
}
export interface Downstream {
  /** One root branch, or none for a station the file does not place. */
  branches: Branch[];
  /** The sea exits of every tidal zone the walk reached, once each, in the order found. */
  exits: Exit[];
}
/** Reaches walked per call and bifurcation levels (defaults: the upstream chain's caps). */
export interface Caps {
  reaches?: number;
  depth?: number;
}

const END: End = { kind: 'end' };
const DELTA: End = { kind: 'delta' };
const JOINS: End = { kind: 'joins' };
const NONE: Downstream = { branches: [], exits: [] };

/** `flags` null (a lenient row) is not known tidal. */
const isTidal = (r: GReach) => r.flags?.tidal === true;

/** The downstream chain of `stationId`; `known` is the set of station ids that may become rows. */
export function downstream(
  graph: ReachGraph,
  mouths: readonly WebMouth[],
  bodies: readonly Pick<WebWaterbody, 'id' | 'outflows'>[],
  stationId: string,
  known: ReadonlySet<string>,
  caps: Caps = {},
): Downstream {
  const ix = indexOf(graph);
  const target = ix.stations.get(stationId);
  if (target === undefined || target.reach_id === null || target.km_graph === null) return NONE;
  const own = ix.reaches.get(target.reach_id);
  if (own === undefined) return NONE;
  const w = { ix, known, target, places: placesOf(graph) };
  const depthCap = caps.depth ?? GROUP_DEPTH_CAP;
  let budget = caps.reaches ?? REACH_CAP;
  const seen = new Set<string>();

  const mouthOf = new Map<string, WebMouth>();
  for (const m of mouths) if (!mouthOf.has(m.river_id)) mouthOf.set(m.river_id, m);
  const bodyOf = new Map(bodies.map((b) => [b.id, b]));
  /** The outflows from `from` on, body to body, each body once. */
  const outflowsOf = (from: string): Outflow[] => {
    const out: Outflow[] = [];
    const queue = [from];
    const reached = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i] as string;
      for (const o of bodyOf.get(at)?.outflows ?? []) {
        if (reached.has(o.to)) continue;
        reached.add(o.to);
        out.push({ from: at, to: o.to });
        queue.push(o.to);
      }
    }
    return out;
  };
  const exitOf = (mouth: WebMouth): Exit => ({ mouth, outflows: outflowsOf(mouth.waterbody_id) });

  const exits = new Map<string, Exit>();
  const zone = new Set<string>();
  /** A branch enters the tidal zone at `entry`: its component (undirected) adds its rivers' mouths to the exits. */
  const delta = (entry: GReach): End => {
    // A schema 1 file has no mouths: no exits to name, the mapped network just ends.
    if (mouths.length === 0) return END;
    if (zone.has(entry.id)) return DELTA;
    zone.add(entry.id);
    const stack = [entry];
    const rivers = new Set<string>();
    for (let r = stack.pop(); r !== undefined; r = stack.pop()) {
      rivers.add(r.river_id);
      for (const id of [...r.upstream, ...r.downstream]) {
        const n = ix.reaches.get(id);
        if (n === undefined || !isTidal(n) || zone.has(n.id)) continue;
        zone.add(n.id);
        stack.push(n);
      }
    }
    for (const m of mouths) if (rivers.has(m.river_id) && !exits.has(m.id)) exits.set(m.id, exitOf(m));
    return DELTA;
  };

  const walk = (start: GReach, at: number, d0: number, depth: number): Branch => {
    const branch: Branch = { riverId: start.river_id, at, rows: [], end: END, children: [] };
    const arms: { reach: GReach; at: number; d: number }[] = [];
    let d = d0;
    for (let r: GReach | undefined = start; r !== undefined; ) {
      if (isTidal(r)) {
        branch.end = delta(r);
        break;
      }
      if (seen.has(r.id)) {
        branch.end = JOINS;
        break;
      }
      if (budget <= 0) break;
      seen.add(r.id);
      budget -= 1;
      d += lengthOf(r);
      const row = rowAt(w, r.down_station_id, d);
      if (row !== undefined) branch.rows.push(row);
      // ponytail: one link of look-ahead keeps a dead-end stub (a braid's ditch) off the main arm; a longer dead end
      // still takes it, and its sibling then shows as the child that goes on. Walk ahead per arm if that ever shows.
      const [main, ...others] = branches(ix, r.downstream, r.river_id).sort(
        (a, b) => Number(b.downstream.length > 0) - Number(a.downstream.length > 0),
      );
      if (main === undefined) {
        const mouth = mouthOf.get(r.river_id);
        if (mouth !== undefined) branch.end = { kind: 'mouth', ...exitOf(mouth) };
        break;
      }
      // Past the depth cap the other arms are not followed (the main one is): a cycle ends the walk, not the tab.
      if (depth < depthCap) for (const o of others) arms.push({ reach: o, at: branch.rows.length, d });
      r = main;
    }
    // The main arm first, so it keeps the reaches the arms share downstream. An arm already walked is no branch, nor
    // is one with no row that only rejoins or runs dry (a braid around an island): nothing to show.
    for (const a of arms) {
      if (seen.has(a.reach.id)) continue;
      const child = walk(a.reach, a.at, a.d, depth + 1);
      const empty = child.rows.length === 0 && child.children.length === 0;
      if (!(empty && (child.end.kind === 'end' || child.end.kind === 'joins'))) branch.children.push(child);
    }
    return branch;
  };

  const root = walk(own, 0, 0, 0);
  return { branches: [root], exits: [...exits.values()] };
}
