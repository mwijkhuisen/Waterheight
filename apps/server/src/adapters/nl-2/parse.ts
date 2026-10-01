import { boundedJson, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// NL-2 RWS WFS `DDAPI20:locatiesmetlaatstewaarneming` (catalogue §2.1): the
// strict schema of an archived GeoJSON FeatureCollection, the CQL-filtered
// snapshot of the latest value per series. Anything the schema does not know
// is a SchemaDrift: that payload is quarantined (A§7.4 step 5). Provider strings
// are data; none is interpreted here. The document is bounded before it is
// parsed, and its features are parsed one at a time (packages/core json.ts). A
// WFS error (an XML `ExceptionReport`) or an HTML page is not JSON: drift.

const text = (max: number) => z.string().max(max);

const Feature = z.strictObject({
  type: z.literal('Feature'),
  id: text(120),
  geometry: z.strictObject({
    type: z.literal('Point'),
    /** GeoJSON order, `[lon, lat]`; a third value (height) or a projected pair is drift. */
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  }),
  geometry_name: z.literal('GEOMETRY'),
  properties: z.strictObject({
    NAAM: text(200),
    CODE: text(80),
    BEMONSTERINGSHOOGTE: z.number(),
    OPDRACHTGEVENDE_INSTANTIE: text(80),
    KWALITEITSWAARDE_CODE: z.string().regex(/^\d{2}$/),
    /** Parsed for its shape only: NL-2 never stores a value (normalise.ts). */
    WAARDE_LAATSTE_METING: z.number(),
    /** Amsterdam wall-clock time labelled Z: normalise.ts reads it. */
    TIJDSTIP_LAATSTE_METING: text(40),
    EENHEIDCODE: text(40),
    GROOTHEIDCODE: text(40),
    HOEDANIGHEIDCODE: text(40),
    WAARDEBEPALINGSMETHODECODE: text(40),
  }),
});
export type Feature = z.infer<typeof Feature>;

const count = z.number().int().min(0);
const Envelope = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
  totalFeatures: count,
  numberMatched: count,
  numberReturned: count,
  /** True UTC: the reference of the feature times (normalise.ts). */
  timeStamp: text(40),
  crs: z.strictObject({
    type: z.literal('name'),
    properties: z.strictObject({ name: z.literal('urn:ogc:def:crs:EPSG::4258') }),
  }),
});

export type Collection = { timeStamp: string; features: Feature[] };

/**
 * The caps of one snapshot (in brackets: the recorded one, 434 features of
 * about 21 JSON values each). The unfiltered layer has 941,735 features: a
 * lost CQL filter is refused here, never parsed.
 */
export const JSON_CAPS = {
  /** About 5× the recorded 9,125 values (depth 5). */
  maxNodes: 50_000,
  maxDepth: 8,
  /** About 5× the recorded 434; 2,000 real features are about 42,000 values, inside maxNodes. */
  maxFeatures: 2_000,
} as const satisfies JsonCaps & { maxFeatures: number };

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

/** One snapshot: its `timeStamp` and every feature, in the response's order. */
export function parseCollection(body: Uint8Array): Collection {
  const envelope = parseStrict(Envelope, boundedJson(decode(body), JSON_CAPS));
  const n = envelope.features.length;
  if (n > JSON_CAPS.maxFeatures) throw new SchemaDrift('too_big', 'features');
  // A paged or server-capped answer is not a snapshot: every series it left out would read as vanished.
  if (envelope.numberReturned !== n || envelope.numberMatched !== n || envelope.totalFeatures !== n) {
    throw new SchemaDrift('invalid_value', 'numberReturned');
  }
  return {
    timeStamp: envelope.timeStamp,
    features: envelope.features.map((f, i) => parseStrict(Feature, f, ['features', i])),
  };
}
