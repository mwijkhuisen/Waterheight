import type { ReachesFile, RivernetFile } from '@rws/contracts';
import type { OwnerReachesFile } from '@rws/contracts/reaches-owner';

// P11a (D-C): the owner variant of the installed river release, pure. Each owner station (owner stations.json ∩
// rivernet.yaml, placed with a river and a km_graph, not already in the release) splits the release reach it falls
// on, at its km_graph calibrated per river against the public stations both files place. Reach ids of the release are
// renumbered per build (KG-162/164), so nothing here joins a reach id of rivernet.yaml: a station is placed by its
// river and its km only. The public file is never touched; the result is a new object.

/** Why an owner station got no place in the variant (fixed codes only: never provider text). */
export type OwnerSkipCode = 'owner_reach_ambiguous' | 'owner_reach_unplaced';

export interface SplitResult {
  file: OwnerReachesFile;
  skipped: { id: string; code: OwnerSkipCode }[];
}

/** Within this many km of a public station (or of an earlier owner station) a point is co-located: no split. */
export const CO_LOCATED_KM = 0.05;
const TOL = 1e-9;

type Reach = ReachesFile['reaches'][number];
type OwnerReach = OwnerReachesFile['reaches'][number];
type OwnerStation = OwnerReachesFile['stations'][number];
type Placement = Pick<RivernetFile, 'stations'>['stations'][number];

const km2 = (x: number) => Math.round(x * 100) / 100;
const km3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Maps a km_graph of rivernet.yaml (the committed fixture build) to the release's, per river, piecewise-linearly
 * between the public stations that both files place; beyond the first and last anchor the nearest anchor's offset
 * holds, and a river without an anchor keeps its raw km.
 * ponytail: the ceiling is the fixture's age against the release (KG-164) and parallel branches of one river that
 * restart their km (the Meuse headwaters) mixing into one anchor list; upgrade path: refresh the fixture
 * (`scripts/gen-rivernet.ts`) with each geo release, or carry the fixture's reach geometry into the registry.
 */
function calibrator(release: ReachesFile, placed: ReadonlyMap<string, Placement>) {
  const byRiver = new Map<string, [raw: number, rel: number][]>();
  for (const s of release.stations) {
    const p = placed.get(s.id);
    if (s.km_graph === null || p === undefined || p.river !== s.river_id || p.km_graph === null) continue;
    byRiver.set(s.river_id, [...(byRiver.get(s.river_id) ?? []), [p.km_graph, s.km_graph]]);
  }
  for (const [river, list] of byRiver) {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    byRiver.set(
      river,
      list.filter((a, i) => i === 0 || a[0] !== (list[i - 1] as [number, number])[0]),
    );
  }
  return (river: string, raw: number): number => {
    const a = byRiver.get(river);
    const first = a?.[0];
    const last = a?.at(-1);
    if (a === undefined || first === undefined || last === undefined) return raw;
    if (raw <= first[0]) return km2(raw + (first[1] - first[0]));
    if (raw >= last[0]) return km2(raw + (last[1] - last[0]));
    const i = a.findIndex((x) => x[0] >= raw);
    const hi = a[i] as [number, number];
    const lo = a[i - 1] as [number, number];
    return km2(lo[1] + ((raw - lo[0]) / (hi[0] - lo[0])) * (hi[1] - lo[1]));
  };
}

/** One position on a split reach: the owner stations that share it (alphabetically first is the reach's station). */
type Cluster = { km: number; frac: number; members: Placement[] };

export function splitReaches(
  release: ReachesFile,
  owner: ReadonlySet<string>,
  rivernet: Pick<RivernetFile, 'stations'>,
): SplitResult {
  const placed = new Map(rivernet.stations.map((s) => [s.id, s]));
  const inRelease = new Set(release.stations.map((s) => s.id));
  const calibrate = calibrator(release, placed);
  const skipped: SplitResult['skipped'] = [];

  const reachesOf = new Map<string, Reach[]>();
  for (const r of release.reaches) reachesOf.set(r.river_id, [...(reachesOf.get(r.river_id) ?? []), r]);
  const publicOf = new Map<string, ReachesFile['stations']>();
  for (const s of release.stations)
    if (s.km_graph !== null && s.reach_id !== null) publicOf.set(s.river_id, [...(publicOf.get(s.river_id) ?? []), s]);

  // 1. Place every point: co-located with a public station, on exactly one reach, or skipped.
  const calibrated = new Map<string, number>();
  const colocated: { st: Placement; at: ReachesFile['stations'][number] }[] = [];
  const onReach = new Map<string, { st: Placement; km: number }[]>();
  const points = rivernet.stations
    .filter((s) => owner.has(s.id) && !inRelease.has(s.id) && s.river !== null && s.km_graph !== null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const st of points) {
    const river = st.river as string;
    const km = calibrate(river, st.km_graph as number);
    calibrated.set(st.id, km);
    const near = (publicOf.get(river) ?? [])
      .filter((s) => Math.abs((s.km_graph as number) - km) <= CO_LOCATED_KM + TOL)
      .sort(
        (a, b) =>
          Math.abs((a.km_graph as number) - km) - Math.abs((b.km_graph as number) - km) || (a.id < b.id ? -1 : 1),
      )[0];
    if (near !== undefined) {
      colocated.push({ st, at: near });
      continue;
    }
    const hits = (reachesOf.get(river) ?? []).filter(
      (r) =>
        Math.min(r.km_graph_from, r.km_graph_to) - TOL <= km && km <= Math.max(r.km_graph_from, r.km_graph_to) + TOL,
    );
    const hit = hits[0];
    if (hits.length !== 1 || hit === undefined) {
      skipped.push({ id: st.id, code: hits.length === 0 ? 'owner_reach_unplaced' : 'owner_reach_ambiguous' });
      continue;
    }
    onReach.set(hit.id, [...(onReach.get(hit.id) ?? []), { st, km }]);
  }

  // 2. The clusters of each split reach, in graph order along it.
  const reachById = new Map(release.reaches.map((r) => [r.id, r]));
  const clusters = new Map<string, Cluster[]>();
  for (const [id, list] of onReach) {
    const r = reachById.get(id) as Reach;
    const span = r.km_graph_to - r.km_graph_from;
    const frac = (km: number) => (span === 0 ? 0 : Math.min(1, Math.max(0, (km - r.km_graph_from) / span)));
    const out: Cluster[] = [];
    for (const p of [...list].sort((a, b) => frac(a.km) - frac(b.km) || (a.st.id < b.st.id ? -1 : 1))) {
      const last = out.at(-1);
      if (last !== undefined && Math.abs(p.km - last.km) <= CO_LOCATED_KM + TOL) last.members.push(p.st);
      else out.push({ km: p.km, frac: frac(p.km), members: [p.st] });
    }
    clusters.set(id, out);
  }

  // 3. The reaches: a split one becomes its parts; every reference to it follows to the first or the last part.
  const firstOf = (id: string) => (clusters.has(id) ? `${id}-1` : id);
  const lastOf = (id: string) => (clusters.has(id) ? `${id}-${(clusters.get(id) as Cluster[]).length + 1}` : id);
  const repOf = (c: Cluster) => (c.members[0] as Placement).id;
  const reaches: OwnerReach[] = [];
  for (const r of release.reaches) {
    const cs = clusters.get(r.id);
    if (cs === undefined) {
      reaches.push({ ...r, upstream: r.upstream.map(lastOf), downstream: r.downstream.map(firstOf) });
      continue;
    }
    const n = cs.length + 1;
    const km = [r.km_graph_from, ...cs.map((c) => c.km), r.km_graph_to];
    // Cumulative lengths are rounded, then differenced: the parts add up to the reach.
    const cum = [0, ...cs.map((c) => km3(r.length_km * c.frac)), r.length_km];
    for (let k = 1; k <= n; k++) {
      reaches.push({
        id: `${r.id}-${k}`,
        river_id: r.river_id,
        seq: r.seq,
        up_station_id: k === 1 ? r.up_station_id : repOf(cs[k - 2] as Cluster),
        down_station_id: k === n ? r.down_station_id : repOf(cs[k - 1] as Cluster),
        length_km: km3((cum[k] as number) - (cum[k - 1] as number)),
        km_graph_from: km[k - 1] as number,
        km_graph_to: km[k] as number,
        flags: { ...r.flags, bifurcation: k === 1 && r.flags.bifurcation },
        travel_time_h: null,
        travel_time_source: null,
        upstream: k === 1 ? r.upstream.map(lastOf) : [`${r.id}-${k - 1}`],
        downstream: k === n ? r.downstream.map(firstOf) : [`${r.id}-${k + 1}`],
        part_of: r.id,
      });
    }
  }

  // 4. The stations: a public one on a split reach stays at the end of it that it sits on; an owner one is in the part
  // that starts at its position (or, co-located, wherever the public station is).
  const partOfPublic = (s: ReachesFile['stations'][number]): string | null => {
    if (s.reach_id === null || !clusters.has(s.reach_id)) return s.reach_id;
    const r = reachById.get(s.reach_id) as Reach;
    const k = s.km_graph;
    const atEnd = k !== null && Math.abs(k - r.km_graph_to) < Math.abs(k - r.km_graph_from);
    return atEnd ? lastOf(r.id) : firstOf(r.id);
  };
  const stations: OwnerStation[] = release.stations.map((s) => ({ ...s, reach_id: partOfPublic(s) }));
  for (const { st, at } of colocated)
    stations.push({
      id: st.id,
      river_id: at.river_id,
      reach_id: partOfPublic(at),
      km_official: st.km_official,
      km_official_system: st.km_official_system,
      km_graph: at.km_graph,
      km_to_nl_entry: at.km_to_nl_entry,
      nl_entry_node: at.nl_entry_node,
    });
  for (const [id, cs] of clusters)
    cs.forEach((c, i) => {
      for (const st of c.members)
        stations.push({
          id: st.id,
          river_id: st.river as string,
          reach_id: `${id}-${i + 2}`,
          km_official: st.km_official,
          km_official_system: st.km_official_system,
          km_graph: c.km,
          // Downstream kilometres shrink as km_graph grows: carry the calibration shift over.
          km_to_nl_entry: st.km_to_nl_entry === null ? null : km2(st.km_to_nl_entry - (c.km - (st.km_graph as number))),
          nl_entry_node: st.nl_entry_node,
        });
    });
  stations.sort((a, b) => (a.id < b.id ? -1 : 1));
  skipped.sort((a, b) => (a.id < b.id ? -1 : 1));

  return { file: { ...release, reaches, stations }, skipped };
}
