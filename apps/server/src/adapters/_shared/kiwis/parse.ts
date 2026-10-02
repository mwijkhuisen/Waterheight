import { boundedJson, cappedArray, type JsonCaps, parseStrict, SchemaDrift } from '@rws/core';
import { z } from 'zod';

// KISTERS KiWIS QueryServices (catalogue §2.4): strict schemas of the three answers the capture archives, shared by
// SPW (BE-3) and, from P13, HIC (BE-1) and VMM (BE-2). Every document is bounded before Zod sees it (packages/core
// json.ts). An error object in place of an answer (`{"code":"TooManyResults","message":…}` beyond 250,000 values,
// `InvalidParameterValue`, `DatasourceError`) is drift, never a partial result. `ts_id` is a JSON number in value
// layers and a string in getTimeseriesValues: both come out as a string of digits.

const text = (max: number) => z.string().max(max);
const TS_ID = /^\d{1,12}$/;
const tsId = z
  .union([z.number().int().nonnegative().max(999_999_999_999), z.string().regex(TS_ID)])
  .transform((v) => String(v));

/** One item of `getTimeseriesValueLayer` with the md_returnfields of the capture spec: the latest value per series. */
export const LayerItem = z.strictObject({
  ts_id: tsId,
  timestamp: text(40).nullable(),
  req_timestamp: text(40).nullable(),
  ts_value: z.number().nullable(),
  station_latitude: z.number().min(-90).max(90).nullable().optional(),
  station_longitude: z.number().min(-180).max(180).nullable().optional(),
  station_no: text(40),
  station_name: text(200),
  stationparameter_no: text(40),
  ts_unitsymbol: text(20),
});
export type LayerItem = z.infer<typeof LayerItem>;

/** A cell of a getTimeseriesValues row: what `columns` names (Timestamp, Value, Quality Code, Absolute Value). */
const Cell = z.union([text(40), z.number(), z.null()]);

/** One series of `getTimeseriesValues` (metadata=true with the md_returnfields the request builder sets). */
export const ValuesItem = z.strictObject({
  ts_id: tsId,
  ts_path: text(200).optional(),
  station_no: text(40).optional(),
  stationparameter_no: text(40).optional(),
  ts_unitsymbol: text(20).optional(),
  rows: text(12).optional(),
  columns: text(200),
  data: cappedArray(cappedArray(Cell, 8), 250_000),
});
export type ValuesItem = z.infer<typeof ValuesItem>;

/**
 * A list request (getStationList, getTimeseriesList) in KiWIS JSON: a header row of names, then rows of cells. A
 * cell holds at most 20,000 characters (SPW's longest, `ObjectDescription`, measured 2,204 on 2026-10-02).
 */
const TableRow = cappedArray(z.union([text(20_000), z.number(), z.null()]), 200);

const KiwisError = z.looseObject({ code: z.string(), message: z.string().optional() });

/** About 5× the measured documents (BE-3: 320 layer items; 501 stations × 65 columns; 100 series × 1,440 values). */
export const KIWIS_CAPS = {
  layer: { maxItems: 2_000, maxNodes: 40_000, maxDepth: 3 },
  values: { maxItems: 200, maxNodes: 1_300_000, maxDepth: 4 },
  table: { maxItems: 5_000, maxNodes: 400_000, maxDepth: 3 },
} as const satisfies Record<string, JsonCaps & { maxItems: number }>;

const decoder = new TextDecoder('utf-8', { fatal: true });
function decode(body: Uint8Array): string {
  try {
    return decoder.decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
}

/** The bounded document, or drift when it is a KiWIS error object or not an array within `maxItems`. */
function document(body: Uint8Array, caps: JsonCaps & { maxItems: number }): unknown[] {
  return arrayOf(boundedJson(decode(body), caps), caps);
}

function arrayOf(doc: unknown, caps: { maxItems: number }): unknown[] {
  if (!Array.isArray(doc)) {
    const err = KiwisError.safeParse(doc);
    if (err.success)
      throw new SchemaDrift(err.data.code === 'TooManyResults' ? 'kiwis_too_many_results' : 'kiwis_error');
    throw new SchemaDrift('invalid_type');
  }
  if (doc.length > caps.maxItems) throw new SchemaDrift('too_big');
  return doc;
}

export const parseLayer = (body: Uint8Array): LayerItem[] =>
  document(body, KIWIS_CAPS.layer).map((el, i) => parseStrict(LayerItem, el, [i]));

export const parseValues = (body: Uint8Array): ValuesItem[] =>
  document(body, KIWIS_CAPS.values).map((el, i) => parseStrict(ValuesItem, el, [i]));

/**
 * A list answer as records keyed by its header row. The header must be unique non-empty names; a row as wide as
 * the header (KiWIS writes every returnfield, null when empty). An empty list is `["No matches."]`: drift too.
 */
export const parseTable = (body: Uint8Array) => tableRecords(document(body, KIWIS_CAPS.table));

/** The same, of a document the capture's validity check already parsed under the body cap (the catch-up's list). */
export function tableRecords(parsed: unknown): Record<string, string | number | null>[] {
  const doc = arrayOf(parsed, KIWIS_CAPS.table);
  const [head, ...rows] = doc.map((el, i) => parseStrict(TableRow, el, [i]));
  if (head === undefined) throw new SchemaDrift('kiwis_no_header');
  const names = head.map((h) => (typeof h === 'string' && h !== '' ? h : null));
  if (names.length === 0 || names.includes(null) || new Set(names).size !== names.length) {
    throw new SchemaDrift('kiwis_header');
  }
  return rows.map((row, i) => {
    if (row.length !== names.length) throw new SchemaDrift('kiwis_row_width', String(i + 1));
    return Object.fromEntries(names.map((n, j) => [n as string, row[j] ?? null]));
  });
}

/** The index of each named column of a values item (`Timestamp,Value,Quality Code`), never assumed by position. */
export function columnsOf(item: ValuesItem): ReadonlyMap<string, number> {
  const names = item.columns.split(',').map((c) => c.trim());
  if (names.some((n) => n === '') || new Set(names).size !== names.length) throw new SchemaDrift('kiwis_columns');
  return new Map(names.map((n, i) => [n, i]));
}
