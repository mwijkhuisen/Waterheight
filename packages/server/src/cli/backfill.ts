#!/usr/bin/env node
/**
 * Backfill CLI.
 *
 *   backfill                     plan and run (resumes by default)
 *   backfill --dry-run           print the plan and projected volume only
 *   backfill status              queue progress, throughput and failures
 *   backfill retry-failed        return failed chunks to the queue
 *   backfill refetch             re-download the recent correction window
 *
 * Resuming is the default rather than a mode: planning never resets a chunk
 * that already completed, so re-running after a kill picks up exactly where it
 * left off. `--resume` is accepted for explicitness.
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { buildPlan, monthsBetween } from '../backfill/plan.js';
import { enqueue, recentFailures, reclaimStale, requeueWindow, retryFailed, stats } from '../backfill/queue.js';
import { runQueue, type Progress } from '../backfill/worker.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    locations: { type: 'string' },
    quantities: { type: 'string' },
    concurrency: { type: 'string' },
    limit: { type: 'string' },
    tier: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    'include-deferred': { type: 'boolean', default: false },
    'check-counts': { type: 'boolean', default: false },
    'refetch-days': { type: 'string' },
    'reclaim-after': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

const command = positionals[0] ?? 'run';

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Not a date: ${value}`);
  return new Date(ms);
}

function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function printProgress(p: Progress): void {
  const done = p.queue.done + p.queue.empty + p.queue.failed;
  const pct = p.queue.total > 0 ? ((done / p.queue.total) * 100).toFixed(1) : '0.0';
  process.stdout.write(
    `\r  ${done.toLocaleString('en-GB')}/${p.queue.total.toLocaleString('en-GB')} chunks ` +
    `(${pct}%) · ${p.rowsWritten.toLocaleString('en-GB')} rows · ` +
    `${p.chunksPerMin}/min · ETA ${fmtDuration(p.etaSeconds)} · ${p.failed} failed   `,
  );
}

const HELP = `
Backfill Rijkswaterstaat observation history.

Usage: backfill [command] [options]

Commands:
  run (default)     plan the work, then drain the queue
  status            show queue progress and recent failures
  retry-failed      return failed chunks to the queue
  refetch           re-queue the recent correction window and run it

Options:
  --from <date>            window start (default: 1 year ago)
  --to <date>              window end (default: now)
  --locations <a,b>        limit to these location codes
  --quantities <a,b>       limit to these quantity codes
  --concurrency <n>        parallel outbound requests (default: ${config.rws.maxConcurrency})
  --limit <n>              stop after n chunks (prove it before letting it loose)
  --tier <eager|deferred>  only drain this tier
  --include-deferred       plan deferred quantities too
  --check-counts           pre-flight with the count endpoint (slower; see README)
  --refetch-days <n>       correction window for refetch (default: 60)
  --reclaim-after <mins>   return chunks stuck 'running' to the queue (default: 30).
                           Use 0 after a crash you know killed the only worker.
  --dry-run                print the plan and projection, download nothing
  --resume                 explicit no-op; resuming is the default
  --help
`;

async function main(): Promise<void> {
  if (values.help) { console.log(HELP.trim()); return; }

  const concurrency = values.concurrency ? Number(values.concurrency) : config.rws.maxConcurrency;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error('--concurrency must be a positive number');
  }

  if (command === 'status') {
    const s = await stats();
    const finished = s.done + s.empty + s.failed;
    const pct = s.total > 0 ? ((finished / s.total) * 100).toFixed(1) : '0.0';
    console.log('Backfill queue');
    console.log(`  total     ${s.total.toLocaleString('en-GB')}`);
    console.log(`  done      ${s.done.toLocaleString('en-GB')}`);
    console.log(`  empty     ${s.empty.toLocaleString('en-GB')}`);
    console.log(`  pending   ${s.pending.toLocaleString('en-GB')}`);
    console.log(`  running   ${s.running.toLocaleString('en-GB')}`);
    console.log(`  failed    ${s.failed.toLocaleString('en-GB')}`);
    console.log(`  rows      ${s.rowsWritten.toLocaleString('en-GB')}`);
    console.log(`  progress  ${pct}%`);

    const failures = await recentFailures(10);
    if (failures.length > 0) {
      console.log('\nRecent failures:');
      for (const f of failures) {
        console.log(`  ${f.locationCode}/${f.grootheid} ${f.month} ` +
          `(${f.attempts} attempts): ${f.lastError?.slice(0, 110) ?? 'unknown'}`);
      }
    }
    return;
  }

  if (command === 'retry-failed') {
    const n = await retryFailed();
    console.log(`Returned ${n} failed chunk(s) to the queue.`);
    return;
  }

  const now = new Date();

  if (command === 'refetch') {
    // The archive publishes early as `ongecontroleerd` and revises in place, so
    // recent history is re-downloaded on a schedule and overwritten via the
    // same idempotent upsert.
    const days = values['refetch-days'] ? Number(values['refetch-days']) : 60;
    const from = new Date(now.getTime() - days * 86_400_000);
    const requeued = await requeueWindow(
      new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)),
      now,
    );
    console.log(`Re-queued ${requeued.toLocaleString('en-GB')} chunk(s) from the last ${days} days.`);
    if (requeued === 0) return;

    const result = await runQueue({
      concurrency,
      onProgress: printProgress,
      ...(values.limit ? { limit: Number(values.limit) } : {}),
    });
    process.stdout.write('\n');
    console.log(`Re-fetched ${result.written} chunk(s), ${result.rowsWritten.toLocaleString('en-GB')} rows.`);
    return;
  }

  // --- run ---------------------------------------------------------------
  const from = parseDate(values.from, new Date(now.getTime() - 365 * 86_400_000));
  const to = parseDate(values.to, now);
  if (from >= to) throw new Error('--from must be before --to');

  const plan = await buildPlan(
    {
      from,
      to,
      locations: list(values.locations),
      quantities: list(values.quantities),
      includeDeferred: values['include-deferred'],
    },
    concurrency,
  );

  const months = monthsBetween(from, to);
  console.log('Backfill plan');
  console.log(`  window        ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} (${months.length} months)`);
  console.log(`  series        ${plan.seriesCount.toLocaleString('en-GB')} (location + quantity pairs)`);
  console.log(`  chunks        ${plan.projection.chunks.toLocaleString('en-GB')}`);
  console.log(`  by tier       ${Object.entries(plan.byTier).map(([t, n]) => `${t}=${n.toLocaleString('en-GB')}`).join(' ') || '—'}`);
  console.log(`  est. rows     ${plan.projection.estimatedRows.toLocaleString('en-GB')} (~${plan.projection.estimatedGb} GB uncompressed)`);
  console.log(`  est. time     ~${fmtDuration(plan.projection.estimatedHours * 3600)} at concurrency ${concurrency}`);

  if (plan.byQuantity.length > 0) {
    console.log('  top quantities:');
    for (const q of plan.byQuantity.slice(0, 8)) {
      console.log(`    ${q.grootheid.padEnd(12)} ${q.chunks.toLocaleString('en-GB').padStart(9)} chunks`);
    }
  }

  if (values['dry-run']) {
    console.log('\n--dry-run: nothing was queued or downloaded.');
    return;
  }

  // A crashed worker leaves its claims behind. They are only unstarted work --
  // rows commit with the status change -- but another *live* worker's claims
  // must not be stolen, hence the age threshold rather than a blanket reset.
  const reclaimAfter = values['reclaim-after'] !== undefined
    ? Number(values['reclaim-after'])
    : 30;
  if (!Number.isFinite(reclaimAfter) || reclaimAfter < 0) {
    throw new Error('--reclaim-after must be zero or a positive number of minutes');
  }
  const reclaimed = await reclaimStale(reclaimAfter);
  if (reclaimed > 0) console.log(`\nReturned ${reclaimed} stale running chunk(s) to the queue.`);

  const inserted = await enqueue(plan.jobs);
  const queued = await stats();
  console.log(`\nQueued ${inserted.toLocaleString('en-GB')} new chunk(s); ` +
    `${queued.pending.toLocaleString('en-GB')} pending of ${queued.total.toLocaleString('en-GB')} total.`);

  if (queued.pending === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Ctrl-C stops cleanly: in-flight chunks finish, and because a chunk is
  // marked done in the same transaction as its rows, nothing is half-written.
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stdout.write('\nStopping after in-flight chunks (Ctrl-C again to force)…\n');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log('Running:');
  const result = await runQueue({
    concurrency,
    onProgress: printProgress,
    signal: controller.signal,
    checkCounts: values['check-counts'],
    ...(values.tier ? { tiers: [values.tier] } : {}),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
  });
  process.stdout.write('\n');

  console.log(
    `Done: ${result.written} chunk(s) with data, ${result.emptied} empty, ` +
    `${result.failed} failed, ${result.rowsWritten.toLocaleString('en-GB')} rows written ` +
    `in ${fmtDuration(result.elapsedMs / 1000)}.`,
  );
  if (result.aggregatesRefreshed) console.log('Continuous aggregates refreshed over the written range.');
  if (result.queue.failed > 0) {
    console.log(`${result.queue.failed} chunk(s) failed; see \`backfill status\`, retry with \`backfill retry-failed\`.`);
  }
  if (result.queue.pending > 0) {
    console.log(`${result.queue.pending.toLocaleString('en-GB')} chunk(s) still pending — re-run to continue.`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`\nbackfill: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
