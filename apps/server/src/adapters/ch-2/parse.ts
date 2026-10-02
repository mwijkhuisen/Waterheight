import { boundedJson, cappedArray, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// CH-2 hydrodaten `hydro_sensor_pq.geojson` (catalogue §2.7; undocumented,
// asked in C13): one feature per station, values as strings with their unit
// attached ("2500 m³/s", "261.35 m ü.M."). Strict: anything the schema does
// not know is a SchemaDrift. The legend (`meta`) is presentation and not read.
// Provider strings are data; `failure_text` is never interpreted.

const text = (max: number) => z.string().max(max);
const value = text(40);
const maybe = value.nullable().optional();

const Properties = z.strictObject({
  label: text(300),
  key: z.string().regex(/^\d{1,6}$/),
  icon: text(100),
  icon_path: text(300),
  hydro_body: text(300),
  hydro_body_name: text(300),
  last_value: value,
  metric: z.enum(['discharge_ms', 'discharge_ls', 'masl']),
  unit: text(20),
  unit_short: text(20),
  plot: text(300),
  last_measured_at: text(40),
  min_24h: value.nullable(),
  max_24h: value.nullable(),
  mean_24h: value.nullable(),
  failure_text: text(2000).nullable(),
  failure_valid_from: text(40).nullable(),
  sensor_discharge_measured_at: text(40).optional(),
  sensor_discharge_min_24h: maybe,
  sensor_discharge_max_24h: maybe,
  sensor_discharge_mean_24h: maybe,
  sensor_discharge_last_value: maybe,
  sensor_waterlevel_measured_at: text(40).optional(),
  sensor_waterlevel_min_24h: maybe,
  sensor_waterlevel_max_24h: maybe,
  sensor_waterlevel_mean_24h: maybe,
  sensor_waterlevel_last_value: maybe,
  // Thresholds and their unit strings are P7: parsed for their shape only.
  wl_1: maybe,
  wl_2: maybe,
  wl_3: maybe,
  wl_4: maybe,
  threshold_customer: maybe,
  kind: z.enum(['river', 'lake']),
  name: text(300),
  hydro_station_id: z.number().int(),
});
export type Properties = z.infer<typeof Properties>;

const Feature = z.strictObject({
  type: z.literal('Feature'),
  id: z.number().int(),
  geometry: z.strictObject({ type: z.literal('Point'), coordinates: cappedArray(z.number(), 3) }),
  properties: Properties,
});

const Collection = z.strictObject({
  type: z.literal('FeatureCollection'),
  name: text(100),
  crs: z.strictObject({ type: z.literal('name'), properties: z.strictObject({ name: text(40) }) }),
  meta: z.unknown(),
  features: z.array(z.unknown()),
});

/** About 5× the fixture (207 features, depth 5); a feature is about 45 values. */
export const JSON_CAPS = { maxItems: 1000, maxNodes: 60_000, maxDepth: 8 } as const satisfies JsonCaps & {
  maxItems: number;
};

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

export function parseFeatures(body: Uint8Array): Properties[] {
  const doc = parseStrict(Collection, boundedJson(decode(body), JSON_CAPS));
  if (doc.features.length > JSON_CAPS.maxItems) throw new SchemaDrift('too_big', 'features');
  return doc.features.map((f, i) => parseStrict(Feature, f, ['features', i]).properties);
}
