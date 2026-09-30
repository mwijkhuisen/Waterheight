import { sql } from 'kysely';
import { pino } from 'pino';
import { ArchiveReader } from '../archive/reader.ts';
import { loadRegistry } from '../capture/specs.ts';
import { dbConfig, errorCode, openDb } from '../db/pool.ts';
import { startHeartbeat } from '../heartbeat.ts';
import { computeHealth, LagWindow, storeChecksums } from './health.ts';
import { Loader } from './pipeline.ts';
import { parsedOkKeys, prune } from './prune.ts';
import { reconcileRollups } from './reconcile.ts';
import { parseReplayArgs, replay } from './replay.ts';

// The `load` and `replay` roles (A§4). `load` has no egress and no registry
// write access: it reads the raw archive, writes its own tables, and leaves
// health for the API to read.

const TICK_MS = 10_000;
const HEALTH_MS = 60_000;
/** The nightly jobs run once per UTC day, after this hour. */
const NIGHTLY_HOUR = 2;

const rawDirOf = (env: Readonly<Record<string, string | undefined>>) => env.RWS_RAW_DIR || '/data/raw';

/** The shortest capture cadence per source: what "fresh" means for its fetches. */
function cadences(): Map<string, number> {
  const out = new Map<string, number>();
  for (const spec of loadRegistry().specs) {
    const known = out.get(spec.source);
    if (spec.cadence_s === null || spec.cadence_s <= 0) continue;
    if (known === undefined || spec.cadence_s < known) out.set(spec.source, spec.cadence_s);
  }
  return out;
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
  const cadenceS = cadences();
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
  let nightlyDay = '';
  let caughtUp = false;
  while (!stopped) {
    const now = new Date();
    try {
      const { lines, loaded } = await loader.tick();
      if (lines > 0) logger.info({ lines, loaded }, 'manifest lines consumed');
      const backlog = await loader.backlog();
      // Checksums once the first replay is complete, then nightly.
      if (!caughtUp && backlog.bytes === 0) {
        caughtUp = true;
        await storeChecksums(db, now);
        logger.info('caught up with the manifest: partition checksums stored');
      }
      if (now.getTime() - lastHealth >= HEALTH_MS) {
        await computeHealth(db, { cadenceS, lagP95Ms: lag.p95(now), backlog, badLines: loader.badLines, now });
        lastHealth = now.getTime();
      }
      const day = now.toISOString().slice(0, 10);
      if (day !== nightlyDay && now.getUTCHours() >= NIGHTLY_HOUR && backlog.bytes === 0) {
        nightlyDay = day;
        await sql`SELECT ensure_partitions(now(), now() + interval '3 months')`.execute(db);
        const { repaired } = await reconcileRollups(db, now);
        if (repaired > 0) logger.error({ alert: 'rollup_mismatch', repaired }, 'alert');
        await storeChecksums(db, now);
        const report = await prune(reader, await parsedOkKeys(db), { apply, now });
        logger.info(
          {
            applied: report.applied,
            candidates: report.candidates.length,
            deleted: report.deleted,
            refused: report.refused,
          },
          'retention pruner',
        );
      }
    } catch (err) {
      // Only a code: a driver message can quote SQL, a host or a path.
      logger.error(
        { code: errorCode(err), name: err instanceof Error ? err.name : 'unknown' },
        'load pass failed; retrying',
      );
    }
    if (stopped) break;
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
