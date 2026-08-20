#!/usr/bin/env node
/**
 * Runs the latest poll by hand, or on a loop.
 *
 *   latest                    one cycle, then exit
 *   latest --watch            keep polling on the configured interval
 *   latest --discovery 500    probe more unknown pairs than a cycle usually does
 *   latest --dry-run          print the plan and what it would cost, fetch nothing
 *
 * The same code path the scheduler uses. `--watch` is what to run when the API
 * is scaled past one instance and the schedules are off there: one worker
 * polls, every instance serves what it wrote.
 */

import '../env.js';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { listPollTargets } from '../db/series.js';
import { listPairsToDiscover } from '../db/locations.js';
import { planBatches, pollLatest } from '../ingest/latest.js';

const { values } = parseArgs({
  options: {
    watch: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    interval: { type: 'string' },
    'batch-size': { type: 'string' },
    discovery: { type: 'string' },
    'max-age-hours': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${value}`);
  return n;
}

if (values.help) {
  console.log(`Usage: latest [options]

  --watch                keep polling instead of exiting after one cycle
  --dry-run              print the plan without fetching anything
  --interval <minutes>   override the watch interval (default ${config.latestPoll.intervalMs / 60_000})
  --batch-size <n>       locations per upstream call (default ${config.latestPoll.batchSize})
  --discovery <n>        pairs probed for an unknown series (default ${config.latestPoll.discoveryLimit})
  --max-age-hours <n>    how old a reading may be and still count as live (default ${config.latestPoll.maxAgeMs / 3_600_000})
`);
  process.exit(0);
}

const maxAgeMs = number(values['max-age-hours']) !== undefined
  ? number(values['max-age-hours'])! * 3_600_000
  : config.latestPoll.maxAgeMs;
const batchSize = number(values['batch-size']) ?? config.latestPoll.batchSize;
const discoveryLimit = number(values.discovery) ?? config.latestPoll.discoveryLimit;
const intervalMs = number(values.interval) !== undefined
  ? number(values.interval)! * 60_000
  : config.latestPoll.intervalMs;

const options = { maxAgeMs, batchSize, discoveryLimit };

try {
  if (values['dry-run']) {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const targets = await listPollTargets(cutoff);
    const batches = planBatches(targets, batchSize, config.latestPoll.maxCombinations);
    const pairs = await listPairsToDiscover(
      new Date(Date.now() - config.activeWindowDays * 86_400_000),
      cutoff,
      discoveryLimit,
    );

    const locations = new Set(targets.map((t) => t.locationCode));
    console.log(
      `${targets.length} live series at ${locations.size} location(s), ` +
      `${batches.length} upstream call(s) carrying ` +
      `${batches.reduce((n, b) => n + b.filters.length, 0)} filter(s)`,
    );
    console.log(
      `${pairs.length} pair(s) would be probed for a series not yet known` +
      (pairs.length > 0 ? `, starting with ${pairs[0]!.locationCode}/${pairs[0]!.grootheid}` : ''),
    );
    // Cheap to run and the only place the shape of a cycle is visible before
    // it costs anything upstream, so it prints the widest filters too.
    const bySize = [...batches]
      .sort((a, b) =>
        b.locationCodes.length * b.filters.length - a.locationCodes.length * a.filters.length)
      .slice(0, 5);
    for (const batch of bySize) {
      const first = batch.filters[0]!;
      console.log(
        `  ${first.compartiment}/${first.grootheid}` +
        `${first.parameter ? `/${first.parameter}` : ''}` +
        `${batch.filters.length > 1 ? ` +${batch.filters.length - 1} more filter(s)` : ''}` +
        ` -> ${batch.locationCodes.length} location(s)`,
      );
    }
  } else if (values.watch) {
    console.log(`[latest] polling every ${Math.round(intervalMs / 60_000)} minute(s); Ctrl-C to stop`);
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        controller.abort();
        console.log(`\n[latest] ${signal} received, finishing the current cycle`);
      });
    }
    // A cycle that overruns its interval must not have a second one started on
    // top of it, so the next wait begins when this one ends.
    while (!controller.signal.aborted) {
      await pollLatest({ ...options, signal: controller.signal });
      if (controller.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } else {
    await pollLatest(options);
  }
} catch (err) {
  console.error(`Latest poll failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
