import { boundedJson, cappedArray, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// LU-3 AGE percentile forecasts (catalogue §2.6): one file per station and percentile,
// `https://inondations.public.lu/percentile/<slug>-p<10|30|50|70|90>.json`. Strict schema of one file: anything
// the schema does not know is a SchemaDrift, and every provider string is data (length-capped, never interpreted).
// `rows`, `columns`, `ts_path`, `ts_unitsymbol` and `parametertype_name` are null in every file seen; a value in
// one of them is drift, not something to ignore.

const Point = z.tuple([z.string().max(40), z.number().nullable()]);

const Percentile = z.strictObject({
  rows: z.null(),
  columns: z.null(),
  // About 46 hourly steps; 500 is the cap, so a long array of the wrong shape is one issue.
  data: cappedArray(Point, 500),
  ts_path: z.null(),
  ts_unitsymbol: z.null(),
  station_name: z.string().max(200),
  parametertype_name: z.null(),
});
export type Percentile = z.infer<typeof Percentile>;
export type Point = z.infer<typeof Point>;

/** About 5× the real size (a file of 46 points is about 140 values at depth 3). */
export const JSON_CAPS = { maxNodes: 5_000, maxDepth: 4 } as const;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function parsePercentile(body: Uint8Array): Percentile {
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  return parseStrict(Percentile, boundedJson(text, JSON_CAPS));
}
