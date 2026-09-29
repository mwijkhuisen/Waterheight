import { Cron } from 'croner';
import { utcDay } from '../archive/writer.ts';
import type { Pinger } from './pings.ts';
import { type RunDeps, runSpec } from './runner.ts';
import type { Group, LoadedSpec, Registry } from './specs.ts';
import type { SpecState } from './state.ts';
import { isFresh, type SeedRecord, type StatusPaths, writeDailyReport, writeStatus } from './status.ts';

// The scheduler (A§7.2, A§7.3): croner in UTC with protection (a run that is
// still busy blocks the next tick, which is counted, never queued), staggered
// crons from capture.yaml, the first-enabled group registered first. No run
// on start (a redeploy must not burst the RWS budget); a tick missed while the
// process was down runs once, staggered. A failed daily/weekly run retries
// hourly until its next tick. The group's shortest-cadence spec drives the
// healthchecks ping: /start, then success when every spec of the group is
// fresh and no page alert is pending, else /fail.

export type RecorderDeps = RunDeps & {
  registry: Registry;
  pinger: Pinger;
  paths: StatusPaths;
  seeds: () => (SeedRecord & { audience: 'public' | 'owner' })[];
};

/**
 * Protection per job. croner's own `protect` option re-fires a blocked tick
 * as soon as the busy run ends (a late, queued run), so the scheduler keeps
 * its own busy flag: a tick that finds the job busy is reported and dropped.
 */
export function guarded(run: () => Promise<void>, onBlocked: () => void): () => Promise<void> | undefined {
  let busy = false;
  return () => {
    if (busy) {
      onBlocked();
      return undefined;
    }
    busy = true;
    return run().finally(() => {
      busy = false;
    });
  };
}

export type Recorder = {
  jobs: Map<string, Cron>;
  /** Runs one scheduled spec now (catch-up, retries and tests use it). */
  run: (spec: LoadedSpec) => Promise<void>;
  writeStatusNow: () => Promise<void>;
  stop: () => Promise<void>;
};

const OWNER_GROUPS = new Set(['cap-owner', 'cap-bfg']);
const HOUR = 3_600_000;

export async function startRecorder(deps: RecorderDeps): Promise<Recorder> {
  const { registry, log } = deps;
  const jobs = new Map<string, Cron>();
  const running = new Set<Promise<void>>();
  const retries = new Map<string, NodeJS.Timeout>();
  const timers: NodeJS.Timeout[] = [];

  const groupOf = (spec: LoadedSpec): Group | undefined => registry.groups.find((g) => g.anchor === spec.id);

  async function pingGroup(group: Group): Promise<void> {
    const now = deps.now();
    const stale: string[] = [];
    const pages: string[] = [];
    for (const s of registry.specs.filter((x) => x.group === group.slug && x.cadence_s !== null)) {
      const st = await deps.state.read<SpecState>(s.id);
      if (!isFresh(s, st, now)) stale.push(s.id);
      if (st !== undefined && st.pending_page.length > 0) {
        pages.push(...st.pending_page.map((p) => `${s.id}:${p}`));
        await deps.state.update<SpecState>(s.id, (cur) => ({ ...(cur ?? st), pending_page: [] }));
      }
    }
    if (stale.length === 0 && pages.length === 0) return deps.pinger.ping(group.slug, 'success');
    const body = OWNER_GROUPS.has(group.slug) ? undefined : [...stale.map((s) => `stale ${s}`), ...pages].join('\n');
    log.warn({ group: group.slug, stale: stale.length, alerts: pages.length }, 'group unhealthy');
    return deps.pinger.ping(group.slug, 'fail', body);
  }

  async function runScheduled(spec: LoadedSpec): Promise<void> {
    const cadence = (spec.cadence_s as number) * 1000;
    const group = groupOf(spec);
    if (group) await deps.pinger.ping(group.slug, 'start');
    const summary = await runSpec(spec, deps, { deadline: deps.now().getTime() + 0.9 * cadence });
    if (cadence >= 24 * HOUR && (summary.transient || summary.ok === 0)) {
      const next = jobs.get(spec.id)?.nextRun()?.getTime() ?? Number.POSITIVE_INFINITY;
      if (next - deps.now().getTime() > HOUR && !retries.has(spec.id)) {
        const t = setTimeout(() => {
          retries.delete(spec.id);
          void fire.get(spec.id)?.();
        }, HOUR);
        t.unref();
        retries.set(spec.id, t);
      }
    }
    if (group) await pingGroup(group);
  }

  function track(p: Promise<void>): Promise<void> {
    const q = p.catch((err: unknown) => log.error({ err: String(err) }, 'run failed'));
    running.add(q);
    void q.finally(() => running.delete(q));
    return q;
  }

  const scheduled = registry.specs.filter((s) => s.cron !== null).sort((a, b) => Number(b.first) - Number(a.first));
  const fire = new Map<string, () => Promise<void> | undefined>();
  for (const spec of scheduled) {
    const tick = guarded(
      () => track(runScheduled(spec)),
      () => {
        const day = utcDay(deps.now());
        for (let i = 0; i < spec.rows.length; i += 1) deps.counters.record(day, spec.source, 'other');
        log.warn({ spec: spec.id }, 'previous run still busy: tick skipped');
      },
    );
    fire.set(spec.id, tick);
    const job = new Cron(
      spec.cron as string,
      {
        name: spec.id,
        timezone: 'UTC',
        catch: (err: unknown) => log.error({ spec: spec.id, err: String(err) }, 'run threw'),
      },
      tick,
    );
    jobs.set(spec.id, job);
  }

  // A tick missed while the process was down runs once (it never ran, so no extra load).
  let stagger = 0;
  for (const spec of scheduled) {
    const st = await deps.state.read<SpecState>(spec.id);
    const job = jobs.get(spec.id) as Cron;
    const now = deps.now();
    const prev = job.previousRuns(1, now)[0];
    if (st?.last_attempt === undefined || prev === undefined) continue;
    if (
      prev.getTime() > Date.parse(st.last_attempt) &&
      now.getTime() - prev.getTime() < (spec.cadence_s as number) * 1000
    ) {
      stagger += 1;
      const t = setTimeout(() => fire.get(spec.id)?.(), 15_000 * stagger);
      t.unref();
      timers.push(t);
      log.info({ spec: spec.id }, 'catch-up of a missed tick scheduled');
    }
  }

  async function writeStatusNow(): Promise<void> {
    const now = deps.now();
    const states = new Map<string, SpecState>();
    for (const s of registry.specs) {
      const st = await deps.state.read<SpecState>(s.id);
      if (st) states.set(s.id, st);
    }
    deps.counters.prune(now);
    await deps.state.update('counters', () => deps.counters);
    await writeStatus(deps.paths, {
      registry,
      states,
      counters: deps.counters,
      seeds: deps.seeds(),
      nextDue: (id) => jobs.get(id)?.nextRun() ?? null,
      now,
    });
  }

  const statusJob = new Cron('30 * * * * *', { timezone: 'UTC', protect: true }, () =>
    writeStatusNow().catch((err: unknown) => log.error({ err: String(err) }, 'status write failed')),
  );
  const reportJob = new Cron('0 5 0 * * *', { timezone: 'UTC', protect: true }, () =>
    writeDailyReport(deps.paths, registry, deps.counters, utcDay(new Date(deps.now().getTime() - 86_400_000))).catch(
      (err: unknown) => log.error({ err: String(err) }, 'daily report failed'),
    ),
  );

  return {
    jobs,
    run: (spec) => fire.get(spec.id)?.() ?? Promise.resolve(),
    writeStatusNow,
    stop: async () => {
      for (const j of [...jobs.values(), statusJob, reportJob]) j.stop();
      for (const t of [...timers, ...retries.values()]) clearTimeout(t);
      await Promise.race([Promise.all(running), new Promise((r) => setTimeout(r, 8000).unref())]);
    },
  };
}
