/**
 * Daily refresh of the location set from the WFS layer.
 *
 * The layer is ~940k rows / ~173 MB, so it is streamed and parsed line by line
 * rather than buffered: the whole document as a single string exceeds V8's
 * ~512 MB cap, and holding it in memory would be wasteful even if it did not.
 */

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import { upsertLocations, type UpsertSummary } from '../db/locations.js';
import { fetchWfsFeatureCount, fetchWfsLatestPage } from '../rws/client.js';
import {
  WFS_LATEST_COLUMNS,
  aggregateByLocation,
  parseWfsLatestRow,
  splitCsvLine,
  toWfsRecord,
  type WfsLatestRow,
} from '../rws/wfs.js';

export interface RefreshLocationsResult extends UpsertSummary {
  rowsParsed: number;
  rowsSkipped: number;
  quantitiesUpserted: number;
  durationMs: number;
}

/**
 * Fraction of the layer that may be missing or unparseable before the refresh
 * is treated as a bad download rather than a real change.
 *
 * This is not paranoia: a live run returned ~68% of the layer and then garbage
 * for the remainder. Reconciling `active` from that would have deactivated
 * two-thirds of the map and written a deactivation event for every one of them.
 * Refusing to reconcile is always recoverable; a mass deactivation is not.
 */
const MAX_MISSING_FRACTION = 0.02;

/** Features per WFS request. ~18 MB per page, so a failed page is cheap. */
const PAGE_SIZE = 100_000;

/** Attempts per page before the whole refresh is abandoned. */
const PAGE_ATTEMPTS = 4;

/**
 * Rows a single page may lose before it is retried.
 *
 * A page that arrives short is a corrupted stream, not a smaller page: the
 * service returns exactly `maxFeatures` rows for every page but the last.
 * Unparseable rows do exist in the layer (a few hundred pre-1900 timestamps),
 * hence a small allowance rather than an exact match.
 */
const PAGE_TOLERANCE = 0.01;

interface PageResult {
  rows: WfsLatestRow[];
  parsed: number;
  skipped: number;
}

/** Stream and parse one page, retrying if it arrives short. */
async function readPageWithRetry(
  startIndex: number,
  expectedInPage: number,
  log: (msg: string) => void,
): Promise<PageResult> {
  let lastSeen = 0;

  for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt++) {
    const response = await fetchWfsLatestPage(WFS_LATEST_COLUMNS, {
      startIndex,
      count: expectedInPage,
    });
    if (!response.body) throw new Error('WFS returned no body');

    const rl = createInterface({
      input: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      crlfDelay: Infinity,
    });

    let columns: string[] | null = null;
    let seen = 0;
    let skipped = 0;
    const rows: WfsLatestRow[] = [];

    for await (const line of rl) {
      if (line === '') continue;
      const fields = splitCsvLine(line);
      if (!columns) { columns = fields; continue; }

      seen += 1;
      // Repairs rows the layer over-splits on unescaped commas in NAAM.
      const record = toWfsRecord(columns, fields);

      const row = parseWfsLatestRow(record);
      if (row) rows.push(row);
      else skipped += 1;
    }

    if (seen >= expectedInPage * (1 - PAGE_TOLERANCE)) {
      return { rows, parsed: rows.length, skipped };
    }

    lastSeen = seen;
    log(
      `[refresh] page at ${startIndex} returned ${seen}/${expectedInPage} rows, ` +
      `retrying (attempt ${attempt}/${PAGE_ATTEMPTS})`,
    );
  }

  throw new Error(
    `WFS page at startIndex ${startIndex} kept arriving short ` +
    `(${lastSeen}/${expectedInPage}) after ${PAGE_ATTEMPTS} attempts`,
  );
}

export class TruncatedLayerError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
    readonly skipped = 0,
  ) {
    super(
      `WFS layer looks truncated: expected ${expected} features, ` +
      `parsed ${received} (${((1 - received / expected) * 100).toFixed(1)}% missing, ` +
      `${skipped} unparseable). ` +
      (received + skipped >= expected
        ? 'Every feature arrived, so this is a parsing failure rather than a ' +
          'short download -- check the layer\'s column layout.'
        : 'Refusing to reconcile active flags from a partial download.'),
    );
    this.name = 'TruncatedLayerError';
  }
}

export async function refreshLocations(
  log: (msg: string) => void = console.log,
): Promise<RefreshLocationsResult> {
  const started = Date.now();

  // Ask how many features to expect before downloading, so a short or
  // corrupted stream can be detected rather than silently accepted.
  const expectedFeatures = await fetchWfsFeatureCount();
  log(`[refresh] layer reports ${expectedFeatures.toLocaleString()} features`);

  log('[refresh] streaming locatiesmetlaatstewaarneming in pages...');
  const rows: WfsLatestRow[] = [];
  let rowsParsed = 0;
  let rowsSkipped = 0;

  for (let startIndex = 0; startIndex < expectedFeatures; startIndex += PAGE_SIZE) {
    const expectedInPage = Math.min(PAGE_SIZE, expectedFeatures - startIndex);
    const page = await readPageWithRetry(startIndex, expectedInPage, log);
    rows.push(...page.rows);
    rowsParsed += page.parsed;
    rowsSkipped += page.skipped;
  }

  log(`[refresh] parsed ${rowsParsed} rows (${rowsSkipped} skipped)`);

  // A handful of unparseable rows is normal (corrupt timestamps exist in the
  // layer); losing a meaningful fraction means the download itself was bad.
  //
  // rowsParsed excludes rows the parser rejected, so a parsing regression shows
  // up here as a truncated download. rowsSkipped is reported alongside it to
  // keep the two distinguishable: skipped high with parsed + skipped == the
  // expected count means everything arrived and the parser is at fault.
  if (rowsParsed < expectedFeatures * (1 - MAX_MISSING_FRACTION)) {
    throw new TruncatedLayerError(expectedFeatures, rowsParsed, rowsSkipped);
  }

  const byLocation = aggregateByLocation(rows);
  const cutoff = new Date(Date.now() - config.activeWindowDays * 86_400_000);

  const summary = await upsertLocations(
    [...byLocation.values()].map((l) => ({
      code: l.code,
      name: l.name,
      lat: l.lat,
      lon: l.lon,
      lastSeenAt: l.lastSeenAt,
    })),
    cutoff,
  );

  const quantitiesUpserted = await upsertLocationQuantities(rows);

  await recordRefresh('locations', {
    expectedFeatures,
    rowsParsed,
    rowsSkipped,
    locations: byLocation.size,
    ...summary,
  });

  const durationMs = Date.now() - started;

  // Activations and deactivations are logged individually in location_events;
  // this is the summary line for whoever is watching the job run.
  log(
    `[refresh] ${byLocation.size} locations: ${summary.created} new, ` +
    `${summary.activated} activated, ${summary.deactivated} deactivated (${durationMs} ms)`,
  );

  return { ...summary, rowsParsed, rowsSkipped, quantitiesUpserted, durationMs };
}

/**
 * Record which quantities each location publishes.
 *
 * Rows are only ever added or refreshed, never deleted: a quantity that stops
 * appearing keeps its last_seen_at and ages out of the active view naturally,
 * the same way locations do.
 */
async function upsertLocationQuantities(rows: WfsLatestRow[]): Promise<number> {
  // The layer repeats a (location, compartiment, grootheid) triple once per
  // physical series, so collapse to the newest before writing.
  const byKey = new Map<string, WfsLatestRow>();
  for (const row of rows) {
    if (!row.grootheid || !row.compartiment) continue;
    const key = `${row.code}|${row.compartiment}|${row.grootheid}`;
    const existing = byKey.get(key);
    if (!existing || row.lastSeenAt > existing.lastSeenAt) byKey.set(key, row);
  }

  const values = [...byKey.values()];
  if (values.length === 0) return 0;

  await withTransaction(async (client) => {
    const CHUNK = 5000;
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      await client.query(
        `INSERT INTO location_quantities
           (location_code, compartiment, grootheid, eenheid, last_seen_at, latest_value)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::float8[]
         )
         ON CONFLICT (location_code, compartiment, grootheid) DO UPDATE SET
           eenheid = COALESCE(EXCLUDED.eenheid, location_quantities.eenheid),
           last_seen_at = GREATEST(location_quantities.last_seen_at, EXCLUDED.last_seen_at),
           latest_value = EXCLUDED.latest_value,
           updated_at = now()`,
        [
          chunk.map((r) => r.code),
          chunk.map((r) => r.compartiment),
          chunk.map((r) => r.grootheid),
          chunk.map((r) => r.eenheid),
          chunk.map((r) => r.lastSeenAt),
          chunk.map((r) => r.value),
        ],
      );
    }
  });

  return values.length;
}

export async function recordRefresh(
  name: string,
  detail: Record<string, unknown>,
  succeeded = true,
): Promise<void> {
  await getPool().query(
    `INSERT INTO refresh_state (name, refreshed_at, succeeded, detail)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (name) DO UPDATE SET
       refreshed_at = EXCLUDED.refreshed_at,
       succeeded = EXCLUDED.succeeded,
       detail = EXCLUDED.detail,
       updated_at = now()`,
    [name, succeeded, JSON.stringify(detail)],
  );
}

export async function getRefreshState(
  name: string,
): Promise<{ refreshedAt: string | null; succeeded: boolean | null } | null> {
  const { rows } = await getPool().query<{ refreshed_at: Date | null; succeeded: boolean | null }>(
    'SELECT refreshed_at, succeeded FROM refresh_state WHERE name = $1',
    [name],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    refreshedAt: row.refreshed_at?.toISOString() ?? null,
    succeeded: row.succeeded,
  };
}
