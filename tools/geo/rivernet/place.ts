import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Audience } from '../../../packages/contracts/src/registry.ts';
import {
  type SnapOverridesFile,
  type SnapRule,
  validateSnapOverrides,
} from '../../../packages/contracts/src/rivernet.ts';
import type { RiversFile, TravelTime } from '../../../packages/contracts/src/rivers.ts';
import { BuildError, type Edge, ROOT } from './build.ts';
import { buildNetwork, byString, fromSource, type LonLat, type Network, toTargets } from './network.ts';
import { type BuiltReach, cutReaches } from './reaches.ts';
import { nearestOnRiver, type Placement, snapStations } from './snap.ts';
import type { StationInput } from './stations.ts';

// P6b placement (ADR-0012): every registry station snapped, given chainage and
// a reach; the reaches cut at public stations only. Pure: graph edges, rivers,
// stations and overrides in, the same result for the same input.
//
// Chainage of a placed station:
//   km_official  the operator's own km: a reviewed override (RWS rkm), else
//                the DE-1 value; never derived, never invented
//   km_graph     km along its river from the river's sources (longest path);
//                rises downstream; restarts per river
//   km_to_nl_entry  km to the nearest NL entry node DOWNSTREAM (positive), or,
//                when none lies downstream, minus the km FROM the entry node
//                upstream of it (its own river's first): positive outside NL,
//                0 at the node, negative below it; falls downstream throughout

export interface PlacedStation {
  id: string;
  source: string;
  audience: Audience;
  public: boolean;
  rule: SnapRule;
  override: boolean;
  river: string | null;
  placement: Placement | null;
  reach: string | null;
  km_official: number | null;
  km_official_system: string | null;
  km_graph: number | null;
  km_to_nl_entry: number | null;
  nl_entry_node: string | null;
}

export interface Placed {
  net: Network;
  stations: PlacedStation[];
  reaches: BuiltReach[];
  /** The curated travel-time pairs whose two stations are public and placed. */
  travel: TravelTime[];
}

const km2 = (m: number) => Math.round(m / 10) / 100;

export function readOverrides(
  rivers: RiversFile,
  path = join(ROOT, 'registry/snap-overrides.yaml'),
): SnapOverridesFile {
  const { problems, overrides } = validateSnapOverrides(
    parse(readFileSync(path, 'utf8')),
    new Set(rivers.rivers.map((r) => r.id)),
  );
  if (overrides === undefined) throw new BuildError('overrides_invalid', problems);
  return overrides;
}

export function place(
  edges: readonly Edge[],
  rivers: RiversFile,
  stations: readonly StationInput[],
  overrides: SnapOverridesFile,
): Placed {
  const net = buildNetwork(edges, rivers);
  const snaps = snapStations(net, stations, overrides);
  const kmAt = (river: string, p: Placement) =>
    (net.kmGraph.get(river)?.get((net.edges.get(p.edge) as Edge).from) ?? 0) + p.offset_m;

  // Entry distances: every node to its nearest entry downstream; from each entry to every node below it.
  const down = toTargets(
    net,
    net.entries.map((e) => e.node),
  );
  const entryByNode = new Map(net.entries.map((e) => [e.node, e]));
  const below = net.entries.map((e) => ({ e, d: fromSource(net, e.node) }));
  const entryOf = (river: string, p: Placement): { km: number; id: string } | null => {
    const e = net.edges.get(p.edge) as Edge;
    const atStart = p.offset_m === 0 ? entryByNode.get(e.from) : undefined;
    if (atStart !== undefined) return { km: 0, id: atStart.id };
    const d = down.get(e.to);
    if (d !== undefined) return { km: km2(e.length_m - p.offset_m + d.d), id: entryByNode.get(d.target)?.id as string };
    const up = below
      .filter((x) => x.d.has(e.from))
      .map((x) => ({ id: x.e.id, own: x.e.river === river, m: (x.d.get(e.from)?.d as number) + p.offset_m }))
      .sort((a, b) => Number(b.own) - Number(a.own) || a.m - b.m || byString(a.id, b.id))[0];
    return up === undefined ? null : { km: -km2(up.m), id: up.id };
  };

  const overrideKm = new Map(
    overrides.stations.filter((o) => o.km_official !== undefined).map((o) => [o.station, o.km_official]),
  );
  const byId = new Map(stations.map((s) => [s.id, s]));
  const placed: PlacedStation[] = snaps.map((snap) => {
    const s = byId.get(snap.id) as StationInput;
    const ok = overrideKm.get(s.id);
    const official = ok !== undefined ? { value: ok.value, system: ok.system } : s.km;
    const at = snap.placement !== null && snap.river !== null ? entryOf(snap.river, snap.placement) : null;
    return {
      id: s.id,
      source: s.source,
      audience: s.audience,
      public: s.public,
      rule: snap.rule,
      override: snap.override,
      river: snap.river,
      placement: snap.placement,
      reach: null,
      km_official: official?.value ?? null,
      km_official_system: official?.system ?? null,
      km_graph: snap.placement !== null && snap.river !== null ? km2(kmAt(snap.river, snap.placement)) : null,
      km_to_nl_entry: at?.km ?? null,
      nl_entry_node: at?.id ?? null,
    };
  });

  // Reaches: cut at public placed stations only.
  const { reaches, reachOf } = cutReaches(
    net,
    placed
      .filter((p) => p.public && p.placement !== null)
      .map((p) => ({ station: p.id, placement: p.placement as Placement })),
    kmAt,
  );
  for (const p of placed) if (p.placement !== null) p.reach = reachOf(p.placement);

  // Flags: a reach of river r inside a curated stretch of r (by its midpoint's km_graph); a bound is the nearest
  // point of r's line to the curated coordinate, at most 2 km away.
  const kmNear = (river: string, at: LonLat): number => {
    const p = nearestOnRiver(net, river, at, 2000);
    if (p === null) throw new BuildError('flag_unplaced', [river]);
    return kmAt(river, p);
  };
  for (const river of rivers.rivers) {
    for (const f of river.flags ?? []) {
      const lo = f.from === undefined ? Number.NEGATIVE_INFINITY : kmNear(river.id, f.from);
      const hi = f.to === undefined ? Number.POSITIVE_INFINITY : kmNear(river.id, f.to);
      for (const r of reaches) {
        const mid = (r.km_graph_from + r.km_graph_to) / 2;
        if (r.river === river.id && mid >= Math.min(lo, hi) && mid <= Math.max(lo, hi)) r.flags[f.kind] = true;
      }
    }
  }

  // Travel times: only sourced pairs between two public placed stations; a reach carries one only when the
  // pair is exactly its two ends.
  const shown = new Set(placed.filter((p) => p.public && p.river !== null).map((p) => p.id));
  const travel = (rivers.travel_times ?? []).filter((t) => shown.has(t.from_station) && shown.has(t.to_station));
  for (const r of reaches) {
    const t = travel.find((x) => x.from_station === r.up_station && x.to_station === r.down_station);
    if (t !== undefined) {
      r.travel_time_h = [t.h[0], t.h[1]];
      r.travel_time_source = t.source;
    }
  }
  return { net, stations: placed, reaches, travel };
}
