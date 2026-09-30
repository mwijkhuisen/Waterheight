import { serve } from '@hono/node-server';
import { type Logger, pino } from 'pino';
import { createApp } from './app.ts';
import { Archive } from './archive/writer.ts';
import { budgets, schedule } from './capture/budget.ts';
import { captureEnv, captureUserAgent, EXIT_CONFIG, readSecret } from './capture/env.ts';
import { Pinger } from './capture/pings.ts';
import { Counters } from './capture/runner.ts';
import { startRecorder } from './capture/scheduler.ts';
import { seedRecords, startSeeds } from './capture/seeds.ts';
import { loadRegistry } from './capture/specs.ts';
import { removeStaleTmp, StateStore } from './capture/state.ts';
import { dbConfig, openDb } from './db/pool.ts';
import { healthy, startHeartbeat } from './heartbeat.ts';
import { Client } from './http/client.ts';
import { runMigrate } from './load/migrate.ts';
import { runLoad, runReplay } from './load/run.ts';
import { runWatchdog } from './watchdog/watchdog.ts';

/** Roles of the single server image (A§4); the command picks one. */
export const ROLES = ['capture', 'load', 'publish', 'api', 'replay', 'migrate', 'watchdog', 'healthcheck'] as const;
export type Role = (typeof ROLES)[number];

export const EXIT_NOT_IMPLEMENTED = 2;
export const EXIT_USAGE = 64;
export { EXIT_CONFIG };

const USAGE = `usage: main.js <${ROLES.join('|')}> (capture takes --dry-run; watchdog takes --once or --dry-run;
  replay takes --source <ID> [--spec <id>] --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--dry-run])`;
const RWS_HOST = 'ddapi20-waterwebservices.rijkswaterstaat.nl';
const RWS_LIMIT = 400;

export type Listen = { hostname: string; port: number };

/** HOST and PORT come from the environment; anything malformed is a usage error. */
export function parseListen(env: Readonly<Record<string, string | undefined>>): Listen | string {
  const hostname = env.HOST ?? '127.0.0.1';
  const rawPort = env.PORT ?? '8080';
  if (hostname === '') return 'HOST must not be empty';
  const port = /^[0-9]{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) return `PORT must be an integer from 1 to 65535, got ${JSON.stringify(rawPort)}`;
  return { hostname, port };
}

/** Loads and checks every spec and prints the schedule and budgets: no network, no writes. */
export function dryRun(log: (line: string) => void): number {
  const registry = loadRegistry();
  log(schedule(registry));
  const rws = budgets(registry).find((b) => b.host === RWS_HOST)?.peakPerHour ?? 0;
  log('');
  log(`${registry.specs.length} specs loaded; RWS requests/hour (busiest 60 min): ${rws} (limit ${RWS_LIMIT})`);
  return rws <= RWS_LIMIT ? 0 : 1;
}

/** An error name or code if it is a plain identifier; never a message, which may carry a URL with a key. */
const tag = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : 'other');

/**
 * Keeps the capture role alive after an unexpected error (T-CAP-8). One
 * process records every provider, so an exit would lose every run in flight
 * and could crash-loop. Only fixed fields are logged.
 */
export function keepAlive(log: Pick<Logger, 'error'>): void {
  for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
    process.on(event, (err: unknown) => {
      const e = err as { name?: unknown; code?: unknown } | null | undefined;
      log.error({ event, name: tag(e?.name), code: tag(e?.code) }, 'unexpected error: capture continues');
    });
  }
}

async function capture(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<number> {
  const cfg = captureEnv(env);
  if (typeof cfg === 'string') {
    log(`capture: ${cfg}`);
    return EXIT_CONFIG;
  }
  process.umask(0o027);
  const registry = loadRegistry();
  const logger = pino({ base: { role: 'capture' } });
  const userAgent = captureUserAgent(cfg);
  const sourceHeaders = new Map<string, Record<string, string>>();
  for (const [source, headers] of registry.secretHeaders) {
    const set: Record<string, string> = {};
    for (const [header, secret] of Object.entries(headers)) {
      const value = readSecret(secret);
      if (value === undefined) logger.warn({ source, header }, 'secret file missing: header not sent');
      else set[header] = value;
    }
    sourceHeaders.set(source, set);
  }
  const client = new Client({ hosts: registry.hosts, userAgent, sourceHeaders });
  const state = new StateStore(cfg.rawDir);
  const deps = {
    client,
    archive: new Archive(cfg.rawDir),
    state,
    counters: Counters.from(await state.read('counters')),
    log: logger,
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
  const recovered = await deps.archive.recover(
    (source, spec) => {
      const s = registry.specs.find((x) => x.source === source && x.id === spec);
      return s && { retention: s.retention, version: s.version };
    },
    new Date(),
    (key) => logger.warn({ key }, 'unreadable archive object skipped by the recovery'),
  );
  if (recovered > 0) logger.warn({ recovered }, 'archive objects without a manifest line recorded');
  const paths = { rawDir: cfg.rawDir, statusDir: cfg.statusDir, ownerStatusDir: cfg.ownerStatusDir };
  // Tmp files of writes a crash cut short; in the served status dir only our own.
  await removeStaleTmp(cfg.statusDir, /^capture\.json\.\d+\.tmp$/);
  for (const dir of [
    cfg.ownerStatusDir,
    `${cfg.ownerStatusDir}/reports`,
    state.dir,
    `${state.dir}/seeds`,
    `${cfg.rawDir}/_reports`,
  ])
    await removeStaleTmp(dir);
  let seeds = await seedRecords(registry, deps);
  const stopHeartbeat = startHeartbeat();
  const recorder = await startRecorder({
    ...deps,
    registry,
    paths,
    pinger: new Pinger(() => readSecret('hc_ping_key'), userAgent, logger),
    seeds: () => seeds,
  });
  await recorder.writeStatusNow();
  logger.info({ specs: registry.specs.length }, 'capture started');
  // From here on an unexpected error must not end the recorder; a start-up failure above still exits non-zero.
  keepAlive(logger);
  const harvest = startSeeds(registry, deps, paths, async () => {
    seeds = await seedRecords(registry, deps);
  });
  return new Promise((resolve) => {
    const stop = () => {
      logger.info('capture stopping');
      harvest.stop();
      void recorder
        .stop()
        .then(() => Promise.race([harvest.current(), new Promise((r) => setTimeout(r, 1000))]))
        .then(() => {
          stopHeartbeat();
          resolve(0);
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * The api role: `/healthz` and the two health routes. It logs in as `rws_api`
 * with a pool of 4; without database settings it still starts (`/healthz` must
 * answer, and the health routes answer 503).
 */
function api(env: Readonly<Record<string, string | undefined>>, listen: Listen, log: (line: string) => void) {
  const logger = pino({ base: { role: 'api' } });
  const cfg = dbConfig(env, 'rws_api');
  if (typeof cfg === 'string') log(`api: no database (${cfg}): the health routes answer 503`);
  const pool =
    typeof cfg === 'string'
      ? undefined
      : openDb(cfg, { max: 4, onError: (code) => logger.error({ code }, 'pool error') });
  return new Promise<number>((resolve) => {
    const stopHeartbeat = startHeartbeat();
    const app = createApp({ log: logger, ...(pool === undefined ? {} : { db: pool.db }) });
    const server = serve({ fetch: app.fetch, ...listen }, (info) => {
      log(`api listening on ${info.address}:${info.port}`);
    });
    const stop = () =>
      server.close(() => {
        stopHeartbeat();
        const done = () => resolve(0);
        if (pool === undefined) done();
        else void pool.close().then(done, done);
      });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * Resolves with an exit code; `api`, `capture`, `load` and `watchdog` keep
 * running until SIGINT or SIGTERM; `migrate` and `replay` are one-shot.
 * `publish` is a stub until its phase (P9).
 */
export function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const [role, ...rest] = argv;
  const flag = rest.length === 1 ? rest[0] : undefined;
  const dry = (role === 'capture' || role === 'watchdog') && flag === '--dry-run';
  const once = role === 'watchdog' && flag === '--once';
  const takesArgs = dry || once || role === 'replay';
  if (role === undefined || (rest.length > 0 && !takesArgs) || !(ROLES as readonly string[]).includes(role)) {
    log(USAGE);
    return Promise.resolve(EXIT_USAGE);
  }
  if (role === 'healthcheck') return Promise.resolve(healthy() ? 0 : 1);
  if (role === 'migrate') return runMigrate(env, log);
  if (role === 'load') return runLoad(env, log);
  if (role === 'replay') return runReplay(rest, env, log);
  if (role === 'watchdog') return runWatchdog(env, dry ? 'dry-run' : once ? 'once' : 'loop', log);
  if (role === 'capture') {
    if (dry) {
      try {
        return Promise.resolve(dryRun((line) => console.log(line)));
      } catch (err) {
        log(String(err instanceof Error ? err.message : err));
        return Promise.resolve(EXIT_CONFIG);
      }
    }
    return capture(env, log);
  }
  if (role !== 'api') {
    log(`role ${role} is not implemented yet`);
    return Promise.resolve(EXIT_NOT_IMPLEMENTED);
  }
  const listen = parseListen(env);
  if (typeof listen === 'string') {
    log(listen);
    return Promise.resolve(EXIT_USAGE);
  }
  return api(env, listen, log);
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
