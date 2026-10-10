import type { ReachGraph } from '../../../lib/data/contracts.ts';
import { type GReach, type GStation, indexOf } from '../../station/neighbours.ts';
import { placeKey } from '../chain.ts';
import { binCount } from './bins.ts';

// The spans of the reach colouring (P11b, issue #26): a span is the run of reaches from a station to the next
// station downstream on the same river (reaches-<ver>.json; a reach itself starts and ends at a confluence, a
// bifurcation, a change of river or a station). Each tile feature (one public reach) is coloured at its own chainage
// midpoint on its span. Pure; the walk reuses P11a's index, co-location and sink rules (station/neighbours.ts).
// On the owner variant (`part_of`), a public reach takes the span of the owner part that holds its midpoint (D-2).

/** The closed span a reach lies on: a station group at each end. */
export interface Span {
  /** The up end's station group: co-located stations in file order, only ids of `known`. */
  up: readonly string[];
  /** The down end's station group, likewise. */
  down: readonly string[];
  /** The span's length in km; null when a reach on its path has no length (never interpolated). */
  lengthKm: number | null;
  /** Where the reach's chainage midpoint lies along the span, 0 (up end) … 1 (down end); null when unknown. */
  pos: number | null;
  /** A reach on the span's path is tidal, or has unknown flags: no reach of the span is interpolated. */
  tidal: boolean;
}

/** One public tile reach. */
export interface FeatureSpan {
  /** The reach's own flags; null when the file has none (unknown: never interpolated). */
  tidal: boolean | null;
  impounded: boolean | null;
  /** Its closed span, or null when it lies only on open paths (a river head, a tributary's last stretch). */
  span: Span | null;
  /**
   * #112: the span of each of its position bins (`binCount` of its length; tile ids `<reach_id>/<i>`), each at the
   * bin's centre; on the owner variant each centre lies in the owner part that holds it (its own span).
   */
  bins: readonly (Span | null)[];
}

/** Reaches visited per start: a cycle or a huge delta ends the walk instead of the tab. */
const WALK_CAP = 2000;

/** A closed path's facts for one graph reach: its ends and where the reach lies on it (null = a length is unknown). */
interface Placed {
  up: readonly string[];
  down: readonly string[];
  total: number | null;
  before: number | null;
  tidal: boolean;
}

function placeAll(graph: ReachGraph, known: ReadonlySet<string>): Map<string, Placed> {
  const ix = indexOf(graph);
  const places = new Map<string, GStation[]>();
  for (const s of graph.stations) {
    if (s.reach_id === null || s.km_graph === null) continue;
    const k = placeKey(s);
    places.set(k, [...(places.get(k) ?? []), s]);
  }
  /** The known stations at a reach end: the named one first-come in file order with its co-located ones. */
  const group = (id: string | null): string[] => {
    const s = id === null ? undefined : ix.stations.get(id);
    if (s === undefined) return [];
    const same = s.reach_id === null || s.km_graph === null ? [s] : (places.get(placeKey(s)) ?? [s]);
    return same.filter((o) => known.has(o.id)).map((o) => o.id);
  };
  const startOf = new Map<string, string[]>();
  const endOf = new Map<string, string[]>();
  for (const r of graph.reaches) {
    startOf.set(r.id, group(r.up_station_id));
    endOf.set(r.id, group(r.down_station_id));
  }
  const out = new Map<string, Placed>();
  const close = (stack: readonly GReach[], up: readonly string[], down: readonly string[]) => {
    const lens = stack.map((r) => r.length_km);
    const unknown = lens.includes(null) || stack.some((r) => r.flags === null);
    const total = unknown ? null : stack.reduce((a, r) => a + (r.length_km ?? 0), 0);
    let before = 0;
    for (const [i, r] of stack.entries()) {
      if (!out.has(r.id))
        out.set(r.id, {
          up,
          down,
          total,
          before: unknown ? null : before,
          tidal: stack.some((x) => x.flags === null || x.flags.tidal),
        });
      before += lens[i] ?? 0;
    }
  };
  for (const first of graph.reaches) {
    const up = startOf.get(first.id) ?? [];
    if (up.length === 0) continue;
    let budget = WALK_CAP;
    const stack: GReach[] = [];
    const onPath = new Set<string>();
    const visit = (r: GReach) => {
      if (budget <= 0 || onPath.has(r.id)) return;
      budget -= 1;
      stack.push(r);
      onPath.add(r.id);
      const end = endOf.get(r.id) ?? [];
      if (end.length > 0) close(stack, up, end);
      else
        for (const id of r.downstream) {
          const n = ix.reaches.get(id);
          if (n === undefined || n.river_id !== r.river_id) continue;
          const start = startOf.get(n.id) ?? [];
          if (start.length > 0) close(stack, up, start);
          else visit(n);
        }
      stack.pop();
      onPath.delete(r.id);
    };
    visit(first);
  }
  return out;
}

const flag = (parts: readonly (boolean | undefined)[]): boolean | null =>
  parts.includes(true) ? true : parts.includes(undefined) ? null : false;

/**
 * Every public tile reach of `graph` (public file or owner variant) by its public id. `known` is the site's
 * stations.json ids: only those end a span.
 */
export function spansOf(graph: ReachGraph, known: ReadonlySet<string>): Map<string, FeatureSpan> {
  const placed = placeAll(graph, known);
  const out = new Map<string, FeatureSpan>();
  const at = (r: GReach, d: number | null): Span | null => {
    const p = placed.get(r.id);
    if (p === undefined) return null;
    const pos =
      p.total === null || p.before === null || d === null ? null : p.total === 0 ? 0.5 : (p.before + d) / p.total;
    return {
      up: p.up,
      down: p.down,
      lengthKm: p.total,
      pos,
      tidal: p.tidal,
    };
  };
  const whole = new Map<string, GReach[]>();
  for (const r of graph.reaches) {
    if (r.part_of === undefined) {
      const len = r.length_km;
      const n = binCount(len);
      out.set(r.id, {
        tidal: r.flags?.tidal ?? null,
        impounded: r.flags?.impounded ?? null,
        span: at(r, len === null ? null : len / 2),
        bins: Array.from({ length: n }, (_, i) => at(r, len === null ? null : ((i + 0.5) * len) / n)),
      });
    } else whole.set(r.part_of, [...(whole.get(r.part_of) ?? []), r]);
  }
  // D-2: a public reach cut into parts takes the span of the part that holds its length midpoint, at that point.
  const partNo = (r: GReach) => Number(r.id.slice(r.id.lastIndexOf('-') + 1));
  for (const [id, list] of whole) {
    const parts = list.toSorted((a, b) => partNo(a) - partNo(b));
    const lens = parts.map((r) => r.length_km);
    const mid = lens.includes(null) ? null : parts.reduce((a, r) => a + (r.length_km ?? 0), 0);
    /** The span at `d` km along the whole public reach: in the part that holds it, at its own offset. */
    const along = (d: number): Span | null => {
      let c = 0;
      for (const [i, r] of parts.entries()) {
        const len = lens[i] as number;
        if (c + len >= d || i === parts.length - 1) return at(r, d - c);
        c += len;
      }
      return null;
    };
    let span: Span | null = null;
    let bins: (Span | null)[];
    if (mid === null) {
      const first = parts.find((r) => placed.has(r.id));
      span = first === undefined ? null : at(first, null);
      bins = [span];
    } else {
      span = along(mid / 2);
      const n = binCount(mid);
      bins = Array.from({ length: n }, (_, i) => along(((i + 0.5) * mid) / n));
    }
    out.set(id, {
      tidal: flag(parts.map((r) => r.flags?.tidal)),
      impounded: flag(parts.map((r) => r.flags?.impounded)),
      span,
      bins,
    });
  }
  return out;
}
