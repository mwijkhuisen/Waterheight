import { type Kysely, sql } from 'kysely';
import type { DB } from '../db/generated.ts';
import { lock } from './store.ts';

// The twin check (A§7.4 step 7; issue #17): for every registered pair with an
// `offset` relation, a − b on the timestamps both series have, over the 24
// hours before the current UTC hour. One row per pair and hour, recomputed on
// every health pass (idempotent), so a late value or a revision still counts.
// P5 adds the pairs that need a lag; this one needs none.

/**
 * The newest 30 minutes are left out: the two sides are fetched by different
 * requests, and a value one side has revised and the other not yet is not a
 * breach. Every timestamp still falls in many later windows.
 */
const SETTLE = sql`interval '30 minutes'`;

/**
 * Writes the check of the current hour for every offset pair that has aligned
 * values (none aligned: no row, so a pair whose data has not arrived yet is
 * not reported as failing). `ok`: every delta is within the tolerance of the
 * expected offset. `max_delta` is the delta furthest from that offset. Returns
 * the pairs whose check turned from ok (or from nothing) to failing.
 */
export async function checkTwins(db: Kysely<DB>, now: Date): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    await lock(tx);
    const { rows } = await sql<{ twin_id: string; was: boolean | null; ok: boolean }>`
      INSERT INTO twin_check AS c (twin_id, window_end, n_aligned, median_delta, max_delta, lag_min, ok)
      SELECT p.id, p.window_end, count(*)::int,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY p.delta))::real,
             ((array_agg(p.delta ORDER BY abs(p.delta - p.expected) DESC, p.ts))[1])::real,
             NULL,
             bool_and(abs(p.delta - p.expected) <= p.tolerance)
      FROM (
        SELECT t.id, w.window_end, a.ts, a.value::double precision - b.value::double precision AS delta,
               (t.relation->>'expected')::double precision AS expected,
               (t.relation->>'tolerance')::double precision AS tolerance
        FROM twin t
        CROSS JOIN (SELECT date_trunc('hour', ${now}::timestamptz, 'UTC') AS window_end) w
        JOIN obs a ON a.series_id = t.series_a AND a.ts > w.window_end - interval '24 hours'
                  AND a.ts <= w.window_end - ${SETTLE}
        JOIN obs b ON b.series_id = t.series_b AND b.ts = a.ts
        WHERE t.relation->>'kind' = 'offset'
      ) p
      GROUP BY p.id, p.window_end
      ON CONFLICT (twin_id, window_end) DO UPDATE SET
        n_aligned = EXCLUDED.n_aligned, median_delta = EXCLUDED.median_delta, max_delta = EXCLUDED.max_delta,
        lag_min = EXCLUDED.lag_min, ok = EXCLUDED.ok
      RETURNING c.twin_id, old.ok AS was, new.ok AS ok`.execute(tx);
    return rows.filter((r) => !r.ok && r.was !== false).map((r) => r.twin_id);
  });
}
