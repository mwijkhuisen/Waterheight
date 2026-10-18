import type { DailyMean } from '@rws/core';
import { SUSPECT_BITS } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { snapshot } from '../api/util.ts';
import { type ChannelAudience, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';

// The inputs of the day-of-year climatology (P14f, plan section 3.4), read ONLY through the family's views, in a
// READ ONLY transaction: the family decides which series and which observations the command may see (invariants 2
// and 11), so a public series' statistic is computed from its public view and an owner series exists only in the
// owner run. No base table is read for the data.

export type Candidate = {
  id: number;
  station: string;
  /** The series' own source: the stored rows carry it (the reference views filter on it). */
  source: string;
  /** The series' effective audience in this family's view (the dirty log narrows by it). */
  audience: 'public' | 'owner';
  quantity: 'H' | 'Q';
  unit: 'cm' | 'm³/s';
  eligible: boolean;
};

const flagOf = (flags: unknown, key: string) =>
  typeof flags === 'object' && flags !== null && (flags as Record<string, unknown>)[key] === true;

/**
 * Every series of the family's series view with the plan's eligibility (section 1b): active, level (not stage) or
 * discharge, a station that is neither tidal nor impounded, and the history_export channel (without it the view
 * hides everything older than the history window, which would starve the statistic). An inactive series is read
 * too, so that its open rows are closed (P14f review R1-2). The owner run takes only series that are not in the
 * public family: a public series is computed once, from its public view.
 */
export async function readCandidates(db: Kysely<DB>, family: ChannelAudience): Promise<Candidate[]> {
  const V = VIEWS[family];
  return snapshot(db, async (tx) => {
    const rows = (
      await sql<{
        id: number;
        station_id: string;
        source_id: string;
        audience: 'public' | 'owner';
        quantity: 'H' | 'Q';
        value_kind: 'stage' | 'level' | null;
        active: boolean;
        lic_history_export: boolean;
        flags: unknown;
      }>`
        SELECT s.id, s.station_id, s.source_id, s.audience::text AS audience, s.quantity, s.value_kind, s.active,
               s.lic_history_export, st.flags
        FROM ${sql.table(V.series)} s JOIN ${sql.table(V.station)} st ON st.id = s.station_id
        ORDER BY s.id`.execute(tx)
    ).rows;
    const publicIds =
      family === 'owner'
        ? new Set(
            (await sql<{ id: number }>`SELECT id FROM ${sql.table(VIEWS.public.series)}`.execute(tx)).rows.map(
              (r) => r.id,
            ),
          )
        : new Set<number>();
    return rows
      .filter((r) => !publicIds.has(r.id))
      .map((r) => ({
        id: r.id,
        station: r.station_id,
        source: r.source_id,
        audience: r.audience,
        quantity: r.quantity,
        unit: r.quantity === 'H' ? ('cm' as const) : ('m³/s' as const),
        eligible:
          r.active &&
          (r.quantity === 'Q' || r.value_kind === 'level') &&
          r.lic_history_export &&
          !flagOf(r.flags, 'tidal') &&
          !flagOf(r.flags, 'impounded'),
      }));
  });
}

/**
 * The daily means of one series over its whole history: per UTC hour the mean of the samples without a suspect qc
 * bit, per UTC day the mean of those hourly means and the number of hours (step-agnostic: an hourly 1995 and a
 * 10-minute 2026 weigh alike). One row per day, as `doyClimatology` requires. Backfilled history has no rollups
 * before DATA_FLOOR, hence the raw observation view.
 */
export function readDailyMeans(db: Kysely<DB>, family: ChannelAudience, series: number): Promise<DailyMean[]> {
  return snapshot(db, async (tx) => {
    const { rows } = await sql<{ date: string; mean: number; hours: number }>`
      SELECT to_char(h.day, 'YYYY-MM-DD') AS date, avg(h.mean)::float8 AS mean, count(*)::int AS hours
      FROM (
        SELECT date_trunc('hour', ts AT TIME ZONE 'UTC') AS hour,
               date_trunc('day', ts AT TIME ZONE 'UTC') AS day,
               avg(value)::float8 AS mean
        FROM ${sql.table(VIEWS[family].obs)}
        WHERE series_id = ${series} AND (qc::int & ${SUSPECT_BITS}::int) = 0
        GROUP BY 1, 2
      ) h
      GROUP BY h.day ORDER BY h.day`.execute(tx);
    return rows;
  });
}
