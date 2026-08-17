/**
 * Turning "backfill a year" into a concrete list of chunks.
 *
 * Work is enumerated from `location_quantities` -- what the WFS layer says each
 * location actually publishes -- rather than from the catalogue, which lists
 * every combination that exists anywhere.
 */

import { getPool } from '../db/pool.js';
import {
  ESTIMATED_POINTS_PER_SERIES_MONTH,
  ESTIMATED_SECONDS_PER_REQUEST,
  tierFor,
} from './tiers.js';
import type { PlannedJob } from './queue.js';

export interface PlanFilters {
  from: Date;
  to: Date;
  /** Location codes; omit for every active location. */
  locations?: string[] | undefined;
  /** Quantity codes; omit for everything the locations publish. */
  quantities?: string[] | undefined;
  /** Include quantities the tier config defers. */
  includeDeferred?: boolean | undefined;
  includeInactive?: boolean | undefined;
}

/**
 * Enumerate month starts covering [from, to), in UTC.
 *
 * Months are built from UTC components rather than by adding milliseconds:
 * month lengths vary, and local-time arithmetic would drift across the DST
 * transitions the brief warns about. (The archive itself returns a constant
 * +01:00 year-round, but the ingester still converts at its boundary and never
 * lets local time reach the database.)
 */
export function monthsBetween(from: Date, to: Date): Date[] {
  const months: Date[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor.getTime() < to.getTime()) {
    months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/** The request window for one chunk: [month, start of next month]. */
export function windowFor(month: Date): { from: Date; to: Date } {
  const to = new Date(month);
  to.setUTCMonth(to.getUTCMonth() + 1);
  return { from: new Date(month), to };
}

export interface PlanRow {
  locationCode: string;
  compartiment: string;
  grootheid: string;
}

/** The (location, compartiment, grootheid) triples in scope. */
export async function selectSeriesToBackfill(filters: PlanFilters): Promise<PlanRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!filters.includeInactive) conditions.push('l.active');

  if (filters.locations && filters.locations.length > 0) {
    params.push(filters.locations.map((c) => c.toLowerCase()));
    conditions.push(`q.location_code = ANY($${params.length}::text[])`);
  }

  if (filters.quantities && filters.quantities.length > 0) {
    params.push(filters.quantities);
    conditions.push(`q.grootheid = ANY($${params.length}::text[])`);
  }

  const { rows } = await getPool().query<{
    location_code: string; compartiment: string; grootheid: string;
  }>(
    `SELECT q.location_code, q.compartiment, q.grootheid
       FROM location_quantities q
       JOIN locations l ON l.code = q.location_code
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY q.location_code, q.grootheid`,
    params,
  );

  return rows
    .map((r) => ({
      locationCode: r.location_code,
      compartiment: r.compartiment,
      grootheid: r.grootheid,
    }))
    // An explicit --quantities request wins over the tier config: asking for a
    // deferred quantity by name is an unambiguous instruction to fetch it.
    .filter((r) =>
      filters.includeDeferred
      || (filters.quantities && filters.quantities.length > 0)
      || tierFor(r.grootheid).tier !== 'deferred');
}

export interface Plan {
  jobs: PlannedJob[];
  seriesCount: number;
  monthCount: number;
  byTier: Record<string, number>;
  byQuantity: { grootheid: string; chunks: number }[];
  projection: {
    chunks: number;
    estimatedRows: number;
    estimatedGb: number;
    estimatedHours: number;
    concurrency: number;
  };
}

export async function buildPlan(
  filters: PlanFilters,
  concurrency: number,
): Promise<Plan> {
  const series = await selectSeriesToBackfill(filters);
  const months = monthsBetween(filters.from, filters.to);

  const jobs: PlannedJob[] = [];
  const byTier: Record<string, number> = {};
  const byQuantityMap = new Map<string, number>();

  for (const row of series) {
    const { tier, priority } = tierFor(row.grootheid);
    for (const month of months) {
      jobs.push({ ...row, month, tier, priority });
    }
    byTier[tier] = (byTier[tier] ?? 0) + months.length;
    byQuantityMap.set(row.grootheid, (byQuantityMap.get(row.grootheid) ?? 0) + months.length);
  }

  const estimatedRows = jobs.length * ESTIMATED_POINTS_PER_SERIES_MONTH;

  return {
    jobs,
    seriesCount: series.length,
    monthCount: months.length,
    byTier,
    byQuantity: [...byQuantityMap.entries()]
      .map(([grootheid, chunks]) => ({ grootheid, chunks }))
      .sort((a, b) => b.chunks - a.chunks),
    projection: {
      chunks: jobs.length,
      estimatedRows,
      // ~120 bytes/row including index overhead, before compression.
      estimatedGb: Number(((estimatedRows * 120) / 1e9).toFixed(1)),
      estimatedHours: Number(
        ((jobs.length * ESTIMATED_SECONDS_PER_REQUEST) / concurrency / 3600).toFixed(1),
      ),
      concurrency,
    },
  };
}
