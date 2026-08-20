/**
 * The backfill work queue.
 *
 * The crash-safety property lives here: a chunk is marked `done` in the *same
 * transaction* that commits its rows. Either both land or neither does, so a
 * killed process never leaves a chunk recorded as complete when its data is
 * missing, and restarting never re-downloads a chunk that really finished.
 */

import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool.js';
import { refreshCoverage, upsertSeries } from '../db/series.js';
import { upsertObservations } from '../db/observations.js';
import type { NormalisedSeries } from '../sources/rws/normalise.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'empty' | 'failed';

export interface Job {
  id: number;
  locationCode: string;
  compartiment: string;
  grootheid: string;
  /** First instant of the month, UTC. */
  month: Date;
  attempts: number;
  tier: string;
}

interface JobRow {
  id: number;
  location_code: string;
  compartiment: string;
  grootheid: string;
  month: Date;
  attempts: number;
  tier: string;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    locationCode: row.location_code,
    compartiment: row.compartiment,
    grootheid: row.grootheid,
    month: row.month,
    attempts: row.attempts,
    tier: row.tier,
  };
}

export interface PlannedJob {
  locationCode: string;
  compartiment: string;
  grootheid: string;
  month: Date;
  tier: string;
  priority: number;
}

/**
 * Add work to the queue.
 *
 * Existing rows are left alone, so re-planning is safe and never resets a
 * chunk that has already been downloaded -- that is what makes `--resume` the
 * default rather than a special mode.
 */
export async function enqueue(jobs: PlannedJob[]): Promise<number> {
  if (jobs.length === 0) return 0;

  let inserted = 0;
  await withTransaction(async (client) => {
    const CHUNK = 5000;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      const batch = jobs.slice(i, i + CHUNK);
      const { rowCount } = await client.query(
        `INSERT INTO backfill_jobs
           (location_code, compartiment, grootheid, month, tier, priority)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::text[], $6::int[]
         )
         ON CONFLICT (location_code, compartiment, grootheid, month) DO NOTHING`,
        [
          batch.map((j) => j.locationCode),
          batch.map((j) => j.compartiment),
          batch.map((j) => j.grootheid),
          batch.map((j) => j.month.toISOString()),
          batch.map((j) => j.tier),
          batch.map((j) => j.priority),
        ],
      );
      inserted += rowCount ?? 0;
    }
  });
  return inserted;
}

/**
 * Claim the next pending job.
 *
 * SKIP LOCKED lets several workers -- or several processes -- drain the same
 * queue without contending or handing the same chunk to two of them.
 */
export async function claim(tiers?: string[]): Promise<Job | null> {
  const params: unknown[] = [];
  let tierClause = '';
  if (tiers && tiers.length > 0) {
    params.push(tiers);
    tierClause = ` AND tier = ANY($${params.length}::text[])`;
  }

  const { rows } = await getPool().query<JobRow>(
    `UPDATE backfill_jobs
        SET status = 'running', attempts = attempts + 1, started_at = now()
      WHERE id = (
        SELECT id FROM backfill_jobs
         WHERE status = 'pending'${tierClause}
         ORDER BY priority, month
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, location_code, compartiment, grootheid, month, attempts, tier`,
    params,
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * Commit a chunk's data and mark it done, atomically.
 *
 * This is the whole crash-safety story: the series upserts, the observation
 * rows and the status change share one transaction.
 */
export async function completeWithData(
  job: Job,
  series: NormalisedSeries[],
  fetchedAt = new Date(),
): Promise<{ rowsWritten: number; seriesIds: number[] }> {
  return withTransaction(async (client: PoolClient) => {
    const seriesIds: number[] = [];
    let rowsWritten = 0;

    for (const s of series) {
      const seriesId = await upsertSeries(client, s.identity);
      seriesIds.push(seriesId);
      rowsWritten += await upsertObservations(client, seriesId, s.points, fetchedAt);
    }

    await refreshCoverage(client, seriesIds);

    await client.query(
      `UPDATE backfill_jobs
          SET status = $2, rows_written = $3, fetched_at = $4,
              finished_at = now(), last_error = NULL
        WHERE id = $1`,
      [job.id, rowsWritten > 0 ? 'done' : 'empty', rowsWritten, fetchedAt.toISOString()],
    );

    return { rowsWritten, seriesIds };
  });
}

/** Mark a chunk as having no data upstream, without writing rows. */
export async function markEmpty(job: Job, fetchedAt = new Date()): Promise<void> {
  await getPool().query(
    `UPDATE backfill_jobs
        SET status = 'empty', rows_written = 0, fetched_at = $2,
            finished_at = now(), last_error = NULL
      WHERE id = $1`,
    [job.id, fetchedAt.toISOString()],
  );
}

/**
 * Record a failure. Below the retry limit the chunk goes back to `pending` so
 * another pass picks it up; at the limit it is parked as `failed` so one bad
 * chunk cannot stall the queue.
 */
export async function recordFailure(
  job: Job,
  error: string,
  maxAttempts: number,
): Promise<JobStatus> {
  const status: JobStatus = job.attempts >= maxAttempts ? 'failed' : 'pending';
  await getPool().query(
    `UPDATE backfill_jobs
        SET status = $2, last_error = $3, finished_at = CASE WHEN $2 = 'failed' THEN now() END
      WHERE id = $1`,
    // Errors can be enormous (an HTML error page); keep the useful head.
    [job.id, status, error.slice(0, 2000)],
  );
  return status;
}

/**
 * Return jobs stuck in `running` to the queue.
 *
 * A process killed mid-chunk leaves its claim behind. The rows were never
 * committed (that happens with the status change), so the chunk is simply
 * unstarted work.
 */
export async function reclaimStale(olderThanMinutes = 30): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE backfill_jobs
        SET status = 'pending'
      WHERE status = 'running'
        AND started_at < now() - make_interval(mins => $1)`,
    [olderThanMinutes],
  );
  return rowCount ?? 0;
}

/** Put failed chunks back in the queue, e.g. after an upstream outage. */
export async function retryFailed(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE backfill_jobs
        SET status = 'pending', attempts = 0, last_error = NULL
      WHERE status = 'failed'`,
  );
  return rowCount ?? 0;
}

/**
 * Re-queue a window for the rolling correction re-fetch.
 *
 * Already-done chunks are deliberately reset: the whole point is to
 * re-download them, because upstream publishes early as `ongecontroleerd` and
 * revises in place afterwards.
 */
export async function requeueWindow(from: Date, to: Date): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE backfill_jobs
        SET status = 'pending', attempts = 0, last_error = NULL
      WHERE month >= $1 AND month <= $2
        AND status IN ('done', 'empty', 'failed')`,
    [from.toISOString(), to.toISOString()],
  );
  return rowCount ?? 0;
}

export interface QueueStats {
  pending: number;
  running: number;
  done: number;
  empty: number;
  failed: number;
  total: number;
  rowsWritten: number;
}

export async function stats(): Promise<QueueStats> {
  const { rows } = await getPool().query<{ status: string; n: string; rows_written: string }>(
    `SELECT status, count(*) AS n, COALESCE(sum(rows_written), 0) AS rows_written
       FROM backfill_jobs GROUP BY status`,
  );

  const out: QueueStats = {
    pending: 0, running: 0, done: 0, empty: 0, failed: 0, total: 0, rowsWritten: 0,
  };
  for (const row of rows) {
    const n = Number(row.n);
    if (row.status in out) (out as unknown as Record<string, number>)[row.status] = n;
    out.total += n;
    out.rowsWritten += Number(row.rows_written);
  }
  return out;
}

export interface FailureSample {
  locationCode: string;
  grootheid: string;
  month: string;
  attempts: number;
  lastError: string | null;
}

export async function recentFailures(limit = 10): Promise<FailureSample[]> {
  const { rows } = await getPool().query<{
    location_code: string; grootheid: string; month: Date;
    attempts: number; last_error: string | null;
  }>(
    `SELECT location_code, grootheid, month, attempts, last_error
       FROM backfill_jobs WHERE status = 'failed'
      ORDER BY finished_at DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    locationCode: r.location_code,
    grootheid: r.grootheid,
    month: r.month.toISOString().slice(0, 7),
    attempts: r.attempts,
    lastError: r.last_error,
  }));
}

/** Bounds of the data actually written, for the end-of-run aggregate refresh. */
export async function writtenRange(): Promise<{ from: Date; to: Date } | null> {
  const { rows } = await getPool().query<{ min_month: Date | null; max_month: Date | null }>(
    `SELECT min(month) AS min_month, max(month) AS max_month
       FROM backfill_jobs WHERE status = 'done'`,
  );
  const row = rows[0];
  if (!row?.min_month || !row.max_month) return null;
  // A job's window runs to the end of its month.
  const to = new Date(row.max_month);
  to.setUTCMonth(to.getUTCMonth() + 1);
  return { from: row.min_month, to };
}
