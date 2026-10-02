import { type Kysely, sql } from 'kysely';
import { pino } from 'pino';
import { ArchiveReader } from '../archive/reader.ts';
import { loadRegistry } from '../capture/specs.ts';
import type { DB } from '../db/generated.ts';
import { dbConfig, errorCode, openDb } from '../db/pool.ts';
import { startHeartbeat } from '../heartbeat.ts';
import {
  type Coverage,
  computeHealth,
  findCoverage,
  findOutages,
  LagWindow,
  type Outage,
  storeChecksums,
} from './health.ts';
import { type Backlog, Loader, nothingToLoad } from './pipeline.ts';
import { parsedOkIn, prune } from './prune.ts';
import { reconcileRollups } from './reconcile.ts';
import { parseReplayArgs, replay } from './replay.ts';
import { readMeta, writeMeta } from './store.ts';
import { checkTwins } from './twins.ts';

// The `load` and `replay` roles (A§4). `load` has no egress and no registry
// write access: it reads the raw archive, writes its own tables, and leaves
// health for the API to read.

const TICK_MS = 10_000;
/**
 * One tick reads for at most this long, then the health pass and the nightly
 * jobs get their turn and the next tick goes on at once: a catch-up never
 * leaves health stale, and a stop is honoured between lines.
 */
const TICK_BUDGET_MS = 20_000;
const HEALTH_MS = 60_000;
/** The outage scan reads a week of batches: not on every health pass. */
const OUTAGE_MS = 600_000;
/** The nightly jobs run once per UTC day, after this hour. */
const NIGHTLY_HOUR = 2;

/**
 * Whether the nightly jobs are due at `now`: once per UTC day, after 02:00,
 * with nothing left to load (a torn last line does not count, review N7).
 * The day is marked in app_meta when they start, so a restart does not run them
 * again, and a failing step waits for the next day (partition-maintenance.md §4).
 */
export async function claimNightly(db: Kysely<DB>, now: Date, backlog: Backlog): Promise<boolean> {
  if (!nothingToLoad(backlog) || now.getUTCHours() < NIGHTLY_HOUR) return false;
  const day = now.toISOString().slice(0, 10);
  if ((await readMeta<{ day: string }>(db, 'nightly'))?.day === day) return false;
  await writeMeta(db, 'nightly', { day });
  return true;
}

const rawDirOf = (env: Readonly<Record<string, string | undefined>>) => env.RWS_RAW_DIR || '/data/raw';

/** The shortest capture cadence per source (what "fresh" means for its fetches), and the cadence of every spec. */
function cadences(): { source: Map<string, number>; spec: Map<string, number> } {
  const source = new Map<string, number>();
  const spec = new Map<string, number>();
  for (const s of loadRegistry().specs) {
    if (s.cadence_s === null || s.cadence_s <= 0) continue;
    spec.set(s.id, s.cadence_s);
    const known = source.get(s.source);
    if (known === undefined || s.cadence_s < known) source.set(s.source, s.cadence_s);
  }
  return { source, spec };
}

export async function runLoad(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<number> {
  const cfg = dbConfig(env, 'rws_load');
  if (typeof cfg === 'string') {
    log(`load: ${cfg}`);
    return 78;
  }
  const logger = pino({ base: { role: 'load' } });
  const { db, close } = openDb(cfg, { max: 3, onError: (code) => logger.error({ code }, 'database connection error') });
  const reader = new ArchiveReader(rawDirOf(env));
  const lag = new LagWindow();
  const loader = new Loader({
    db,
    reader,
    alert: (code, fields) => logger.error({ alert: code, ...fields }, 'alert'),
    info: (msg, fields) => logger.info(fields ?? {}, msg),
    now: () => new Date(),
    onLag: (source, fetchedAt, lagMs) => lag.add(source, fetchedAt, lagMs, new Date()),
  });
  const { source: cadenceS, spec: specCadenceS } = cadences();
  const apply = env.RWS_PRUNE_APPLY === '1';
  const stopHeartbeat = startHeartbeat();
  logger.info({ prune: apply ? 'apply' : 'dry-run' }, 'load started');

  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let lastHealth = 0;
  let lastOutages = 0;
  let outages: Map<string, Outage> = new Map();
  let coverage: Map<string, Coverage> = new Map();
  let caughtUp = false;
  while (!stopped) {
    // The tick alerts its own stalls and never throws.
    const { lines, loaded, more } = await loader.tick({ until: Date.now() + TICK_BUDGET_MS, stop: () => stopped });
    if (lines > 0) logger.info({ lines, loaded }, 'manifest lines consumed');
    const now = new Date();
    try {
      const backlog = await loader.backlog(now);
      const idle = nothingToLoad(backlog);
      // Checksums once the first replay is complete, then nightly.
      if (!caughtUp && idle) {
        caughtUp = true;
        await storeChecksums(db, now);
        logger.info('caught up with the manifest: partition checksums stored');
      }
      if (now.getTime() - lastHealth >= HEALTH_MS) {
        if (now.getTime() - lastOutages >= OUTAGE_MS) {
          // A failed scan keeps the last result and waits for its next slot, not the next 10-second tick, and the
          // health pass still runs (review of P2b). The loop has no test harness: this stays inline.
          lastOutages = now.getTime();
          outages = await findOutages(db, cadenceS, now).catch((err: unknown) => {
            logger.error({ code: errorCode(err) }, 'outage scan failed; the last result stands');
            return outages;
          });
          coverage = await findCoverage(db, cadenceS, now).catch((err: unknown) => {
            logger.error({ code: errorCode(err) }, 'coverage scan failed; the last result stands');
            return coverage;
          });
        }
        await computeHealth(db, {
          cadenceS,
          specCadenceS,
          lagP95Ms: lag.p95(now),
          backlog,
          badLines: loader.badLines,
          now,
          outages,
          coverage,
        });
        for (const twin of await checkTwins(db, now)) logger.error({ alert: 'twin_breach', twin }, 'alert');
        lastHealth = now.getTime();
      }
      if (await claimNightly(db, now, backlog)) {
        await sql`SELECT ensure_partitions(now(), now() + interval '3 months')`.execute(db);
        const { repaired } = await reconcileRollups(db, now);
        if (repaired > 0) logger.error({ alert: 'rollup_mismatch', repaired }, 'alert');
        await storeChecksums(db, now);
        const report = await prune(reader, parsedOkIn(db), { apply, now });
        logger.info(report, 'retention pruner');
      }
    } catch (err) {
      // Only a code: a driver message can quote SQL, a host or a path.
      logger.error(
        { code: errorCode(err), name: err instanceof Error ? err.name : 'unknown' },
        'load pass failed; retrying',
      );
    }
    if (stopped) break;
    if (more) continue;
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, TICK_MS);
    });
  }
  logger.info('load stopping');
  stopHeartbeat();
  await close();
  return 0;
}

export async function runReplay(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<number> {
  const args = parseReplayArgs(argv);
  if (typeof args === 'string') {
    log(args);
    return 64;
  }
  const cfg = dbConfig(env, 'rws_load');
  if (typeof cfg === 'string') {
    log(`replay: ${cfg}`);
    return 78;
  }
  const logger = pino({ base: { role: 'replay' } });
  const { db, close } = openDb(cfg, { max: 2 });
  try {
    const result = await replay(
      {
        db,
        reader: new ArchiveReader(rawDirOf(env)),
        alert: (code, fields) => logger.error({ alert: code, ...fields }, 'alert'),
        now: () => new Date(),
      },
      args,
    );
    console.log(JSON.stringify({ ...args, ...result }));
    return 0;
  } catch (err) {
    log(`replay: failed (${errorCode(err)})`);
    return 1;
  } finally {
    await close();
  }
}
