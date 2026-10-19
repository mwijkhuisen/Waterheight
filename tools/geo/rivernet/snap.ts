import type { SnapOverridesFile, SnapRule } from '../../../packages/contracts/src/rivernet.ts';
import { BuildError, type Edge } from './build.ts';
import { byString, type LonLat, linkEnds, linkLength, type Network } from './network.ts';
import type { StationInput } from './stations.ts';

// Station snapping (P6b; catalogue §5.3 step 5): a station is placed on an
// edge of ITS river only, never by distance alone. The river comes from a
// reviewed override, the published water body (rivers.yaml `names` per source,
// verbatim; the owner `waters` table; DE-1's generated river slug), never a
// looser name match (namesakes: the Belgian Orne, the many Aa), and the nearest edge of that river must lie within 500 m (an override
// may allow up to 2 km). A station without coordinates is placed only by its
// official km between two anchors of the same river and km system.
// P17b (D-3): a river that is a `kind: canal` row of rivers.yaml snaps to that canal's own edges (the canal index,
// built from the graph before place() strips the canals): rule canal_edge, `canal` set, never a river or a Placement,
// so no reach, chainage or travel time.

export const SNAP_MAX_M = 500;
const NODE_SNAP_M = 0.5; // closer than this to an edge end: the station sits on the node

export interface Placement {
  edge: string;
  /** Metres from the edge's start, along its drawn line. */
  offset_m: number;
  /** Metres from the station to the line (0 for a km placement). */
  distance_m: number;
}

export interface Snap {
  id: string;
  rule: SnapRule;
  river: string | null;
  placement: Placement | null;
  override: boolean;
  /** P17b: the canal whose edge the station lies on (rule canal_edge), with its distance to that edge (0.1 m). */
  canal: string | null;
  canal_distance_m: number | null;
}

/** What nearestOnRiver reads of a network: per river (or per canal, the canal index) its edge ids, and the edges. */
export type EdgeIndex = Pick<Network, 'riverEdges' | 'edges'>;
const NO_CANALS: EdgeIndex = { riverEdges: new Map(), edges: new Map() };

/** The river a station's published water body names, or null. Ambiguity is a curation error. */
export function riverOf(net: Network, overrides: SnapOverridesFile, s: StationInput): string | null {
  const w = s.water_name;
  const named =
    w === null ? [] : net.rivers.rivers.filter((r) => (r.names[s.source] ?? []).includes(w)).map((r) => r.id);
  const owner =
    w === null ? [] : overrides.waters.filter((x) => x.source === s.source && x.water_name === w).map((x) => x.river);
  const exact = [...new Set([...named, ...owner])];
  if (exact.length > 1) throw new BuildError('ambiguous_water', [s.id]);
  if (s.river_hint !== null && exact.length === 1 && exact[0] !== s.river_hint)
    throw new BuildError('river_hint_mismatch', [s.id]);
  if (exact.length === 1) return exact[0] as string;
  return s.river_hint;
}

/** Nearest point of a river's edges to a station, within maxM; ties by edge id. */
export function nearestOnRiver(net: EdgeIndex, river: string, at: LonLat, maxM: number): Placement | null {
  const [lon0, lat0] = at;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_574;
  const dLon = (maxM + 100) / kx;
  const dLat = (maxM + 100) / ky;
  let best: Placement | null = null;
  for (const id of net.riverEdges.get(river) ?? []) {
    const e = net.edges.get(id);
    if (e === undefined) continue; // a join has no line
    let along = 0;
    for (let i = 0; i + 1 < e.coords.length; i++) {
      const a = e.coords[i] as LonLat;
      const b = e.coords[i + 1] as LonLat;
      const segM = segLength(a, b);
      if (
        Math.min(a[0], b[0]) - dLon > lon0 ||
        Math.max(a[0], b[0]) + dLon < lon0 ||
        Math.min(a[1], b[1]) - dLat > lat0 ||
        Math.max(a[1], b[1]) + dLat < lat0
      ) {
        along += segM;
        continue;
      }
      // Local equirectangular metres around the station: exact enough within a kilometre.
      const ax = (a[0] - lon0) * kx;
      const ay = (a[1] - lat0) * ky;
      const bx = (b[0] - lon0) * kx;
      const by = (b[1] - lat0) * ky;
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2));
      const d = Math.hypot(ax + t * vx, ay + t * vy);
      if (d <= maxM && (best === null || d < best.distance_m || (d === best.distance_m && id < best.edge))) {
        best = { edge: id, offset_m: along + t * segM, distance_m: d };
      }
      along += segM;
    }
  }
  return best === null ? null : normalise(net.edges.get(best.edge) as Edge, best);
}

/** The same metric as the edge's length_m (P6a: haversine per segment). */
function segLength(a: LonLat, b: LonLat): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b[1] - a[1]) * r) / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rounds to 0.1 m and pins a point within NODE_SNAP_M of an edge end onto that end. */
function normalise(e: Edge, p: Placement): Placement {
  const offset = p.offset_m < NODE_SNAP_M ? 0 : p.offset_m > e.length_m - NODE_SNAP_M ? e.length_m : p.offset_m;
  return { edge: p.edge, offset_m: Math.round(offset * 10) / 10, distance_m: Math.round(p.distance_m * 10) / 10 };
}

const unplaced = (s: StationInput, rule: SnapRule, override: boolean): Snap => ({
  id: s.id,
  rule,
  river: null,
  placement: null,
  override,
  canal: null,
  canal_distance_m: null,
});

/**
 * Snaps every station: first those with coordinates, then those placed by official km between them. `canals` is the
 * canal index (place() builds it from the graph before it strips the canals); without it no station reaches a canal.
 */
export function snapStations(
  net: Network,
  stations: readonly StationInput[],
  overrides: SnapOverridesFile,
  canals: EdgeIndex = NO_CANALS,
): Snap[] {
  const byId = new Map(overrides.stations.map((o) => [o.station, o]));
  for (const id of byId.keys())
    if (!stations.some((s) => s.id === id)) throw new BuildError('override_unknown_station', [id]);
  const isCanal = new Set(net.rivers.rivers.filter((r) => r.kind === 'canal').map((r) => r.id));
  // A river id snaps to its own edges; a canal id to the canal index, and the result is never a Placement.
  const snapTo = (
    s: StationInput,
    river: string,
    at: LonLat,
    maxM: number,
    rule: SnapRule,
    override: boolean,
  ): Snap | null => {
    const canal = isCanal.has(river);
    const p = nearestOnRiver(canal ? canals : net, river, at, maxM);
    if (p === null) return null;
    return canal
      ? { ...unplaced(s, 'canal_edge', override), canal: river, canal_distance_m: p.distance_m }
      : { ...unplaced(s, rule, override), river, placement: p };
  };
  const snaps = new Map<string, Snap>();
  const later: StationInput[] = [];
  for (const s of stations) {
    const o = byId.get(s.id);
    if (o?.canal !== undefined) snaps.set(s.id, unplaced(s, 'canal', true));
    else if (o?.unsnapped === true) snaps.set(s.id, unplaced(s, 'unsnapped', true));
    else if (o?.by_km === true) {
      const river = riverOf(net, overrides, s);
      if (river !== null && isCanal.has(river)) throw new BuildError('by_km_on_canal', [s.id]);
      later.push(s);
    } else if (o?.river !== undefined) {
      if (s.lon === null || s.lat === null) throw new BuildError('override_without_coordinates', [s.id]);
      const snap = snapTo(s, o.river, [s.lon, s.lat], o.max_m ?? SNAP_MAX_M, 'override', true);
      if (snap === null) throw new BuildError('override_unplaced', [s.id]);
      snaps.set(s.id, snap);
    } else if (s.lon === null || s.lat === null) later.push(s);
    else {
      const river = riverOf(net, overrides, s);
      snaps.set(
        s.id,
        river === null
          ? unplaced(s, 'water_not_in_rivers', false)
          : (snapTo(s, river, [s.lon, s.lat], SNAP_MAX_M, 'name', false) ?? unplaced(s, 'no_edge_within_500m', false)),
      );
    }
  }
  for (const s of later) {
    const snap = placeByKm(net, overrides, s, stations, snaps);
    if (byId.get(s.id)?.by_km !== true) snaps.set(s.id, snap);
    else if (snap.placement === null) throw new BuildError('override_unplaced', [s.id]);
    else snaps.set(s.id, { ...snap, override: true });
  }
  return stations.map((s) => snaps.get(s.id) as Snap);
}

/**
 * A station without coordinates, between two anchors of the same river and
 * km system that bracket its official km: linear along the anchors' path.
 * Anchors are stations of audience public only (mirrors included), so no
 * owner or off row moves a public placement (T-GEO-9).
 */
function placeByKm(
  net: Network,
  overrides: SnapOverridesFile,
  s: StationInput,
  stations: readonly StationInput[],
  snaps: ReadonlyMap<string, Snap>,
): Snap {
  const none = unplaced(s, 'no_coordinates', false);
  const river = riverOf(net, overrides, s);
  if (river === null || s.km === null) return none;
  const km = s.km;
  const anchors = stations
    .filter((a) => a.audience === 'public' && a.km !== null && a.km.system === km.system)
    .map((a) => ({ a, snap: snaps.get(a.id) }))
    .filter(
      (x): x is { a: StationInput; snap: Snap & { placement: Placement } } =>
        x.snap !== undefined && x.snap.river === river && x.snap.placement !== null && x.snap.rule !== 'official_km',
    )
    .sort((x, y) => (x.a.km?.value as number) - (y.a.km?.value as number) || byString(x.a.id, y.a.id));
  const lo = anchors.filter((x) => (x.a.km?.value as number) <= km.value).at(-1);
  const hi = anchors.find((x) => (x.a.km?.value as number) >= km.value);
  if (lo === undefined || hi === undefined) return none;
  if (lo.a.km?.value === km.value)
    return { ...none, rule: 'official_km', river, placement: { ...lo.snap.placement, distance_m: 0 } };
  const path =
    pathBetween(net, river, lo.snap.placement, hi.snap.placement) ??
    pathBetween(net, river, hi.snap.placement, lo.snap.placement);
  if (path === null) return none;
  const loKm = lo.a.km?.value as number;
  const hiKm = hi.a.km?.value as number;
  // The path runs from its first to its last placement; the fraction counts from the end that is upstream.
  const fromLo = path.start.edge === lo.snap.placement.edge && path.start.offset_m === lo.snap.placement.offset_m;
  const f = (km.value - loKm) / (hiKm - loKm);
  const target = (fromLo ? f : 1 - f) * path.length;
  return { ...none, rule: 'official_km', river, placement: walk(net, path, target) };
}

interface Path {
  start: Placement;
  /** Links in order; the first and last may be partial (from start.offset_m, to end.offset_m). */
  links: string[];
  end: Placement;
  length: number;
}

/** The shortest downstream path along `river`'s own links from one placement to another, or null. */
function pathBetween(net: Network, river: string, a: Placement, b: Placement): Path | null {
  const own = new Set(net.riverEdges.get(river) ?? []);
  const ea = net.edges.get(a.edge) as Edge;
  if (a.edge === b.edge)
    return b.offset_m >= a.offset_m ? { start: a, links: [a.edge], end: b, length: b.offset_m - a.offset_m } : null;
  const goal = (net.edges.get(b.edge) as Edge).from;
  const prev = new Map<string, string>(); // node -> link that reached it
  const dist = new Map<string, number>([[ea.to, ea.length_m - a.offset_m]]);
  const open = [ea.to];
  while (open.length > 0) {
    open.sort((x, y) => (dist.get(x) as number) - (dist.get(y) as number) || byString(x, y));
    const n = open.shift() as string;
    if (n === goal) break;
    for (const l of net.out.get(n) ?? []) {
      if (!own.has(l)) continue;
      const m = linkEnds(net, l).to;
      const d = (dist.get(n) as number) + linkLength(net, l);
      if (!dist.has(m) || d < (dist.get(m) as number)) {
        dist.set(m, d);
        prev.set(m, l);
        if (!open.includes(m)) open.push(m);
      }
    }
  }
  if (!dist.has(goal)) return null;
  const links: string[] = [b.edge];
  for (let n = goal; n !== ea.to; ) {
    const l = prev.get(n) as string;
    links.unshift(l);
    n = linkEnds(net, l).from;
  }
  links.unshift(a.edge);
  return { start: a, links, end: b, length: (dist.get(goal) as number) + b.offset_m };
}

/** The placement `target` metres along a path (a path starts and ends on OSM edges, never on a join). */
function walk(net: Network, path: Path, target: number): Placement {
  let left = target;
  for (const [i, l] of path.links.entries()) {
    const from = i === 0 ? path.start.offset_m : 0;
    const to = i === path.links.length - 1 ? path.end.offset_m : linkLength(net, l);
    const span = to - from;
    if (left <= span || i === path.links.length - 1) {
      const e = net.edges.get(l);
      if (e !== undefined)
        return normalise(e, { edge: l, offset_m: from + Math.max(0, Math.min(left, span)), distance_m: 0 });
      return { edge: path.links[i + 1] as string, offset_m: 0, distance_m: 0 };
    }
    left -= span;
  }
  return path.end;
}

/** The point of a placement on its edge's line ([lon, lat]). */
export function pointOf(net: Network, p: Placement): LonLat {
  const e = net.edges.get(p.edge) as Edge;
  let left = p.offset_m;
  for (let i = 0; i + 1 < e.coords.length; i++) {
    const a = e.coords[i] as LonLat;
    const b = e.coords[i + 1] as LonLat;
    const seg = segLength(a, b);
    if (left <= seg || i + 2 === e.coords.length) {
      const t = seg === 0 ? 0 : Math.min(1, left / seg);
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    left -= seg;
  }
  return e.coords[0] as LonLat;
}
