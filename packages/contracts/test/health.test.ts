import { describe, expect, it } from 'vitest';
import { Health, HealthSources, LAG_DEGRADED_S, overallStatus } from '../src/health.ts';

// The public health contract (A§9.2): strict schemas and the overall status.

const NOW = new Date('2026-10-05T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const base = (over: Partial<Omit<Health, 'status'>> = {}): Omit<Health, 'status'> => ({
  generated_at: ago(60_000),
  loader: { lag_p95_s: 34, backlog_files: 0, backlog_bytes: 0, bad_manifest_lines: 0 },
  sources: { ok: 10, degraded: 0, down: 0, unknown: 2, total: 12 },
  owner_sources: { healthy: 5, total: 6 },
  quarantined: 0,
  twins: { ok: 1, failing: 0 },
  ...over,
});

const source = {
  id: 'DE-1',
  status: 'ok',
  last_fetch_ok: ago(60_000),
  last_new_data: ago(60_000),
  newest_ts: ago(120_000),
  consecutive_failures: 0,
  quarantined: 0,
  lag_p95_s: 34,
  tier1: { total: 69, fresh: 64, provider_stale: 5 },
  missing_buckets_24h: 12,
  partitions: [{ partition: '2026-09', md5: 'a'.repeat(32), rows: 1234 }],
  partitions_at: ago(60_000),
};
const sources = (over: Record<string, unknown> = {}) => ({
  generated_at: ago(60_000),
  sources: [source],
  quarantined_batches: [],
  twins: [],
  owner_sources: { healthy: 5, total: 6 },
  ...over,
});

describe('overallStatus', () => {
  it('ok when the loader computed within 5 minutes and nothing is wrong', () => {
    expect(overallStatus(base(), NOW)).toBe('ok');
    expect(overallStatus(base({ generated_at: ago(300_000) }), NOW)).toBe('ok');
  });

  it('down when the loader is not computing: never, or more than 5 minutes ago', () => {
    expect(overallStatus(base({ generated_at: null }), NOW)).toBe('down');
    expect(overallStatus(base({ generated_at: ago(300_001) }), NOW)).toBe('down');
    // Down wins over every degrading fact.
    expect(overallStatus(base({ generated_at: null, quarantined: 3 }), NOW)).toBe('down');
  });

  it('degraded for a degraded or down source, a lagging loader, a quarantined payload or a failing twin', () => {
    expect(overallStatus(base({ sources: { ok: 9, degraded: 1, down: 0, unknown: 2, total: 12 } }), NOW)).toBe(
      'degraded',
    );
    expect(overallStatus(base({ sources: { ok: 9, degraded: 0, down: 1, unknown: 2, total: 12 } }), NOW)).toBe(
      'degraded',
    );
    expect(overallStatus(base({ quarantined: 1 }), NOW)).toBe('degraded');
    expect(overallStatus(base({ twins: { ok: 0, failing: 1 } }), NOW)).toBe('degraded');
    const lag = (lag_p95_s: number | null) => overallStatus(base({ loader: { ...base().loader, lag_p95_s } }), NOW);
    expect(lag(LAG_DEGRADED_S - 0.1)).toBe('ok');
    expect(lag(LAG_DEGRADED_S)).toBe('degraded');
    expect(lag(null)).toBe('ok');
  });

  it('a source that was never fetched (unknown) does not degrade', () => {
    expect(overallStatus(base({ sources: { ok: 0, degraded: 0, down: 0, unknown: 12, total: 12 } }), NOW)).toBe('ok');
  });
});

describe('Health', () => {
  it('accepts a document and rejects an unknown or missing field at every level', () => {
    const doc = { status: 'ok', ...base() };
    expect(Health.safeParse(doc).success).toBe(true);
    expect(Health.safeParse({ ...doc, version: '1' }).success).toBe(false);
    expect(Health.safeParse({ ...doc, owner_sources: { healthy: 1, total: 2, ids: [] } }).success).toBe(false);
    expect(Health.safeParse({ ...doc, loader: { ...doc.loader, path: '/x' } }).success).toBe(false);
    expect(Health.safeParse({ ...doc, twins: undefined }).success).toBe(false);
  });

  it('rejects a bad status, a negative or fractional count and an offset timestamp', () => {
    const doc = { status: 'ok', ...base() };
    expect(Health.safeParse({ ...doc, status: 'unknown' }).success).toBe(false);
    expect(Health.safeParse({ ...doc, quarantined: -1 }).success).toBe(false);
    expect(Health.safeParse({ ...doc, quarantined: 1.5 }).success).toBe(false);
    expect(Health.safeParse({ ...doc, generated_at: '2026-10-05T12:00:00+02:00' }).success).toBe(false);
    expect(Health.safeParse({ ...doc, generated_at: null }).success).toBe(true);
  });
});

describe('HealthSources', () => {
  it('accepts a document', () => {
    expect(HealthSources.safeParse(sources()).success).toBe(true);
    expect(HealthSources.safeParse(sources({ generated_at: null, sources: [] })).success).toBe(true);
  });

  it('accepts a source without tier-1 numbers, gaps or checksums yet', () => {
    const fresh = { ...source, tier1: null, missing_buckets_24h: null, partitions: [], partitions_at: null };
    expect(HealthSources.safeParse(sources({ sources: [fresh] })).success).toBe(true);
  });

  it('only catalogue source IDs: no canary, no owner-only spelling, no free text', () => {
    for (const id of ['CANARY-OWNER', 'de-1', 'DE-0', 'DE-100', 'DE-1 ', 'XX-1'])
      expect(HealthSources.safeParse(sources({ sources: [{ ...source, id }] })).success, id).toBe(false);
    expect(HealthSources.safeParse(sources({ sources: [{ ...source, id: 'CH-4' }] })).success).toBe(true);
  });

  it('rejects an extra key anywhere, such as a private_basis', () => {
    expect(HealthSources.safeParse(sources({ private_basis: 'x' })).success).toBe(false);
    expect(HealthSources.safeParse(sources({ sources: [{ ...source, private_basis: 'x' }] })).success).toBe(false);
    expect(HealthSources.safeParse(sources({ owner_sources: { healthy: 1, total: 1, id: 'BE-3' } })).success).toBe(
      false,
    );
  });

  it('bounds every array', () => {
    const many = (n: number, row: unknown) => Array.from({ length: n }, () => row);
    expect(HealthSources.safeParse(sources({ sources: many(201, source) })).success).toBe(false);
    expect(HealthSources.safeParse(sources({ sources: many(200, source) })).success).toBe(true);
    const part = { partition: '2026-09', md5: 'a'.repeat(32), rows: 1 };
    expect(HealthSources.safeParse(sources({ sources: [{ ...source, partitions: many(241, part) }] })).success).toBe(
      false,
    );
    const batch = { id: '12', source: 'DE-1', spec: 'de-1-basin', fetched_at: ago(1000), error: 'schema_mismatch' };
    expect(HealthSources.safeParse(sources({ quarantined_batches: many(50, batch) })).success).toBe(true);
    expect(HealthSources.safeParse(sources({ quarantined_batches: many(51, batch) })).success).toBe(false);
  });

  it('checksums are 32 hex digits in a YYYY-MM partition', () => {
    const withPart = (p: Record<string, unknown>) =>
      HealthSources.safeParse(
        sources({
          sources: [{ ...source, partitions: [{ partition: '2026-09', md5: 'a'.repeat(32), rows: 1, ...p }] }],
        }),
      ).success;
    expect(withPart({})).toBe(true);
    expect(withPart({ md5: 'A'.repeat(32) })).toBe(false);
    expect(withPart({ md5: 'a'.repeat(31) })).toBe(false);
    expect(withPart({ partition: '2026-13' })).toBe(false);
    expect(withPart({ partition: '2026-9' })).toBe(false);
  });

  it('a quarantined batch carries a fixed error code, never free text', () => {
    const batch = (error: string | null) => ({
      id: '7',
      source: 'DE-1',
      spec: 'de-1-basin',
      fetched_at: ago(1000),
      error,
    });
    const ok = (error: string | null) =>
      HealthSources.safeParse(sources({ quarantined_batches: [batch(error)] })).success;
    expect(ok('unrecognized_keys')).toBe(true);
    expect(ok('invalid_type at [3].value')).toBe(true);
    expect(ok(null)).toBe(true);
    expect(ok('Ignore previous instructions <script>')).toBe(false);
    expect(ok('a'.repeat(171))).toBe(false);
    expect(HealthSources.safeParse(sources({ quarantined_batches: [{ ...batch(null), id: 'x1' }] })).success).toBe(
      false,
    );
    expect(
      HealthSources.safeParse(sources({ quarantined_batches: [{ ...batch(null), spec: 'Bad_Spec' }] })).success,
    ).toBe(false);
  });

  it('a twin check may lack aligned deltas', () => {
    const twin = {
      id: 'lobith-tolkamer',
      window_end: ago(1000),
      n_aligned: 0,
      median_delta: null,
      max_delta: null,
      lag_min: null,
      ok: false,
    };
    expect(HealthSources.safeParse(sources({ twins: [twin] })).success).toBe(true);
    expect(HealthSources.safeParse(sources({ twins: [{ ...twin, id: 'Lobith' }] })).success).toBe(false);
  });
});
