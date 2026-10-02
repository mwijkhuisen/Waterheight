import { boundedJson, cappedArray, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// FR-1 Hub'Eau hydrometrie v2 (catalogue §2.5): strict schemas of the two
// archived calls, the JSON form only (the GeoJSON has a misspelt property).
// `observations_tr` is paged by a cursor: every page is its own archived
// payload (the recorder follows `next`, P1), a page with a `next` comes as
// HTTP 206, and `count` is the total over all pages, so it is never compared
// with the page's own length. Anything the schema does not know is a
// SchemaDrift; provider strings are data and none is interpreted here.

const text = (max: number) => z.string().max(max);
const url = text(2000).nullable();

/** One observation, with exactly the `fields=` the capture spec asks for. */
const Observation = z.strictObject({
  code_site: text(20).nullable(),
  /** null for a site-level series (a duplicate of the station-level one): dropped in normalise. */
  code_station: text(20).nullable(),
  grandeur_hydro: z.enum(['H', 'Q']),
  date_obs: text(40),
  resultat_obs: z.number().nullable(),
  code_statut: z.number().int(),
  code_qualification_obs: z.number().int(),
});
export type Observation = z.infer<typeof Observation>;

const Point = z.strictObject({
  type: z.literal('Point'),
  crs: z.strictObject({ type: text(20), properties: z.strictObject({ name: text(100) }) }),
  coordinates: cappedArray(z.number(), 3),
});

/** One station of `referentiel/stations`: only the gauge-zero fields are used (coordinates live in the registry). */
const Station = z.strictObject({
  code_site: text(20),
  libelle_site: text(500),
  code_station: text(20),
  libelle_station: text(500),
  type_station: text(40),
  coordonnee_x_station: z.number(),
  coordonnee_y_station: z.number(),
  code_projection: z.number().int(),
  longitude_station: z.number(),
  latitude_station: z.number(),
  influence_locale_station: z.number().int().nullable(),
  commentaire_station: text(4000).nullable(),
  altitude_ref_alti_station: z.number().nullable(),
  code_systeme_alti_site: z.number().int().nullable(),
  code_commune_station: text(10),
  libelle_commune: text(200).nullable(),
  code_departement: text(10).nullable(),
  libelle_departement: text(200).nullable(),
  code_region: text(10).nullable(),
  libelle_region: text(200).nullable(),
  code_cours_eau: text(20).nullable(),
  libelle_cours_eau: text(200).nullable(),
  uri_cours_eau: text(500).nullable(),
  descriptif_station: text(2000).nullable(),
  date_maj_station: text(40),
  date_ouverture_station: text(40),
  date_fermeture_station: text(40).nullable(),
  commentaire_influence_locale_station: text(4000).nullable(),
  code_regime_station: z.number().int(),
  qualification_donnees_station: z.number().int(),
  code_finalite_station: text(20).nullable(),
  type_contexte_loi_stat_station: z.number().int().nullable(),
  type_loi_station: z.number().int().nullable(),
  code_sandre_reseau_station: cappedArray(text(40), 100).nullable(),
  date_debut_ref_alti_station: text(40).nullable(),
  date_activation_ref_alti_station: text(40).nullable(),
  date_maj_ref_alti_station: text(40).nullable(),
  en_service: z.boolean(),
  geometry: Point,
});
export type Station = z.infer<typeof Station>;

const Envelope = z.strictObject({
  count: z.number().int().min(0),
  first: url,
  last: url.optional(),
  prev: url,
  next: url,
  api_version: text(20),
  data: z.array(z.unknown()),
});

/**
 * Node and depth caps, about 1.5× the largest possible page (in brackets: the
 * recorded fixtures). An observation is 8 JSON values and a page holds at
 * most `size=20000` of them; a station about 50, and the referentiel asks for
 * `size=10000`.
 */
export const JSON_CAPS = {
  /** An observations_tr page (5,660 rows, 45,287 values, depth 2). */
  obs: { maxItems: 20_000, maxNodes: 250_000, maxDepth: 4 },
  /** A referentiel/stations prefix (409 stations of A, depth 5). */
  ref: { maxItems: 10_000, maxNodes: 600_000, maxDepth: 6 },
} as const satisfies Record<string, JsonCaps & { maxItems: number }>;

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

function page<T>(body: Uint8Array, item: z.ZodType<T>, caps: JsonCaps & { maxItems: number }) {
  const envelope = parseStrict(Envelope, boundedJson(decode(body), caps));
  if (envelope.data.length > caps.maxItems) throw new SchemaDrift('too_big', 'data');
  return { next: envelope.next, data: envelope.data.map((element, i) => parseStrict(item, element, ['data', i])) };
}

/** One `observations_tr` page: its rows, and whether the walk goes on (`next`). */
export const parseObservations = (body: Uint8Array): { next: string | null; data: Observation[] } =>
  page(body, Observation, JSON_CAPS.obs);

/** One `referentiel/stations` prefix. */
export const parseStations = (body: Uint8Array): Station[] => page(body, Station, JSON_CAPS.ref).data;
