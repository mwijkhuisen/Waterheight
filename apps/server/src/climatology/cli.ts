import { type DoySet, doyClimatology } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { CHANNEL_AUDIENCES, type ChannelAudience } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { dbConfig, errorCode, openDb } from '../db/pool.ts';
import { lock } from '../load/store.ts';
import { climatologyConfig } from './config.ts';
import { type Candidate, readCandidates, readDailyMeans } from './read.ts';
import { applyPlan, type Counts, planOf, readStored } from './write.ts';

// The day-of-year climatology command (P14f, plan section 3.4; docs/runbooks/climatology.md): our own P10 and P90 of
// each eligible series' daily means per UTC day of the year, stored as P10_DOY and P90_DOY reference rows under the
// series' own source. It runs as rws_migrator (the login that already writes derived references), reads the data only
// through the family's views in READ ONLY transactions and writes only reference_value and the dirty log. Output is
// counts only: owner series are in the same run, so no id, station or source of one ever reaches the log.

const EXIT_FAILURE = 1;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;
const USAGE = 'usage: main.js climatology [--dry-run] [--family public|owner] [--series <id>,…]';
const MAX_SERIES = 1_000;

type Args = { dryRun: boolean; families: readonly ChannelAudience[]; series: ReadonlySet<number> | null };

/** Strict parsing: each flag at most once; null for a usage error. */
function parseArgs(argv: readonly string[]): Args | null {
  let dryRun = false;
  let family: ChannelAudience | undefined;
  let series: Set<number> | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      if (dryRun) return null;
      dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return null;
    if (flag === '--family') {
      if (family !== undefined || !CHANNEL_AUDIENCES.includes(value as ChannelAudience)) return null;
      family = value as ChannelAudience;
    } else if (flag === '--series') {
      const ids = value.split(',');
      if (series !== undefined || ids.length > MAX_SERIES || !ids.every((id) => /^[1-9][0-9]{0,8}$/.test(id)))
        return null;
      series = new Set(ids.map(Number));
    } else return null;
  }
  return { dryRun, families: family === undefined ? CHANNEL_AUDIENCES : [family], series: series ?? null };
}

type Deps = { now?: () => Date };
type Totals = {
  considered: number;
  eligible: number;
  withSet: number;
  years: [number, number] | null;
  rows: Counts;
};

/** The series of `ids` that have an open DOY row (the ones that may have to be closed). */
async function withOpenRows(db: Kysely<DB>, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { rows } = await sql<{ series_id: number }>`
    SELECT DISTINCT series_id FROM reference_value
    WHERE kind IN ('P10_DOY', 'P90_DOY') AND upper_inf(valid) AND series_id = ANY(${ids as number[]}::int[])`.execute(
    db,
  );
  return new Set(rows.map((r) => r.series_id));
}

/**
 * `climatology [--dry-run] [--family public|owner] [--series <id>,…]`: exit 0, 1 (a failed read or write), 64
 * (usage) or 78 (no database settings, or the registry file is unusable). A re-run that changes nothing writes
 * nothing; `--dry-run` reads everything and writes nothing.
 */
export async function climatologyMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  deps: Deps = {},
): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    log(USAGE);
    return EXIT_USAGE;
  }
  let cfg: ReturnType<typeof climatologyConfig>;
  try {
    cfg = climatologyConfig();
  } catch {
    log('climatology: registry/climatology.yaml is not usable');
    return EXIT_CONFIG;
  }
  const db = dbConfig(env, 'rws_migrator');
  if (typeof db === 'string') {
    log(`climatology: ${db}`);
    return EXIT_CONFIG;
  }
  const clock = deps.now ?? (() => new Date());
  const runStart = clock();
  // One connection: the command never runs two statements at once, and rws_migrator has CONNECTION LIMIT 3, which
  // a `migrate` during the run also needs (P14f review S2).
  const conn = openDb(db, { max: 1, onError: (code) => log(`climatology: connection error ${code}`) });
  try {
    for (const family of args.families) {
      const totals: Totals = {
        considered: 0,
        eligible: 0,
        withSet: 0,
        years: null,
        rows: { new: 0, changed: 0, unchanged: 0, closed: 0 },
      };
      const all = (await readCandidates(conn.db, family)).filter((c) => args.series === null || args.series.has(c.id));
      totals.considered = all.length;
      const open = await withOpenRows(
        conn.db,
        all.filter((c) => !c.eligible).map((c) => c.id),
      );
      for (const c of all) {
        if (!c.eligible && !open.has(c.id)) continue;
        let set: DoySet | null = null;
        if (c.eligible) {
          totals.eligible += 1;
          set = doyClimatology(await readDailyMeans(conn.db, family, c.id), cfg);
          if (set !== null) {
            totals.withSet += 1;
            const [lo, hi] = totals.years ?? [Number.POSITIVE_INFINITY, 0];
            totals.years = [Math.min(lo, set.years), Math.max(hi, set.years)];
          }
        }
        const counts = await store(conn.db, c, set, runStart, clock, args.dryRun);
        for (const k of Object.keys(counts) as (keyof Counts)[]) totals.rows[k] += counts[k];
      }
      log(
        `climatology: family ${family}${args.dryRun ? ' (dry run)' : ''}: series ${totals.considered}, ` +
          `eligible ${totals.eligible}, with a set ${totals.withSet}, ` +
          `years per set ${totals.years === null ? 'none' : `${totals.years[0]}-${totals.years[1]}`}, ` +
          `rows new ${totals.rows.new}, changed ${totals.rows.changed}, unchanged ${totals.rows.unchanged}, ` +
          `closed ${totals.rows.closed}`,
      );
    }
    return 0;
  } catch (err) {
    log(`climatology: failed (${errorCode(err)})`);
    return EXIT_FAILURE;
  } finally {
    await conn.close();
  }
}

/** One series' rows: the plan always, the write unless it is a dry run. */
async function store(
  db: Kysely<DB>,
  c: Candidate,
  set: DoySet | null,
  runStart: Date,
  clock: () => Date,
  dryRun: boolean,
): Promise<Counts> {
  if (dryRun) return planOf(set, await readStored(db, c.id)).counts;
  return db.transaction().execute(async (tx) => {
    await lock(tx);
    const stored = await readStored(tx, c.id);
    const plan = planOf(set, stored);
    await applyPlan(tx, c, set, stored, plan, runStart, clock());
    return plan.counts;
  });
}
