import {
  type ApiErrorCode,
  FramesAnswer,
  floorBucket,
  isSettled,
  MetaAnswer,
  openApiDocument,
  SeriesAnswer,
  SeriesForecastAnswer,
  SnapshotAnswer,
  StationsAnswer,
} from '@rws/contracts';
import {
  OwnerFramesAnswer,
  OwnerMetaAnswer,
  OwnerSeriesAnswer,
  OwnerSeriesForecastAnswer,
  OwnerSnapshotAnswer,
  OwnerStationsAnswer,
  ownerOpenApiDocument,
} from '@rws/contracts/api-owner';
import type { Context, Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { ChannelAudience } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import { attributionOf, type BodyKind, bodySources, historyCapMs } from './answer.ts';
import { registerBeacon } from './beacon.ts';
import { rateClass } from './channels.ts';
import { readFrames, readMeta, readSeries, readSnapshot, readStations } from './data.ts';
import { readFutureSnapshot, readSeriesForecast } from './forecast-at.ts';
import { clientKey, type Limiter } from './limiter.ts';
import { Busy, type Encoding, Lru, negotiate } from './lru.ts';
import {
  agePolicy,
  type CachePolicy,
  framesParams,
  noQuery,
  QUERY_MAX_BYTES,
  Refused,
  seriesForecastParams,
  seriesParams,
  snapshotParams,
  versionParam,
} from './params.ts';
import { Saturated, type Semaphore } from './semaphore.ts';
import { HourMemo, type Static, type StaticCache } from './states.ts';
import { coded, validated } from './util.ts';
import { type DayVersions, IMMUTABLE, isImmutable, readVersionTag, spannedDays, versionTag } from './versions.ts';
import type { DisplayWindow, Window } from './window.ts';

// The data routes of an api process (A§9.2, A§9.3; PHASES P4a, P8b, P9b): /api/v1/meta, /stations, /snapshot,
// /series/{id}, /series/{id}/forecast, /frames, /openapi.json and /beacon, plus the rules of the whole /api/v1 tree. One
// process serves one family, fixed at start (`api` public, `api --audience owner` the owner's): never request input.
// Every request runs one pipeline (P9b): the method rule; the per-client token buckets (before anything is parsed, so
// a flood of bad requests is limited too); a cap on the raw query string; strict validation, all in memory; a cache
// key from the normalised parameters only; the LRU and single flight, whose miss path takes a DB permit around the
// database work only; then the contract check of the answer with its `attribution`. Every refusal is the same fixed
// body `{"error": code, "attribution": []}` with no-store; nothing of the request is echoed.

export type ApiDeps = {
  /** The family this process serves; its views and its contracts follow from it. */
  family: ChannelAudience;
  /** The family's connection (`rws_api` or `rws_owner_api`); without it the data routes answer 503. */
  db: Kysely<DB> | undefined;
  now: () => Date;
  log: Pick<Logger, 'error'> | undefined;
  /** The beacon's log (info lines); separate so the error log's type stays narrow. */
  beaconLog: Pick<Logger, 'info'> | undefined;
  /** The git commit of the image, or `dev`. */
  build: string;
  /** The display window; until it is loaded the routes that need it answer 503. */
  window: DisplayWindow | undefined;
  /** The family's settled-day versions; without them nothing is immutable. */
  versions: DayVersions | undefined;
  /** The FR-5 station → section map (registry/vigicrues-sections.yaml), loaded at boot. */
  sections: ReadonlyMap<string, string>;
  /** The rows of the classification that change only with the registry or a reference, per family. */
  cache: StaticCache;
  /** The DB-concurrency semaphore of this process (health shares it). */
  semaphore: Semaphore;
  /** The per-client token buckets; off (undefined) unless the role passes one (tests keep a fixed clock, C1). */
  limiter: Limiter | undefined;
};

const NO_STORE = 'no-store';
/** Every owner answer, whatever `v` says (invariant 11), besides the owner site's own header. */
const OWNER_CACHE = 'private, no-store';
const RETRY_BUSY = '2';
const FIXED: Readonly<Record<'meta' | 'stations' | 'openapi' | 'forecast', CachePolicy>> = {
  meta: { header: 'public, max-age=60', ttlMs: 60_000 },
  stations: { header: 'public, max-age=300', ttlMs: 300_000 },
  openapi: { header: 'public, max-age=300', ttlMs: 300_000 },
  forecast: { header: 'public, max-age=300', ttlMs: 300_000 },
};
// The in-process cache: bounded by entries and bytes; at most 64 distinct keys computed at once, and the two fixed
// keys never refused (a flood of /series or /snapshot keys must not take /meta and /stations down).
const LRU_ENTRIES = 2048;
const LRU_BYTES = 64 * 1024 * 1024;
const LRU_INFLIGHT = 64;

const WIRE = {
  public: {
    meta: MetaAnswer,
    stations: StationsAnswer,
    snapshot: SnapshotAnswer,
    series: SeriesAnswer,
    forecast: SeriesForecastAnswer,
    frames: FramesAnswer,
  },
  owner: {
    meta: OwnerMetaAnswer,
    stations: OwnerStationsAnswer,
    snapshot: OwnerSnapshotAnswer,
    series: OwnerSeriesAnswer,
    forecast: OwnerSeriesForecastAnswer,
    frames: OwnerFramesAnswer,
  },
} as const satisfies Record<ChannelAudience, Record<Exclude<BodyKind, 'healthSources'>, z.ZodType>>;

/** The one error body: a fixed code and an empty attribution array. */
export function refuse(
  c: Context,
  status: 400 | 404 | 405 | 413 | 415 | 429 | 500 | 503,
  code: ApiErrorCode,
  extra: Record<string, string> = {},
): Response {
  return c.json({ error: code, attribution: [] }, status, { 'Cache-Control': NO_STORE, ...extra });
}

/** A failure inside a route: its own refusal, a 503 busy with Retry-After when saturated, else 503 unavailable. */
export function failure(c: Context, err: unknown): Response {
  if (err instanceof Refused) return refuse(c, err.status, err.code);
  if (err instanceof Busy || err instanceof Saturated) return refuse(c, 503, 'busy', { 'Retry-After': RETRY_BUSY });
  return refuse(c, 503, 'unavailable');
}

/** The series → source map of a family's static rows, built once per load. */
const sourceMaps = new WeakMap<Static, Map<number, string>>();
const seriesSourceOf = (st: Static) => {
  let m = sourceMaps.get(st);
  if (m === undefined) {
    m = new Map(st.series.map((s) => [s.id, s.source_id]));
    sourceMaps.set(st, m);
  }
  return (id: number) => m.get(id);
};

/** What one data request asks, decided without the database. */
type Plan = {
  key: string;
  policy: CachePolicy;
  kind: Exclude<BodyKind, 'healthSources'>;
  /** Dated by what the loader knows now (meta, stations, a snapshot or forecast at or after now's bucket). */
  live: boolean;
  /** The answer's own instant: the date of a source the body states no instant for. */
  at: number;
  /** The UTC days the answer spans and the request's `v` (versioned routes only). */
  days?: string[];
  v?: number | undefined;
  read: (db: Kysely<DB>) => Promise<unknown>;
};

/**
 * Registers the method rule, the limiter, the query cap, the data routes, the beacon, the 404 and the error handler.
 * Call it before the health routes, so the rules cover them too.
 */
export function registerApi(app: Hono, deps: ApiDeps): void {
  const family = deps.family;
  const lru = new Lru({
    maxEntries: LRU_ENTRIES,
    maxBytes: LRU_BYTES,
    maxInflight: LRU_INFLIGHT,
    reserved: ['meta', 'stations'],
    now: () => deps.now().getTime(),
  });
  const openapi = JSON.stringify(family === 'owner' ? ownerOpenApiDocument() : openApiDocument());

  // 1. The method rule: GET and HEAD everywhere (Hono answers HEAD through the GET route), POST only on the beacon.
  app.use('/api/v1/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/v1/beacon') {
      if (c.req.method !== 'POST') return refuse(c, 405, 'method_not_allowed', { Allow: 'POST' });
    } else if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      return refuse(c, 405, 'method_not_allowed', { Allow: 'GET, HEAD' });
    // 2. The per-client buckets, keyed only by the header Caddy sets from the TCP peer.
    const limiter = deps.limiter;
    if (limiter !== undefined) {
      const wait = limiter.take(clientKey(c.req.header('x-rws-client')), rateClass(c.req.method, path));
      if (wait > 0) return refuse(c, 429, 'rate_limited', { 'Retry-After': String(wait) });
    }
    // 3. The raw query string, before anything is parsed.
    if (Buffer.byteLength(new URL(c.req.url).search) > QUERY_MAX_BYTES) return refuse(c, 400, 'bad_parameter');
    await next();
  });

  /** The display window, or a 503 until it is loaded (no database is asked here). */
  const window = (): Window => {
    const w = deps.window?.current;
    if (w === undefined) throw coded('no_window');
    return w;
  };
  /** The versions part of a key: the in-memory version of each spanned day (a bump makes a new key). */
  const vstate = (days: readonly string[]) => versionTag(days, (d) => deps.versions?.versionOf(d) ?? 1);
  /** #112: the state codes of settled frames days, per app (readHourStates). */
  const hourMemo = new HourMemo();

  /**
   * One data route: `plan` validates the request without the database and names its cache key; then the cached
   * answer, or one computation shared by every caller of that key under one DB permit, or a fixed error. A failure is
   * logged once per computation, never per request.
   */
  const route = (path: string, name: string, plan: (c: Context) => Plan) =>
    app.get(path, async (c) => {
      try {
        const p = plan(c);
        // The in-memory versions the key was built from (the same instant as plan()).
        const keyVersions = p.days === undefined ? undefined : vstate(p.days);
        const db = deps.db;
        if (db === undefined) throw coded('no_database');
        const enc: Encoding = negotiate(c.req.header('accept-encoding'));
        const { body, tag, capUntil } = await lru.getEncoded(
          p.key,
          p.policy.ttlMs,
          () =>
            deps.semaphore.run(async () => {
              try {
                const data = await p.read(db);
                const st = await deps.cache.get(db, family);
                const now = deps.now().getTime();
                const attribution = attributionOf(st, bodySources(p.kind, data, seriesSourceOf(st)), {
                  live: p.live,
                  at: p.at,
                });
                const wire = { ...(data as object), attribution, ...(family === 'owner' ? { audience: 'owner' } : {}) };
                const json = JSON.stringify(validated(WIRE[family][p.kind] as z.ZodType, wire));
                const cap = historyCapMs(p.kind, data, st.history, now);
                // The versions of the spanned days as stored now (C6), read only where an immutable answer is possible:
                // versions loaded, no history cap, every spanned day settled.
                // ponytail: its own short query after the read, not the read's transaction (that is readStates'
                // own). A bump between the two makes the tag newer than the key's versions (the in-memory ones when
                // the key was built), and the answer is then not immutable (the check below), never wrongly so.
                const possible =
                  p.days !== undefined &&
                  deps.versions?.loaded === true &&
                  !Number.isFinite(cap) &&
                  p.days.every((d) => isSettled(d, now));
                const tag = possible ? await readVersionTag(db, family, p.days as string[]) : undefined;
                return { json, ...(tag === undefined ? {} : { tag }), ...(Number.isFinite(cap) ? { capMs: cap } : {}) };
              } catch (err) {
                // A fixed code only: a driver message can quote SQL, a host or a value.
                if (!(err instanceof Refused))
                  deps.log?.error({ code: errorCode(err), route: name }, 'api unavailable');
                throw err;
              }
            }),
          enc,
        );
        const now = deps.now().getTime();
        let cacheControl = p.policy.header;
        if (family === 'owner') cacheControl = OWNER_CACHE;
        else if (capUntil !== null) {
          const s = Math.floor((capUntil - now) / 1000);
          if (s <= 0) cacheControl = NO_STORE;
          else if (s < p.policy.ttlMs / 1000) cacheControl = `public, max-age=${s}`;
        } else if (
          p.days !== undefined &&
          // The tag (read after the data) must equal the versions the key was built from, and the current ones.
          tag === keyVersions &&
          isImmutable(p.v, p.days, deps.versions, tag, now)
        )
          cacheControl = IMMUTABLE;
        return c.body(new Uint8Array(body), 200, {
          'Content-Type': 'application/json',
          'Cache-Control': cacheControl,
          Vary: 'Accept-Encoding',
          ...(enc === 'identity' ? {} : { 'Content-Encoding': enc }),
        });
      } catch (err) {
        return failure(c, err);
      }
    });

  route('/api/v1/meta', 'meta', (c): Plan => {
    noQuery(c.req.url);
    const w = window();
    const now = deps.now();
    return {
      key: 'meta',
      policy: FIXED.meta,
      kind: 'meta',
      live: true,
      at: now.getTime(),
      read: async (db) => {
        const meta = await readMeta(db, family, w, deps.build, deps.now());
        // A horizon only for a source the family's source view holds (the registry's list may name more).
        const { sources } = await deps.cache.get(db, family);
        return { ...meta, forecastHorizons: meta.forecastHorizons.filter((h) => sources.has(h.source)) };
      },
    };
  });

  route('/api/v1/stations', 'stations', (c): Plan => {
    noQuery(c.req.url);
    return {
      key: 'stations',
      policy: FIXED.stations,
      kind: 'stations',
      live: true,
      at: deps.now().getTime(),
      read: (db) => readStations(db, family),
    };
  });

  route('/api/v1/snapshot', 'snapshot', (c): Plan => {
    const now = deps.now().getTime();
    const t = snapshotParams(c.req.url, now, window().displayStartMs);
    const opts = { now, sections: deps.sections, cache: deps.cache };
    const live = t >= floorBucket(now);
    // After now: forecasts only, as known at now's bucket (part of the key, so a cached answer never outlives it).
    if (t > now)
      return {
        key: `snapshot|${t}|${floorBucket(now)}`,
        policy: agePolicy(t, now),
        kind: 'snapshot',
        live,
        at: t,
        read: (db) => readFutureSnapshot(db, family, t, opts),
      };
    const days = spannedDays(t, t + 1);
    return {
      key: `snapshot|${t}|${vstate(days)}`,
      policy: agePolicy(t, now),
      kind: 'snapshot',
      live,
      at: t,
      days,
      v: versionParam(c.req.url),
      read: (db) => readSnapshot(db, family, t, opts),
    };
  });

  route('/api/v1/series/:id/forecast', 'forecast', (c): Plan => {
    const now = deps.now().getTime();
    const p = seriesForecastParams(c.req.param('id') ?? '', c.req.url, now, window().displayStartMs);
    return {
      key: `forecast|${p.id}|${p.asof}`,
      policy: FIXED.forecast,
      kind: 'forecast',
      live: p.asof >= floorBucket(now),
      at: p.asof,
      read: async (db) => {
        const answer = await readSeriesForecast(db, family, p.id, p.asof);
        // Unknown, inactive and api-channel-off answer the same; a 404 is never cached.
        if (answer === undefined) throw new Refused('not_found', 404);
        return answer;
      },
    };
  });

  route('/api/v1/series/:id', 'series', (c): Plan => {
    const now = deps.now().getTime();
    const p = seriesParams(c.req.param('id') ?? '', c.req.url, now, window().displayStartMs);
    const days = spannedDays(p.from, p.to);
    return {
      key: `series|${p.id}|${p.res}|${p.from}|${p.to}|${vstate(days)}`,
      policy: agePolicy(p.to, now),
      kind: 'series',
      live: false,
      at: p.to,
      days,
      v: versionParam(c.req.url),
      read: async (db) => {
        const series = await readSeries(db, family, p);
        // Unknown, inactive and api-channel-off answer the same; a 404 is never cached.
        if (series === undefined) throw new Refused('not_found', 404);
        return series;
      },
    };
  });

  // /frames (P11b): [from, to) of whole hours, at most 14 days; the key holds the in-memory version of each spanned day
  // (like /series), so `v` makes the answer immutable only when it equals them all and every day is settled.
  route('/api/v1/frames', 'frames', (c): Plan => {
    const now = deps.now().getTime();
    const p = framesParams(c.req.url, now, window().displayStartMs);
    const days = spannedDays(p.from, p.to);
    return {
      key: `frames|${p.from}|${p.to}|${vstate(days)}`,
      policy: agePolicy(p.to, now),
      kind: 'frames',
      live: false,
      at: p.to,
      days,
      v: versionParam(c.req.url),
      read: (db) =>
        readFrames(db, family, p, {
          now,
          sections: deps.sections,
          cache: deps.cache,
          // The settled days' state codes are kept per day version (#112); without loaded versions nothing is kept.
          ...(deps.versions?.loaded === true
            ? { memo: hourMemo, versionOf: (d: string) => deps.versions?.versionOf(d) ?? 1 }
            : {}),
          yieldEvery: 200,
        }),
    };
  });

  app.get('/api/v1/openapi.json', (c) => {
    try {
      noQuery(c.req.url);
    } catch (err) {
      return failure(c, err);
    }
    return c.body(openapi, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': family === 'owner' ? OWNER_CACHE : FIXED.openapi.header,
    });
  });

  registerBeacon(app, { log: deps.beaconLog });

  app.notFound((c) => refuse(c, 404, 'not_found'));
  app.onError((err, c) => {
    deps.log?.error({ code: errorCode(err) }, 'unexpected error');
    return refuse(c, 500, 'internal');
  });
}
