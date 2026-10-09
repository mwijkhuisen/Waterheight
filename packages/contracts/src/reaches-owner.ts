import { z } from 'zod';
import { Reach, ReachesFile, ReachId, ReachStation } from './reaches.ts';

// Server only (P11a, D-C): the owner variant of reaches-<ver>.json, the public release's reaches split at the owner
// stations (publish-owner, written to the owner tree and served by owner.caddy only). A split reach `<river>.<seq>`
// becomes the parts `<river>.<seq>-<k>` (k from 1, in graph order), each with `part_of` naming the reach it came from;
// every other field is the public file's. Like static-owner, the web never imports this module
// (`@rws/contracts/reaches-owner`, not re-exported from the index; check-boundaries), so no owner shape reaches the
// public bundle, and the public `ReachesFile` stays byte-identical.

/** `<river>.<seq>` or a part of it, `<river>.<seq>-<k>`. */
export const OwnerReachId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}\.[1-9][0-9]{0,5}(?:-[1-9][0-9]{0,3})?$/, 'must be <river>.<seq> or <river>.<seq>-<k>');

const OwnerReach = Reach.extend({
  id: OwnerReachId,
  upstream: z.array(OwnerReachId).max(20),
  downstream: z.array(OwnerReachId).max(20),
  /** The public reach this part was cut from; absent on a reach that was not split. */
  part_of: ReachId.optional(),
});

export const OwnerReachesFile = ReachesFile.extend({
  reaches: z.array(OwnerReach).max(50_000),
  stations: z.array(ReachStation.extend({ reach_id: OwnerReachId.nullable() })).max(10_000),
});
export type OwnerReachesFile = z.infer<typeof OwnerReachesFile>;

const ID = /^(.+)\.([1-9][0-9]*)(?:-([1-9][0-9]*))?$/;

/**
 * What the schema cannot say alone: unique ids, every reference resolving, and the parts of a reach in a clean chain
 * (ids `<river>.<seq>-<k>` with k = 1..n, `part_of` the reach they replace, which is no longer in the file, each part
 * ending where the next starts and only the first keeping the bifurcation). Problems, or none.
 */
export function checkOwnerReaches(f: OwnerReachesFile): string[] {
  const problems: string[] = [];
  const rivers = new Set(f.rivers.map((r) => r.id));
  const reaches = new Map<string, OwnerReachesFile['reaches'][number]>();
  const parts = new Map<string, OwnerReachesFile['reaches']>();
  for (const r of f.reaches) {
    if (reaches.has(r.id)) problems.push(`reach ${r.id} twice`);
    reaches.set(r.id, r);
    if (!rivers.has(r.river_id)) problems.push(`reach ${r.id}: unknown river ${r.river_id}`);
    const m = ID.exec(r.id);
    if (m === null || m[1] !== r.river_id || Number(m[2]) !== r.seq) {
      problems.push(`reach ${r.id} is not ${r.river_id}.${r.seq}[-k]`);
      continue;
    }
    if (m[3] === undefined) {
      if (r.part_of !== undefined) problems.push(`reach ${r.id}: part_of without a part id`);
    } else if (r.part_of !== `${r.river_id}.${r.seq}`) {
      problems.push(`reach ${r.id}: part_of is not ${r.river_id}.${r.seq}`);
    } else {
      parts.set(r.part_of, [...(parts.get(r.part_of) ?? []), r]);
    }
  }
  for (const [whole, list] of parts) {
    if (reaches.has(whole)) problems.push(`reach ${whole} is still in the file beside its parts`);
    list.forEach((p, i) => {
      if (p.id !== `${whole}-${i + 1}`) problems.push(`parts of ${whole}: ${p.id} is not part ${i + 1}`);
      const next = list[i + 1];
      if (next !== undefined) {
        if (!p.downstream.includes(next.id) || !next.upstream.includes(p.id))
          problems.push(`parts of ${whole}: ${p.id} and ${next.id} are not linked`);
        if (p.km_graph_to !== next.km_graph_from)
          problems.push(`parts of ${whole}: ${p.id} does not end where ${next.id} starts`);
      }
      if (i > 0 && p.flags.bifurcation) problems.push(`parts of ${whole}: ${p.id} is a bifurcation`);
    });
  }
  for (const r of f.reaches)
    for (const n of [...r.upstream, ...r.downstream]) if (!reaches.has(n)) problems.push(`reach ${r.id}: unknown ${n}`);
  const stations = new Set<string>();
  for (const s of f.stations) {
    if (stations.has(s.id)) problems.push(`station ${s.id} twice`);
    stations.add(s.id);
    if (!rivers.has(s.river_id)) problems.push(`station ${s.id}: unknown river ${s.river_id}`);
    if (s.reach_id !== null && !reaches.has(s.reach_id)) problems.push(`station ${s.id}: unknown reach ${s.reach_id}`);
  }
  for (const r of f.reaches)
    for (const s of [r.up_station_id, r.down_station_id])
      if (s !== null && !stations.has(s)) problems.push(`reach ${r.id}: unknown station ${s}`);
  for (const t of f.travel_times)
    for (const s of [t.from_station_id, t.to_station_id])
      if (!stations.has(s)) problems.push(`travel time: unknown station ${s}`);
  for (const e of f.nl_entry_nodes) if (!rivers.has(e.river_id)) problems.push(`entry ${e.id}: unknown river`);
  return problems;
}
