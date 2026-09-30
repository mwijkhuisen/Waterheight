import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { registerHealth } from './api/health.ts';
import type { DB } from './db/generated.ts';

export type AppDeps = {
  /** The `rws_api` connection. Without it `/healthz` still answers and the health routes answer 503. */
  db?: Kysely<DB>;
  now?: () => Date;
  log?: Pick<Logger, 'error'>;
};

/**
 * The HTTP app of the `api` role. `/healthz` is a liveness probe only: it
 * reports no version, host or build data and asks no database (A§12.2). The
 * only other routes are the two public health documents (A§9.2); everything
 * else, `/api/` included, is a 404.
 */
export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  registerHealth(app, { db: deps.db, now: deps.now ?? (() => new Date()), log: deps.log });
  return app;
}
