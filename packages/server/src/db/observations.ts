/**
 * Observation read and write paths.
 *
 * Writes are idempotent upserts, so corrections overwrite in place and a retry
 * of a partially-applied chunk is harmless.
 *
 * Reads pick raw rows for short windows and a continuous aggregate for longer
 * ones. A browser drawing a 400px-wide chart never needs 50,000 points.
 */

import type { PoolClient } from 'pg';
import type { AggregatePoint, RawPoint, Resolution } from '@rws/shared';
import { config } from '../config.js';
import type { NormalisedPoint } from '../sources/rws/normalise.js';
import { getPool } from './pool.js';
import { resolveLocationKey } from '../sources/registry.js';

/**
 * Insert or update a batch of points for one series.
 *
 * Runs on the caller's client so the backfill can mark a chunk done in the
 * same transaction that commits its rows.
 */
export async function upsertObservations(
  client: PoolClient,
  seriesId: number,
  points: NormalisedPoint[],
  fetchedAt = new Date(),
): Promise<number> {
  if (points.length === 0) return 0;

  const { rowCount } = await client.query(
    `INSERT INTO observations (series_id, ts, value_numeric, value_text, quality_code, status, fetched_at)
     SELECT $1, ts, value_numeric, value_text, quality_code, status, $7
       FROM unnest($2::timestamptz[], $3::float8[], $4::text[], $5::text[], $6::text[])
            AS t(ts, value_numeric, value_text, quality_code, status)
     ON CONFLICT (series_id, ts) DO UPDATE SET
       value_numeric = EXCLUDED.value_numeric,
       value_text    = EXCLUDED.value_text,
       quality_code  = EXCLUDED.quality_code,
       status        = EXCLUDED.status,
       fetched_at    = EXCLUDED.fetched_at`,
    [
      seriesId,
      points.map((p) => p.t),
      points.map((p) => p.value),
      points.map((p) => p.text),
      points.map((p) => p.qualityCode),
      points.map((p) => p.status),
      fetchedAt.toISOString(),
    ],
  );
  return rowCount ?? 0;
}

/**
 * Materialise the continuous aggregates over a window that was just ingested.
 *
 * The scheduled policies only cover recent time (3 days hourly, 30 days daily),
 * which is right for keeping up with live data but useless for backfill: a
 * chunk of history from eight months ago falls outside every policy window and
 * would never be aggregated, so the 1-year chart would silently come back
 * empty. Any ingest that writes outside the policy window must refresh
 * explicitly, which is what TimescaleDB recommends for backfilled data.
 *
 * Cannot run inside a transaction, so call it after the write has committed.
 */
export async function refreshAggregates(from: Date, to: Date): Promise<void> {
  // time_bucket boundaries: widen to whole days so partial buckets at the edges
  // are recomputed from complete data rather than left half-filled.
  const start = new Date(from.getTime() - 86_400_000);
  const end = new Date(to.getTime() + 86_400_000);

  for (const view of ['observations_hourly', 'observations_daily']) {
    // Explicit casts: PostgreSQL cannot infer parameter types inside CALL.
    await getPool().query(
      `CALL refresh_continuous_aggregate($1::regclass, $2::timestamptz, $3::timestamptz)`,
      [view, start.toISOString(), end.toISOString()],
    );
  }
}

/** Roughly how many raw points a window holds, at the 10-minute publish cadence. */
export function estimateRawPoints(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / (10 * 60_000));
}

/**
 * Choose the resolution to serve.
 *
 * An explicit request is honoured when it fits under the point cap; otherwise
 * it is coarsened and the response says so, which is better than silently
 * truncating the tail off a chart.
 */
export function selectResolution(
  from: Date,
  to: Date,
  requested: Resolution | null,
  maxPoints = config.maxPointsPerResponse,
): { resolution: Resolution; downsampled: boolean } {
  const spanMs = Math.max(0, to.getTime() - from.getTime());
  const counts: Record<Resolution, number> = {
    raw: estimateRawPoints(from, to),
    hourly: Math.ceil(spanMs / 3_600_000),
    daily: Math.ceil(spanMs / 86_400_000),
  };

  const order: Resolution[] = ['raw', 'hourly', 'daily'];

  if (requested) {
    if (counts[requested] <= maxPoints) return { resolution: requested, downsampled: requested !== 'raw' };
    const coarser = order.slice(order.indexOf(requested) + 1).find((r) => counts[r] <= maxPoints);
    return { resolution: coarser ?? 'daily', downsampled: true };
  }

  const chosen = order.find((r) => counts[r] <= maxPoints) ?? 'daily';
  return { resolution: chosen, downsampled: chosen !== 'raw' };
}

export interface ReadResult {
  resolution: Resolution;
  points: RawPoint[] | AggregatePoint[];
  truncated: boolean;
}

/**
 * Read a series over a window.
 *
 * Quality filtering happens here, at read time, not at ingest: the raw code is
 * always stored so a change of display policy costs nothing. `qualityCodes`
 * restricts which codes count; passing null returns everything.
 */
export async function readObservations(
  seriesId: number,
  from: Date,
  to: Date,
  resolution: Resolution,
  qualityCodes: readonly string[] | null,
  maxPoints = config.maxPointsPerResponse,
): Promise<ReadResult> {
  // Fetch one extra row to detect truncation without a second count query.
  const limit = maxPoints + 1;

  if (resolution === 'raw') {
    const params: unknown[] = [seriesId, from.toISOString(), to.toISOString()];
    let qualityClause = '';
    if (qualityCodes) {
      params.push(qualityCodes as string[]);
      qualityClause = ` AND (quality_code IS NULL OR quality_code = ANY($${params.length}::text[]))`;
    }
    params.push(limit);

    const { rows } = await getPool().query<{
      ts: Date; value_numeric: number | null; quality_code: string | null;
    }>(
      `SELECT ts, value_numeric, quality_code
         FROM observations
        WHERE series_id = $1 AND ts >= $2 AND ts <= $3${qualityClause}
        ORDER BY ts
        LIMIT $${params.length}`,
      params,
    );

    const truncated = rows.length > maxPoints;
    const points: RawPoint[] = rows.slice(0, maxPoints).map((r) => ({
      t: r.ts.toISOString(),
      v: r.value_numeric,
      q: r.quality_code,
    }));
    return { resolution, points, truncated };
  }

  const view = resolution === 'hourly' ? 'observations_hourly' : 'observations_daily';
  const { rows } = await getPool().query<{
    bucket: Date; min_value: number | null; max_value: number | null;
    mean_value: number | null; point_count: number;
  }>(
    `SELECT bucket, min_value, max_value, mean_value, point_count
       FROM ${view}
      WHERE series_id = $1 AND bucket >= $2 AND bucket <= $3
      ORDER BY bucket
      LIMIT $4`,
    [seriesId, from.toISOString(), to.toISOString(), limit],
  );

  const truncated = rows.length > maxPoints;
  const points: AggregatePoint[] = rows.slice(0, maxPoints).map((r) => ({
    t: r.bucket.toISOString(),
    min: r.min_value,
    max: r.max_value,
    mean: r.mean_value,
    count: r.point_count,
  }));
  return { resolution, points, truncated };
}

export interface LatestRow {
  seriesId: number;
  grootheid: string;
  eenheid: string | null;
  procesType: string;
  ts: string;
  value: number | null;
  valueText: string | null;
  qualityCode: string | null;
}

/** Latest stored point for every series at a location. */
export async function readLatestForLocation(locationCode: string): Promise<LatestRow[]> {
  const { rows } = await getPool().query<{
    series_id: number; grootheid: string; eenheid: string | null; proces_type: string;
    ts: Date; value_numeric: number | null; value_text: string | null; quality_code: string | null;
  }>(
    // Prefer the most recent row that actually carries a reading. The newest
    // row for a series is often a gap (quality code '99'), and reporting that
    // as "the latest value" gives the panel a blank where a number belongs.
    // Falls back to the newest row when a series has nothing but gaps.
    `SELECT DISTINCT ON (o.series_id)
            o.series_id, s.grootheid, s.eenheid, s.proces_type,
            o.ts, o.value_numeric, o.value_text, o.quality_code
       FROM observations o
       JOIN series s ON s.id = o.series_id
      WHERE s.location_code = $1
      ORDER BY o.series_id, (o.value_numeric IS NOT NULL) DESC, o.ts DESC`,
    [resolveLocationKey(locationCode)],
  );

  return rows.map((r) => ({
    seriesId: r.series_id,
    grootheid: r.grootheid,
    eenheid: r.eenheid,
    procesType: r.proces_type,
    ts: r.ts.toISOString(),
    value: r.value_numeric,
    valueText: r.value_text,
    qualityCode: r.quality_code,
  }));
}
