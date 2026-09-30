import { type Kysely, sql } from 'kysely';
import type { DB } from '../db/generated.ts';
import { lock } from './store.ts';

// Nightly (A§7.4 step 4): the rollups of the previous 40 days are recomputed
// from obs and compared. The loader keeps them exact in its own transactions,
// so a difference is a bug and is reported; it is also repaired. One UTC day
// per transaction, under the loader lock, so it never overwrites a bucket with
// a snapshot older than a concurrent load.

const ORIGIN = sql`timestamptz '2000-01-01 00:00:00+00'`;
export const RECONCILE_DAYS = 40;

export async function reconcileRollups(
  db: Kysely<DB>,
  now: Date,
  days = RECONCILE_DAYS,
): Promise<{ repaired: number }> {
  let repaired = 0;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let d = days; d >= 0; d--) {
    const from = new Date(today - d * 86_400_000);
    const to = new Date(today - (d - 1) * 86_400_000);
    await db.transaction().execute(async (tx) => {
      await lock(tx);
      const hourly = await sql`
        INSERT INTO obs_1h AS r (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
        SELECT o.series_id, date_bin('1 hour', o.ts, ${ORIGIN}), min(o.value), max(o.value), avg(o.value)::real,
               (array_agg(o.value ORDER BY o.ts DESC))[1], count(*)::int, bit_or(o.qc)
        FROM obs o WHERE o.ts >= ${from} AND o.ts < ${to}
        GROUP BY 1, 2
        ON CONFLICT (series_id, bucket) DO UPDATE
          SET vmin = EXCLUDED.vmin, vmax = EXCLUDED.vmax, vavg = EXCLUDED.vavg, vlast = EXCLUDED.vlast,
              n = EXCLUDED.n, qc_or = EXCLUDED.qc_or
          WHERE (r.vmin, r.vmax, r.vavg, r.vlast, r.n, r.qc_or)
                IS DISTINCT FROM (EXCLUDED.vmin, EXCLUDED.vmax, EXCLUDED.vavg, EXCLUDED.vlast, EXCLUDED.n, EXCLUDED.qc_or)`.execute(
        tx,
      );
      const daily = await sql`
        INSERT INTO obs_1d AS r (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
        SELECT o.series_id, date_bin('1 day', o.ts, ${ORIGIN}), min(o.value), max(o.value), avg(o.value)::real,
               (array_agg(o.value ORDER BY o.ts DESC))[1], count(*)::int, bit_or(o.qc)
        FROM obs o WHERE o.ts >= ${from} AND o.ts < ${to}
        GROUP BY 1, 2
        ON CONFLICT (series_id, bucket) DO UPDATE
          SET vmin = EXCLUDED.vmin, vmax = EXCLUDED.vmax, vavg = EXCLUDED.vavg, vlast = EXCLUDED.vlast,
              n = EXCLUDED.n, qc_or = EXCLUDED.qc_or
          WHERE (r.vmin, r.vmax, r.vavg, r.vlast, r.n, r.qc_or)
                IS DISTINCT FROM (EXCLUDED.vmin, EXCLUDED.vmax, EXCLUDED.vavg, EXCLUDED.vlast, EXCLUDED.n, EXCLUDED.qc_or)`.execute(
        tx,
      );
      repaired += Number(hourly.numAffectedRows ?? 0n) + Number(daily.numAffectedRows ?? 0n);
    });
  }
  return { repaired };
}
