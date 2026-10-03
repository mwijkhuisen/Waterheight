import type { RiversFile } from '../../../packages/contracts/src/rivers.ts';
import { BuildError, type Edge } from './build.ts';

// The P6b routing view of the P6a graph (ADR-0012): the OSM edges as drawn
// (downstream), plus the reviewed joins of rivers.yaml (KG-161; routing only,
// never drawn), with per river the longest-path distance from its own sources
// (km_graph: it rises along every downstream path) and the NL entry nodes.
// Pure and deterministic: every map is filled and read in sorted order.

export type LonLat = [number, number];

/** A reviewed connection: no geometry, length = the straight distance between its nodes. */
export interface JoinEdge {
  id: string;
  from: string;
  to: string;
  river: string;
  length_m: number;
}

export interface EntryNode {
  id: string;
  river: string;
  node: string;
  name_nl: string;
  name_en: string;
  coord: LonLat;
}

export interface Network {
  rivers: RiversFile;
  edges: ReadonlyMap<string, Edge>;
  joins: readonly JoinEdge[];
  coord: ReadonlyMap<string, LonLat>;
  /** Downstream links per node: OSM edge ids and join ids (`j…`), sorted. */
  out: ReadonlyMap<string, readonly string[]>;
  in: ReadonlyMap<string, readonly string[]>;
  /** The river an edge belongs to for reaches and drawing: the deepest of its `rivers[]` in the parent tree. */
  primary: ReadonlyMap<string, string>;
  /** Per river, its edge ids (an edge may belong to several, KG-162). */
  riverEdges: ReadonlyMap<string, readonly string[]>;
  /** Per river, metres from the river's own sources to each of its nodes, along the longest path. */
  kmGraph: ReadonlyMap<string, ReadonlyMap<string, number>>;
  entries: readonly EntryNode[];
}

export const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function haversine([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list === undefined) m.set(k, [v]);
  else list.push(v);
};

/** Link length: an OSM edge's own length or a join's straight length. */
export function linkLength(net: Network, id: string): number {
  return net.edges.get(id)?.length_m ?? (net.joins.find((j) => j.id === id) as JoinEdge).length_m;
}
export function linkEnds(net: Network, id: string): { from: string; to: string } {
  return net.edges.get(id) ?? (net.joins.find((j) => j.id === id) as JoinEdge);
}

/** Every node from which `node` can be reached (its ancestors), `node` excluded. */
function ancestors(
  inLinks: ReadonlyMap<string, readonly string[]>,
  ends: (id: string) => { from: string },
  node: string,
) {
  const seen = new Set<string>();
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop() as string;
    for (const l of inLinks.get(n) ?? []) {
      const f = ends(l).from;
      if (!seen.has(f)) {
        seen.add(f);
        stack.push(f);
      }
    }
  }
  return seen;
}

/** Nodes in a topological order of the links (Kahn); a cycle is a BuildError naming the links left over. */
function topoOrder(
  nodes: readonly string[],
  out: ReadonlyMap<string, readonly string[]>,
  ends: (id: string) => { to: string },
) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  for (const n of nodes) for (const l of out.get(n) ?? []) indeg.set(ends(l).to, (indeg.get(ends(l).to) ?? 0) + 1);
  const ready = nodes.filter((n) => indeg.get(n) === 0).sort(byString);
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift() as string;
    order.push(n);
    for (const l of out.get(n) ?? []) {
      const t = ends(l).to;
      const d = (indeg.get(t) as number) - 1;
      indeg.set(t, d);
      if (d === 0) ready.push(t);
    }
  }
  if (order.length !== nodes.length) {
    const left = nodes.filter((n) => (indeg.get(n) ?? 0) > 0);
    throw new BuildError('cycle', left.flatMap((n) => [...(out.get(n) ?? [])]).sort(byString));
  }
  return order;
}

/** Builds the routing view; fails closed on a join or entry it cannot place. */
export function buildNetwork(edgeList: readonly Edge[], rivers: RiversFile): Network {
  const edges = new Map([...edgeList].sort((a, b) => byString(a.id, b.id)).map((e) => [e.id, e]));
  const coord = new Map<string, LonLat>();
  for (const e of edges.values()) {
    coord.set(e.from, e.coords[0] as LonLat);
    coord.set(e.to, e.coords.at(-1) as LonLat);
  }
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  const riverEdges = new Map<string, string[]>();
  for (const e of edges.values()) {
    push(out, e.from, e.id);
    push(inn, e.to, e.id);
    for (const r of e.rivers) push(riverEdges, r, e.id);
  }
  const known = new Set(rivers.rivers.map((r) => r.id));
  for (const r of riverEdges.keys()) if (!known.has(r)) throw new BuildError('unknown_river', [r]);

  // Parent depth: the deepest river of an edge's `rivers[]` is the one it is drawn and cut as (Waal over Rhine).
  const parent = new Map(rivers.rivers.map((r) => [r.id, r.parent_river_id]));
  const depth = (id: string) => {
    let d = 0;
    for (let p = parent.get(id); p !== null && p !== undefined && d < 100; p = parent.get(p)) d++;
    return d;
  };
  const primary = new Map<string, string>();
  for (const e of edges.values()) {
    const best = [...e.rivers].sort((a, b) => depth(b) - depth(a) || byString(a, b))[0];
    if (best === undefined) throw new BuildError('edge_without_river', [e.id]);
    primary.set(e.id, best);
  }

  // Joins: the sink of `river` nearest `at` → the nearest node of `to_river` that is not upstream of it.
  const ends = (id: string) => edges.get(id) ?? (joins.find((j) => j.id === id) as JoinEdge);
  const joins: JoinEdge[] = [];
  for (const [k, j] of (rivers.joins ?? []).entries()) {
    const own = riverEdges.get(j.river) ?? [];
    const ownOut = new Set(own.map((id) => (edges.get(id) as Edge).from));
    const sinks = [...new Set(own.map((id) => (edges.get(id) as Edge).to))]
      .filter((n) => !ownOut.has(n))
      .sort(byString);
    const from = nearest(sinks, j.at, coord);
    if (from === undefined || haversine(coord.get(from) as LonLat, j.at) > j.max_m)
      throw new BuildError('join_unplaced', [j.river]);
    const up = ancestors(inn, ends, from);
    const targets = [
      ...new Set(
        (riverEdges.get(j.to_river) ?? []).flatMap((id) => [(edges.get(id) as Edge).from, (edges.get(id) as Edge).to]),
      ),
    ]
      .filter((n) => n !== from && !up.has(n))
      .sort(byString);
    const to = nearest(targets, coord.get(from) as LonLat, coord);
    const length_m =
      to === undefined ? Number.POSITIVE_INFINITY : haversine(coord.get(from) as LonLat, coord.get(to) as LonLat);
    if (to === undefined || length_m > j.max_m) throw new BuildError('join_too_far', [j.river, j.to_river]);
    const join = { id: `j${k + 1}`, from, to, river: j.river, length_m: Math.round(length_m * 10) / 10 };
    joins.push(join);
    push(out, from, join.id);
    push(inn, to, join.id);
    push(riverEdges, j.river, join.id);
    if (j.to_river !== j.river) push(riverEdges, j.to_river, join.id);
  }
  for (const m of [out, inn, riverEdges]) for (const list of m.values()) list.sort(byString);

  const nodes = [...coord.keys()].sort(byString);
  const order = topoOrder(nodes, out, ends);
  const rank = new Map(order.map((n, i) => [n, i]));

  // km_graph: longest path from the river's own sources, over its own links, in topological order.
  const kmGraph = new Map<string, Map<string, number>>();
  for (const [river, links] of [...riverEdges].sort((a, b) => byString(a[0], b[0]))) {
    const linkSet = new Set(links);
    const own = new Set(links.flatMap((l) => [ends(l).from, ends(l).to]));
    const d = new Map<string, number>();
    for (const n of [...own].sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number))) {
      let best = 0;
      for (const l of inn.get(n) ?? []) {
        if (!linkSet.has(l)) continue;
        const u = ends(l).from;
        best = Math.max(best, (d.get(u) ?? 0) + linkLengthOf(edges, joins, l));
      }
      d.set(n, best);
    }
    kmGraph.set(river, d);
  }

  const entries: EntryNode[] = [];
  for (const r of [...rivers.rivers].sort((a, b) => byString(a.id, b.id))) {
    if (r.nl_entry === undefined) continue;
    const own = [...(kmGraph.get(r.id)?.keys() ?? [])].sort(byString);
    const node = nearest(own, r.nl_entry.at, coord);
    if (node === undefined || haversine(coord.get(node) as LonLat, r.nl_entry.at) > r.nl_entry.max_m)
      throw new BuildError('entry_unplaced', [r.nl_entry.id]);
    const e = r.nl_entry;
    entries.push({
      id: e.id,
      river: r.id,
      node,
      name_nl: e.name_nl,
      name_en: e.name_en,
      coord: coord.get(node) as LonLat,
    });
  }

  return { rivers, edges, joins, coord, out, in: inn, primary, riverEdges, kmGraph, entries };
}

function linkLengthOf(edges: ReadonlyMap<string, Edge>, joins: readonly JoinEdge[], id: string): number {
  return edges.get(id)?.length_m ?? (joins.find((j) => j.id === id) as JoinEdge).length_m;
}

function nearest(nodes: readonly string[], at: LonLat, coord: ReadonlyMap<string, LonLat>): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    const d = haversine(coord.get(n) as LonLat, at);
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/**
 * Shortest distances (m) from every node to the nearest of `targets` going
 * downstream (Dijkstra on the reversed links), with which target it is.
 */
export function toTargets(net: Network, targets: readonly string[]): Map<string, { d: number; target: string }> {
  return dijkstra(
    targets.map((t) => [t, t]),
    (n) => net.in.get(n) ?? [],
    (l) => linkEnds(net, l).from,
    net,
  );
}

/** Shortest distances (m) from `source` to every node it reaches downstream. */
export function fromSource(net: Network, source: string): Map<string, { d: number; target: string }> {
  return dijkstra(
    [[source, source]],
    (n) => net.out.get(n) ?? [],
    (l) => linkEnds(net, l).to,
    net,
  );
}

function dijkstra(
  starts: readonly [string, string][],
  links: (n: string) => readonly string[],
  next: (l: string) => string,
  net: Network,
): Map<string, { d: number; target: string }> {
  const best = new Map<string, { d: number; target: string }>();
  // ponytail: an array scan as the queue (O(n^2) on ~4k nodes, about 16M steps); a heap when the graph grows 10×.
  const open = new Map<string, { d: number; target: string }>();
  for (const [n, t] of starts) open.set(n, { d: 0, target: t });
  while (open.size > 0) {
    let pick: string | undefined;
    let pv: { d: number; target: string } | undefined;
    for (const [n, v] of open)
      if (
        pv === undefined ||
        v.d < pv.d ||
        (v.d === pv.d && (v.target < pv.target || (v.target === pv.target && n < (pick as string))))
      ) {
        pick = n;
        pv = v;
      }
    open.delete(pick as string);
    best.set(pick as string, pv as { d: number; target: string });
    for (const l of links(pick as string)) {
      const m = next(l);
      if (best.has(m)) continue;
      const d = (pv as { d: number }).d + linkLength(net, l);
      const cur = open.get(m);
      if (cur === undefined || d < cur.d || (d === cur.d && (pv as { target: string }).target < cur.target))
        open.set(m, { d, target: (pv as { target: string }).target });
    }
  }
  return best;
}
