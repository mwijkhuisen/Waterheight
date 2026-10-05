import {
  type ClassCoverage,
  type ForecastCoverage,
  floorBucket,
  HEALTH_MAX_AGE_MS,
  Health,
  HealthAnswer,
  HealthSources,
  HealthSourcesAnswer,
  type HealthStatus,
  type HealthUnavailable,
  overallStatus,
} from '@rws/contracts';
import { OwnerHealthAnswer, OwnerHealthSourcesAnswer } from '@rws/contracts/api-owner';
import type { Hono } from 'hono';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  type ChannelAudience,
  type IngestBatchRow,
  type LoaderRow,
  type OwnerHealthRow,
  PUBLIC_ONLY_VIEWS,
  type SourceHealthRow,
  type TwinCheckRow,
  VIEWS,
} from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import { attributionOf, bodySources } from './answer.ts';
import { TtlCache } from './cache.ts';
import { forecastCoverage } from './forecast.ts';
import { refuse } from './routes.ts';
import { Saturated, type Semaphore } from './semaphore.ts';
import { classCoverage, readStates, type StaticCache } from './states.ts';
import { coded, iso, snapshot, validated } from './util.ts';

// GET /api/v1/health and GET /api/v1/health/sources (A§9.2, A§9.3). The loader
// precomputes everything (load/health.ts); this only reads it through the
// process's own view family: the public api shows public sources and the owner
// sources as two counts, the owner api (P9b) every source of its family. Nothing
// here is built from a request: the routes take no parameter, the queries are
// fixed, and the view names come from db/audience.ts.
//
// Under saturation (P9b, A§9.2): a health computation takes a DB permit only if
// one is free now. When none is, the route answers the last good body (at most
// 60 s old) with no-store and `X-Stale: 1`, else 503 busy with Retry-After, so
// the watchdog sees a stale but valid answer during a spike, never a false
// "down". A real database error stays the cached 503 (5 s).

const NO_STORE = { 'Cache-Control': 'no-store' };
const UNAVAILABLE: HealthUnavailable = { status: 'down', error: 'unavailable', attribution: [] };
/** How old the last good body may be when it is served stale under saturation. */
export const STALE_MS = 60_000;
/** How long a computed answer is served; also the response's max-age. */
export const CACHE_MS = 30_000;
/** After a database error the next attempt waits this long (the answer stays a 503 meanwhile). */
const ERROR_MS = 5_000;
// The bounds of the contract (packages/contracts/src/health.ts).
const MAX_SOURCES = 200;
const MAX_BATCHES = 50;
const MAX_TWINS = 100;

type Tx = Kysely<DB>;
type SourceRow = Pick<
  SourceHealthRow,
  | 'updated_at'
  | 'source_id'
  | 'last_fetch_ok'
  | 'last_new_data'
  | 'newest_ts'
  | 'consecutive_failures'
  | 'quarantine_count'
  | 'lag_p95_s'
  | 'status'
  | 'detail'
>;
type BatchRow = Pick<IngestBatchRow, 'id' | 'source_id' | 'spec_id' | 'fetched_at' | 'error'>;

// The row readers take a family: the routes read 'public'; the publishers' status files their own (P9a).
export const sourceRows = (tx: Tx, family: ChannelAudience) =>
  sql<SourceRow>`
    SELECT source_id, last_fetch_ok, last_new_data, newest_ts, consecutive_failures, quarantine_count, lag_p95_s,
           status, detail, updated_at
    FROM ${sql.table(VIEWS[family].sourceHealth)} ORDER BY source_id LIMIT ${MAX_SOURCES}`
    .execute(tx)
    .then((r) => r.rows);

// An aggregate view of the public family only: always one row; the fallback only satisfies the type.
export const ownerCounts = (tx: Tx) =>
  sql<OwnerHealthRow>`SELECT healthy, total FROM ${sql.table(PUBLIC_ONLY_VIEWS.ownerHealth)} LIMIT 1`
    .execute(tx)
    .then((r) => r.rows[0] ?? { healthy: 0, total: 0 });

/** Absent until the loader has computed once. The public family only (the owner role cannot read it). */
export const loaderRow = (tx: Tx) =>
  sql<LoaderRow>`
    SELECT computed_at, backlog_files, backlog_bytes, backlog_age_s, bad_manifest_lines
    FROM ${sql.table(PUBLIC_ONLY_VIEWS.loader)} LIMIT 1`
    .execute(tx)
    .then((r) => r.rows[0]);

/**
 * The newest loaded_at of the family's batches (P9a: meta.latestFrom, status loader.lastCommit, health
 * loader.last_commit). The range qual passes the security_barrier view into the ingest_batch_loaded index; an
 * unbounded max is a scan of every batch, run only when the last hour has none.
 */
export const lastCommit = (tx: Tx, family: ChannelAudience, now: Date) =>
  sql<{ at: Date | null }>`
    SELECT COALESCE(
      (SELECT max(loaded_at) FROM ${sql.table(VIEWS[family].ingestBatch)}
       WHERE loaded_at > ${now}::timestamptz - interval '1 hour'),
      (SELECT max(loaded_at) FROM ${sql.table(VIEWS[family].ingestBatch)})) AS at`
    .execute(tx)
    .then((r) => r.rows[0]?.at ?? null);

const quarantinedBatches = (tx: Tx, family: ChannelAudience) =>
  sql<BatchRow>`
    SELECT id, source_id, spec_id, fetched_at, error
    FROM ${sql.table(VIEWS[family].ingestBatch)}
    WHERE parse_status = 'quarantined' ORDER BY fetched_at DESC, id DESC LIMIT ${MAX_BATCHES}`
    .execute(tx)
    .then((r) => r.rows);

/** The latest check of each twin, with how many of its hourly checks of the last week there are and how many failed. */
// ponytail: more than MAX_TWINS twins would drop some; the registry has a handful (P2b).
export const latestTwinChecks = (tx: Tx, family: ChannelAudience, now: Date) =>
  sql<TwinCheckRow & { checks_7d: number; failed_7d: number }>`
    SELECT DISTINCT ON (twin_id) twin_id, window_end, n_aligned, median_delta, max_delta, lag_min, ok,
           (count(*) OVER week)::int AS checks_7d, (count(*) FILTER (WHERE NOT ok) OVER week)::int AS failed_7d
    FROM ${sql.table(VIEWS[family].twinCheck)}
    WHERE window_end > ${now}::timestamptz - interval '168 hours'
    WINDOW week AS (PARTITION BY twin_id)
    ORDER BY twin_id, window_end DESC LIMIT ${MAX_TWINS}`
    .execute(tx)
    .then((r) => r.rows);

/**
 * source_health.detail as the loader writes it. Read leniently and stripped
 * to the known keys: only these ever leave; the contract then checks the values.
 */
export const Detail = z.object({
  tier1: z.object({ total: z.number(), fresh: z.number(), provider_stale: z.number() }).optional(),
  missing_buckets_24h: z.number().optional(),
  outage: z.object({ from: z.string(), to: z.string(), missing_buckets: z.number() }).optional(),
  coverage: z
    .object({
      from: z.string(),
      ratio: z.number(),
      series: z.number(),
      series_below_95: z.number(),
      gaps: z.array(z.object({ from: z.string(), to: z.string() })),
    })
    .optional(),
  min_interval_s: z.array(z.object({ spec: z.string(), seconds: z.number() })).optional(),
  label_offset: z
    .object({
      day: z.string(),
      decided: z.boolean(),
      n_aligned: z.number(),
      share: z.number().nullable(),
      minutes: z.number().nullable(),
      decided_day: z.string().nullable(),
    })
    .optional(),
  forecast: z
    .object({
      issued_at: z.string(),
      run_age_s: z.number(),
      series: z.number(),
      current: z.number(),
      late: z.string().nullable(),
    })
    .optional(),
  partitions: z.record(z.string(), z.object({ md5: z.string(), rows: z.number() })).optional(),
  partitions_at: z.string().optional(),
});

export async function readHealth(db: Kysely<DB>, now: Date): Promise<Health> {
  const { rows, owner, l, twins, commit } = await snapshot(db, async (tx) => ({
    rows: await sourceRows(tx, 'public'),
    owner: await ownerCounts(tx),
    l: await loaderRow(tx),
    twins: await latestTwinChecks(tx, 'public', now),
    commit: await lastCommit(tx, 'public', now),
  }));
  const of = (status: SourceRow['status']) => rows.filter((r) => r.status === status).length;
  const lags = rows.flatMap((r) => (r.lag_p95_s === null ? [] : [r.lag_p95_s]));
  const body = {
    generated_at: iso(l?.computed_at ?? null),
    loader: {
      lag_p95_s: lags.length === 0 ? null : Math.max(...lags),
      backlog_files: l?.backlog_files ?? 0,
      // bigint arrives as a string; a value beyond 2^53 fails the contract.
      backlog_bytes: Number(l?.backlog_bytes ?? 0),
      backlog_age_s: l?.backlog_age_s ?? null,
      bad_manifest_lines: l?.bad_manifest_lines ?? 0,
      last_commit: iso(commit),
    },
    sources: { ok: of('ok'), degraded: of('degraded'), down: of('down'), unknown: of('unknown'), total: rows.length },
    owner_sources: { healthy: owner.healthy, total: owner.total },
    quarantined: rows.reduce((sum, r) => sum + r.quarantine_count, 0),
    twins: { ok: twins.filter((t) => t.ok).length, failing: twins.filter((t) => !t.ok).length },
  };
  return validated(Health, { status: overallStatus(body, now), ...body });
}

/** The newest source health the loader wrote for the family (the owner documents' generated_at). */
const newestUpdate = (rows: readonly SourceRow[]): Date | null =>
  rows.reduce<Date | null>((a, r) => (a === null || r.updated_at > a ? r.updated_at : a), null);

/**
 * /health of the owner api (P9b): the owner family's sources as counts, its quarantined payloads and its twins. No
 * loader backlog (the loader view is public-only, KG-219) and no owner count: every source is listed. `down` when the
 * loader wrote no source health within 5 minutes; `degraded` like the public document.
 */
export async function readOwnerHealth(db: Kysely<DB>, now: Date) {
  const { rows, twins } = await snapshot(db, async (tx) => ({
    rows: await sourceRows(tx, 'owner'),
    twins: await latestTwinChecks(tx, 'owner', now),
  }));
  const of = (status: SourceRow['status']) => rows.filter((r) => r.status === status).length;
  const generated = newestUpdate(rows);
  const sources = {
    ok: of('ok'),
    degraded: of('degraded'),
    down: of('down'),
    unknown: of('unknown'),
    total: rows.length,
  };
  const quarantined = rows.reduce((sum, r) => sum + r.quarantine_count, 0);
  const failing = twins.filter((t) => !t.ok).length;
  const status: HealthStatus =
    generated === null || now.getTime() - generated.getTime() > HEALTH_MAX_AGE_MS
      ? 'down'
      : sources.degraded + sources.down > 0 || quarantined > 0 || failing > 0
        ? 'degraded'
        : 'ok';
  return {
    audience: 'owner' as const,
    status,
    generated_at: iso(generated),
    sources,
    quarantined,
    twins: { ok: twins.length - failing, failing },
  };
}

/**
 * The public classification coverage at the current bucket (P7b; D10), from the public family only. It is computed
 * beside the health document, never inside its transaction: a failure gives null and a logged fixed code, never a
 * 503 of the whole document.
 */
async function familyCoverage(
  db: Kysely<DB>,
  now: Date,
  deps: Pick<HealthDeps, 'sections' | 'log' | 'cache'>,
  family: ChannelAudience,
): Promise<ClassCoverage | null> {
  try {
    const t = floorBucket(now.getTime());
    const opts = { now: now.getTime(), current: true, sections: deps.sections, cache: deps.cache };
    return classCoverage(await readStates(db, family, t, opts));
  } catch (err) {
    deps.log?.error({ code: errorCode(err), route: 'classification' }, 'coverage unavailable');
    return null;
  }
}

/**
 * The public forecast coverage (P8a; catalogue §0.5), from the public family only, beside the health document like
 * the classification: a failure gives null and a logged fixed code, never a 503 of the whole document.
 */
async function familyForecastCoverage(
  db: Kysely<DB>,
  now: Date,
  deps: Pick<HealthDeps, 'log'>,
  family: ChannelAudience,
): Promise<ForecastCoverage | null> {
  try {
    return await forecastCoverage(db, family, now.getTime());
  } catch (err) {
    deps.log?.error({ code: errorCode(err), route: 'forecast' }, 'coverage unavailable');
    return null;
  }
}

export async function readSources(
  db: Kysely<DB>,
  now: Date,
  deps: Pick<HealthDeps, 'sections' | 'log' | 'cache'> = { sections: new Map(), log: undefined },
): Promise<HealthSources> {
  const { owner_sources, generated_at, ...rest } = await readFamilySources(db, now, deps, 'public');
  return validated(HealthSources, { generated_at, ...rest, owner_sources });
}

/** /health/sources of one family; `owner_sources` and the loader's computed_at exist in the public family only. */
export async function readFamilySources(
  db: Kysely<DB>,
  now: Date,
  deps: Pick<HealthDeps, 'sections' | 'log' | 'cache'>,
  family: ChannelAudience,
) {
  const classification = await familyCoverage(db, now, deps, family);
  const forecast_coverage = await familyForecastCoverage(db, now, deps, family);
  const { rows, batches, twins, owner, l } = await snapshot(db, async (tx) => ({
    rows: await sourceRows(tx, family),
    batches: await quarantinedBatches(tx, family),
    twins: await latestTwinChecks(tx, family, now),
    owner: family === 'public' ? await ownerCounts(tx) : undefined,
    l: family === 'public' ? await loaderRow(tx) : undefined,
  }));
  return {
    generated_at: iso(family === 'public' ? (l?.computed_at ?? null) : newestUpdate(rows)),
    sources: rows.map((r) => {
      const detail = validated(Detail, r.detail);
      return {
        id: r.source_id,
        status: r.status,
        last_fetch_ok: iso(r.last_fetch_ok),
        last_new_data: iso(r.last_new_data),
        newest_ts: iso(r.newest_ts),
        consecutive_failures: r.consecutive_failures,
        quarantined: r.quarantine_count,
        lag_p95_s: r.lag_p95_s,
        tier1: detail.tier1 ?? null,
        missing_buckets_24h: detail.missing_buckets_24h ?? null,
        outage: detail.outage ?? null,
        coverage: detail.coverage ?? null,
        min_interval_s: detail.min_interval_s ?? [],
        label_offset: detail.label_offset ?? null,
        forecast: detail.forecast ?? null,
        partitions: Object.entries(detail.partitions ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([partition, p]) => ({ partition, md5: p.md5, rows: p.rows })),
        partitions_at: detail.partitions_at ?? null,
      };
    }),
    quarantined_batches: batches.map((b) => ({
      id: b.id,
      source: b.source_id,
      spec: b.spec_id,
      fetched_at: b.fetched_at.toISOString(),
      error: b.error,
    })),
    twins: twins.map((t) => ({
      id: t.twin_id,
      window_end: t.window_end.toISOString(),
      n_aligned: t.n_aligned,
      median_delta: t.median_delta,
      max_delta: t.max_delta,
      lag_min: t.lag_min,
      ok: t.ok,
      checks_7d: t.checks_7d,
      failed_7d: t.failed_7d,
    })),
    owner_sources: { healthy: owner?.healthy ?? 0, total: owner?.total ?? 0 },
    classification,
    forecast_coverage,
  };
}

export type HealthDeps = {
  /** The family this process serves (the public api, or the owner api of P9b). */
  family?: ChannelAudience;
  /** The family's connection; without it both routes answer 503. */
  db: Kysely<DB> | undefined;
  now: () => Date;
  log: Pick<Logger, 'error'> | undefined;
  /** The FR-5 station → section map, for the coverage report. */
  sections: ReadonlyMap<string, string>;
  /** The classification's static rows, shared with the data routes; none in tests that read fresh. */
  cache?: StaticCache;
  /** The DB-concurrency semaphore of the process; a computation runs only if a permit is free now. */
  semaphore?: Semaphore;
};

/**
 * Registers the two health routes. Each has its own 30 s cache with single
 * flight; the JSON is validated once and served as the same bytes.
 */
export function registerHealth(app: Hono, deps: HealthDeps): void {
  const family = deps.family ?? 'public';
  const owner = family === 'owner';
  const route = (path: string, read: (db: Kysely<DB>, now: Date) => Promise<unknown>) => {
    const cache = new TtlCache(
      async () => {
        try {
          const db = deps.db;
          if (db === undefined) throw coded('no_database');
          const compute = async () => JSON.stringify(await read(db, deps.now()));
          return await (deps.semaphore === undefined ? compute() : deps.semaphore.tryRun(compute));
        } catch (err) {
          // Once per attempt, not per request. A fixed code only: a driver message can quote SQL, a host or a value.
          if (!(err instanceof Saturated)) deps.log?.error({ code: errorCode(err), route: path }, 'health unavailable');
          throw err;
        }
      },
      () => deps.now().getTime(),
      CACHE_MS,
      ERROR_MS,
      (err) => err instanceof Saturated,
    );
    const cacheControl = owner ? 'private, no-store' : `public, max-age=${CACHE_MS / 1000}`;
    app.get(path, async (c) => {
      // Any query string is a parameter this route does not know: 400, and the cache-key space stays closed.
      if (new URL(c.req.url).search !== '') return refuse(c, 400, 'unknown_parameter');
      try {
        return c.body(await cache.get(), 200, { 'Content-Type': 'application/json', 'Cache-Control': cacheControl });
      } catch (err) {
        if (!(err instanceof Saturated)) return c.json(UNAVAILABLE, 503, NO_STORE);
        const last = cache.lastGood;
        if (last !== undefined && deps.now().getTime() - last.at <= STALE_MS)
          return c.body(last.value, 200, { 'Content-Type': 'application/json', ...NO_STORE, 'X-Stale': '1' });
        return refuse(c, 503, 'busy', { 'Retry-After': '2' });
      }
    });
  };
  /** The family's attribution of a /health/sources body: its sources, dated by what the loader knows now. */
  const attributed = async (db: Kysely<DB>, now: Date, body: { sources: unknown[] }) => {
    if (deps.cache === undefined) throw coded('no_cache');
    const st = await deps.cache.get(db, family);
    const ids = new Map(st.series.map((s) => [s.id, s.source_id]));
    return attributionOf(
      st,
      bodySources('healthSources', body, (id) => ids.get(id)),
      { live: true, at: now.getTime() },
    );
  };
  if (owner) {
    route('/api/v1/health', async (db, now) =>
      validated(OwnerHealthAnswer, { ...(await readOwnerHealth(db, now)), attribution: [] }),
    );
    route('/api/v1/health/sources', async (db, now) => {
      const body = await readFamilySources(db, now, deps, 'owner');
      const { owner_sources: _, ...rest } = body;
      return validated(OwnerHealthSourcesAnswer, {
        audience: 'owner',
        ...rest,
        attribution: await attributed(db, now, body),
      });
    });
    return;
  }
  route('/api/v1/health', async (db, now) =>
    validated(HealthAnswer, { ...(await readHealth(db, now)), attribution: [] }),
  );
  route('/api/v1/health/sources', async (db, now) => {
    const body = await readSources(db, now, deps);
    return validated(HealthSourcesAnswer, { ...body, attribution: await attributed(db, now, body) });
  });
}
