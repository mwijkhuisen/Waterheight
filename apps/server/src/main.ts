import { serve } from '@hono/node-server';
import { type Logger, pino } from 'pino';
import { Limiter } from './api/limiter.ts';
import { DEFAULT_PERMITS, permitsFrom, Semaphore } from './api/semaphore.ts';
import { DayVersions } from './api/versions.ts';
import { DisplayWindow } from './api/window.ts';
import { createApp } from './app.ts';
import { Archive } from './archive/writer.ts';
import { runBasemap } from './basemap/index.ts';
import { budgets, schedule } from './capture/budget.ts';
import { captureEnv, captureUserAgent, EXIT_CONFIG, readSecret } from './capture/env.ts';
import { Pinger } from './capture/pings.ts';
import { Counters } from './capture/runner.ts';
import { startRecorder } from './capture/scheduler.ts';
import { seedRecords, startSeeds } from './capture/seeds.ts';
import { loadRegistry } from './capture/specs.ts';
import { removeStaleTmp, StateStore } from './capture/state.ts';
import { type ChannelAudience, DB_ROLE } from './db/audience.ts';
import { type Db, dbConfig, openDb } from './db/pool.ts';
import { healthy, startHeartbeat } from './heartbeat.ts';
import { Client } from './http/client.ts';
import { runMigrate } from './load/migrate.ts';
import { runLoad, runReplay } from './load/run.ts';
import { runPublisher } from './publish/index.ts';
import { runWatchdog } from './watchdog/watchdog.ts';

/** Roles of the single server image (A§4); the command picks one. */
export const ROLES = [
  'capture',
  'load',
  'publish',
  'api',
  'replay',
  'migrate',
  'basemap',
  'watchdog',
  'healthcheck',
] as const;
export type Role = (typeof ROLES)[number];

export const EXIT_USAGE = 64;
export { EXIT_CONFIG };

const USAGE = `usage: main.js <${ROLES.join('|')}> (capture takes --dry-run; watchdog takes --once or --dry-run;
  api takes [--audience public|owner]; publish takes [--audience public|owner] [--once];
  replay takes --source <ID> [--spec <id>] --from <YYYY-MM-DD[THH:MM:SSZ]> --to <YYYY-MM-DD> [--dry-run];
  basemap takes <fetch|promote|rollback> [--build <YYYYMMDD>] [--dry-run])`;
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
 * The api roles' pools (A§9.2, A§9.3): `rws_api`'s CONNECTION LIMIT of 12 leaves room for a deploy's overlap;
 * `rws_owner_api` has 4, of which the owner publisher takes 2 (P9a), so the owner api takes the other 2.
 */
export const API_POOL = { public: 10, owner: 2 } as const satisfies Record<ChannelAudience, number>;
export const API_POOL_MAX = API_POOL.public;

/** An api role's database: its family's role (`rws_api`, `rws_owner_api`) with its pool, or an error text. */
export function openApiDb(
  env: Readonly<Record<string, string | undefined>>,
  onError?: (code: string) => void,
  family: ChannelAudience = 'public',
): Db | string {
  const cfg = dbConfig(env, DB_ROLE[family].api);
  return typeof cfg === 'string' ? cfg : openDb(cfg, { max: API_POOL[family], ...(onError ? { onError } : {}) });
}

/** The build id the image carries (`RWS_BUILD`, its git commit); anything else is `dev`. */
export function buildId(env: Readonly<Record<string, string | undefined>>): string {
  const build = env.RWS_BUILD ?? '';
  return /^[0-9a-f]{40}$/.test(build) ? build : 'dev';
}

/** `api [--audience public|owner]`, at most once; anything else is a usage error. */
export function apiArgs(rest: readonly string[]): { family: ChannelAudience } | undefined {
  if (rest.length === 0) return { family: 'public' };
  if (rest.length === 2 && rest[0] === '--audience' && (rest[1] === 'public' || rest[1] === 'owner'))
    return { family: rest[1] };
  return undefined;
}

/**
 * The api roles: `/healthz`, the data routes, the beacon and the two health routes of one family (P9b: `api` the
 * public one as `rws_api` with a pool of 10, `api --audience owner` the owner's as `rws_owner_api` with a pool of 2).
 * It loads the display window and the day versions before it listens; without database settings it still starts
 * (`/healthz` must answer, and the other routes answer 503). The per-client limiter is always on here.
 */
async function api(
  env: Readonly<Record<string, string | undefined>>,
  listen: Listen,
  log: (line: string) => void,
  family: ChannelAudience,
) {
  const permits = permitsFrom(env.RWS_API_DB_CONCURRENCY, DEFAULT_PERMITS[family]);
  if (permits === undefined) {
    log('RWS_API_DB_CONCURRENCY must be a whole number from 1 to 64');
    return EXIT_USAGE;
  }
  const logger = pino({ base: { role: family === 'owner' ? 'api-owner' : 'api' } });
  const db = openApiDb(env, (code) => logger.error({ code }, 'pool error'), family);
  if (typeof db === 'string') log(`api: no database (${db}): the data and health routes answer 503`);
  const pool = typeof db === 'string' ? undefined : db;
  const stopHeartbeat = startHeartbeat();
  // Loaded before the server listens, so validating a request never asks the database.
  const window = pool === undefined ? undefined : new DisplayWindow(pool.db, logger, family);
  const versions = pool === undefined ? undefined : new DayVersions(pool.db, family, logger);
  if (window !== undefined && versions !== undefined) {
    await window.refresh();
    window.start();
    await versions.refresh();
    versions.start();
  }
  // Fixed codes only: the limiter never logs an address (a collapsed peer is a deployment fault, C7).
  // The owner API's peer is always the owner's WireGuard address (a private one): its key is `unknown-gw` by design, so
  // only the public API reports one (review SEC-4).
  const limiter = new Limiter(
    family === 'public' ? { onGateway: () => logger.error({ code: 'limiter_gateway_key' }, 'limiter') } : {},
  );
  return new Promise<number>((resolve) => {
    const app = createApp({
      family,
      log: logger,
      beaconLog: logger,
      build: buildId(env),
      semaphore: new Semaphore({ permits }),
      limiter,
      ...(pool === undefined || window === undefined || versions === undefined
        ? {}
        : { db: pool.db, window, versions }),
    });
    // Behind Caddy's own read timeouts (10 s), a request that still trickles is cut here too (review SEC-2).
    const serverOptions = { requestTimeout: 30_000, headersTimeout: 10_000 };
    const server = serve({ fetch: app.fetch, ...listen, serverOptions }, (info) => {
      log(`api listening on ${info.address}:${info.port}`);
    });
    const stop = () =>
      server.close(() => {
        stopHeartbeat();
        window?.stop();
        versions?.stop();
        const done = () => resolve(0);
        if (pool === undefined) done();
        else void pool.close().then(done, done);
      });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** `publish [--audience public|owner] [--once]`, each flag at most once; anything else is a usage error. */
export function publishArgs(rest: readonly string[]): { family: 'public' | 'owner'; once: boolean } | undefined {
  let family: 'public' | 'owner' | undefined;
  let once = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--once' && !once) once = true;
    else if (arg === '--audience' && family === undefined && (rest[i + 1] === 'public' || rest[i + 1] === 'owner'))
      family = rest[++i] as 'public' | 'owner';
    else return undefined;
  }
  return { family: family ?? 'public', once };
}

/**
 * Resolves with an exit code; `api`, `capture`, `load`, `publish` and `watchdog`
 * keep running until SIGINT or SIGTERM; `migrate`, `replay` and `basemap` are
 * one-shot (and `publish --once`).
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
  const publish = role === 'publish' ? publishArgs(rest) : undefined;
  const apiFamily = role === 'api' ? apiArgs(rest) : undefined;
  const takesArgs =
    dry || once || publish !== undefined || apiFamily !== undefined || role === 'replay' || role === 'basemap';
  if (role === undefined || (rest.length > 0 && !takesArgs) || !(ROLES as readonly string[]).includes(role)) {
    log(USAGE);
    return Promise.resolve(EXIT_USAGE);
  }
  if (role === 'healthcheck') return Promise.resolve(healthy() ? 0 : 1);
  if (role === 'migrate') return runMigrate(env, log);
  if (role === 'load') return runLoad(env, log);
  if (role === 'replay') return runReplay(rest, env, log);
  if (role === 'basemap') return runBasemap(rest, env, log);
  if (role === 'watchdog') return runWatchdog(env, dry ? 'dry-run' : once ? 'once' : 'loop', log);
  if (publish !== undefined) return runPublisher(env, publish.family, publish.once, log);
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
  const listen = parseListen(env);
  if (typeof listen === 'string') {
    log(listen);
    return Promise.resolve(EXIT_USAGE);
  }
  return api(env, listen, log, apiFamily?.family ?? 'public');
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
