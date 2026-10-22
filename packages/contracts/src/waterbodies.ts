import { z } from 'zod';
import { WATERBODY_KINDS } from './reaches.ts';
import { LonLat, type RiversFile } from './rivers.ts';

// The water-body registry (registry/waterbodies.yaml; P17b, ADR-0012, ADR-0022): the lakes, closed and open estuaries
// and seas that stations lie in and rivers end in. A lake or closed estuary is an OSM polygon (`osm`); a sea or an
// open estuary may be point-only (`point` and a reviewed sanity `bbox`, never drawn). `names` are the verbatim
// spellings providers publish, as in rivers.yaml; geometry alone never assigns a station to a body.

const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'must be a slug');
const Qid = z.string().regex(/^Q[1-9][0-9]{0,9}$/, 'must be a Wikidata Q-id');
const SourceId = z.string().regex(/^[A-Z]{2}-[0-9]+$/, 'must be a source id such as DE-1');
const StationRef = z.string().regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/, 'must be a station id');
// Reviewed display names: trimmed, no markup, no control or format characters (as rivers.yaml).
const Name = z
  .string()
  .min(1)
  .max(80)
  .refine((s) => s === s.trim(), 'name has leading or trailing whitespace')
  .refine((s) => !/[<>]/.test(s), 'name holds < or >')
  .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), 'name holds a control or format character');
const Spelling = z.string().min(1).max(120);
const Evidence = z.url({ protocol: /^https$/ }).max(500);

/** [west, south, east, north] in WGS84. */
export const Bbox = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

export const Waterbody = z.strictObject({
  id: Slug,
  kind: z.enum(WATERBODY_KINDS),
  name_nl: Name,
  name_en: Name,
  wikidata: Qid,
  /** The OSM polygon (a multipolygon relation or a closed way), or null for a point-only body. */
  osm: z.strictObject({ type: z.enum(['relation', 'way']), id: z.number().int().positive() }).nullable(),
  /** Point-only bodies: the label point (the OSM label or place=sea node, or Wikidata P625; source in `evidence`). */
  point: LonLat.optional(),
  /** Point-only bodies: a reviewed bound that rejects an implausible curated station; never drawn. */
  bbox: Bbox.optional(),
  names: z.record(SourceId, z.array(Spelling).min(1)),
  /** Regulated by structures (true) or tidal (false). */
  managed_level: z.boolean(),
  outflows: z.array(z.strictObject({ to: Slug, via: Name })),
  /**
   * The D27 reference gauge (P18b, owner decision O-3): a public station placed in the body whose H series alone
   * gives a lake its state, or null (lakes without a placed gauge, the seas and estuaries).
   */
  reference_station: StationRef.nullable(),
  /** The OSM object, the Wikidata item (P402 = the OSM id where present) and the outflow source. */
  evidence: z.array(Evidence).min(1),
});
export type Waterbody = z.infer<typeof Waterbody>;

export const WaterbodiesFile = z.strictObject({
  version: z.literal(1),
  waterbodies: z.array(Waterbody).min(1).max(500),
});
export type WaterbodiesFile = z.infer<typeof WaterbodiesFile>;

/**
 * The schema plus what it cannot say alone: unique ids, QIDs and OSM objects; a name of one source in one body only;
 * outflows to known bodies and never to itself; `osm` null exactly when `point` and `bbox` are given (point inside the
 * bbox); and, with `rivers`, every rivers.yaml mouth naming a known body.
 */
export function validateWaterbodies(
  input: unknown,
  rivers: Pick<RiversFile, 'mouths'> | null,
): { problems: string[]; waterbodies?: WaterbodiesFile } {
  const parsed = WaterbodiesFile.safeParse(input);
  if (!parsed.success) return { problems: [z.prettifyError(parsed.error)] };
  const f = parsed.data;
  const problems: string[] = [];
  const ids = new Set<string>();
  const qids = new Set<string>();
  const osm = new Set<string>();
  const names = new Map<string, string>();
  for (const w of f.waterbodies) {
    if (ids.has(w.id)) problems.push(`${w.id}: duplicate id`);
    ids.add(w.id);
    if (qids.has(w.wikidata)) problems.push(`${w.id}: duplicate wikidata ${w.wikidata}`);
    qids.add(w.wikidata);
    if (w.osm !== null) {
      const key = `${w.osm.type[0]}${w.osm.id}`;
      if (osm.has(key)) problems.push(`${w.id}: duplicate osm ${key}`);
      osm.add(key);
    }
    const pointOnly = w.point !== undefined && w.bbox !== undefined;
    if ((w.osm === null) !== pointOnly) problems.push(`${w.id}: osm null exactly when point and bbox are given`);
    if (w.osm !== null && (w.point !== undefined || w.bbox !== undefined))
      problems.push(`${w.id}: a polygon body has no point or bbox`);
    if (w.point !== undefined && w.bbox !== undefined) {
      const [x, y] = w.point;
      const [west, south, east, north] = w.bbox;
      if (!(west < east && south < north)) problems.push(`${w.id}: bbox is not [west, south, east, north]`);
      else if (x < west || x > east || y < south || y > north) problems.push(`${w.id}: point outside its bbox`);
    }
    for (const [src, list] of Object.entries(w.names)) {
      if (new Set(list).size !== list.length) problems.push(`${w.id}: names.${src} has a duplicate spelling`);
      for (const n of list) {
        const key = `${src}\u0000${n}`;
        const other = names.get(key);
        if (other !== undefined && other !== w.id) problems.push(`${w.id}: names.${src} "${n}" is also ${other}'s`);
        names.set(key, w.id);
      }
    }
  }
  for (const w of f.waterbodies)
    for (const o of w.outflows) {
      if (o.to === w.id) problems.push(`${w.id}: outflow to itself`);
      else if (!ids.has(o.to)) problems.push(`${w.id}: outflow to unknown ${o.to}`);
    }
  for (const m of rivers?.mouths ?? [])
    if (!ids.has(m.waterbody)) problems.push(`mouths ${m.id}: unknown waterbody ${m.waterbody}`);
  return problems.length > 0 ? { problems } : { problems, waterbodies: f };
}
