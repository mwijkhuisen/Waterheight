import { z } from 'zod';
import { TravelLabel, travelShapeProblem } from './reaches.ts';

// The river registry (registry/rivers.yaml; P6a): the rivers the graph pipeline
// builds, their OSM selection and the verbatim spellings providers use.

const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'must be a slug');
const Qid = z.string().regex(/^Q[1-9][0-9]{0,9}$/, 'must be a Wikidata Q-id');
const SourceId = z.string().regex(/^[A-Z]{2}-[0-9]+$/, 'must be a source id such as DE-1');
// Reviewed display names: trimmed, no markup, no control or format characters (U+200B and friends).
const Name = z
  .string()
  .min(1)
  .max(80)
  .refine((s) => s === s.trim(), 'name has leading or trailing whitespace')
  .refine((s) => !/[<>]/.test(s), 'name holds < or >')
  .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), 'name holds a control or format character');
const Spelling = z.string().min(1).max(120);
const Evidence = z.string().min(1).max(500);
/** WGS84 [lon, lat], as the graph stores coordinates. */
export const LonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
// A registry station id (stations.ts), e.g. de.wsv.2790020 or nl.rws.lobith.bovenrijn.tolkamer.
const StationRef = z.string().regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/, 'must be a station id');

export const KM_DIRECTIONS = ['downstream', 'upstream', 'none'] as const;

/**
 * Where a river enters the Netherlands (P6b): the graph node of this river
 * nearest to `at`, at most `max_m` away. km_to_nl_entry is measured to it.
 */
export const NlEntry = z.strictObject({
  id: Slug,
  name_nl: Name,
  name_en: Name,
  at: LonLat,
  max_m: z.number().positive().max(5000),
  evidence: Evidence,
});
export type NlEntry = z.infer<typeof NlEntry>;

export const RIVER_FLAG_KINDS = ['tidal', 'impounded'] as const;
/**
 * A stretch of a river with a reach flag (catalogue §4.7 items 6-7): from the
 * river node nearest `from` (or the river's start) to the one nearest `to`
 * (or its end), along the river's own km_graph.
 */
export const RiverFlag = z.strictObject({
  kind: z.enum(RIVER_FLAG_KINDS),
  from: LonLat.optional(),
  to: LonLat.optional(),
  evidence: Evidence,
});
export type RiverFlag = z.infer<typeof RiverFlag>;

export const River = z.strictObject({
  id: Slug,
  name_nl: Name,
  name_en: Name,
  names: z.record(SourceId, z.array(Spelling).min(1)),
  aliases: z.array(Spelling),
  osm_relation_id: z.number().int().positive().nullable(),
  osm_way_name: Spelling.nullable(),
  wikidata: Qid,
  parent_river_id: Slug.nullable(),
  km_direction: z.enum(KM_DIRECTIONS),
  drop_ways: z.array(z.strictObject({ id: z.number().int().positive(), reason: z.string().min(1) })).optional(),
  nl_entry: NlEntry.optional(),
  flags: z.array(RiverFlag).optional(),
  evidence: Evidence,
});
export type River = z.infer<typeof River>;

/**
 * A reviewed connection where the OSM relation ends short of its confluence or
 * has a gap (KG-161): the sink of `river` nearest `at` joins the nearest node of
 * `to_river` that is not upstream of it, at most `max_m` away. Onto another
 * river, that river's vertex nearest `at` becomes a node first, so the join
 * lands where the river passes (#110). `max_m` bounds both that vertex's
 * distance from `at` and the join's length from the sink, so `at` is best the
 * sink itself. Routing only: a join is never drawn and never published as
 * geometry.
 */
export const Join = z.strictObject({
  river: Slug,
  at: LonLat,
  to_river: Slug,
  max_m: z.number().positive().max(2000),
  reason: Evidence,
});
export type Join = z.infer<typeof Join>;

// The file's TravelValue without its lo < hi refine: validateRivers checks the order with a named message.
const TravelSpan = z.union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive()])]);

/**
 * A sourced travel time between two stations (catalogue §3.7; #110): hours `h` or days `d`, a range [lo, hi] or one
 * value with its `label` (the condition or event, NL and EN); `derived` marks a figure the catalogue derives from
 * other anchors. Indicative, never an ETA.
 */
export const TravelTime = z.strictObject({
  from_station: StationRef,
  to_station: StationRef,
  h: TravelSpan.optional(),
  d: TravelSpan.optional(),
  label: TravelLabel.optional(),
  derived: z.literal(true).optional(),
  basis: z.string().min(1).max(200),
  source: z.string().min(1).max(300),
  source_url: z.url({ protocol: /^https$/ }),
});
export type TravelTime = z.infer<typeof TravelTime>;

export const RiversFile = z.strictObject({
  version: z.literal(1),
  rivers: z.array(River).min(1),
  excluded: z.array(z.strictObject({ name: z.string().min(1), wikidata: Qid.optional(), reason: z.string().min(1) })),
  joins: z.array(Join).optional(),
  travel_times: z.array(TravelTime).optional(),
});
export type RiversFile = z.infer<typeof RiversFile>;

/** The schema, plus what it cannot say alone: uniqueness, one OSM selector, parents without a cycle. */
export function validateRivers(input: unknown): { problems: string[]; rivers?: RiversFile } {
  const parsed = RiversFile.safeParse(input);
  if (!parsed.success) return { problems: [z.prettifyError(parsed.error)] };
  const f = parsed.data;
  const problems: string[] = [];
  const dup = (what: string, seen: Set<unknown>, v: unknown, id: string) => {
    if (v !== null && seen.has(v)) problems.push(`${id}: duplicate ${what} ${String(v)}`);
    seen.add(v);
  };
  const ids = new Set<string>();
  const relations = new Set<number | null>();
  const qids = new Set<string>();
  for (const r of f.rivers) {
    dup('id', ids, r.id, r.id);
    dup('osm_relation_id', relations, r.osm_relation_id, r.id);
    dup('wikidata', qids, r.wikidata, r.id);
    if ((r.osm_relation_id === null) === (r.osm_way_name === null))
      problems.push(`${r.id}: exactly one of osm_relation_id and osm_way_name must be set`);
    for (const [src, list] of Object.entries(r.names))
      if (new Set(list).size !== list.length) problems.push(`${r.id}: names.${src} has a duplicate spelling`);
    const ways = new Set<number>();
    for (const w of r.drop_ways ?? []) dup('drop_ways id', ways, w.id, r.id);
  }
  const parent = new Map(f.rivers.map((r) => [r.id, r.parent_river_id]));
  for (const r of f.rivers) {
    if (r.parent_river_id !== null && !parent.has(r.parent_river_id))
      problems.push(`${r.id}: unknown parent_river_id ${r.parent_river_id}`);
  }
  const looped = new Set<string>();
  for (const r of f.rivers) {
    const chain: string[] = [];
    for (let at: string | null | undefined = r.id; at && !chain.includes(at); at = parent.get(at)) chain.push(at);
    const next = parent.get(chain.at(-1) ?? '');
    if (next && chain.includes(next)) {
      const cycle = chain.slice(chain.indexOf(next));
      if (!cycle.some((c) => looped.has(c))) problems.push(`parent cycle: ${cycle.join(' -> ')} -> ${next}`);
      for (const c of cycle) looped.add(c);
    }
  }
  const names = new Set(f.rivers.flatMap((r) => [r.name_nl, r.name_en]));
  for (const x of f.excluded) if (names.has(x.name)) problems.push(`excluded: "${x.name}" is also a river name`);
  const entries = new Set<string>();
  for (const r of f.rivers) if (r.nl_entry) dup('nl_entry id', entries, r.nl_entry.id, r.id);
  for (const j of f.joins ?? []) {
    for (const id of [j.river, j.to_river]) if (!parent.has(id)) problems.push(`joins: unknown river ${id}`);
  }
  const pairs = new Set<string>();
  for (const t of f.travel_times ?? []) {
    const shape = travelShapeProblem(t);
    if (shape !== null) problems.push(`travel_times ${t.from_station}: ${shape}`);
    const v = t.h ?? t.d;
    if (Array.isArray(v) && !(v[0] < v[1])) problems.push(`travel_times ${t.from_station}: a range must be lo < hi`);
    if (t.from_station === t.to_station) problems.push(`travel_times ${t.from_station}: from and to are the same`);
    dup('travel_times pair', pairs, `${t.from_station} ${t.to_station}`, 'travel_times');
  }
  return problems.length > 0 ? { problems } : { problems, rivers: f };
}
