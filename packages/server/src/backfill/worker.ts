/**
 * The queue runner.
 *
 * Bounded concurrency, retry with backoff, and a progress report. Failures are
 * recorded and the worker moves on -- one bad chunk must not stall the queue.
 *
 * Note what this deliberately does NOT do: pre-flight each chunk with
 * OphalenAantalWaarnemingen to skip empty months. Phase 1 measured that
 * endpoint at 5-200 s per location against ~1 s to fetch a real month of
 * observations, so checking first costs more than it saves. An upstream 204 is
 * already a cheap "no data" answer, and marks the chunk `empty`. The count
 * check is available behind --check-counts for anyone who wants it.
 */

import { config } from '../config.js';
import { refreshAggregates } from '../db/observations.js';
import { RwsError, fetchCounts, fetchObservations } from '../sources/rws/client.js';
import { normaliseObservations } from '../sources/rws/normalise.js';
import { windowFor } from './plan.js';
import {
  claim,
  completeWithData,
  markEmpty,
  recordFailure,
  stats,
  writtenRange,
  type Job,
  type QueueStats,
} from './queue.js';

export interface RunOptions {
  concurrency?: number;
  maxAttempts?: number;
  /** Only drain these tiers; omit for all. */
  tiers?: string[] | undefined;
  /** Pre-flight with the (slow) count endpoint to skip empty months. */
  checkCounts?: boolean;
  /** Stop after this many chunks; useful for proving the pipeline. */
  limit?: number | undefined;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
}

export interface Progress {
  processed: number;
  written: number;
  emptied: number;
  failed: number;
  rowsWritten: number;
  elapsedMs: number;
  chunksPerMin: number;
  queue: QueueStats;
  etaSeconds: number | null;
}

export interface RunResult extends Progress {
  aggregatesRefreshed: boolean;
}

/**
 * Fetch and store one chunk.
 *
 * Returns without throwing for the expected outcomes (data, or no data);
 * throws only for a genuine upstream failure, which the caller retries.
 */
async function processJob(
  job: Job,
  checkCounts: boolean,
): Promise<{ outcome: 'written' | 'empty'; rows: number }> {
  const { from, to } = windowFor(job.month);

  if (checkCounts) {
    const counts = await fetchCounts(
      job.locationCode,
      [{ compartiment: job.compartiment, grootheid: job.grootheid }],
      from,
      to,
    );
    const total = (counts.data?.AantalWaarnemingenPerPeriodeLijst ?? [])
      .flatMap((s) => s.AantalMetingenPerPeriodeLijst ?? [])
      .reduce((n, p) => n + Number(p.AantalMetingen ?? 0), 0);
    if (counts.status === 204 || total === 0) {
      // The RWS issue tracker reports the count endpoints are not always
      // consistent with OphalenWaarnemingen, so a zero is "probably empty".
      // Without --check-counts we simply fetch and let a 204 answer instead.
      await markEmpty(job);
      return { outcome: 'empty', rows: 0 };
    }
  }

  const response = await fetchObservations({
    locationCode: job.locationCode,
    compartiment: job.compartiment,
    grootheid: job.grootheid,
    // Forecasts are archived too and would otherwise pollute the history.
    procesType: 'meting',
    from,
    to,
  });

  // 204 means no data matched, which is an answer rather than a failure.
  if (!response.data) {
    await markEmpty(job);
    return { outcome: 'empty', rows: 0 };
  }

  const series = normaliseObservations(response.data);
  if (series.length === 0) {
    await markEmpty(job);
    return { outcome: 'empty', rows: 0 };
  }

  const { rowsWritten } = await completeWithData(job, series);
  return { outcome: rowsWritten > 0 ? 'written' : 'empty', rows: rowsWritten };
}

export async function runQueue(options: RunOptions = {}): Promise<RunResult> {
  const concurrency = options.concurrency ?? config.sources.rws.http.maxConcurrency;
  const maxAttempts = options.maxAttempts ?? config.sources.rws.http.maxRetries;
  const started = Date.now();

  let processed = 0;
  let written = 0;
  let emptied = 0;
  let failed = 0;
  let rowsWritten = 0;
  let stop = false;

  const report = async (): Promise<Progress> => {
    const queue = await stats();
    const elapsedMs = Date.now() - started;
    const chunksPerMin = elapsedMs > 0 ? (processed / elapsedMs) * 60_000 : 0;
    const remaining = queue.pending + queue.running;
    return {
      processed, written, emptied, failed, rowsWritten, elapsedMs,
      chunksPerMin: Number(chunksPerMin.toFixed(1)),
      queue,
      etaSeconds: chunksPerMin > 0 && remaining > 0
        ? Math.round((remaining / chunksPerMin) * 60)
        : null,
    };
  };

  async function lane(): Promise<void> {
    while (!stop) {
      if (options.signal?.aborted) return;
      if (options.limit !== undefined && processed >= options.limit) return;

      const job = await claim(options.tiers);
      if (!job) return; // queue drained

      try {
        const { outcome, rows } = await processJob(job, options.checkCounts ?? false);
        rowsWritten += rows;
        if (outcome === 'written') written += 1;
        else emptied += 1;
      } catch (err) {
        const message = err instanceof RwsError
          ? `${err.message}${err.status ? ` (status ${err.status})` : ''}`
          : (err as Error).message;
        const status = await recordFailure(job, message, maxAttempts);
        if (status === 'failed') failed += 1;
      }

      processed += 1;
      // The client already applies exponential backoff with jitter per request,
      // so retried chunks are spaced without an extra sleep here.
      if (options.onProgress && processed % 10 === 0) {
        options.onProgress(await report());
      }
    }
  }

  const abortHandler = () => { stop = true; };
  options.signal?.addEventListener('abort', abortHandler);

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, () => lane()),
    );
  } finally {
    options.signal?.removeEventListener('abort', abortHandler);
  }

  const progress = await report();

  // Refresh the continuous aggregates once for the whole range, rather than
  // per chunk: the scheduled policies only cover recent time, so backfilled
  // history would otherwise never be materialised and a 1-year chart would
  // come back empty. Doing it per chunk would mean tens of thousands of
  // refreshes for the same buckets.
  let aggregatesRefreshed = false;
  if (written > 0) {
    const range = await writtenRange();
    if (range) {
      await refreshAggregates(range.from, range.to);
      aggregatesRefreshed = true;
    }
  }

  return { ...progress, aggregatesRefreshed };
}
