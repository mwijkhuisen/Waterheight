import type { ReachFlags } from '../../../packages/contracts/src/reaches.ts';
import { BuildError, type Edge } from './build.ts';
import { byString, haversine, type LonLat, type Network } from './network.ts';
import type { Placement } from './snap.ts';

// Reaches (P6b; A§6 `reach`): the graph cut at the positions of PUBLIC stations
// only (owner and off stations get a reach but split nothing; the owner
// publisher adds their split points in P11), then chained: a reach runs
// between two break points (a station, a confluence, a bifurcation, a change
// of river, a join end). Numbered per river in graph order by km_graph.

export interface Cut {
  station: string;
  placement: Placement;
}

interface Piece {
  edge: string;
  start: number;
  end: number;
  from: string;
  to: string;
}

export interface BuiltReach {
  id: string;
  river: string;
  seq: number;
  up_station: string | null;
  down_station: string | null;
  length_m: number;
  km_graph_from: number;
  km_graph_to: number;
  flags: ReachFlags;
  travel_time_h: [number, number] | null;
  travel_time_source: string | null;
  upstream: string[];
  downstream: string[];
  /** The drawn line (none for a reach that is only a join: never drawn). */
  coords: LonLat[];
  pieces: Piece[];
}

const pointKey = (e: Edge, offset: number) =>
  offset === 0 ? e.from : offset === e.length_m ? e.to : `c:${e.id}:${offset}`;

/** The part of an edge's line between two offsets (metres, the edge's own haversine metric). */
export function sliceLine(e: Edge, a: number, b: number): LonLat[] {
  const out: LonLat[] = [];
  let along = 0;
  const at = (p: LonLat, q: LonLat, t: number): LonLat => [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
  for (let i = 0; i + 1 < e.coords.length; i++) {
    const p = e.coords[i] as LonLat;
    const q = e.coords[i + 1] as LonLat;
    const seg = haversine(p, q);
    const s0 = along;
    const s1 = along + seg;
    if (s1 >= a && s0 <= b) {
      if (out.length === 0) out.push(a <= s0 ? p : at(p, q, seg === 0 ? 0 : (a - s0) / seg));
      out.push(b >= s1 ? q : at(p, q, seg === 0 ? 0 : (b - s0) / seg));
      if (b <= s1) break;
    }
    along = s1;
  }
  return out.map(([lon, lat]) => [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]);
}

export function cutReaches(
  net: Network,
  cuts: readonly Cut[],
  kmAt: (river: string, p: Placement) => number,
): { reaches: BuiltReach[]; reachOf: (p: Placement, river: string) => string } {
  // 1. Pieces: every edge split at the public stations on it.
  const offsetsByEdge = new Map<string, number[]>();
  const stationsAt = new Map<string, string[]>();
  for (const c of [...cuts].sort((a, b) => byString(a.station, b.station))) {
    const e = net.edges.get(c.placement.edge) as Edge;
    const key = pointKey(e, c.placement.offset_m);
    stationsAt.set(key, [...(stationsAt.get(key) ?? []), c.station]);
    if (c.placement.offset_m > 0 && c.placement.offset_m < e.length_m)
      offsetsByEdge.set(e.id, [...new Set([...(offsetsByEdge.get(e.id) ?? []), c.placement.offset_m])]);
  }
  const pieces: Piece[] = [];
  const piecesOf = new Map<string, Piece[]>();
  for (const e of net.edges.values()) {
    const marks = [0, ...(offsetsByEdge.get(e.id) ?? []).sort((a, b) => a - b), e.length_m];
    const list: Piece[] = [];
    for (let i = 0; i + 1 < marks.length; i++) {
      const start = marks[i] as number;
      const end = marks[i + 1] as number;
      list.push({ edge: e.id, start, end, from: pointKey(e, start), to: pointKey(e, end) });
    }
    piecesOf.set(e.id, list);
    pieces.push(...list);
  }

  // 2. Links between points: pieces and joins.
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  const outPieces = new Map<string, Piece[]>();
  const inRivers = new Map<string, Set<string>>();
  const outRivers = new Map<string, Set<string>>();
  const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const p of pieces) {
    add(out, p.from);
    add(inn, p.to);
    outPieces.set(p.from, [...(outPieces.get(p.from) ?? []), p]);
    const r = net.primary.get(p.edge) as string;
    outRivers.set(p.from, (outRivers.get(p.from) ?? new Set()).add(r));
    inRivers.set(p.to, (inRivers.get(p.to) ?? new Set()).add(r));
  }
  const joinEnds = new Set<string>();
  for (const j of net.joins) {
    add(out, j.from);
    add(inn, j.to);
    joinEnds.add(j.from);
    joinEnds.add(j.to);
  }
  const isBreak = (pt: string) =>
    stationsAt.has(pt) ||
    joinEnds.has(pt) ||
    (out.get(pt) ?? 0) !== 1 ||
    (inn.get(pt) ?? 0) !== 1 ||
    [...(inRivers.get(pt) ?? [])][0] !== [...(outRivers.get(pt) ?? [])][0];

  // 3. Chains of pieces between break points.
  const chains: Piece[][] = [];
  for (const p of [...pieces].sort((a, b) => byString(a.edge, b.edge) || a.start - b.start)) {
    if (!isBreak(p.from)) continue;
    const chain = [p];
    for (let last = p; !isBreak(last.to); ) {
      last = (outPieces.get(last.to) as Piece[])[0] as Piece;
      chain.push(last);
    }
    chains.push(chain);
  }
  if (chains.reduce((n, c) => n + c.length, 0) !== pieces.length) throw new BuildError('reach_cover', []);

  // 4. Reaches, numbered per river by km_graph at their start.
  const built = chains.map((chain) => {
    const first = chain[0] as Piece;
    const last = chain.at(-1) as Piece;
    const river = net.primary.get(first.edge) as string;
    const line: LonLat[] = [];
    for (const p of chain) {
      const part = sliceLine(net.edges.get(p.edge) as Edge, p.start, p.end);
      line.push(...(line.length > 0 ? part.slice(1) : part));
    }
    return {
      river,
      chain,
      from: first.from,
      to: last.to,
      length_m: chain.reduce((s, p) => s + (p.end - p.start), 0),
      km_graph_from: kmAt(river, { edge: first.edge, offset_m: first.start, distance_m: 0 }),
      km_graph_to: kmAt(river, { edge: last.edge, offset_m: last.end, distance_m: 0 }),
      line,
    };
  });
  const seqOf = new Map<(typeof built)[number], number>();
  const byRiver = new Map<string, (typeof built)[number][]>();
  for (const b of built) byRiver.set(b.river, [...(byRiver.get(b.river) ?? []), b]);
  for (const list of byRiver.values()) {
    list.sort(
      (a, b) =>
        a.km_graph_from - b.km_graph_from ||
        a.km_graph_to - b.km_graph_to ||
        byString((a.chain[0] as Piece).edge, (b.chain[0] as Piece).edge) ||
        (a.chain[0] as Piece).start - (b.chain[0] as Piece).start,
    );
    for (const [i, b] of list.entries()) seqOf.set(b, i + 1);
  }
  const idOf = (b: (typeof built)[number]) => `${b.river}.${seqOf.get(b)}`;
  const starting = new Map<string, string[]>();
  const ending = new Map<string, string[]>();
  for (const b of built) {
    starting.set(b.from, [...(starting.get(b.from) ?? []), idOf(b)]);
    ending.set(b.to, [...(ending.get(b.to) ?? []), idOf(b)]);
  }
  // A join is transparent: the reaches ending at its start meet the reaches starting at its end.
  const after = (pt: string) => [
    ...(starting.get(pt) ?? []),
    ...net.joins.filter((j) => j.from === pt).flatMap((j) => starting.get(j.to) ?? []),
  ];
  const before = (pt: string) => [
    ...(ending.get(pt) ?? []),
    ...net.joins.filter((j) => j.to === pt).flatMap((j) => ending.get(j.from) ?? []),
  ];
  const first = (pt: string) => (stationsAt.get(pt) ?? [])[0] ?? null;

  const reaches: BuiltReach[] = built.map((b) => ({
    id: idOf(b),
    river: b.river,
    seq: seqOf.get(b) as number,
    up_station: first(b.from),
    down_station: first(b.to),
    length_m: b.length_m,
    km_graph_from: b.km_graph_from,
    km_graph_to: b.km_graph_to,
    flags: { tidal: false, impounded: false, bifurcation: (out.get(b.from) ?? 0) >= 2 },
    travel_time_h: null,
    travel_time_source: null,
    upstream: [...new Set(before(b.from))].sort(byString),
    downstream: [...new Set(after(b.to))].sort(byString),
    coords: b.line,
    pieces: b.chain,
  }));
  reaches.sort((a, b) => byString(a.river, b.river) || a.seq - b.seq);

  const reachOfPiece = new Map<Piece, string>();
  for (const r of reaches) for (const p of r.pieces) reachOfPiece.set(p, r.id);
  const riverOfReach = new Map(reaches.map((r) => [r.id, r.river]));
  // One convention: a placed station's reach is the reach starting at its position (the piece that starts at
  // or contains it). At the very end of its edge that is a reach starting at the edge's end node: one of the
  // station's own river if several start there, else the smallest id. Only at a sink (no piece starts there,
  // a join's start included) is it the reach ending there. Co-located public stations therefore share one
  // reach, and the alphabetically first of them is that reach's up_station (and the down_station of the
  // reaches ending there).
  const reachOf = (p: Placement, river: string) => {
    const list = piecesOf.get(p.edge) as Piece[];
    const inside = list.find((x) => x.start <= p.offset_m && p.offset_m < x.end);
    if (inside !== undefined) return reachOfPiece.get(inside) as string;
    const last = list.at(-1) as Piece;
    const next = [...new Set((outPieces.get(last.to) ?? []).map((x) => reachOfPiece.get(x) as string))].sort(
      (a, b) => Number(riverOfReach.get(b) === river) - Number(riverOfReach.get(a) === river) || byString(a, b),
    );
    return next[0] ?? (reachOfPiece.get(last) as string);
  };
  return { reaches, reachOf };
}
