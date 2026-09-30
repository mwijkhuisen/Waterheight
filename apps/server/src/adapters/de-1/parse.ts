import { cappedArray, type JsonCaps, parseJsonArray } from '@rws/core';
import { z } from 'zod';

// DE-1 PEGELONLINE rest-api/v2 (catalogue §2.2): strict schemas of the three
// archived calls. Anything the schema does not know is a SchemaDrift: that
// payload is quarantined and nothing of it is stored (A§7.4 step 5). Provider
// strings are data; none is interpreted here. Every document is bounded before
// Zod sees it (packages/core json.ts), so no payload inside the byte caps can
// run the loader out of memory on its way to a SchemaDrift.

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
  occurrences: cappedArray(text(10), 100).optional(),
});

const Timeseries = z.strictObject({
  shortname: text(40),
  longname: text(200),
  unit: text(40),
  equidistance: z.number().int().min(0).max(100_000),
  currentMeasurement: CurrentMeasurement.optional(),
  gaugeZero: GaugeZero.optional(),
  comment: z.strictObject({ shortDescription: text(500), longDescription: text(4000) }).optional(),
  characteristicValues: cappedArray(CharacteristicValue, 200).optional(),
});

const Station = z.strictObject({
  // Any 8-4-4-4-12 hex id: PEGELONLINE's UUIDs need not follow the RFC's version and variant bits.
  uuid: z.guid(),
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
  timeseries: cappedArray(Timeseries, 60),
});
export type Station = z.infer<typeof Station>;
export type Measurement = z.infer<typeof Measurement>;

/**
 * The node and depth caps of each call's document, about 5× the recorded peak
 * (in brackets: nodes and depth of the fixture). `stations.json` holds at most
 * 5,000 stations; `measurements.json` at most 60,000 points (P31D of a 1-minute
 * series is 44,640), which the series cap admits (60,000 points are 180,001 values).
 */
export const JSON_CAPS = {
  /** The basin call (5,776 values, depth 5: 199 stations). */
  basin: { maxItems: 5000, maxNodes: 30_000, maxDepth: 8 },
  /** The daily metadata call (41,043 values, depth 7: 786 stations). */
  meta: { maxItems: 5000, maxNodes: 200_000, maxDepth: 10 },
  /** A series window (8,920 values, depth 2: the P31D seed of a 15-minute series). */
  series: { maxItems: 60_000, maxNodes: 200_000, maxDepth: 3 },
} as const satisfies Record<string, JsonCaps & { maxItems: number }>;

const decode = (body: Uint8Array) => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');

/** `stations.json`: the basin call (current values) and the daily metadata call (gauge zeros). */
export const parseStations = (body: Uint8Array, caps: JsonCaps & { maxItems: number } = JSON_CAPS.meta): Station[] =>
  parseJsonArray(decode(body), Station, caps);
export const parseMeasurements = (body: Uint8Array): Measurement[] =>
  parseJsonArray(decode(body), Measurement, JSON_CAPS.series);
