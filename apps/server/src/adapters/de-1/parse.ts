import { SchemaDrift } from '@rws/core';
import { z } from 'zod';

// DE-1 PEGELONLINE rest-api/v2 (catalogue §2.2): strict schemas of the three
// archived calls. Anything the schema does not know is a SchemaDrift: that
// payload is quarantined and nothing of it is stored (A§7.4 step 5). Provider
// strings are data; none is interpreted here.

const text = (max: number) => z.string().max(max);

const Measurement = z.strictObject({
  timestamp: text(40),
  value: z.number(),
});

const CurrentMeasurement = Measurement.extend({
  stateMnwMhw: text(40).optional(),
  stateNswHsw: text(40).optional(),
});

const GaugeZero = z.strictObject({
  unit: text(40),
  value: z.number(),
  validFrom: text(10),
});

// Parsed for their shape only: characteristic values are P7.
const CharacteristicValue = z.strictObject({
  shortname: text(40),
  longname: text(200),
  unit: text(40),
  value: z.number(),
  validFrom: text(10).optional(),
  timespanStart: text(10).optional(),
  timespanEnd: text(10).optional(),
  occurrences: z.array(text(10)).max(100).optional(),
});

const Timeseries = z.strictObject({
  shortname: text(40),
  longname: text(200),
  unit: text(40),
  equidistance: z.number().int().min(0).max(100_000),
  currentMeasurement: CurrentMeasurement.optional(),
  gaugeZero: GaugeZero.optional(),
  comment: z.strictObject({ shortDescription: text(500), longDescription: text(4000) }).optional(),
  characteristicValues: z.array(CharacteristicValue).max(200).optional(),
});

const Station = z.strictObject({
  uuid: z.uuid(),
  number: text(40),
  shortname: text(200),
  longname: text(200),
  km: z.number().optional(),
  agency: text(200),
  longitude: z.number().min(-180).max(180).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  voiceServiceNumber: text(80).optional(),
  remark: text(2000).optional(),
  water: z.strictObject({ shortname: text(80), longname: text(200) }),
  timeseries: z.array(Timeseries).max(60),
});
export type Station = z.infer<typeof Station>;

/** `stations.json`: the basin call (current values) and the daily metadata call (gauge zeros). */
const Stations = z.array(Station).max(5000);
/** `measurements.json`: P31D of a 1-minute series is 44,640 points. */
const Measurements = z.array(Measurement).max(60_000);
export type Measurement = z.infer<typeof Measurement>;

function parse<T>(schema: z.ZodType<T>, body: Uint8Array): T {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'));
  } catch {
    throw new SchemaDrift('not_json');
  }
  const result = schema.safeParse(doc);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  // The issue code is Zod's own identifier; the path holds our keys and array indexes only.
  throw new SchemaDrift(issue?.code ?? 'invalid', issue?.path.map(String).join('.') ?? '');
}

export const parseStations = (body: Uint8Array): Station[] => parse(Stations, body);
export const parseMeasurements = (body: Uint8Array): Measurement[] => parse(Measurements, body);
