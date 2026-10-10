import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { registerHealth } from './api/health.ts';
import type { Limiter } from './api/limiter.ts';
import { registerApi } from './api/routes.ts';
import { DEFAULT_PERMITS, Semaphore } from './api/semaphore.ts';
import { StaticCache } from './api/states.ts';
import type { DayVersions } from './api/versions.ts';
import type { DisplayWindow } from './api/window.ts';
import type { ChannelAudience } from './db/audience.ts';
import type { DB } from './db/generated.ts';
import { vigicruesSections } from './load/tables.ts';

/** How long the classification's registry and reference rows are kept per family (P7b). */
const STATIC_TTL_MS = 60_000;

export type AppDeps = {
  /** The family this app serves (P9b): `public` (the `api` role) unless the owner api passes `owner`. */
  family?: ChannelAudience;
  /** The family's connection. Without it `/healthz` still answers and the other routes answer 503. */
  db?: Kysely<DB>;
  /** Tests only: production never passes a clock, and no request, header or variable sets one. */
  now?: () => Date;
  log?: Pick<Logger, 'error'>;
  /** The beacon's info log (P9b); none: reports are read and dropped. */
  beaconLog?: Pick<Logger, 'info'>;
  /** The git commit of the image (`RWS_BUILD`), or `dev`. */
  build?: string;
  /** The display window (D9), loaded before the server listens. */
  window?: DisplayWindow;
  /** The family's settled-day versions (P9b), loaded before the server listens; none: nothing is immutable. */
  versions?: DayVersions;
  /** The FR-5 station → section map; read from the registry when the app is made, so a bad file fails the boot. */
  sections?: ReadonlyMap<string, string>;
  /** The DB-concurrency semaphore (P9b); by default 16 permits public, 2 owner. */
  semaphore?: Semaphore;
  /**
   * The per-client token buckets (P9b). Off unless passed: the role passes one (main.ts), tests of the limits pass
   * their own, and every other caller keeps its fixed clock and no client header (C1).
   */
  limiter?: Limiter;
  /** The brownout flag (P12a), public family only; default: the process flag of RWS_BROWNOUT_DIR. Tests flip it. */
  brownout?: () => boolean;
};

/**
 * The HTTP app of the `api` role (and, P9b, of `api --audience owner`). `/healthz` is a liveness probe only: it
 * reports no version, host or build data and asks no database (A§12.2). Under `/api/v1` are the data routes, the
 * OpenAPI document, the beacon and the two health documents (A§9.2), GET and HEAD only (POST on the beacon);
 * everything else is a 404.
 */
export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const family = deps.family ?? 'public';
  const now = deps.now ?? (() => new Date());
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  const sections = deps.sections ?? vigicruesSections();
  const cache = new StaticCache(STATIC_TTL_MS, () => now().getTime());
  const semaphore = deps.semaphore ?? new Semaphore({ permits: DEFAULT_PERMITS[family] });
  registerApi(app, {
    family,
    db: deps.db,
    now,
    log: deps.log,
    beaconLog: deps.beaconLog,
    build: deps.build ?? 'dev',
    window: deps.window,
    versions: deps.versions,
    sections,
    cache,
    semaphore,
    limiter: deps.limiter,
    ...(deps.brownout === undefined ? {} : { brownout: deps.brownout }),
  });
  registerHealth(app, { family, db: deps.db, now, log: deps.log, sections, cache, semaphore });
  return app;
}
