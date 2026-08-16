/**
 * Backfill progress for /api/health.
 *
 * The same figures the CLI prints, so a running backfill is observable without
 * shell access to the machine running it.
 */

import type { BackfillProgress } from '@rws/shared';
import { getPool } from './pool.js';

export async function backfillProgress(): Promise<BackfillProgress> {
  const { rows } = await getPool().query<{
    status: string; n: string; rows_written: string;
  }>(
    `SELECT status, count(*) AS n, COALESCE(sum(rows_written), 0) AS rows_written
       FROM backfill_jobs
      GROUP BY status`,
  );

  const byStatus = new Map(rows.map((r) => [r.status, r]));
  const count = (s: string) => Number(byStatus.get(s)?.n ?? 0);

  const done = count('done');
  const empty = count('empty');
  const failed = count('failed');
  const running = count('running');
  const pending = count('pending');

  // Throughput over a recent window, for an ETA that reflects the run in
  // progress rather than a lifetime average.
  const { rows: rateRows } = await getPool().query<{ finished: string }>(
    `SELECT count(*) AS finished
       FROM backfill_jobs
      WHERE finished_at > now() - INTERVAL '5 minutes'`,
  );
  const finishedRecently = Number(rateRows[0]?.finished ?? 0);
  const throughputPerMin = finishedRecently > 0 ? finishedRecently / 5 : null;

  const remaining = pending + running;
  const etaSeconds = throughputPerMin && remaining > 0
    ? Math.round((remaining / throughputPerMin) * 60)
    : null;

  return {
    total: done + empty + failed + running + pending,
    done,
    empty,
    failed,
    running,
    pending,
    rowsWritten: rows.reduce((n, r) => n + Number(r.rows_written), 0),
    throughputPerMin,
    etaSeconds,
  };
}
