import { boundedJson, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// CH-5 BAFU hydrodaten flood-danger sections (`hydro_warn_levels_{de,en}.geojson`, catalogue §2.7): one feature per
// river, lake or hydrological region, with its danger level 0–5 and validity, geometry in LV95 (EPSG:2056). Strict
// and bounded; anything the schema does not know is a SchemaDrift. Provider strings are data. The `meta` legends and
// icons are presentation (the de/fr/it/en texts of the six levels) and are checked for shape only; `plot` is a URL
// string or an object, bounded by the node cap and never read.

/** 33,961 values in the recorded payloads (about 6x). */
export const CAPS: JsonCaps = { maxNodes: 200_000, maxDepth: 12 };
export const MAX_FEATURES = 500;
/**
 * Every recorded map lists 93 sections. Fewer than this is not the whole map, which would close every area it
 * leaves out: drift `too_few_areas` (review SR-6).
 */
export const MIN_FEATURES = 80;

const text = (max: number) => z.string().max(max);

// LV95 position (E, N) in metres: Switzerland spans about 2,485,000–2,834,000 and 1,075,000–1,296,000. A position
// far outside is not LV95 (a CRS change to WGS84 would put degrees here) and is drift, never converted.
const Position = z.tuple([z.number().min(2_000_000).max(3_000_000), z.number().min(1_000_000).max(1_500_000)]);
const Line = z.array(Position);

const Geometry = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('MultiLineString'), coordinates: z.array(Line) }),
  z.strictObject({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(Line)) }),
]);
export type Geometry = z.infer<typeof Geometry>;

const Properties = z.strictObject({
  id: z.number().int(),
  label: text(300),
  /** The hydro-body or region number; unique within its kind. */
  key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  /** 0 "Keine Gefahrenstufe" … 5; another integer is dropped by the normaliser as unmapped. */
  level: z.number().int().min(0).max(99),
  kind: z.enum(['river', 'lake', 'hydro_region']),
  hydro_body: text(500).nullable(),
  color_polygon_fill: text(20),
  color_polygon_outline: text(20),
  valid_from: text(40),
  valid_until: text(40).nullable(),
  plot: z.unknown(),
});
export type Properties = z.infer<typeof Properties>;

const Feature = z.strictObject({
  type: z.literal('Feature'),
  id: z.number().int().optional(),
  geometry: Geometry,
  properties: Properties,
});

const Lang = z.strictObject({ title: text(200), legend: z.record(text(20), text(200)) });

const Collection = z.strictObject({
  type: z.literal('FeatureCollection'),
  name: text(100),
  crs: z.strictObject({ type: z.literal('name'), properties: z.strictObject({ name: z.literal('EPSG:2056') }) }),
  meta: z.strictObject({
    de: Lang,
    fr: Lang,
    it: Lang,
    en: Lang,
    icons: z.record(text(20), z.array(text(200)).max(10)),
    produced_at: text(40),
  }),
  features: z.array(z.unknown()).max(MAX_FEATURES),
});

export type Section = { properties: Properties; geometry: Geometry };

export type Collected = { producedAt: string; sections: Section[] };

export function parseWarnings(body: Uint8Array): Collected {
  const doc = parseStrict(
    Collection,
    boundedJson(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'), CAPS),
  );
  if (doc.features.length < MIN_FEATURES) throw new SchemaDrift('too_few_areas');
  return {
    producedAt: doc.meta.produced_at,
    sections: doc.features.map((element, i) => {
      const f = parseStrict(Feature, element, ['features', i]);
      return { properties: f.properties, geometry: f.geometry };
    }),
  };
}
