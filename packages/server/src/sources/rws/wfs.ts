/**
 * Parsing for the OGC WFS layer `locatiesmetlaatstewaarneming`, which is the
 * authoritative source for which locations exist in this application.
 *
 * The layer is requested as CSV restricted to the columns we need. GeoJSON is
 * offered and is nicer to parse, but the full layer is ~940k features and the
 * GeoJSON encoding of it exceeds V8's ~512 MB string cap, so CSV it is.
 *
 * Watch the axis order: GeoJSON gives [lon, lat] while this CSV gives
 * `POINT (lat lon)`.
 */

import { RWS_SOURCE_ID, locationKey, normaliseSourceCode } from '../registry.js';

/** Columns requested via PROPERTYNAME, in the layer's own naming. */
export const WFS_LATEST_COLUMNS = [
  'CODE',
  'NAAM',
  'GROOTHEIDCODE',
  'COMPARTIMENTCODE',
  'EENHEIDCODE',
  'TIJDSTIP_LAATSTE_METING',
  'WAARDE_LAATSTE_METING',
  'GEOMETRY',
] as const;

export interface WfsLatestRow {
  /** Qualified location key, e.g. `rws:lobith`. */
  code: string;
  /** The code as Rijkswaterstaat publishes it, case-folded. */
  sourceCode: string;
  name: string;
  grootheid: string | null;
  compartiment: string | null;
  eenheid: string | null;
  /** ISO 8601 UTC. */
  lastSeenAt: string;
  value: number | null;
  lat: number | null;
  lon: number | null;
}

/** Split one CSV line, honouring quoted fields and doubled-quote escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** CSV geometry is `POINT (lat lon)` -- note the axis order. */
export function parsePointLatLon(wkt: string | undefined): { lat: number | null; lon: number | null } {
  const m = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(wkt ?? '');
  if (!m) return { lat: null, lon: null };
  return { lat: Number(m[1]), lon: Number(m[2]) };
}

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Plausible bounds for a "last measurement" timestamp.
 *
 * The layer contains genuinely old records (a few hundred rows predate 1900)
 * and occasional corrupt ones -- a real download produced year 13094, which
 * Date.parse accepts happily and PostgreSQL then rejects with "time zone
 * displacement out of range", failing the whole batch. Bounding here turns a
 * poisoned row into a skipped row.
 */
const MIN_PLAUSIBLE_MS = Date.UTC(1900, 0, 1);
const MAX_FUTURE_MS = 366 * 86_400_000;

export function isPlausibleTimestamp(ms: number, now = Date.now()): boolean {
  return ms >= MIN_PLAUSIBLE_MS && ms <= now + MAX_FUTURE_MS;
}

/**
 * Applies to the code as Rijkswaterstaat publishes it, not to the qualified
 * location key -- the key's `source:` prefix is ours and is not what a corrupt
 * row would damage.
 *
 * Location codes are lowercase dotted strings; all 2,608 in the live layer
 * match this, none contain whitespace, and the longest is 62 characters.
 *
 * Checking the shape catches field-shifted rows, which is what a corrupted
 * stream produces: a line that starts mid-record loses the opening quote of a
 * name like "Terschelling, 20 km uit de kust", so the comma inside it splits
 * the fields and the *name* fragment lands in the code column.
 */
const CODE_PATTERN = /^[a-z0-9._-]{1,80}$/;

export function isPlausibleCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/**
 * Parse one CSV row into a location row, or null if it is unusable.
 * Rows without a code or a parseable timestamp cannot be placed on the map or
 * aged, so they are dropped rather than stored half-formed.
 */
export function parseWfsLatestRow(
  record: Record<string, string | undefined>,
): WfsLatestRow | null {
  const rawCode = record['CODE'];
  if (!rawCode || rawCode.trim() === '') return null;

  const rawTs = record['TIJDSTIP_LAATSTE_METING'];
  const ms = rawTs ? Date.parse(rawTs) : Number.NaN;
  if (Number.isNaN(ms) || !isPlausibleTimestamp(ms)) return null;

  const { lat, lon } = parsePointLatLon(record['GEOMETRY']);
  // Validate before qualifying: the shape check exists to catch field-shifted
  // rows, and it is the upstream code that gets shifted.
  const sourceCode = normaliseSourceCode(RWS_SOURCE_ID, rawCode);
  if (!isPlausibleCode(sourceCode)) return null;

  return {
    code: locationKey(RWS_SOURCE_ID, sourceCode),
    sourceCode,
    name: record['NAAM']?.trim() || sourceCode,
    grootheid: record['GROOTHEIDCODE']?.trim() || null,
    compartiment: record['COMPARTIMENTCODE']?.trim() || null,
    eenheid: record['EENHEIDCODE']?.trim() || null,
    lastSeenAt: new Date(ms).toISOString(),
    value: num(record['WAARDE_LAATSTE_METING']),
    lat,
    lon,
  };
}

/**
 * Build a record from one split CSV line, repairing rows that over-split.
 *
 * The layer's CSV is not properly escaped: a location name containing a comma
 * -- "Aa, Helmond", "Waal, de Neswaarden" -- is emitted raw rather than
 * quoted, so the line splits into more fields than the header has columns and
 * every value after the name lands one column to the right. Measured against
 * the live layer, 47% of rows are affected and the parser dropped all of them:
 * ~20% of rows failed outright (a name fragment is not a plausible location
 * code), which then tripped the truncation guard and failed the whole refresh.
 *
 * NAAM is the only free-text column -- the codes are codes, WAARDE is numeric,
 * TIJDSTIP is a timestamp and GEOMETRY is `POINT (lat lon)`, which contains no
 * comma. So the columns before the name can be anchored from the left and
 * those after it from the right, and whatever is left in the middle is the
 * name. Verified against 30,000 live rows: every one reassembles into a
 * plausible code, a parseable timestamp and a WKT point.
 *
 * A row with no surplus takes the same path as before, and a short row still
 * yields undefined for the missing columns.
 */
export function toWfsRecord(
  columns: string[],
  fields: string[],
): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};
  const nameIndex = columns.indexOf('NAAM');
  const surplus = fields.length - columns.length;

  // Nothing to repair, or nowhere to put the surplus: map positionally.
  if (surplus <= 0 || nameIndex === -1) {
    columns.forEach((c, i) => { record[c] = fields[i]; });
    return record;
  }

  columns.forEach((c, i) => {
    if (i < nameIndex) record[c] = fields[i];
    else if (i === nameIndex) record[c] = fields.slice(i, i + 1 + surplus).join(',');
    else record[c] = fields[i + surplus];
  });
  return record;
}

/**
 * Parse a whole CSV document. Only for small documents and tests -- the daily
 * refresh streams the real 173 MB layer line by line instead (see
 * ingest/locations.ts).
 */
export function parseWfsLatestCsv(text: string): WfsLatestRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  const header = lines.shift();
  if (!header) return [];
  const columns = splitCsvLine(header);

  const rows: WfsLatestRow[] = [];
  for (const line of lines) {
    const record = toWfsRecord(columns, splitCsvLine(line));
    const row = parseWfsLatestRow(record);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Collapse per-quantity rows into one record per location.
 *
 * The layer emits one row per location+quantity (~940k rows for ~2,600
 * locations), so a location's freshness is its single newest observation across
 * all of its quantities.
 */
export interface AggregatedLocation {
  code: string;
  sourceCode: string;
  name: string;
  lat: number | null;
  lon: number | null;
  lastSeenAt: string;
  quantities: Set<string>;
}

export function aggregateByLocation(rows: Iterable<WfsLatestRow>): Map<string, AggregatedLocation> {
  const byCode = new Map<string, AggregatedLocation>();

  for (const row of rows) {
    let entry = byCode.get(row.code);
    if (!entry) {
      entry = {
        code: row.code,
        sourceCode: row.sourceCode,
        name: row.name,
        lat: row.lat,
        lon: row.lon,
        lastSeenAt: row.lastSeenAt,
        quantities: new Set(),
      };
      byCode.set(row.code, entry);
    }
    if (row.lastSeenAt > entry.lastSeenAt) entry.lastSeenAt = row.lastSeenAt;
    if (entry.lat === null && row.lat !== null) { entry.lat = row.lat; entry.lon = row.lon; }
    if (row.grootheid) entry.quantities.add(row.grootheid);
  }

  return byCode;
}
