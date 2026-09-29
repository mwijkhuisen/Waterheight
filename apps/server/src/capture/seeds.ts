import { type RunDeps, runSpec } from './runner.ts';
import { durationMs, type LoadedSpec, type Registry } from './specs.ts';
import { type SeedRecord, type StatusPaths, writeSeedReport } from './status.ts';

// The §0.1b day-0 harvest: one-off, idempotent (a finished seed is never run
// again, and says so), paced (FR-1 ≥ 2 s between requests), resumable per
// item (its progress is in _state/seeds/<spec>.json), and off the main queue:
// seeds run one request at a time, so a host's second connection always stays
// free for the scheduled captures. Public seeds go to seed-report.json and the
// public seeds[]; the LU-2 first capture only to the owner status.

const DAY = 86_400_000;

export type SeedState = {
  done: string[];
  files: number;
  series: number;
  coverage: { from: string; to: string } | null;
  done_at?: string;
};

const mergeCoverage = (a: SeedState['coverage'], b: SeedState['coverage']): SeedState['coverage'] =>
  a === null ? b : b === null ? a : { from: a.from < b.from ? a.from : b.from, to: a.to > b.to ? a.to : b.to };

export function seedRecord(spec: LoadedSpec, st: SeedState): SeedRecord & { audience: 'public' | 'owner' } {
  const days = st.coverage === null ? 0 : (Date.parse(st.coverage.to) - Date.parse(st.coverage.from)) / DAY;
  return {
    spec: spec.id,
    audience: spec.audience,
    series: st.series,
    days_covered: Math.round(days * 10) / 10,
    files: st.files,
    done_at: st.done_at as string,
  };
}

/** Finished seeds, for the status files. */
export async function seedRecords(registry: Registry, deps: Pick<RunDeps, 'state'>) {
  const out: (SeedRecord & { audience: 'public' | 'owner' })[] = [];
  for (const spec of registry.specs.filter((s) => s.seed)) {
    const st = await deps.state.read<SeedState>(`seeds/${spec.id}`);
    if (st?.done_at) out.push(seedRecord(spec, st));
  }
  return out;
}

async function seedOne(spec: LoadedSpec, deps: RunDeps): Promise<void> {
  const seed = spec.seed;
  if (seed === undefined) return;
  const name = `seeds/${spec.id}`;
  let st: SeedState = (await deps.state.read<SeedState>(name)) ?? { done: [], files: 0, series: 0, coverage: null };
  if (st.done_at !== undefined) {
    deps.log.info({ spec: spec.id }, 'seed already done');
    return;
  }
  const save = async (patch: Partial<SeedState>) => {
    st = { ...st, ...patch };
    await deps.state.update<SeedState>(name, () => st);
  };
  const now = deps.now();
  const add = async (key: string, s: Awaited<ReturnType<typeof runSpec>>) => {
    // Done unless only transient failures happened (a 404 or an invalid body will not heal by retrying).
    await save({
      done: s.ok > 0 || !s.transient ? [...st.done, key] : st.done,
      files: st.files + s.stored,
      coverage: mergeCoverage(st.coverage, s.coverage),
    });
  };

  if (seed.kind === 'once' || seed.kind === 'window') {
    const window =
      seed.kind === 'window' && seed.window
        ? { from: new Date(now.getTime() - durationMs(seed.window)), to: now }
        : undefined;
    await save({ series: spec.rows.length });
    for (const [i, row] of spec.rows.entries()) {
      const key = `row${i}`;
      if (st.done.includes(key)) continue;
      if (i > 0 && seed.pace_ms > 0) await deps.sleep(seed.pace_ms);
      await add(key, await runSpec(spec, deps, { seed: true, rows: [row], ...(window ? { window } : {}) }));
    }
  } else if (seed.kind === 'days') {
    // Hub'Eau keeps one month: day windows from 30 days ago (+1 h margin) up to now, each paged by cursor.
    const days = seed.days ?? 30;
    const start = now.getTime() - days * DAY + 3_600_000;
    await save({ series: spec.rows.length });
    for (let d = 0; d < days; d += 1) {
      const key = `day${d}`;
      if (st.done.includes(key)) continue;
      const from = new Date(start + d * DAY);
      const to = new Date(Math.min(start + (d + 1) * DAY, now.getTime()));
      await add(
        key,
        await runSpec(spec, deps, {
          seed: true,
          window: { from, to },
          spaceMs: seed.pace_ms,
          maxExpand: seed.page_cap,
        }),
      );
      await deps.sleep(seed.pace_ms);
    }
  } else {
    // all-resources (LU-5): walk every list page and fetch each dump not seen yet, by its own url.
    const s = await runSpec(spec, deps, { seed: true, spaceMs: seed.pace_ms, maxExpand: seed.page_cap });
    const seen = (await deps.state.read<{ seen: string[] }>(spec.id))?.seen.length ?? 0;
    await save({
      series: 1,
      files: seen,
      coverage: mergeCoverage(st.coverage, s.coverage),
      done: s.ok > 0 ? ['all'] : [],
    });
    if (s.ok === 0) return; // not done: the next start resumes (the seen set persisted)
  }
  const complete =
    seed.kind === 'all-resources' || st.done.length >= (seed.kind === 'days' ? (seed.days ?? 30) : spec.rows.length);
  if (complete) {
    await save({ done_at: deps.now().toISOString() });
    deps.log.info({ spec: spec.id, files: st.files }, 'seed done');
  } else {
    deps.log.warn({ spec: spec.id, done: st.done.length }, 'seed incomplete; resumes at the next start');
  }
}

/** Runs every unfinished seed once, one after the other. */
export async function runSeeds(registry: Registry, deps: RunDeps, paths: StatusPaths): Promise<void> {
  for (const spec of registry.specs.filter((s) => s.seed)) {
    try {
      await seedOne(spec, deps);
    } catch (err) {
      deps.log.error({ spec: spec.id, err: String(err) }, 'seed failed; resumes at the next start');
    }
  }
  await writeSeedReport(paths, await seedRecords(registry, deps));
}
