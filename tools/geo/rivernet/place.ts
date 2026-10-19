import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Audience } from '../../../packages/contracts/src/registry.ts';
import {
  type SnapOverridesFile,
  type SnapRule,
  validateSnapOverrides,
  type WaterbodyRule,
} from '../../../packages/contracts/src/rivernet.ts';
import {
  type RiversFile,
  type TravelEmpirical,
  type TravelTime,
  validateTravelEmpirical,
} from '../../../packages/contracts/src/rivers.ts';
import type { WaterbodiesFile } from '../../../packages/contracts/src/waterbodies.ts';
import { BuildError, type Edge, ROOT } from './build.ts';
import { buildNetwork, byString, fromSource, type LonLat, type Network, toTargets } from './network.ts';
import { contains, type PreparedArea, prepareArea, shoreDistance } from './polygon.ts';
import { type BuiltReach, cutReaches } from './reaches.ts';
import { type EdgeIndex, nearestOnRiver, type Placement, snapStations } from './snap.ts';
import type { StationInput } from './stations.ts';
import { readWaterbodies, type WaterbodyInput } from './waterbodies.ts';

// P6b placement (ADR-0012): every registry station snapped, given chainage and
// a reach; the reaches cut at public stations only. Pure: graph edges, rivers,
// stations and overrides in, the same result for the same input. P17b: a station of a canal lies on the canal's
// edge (`canal`, never a Placement: no reach or chainage), and every station may have a water body by identity.
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
  /** P17b (D-3): the canal whose edge the station snapped to (rule canal_edge; river, placement and reach null). */
  canal: string | null;
  canal_distance_m: number | null;
  /** P17b: the station's water body by identity (override or exact name), independent of the edge placement. */
  waterbody: string | null;
  waterbody_rule: WaterbodyRule | null;
  /** Metres to the polygon's shore (0 inside); null for a point-only body or no identity. */
  waterbody_distance_m: number | null;
}

export interface Placed {
  net: Network;
  stations: PlacedStation[];
  reaches: BuiltReach[];
  /** The curated travel-time pairs whose two stations are public and placed. */
  travel: TravelTime[];
  /** P17b: the water bodies the placement read (null: none given, no station gets one). */
  waterbodies: WaterbodyInput | null;
  /** P17b: the edges of canals only (direction_reason canal), before place() drops them: the `canals` tile layer. */
  canalEdges: readonly Edge[];
}

const km2 = (m: number) => Math.round(m / 10) / 100;

export function readOverrides(
  rivers: RiversFile,
  waterbodies: WaterbodiesFile | null = readWaterbodies(rivers),
  path = join(ROOT, 'registry/snap-overrides.yaml'),
): SnapOverridesFile {
  const { problems, overrides } = validateSnapOverrides(
    parse(readFileSync(path, 'utf8')),
    new Set(rivers.rivers.map((r) => r.id)),
    new Set((waterbodies?.waterbodies ?? []).map((w) => w.id)),
  );
  if (overrides === undefined) throw new BuildError('overrides_invalid', problems);
  return overrides;
}

/** registry/travel-empirical.yaml (P14f): the travel times measured on our own history; BuildError('empirical_invalid'). */
export function readEmpirical(path = join(ROOT, 'registry/travel-empirical.yaml')): TravelEmpirical {
  const { problems, empirical } = validateTravelEmpirical(parse(readFileSync(path, 'utf8')));
  if (empirical === undefined) throw new BuildError('empirical_invalid', problems);
  return empirical;
}

// What an empirical pair carries as a derived `travel_times` entry. The basis holds no digit (the site's ETA scan
// allows one in a travel row only beside "indicative"); the reach's source text names the quantity, classes and years.
export const EMPIRICAL_BASIS = 'empirical: cross-correlation of level or discharge changes by flow class';
export const EMPIRICAL_SOURCE = 'Water Radar (own computation)';
export const EMPIRICAL_URL = 'https://github.com/mwijkhuisen/Waterheight/blob/main/registry/travel-empirical.yaml';
export const empiricalSource = (p: TravelEmpirical['pairs'][number]): string =>
  `empirical: Δ${p.quantity} cross-correlation, ${Object.keys(p.classes).length}/3 flow classes (terciles at ${p.from_station}), ${p.years[0]}–${p.years[1]}`;

/** Metres from a polygon's shore within which an identified station still belongs to it (an override may widen it). */
export const WATERBODY_SHORE_M = 500;

type BodyFields = Pick<PlacedStation, 'waterbody' | 'waterbody_rule' | 'waterbody_distance_m'>;
const NO_BODY: BodyFields = { waterbody: null, waterbody_rule: null, waterbody_distance_m: null };
const round1 = (m: number) => Math.round(m * 10) / 10;

/**
 * P17b: a station's water body, independent of its edge placement. Identity first (the station's `waterbody`
 * override, else the one body whose `names[source]` holds its exact water name; geometry alone never assigns one),
 * then the geometry decides: a polygon body inside or within the shore limit, a point-only body only inside its
 * reviewed bbox (else a curation error).
 */
function waterbodyOf(
  s: StationInput,
  o: SnapOverridesFile['stations'][number] | undefined,
  input: WaterbodyInput,
  prepared: Map<string, PreparedArea>,
): BodyFields {
  const w = s.water_name;
  const id =
    o?.waterbody ?? input.file.waterbodies.find((b) => w !== null && (b.names[s.source] ?? []).includes(w))?.id;
  if (id === undefined) return NO_BODY;
  if (s.lon === null || s.lat === null) {
    if (o?.waterbody !== undefined) throw new BuildError('waterbody_without_coordinates', [s.id]);
    return NO_BODY;
  }
  const at: LonLat = [s.lon, s.lat];
  const body = input.file.waterbodies.find((b) => b.id === id);
  if (body === undefined) throw new BuildError('waterbody_unknown', [s.id]);
  if (body.osm === null) {
    const [west, south, east, north] = body.bbox as [number, number, number, number];
    if (at[0] < west || at[0] > east || at[1] < south || at[1] > north)
      throw new BuildError('waterbody_outside_bbox', [s.id]);
    return { waterbody: id, waterbody_rule: 'waterbody_named', waterbody_distance_m: null };
  }
  let area = prepared.get(id);
  if (area === undefined) {
    const raw = input.areas.get(id);
    if (raw === undefined) throw new BuildError('waterbody_area_missing', [id]);
    area = prepareArea(raw);
    prepared.set(id, area);
  }
  if (contains(area, at)) return { waterbody: id, waterbody_rule: 'waterbody_contains', waterbody_distance_m: 0 };
  const max = o?.waterbody_max_m ?? WATERBODY_SHORE_M;
  const d = shoreDistance(area, at, max);
  if (d <= max) return { waterbody: id, waterbody_rule: 'waterbody_shore', waterbody_distance_m: round1(d) };
  // Too far: the exact distance is reported (the bounded search only says "beyond the limit").
  return {
    waterbody: null,
    waterbody_rule: 'waterbody_too_far',
    waterbody_distance_m: round1(shoreDistance(area, at)),
  };
}

export function place(
  edges: readonly Edge[],
  rivers: RiversFile,
  stations: readonly StationInput[],
  overrides: SnapOverridesFile,
  empirical: TravelEmpirical | null = null,
  waterbodies: WaterbodyInput | null = null,
): Placed {
  const canalEdges = edges.filter((e) => e.direction_reason === 'canal');
  const canals = new Set(rivers.rivers.filter((r) => r.kind === 'canal').map((r) => r.id));
  // P17b (D-3): the canal index, from the edges as built (a canal's own edges and those it shares with a river),
  // before the strip below: a station whose river is a canal snaps to it (canal_edge) and never becomes a Placement.
  const onCanal = edges.filter((e) => e.rivers.some((r) => canals.has(r)));
  const canalIndex: EdgeIndex = {
    edges: new Map(onCanal.map((e) => [e.id, e])),
    riverEdges: new Map(
      [...canals].map((c) => [
        c,
        onCanal
          .filter((e) => e.rivers.includes(c))
          .map((e) => e.id)
          .sort(byString),
      ]),
    ),
  };
  // P17a: canals stay out of the network, so out of every reach, chainage and travel time. Their own edges are
  // dropped, and a canal id is stripped from an edge it shares with a river (a canal deeper in the parent tree would
  // otherwise be that edge's primary), so no canal has an edge in the network and a canal junction cuts no river's reach.
  const net = buildNetwork(
    edges
      .filter((e) => e.direction_reason !== 'canal')
      .map((e) => (e.rivers.some((r) => canals.has(r)) ? { ...e, rivers: e.rivers.filter((r) => !canals.has(r)) } : e)),
    rivers,
  );
  const snaps = snapStations(net, stations, overrides, canalIndex);
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
  const overrideOf = new Map(overrides.stations.map((o) => [o.station, o]));
  const prepared = new Map<string, PreparedArea>();
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
      canal: snap.canal,
      canal_distance_m: snap.canal_distance_m,
      ...(waterbodies === null ? NO_BODY : waterbodyOf(s, overrideOf.get(s.id), waterbodies, prepared)),
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
  for (const p of placed) if (p.placement !== null) p.reach = reachOf(p.placement, p.river as string);

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
  // A reach of a tidal-zone channel (P17a) is tidal throughout and never carries a travel time.
  const zone = new Set(rivers.rivers.filter((r) => r.tidal_zone).map((r) => r.id));
  for (const r of reaches) if (zone.has(r.river)) r.flags.tidal = true;

  // Travel times: only sourced pairs between two public placed stations; a reach carries one only when the
  // pair is exactly its two ends and the value is a range in hours.
  const shown = new Set(placed.filter((p) => p.public && p.river !== null).map((p) => p.id));
  const travel = (rivers.travel_times ?? []).filter((t) => shown.has(t.from_station) && shown.has(t.to_station));
  for (const r of reaches) {
    const t = travel.find((x) => x.from_station === r.up_station && x.to_station === r.down_station);
    if (t !== undefined && Array.isArray(t.h) && !zone.has(r.river)) {
      r.travel_time_h = [t.h[0], t.h[1]];
      r.travel_time_source = t.source;
    }
  }

  // Empirical pairs (P14f): public stations only, else the build fails (a sourced pair is dropped silently, this file
  // is ours and a wrong id is a mistake to see). A sourced pair of rivers.yaml for the same two stations always wins;
  // a reach without a pair keeps what it has. Each applied pair is also a derived `travel_times` entry.
  const known = new Map(placed.map((p) => [p.id, p]));
  const ids = (empirical?.pairs ?? []).flatMap((e) => [e.from_station, e.to_station]);
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new BuildError('empirical_unknown_station', [...new Set(unknown)].sort());
  const hidden = ids.filter((id) => known.get(id)?.public !== true);
  if (hidden.length > 0) throw new BuildError('empirical_non_public_station', [...new Set(hidden)].sort());
  const sourced = new Set((rivers.travel_times ?? []).map((t) => `${t.from_station} ${t.to_station}`));
  const used = new Set<string>();
  for (const e of empirical?.pairs ?? []) {
    const key = `${e.from_station} ${e.to_station}`;
    if (sourced.has(key)) continue;
    for (const r of reaches) {
      if (r.up_station !== e.from_station || r.down_station !== e.to_station || zone.has(r.river)) continue;
      r.travel_time_h = [e.h[0], e.h[1]];
      r.travel_time_source = empiricalSource(e);
      used.add(key);
    }
    if (used.has(key))
      travel.push({
        from_station: e.from_station,
        to_station: e.to_station,
        h: [e.h[0], e.h[1]],
        derived: true,
        basis: EMPIRICAL_BASIS,
        source: EMPIRICAL_SOURCE,
        source_url: EMPIRICAL_URL,
      });
  }
  return { net, stations: placed, reaches, travel, waterbodies, canalEdges };
}
