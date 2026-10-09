import type { ApiStation } from '@rws/contracts';
import type { ReachGraph } from '../../../lib/data/contracts.ts';
import type { HovPathId } from '../../../lib/url/url.ts';
import { indexOf } from '../../station/neighbours.ts';
import { GAP_KM } from '../chain.ts';

// P11c (issue #26): the columns of the Hovmöller panel, one per primary main-stem station of a path, ordered by the
// registry's km_to_nl_entry (x = −km: 0 at the NL entry node, upstream → downstream left to right). Membership comes
// from the reach graph of reaches-<ver>.json (public, or the owner variant on the owner site), never from a station's
// own river_id and never from a hard-coded list. Pure.

export interface Column {
  /** The station id (stations.json). */
  id: string;
  /** As published: untrusted text, data only. */
  name: string;
  /** The river of the station's reach in the graph (not the station's own river_id). */
  riverId: string;
  /** −km_to_nl_entry: 0 at the NL entry node, growing downstream (km). Strictly increasing along `columns`. */
  x: number;
  tier: 1 | 2;
  /** The station's reach is tidal (reach flags), or the station's own flag says so: a hatched column. */
  tidal: boolean;
  /** The station has a series of an owner-audience source (owner site only): the "owner only" badge. */
  owner: boolean;
}

export interface Gap {
  /** x of the column before the gap. */
  fromX: number;
  /** x of the column after it. */
  toX: number;
  /** 'wallonia': the Walloon Meuse without a column (the public site); 'plain': any other stretch over GAP_KM. */
  kind: 'wallonia' | 'plain';
  /** toX − fromX (km). */
  km: number;
}

export interface HovPath {
  columns: readonly Column[];
  gaps: readonly Gap[];
}

interface PathSpec {
  /** The rivers of the path, main stem first: a higher index wins at a bifurcation. */
  rivers: readonly string[];
  start: string;
  /** The last station of the path, when it ends at a station rather than where the river ends. */
  end?: string;
}

const PATHS: Record<HovPathId, PathSpec> = {
  'rhine-waal': { rivers: ['rhine', 'waal'], start: 'ch.bafu.2289' },
  'rhine-lek': { rivers: ['rhine', 'pannerdensch-kanaal', 'nederrijn', 'lek'], start: 'ch.bafu.2289' },
  'rhine-ijssel': { rivers: ['rhine', 'pannerdensch-kanaal', 'nederrijn', 'ijssel'], start: 'ch.bafu.2289' },
  meuse: { rivers: ['meuse'], start: 'fr.sandre.B720000001', end: 'nl.rws.lith.beneden' },
};

/** The reaches of the path: the start reach and, downstream, the highest-ranked listed river at every split. */
function visitedReaches(graph: ReachGraph, spec: PathSpec, startReach: string): Set<string> {
  const { reaches } = indexOf(graph);
  const rank = (id: string) => spec.rivers.indexOf(reaches.get(id)?.river_id ?? '');
  const seen = new Set<string>([startReach]);
  // The seen set ends a cycle; a split is at most 20 wide (the contract), so the walk is bounded by the file.
  const todo = [startReach];
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    const next = (reaches.get(id)?.downstream ?? []).filter((d) => rank(d) >= 0 && !seen.has(d));
    const top = Math.max(...next.map(rank));
    for (const d of next.filter((n) => rank(n) === top)) {
      seen.add(d);
      todo.push(d);
    }
  }
  return seen;
}

/** D-3 and the same-km rule: of a weir pair or of stations at one chainage the best column stays. */
const better = (a: Column, b: Column) =>
  Number(a.owner) - Number(b.owner) || a.tier - b.tier || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildPath(
  id: HovPathId,
  graph: ReachGraph,
  stations: readonly ApiStation[],
  ownerSources: ReadonlySet<string>,
): HovPath {
  const spec = PATHS[id];
  const ix = indexOf(graph);
  const start = ix.stations.get(spec.start);
  const startReach = start?.reach_id;
  const last = spec.end === undefined ? undefined : ix.stations.get(spec.end);
  if (startReach === undefined || startReach === null || typeof start?.km_to_nl_entry !== 'number')
    return { columns: [], gaps: [] };
  const visited = visitedReaches(graph, spec, startReach);
  const byId = new Map(stations.map((s) => [s.id, s]));
  const kmMax = start.km_to_nl_entry;
  const kmMin = typeof last?.km_to_nl_entry === 'number' ? last.km_to_nl_entry : -Infinity;

  const members: Column[] = [];
  for (const g of graph.stations) {
    const km = g.km_to_nl_entry;
    const st = byId.get(g.id);
    if (st === undefined || typeof km !== 'number' || !Number.isFinite(km) || km > kmMax || km < kmMin) continue;
    if (g.reach_id === null || !visited.has(g.reach_id)) continue;
    members.push({
      id: g.id,
      name: st.name,
      riverId: ix.reaches.get(g.reach_id)?.river_id ?? g.river_id,
      x: 0 - km,
      tier: st.tier,
      tidal: ix.reaches.get(g.reach_id)?.flags?.tidal === true || st.flags.tidal === true,
      owner: st.series.some((s) => ownerSources.has(s.source)),
    });
  }

  // D-3: a <base>.boven/<base>.beneden pair is one column, the lower tier, a tie the .boven.
  const dropped = new Set<string>();
  const ids = new Map(members.map((c) => [c.id, c]));
  for (const c of members) {
    const below = c.id.endsWith('.boven') ? ids.get(`${c.id.slice(0, -'.boven'.length)}.beneden`) : undefined;
    if (below !== undefined) dropped.add(below.tier < c.tier ? c.id : below.id);
  }
  const sorted = members.filter((c) => !dropped.has(c.id)).sort((a, b) => a.x - b.x || better(a, b));
  // Exact same-km duplicates: the sort put the best first. No proximity merge.
  const columns = sorted.filter((c, i) => i === 0 || c.x !== (sorted[i - 1] as Column).x);

  const gaps: Gap[] = [];
  for (let i = 1; i < columns.length; i++) {
    const [a, b] = [columns[i - 1] as Column, columns[i] as Column];
    if (b.x - a.x > GAP_KM)
      gaps.push({ fromX: a.x, toX: b.x, kind: id === 'meuse' && b.x <= 0 ? 'wallonia' : 'plain', km: b.x - a.x });
  }
  return { columns, gaps };
}
