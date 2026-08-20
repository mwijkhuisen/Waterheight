/**
 * On-demand observation ingest.
 *
 * The read path serves from the local store; when a window is not covered
 * locally this fetches it from Rijkswaterstaat, stores it, and lets the caller
 * read it back. That is what makes the API useful before the Phase 4 backfill
 * has run, and it doubles as the lazy path for quantities that are never
 * eagerly backfilled.
 */

import { withTransaction } from '../db/pool.js';
import { refreshCoverage, upsertSeries } from '../db/series.js';
import { refreshAggregates, upsertObservations } from '../db/observations.js';
import { fetchObservations } from '../sources/rws/client.js';
import { normaliseObservations } from '../sources/rws/normalise.js';

/**
 * Largest window fetched synchronously while a user waits.
 *
 * A month of 10-minute data is ~4,450 points and came back in ~1 s live, so a
 * few months is tolerable. Anything longer belongs to the batch backfill.
 */
export const MAX_LIVE_FETCH_DAYS = 92;

export interface EnsureResult {
  fetched: boolean;
  seriesIds: number[];
  rowsWritten: number;
  /** Set when the upstream call failed and stale local data was left in place. */
  error?: string;
}

export interface EnsureParams {
  locationCode: string;
  grootheid: string;
  compartiment: string;
  from: Date;
  to: Date;
  procesType?: string;
}

/**
 * Fetch a window from upstream and store it.
 *
 * Series rows are created here rather than during the location refresh,
 * because only an observation response carries the full AquoMetadata that
 * distinguishes one physical series from another.
 */
export async function ensureObservations(params: EnsureParams): Promise<EnsureResult> {
  const spanDays = (params.to.getTime() - params.from.getTime()) / 86_400_000;
  if (spanDays > MAX_LIVE_FETCH_DAYS) {
    return { fetched: false, seriesIds: [], rowsWritten: 0 };
  }

  let response;
  try {
    response = await fetchObservations({
      locationCode: params.locationCode,
      compartiment: params.compartiment,
      grootheid: params.grootheid,
      ...(params.procesType ? { procesType: params.procesType } : {}),
      from: params.from,
      to: params.to,
    });
  } catch (err) {
    // Upstream failure must not fail the request: whatever is stored locally
    // is still served, flagged as stale.
    return { fetched: false, seriesIds: [], rowsWritten: 0, error: (err as Error).message };
  }

  // 204 means no data matched, which is an empty series rather than an error.
  if (!response.data) return { fetched: true, seriesIds: [], rowsWritten: 0 };

  const series = normaliseObservations(response.data);
  if (series.length === 0) return { fetched: true, seriesIds: [], rowsWritten: 0 };

  const fetchedAt = new Date();

  const result = await withTransaction(async (client) => {
    const seriesIds: number[] = [];
    let rowsWritten = 0;

    for (const s of series) {
      const seriesId = await upsertSeries(client, s.identity);
      seriesIds.push(seriesId);
      rowsWritten += await upsertObservations(client, seriesId, s.points, fetchedAt);
    }

    await refreshCoverage(client, seriesIds);
    return { fetched: true as const, seriesIds, rowsWritten };
  });

  // After the write commits: the scheduled policies do not cover historical
  // windows, so without this the hourly/daily views stay empty for this range.
  if (result.rowsWritten > 0) {
    await refreshAggregates(params.from, params.to);
  }

  return result;
}
