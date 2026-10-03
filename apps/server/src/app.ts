import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { registerHealth } from './api/health.ts';
import { registerApi } from './api/routes.ts';
import { StaticCache } from './api/states.ts';
import type { DisplayWindow } from './api/window.ts';
import type { DB } from './db/generated.ts';
import { vigicruesSections } from './load/tables.ts';

/** How long the classification's registry and reference rows are kept per family (P7b). */
const STATIC_TTL_MS = 60_000;

export type AppDeps = {
  /** The `rws_api` connection. Without it `/healthz` still answers and the other routes answer 503. */
  db?: Kysely<DB>;
  /** Tests only: production never passes a clock, and no request, header or variable sets one. */
  now?: () => Date;
  log?: Pick<Logger, 'error'>;
  /** The git commit of the image (`RWS_BUILD`), or `dev`. */
  build?: string;
  /** The display window (D9), loaded before the server listens. */
  window?: DisplayWindow;
  /** The FR-5 station → section map; read from the registry when the app is made, so a bad file fails the boot. */
  sections?: ReadonlyMap<string, string>;
};

/**
 * The HTTP app of the `api` role. `/healthz` is a liveness probe only: it
 * reports no version, host or build data and asks no database (A§12.2). Under
 * `/api/v1` are the public data routes, the OpenAPI document and the two health
 * documents (A§9.2), GET and HEAD only; everything else is a 404.
 */
export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  const sections = deps.sections ?? vigicruesSections();
  const cache = new StaticCache(STATIC_TTL_MS, () => now().getTime());
  registerApi(app, {
    db: deps.db,
    now,
    log: deps.log,
    build: deps.build ?? 'dev',
    window: deps.window,
    sections,
    cache,
  });
  registerHealth(app, { db: deps.db, now, log: deps.log, sections, cache });
  return app;
}
