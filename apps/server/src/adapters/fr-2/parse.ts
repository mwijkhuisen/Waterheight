import { boundedJson, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// FR-2 Hub'Eau hydrométrie v2 `obs_elab` (catalogue §2.5): the elaborated daily values, here the daily mean
// discharge QmnJ (l/s) and the daily maximum of the instantaneous stage HIXnJ (mm). Strict schemas of the one call
// the backfill makes (the JSON form). A page with a `next` comes as HTTP 206 and `count` is the total over all
// pages, so `parse` only reports them: the backfill provider calls the answer truncated when `next` is set or
// `count` exceeds the page. Anything the schema does not know is a SchemaDrift; provider strings are data, length
// capped, and none is interpreted here.

const text = (max: number) => z.string().max(max);

/** One daily value, with exactly the 14 keys of the recorded answers (types as recorded). */
const ElabRecordSchema = z.strictObject({
  code_site: text(20),
  code_station: text(20),
  /** The day, a date without a time or zone: see normalise.ts for what instant it stands for. */
  date_obs_elab: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  resultat_obs_elab: z.number().finite(),
  date_prod: text(40),
  code_statut: z.number().int(),
  libelle_statut: text(200),
  code_methode: z.number().int(),
  libelle_methode: text(200),
  code_qualification: z.number().int(),
  libelle_qualification: text(200),
  longitude: z.number(),
  latitude: z.number(),
  grandeur_hydro_elab: z.enum(['QmnJ', 'HIXnJ']),
});
export type ElabRecord = z.infer<typeof ElabRecordSchema>;

const url = text(2000).nullable();
const Envelope = z.strictObject({
  count: z.number().int().min(0),
  first: url,
  prev: url,
  next: url,
  api_version: text(20),
  data: z.array(z.unknown()),
});

/**
 * Node and depth caps: a record is 14 values and an object (about 15 nodes by the scan's count), and a call asks
 * `size=20000`, so a full page is 300,000 nodes; the cap is 1.5× that. Measured (fr-2-uckange-qmnj-1981, 7,018
 * records, 19 years): about 105,000 nodes, depth 3.
 */
export const JSON_CAPS = { maxItems: 20_000, maxNodes: 450_000, maxDepth: 4 } as const satisfies JsonCaps & {
  maxItems: number;
};

export type ElabPage = { count: number; next: string | null; data: ElabRecord[] };

/** One `obs_elab` answer: its records, the walk's total and whether another page follows. */
export function parseElab(body: Uint8Array): ElabPage {
  const doc = boundedJson(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'), JSON_CAPS);
  const envelope = parseStrict(Envelope, doc);
  if (envelope.data.length > JSON_CAPS.maxItems) throw new SchemaDrift('too_big', 'data');
  return {
    count: envelope.count,
    next: envelope.next,
    data: envelope.data.map((element, i) => parseStrict(ElabRecordSchema, element, ['data', i])),
  };
}
