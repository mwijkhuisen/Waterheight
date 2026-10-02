import { boundedJson, cappedArray, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// LU-2 AGE per-station JSON (owner audience; catalogue §2.6): one file per station, hourly, a rolling 7 days.
//
//   [{"ts_path":"0/11/W_out/15m.Cmd.RelAbs.P","ts_unitsymbol":"cm","station_name":"Diekirch",
//     "parametertype_name":"W","rows":"671","columns":"Timestamp,Value",
//     "data":[["2026-09-16T22:15:00.000+02:00",122.0],…]}]
//
// The values are read by position, which is safe only because `columns` says exactly that: any other
// column list is drift, never a guess. Provider strings are data (capped here, interpreted nowhere);
// `rows` is the provider's count and is not compared with the data (as FR-1's `count`). A SchemaDrift
// carries a fixed code and a path of our keys, never provider text.

const text = (max: number) => z.string().max(max);

const File = z.strictObject({
  ts_path: text(200),
  ts_unitsymbol: text(20),
  station_name: text(200),
  parametertype_name: text(40),
  rows: z.string().regex(/^\d{1,12}$/),
  columns: z.literal('Timestamp,Value'),
  data: cappedArray(z.tuple([text(40), z.number().nullable()]), 3_500),
});
export type File = z.infer<typeof File>;

/**
 * About 5× a real file (671 rows of 3 nodes: `[`, its comma and the comma after it, about 2,000 nodes; depth 4:
 * array, object, data, row).
 */
export const JSON_CAPS = { maxNodes: 12_000, maxDepth: 5 } as const satisfies JsonCaps;

/** The payload is an array of exactly one station file (scripts/gen-lu2-stations.ts destructures it). */
export function parseJson(body: Uint8Array): [File] {
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  const doc = boundedJson(json, JSON_CAPS);
  if (!Array.isArray(doc)) throw new SchemaDrift('invalid_type');
  if (doc.length !== 1) throw new SchemaDrift('array_length');
  return [parseStrict(File, doc[0], [0])];
}
