/**
 * Scheduled jobs, sharing the same code paths as the CLI.
 *
 * Deliberately a plain interval scheduler rather than a cron dependency: there
 * are four jobs, and an in-process timer is one less thing to operate. If
 * these ever need to run on a separate box or survive a restart mid-job, move
 * them to a real scheduler rather than growing this file.
 */

import { config } from '../config.js';
import { refreshCatalogue } from '../ingest/catalogue.js';
import { pollLatest } from '../ingest/latest.js';
import { recordRefresh, refreshLocations } from '../ingest/locations.js';
import { requeueWindow } from './queue.js';
import { runQueue } from './worker.js';

const DAY_MS = 86_400_000;

export interface ScheduleOptions {
  /** Refresh the location layer and catalogue on this cadence. */
  refreshIntervalMs?: number;
  /** Re-download the correction window on this cadence. */
  refetchIntervalMs?: number;
  /** How far back corrections are re-downloaded. */
  refetchDays?: number;
  /** Pull the latest reading of every live series on this cadence. */
  latestIntervalMs?: number;
  /** Leave the latest poll out entirely. */
  pollLatest?: boolean;
  log?: (msg: string) => void;
}

/**
 * The archive publishes early as `ongecontroleerd` and applies corrections in
 * place afterwards, so recent history is re-downloaded on a cadence and
 * overwritten through the same idempotent upsert the backfill uses.
 *
 * 60 days by default, comfortably inside the 90-day compression delay so the
 * re-fetch never has to rewrite a compressed chunk.
 */
export async function runRollingRefetch(
  days = 60,
  log: (msg: string) => void = console.log,
): Promise<{ requeued: number; rowsWritten: number }> {
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY_MS);
  const requeued = await requeueWindow(
    new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)),
    now,
  );

  if (requeued === 0) {
    log('[refetch] nothing in the correction window to re-download');
    return { requeued: 0, rowsWritten: 0 };
  }

  log(`[refetch] re-queued ${requeued} chunk(s) from the last ${days} days`);
  const result = await runQueue({ concurrency: config.rws.maxConcurrency });
  log(`[refetch] rewrote ${result.rowsWritten.toLocaleString('en-GB')} row(s)`);
  return { requeued, rowsWritten: result.rowsWritten };
}

/**
 * Start the scheduled jobs. Returns a stop function.
 *
 * Each job guards against overlapping with itself: the location refresh takes
 * minutes and the re-fetch can take much longer, so a slow run must not have a
 * second copy started on top of it.
 */
export function startSchedules(options: ScheduleOptions = {}): () => void {
  const log = options.log ?? console.log;
  const refreshInterval = options.refreshIntervalMs ?? DAY_MS;
  const refetchInterval = options.refetchIntervalMs ?? 7 * DAY_MS;
  const refetchDays = options.refetchDays ?? 60;
  const latestInterval = options.latestIntervalMs ?? config.latestPoll.intervalMs;
  const pollingLatest = options.pollLatest ?? config.latestPoll.enabled;

  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();

  const run = (name: string, fn: () => Promise<unknown>): void => {
    if (running.has(name)) {
      log(`[schedule] ${name} still running, skipping this tick`);
      return;
    }
    running.add(name);
    void fn()
      .catch((err: unknown) => {
        log(`[schedule] ${name} failed: ${(err as Error).message}`);
        // Record the failure so /api/health can report a stale cache rather
        // than silently serving old data as though it were fresh.
        return recordRefresh(name, { error: String(err) }, false).catch(() => {});
      })
      .finally(() => running.delete(name));
  };

  const schedule = (name: string, intervalMs: number, fn: () => Promise<unknown>) => {
    const timer = setInterval(() => run(name, fn), intervalMs);
    // Do not hold the process open purely for a timer.
    timer.unref?.();
    timers.push(timer);
  };

  schedule('locations', refreshInterval, () => refreshLocations(log));
  schedule('catalogue', refreshInterval, () => refreshCatalogue(log));
  schedule('refetch', refetchInterval, () => runRollingRefetch(refetchDays, log));

  // Runs first rather than waiting out a full interval: on a restart the store
  // is already up to five minutes behind, and this is the job whose whole
  // point is not being behind. The others cost minutes to hours and can wait.
  if (pollingLatest) {
    schedule('latest', latestInterval, () => pollLatest({ log }));
    run('latest', () => pollLatest({ log }));
  }

  log(
    `[schedule] locations+catalogue every ${Math.round(refreshInterval / 3_600_000)}h, ` +
    `correction re-fetch every ${Math.round(refetchInterval / DAY_MS)}d over ${refetchDays} days` +
    (pollingLatest
      ? `, latest poll every ${Math.round(latestInterval / 60_000)}m`
      : ', latest poll off'),
  );

  return () => { for (const t of timers) clearInterval(t); };
}
