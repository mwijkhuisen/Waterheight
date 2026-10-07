import type { ReachGraph } from '../../lib/data/contracts.ts';

// The nearest public station upstream and downstream of one station (P10d, owner decision 2026-10-07): a walk on the
// reach graph of reaches-<ver>.json. A reach starts at a station (`reach_id`), `down_station_id` is the station at its
// end and `up_station_id` the one at its start; a reach with none is passed through to its neighbours. At a
// confluence or a bifurcation the branch on the same river comes first, then file order. Co-located stations share
// a reach and a chainage, and the file names only one of them at a reach end: such a station is never a neighbour.

type GStation = ReachGraph['stations'][number];
type GReach = ReachGraph['reaches'][number];

export type Neighbour = { id: string; riverId: string; crossRiver: boolean };
export type Neighbours = { up?: Neighbour; down?: Neighbour };

/** Reaches visited per search: a cycle or a huge delta ends the walk instead of the tab. */
const DEPTH_CAP = 200;

type Index = { stations: Map<string, GStation>; reaches: Map<string, GReach> };
const indexes = new WeakMap<ReachGraph, Index>();

function indexOf(graph: ReachGraph): Index {
  let ix = indexes.get(graph);
  if (ix === undefined) {
    ix = {
      stations: new Map(graph.stations.map((s) => [s.id, s])),
      reaches: new Map(graph.reaches.map((r) => [r.id, r])),
    };
    indexes.set(graph, ix);
  }
  return ix;
}

/** The reaches of `ids` that the file holds, the ones on `river` first (a stable sort keeps the file order). */
const branches = (ix: Index, ids: readonly string[], river: string): GReach[] =>
  ids
    .flatMap((id) => {
      const r = ix.reaches.get(id);
      return r === undefined ? [] : [r];
    })
    .sort((a, b) => Number(b.river_id === river) - Number(a.river_id === river));

/** The first station that `ok` accepts, found by `pick` on the starting reaches or, failing that, on the reaches `next` names. */
function search(
  ix: Index,
  starts: readonly GReach[],
  pick: (r: GReach) => string | null,
  next: (r: GReach) => readonly string[],
  ok: (id: string) => boolean,
): string | undefined {
  const seen = new Set<string>();
  let budget = DEPTH_CAP;
  const visit = (reach: GReach): string | undefined => {
    if (seen.has(reach.id) || budget <= 0) return undefined;
    seen.add(reach.id);
    budget -= 1;
    const found = pick(reach);
    if (found !== null && ok(found)) return found;
    for (const n of branches(ix, next(reach), reach.river_id)) {
      const hit = visit(n);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  for (const start of starts) {
    const hit = visit(start);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The neighbours of `id`. `known` is the set of station ids the page has (stations.json): an id outside it is
 * walked past. A station the file does not place (no reach, no chainage, not in the file) has none.
 */
export function neighbours(id: string, graph: ReachGraph, known: ReadonlySet<string>): Neighbours {
  const ix = indexOf(graph);
  const station = ix.stations.get(id);
  if (station === undefined || station.reach_id === null || station.km_graph === null) return {};
  const own = ix.reaches.get(station.reach_id);
  if (own === undefined) return {};

  const here = (s: GStation | undefined) => s?.reach_id === station.reach_id && s?.km_graph === station.km_graph;
  const ok = (other: string) =>
    other !== id && known.has(other) && ix.stations.has(other) && !here(ix.stations.get(other));
  const make = (other: string | undefined): Neighbour | undefined => {
    const found = other === undefined ? undefined : ix.stations.get(other);
    return found === undefined
      ? undefined
      : { id: found.id, riverId: found.river_id, crossRiver: found.river_id !== station.river_id };
  };

  // A station at a sink has the reach that ENDS there (the file's rule): its upstream search starts on that reach.
  // The station at that end shares the reach and the chainage; one upstream on a reach that ends at a sink does not.
  const sink = here(own.down_station_id === null ? undefined : ix.stations.get(own.down_station_id));
  const upStarts = sink ? [own] : branches(ix, own.upstream, own.river_id);

  const up = search(
    ix,
    upStarts,
    (r) => r.up_station_id,
    (r) => r.upstream,
    ok,
  );
  const down = search(
    ix,
    [own],
    (r) => r.down_station_id,
    (r) => r.downstream,
    ok,
  );
  const result: Neighbours = {};
  const u = make(up);
  const d = make(down);
  if (u !== undefined) result.up = u;
  if (d !== undefined) result.down = d;
  return result;
}
