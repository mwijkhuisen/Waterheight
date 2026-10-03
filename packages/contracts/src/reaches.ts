import { z } from 'zod';

// /data/v1/rivers/reaches-<ver>.json (P6b; A§9.1): the public reaches of the
// river graph in graph order, their upstream/downstream adjacency, the public
// stations with their chainage, and the sourced travel-time ranges (catalogue
// §3.7: indicative, never an ETA). Written by tools/geo/rivernet in geo.yml and
// served immutable after rws-rivers-refresh. P11 reads it (the upstream chain,
// the Hovmöller km axis), so this module stays web-safe: it imports nothing of
// the registry, the health documents or the canaries.
//
// Reach ids are `<river>.<seq>` (seq in graph order along the river) and hold
// within one build only (KG-162): a new graph renumbers `seq`. The database
// keys its reaches by (river_id, seq) too, but they mirror the committed
// fixture build (`registry/rivernet.yaml`), not a release (KG-164), so nothing
// may join `station.reach_id` or a database reach to a release file: within a
// file, use its own `reach_id`s. A reach starts and ends at a confluence, a
// bifurcation, a change of river or a public station; `upstream`/`downstream`
// carry the topology, so no OSM node or edge id is published here. A station's
// `reach_id` is the reach starting at its position (the one ending there only
// at a sink). Public stations at one position share that reach; the
// alphabetically first of them is its `up_station_id` (and the
// `down_station_id` of the reaches ending there).

export const REACHES_SCHEMA_VERSION = 1;
export const RIVERS_VERSION_RE = /^[0-9]{8}$/;
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
export const ODBL_LICENCE = 'ODbL-1.0';
export const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
const StationRef = z
  .string()
  .max(80)
  .regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/);
const NodeId = z.string().regex(/^n[1-9][0-9]{0,15}$/);
const Name = z.string().min(1).max(80);
const Km = z.number().min(-5000).max(5000);

export const ReachId = z.string().regex(/^[a-z][a-z0-9-]{1,40}\.[1-9][0-9]{0,5}$/, 'must be <river>.<seq>');
export const ReachFlags = z.strictObject({ tidal: z.boolean(), impounded: z.boolean(), bifurcation: z.boolean() });
export type ReachFlags = z.infer<typeof ReachFlags>;
/** Hours [lo, hi], lo < hi: a range, never one number. */
export const TravelRange = z
  .tuple([z.number().positive(), z.number().positive()])
  .refine(([lo, hi]) => lo < hi, 'a travel time is a range lo < hi');

export const ReachRiver = z.strictObject({
  id: Slug,
  name_nl: Name,
  name_en: Name,
  parent_river_id: Slug.nullable(),
  km_direction: z.enum(['downstream', 'upstream', 'none']),
});

export const NlEntryNode = z.strictObject({
  id: Slug,
  river_id: Slug,
  node: NodeId,
  name_nl: Name,
  name_en: Name,
  coord: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
});

export const Reach = z.strictObject({
  id: ReachId,
  river_id: Slug,
  seq: z.number().int().min(1),
  up_station_id: StationRef.nullable(),
  down_station_id: StationRef.nullable(),
  length_km: z.number().min(0),
  km_graph_from: Km,
  km_graph_to: Km,
  flags: ReachFlags,
  travel_time_h: TravelRange.nullable(),
  travel_time_source: z.string().min(1).max(300).nullable(),
  upstream: z.array(ReachId).max(20),
  downstream: z.array(ReachId).max(20),
});
export type Reach = z.infer<typeof Reach>;

export const ReachStation = z.strictObject({
  id: StationRef,
  river_id: Slug,
  reach_id: ReachId.nullable(),
  km_official: Km.nullable(),
  km_official_system: z.string().min(1).max(80).nullable(),
  km_graph: Km.nullable(),
  km_to_nl_entry: Km.nullable(),
  nl_entry_node: Slug.nullable(),
});
export type ReachStation = z.infer<typeof ReachStation>;

export const StationTravelTime = z.strictObject({
  from_station_id: StationRef,
  to_station_id: StationRef,
  h: TravelRange,
  basis: z.string().min(1).max(200),
  source: z.string().min(1).max(300),
  source_url: z.url({ protocol: /^https$/ }),
});

export const ReachesFile = z.strictObject({
  schema_version: z.literal(REACHES_SCHEMA_VERSION),
  version: z.string().regex(RIVERS_VERSION_RE),
  attribution: z.literal(OSM_ATTRIBUTION),
  attribution_url: z.literal(OSM_ATTRIBUTION_URL),
  licence: z.literal(ODBL_LICENCE),
  licence_url: z.literal(ODBL_URL),
  licence_note: z.string().min(1).max(500),
  osm_replication_timestamp: z.iso.datetime(),
  rivers: z.array(ReachRiver).max(500),
  nl_entry_nodes: z.array(NlEntryNode).max(50),
  reaches: z.array(Reach).max(50_000),
  stations: z.array(ReachStation).max(10_000),
  travel_times: z.array(StationTravelTime).max(1_000),
});
export type ReachesFile = z.infer<typeof ReachesFile>;

/** What the schema cannot say alone: unique ids and every reference resolving. */
export function checkReaches(f: ReachesFile): string[] {
  const problems: string[] = [];
  const rivers = new Set(f.rivers.map((r) => r.id));
  const reaches = new Set<string>();
  for (const r of f.reaches) {
    if (reaches.has(r.id)) problems.push(`reach ${r.id} twice`);
    reaches.add(r.id);
    if (r.id !== `${r.river_id}.${r.seq}`) problems.push(`reach ${r.id} is not ${r.river_id}.${r.seq}`);
    if (!rivers.has(r.river_id)) problems.push(`reach ${r.id}: unknown river ${r.river_id}`);
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
