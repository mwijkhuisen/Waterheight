import { join } from 'node:path';
import { z } from 'zod';
import { utcDay } from '../archive/writer.ts';
import type { Counters, Day } from './runner.ts';
import type { Audience, LoadedSpec, Registry } from './specs.ts';
import { type SpecState, writeFileAtomic } from './state.ts';

// Status files (the P1a ↔ P1b contract; A§7.1). The public file lists public
// specs only, plus the aggregate owner_specs {fresh, total}; the owner file
// holds the same fields for owner specs and nothing serves it in P1. Nothing
// else goes in: no URLs, hosts, versions or error bodies (invariant 11).

const iso = z.iso.datetime();
const n = z.number().int().nonnegative();
const SourceId = z.string().regex(/^(?:NL|DE|BE|FR|LU|CH)-\d+$/);

export const StatusSpec = z.strictObject({
  source: SourceId,
  spec: z.string(),
  cadence_s: n,
  last_success: iso.nullable(),
  last_failure_status: z.union([z.number().int(), z.string().regex(/^[a-z_]+$/)]).nullable(),
  next_due: iso.nullable(),
  bytes_today: n,
});
export const StatusDay = z.strictObject({
  source: SourceId,
  date: z.iso.date(),
  scheduled: n,
  ok: n,
  upstream_5xx: n,
  timeouts: n,
  other: n,
  bytes: z.record(z.string(), n),
});
export const SeedRecord = z.strictObject({
  spec: z.string(),
  series: n,
  days_covered: z.number().nonnegative(),
  files: n,
  done_at: iso,
});
export type SeedRecord = z.infer<typeof SeedRecord>;

export const CaptureStatus = z.strictObject({
  generated_at: iso,
  specs: z.array(StatusSpec),
  days: z.array(StatusDay),
  seeds: z.array(SeedRecord),
  owner_specs: z.strictObject({ fresh: n, total: n }).optional(),
});
export type CaptureStatus = z.infer<typeof CaptureStatus>;

/** Fresh: a success within 3 × cadence; a spec never attempted yet counts from when it was enabled. */
export function isFresh(spec: LoadedSpec, st: SpecState | undefined, now: Date): boolean {
  if (spec.cadence_s === null) return true;
  const limit = 3 * spec.cadence_s * 1000;
  const since = st?.last_success ?? (st?.last_attempt === undefined ? st?.enabled_since : undefined);
  return since !== undefined && now.getTime() - Date.parse(since) <= limit;
}

const emptyDay = (): Day => ({ scheduled: 0, ok: 0, upstream_5xx: 0, timeouts: 0, other: 0, bytes: {} });

export type StatusInput = {
  registry: Registry;
  states: ReadonlyMap<string, SpecState>;
  counters: Counters;
  seeds: readonly (SeedRecord & { audience: Audience })[];
  nextDue: (specId: string) => Date | null;
  now: Date;
};

export function buildStatus(audience: Audience, input: StatusInput): CaptureStatus {
  const { registry, states, counters, now } = input;
  const scheduled = registry.specs.filter((s) => s.cadence_s !== null);
  const mine = scheduled.filter((s) => s.audience === audience);
  const today = utcDay(now);
  const status: CaptureStatus = {
    generated_at: now.toISOString(),
    specs: mine.map((s) => {
      const st = states.get(s.id);
      const due = input.nextDue(s.id);
      const failure = st?.last_failure_status ?? null;
      return {
        source: s.source,
        spec: s.id,
        cadence_s: s.cadence_s as number,
        last_success: st?.last_success ?? null,
        last_failure_status: typeof failure === 'string' && !/^[a-z_]+$/.test(failure) ? 'other' : failure,
        next_due: due === null ? null : due.toISOString(),
        bytes_today: counters.days[today]?.[s.source]?.bytes[s.id] ?? 0,
      };
    }),
    days: [],
    seeds: input.seeds.filter((r) => r.audience === audience).map(({ audience: _, ...r }) => r),
  };
  const sources = [...new Set(mine.map((s) => s.source))].sort();
  const specIds = new Set(mine.map((s) => s.id));
  for (let back = 2; back >= 0; back -= 1) {
    const date = utcDay(new Date(now.getTime() - back * 86_400_000));
    for (const source of sources) {
      const d = counters.days[date]?.[source] ?? emptyDay();
      const bytes = Object.fromEntries(Object.entries(d.bytes).filter(([spec]) => specIds.has(spec)));
      status.days.push({ source, date, ...d, bytes });
    }
  }
  if (audience === 'public') {
    const owner = scheduled.filter((s) => s.audience === 'owner');
    status.owner_specs = { fresh: owner.filter((s) => isFresh(s, states.get(s.id), now)).length, total: owner.length };
  }
  return CaptureStatus.parse(status);
}

export type StatusPaths = { rawDir: string; statusDir: string; ownerStatusDir: string };

/** Both files, each atomically: public 0644 (Caddy serves it), owner 0640. */
export async function writeStatus(paths: StatusPaths, input: StatusInput): Promise<void> {
  await writeFileAtomic(
    join(paths.statusDir, 'capture.json'),
    `${JSON.stringify(buildStatus('public', input))}\n`,
    0o644,
  );
  await writeFileAtomic(
    join(paths.ownerStatusDir, 'capture.json'),
    `${JSON.stringify(buildStatus('owner', input))}\n`,
    0o640,
  );
}

/**
 * The daily capture report for `date`: public specs to raw/_reports/{date}.json,
 * the owner part only to $RWS_OWNER_STATUS_DIR/reports/{date}.json.
 */
export async function writeDailyReport(
  paths: StatusPaths,
  registry: Registry,
  counters: Counters,
  date: string,
): Promise<void> {
  for (const audience of ['public', 'owner'] as const) {
    const specs = registry.specs.filter((s) => s.audience === audience);
    const ids = new Set(specs.map((s) => s.id));
    const sources = [...new Set(specs.map((s) => s.source))].sort();
    const report = {
      date,
      generated_at: new Date().toISOString(),
      sources: Object.fromEntries(
        sources.map((src) => {
          const d = counters.days[date]?.[src] ?? emptyDay();
          return [src, { ...d, bytes: Object.fromEntries(Object.entries(d.bytes).filter(([s]) => ids.has(s))) }];
        }),
      ),
      alerts: (counters.alerts[date] ?? []).filter((a) => ids.has(a.spec)),
    };
    const file =
      audience === 'public'
        ? join(paths.rawDir, '_reports', `${date}.json`)
        : join(paths.ownerStatusDir, 'reports', `${date}.json`);
    await writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`, 0o640);
  }
}

/** raw/_reports/seed-report.json: public seeds only (the LU-2 first capture is owner status only). */
export async function writeSeedReport(paths: StatusPaths, seeds: readonly (SeedRecord & { audience: Audience })[]) {
  const report = {
    generated_at: new Date().toISOString(),
    seeds: seeds.filter((s) => s.audience === 'public').map(({ audience: _, ...r }) => r),
  };
  await writeFileAtomic(
    join(paths.rawDir, '_reports', 'seed-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    0o640,
  );
}
