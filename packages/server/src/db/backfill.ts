/**
 * Backfill queue reads.
 *
 * The queue itself is driven in Phase 4; what exists here is what /api/health
 * needs to report progress, plus the shared status shape.
 */

import type { BackfillProgress } from '@rws/shared';
import { getPool } from './pool.js';

export async function backfillProgress(): Promise<BackfillProgress> {
  const { rows } = await getPool().query<{
    status: string; n: number; rows_written: number;
  }>(
    `SELECT status, count(*)::int AS n, COALESCE(sum(rows_written), 0)::int AS rows_written
       FROM backfill_jobs
      GROUP BY status`,
  );

  const byStatus = new Map(rows.map((r) => [r.status, r]));
  const count = (s: string) => byStatus.get(s)?.n ?? 0;

  const done = count('done');
  const empty = count('empty');
  const failed = count('failed');
  const running = count('running');
  const pending = count('pending');
  const total = done + empty + failed + running + pending;

  // Throughput over the recent window, used for a rough ETA.
  const { rows: rateRows } = await getPool().query<{ finished: number }>(
    `SELECT count(*)::int AS finished
       FROM backfill_jobs
      WHERE finished_at > now() - INTERVAL '5 minutes'`,
  );
  const finishedRecently = rateRows[0]?.finished ?? 0;
  const throughputPerMin = finishedRecently > 0 ? finishedRecently / 5 : null;

  const remaining = pending + running;
  const etaSeconds = throughputPerMin && remaining > 0
    ? Math.round((remaining / throughputPerMin) * 60)
    : null;

  return {
    total,
    done,
    empty,
    failed,
    running,
    pending,
    rowsWritten: rows.reduce((n, r) => n + r.rows_written, 0),
    throughputPerMin,
    etaSeconds,
  };
}
