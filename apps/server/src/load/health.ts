import { type Kysely, sql } from 'kysely';
import type { DB } from '../db/generated.ts';
import { lock } from './store.ts';

// Health is precomputed here and only read by the API (A§9.2: no checksum or
// gap scan per request). Everything is per source, over the series that share
// their source's audience, so a public source's numbers never include a series
// it withholds, and an owner source's numbers exist only in the owner views.
// The loader keeps the same rule for what it writes as it loads: newest_ts,
// last_new_data and the batch counters (n_rows, n_new, n_changed) count only
// those series too (store.ts `sameAudience`).

/** A series that the source narrows (withheld, or owner inside a public source) is not part of its numbers. */
const SAME_AUDIENCE = sql`COALESCE(s.audience, src.audience) = src.audience`;

export type HealthInputs = {
  /** The shortest capture cadence of each source, in seconds (from registry/capture.yaml). */
  cadenceS: ReadonlyMap<string, number>;
  /** p95 of "loaded at − fetched at" over the manifest lines fetched in the last hour, per source (ms). */
  lagP95Ms: ReadonlyMap<string, number>;
  /** Unconsumed manifest bytes and the age of the oldest unconsumed line (Loader.backlog). */
  backlog: { files: number; bytes: number; age_s: number | null };
  badLines: number;
  now: Date;
};

type Tier1 = { total: number; fresh: number; provider_stale: number };

/**
 * Recomputes source_health for every source: freshness of its tier-1 series,
 * the quarantine count, Q7 over 24 h, and the status the API shows. Cheap
 * (index probes on tier-1 series only); runs every minute.
 */
export async function computeHealth(db: Kysely<DB>, inputs: HealthInputs): Promise<void> {
  // Each tier-1 series: is its latest value fresh, and when was the payload fetched that last stated it.
  const tier1 = await sql<{ source_id: string; fresh: boolean; stated_at: Date | null }>`
    SELECT s.source_id, COALESCE(l.ts > ${inputs.now}::timestamptz - s.staleness_limit, false) AS fresh,
           b.fetched_at AS stated_at
    FROM series s
    JOIN source src ON src.id = s.source_id
    JOIN station st ON st.id = s.station_id AND st.tier = 1
    LEFT JOIN obs_latest l ON l.series_id = s.id
    LEFT JOIN ingest_batch b ON b.id = l.batch_id
    WHERE s.active AND s.role = 'primary' AND ${SAME_AUDIENCE}`.execute(db);

  // Q7 (A§8): expected buckets without data over the last 24 h, up to the point where a value may still be on its way.
  const gaps = await sql<{ source_id: string; missing: number }>`
    SELECT s.source_id, count(*)::int AS missing
    FROM series s
    JOIN source src ON src.id = s.source_id
    JOIN station st ON st.id = s.station_id AND st.tier = 1
    CROSS JOIN LATERAL generate_series(
      date_bin(s.expected_step, ${inputs.now}::timestamptz - interval '24 hours', timestamptz '2000-01-01 00:00:00+00'),
      ${inputs.now}::timestamptz - s.staleness_limit - s.expected_step,
      s.expected_step) AS g(b)
    WHERE s.active AND s.role = 'primary' AND ${SAME_AUDIENCE}
      AND NOT EXISTS (SELECT 1 FROM obs o WHERE o.series_id = s.id AND o.ts >= g.b AND o.ts < g.b + s.expected_step)
    GROUP BY s.source_id`.execute(db);

  const batches = await sql<{ source_id: string; quarantined: number; last_ok: Date | null }>`
    SELECT b.source_id, (count(*) FILTER (WHERE b.parse_status = 'quarantined'))::int AS quarantined,
           max(b.fetched_at) FILTER (WHERE b.parse_status = 'ok') AS last_ok
    FROM ingest_batch b GROUP BY b.source_id`.execute(db);

  const sources = await sql<{ id: string; has_series: boolean; last_fetch_ok: Date | null; failures: number | null }>`
    SELECT src.id,
           EXISTS (SELECT 1 FROM series s WHERE s.source_id = src.id AND s.active AND s.role = 'primary'
                     AND ${SAME_AUDIENCE}) AS has_series,
           h.last_fetch_ok, h.consecutive_failures AS failures
    FROM source src LEFT JOIN source_health h ON h.source_id = src.id
    WHERE src.capture_enabled AND NOT src.canary`.execute(db);

  const tierOf = new Map<string, { total: number; fresh: number; stale: (Date | null)[] }>();
  for (const r of tier1.rows) {
    const t = tierOf.get(r.source_id) ?? { total: 0, fresh: 0, stale: [] };
    t.total += 1;
    if (r.fresh) t.fresh += 1;
    else t.stale.push(r.stated_at);
    tierOf.set(r.source_id, t);
  }
  const gapOf = new Map(gaps.rows.map((r) => [r.source_id, r.missing]));
  const batchOf = new Map(batches.rows.map((r) => [r.source_id, r]));
  const nowMs = inputs.now.getTime();

  await db.transaction().execute(async (tx) => {
    await lock(tx);
    for (const src of sources.rows) {
      const cadenceMs = (inputs.cadenceS.get(src.id) ?? 3600) * 1000;
      const batch = batchOf.get(src.id);
      const t = tierOf.get(src.id);
      const recent = (at: Date | null) => at !== null && nowMs - at.getTime() <= 2 * cadenceMs;
      const payloadFresh = recent(batch?.last_ok ?? null);
      // A stale series is the provider's (it publishes nothing newer) only when a payload fetched within two
      // cadences itself stated its latest value (obs_latest.batch_id follows every confirmation). A series we
      // stopped storing (a unit mismatch, a 404, a changed key) is plain stale.
      const tier: Tier1 | null =
        t === undefined ? null : { total: t.total, fresh: t.fresh, provider_stale: t.stale.filter(recent).length };
      const quarantined = batch?.quarantined ?? 0;
      const fetchAgeMs = src.last_fetch_ok === null ? Number.POSITIVE_INFINITY : nowMs - src.last_fetch_ok.getTime();
      const lag = inputs.lagP95Ms.get(src.id);

      let status: 'ok' | 'degraded' | 'down' | 'unknown';
      if (src.last_fetch_ok === null && (src.failures ?? 0) === 0) status = 'unknown';
      else if ((src.failures ?? 0) >= 5 || fetchAgeMs > 3 * cadenceMs) status = 'down';
      else if (quarantined > 0) status = 'degraded';
      else if (src.has_series && !payloadFresh) status = 'degraded';
      else if (tier !== null && tier.total > 0 && (tier.fresh + tier.provider_stale) / tier.total < 0.95)
        status = 'degraded';
      else status = 'ok';

      const detail = {
        ...(tier === null ? {} : { tier1: tier }),
        ...(src.has_series ? { missing_buckets_24h: gapOf.get(src.id) ?? 0 } : {}),
      };
      // `partitions` inside detail is written by the checksum job; this update keeps it.
      await sql`
        INSERT INTO source_health AS h (source_id, quarantine_count, lag_p95, status, detail, updated_at)
        VALUES (${src.id}, ${quarantined}, ${lag === undefined ? null : `${Math.round(lag)} milliseconds`}::interval,
                ${status}, ${JSON.stringify(detail)}::jsonb, ${inputs.now})
        ON CONFLICT (source_id) DO UPDATE SET
          quarantine_count = EXCLUDED.quarantine_count,
          lag_p95 = EXCLUDED.lag_p95,
          status = EXCLUDED.status,
          detail = (h.detail - 'tier1' - 'missing_buckets_24h') || EXCLUDED.detail,
          updated_at = EXCLUDED.updated_at`.execute(tx);
    }
    const loader = {
      computed_at: inputs.now.toISOString(),
      backlog_files: inputs.backlog.files,
      backlog_bytes: inputs.backlog.bytes,
      backlog_age_s: inputs.backlog.age_s,
      bad_manifest_lines: inputs.badLines,
    };
    await sql`
      INSERT INTO app_meta (key, value, updated_at) VALUES ('loader', ${JSON.stringify(loader)}::jsonb, ${inputs.now})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`.execute(tx);
  });
}

/**
 * The checksum of every obs partition, per source: md5 over (series key, ts,
 * value, qc) in key and time order. It names a series by its registry key, not
 * its id, so a database rebuilt by replay gives the same checksum. Stored in
 * source_health.detail.partitions.
 */
// ponytail: one string_agg per (source, month); fine for DE-1 (under 1M rows a month). Before the
// P5 sources load 3,000 series, switch to a rolling per-day hash kept by the upsert.
export async function computeChecksums(
  db: Kysely<DB>,
  source?: string,
): Promise<Map<string, Record<string, { md5: string; rows: number }>>> {
  const { rows } = await sql<{ source_id: string; partition: string; md5: string; rows: number }>`
    SELECT s.source_id, to_char(date_trunc('month', o.ts AT TIME ZONE 'UTC'), 'YYYY-MM') AS partition,
           md5(string_agg(s.provider_key || '|' || (extract(epoch FROM o.ts))::bigint || '|' || o.value::text || '|' || o.qc,
                          ',' ORDER BY s.provider_key, o.ts)) AS md5,
           count(*)::int AS rows
    FROM obs o
    JOIN series s ON s.id = o.series_id
    JOIN source src ON src.id = s.source_id
    WHERE ${SAME_AUDIENCE} AND (${source ?? null}::text IS NULL OR s.source_id = ${source ?? null})
    GROUP BY 1, 2`.execute(db);
  const out = new Map<string, Record<string, { md5: string; rows: number }>>();
  for (const r of rows) {
    const parts = out.get(r.source_id) ?? {};
    parts[r.partition] = { md5: r.md5, rows: r.rows };
    out.set(r.source_id, parts);
  }
  return out;
}

export async function storeChecksums(db: Kysely<DB>, now: Date): Promise<void> {
  const sums = await computeChecksums(db);
  await db.transaction().execute(async (tx) => {
    await lock(tx);
    for (const [source, partitions] of sums) {
      await sql`
        UPDATE source_health
        SET detail = detail || ${JSON.stringify({ partitions, partitions_at: now.toISOString() })}::jsonb
        WHERE source_id = ${source}`.execute(tx);
    }
  });
}

/** p95 of the lag samples of the last hour, per source: none (null) when no line of the source was loaded then. */
export class LagWindow {
  private readonly samples = new Map<string, { at: number; lag: number }[]>();

  /**
   * Only lines fetched within the last hour count: replaying a backlog is not
   * lag. (A loader that falls further behind or stalls shows in the age of the
   * oldest unconsumed line, which the watchdog alerts on.)
   */
  add(source: string, fetchedAt: Date, lagMs: number, now: Date): void {
    if (now.getTime() - fetchedAt.getTime() > 3_600_000) return;
    const list = this.samples.get(source) ?? [];
    list.push({ at: now.getTime(), lag: Math.max(0, lagMs) });
    this.samples.set(source, list);
  }

  p95(now: Date): Map<string, number> {
    const out = new Map<string, number>();
    for (const [source, list] of this.samples) {
      const live = list.filter((s) => now.getTime() - s.at <= 3_600_000);
      this.samples.set(source, live);
      if (live.length === 0) continue;
      const sorted = live.map((s) => s.lag).sort((a, b) => a - b);
      out.set(source, sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number);
    }
    return out;
  }
}
