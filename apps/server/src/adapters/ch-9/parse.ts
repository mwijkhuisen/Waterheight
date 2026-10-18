import { type JsonCaps, parseJsonArray, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// CH-9 Basel-Stadt open data (data.bs.ch, Explore v2.1), P14b backfill: `/exports/json` of one dataset is a bare JSON
// array of records, sorted by time. The body does not name its dataset, so the manifest variant does (the dataset id)
// and each dataset has its own strict record: 100089 (Rhine, Basel Rheinhalle) and 100236 (Birs, Münchenstein).
// A key the schema does not know is SchemaDrift; numbers or null; every provider string is data.

/** ISO 8601 with an explicit offset (`+00:00` seen); an offset-less stamp is drift (invariant 4). */
const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/);
const Num = z.number().nullable();

const RHINE = z.strictObject({ timestamp: Timestamp, abfluss: Num, pegelhoehe: Num, pegel: Num });
const BIRS = z.strictObject({ timestamp: Timestamp, abfluss: Num, pegel: Num, temperatur: Num });

/** One record: `abfluss` m³/s, `pegel` m ü. M. (LN02), `pegelhoehe` cm (100089 only), `temperatur` °C (100236 only, never stored). */
export type Ch9Record = {
  timestamp: string;
  abfluss: number | null;
  pegel: number | null;
  pegelhoehe?: number | null | undefined;
};

const SCHEMAS: Readonly<Record<string, z.ZodType<Ch9Record>>> = { '100089': RHINE, '100236': BIRS };

/** A P30D chunk is 8,640 records at 5 minutes; 20,000 leaves room. A record is 5 nodes in the bounded scan (120,000 with room). */
export const MAX_RECORDS = 20_000;
export const JSON_CAPS: JsonCaps & { maxItems: number } = { maxNodes: 120_000, maxDepth: 3, maxItems: MAX_RECORDS };

const utf8 = new TextDecoder('utf-8', { fatal: true });
function text(body: Uint8Array): string {
  try {
    return utf8.decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
}

/** The records of one dataset's export (`dataset`: the manifest variant); an unknown dataset is drift. */
export function parseRecords(body: Uint8Array, dataset: string): Ch9Record[] {
  const schema = Object.hasOwn(SCHEMAS, dataset) ? SCHEMAS[dataset] : undefined;
  if (schema === undefined) throw new SchemaDrift('unknown_variant');
  return parseJsonArray(text(body), schema, JSON_CAPS);
}

/** The variant-free check of the runner (it does not know the dataset's schema): an array of records with a stamp. */
export function countRecords(body: Uint8Array): number {
  return parseJsonArray(text(body), z.looseObject({ timestamp: Timestamp }), JSON_CAPS).length;
}
