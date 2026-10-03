import { type JsonCaps, parseJsonArray, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// DE-2 BfG water-level forecast (catalogue §2.2, `WV`): one PEGELONLINE measurements document per station,
// `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/<uuid>/WV/measurements.json`, a JSON array of
// points that all state the run's `initialized`. Strict schema of one point: a key the schema does not know is
// SchemaDrift, and every provider string is data (length-capped, never interpreted). The real document is 49 points
// (25 `forecast` up to 48 h, 24 `estimate` up to 96 h), two hours apart.

const Point = z.strictObject({
  initialized: z.string().max(40),
  timestamp: z.string().max(40),
  // Integer centimetres in every document seen; a decimal is fine, a string, NaN or Infinity is not.
  value: z.number().nullable(),
  type: z.enum(['forecast', 'estimate']),
});
export type Point = z.infer<typeof Point>;

/** At most this many points (the real document has 49). */
export const MAX_POINTS = 200;

/** A point is 5 values in the bounded scan's count: 200 points are about 1,000; the real document has 246. */
export const JSON_CAPS: JsonCaps & { maxItems: number } = { maxNodes: 1_500, maxDepth: 3, maxItems: MAX_POINTS };

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function parseForecast(body: Uint8Array): Point[] {
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  return parseJsonArray(text, Point, JSON_CAPS);
}
