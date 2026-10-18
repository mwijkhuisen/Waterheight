import { SPEC_RE } from '../archive/manifest.ts';
import { Archive } from '../archive/writer.ts';
import { captureEnv, captureUserAgent, EXIT_CONFIG, readSecret } from '../capture/env.ts';
import { loadRegistry, type Registry } from '../capture/specs.ts';
import { dbConfig, errorCode, openDb } from '../db/pool.ts';
import { Client } from '../http/client.ts';
import { type Job, type JobStatus, type JobStore, SqlJobStore } from './job.ts';
import { jobBudget, planChunks, unitRange } from './plan.ts';
import { NL1_DRY_RUN, project, totals } from './project.ts';
import { PROVIDERS, type Provider } from './provider.ts';
import { type RunResult, runBackfill } from './run.ts';
import { ceilingMs, type LoadedBackfill, type LoadedBackfillSpec, loadBackfill, type Unit } from './spec.ts';

// `backfill plan|run|status|pause|resume|abort` (P14a, plan §3.3): the history runner's command line. Arguments are
// hand-rolled like replay's; every value is checked against a fixed pattern. Output is one JSON line per job and a
// totals line, with fixed codes and never provider text. Exit codes: 0, 64 usage, 78 config, 1 failure.

export const EXIT_USAGE = 64;

export const BACKFILL_USAGE = `usage: backfill plan --spec <id> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--series key,…] [--dry-run]
       backfill run [--until YYYY-MM-DDTHH:MM:SSZ]
       backfill status
       backfill pause|resume|abort --job <id>`;

export type BackfillArgs =
  | { cmd: 'plan'; spec: string; from: string | null; to: string | null; series: string[] | null; dryRun: boolean }
  | { cmd: 'run'; until: Date | null }
  | { cmd: 'status' }
  | { cmd: 'pause' | 'resume' | 'abort'; job: number };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string) =>
  DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isInstant = (v: string) =>
  INSTANT.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === `${v.slice(0, 19)}.000Z`;
/**
 * A unit key: an NL-1 provider key `<code>/<Grootheid>/<Hoedanigheid>/<method>`, a DE-8 `<dataset>/<decade>`, an
 * FR-2 `<code>/<aggregate>` or a CH-9 dataset id; nothing outside this alphabet.
 */
const SERIES_KEY = /^[A-Za-z0-9._:/-]{1,300}$/;

/** The arguments, or a usage error text. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs | string {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] as string;
    if (flag === '--dry-run' && cmd === 'plan' && !dryRun) {
      dryRun = true;
      continue;
    }
    const value = rest[++i];
    if (!flag.startsWith('--') || value === undefined || flags.has(flag)) return `backfill ${cmd}: bad argument`;
    flags.set(flag, value);
  }
  const allowed = (names: readonly string[]) => [...flags.keys()].every((k) => names.includes(k));
  switch (cmd) {
    case 'plan': {
      const spec = flags.get('--spec');
      const from = flags.get('--from') ?? null;
      const to = flags.get('--to') ?? null;
      const series = flags.get('--series')?.split(',') ?? null;
      if (!allowed(['--spec', '--from', '--to', '--series']) || spec === undefined || !SPEC_RE.test(spec))
        return 'backfill plan: --spec <id> is required; the others are --from, --to, --series and --dry-run';
      if ((from !== null && !isDay(from)) || (to !== null && !isDay(to)))
        return 'backfill plan: --from and --to are UTC days (YYYY-MM-DD)';
      if (series !== null && !series.every((k) => SERIES_KEY.test(k)))
        return 'backfill plan: --series is a list of keys';
      return { cmd, spec, from, to, series, dryRun };
    }
    case 'run': {
      const until = flags.get('--until') ?? null;
      if (!allowed(['--until']) || (until !== null && !isInstant(until)))
        return 'backfill run: --until is a UTC instant (YYYY-MM-DDTHH:MM:SSZ)';
      return { cmd, until: until === null ? null : new Date(until) };
    }
    case 'status':
      return rest.length === 0 ? { cmd } : 'backfill status takes no arguments';
    case 'pause':
    case 'resume':
    case 'abort': {
      const job = flags.get('--job') ?? '';
      if (!allowed(['--job']) || !/^[1-9]\d{0,9}$/.test(job)) return `backfill ${cmd}: --job <id> is required`;
      return { cmd, job: Number(job) };
    }
    default:
      return BACKFILL_USAGE;
  }
}

const print = (o: unknown) => console.log(JSON.stringify(o));
/**
 * A rough wait per committed chunk until the loader has it (UNLOADED_SLEEP_MS 2 s plus a loader tick of up to 10 s; a
 * warm DE-8 slice loads in milliseconds): the dry-run's estimate for a reuse provider, never a limit.
 */
const SLICE_WAIT_MS = 8_000;

const jobLine = (j: Job) => ({
  job: j.id,
  spec: j.spec_id,
  series: j.series_key,
  status: j.status,
  range_from: j.range_from.toISOString(),
  range_to: j.range_to.toISOString(),
  data_from: j.data_from?.toISOString() ?? null,
  cursor: j.cursor_ts.toISOString(),
  chunks_done: j.chunks_done,
  chunks_with_data: j.chunks_with_data,
  requests: j.requests,
  request_budget: j.request_budget,
  attempts: j.attempts,
  provider_values: j.provider_values,
  inserted: j.inserted,
  revised: j.revised,
  skipped: j.skipped,
  dropped: j.dropped,
  unreconciled: j.unreconciled,
  error: j.last_error,
});

/**
 * The plan's range: --from (default the spec floor) up to --to (default and at most the spec's ceiling: DATA_EPOCH,
 * the first production capture, where the history meets the live rows and never reaches past them; P14b: DATA_FLOOR
 * for a spec with a target, the start of the target's display window), or a usage error.
 */
export function planRange(
  spec: LoadedBackfillSpec,
  from: string | null,
  to: string | null,
): { from: Date; to: Date } | string {
  const ceiling = new Date(ceilingMs(spec));
  const a = new Date(`${from ?? spec.floor}T00:00:00Z`);
  const b = to === null ? ceiling : new Date(`${to}T00:00:00Z`);
  if (a < new Date(`${spec.floor}T00:00:00Z`)) return 'backfill plan: --from is before the spec floor';
  if (b > ceiling)
    return spec.target === undefined
      ? 'backfill plan: --to is after the data epoch'
      : 'backfill plan: --to is after the data floor (a spec with a target stops there)';
  if (!(a < b)) return 'backfill plan: --from must be before --to';
  return { from: a, to: b };
}

/**
 * Plan: one job per unit of the spec (P14b: its range cut to the unit's own), or with `--dry-run` one projection per
 * job. The dry-run needs neither the database nor the network. `providers` is a test seam.
 */
export async function plan(
  args: Extract<BackfillArgs, { cmd: 'plan' }>,
  config: LoadedBackfill,
  jobs: JobStore | undefined,
  log: (line: string) => void,
  providers: Readonly<Record<string, Provider>> = PROVIDERS,
): Promise<number> {
  const spec = config.specs.find((s) => s.id === args.spec);
  const provider = spec === undefined ? undefined : providers[spec.source];
  if (spec === undefined || provider === undefined) {
    const skipped = config.skipped?.some((s) => s.startsWith(`backfill spec ${args.spec}: `)) === true;
    log(
      skipped
        ? 'backfill plan: --spec has no provider built yet'
        : 'backfill plan: --spec is not in registry/backfill.yaml',
    );
    return EXIT_USAGE;
  }
  const range = planRange(spec, args.from, args.to);
  if (typeof range === 'string') {
    log(range);
    return EXIT_USAGE;
  }
  const units: readonly Unit[] = spec.series;
  const chosen = args.series === null ? units : units.filter((s) => args.series?.includes(s.series_key));
  if (args.series !== null && chosen.length !== new Set(args.series).size) {
    log('backfill plan: --series names a key the spec does not select');
    return EXIT_USAGE;
  }
  // One job per unit, over the range cut to the unit's own (DE-8: its decade); a unit outside the range has none.
  const planned = chosen.flatMap((unit) => {
    const r = unitRange(unit, range.from, range.to);
    return r === null ? [] : [{ unit, ...r }];
  });
  if (args.dryRun) {
    const rows = planned.map((j) => project(j.unit, j.from, j.to, spec.chunk_ms, provider));
    for (const r of rows) print(r);
    const ratio = (provider.dryRun ?? NL1_DRY_RUN).zstd_ratio;
    const t = totals(rows, spec.limits.min_interval_ms);
    print({
      totals: {
        spec: spec.id,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        ...t,
        // P14b (review C4): a reused answer sends nothing, but every slice still waits for its load (the guard's
        // `unloaded`), so the night is the slices', not the requests'.
        ...(provider.reuse === true
          ? { hours_with_loads: Math.round(t.hours_at_pace * 10 + (t.chunks * SLICE_WAIT_MS) / 360_000) / 10 }
          : {}),
        zstd_ratio: ratio,
        ...(ratio === 1 ? { note: 'the archive grows by the bytes: a ZIP does not compress' } : {}),
      },
    });
    return 0;
  }
  if (jobs === undefined) return 1;
  let created = 0;
  for (const j of planned) {
    const chunks = planChunks(j.from, j.to, spec.chunk_ms).length;
    const budget = jobBudget(j.from, j.to, spec.chunk_ms, provider.checkRequest !== undefined);
    const made = await jobs.insert({
      spec_id: spec.id,
      source_id: spec.source,
      series_key: j.unit.series_key,
      range_from: j.from,
      range_to: j.to,
      chunk_ms: spec.chunk_ms,
      request_budget: budget,
    });
    if (made.created) created += 1;
    print({ job: made.id, series: j.unit.series_key, created: made.created, chunks, request_budget: budget });
  }
  print({ totals: { spec: spec.id, jobs: planned.length, created } });
  return 0;
}

/** Sums of the jobs' progress, for the totals line. */
function jobTotals(jobs: readonly Job[]) {
  const by: Partial<Record<JobStatus, number>> = {};
  for (const j of jobs) by[j.status] = (by[j.status] ?? 0) + 1;
  const sum = (k: 'chunks_done' | 'requests' | 'inserted' | 'revised' | 'unreconciled') =>
    jobs.reduce((a, j) => a + j[k], 0);
  return {
    jobs: jobs.length,
    by_status: by,
    chunks_done: sum('chunks_done'),
    requests: sum('requests'),
    inserted: sum('inserted'),
    revised: sum('revised'),
    unreconciled: sum('unreconciled'),
  };
}

/** The `backfill` role (main.ts): arguments, config and the database, then the command. */
export async function backfillMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<number> {
  const args = parseBackfillArgs(argv);
  if (typeof args === 'string') {
    log(args);
    return EXIT_USAGE;
  }
  const needsRegistry = args.cmd === 'plan' || args.cmd === 'run';
  let registry: Registry | undefined;
  let config: LoadedBackfill | undefined;
  if (needsRegistry) {
    try {
      registry = loadRegistry();
      config = loadBackfill(registry.hosts);
    } catch (err) {
      log(`backfill: ${err instanceof Error ? err.message : 'registry is not valid'}`);
      return EXIT_CONFIG;
    }
  }
  if (args.cmd === 'plan' && args.dryRun) {
    return plan(args, config as LoadedBackfill, undefined, log);
  }
  const cfg = dbConfig(env, 'rws_backfill');
  if (typeof cfg === 'string') {
    log(`backfill: ${cfg}`);
    return EXIT_CONFIG;
  }
  let capture: ReturnType<typeof captureEnv> | undefined;
  if (args.cmd === 'run') {
    capture = captureEnv(env);
    if (typeof capture === 'string') {
      log(`backfill: ${capture}`);
      return EXIT_CONFIG;
    }
  }
  const { db, close } = openDb(cfg, { max: 1 });
  const store = new SqlJobStore(db);
  try {
    switch (args.cmd) {
      case 'plan':
        return await plan(args, config as LoadedBackfill, store, log);
      case 'status': {
        const jobs = await store.list();
        for (const j of jobs) print(jobLine(j));
        print({ totals: jobTotals(jobs) });
        return 0;
      }
      case 'pause':
      case 'resume':
      case 'abort': {
        const to: JobStatus = args.cmd === 'pause' ? 'paused' : args.cmd === 'resume' ? 'planned' : 'aborted';
        const only: JobStatus[] =
          args.cmd === 'pause'
            ? ['planned', 'running']
            : args.cmd === 'resume'
              ? ['paused', 'failed']
              : ['planned', 'running', 'paused', 'failed'];
        const changed = await store.setStatus(args.job, to, null, only);
        print({ job: args.job, status: changed ? to : null, changed });
        return changed ? 0 : 1;
      }
      case 'run': {
        const reg = registry as Registry;
        const cap = capture as Exclude<typeof capture, string | undefined>;
        process.umask(0o027);
        // The sources the specs name, with the allowlist and the secret headers live capture uses for them.
        const sources = [...new Set((config as LoadedBackfill).specs.map((s) => s.source))];
        const hosts = new Map(sources.map((s) => [s, reg.hosts.get(s) ?? []] as const));
        const sourceHeaders = new Map<string, Record<string, string>>();
        for (const source of sources) {
          const set: Record<string, string> = {};
          for (const [header, secret] of Object.entries(reg.secretHeaders.get(source) ?? {})) {
            const value = readSecret(secret);
            if (value !== undefined) set[header] = value;
          }
          sourceHeaders.set(source, set);
        }
        const client = new Client({ hosts, userAgent: captureUserAgent(cap), sourceHeaders });
        // SIGTERM (docker stop) and SIGINT (Ctrl-C): the loop ends between two chunks and the lease is released.
        let interrupted = false;
        let wake: (() => void) | undefined;
        const onSignal = () => {
          interrupted = true;
          wake?.();
        };
        process.once('SIGTERM', onSignal);
        process.once('SIGINT', onSignal);
        const result: RunResult = await runBackfill(
          {
            config: config as LoadedBackfill,
            store,
            archive: new Archive(cap.rawDir),
            client,
            now: () => new Date(),
            sleep: (ms) =>
              new Promise<void>((r) => {
                if (interrupted) return r();
                const t = setTimeout(r, ms);
                wake = () => {
                  clearTimeout(t);
                  r();
                };
              }),
          },
          { ...(args.until === null ? {} : { until: args.until }), stop: () => interrupted },
        ).finally(() => {
          process.off('SIGTERM', onSignal);
          process.off('SIGINT', onSignal);
        });
        for (const j of result.jobs) print(j);
        print({
          totals: {
            stopped: result.stopped,
            jobs: result.jobs.length,
            chunks: result.jobs.reduce((a, j) => a + j.chunks, 0),
            requests: result.jobs.reduce((a, j) => a + j.requests, 0),
            failed: result.jobs.filter((j) => j.status === 'failed').length,
            guard_waits: result.guard_waits,
          },
        });
        const stoppedBad = ['breaker_open', 'busy', 'throttled', 'stuck'].includes(result.stopped);
        return result.jobs.some((j) => j.status === 'failed') || stoppedBad ? 1 : 0;
      }
    }
  } catch (err) {
    log(`backfill: failed (${errorCode(err)})`);
    return 1;
  } finally {
    await close();
  }
}
