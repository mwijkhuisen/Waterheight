import { resolve } from 'node:path';
import { pino } from 'pino';
import { captureEnv, captureUserAgent } from '../capture/env.ts';
import type { Resolver } from '../http/addresses.ts';
import { undiciTransport } from '../http/client.ts';
import type { Transport } from '../http/types.ts';
import { isCalendarDate } from './builds.ts';
import { BasemapError, EXIT_CONFIG, EXIT_FAILURE, EXIT_USAGE, type Log } from './errors.ts';
import { type DiskStat, runFetch } from './fetch.ts';
import { runPromote } from './promote.ts';
import { DEFAULT_REGISTRY, loadBasemap } from './registry.ts';
import { runRollback } from './rollback.ts';

// The one-shot `basemap` role (P3, ADR-0016): `basemap <fetch|promote|rollback>
// [--build YYYYMMDD] [--dry-run]`. Exit 0 done or nothing to do, 1 failure, 64
// usage, 78 configuration. `fetch` is the only command with network access; the
// promote and rollback containers have none.
//   RWS_BASEMAP_REGISTRY  registry file (default: registry/basemap.yaml of the image)
//   RWS_TILES_DIR         the served directory (default /tiles); staging for promote is <it>/.staging
//   RWS_STAGING_DIR       fetch only: where it writes (default /staging)
//   RWS_PMTILES_BIN       go-pmtiles (default /app/bin/pmtiles)
//   RWS_DOMAIN, RWS_CONTACT_EMAIL   fetch only: the User-Agent

export const COMMANDS = ['fetch', 'promote', 'rollback'] as const;
export const USAGE = `usage: main.js basemap <${COMMANDS.join('|')}> [--build <YYYYMMDD> (fetch only)] [--dry-run]`;

export type Command = { cmd: (typeof COMMANDS)[number]; build?: string; dryRun: boolean };

/** Strict: a known command, each flag at most once, `--build` only for fetch and only a real date. */
export function parseArgs(argv: readonly string[]): Command | null {
  const [cmd, ...rest] = argv;
  if (cmd !== 'fetch' && cmd !== 'promote' && cmd !== 'rollback') return null;
  let build: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dry-run' && !dryRun) dryRun = true;
    else if (arg === '--build' && cmd === 'fetch' && build === undefined) {
      const value = rest[i + 1];
      if (value === undefined || !isCalendarDate(value)) return null;
      build = value;
      i += 1;
    } else return null;
  }
  return { cmd, dryRun, ...(build === undefined ? {} : { build }) };
}

/** Test seams: production leaves all of them out. */
export type Overrides = {
  log?: Log;
  out?: (line: string) => void;
  transport?: Transport;
  resolver?: Resolver;
  now?: () => Date;
  statfs?: (dir: string) => Promise<DiskStat>;
  signal?: AbortSignal;
};

/** An error name or code if it is a plain identifier; never a message. */
const tag = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : 'other');

function pinoLog(): Log {
  const logger = pino({ base: { role: 'basemap' } });
  return (level, code, fields = {}) => logger[level](fields, code);
}

export async function runBasemap(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  test: Overrides = {},
): Promise<number> {
  const command = parseArgs(argv);
  if (command === null) {
    log(USAGE);
    return EXIT_USAGE;
  }
  const lg = test.log ?? pinoLog();
  try {
    await dispatch(command, env, lg, test);
    return 0;
  } catch (err) {
    if (err instanceof BasemapError) {
      lg('error', err.code);
      return err.exit;
    }
    const e = err as { name?: unknown; code?: unknown } | null | undefined;
    lg('error', 'unexpected', { name: tag(e?.name), error_code: tag(e?.code) });
    return EXIT_FAILURE;
  }
}

async function dispatch(c: Command, env: Readonly<Record<string, string | undefined>>, lg: Log, t: Overrides) {
  const tilesDir = resolve(env.RWS_TILES_DIR || '/tiles');
  const pmtiles = env.RWS_PMTILES_BIN || '/app/bin/pmtiles';
  const out = t.out ?? ((line: string) => console.log(line));
  const registry = env.RWS_BASEMAP_REGISTRY || DEFAULT_REGISTRY;

  if (c.cmd === 'rollback') {
    // The emergency path needs no registry: it only swaps what the manifest names.
    await runRollback({ tilesDir, log: lg, out }, { dryRun: c.dryRun });
    return;
  }
  const basemap = loadBasemap(registry);
  if (c.cmd === 'promote') {
    await runPromote({ basemap, tilesDir, pmtiles, env, log: lg, out }, { dryRun: c.dryRun });
    return;
  }

  // fetch: no request goes out without a contact User-Agent (the A2 switch).
  const contact = captureEnv(env);
  if (typeof contact === 'string') {
    lg('error', 'env_contact', { detail: contact });
    throw new BasemapError('env_contact', EXIT_CONFIG);
  }
  const { transport, agent } =
    t.transport === undefined
      ? undiciTransport(new Set(basemap.protomaps.hosts))
      : { transport: t.transport, agent: undefined };
  // A stop signal ends go-pmtiles and the run cleans up after itself.
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await runFetch(
      {
        basemap,
        tilesDir,
        stagingDir: resolve(env.RWS_STAGING_DIR || '/staging'),
        pmtiles,
        env,
        userAgent: captureUserAgent(contact),
        transport,
        ...(t.resolver === undefined ? {} : { resolver: t.resolver }),
        log: lg,
        out,
        now: t.now ?? (() => new Date()),
        signal: t.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, t.signal]),
        ...(t.statfs === undefined ? {} : { statfs: t.statfs }),
      },
      { dryRun: c.dryRun, ...(c.build === undefined ? {} : { build: c.build }) },
    );
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await agent?.close().catch(() => {});
  }
}
