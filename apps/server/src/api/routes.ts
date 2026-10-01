import { type ApiErrorCode, Meta, openApiDocument, Series, Snapshot, Stations } from '@rws/contracts';
import type { Context, Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import { readMeta, readSeries, readSnapshot, readStations } from './data.ts';
import { Busy, Lru } from './lru.ts';
import { agePolicy, type CachePolicy, noQuery, Refused, seriesParams, snapshotParams } from './params.ts';
import { coded, validated } from './util.ts';
import type { DisplayWindow, Window } from './window.ts';

// The public data routes of the api role (A§9.2; PHASES P4a): /api/v1/meta,
// /stations, /snapshot, /series/{id} and /openapi.json, plus the rules of the
// whole /api/v1 tree: GET and HEAD only, no CORS headers, fixed error bodies
// with no-store. A request is validated completely before anything asks the
// database; an answer is checked against its contract before it is cached or
// sent. Rate limits and the DB semaphore are P9b.

export type ApiDeps = {
  /** The `rws_api` connection; without it the data routes answer 503. */
  db: Kysely<DB> | undefined;
  now: () => Date;
  log: Pick<Logger, 'error'> | undefined;
  /** The git commit of the image, or `dev`. */
  build: string;
  /** The display window; until it is loaded the routes that need it answer 503. */
  window: DisplayWindow | undefined;
};

const NO_STORE = { 'Cache-Control': 'no-store' };
const FIXED: Readonly<Record<'meta' | 'stations' | 'openapi', CachePolicy>> = {
  meta: { header: 'public, max-age=60', ttlMs: 60_000 },
  stations: { header: 'public, max-age=300', ttlMs: 300_000 },
  openapi: { header: 'public, max-age=300', ttlMs: 300_000 },
};
// The in-process cache: bounded by entries and bytes; at most 64 distinct keys computed at once.
const LRU_ENTRIES = 2048;
const LRU_BYTES = 64 * 1024 * 1024;
const LRU_INFLIGHT = 64;

const refuse = (
  c: Context,
  status: 400 | 404 | 405 | 500 | 503,
  code: ApiErrorCode,
  extra: Record<string, string> = {},
) => c.json({ error: code }, status, { ...NO_STORE, ...extra });

/**
 * Registers the method rule, the data routes, the 404 and the error handler.
 * Call it before the health routes, so the method rule covers them too.
 */
export function registerApi(app: Hono, deps: ApiDeps): void {
  const lru = new Lru({
    maxEntries: LRU_ENTRIES,
    maxBytes: LRU_BYTES,
    maxInflight: LRU_INFLIGHT,
    now: () => deps.now().getTime(),
  });
  const openapi = JSON.stringify(openApiDocument());

  // Hono answers HEAD through the GET route and drops the body.
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      return refuse(c, 405, 'method_not_allowed', { Allow: 'GET, HEAD' });
    await next();
  });

  /** The display window, or a 503 until it is loaded (no database is asked here). */
  const window = (): Window => {
    const w = deps.window?.current;
    if (w === undefined) throw coded('no_window');
    return w;
  };

  /**
   * One data route: `plan` validates the request without the database and
   * names its cache key; then the cached answer, or one computation shared by
   * every caller of that key, or a fixed error. A failure is logged once per
   * computation, never per request.
   */
  const route = <T>(
    path: string,
    name: string,
    schema: z.ZodType<T>,
    plan: (c: Context) => { key: string; policy: CachePolicy; read: (db: Kysely<DB>) => Promise<T> },
  ) =>
    app.get(path, async (c) => {
      try {
        const { key, policy, read } = plan(c);
        const db = deps.db;
        if (db === undefined) throw coded('no_database');
        const body = await lru.get(key, policy.ttlMs, async () => {
          try {
            return JSON.stringify(validated(schema, await read(db)));
          } catch (err) {
            // A fixed code only: a driver message can quote SQL, a host or a value.
            if (!(err instanceof Refused)) deps.log?.error({ code: errorCode(err), route: name }, 'api unavailable');
            throw err;
          }
        });
        return c.body(body, 200, { 'Content-Type': 'application/json', 'Cache-Control': policy.header });
      } catch (err) {
        if (err instanceof Refused) return refuse(c, err.status, err.code);
        if (err instanceof Busy) return refuse(c, 503, 'busy', { 'Retry-After': '5' });
        return refuse(c, 503, 'unavailable');
      }
    });

  route('/api/v1/meta', 'meta', Meta, (c) => {
    noQuery(c.req.url);
    const w = window();
    return { key: 'meta', policy: FIXED.meta, read: (db) => readMeta(db, w, deps.build, deps.now()) };
  });

  route('/api/v1/stations', 'stations', Stations, (c) => {
    noQuery(c.req.url);
    return { key: 'stations', policy: FIXED.stations, read: readStations };
  });

  route('/api/v1/snapshot', 'snapshot', Snapshot, (c) => {
    const now = deps.now().getTime();
    const t = snapshotParams(c.req.url, now, window().displayStartMs);
    return { key: `snapshot|${t}`, policy: agePolicy(t, now), read: (db) => readSnapshot(db, t) };
  });

  route('/api/v1/series/:id', 'series', Series, (c) => {
    const now = deps.now().getTime();
    const p = seriesParams(c.req.param('id') ?? '', c.req.url, now, window().displayStartMs);
    return {
      key: `series|${p.id}|${p.res}|${p.from}|${p.to}`,
      policy: agePolicy(p.to, now),
      read: async (db) => {
        const series = await readSeries(db, p);
        // Unknown and api-channel-off answer the same; a 404 is never cached.
        if (series === undefined) throw new Refused('not_found', 404);
        return series;
      },
    };
  });

  app.get('/api/v1/openapi.json', (c) => {
    try {
      noQuery(c.req.url);
    } catch {
      return refuse(c, 400, 'unknown_parameter');
    }
    return c.body(openapi, 200, { 'Content-Type': 'application/json', 'Cache-Control': FIXED.openapi.header });
  });

  app.notFound((c) => refuse(c, 404, 'not_found'));
  app.onError((err, c) => {
    deps.log?.error({ code: errorCode(err) }, 'unexpected error');
    return refuse(c, 500, 'internal');
  });
}
