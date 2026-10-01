import { z } from 'zod';

// The public health documents (A§9.2 `GET /health` and `GET /health/sources`;
// PHASES P2a). They describe public-audience sources only: owner-audience
// sources are two counts and nothing else (invariant 11). Every object is
// strict, so a field added by mistake fails the API's own check before it is
// sent, and the watchdog's and verify-prod's after it.

const iso = z.iso.datetime();
const count = z.number().int().nonnegative();

/** The loader is "not computing" when its health is older than this (down; the watchdog's `load_stale`). */
export const HEALTH_MAX_AGE_MS = 5 * 60_000;
/** A loader whose p95 lag (fetched → loaded) reaches this many seconds degrades the overall status. */
export const LAG_DEGRADED_S = 120;
/**
 * A manifest line still unconsumed after this many seconds means the loader is
 * stalled (the watchdog's `load_backlog`, and a degraded status). A healthy
 * loader consumes a line within one 10 s tick; health is recomputed every
 * minute and the watchdog looks every 5 minutes, so 15 minutes is three
 * watchdog cycles: a deploy or a slow tick never reaches it, a stall pages
 * within about 20 minutes. The first catch-up after a long outage reaches it
 * too, on purpose: the loader is behind.
 */
export const BACKLOG_MAX_AGE_S = 900;

export const HealthStatus = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof HealthStatus>;
/** A source that was never fetched yet is `unknown`; it does not degrade anything. */
export const SourceStatus = z.enum(['ok', 'degraded', 'down', 'unknown']);
export type SourceStatus = z.infer<typeof SourceStatus>;

/** A catalogue source ID: no canary, no owner-only spelling. */
export const HealthSourceId = z.string().regex(/^(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?$/);

export const Health = z.strictObject({
  status: HealthStatus,
  /** When the loader last computed health; null before its first pass. */
  generated_at: iso.nullable(),
  loader: z.strictObject({
    /** The largest p95 lag (fetched → loaded, seconds) over the public sources; null when none has one. */
    lag_p95_s: z.number().nonnegative().nullable(),
    backlog_files: count,
    backlog_bytes: count,
    /** How old the oldest manifest line the loader has not consumed is (seconds); null when there is none. */
    backlog_age_s: z.number().nonnegative().nullable(),
    bad_manifest_lines: count,
  }),
  /** Public sources only. */
  sources: z.strictObject({ ok: count, degraded: count, down: count, unknown: count, total: count }),
  /** Two counts and nothing else (invariant 11). */
  owner_sources: z.strictObject({ healthy: count, total: count }),
  /** Quarantined payloads over the public sources. */
  quarantined: count,
  /** The latest check of each public twin. */
  twins: z.strictObject({ ok: count, failing: count }),
});
export type Health = z.infer<typeof Health>;

/** The 503 body of both health routes (no database, or it failed); never cached. */
export const HealthUnavailable = z.strictObject({ status: z.literal('down'), error: z.literal('unavailable') });
export type HealthUnavailable = z.infer<typeof HealthUnavailable>;

const Tier1 = z.strictObject({ total: count, fresh: count, provider_stale: count });

const Partition = z.strictObject({
  partition: z.string().regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])$/),
  md5: z.string().regex(/^[0-9a-f]{32}$/),
  rows: count,
});

/** ingest_batch.error: one of our fixed codes, optionally with a schema path; never provider text. */
const BatchError = z
  .string()
  .max(170)
  .regex(/^[a-z0-9_]{1,40}(?: at [A-Za-z0-9_.?[\]-]{1,120})?$/);

export const HealthSources = z.strictObject({
  generated_at: iso.nullable(),
  sources: z
    .array(
      z.strictObject({
        id: HealthSourceId,
        status: SourceStatus,
        last_fetch_ok: iso.nullable(),
        last_new_data: iso.nullable(),
        newest_ts: iso.nullable(),
        consecutive_failures: count,
        quarantined: count,
        lag_p95_s: z.number().nonnegative().nullable(),
        tier1: Tier1.nullable(),
        missing_buckets_24h: count.nullable(),
        /**
         * The last gap in the source's loaded payloads within 168 hours (a capture outage or drill), and Q7 over
         * it: expected buckets still without data, over the tier-1 series that had data in the day before it.
         */
        outage: z.strictObject({ from: iso, to: iso, missing_buckets: count }).nullable(),
        partitions: z.array(Partition).max(240),
        partitions_at: iso.nullable(),
      }),
    )
    .max(200),
  quarantined_batches: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[0-9]{1,19}$/),
        source: HealthSourceId,
        spec: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .max(80),
        fetched_at: iso,
        error: BatchError.nullable(),
      }),
    )
    .max(50),
  twins: z
    .array(
      z.strictObject({
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .max(80),
        window_end: iso,
        n_aligned: count,
        median_delta: z.number().nullable(),
        max_delta: z.number().nullable(),
        lag_min: z.number().nullable(),
        ok: z.boolean(),
        /** The hourly checks of the last 168 hours, and how many of them failed. */
        checks_7d: count,
        failed_7d: count,
      }),
    )
    .max(100),
  owner_sources: z.strictObject({ healthy: count, total: count }),
});
export type HealthSources = z.infer<typeof HealthSources>;

/**
 * The overall status of a health document (without its `status`). `down`: the
 * loader is not computing (no health yet, or none within 5 minutes); `degraded`:
 * a public source is degraded or down, the loader lags or is stalled, a payload
 * is quarantined or a twin check fails; otherwise `ok`.
 */
export function overallStatus(h: Omit<Health, 'status'>, now: Date): HealthStatus {
  if (h.generated_at === null || now.getTime() - Date.parse(h.generated_at) > HEALTH_MAX_AGE_MS) return 'down';
  if (
    h.sources.degraded + h.sources.down > 0 ||
    (h.loader.lag_p95_s ?? 0) >= LAG_DEGRADED_S ||
    (h.loader.backlog_age_s ?? 0) >= BACKLOG_MAX_AGE_S ||
    h.quarantined > 0 ||
    h.twins.failing > 0
  )
    return 'degraded';
  return 'ok';
}
