import type { Kysely } from 'kysely';
import { pino } from 'pino';
import { StaticCache } from '../api/states.ts';
import { DisplayWindow } from '../api/window.ts';
import { type ChannelAudience, DB_ROLE } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { dbConfig, errorCode, openDb } from '../db/pool.ts';
import { startHeartbeat } from '../heartbeat.ts';
import { vigicruesSections } from '../load/tables.ts';
import { type CycleDeps, Publisher, type Renderers } from './cycle.ts';
import { RENDERERS } from './render/index.ts';
import { RIVERS_DIR_DEFAULT } from './rivers.ts';
import { Output } from './write.ts';

// The `publish` role (A§9.1, P9a): `publish [--audience public|owner] [--once]`. The public publisher logs in as
// rws_publish (pool 3), the owner one as rws_owner_api (pool 2, leaving 2 of its 4 for P9b's api-owner; §9 C20).

export const CYCLE_MS = 60_000;
const BUDGET_MS = 35_000;
/** How long the classification's registry and reference rows are kept (as the api's). */
const STATIC_TTL_MS = 60_000;
const POOL: Record<ChannelAudience, number> = { public: 3, owner: 2 };

type Base = Omit<CycleDeps, 'out' | 'window' | 'cache' | 'budgetMs' | 'settledPerCycle' | 'strict'> & { dir: string };

function publisher(b: Base, mode: { budgetMs: number; settledPerCycle: number; strict: boolean }): Publisher {
  return new Publisher({
    ...b,
    ...mode,
    out: new Output(b.dir),
    window: new DisplayWindow(b.db, b.log, b.family),
    cache: new StaticCache(STATIC_TTL_MS, b.now),
  });
}

/**
 * One complete cycle with a fixed clock and no budget: every recent bucket, every station and every pending settled
 * day (or the newest `settledDays` of them; the rest stay 0 in meta, read from the API). Any failing step throws. The
 * library entry of the tests and the e2e stand-in; production has no clock flag.
 */
export async function publishOnce(
  db: Kysely<DB>,
  family: ChannelAudience,
  dir: string,
  opts: {
    now: number;
    render?: Renderers;
    inputs?: string;
    build?: string;
    settledDays?: number;
    /** The owner family's read-only rivers directory (production /srv/rivers); unset: no owner reaches step. */
    riversDir?: string;
    rivernet?: CycleDeps['rivernet'];
  },
): Promise<void> {
  const base: Base = {
    db,
    family,
    dir,
    render: opts.render ?? RENDERERS,
    now: () => opts.now,
    build: opts.build ?? 'dev',
    sections: vigicruesSections(),
    inputs: opts.inputs,
    riversDir: opts.riversDir,
    rivernet: opts.rivernet,
    log: { error: () => undefined },
  };
  await publisher(base, {
    budgetMs: Number.POSITIVE_INFINITY,
    settledPerCycle: opts.settledDays ?? Number.POSITIVE_INFINITY,
    strict: true,
  }).cycle();
}

export async function runPublisher(
  env: Readonly<Record<string, string | undefined>>,
  family: ChannelAudience,
  once: boolean,
  log: (line: string) => void,
): Promise<number> {
  const name = family === 'public' ? 'publish' : 'publish-owner';
  const cfg = dbConfig(env, DB_ROLE[family].publish);
  if (typeof cfg === 'string') {
    log(`${name}: ${cfg}`);
    return 78;
  }
  const logger = pino({ base: { role: name } });
  const { db, close } = openDb(cfg, {
    max: POOL[family],
    onError: (code) => logger.error({ code }, 'database connection error'),
  });
  const p = publisher(
    {
      db,
      family,
      dir: env.RWS_PUBLISH_DIR || '/srv/www',
      render: RENDERERS,
      now: Date.now,
      build: /^[0-9a-f]{40}$/.test(env.RWS_BUILD ?? '') ? (env.RWS_BUILD as string) : 'dev',
      sections: vigicruesSections(),
      inputs: family === 'public' ? env.RWS_OPS_DIR || '/srv/ops' : env.RWS_CAPTURE_DIR || '/srv/capture',
      // Only the owner publisher mounts the rivers directory (compose.yaml, read-only); the public one never reads it.
      riversDir: family === 'owner' ? env.RWS_RIVERS_DIR || RIVERS_DIR_DEFAULT : undefined,
      log: logger,
    },
    { budgetMs: BUDGET_MS, settledPerCycle: 1, strict: false },
  );
  // ponytail: the heartbeat shows the process is alive, not that cycles succeed; status.json's cycleAt and the
  // [agent-prod] static checks show that.
  const stopHeartbeat = startHeartbeat();
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  logger.info({ family }, 'publisher started');
  let code = 0;
  while (!stopped) {
    const started = Date.now();
    try {
      await p.cycle();
    } catch (err) {
      logger.error({ code: errorCode(err) }, 'publish cycle failed');
      if (once) code = 1;
    }
    if (once) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, Math.max(0, CYCLE_MS - (Date.now() - started)));
    });
  }
  stopHeartbeat();
  await close();
  return code;
}
