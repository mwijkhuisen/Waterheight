import { boundedJson, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// DE-6 LHP PublicAPI (catalogue §2.3, §4.9): the strict schemas of the stations collection (`/data/stations`) and
// the alerts collection (`/data/alerts`), as the recorded payloads show them. Anything the schema does not know is
// a SchemaDrift: that payload is quarantined (A§7.4 step 5). Provider strings are data; none is interpreted here
// (`stateClassName` holds HTML entities such as `&#60;`: it stays raw text, never decoded into markup). Each
// document is bounded before it is parsed and its features are parsed one at a time (packages/core json.ts).
// Two scales that must never be mixed: a station's `lhpClass` is an integer -1…4, an alert's is a string.

const text = (max: number) => z.string().max(max);

const Item = z.strictObject({
  lhpClass: z.number().int(),
  lhpClassName: text(100),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  cssStyle: z.strictObject({ 'background-image': text(300) }).optional(),
});

/** The members both collections share (the top-level keys of every recorded payload). */
const common = {
  apiVersion: text(60),
  status: z.literal('success'),
  lang: text(8),
  source: text(200),
  sourceName: text(200),
  sourceLogo: text(200),
  licence: text(200),
  licenceName: text(200),
  title: text(200),
  description: text(300),
  /** True UTC with a fixed `+01:00` all year (summer too); normalise.ts reads it. */
  updated: text(40),
  lastModified: text(40),
  legend: z.strictObject({ title: text(100), items: z.array(Item).max(20) }),
  type: z.literal('FeatureCollection'),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
};

const FeatureId = z.string().regex(/^[A-Z]{2}_[A-Za-z0-9._-]{1,40}$/);
const Lon = z.number().min(-180).max(180);
const Lat = z.number().min(-90).max(90);
const Position = z.tuple([Lon, Lat]);
const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const StationFeature = z.strictObject({
  kind: z.literal('Station'),
  id: FeatureId,
  type: z.literal('Feature'),
  geometry: z.strictObject({ type: z.literal('Point'), coordinates: Position }),
  properties: z.strictObject({
    name: text(200),
    water: text(200),
    /** Offset-less local time (Europe/Berlin); absent on 72 recorded features. normalise.ts reads it. */
    timestamp: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      .optional(),
    /** -1…4. Absent or null both mean "no class" (216 recorded features have no key at all). */
    lhpClass: z.number().int().nullable().optional(),
    /** Provider text, raw (HTML entities included); the test server leaves it out on 13 features. */
    stateClassName: text(200).optional(),
    stationLink: text(500).nullable().optional(),
    stateId: z.string().regex(/^DE-[A-Z]{2}$/),
  }),
  /** Absent on a feature without a class. */
  style: z.strictObject({ color: Color }).optional(),
});
export type StationFeature = z.infer<typeof StationFeature>;

const Stations = z.strictObject({
  ...common,
  stateLinks: z.record(z.string().max(10), text(300)),
  features: z.array(z.unknown()),
});
export type Stations = Omit<z.infer<typeof Stations>, 'features'> & { features: StationFeature[] };

// Rings and lines are length-checked before their positions are parsed (cappedArray in packages/core json.ts).
const Line = z.array(z.unknown()).max(20_000).pipe(z.array(Position));
const Geometry = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('LineString'), coordinates: Line }),
  z.strictObject({
    type: z.literal('Polygon'),
    coordinates: z.array(z.unknown()).max(200).pipe(z.array(Line)),
  }),
]);

const AlertFeature = z.strictObject({
  kind: z.literal('AlertArea'),
  id: FeatureId,
  type: z.literal('Feature'),
  geometry: Geometry,
  properties: z.strictObject({
    areaDesc: text(200),
    areaType: text(40),
    alertHeadline: text(300),
    /** A STRING here ("1", "2", "4", "5", "6": no 3), an integer on the stations. */
    lhpClass: z.string().regex(/^[0-9]{1,2}$/),
    lhpClassName: text(100),
  }),
  style: z
    .strictObject({
      color: Color.optional(),
      cssStyle: z.strictObject({ 'background-image': text(300) }).optional(),
    })
    .optional(),
});
export type AlertFeature = z.infer<typeof AlertFeature>;

const Alerts = z.strictObject({ ...common, features: z.array(z.unknown()) });
export type Alerts = Omit<z.infer<typeof Alerts>, 'features'> & { features: AlertFeature[] };

/**
 * The caps of each collection (in brackets: the largest recorded one). Stations: 1,589 features of about 18
 * values (29,514 values, depth 5). Alerts: 40 areas of the test server, whose polygons are 21,214 values
 * (depth 7: root, features, feature, geometry, coordinates, ring, position).
 */
export const STATIONS_CAPS = {
  /** About 5× the recorded 29,514. */
  maxNodes: 150_000,
  maxDepth: 8,
  /** About 5× the recorded 1,589; 8,000 real features are about 144,000 values, inside maxNodes. */
  maxFeatures: 8_000,
} as const satisfies JsonCaps & { maxFeatures: number };

export const ALERTS_CAPS = {
  /** About 5× the recorded 21,214. */
  maxNodes: 110_000,
  maxDepth: 9,
  /** A flood across several states is hundreds of areas, not thousands. */
  maxFeatures: 1_000,
} as const satisfies JsonCaps & { maxFeatures: number };

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

function collection<T>(
  body: Uint8Array,
  envelope: z.ZodType<{ features: unknown[] }>,
  feature: z.ZodType<T>,
  caps: JsonCaps & { maxFeatures: number },
): { features: T[] } {
  const doc = parseStrict(envelope, boundedJson(decode(body), caps));
  if (doc.features.length > caps.maxFeatures) throw new SchemaDrift('too_big', 'features');
  return { ...doc, features: doc.features.map((f, i) => parseStrict(feature, f, ['features', i])) };
}

/** One `/data/stations` answer: the strict envelope and every feature, in the response's order. */
export const parseStations = (body: Uint8Array): Stations =>
  collection(body, Stations, StationFeature, STATIONS_CAPS) as Stations;

/** One `/data/alerts` answer. An empty collection is a real answer (no area is alerted). */
export const parseAlerts = (body: Uint8Array): Alerts => collection(body, Alerts, AlertFeature, ALERTS_CAPS) as Alerts;
