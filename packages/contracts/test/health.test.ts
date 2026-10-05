import { describe, expect, it } from 'vitest';
import {
  BACKLOG_MAX_AGE_S,
  ClassCoverage,
  Health,
  HealthSources,
  LAG_DEGRADED_S,
  overallStatus,
} from '../src/health.ts';

// The public health contract (A§9.2): strict schemas and the overall status.

const NOW = new Date('2026-10-05T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const base = (over: Partial<Omit<Health, 'status'>> = {}): Omit<Health, 'status'> => ({
  generated_at: ago(60_000),
  loader: {
    lag_p95_s: 34,
    backlog_files: 0,
    backlog_bytes: 0,
    backlog_age_s: null,
    bad_manifest_lines: 0,
    last_commit: null,
  },
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
  outage: null,
  coverage: null,
  min_interval_s: [],
  label_offset: null,
  forecast: null,
  partitions: [{ partition: '2026-09', md5: 'a'.repeat(32), rows: 1234 }],
  partitions_at: ago(60_000),
};
const sources = (over: Record<string, unknown> = {}) => ({
  generated_at: ago(60_000),
  sources: [source],
  quarantined_batches: [],
  twins: [],
  owner_sources: { healthy: 5, total: 6 },
  classification: null,
  forecast_coverage: null,
  ...over,
});

const share = { stations: 10, classed: 6, by_section: 2, ratio: 0.6 };
const coverage = {
  t: ago(0),
  mode: 'state',
  tier1: share,
  first_release: share,
  countries: [{ country: 'DE', tier1: share, first_release: share }],
};

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

  it('degraded for a stalled loader: a manifest line left unconsumed for 15 minutes', () => {
    expect(BACKLOG_MAX_AGE_S).toBe(900);
    const age = (backlog_age_s: number | null) =>
      overallStatus(base({ loader: { ...base().loader, backlog_files: 1, backlog_bytes: 900, backlog_age_s } }), NOW);
    expect(age(null)).toBe('ok');
    expect(age(BACKLOG_MAX_AGE_S - 1)).toBe('ok');
    expect(age(BACKLOG_MAX_AGE_S)).toBe('degraded');
    expect(
      Health.safeParse({ status: 'ok', ...base({ loader: { ...base().loader, backlog_age_s: -1 } }) }).success,
    ).toBe(false);
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

describe('ClassCoverage', () => {
  const ok = (v: unknown) => ClassCoverage.safeParse(v).success;
  const withShare = (over: Record<string, unknown>) => ({ ...coverage, tier1: { ...share, ...over } });

  it('is required in HealthSources, null or a full report', () => {
    expect(HealthSources.safeParse(sources({ classification: coverage })).success).toBe(true);
    expect(HealthSources.safeParse(sources({ classification: null })).success).toBe(true);
    const { classification: _, ...missing } = sources();
    expect(HealthSources.safeParse(missing).success).toBe(false);
    expect(HealthSources.safeParse(sources({ classification: { ...coverage, x: 1 } })).success).toBe(false);
  });

  it('bounds the ratio, the countries and the enums, and is strict', () => {
    expect(ok(coverage)).toBe(true);
    expect(ok(withShare({ stations: 0, classed: 0, ratio: null }))).toBe(true);
    expect(ok(withShare({ ratio: 0 }))).toBe(true);
    expect(ok(withShare({ ratio: 1 }))).toBe(true);
    expect(ok(withShare({ ratio: 1.01 }))).toBe(false);
    expect(ok(withShare({ ratio: -0.1 }))).toBe(false);
    expect(ok(withShare({ stations: -1 }))).toBe(false);
    expect(ok(withShare({ by_section: -1 }))).toBe(false);
    expect(ok(withShare({ by_section: 1.5 }))).toBe(false);
    const { by_section: _, ...noSection } = share;
    expect(ok({ ...coverage, tier1: noSection })).toBe(false);
    expect(ok(withShare({ x: 1 }))).toBe(false);
    const c = (country: string) => ({ country, tier1: share, first_release: share });
    expect(ok({ ...coverage, countries: ['NL', 'DE', 'BE', 'FR', 'LU', 'CH'].map(c) })).toBe(true);
    expect(ok({ ...coverage, countries: [...['NL', 'DE', 'BE', 'FR', 'LU', 'CH'].map(c), c('NL')] })).toBe(false);
    expect(ok({ ...coverage, countries: [c('AT')] })).toBe(false);
    expect(ok({ ...coverage, countries: [{ ...c('NL'), x: 1 }] })).toBe(false);
    expect(ok({ ...coverage, mode: 'dh' })).toBe(true);
    expect(ok({ ...coverage, mode: 'map' })).toBe(false);
    expect(ok({ ...coverage, t: '2026-10-05T12:00:00+02:00' })).toBe(false);
  });
});

describe('the forecast fields of HealthSources (P8a)', () => {
  const run = { issued_at: ago(3_600_000), run_age_s: 3600, series: 71, current: 70, late: null };
  const ok = (over: Record<string, unknown>) =>
    HealthSources.safeParse(sources({ sources: [{ ...source, ...over }] })).success;

  it('forecast is required per source: null or the five fields and nothing else', () => {
    expect(ok({ forecast: run })).toBe(true);
    expect(ok({ forecast: { ...run, late: '2026-10-05' } })).toBe(true);
    const { forecast: _, ...without } = source;
    expect(HealthSources.safeParse(sources({ sources: [without] })).success).toBe(false);
    expect(ok({ forecast: { ...run, x: 1 } })).toBe(false);
    expect(ok({ forecast: { ...run, series: -1 } })).toBe(false);
    expect(ok({ forecast: { ...run, run_age_s: 1.5 } })).toBe(false);
    expect(ok({ forecast: { ...run, late: '2026-10-05T12:00:00Z' } })).toBe(false);
    expect(ok({ forecast: { ...run, issued_at: '2026-10-05T12:00:00+02:00' } })).toBe(false);
  });

  it('forecast_coverage is required in HealthSources, null or a full report', () => {
    const reach = {
      id: 'ems-vecht',
      names: { nl: 'Eems, Vecht', en: 'Ems, Vecht' },
      stations: 4,
      covered: 3,
      sources: ['NL-1'],
      no_official_forecast: false,
      after_permission: [],
      none_publishes: ['NLWKN'],
    };
    const report = {
      t: ago(0),
      total: { stations: 5, covered: 3 },
      countries: [{ country: 'NL', stations: 5, covered: 3 }],
      reaches: [reach],
      other: { stations: 1, covered: 0 },
    };
    expect(HealthSources.safeParse(sources({ forecast_coverage: report })).success).toBe(true);
    expect(HealthSources.safeParse(sources({ forecast_coverage: null })).success).toBe(true);
    const { forecast_coverage: _, ...missing } = sources();
    expect(HealthSources.safeParse(missing).success).toBe(false);
    expect(HealthSources.safeParse(sources({ forecast_coverage: { ...report, x: 1 } })).success).toBe(false);
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

  it('label_offset is the latest day, whether it decided, and the offset in force, nothing else, and is required (null for most sources)', () => {
    const decided = {
      day: '2026-10-04',
      decided: true,
      n_aligned: 34,
      share: 0.978,
      minutes: 15,
      decided_day: '2026-10-04',
    };
    const lu = { ...source, id: 'LU-1', label_offset: decided };
    expect(HealthSources.safeParse(sources({ sources: [lu] })).success).toBe(true);
    const bad = (label_offset: unknown) => HealthSources.safeParse(sources({ sources: [{ ...lu, label_offset }] }));
    // Review CR-4: an undecided latest day has no share, and before the first decided day no offset either.
    const undecided = { ...decided, day: '2026-10-05', decided: false, n_aligned: 3, share: null };
    expect(bad(undecided).success).toBe(true);
    expect(bad({ ...undecided, minutes: null, decided_day: null }).success).toBe(true);
    expect(bad({ ...decided, extra: 1 }).success).toBe(false);
    expect(bad({ ...decided, day: '2026-10-04T00:00:00Z' }).success).toBe(false);
    expect(bad({ ...decided, decided_day: '2026-10-04T00:00:00Z' }).success).toBe(false);
    expect(bad({ ...decided, share: 1.2 }).success).toBe(false);
    expect(bad({ ...decided, n_aligned: -1 }).success).toBe(false);
    expect(bad({ ...decided, decided: 'yes' }).success).toBe(false);
    const { decided: _flag, ...unflagged } = decided;
    expect(bad(unflagged).success).toBe(false);
    const { label_offset: _omitted, ...without } = source;
    expect(HealthSources.safeParse(sources({ sources: [without] })).success).toBe(false);
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
      checks_7d: 1,
      failed_7d: 1,
    };
    expect(HealthSources.safeParse(sources({ twins: [twin] })).success).toBe(true);
    expect(HealthSources.safeParse(sources({ twins: [{ ...twin, id: 'Lobith' }] })).success).toBe(false);
    expect(HealthSources.safeParse(sources({ twins: [{ ...twin, failed_7d: -1 }] })).success).toBe(false);
  });

  it('coverage (P5a) is a ratio in [0, 1] with at most 20 gaps, or null; min_interval_s names a spec and whole seconds', () => {
    const coverage = { from: ago(86_400_000), ratio: 0.97, series: 40, series_below_95: 2, gaps: [] };
    expect(HealthSources.safeParse(sources({ sources: [{ ...source, coverage }] })).success).toBe(true);
    const gap = { from: ago(7_200_000), to: ago(3_600_000) };
    for (const bad of [
      { ...coverage, ratio: 1.01 },
      { ...coverage, ratio: -0.01 },
      { ...coverage, series: -1 },
      { ...coverage, gaps: Array.from({ length: 21 }, () => gap) },
      { ...coverage, gaps: [{ ...gap, note: 'x' }] },
      { ...coverage, extra: 1 },
    ])
      expect(HealthSources.safeParse(sources({ sources: [{ ...source, coverage: bad }] })).success).toBe(false);
    const interval = { spec: 'ch-1-lindas', seconds: 600 };
    expect(HealthSources.safeParse(sources({ sources: [{ ...source, min_interval_s: [interval] }] })).success).toBe(
      true,
    );
    for (const bad of [
      { ...interval, seconds: 600.5 },
      { ...interval, spec: 'CH-1 lindas' },
      { ...interval, seconds: -1 },
    ])
      expect(HealthSources.safeParse(sources({ sources: [{ ...source, min_interval_s: [bad] }] })).success).toBe(false);
  });

  it('an outage is a window and a count, or null', () => {
    const outage = { from: ago(7_200_000), to: ago(3_600_000), missing_buckets: 0 };
    expect(HealthSources.safeParse(sources({ sources: [{ ...source, outage }] })).success).toBe(true);
    for (const bad of [
      { ...outage, missing_buckets: -1 },
      { ...outage, from: 'yesterday' },
      { ...outage, series: 'x' },
    ])
      expect(HealthSources.safeParse(sources({ sources: [{ ...source, outage: bad }] })).success).toBe(false);
  });
});
