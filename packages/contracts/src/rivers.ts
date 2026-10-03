import { z } from 'zod';

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

export const KM_DIRECTIONS = ['downstream', 'upstream', 'none'] as const;

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
  evidence: z.string().min(1).max(500),
});
export type River = z.infer<typeof River>;

export const RiversFile = z.strictObject({
  version: z.literal(1),
  rivers: z.array(River).min(1),
  excluded: z.array(z.strictObject({ name: z.string().min(1), wikidata: Qid.optional(), reason: z.string().min(1) })),
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
  return problems.length > 0 ? { problems } : { problems, rivers: f };
}
