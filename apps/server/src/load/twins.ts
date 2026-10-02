import { QC } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import type { DB } from '../db/generated.ts';
import { type Point, scoreShifts, shiftsWithin } from './align.ts';
import { lock } from './store.ts';

// The twin check (A§7.4 step 7; issue #17, P5b): for every registered pair with an `offset` (or, P5c, a
// `constant`: the expected difference detected as the median at shift 0) relation, a − b
// on the timestamps both series have, over the 24 hours before the current UTC hour, and the lag of b against
// a. One row per pair and hour, recomputed on every health pass (idempotent), so a late value or a revision
// still counts. A pair that was checked before and now has no timestamp both sides state (one side has no
// values in the window, or their instants no longer coincide) gets a failing row with n_aligned 0 (review F2
// of P2b): no data is never ok. A pair never checked gets none, so data that has not arrived is not a breach.
//
// Rows filled from another source's payload (QC bit 512: FR-3 into FR-1) are left out on both sides: the
// Chooz and Uckange checks would otherwise compare FR-3 with itself (KG-121).
//
// The lag: a − b is scored at every shift of b within ± `max_lag_min` (default 60) in 5-minute steps; the lag
// is the shift where the most aligned points agree, and 0 unless the relation holds there (`min_share`) and it
// beats the unshifted share by LAG_MARGIN (a flat river agrees at every shift, and noise or a constant bias
// must not pick one). When shifts of both signs share the best share (a periodic signal), the lag is
// undetermined and reported as 0 (review CR-6), never the first of them. ok: points aligned, the share within
// tolerance at least `min_share` (default 1), and a lag of 0: so `ok` is the relation at shift 0 whenever the
// lag is undetermined.

/**
 * The newest 30 minutes are left out: the two sides are fetched by different
 * requests, and a value one side has revised and the other not yet is not a
 * breach. Every timestamp still falls in many later windows.
 */
const SETTLE_MS = 30 * 60_000;
const WINDOW_MS = 24 * 3_600_000;
const STEP_MIN = 5;
/** A shift must agree on this much larger a share than no shift before it counts as a lag. */
export const LAG_MARGIN = 0.05;

type Relation = {
  tolerance: number;
  min_share?: number;
  max_lag_min?: number;
} & ({ kind: 'offset'; expected: number } | { kind: 'constant' });

export type TwinResult = {
  n_aligned: number;
  median_delta: number | null;
  max_delta: number | null;
  lag_min: number | null;
  ok: boolean;
};

/** The check of one pair over one window (pure): `a` inside the window, `b` with the lag margin around it. */
export function judgeTwin(a: readonly Point[], b: readonly Point[], relation: Relation): TwinResult {
  const { tolerance } = relation;
  const minShare = relation.min_share ?? 1;
  const maxLag = relation.max_lag_min ?? 60;
  const at = new Map(b.map((p) => [p.ts, p.value]));
  const deltas: number[] = [];
  for (const p of a) {
    const v = at.get(p.ts);
    if (v !== undefined) deltas.push(p.value - v);
  }
  if (deltas.length === 0) return { n_aligned: 0, median_delta: null, max_delta: null, lag_min: null, ok: false };
  const sorted = [...deltas].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  // `constant` (P5c): the expected difference is the one this window shows at shift 0, so a stable offset that
  // nobody published (two gauge zeros of one gauge) passes, and noise or a jump in it does not.
  const expected = relation.kind === 'constant' ? median : relation.expected;
  const scores = scoreShifts(a, b, shiftsWithin(maxLag, STEP_MIN), { expected, tolerance });
  const zero = scores.find((s) => s.shift === 0) as (typeof scores)[number];
  const furthest = deltas.reduce((m, d) => (Math.abs(d - expected) > Math.abs(m - expected) ? d : m));
  // A shift that aligns far fewer points (the edge of the window) does not compete.
  const competing = scores.filter((s) => s.n * 2 >= zero.n);
  let best = zero;
  for (const s of competing) {
    if (s.share > best.share || (s.share === best.share && Math.abs(s.shift) < Math.abs(best.shift))) best = s;
  }
  // The best share reached on both sides of 0 leaves the lag's sign, and so the lag, undetermined.
  const tied = competing.filter((s) => s.share === best.share);
  const undetermined = tied.some((s) => s.shift < 0) && tied.some((s) => s.shift > 0);
  // A lag is a shift where the relation holds (a constant bias fails at every shift and must not invent one).
  const lag = !undetermined && best.share > zero.share + LAG_MARGIN && best.share >= minShare ? best.shift : 0;
  return {
    n_aligned: deltas.length,
    median_delta: median,
    max_delta: furthest,
    lag_min: lag,
    ok: zero.share >= minShare && lag === 0,
  };
}

/**
 * Writes the check of the current hour for every offset pair that has aligned values, or none but a check of
 * an earlier pass (n_aligned 0, both deltas NULL, not ok). Returns the pairs whose check turned from ok (or
 * from nothing this hour) to failing.
 */
export async function checkTwins(db: Kysely<DB>, now: Date): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    await lock(tx);
    const windowEnd = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    const from = windowEnd - WINDOW_MS;
    const to = windowEnd - SETTLE_MS;
    const { rows: twins } = await sql<{ id: string; series_a: number; series_b: number; relation: Relation }>`
      SELECT id, series_a, series_b, relation FROM twin WHERE relation->>'kind' IN ('offset', 'constant')
      ORDER BY id`.execute(tx);
    const breached: string[] = [];
    for (const t of twins) {
      const lag = (t.relation.max_lag_min ?? 60) * 60_000;
      const { rows } = await sql<{ series_id: number; ts: Date; value: number }>`
        SELECT series_id, ts, value FROM obs
        WHERE series_id IN (${t.series_a}, ${t.series_b})
          AND ts > ${new Date(from - lag)}::timestamptz AND ts <= ${new Date(to + lag)}::timestamptz
          AND (qc & ${QC.BACKFILLED}::int2) = 0`.execute(tx);
      const a = rows
        .filter((r) => r.series_id === t.series_a && r.ts.getTime() > from && r.ts.getTime() <= to)
        .map((r) => ({ ts: r.ts.getTime(), value: r.value }));
      const b = rows.filter((r) => r.series_id === t.series_b).map((r) => ({ ts: r.ts.getTime(), value: r.value }));
      const result = judgeTwin(a, b, t.relation);
      if (result.n_aligned === 0) {
        const { rows: before } = await sql`SELECT 1 FROM twin_check WHERE twin_id = ${t.id} LIMIT 1`.execute(tx);
        if (before.length === 0) continue;
      }
      const { rows: written } = await sql<{ was: boolean | null; ok: boolean }>`
        INSERT INTO twin_check AS c (twin_id, window_end, n_aligned, median_delta, max_delta, lag_min, ok)
        VALUES (${t.id}, ${new Date(windowEnd)}::timestamptz, ${result.n_aligned}, ${result.median_delta}::real,
                ${result.max_delta}::real, ${result.lag_min}, ${result.ok})
        ON CONFLICT (twin_id, window_end) DO UPDATE SET
          n_aligned = EXCLUDED.n_aligned, median_delta = EXCLUDED.median_delta, max_delta = EXCLUDED.max_delta,
          lag_min = EXCLUDED.lag_min, ok = EXCLUDED.ok
        RETURNING old.ok AS was, new.ok AS ok`.execute(tx);
      const w = written[0];
      if (w !== undefined && !w.ok && w.was !== false) breached.push(t.id);
    }
    return breached;
  });
}
