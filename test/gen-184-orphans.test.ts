import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_FLOOR } from '../apps/server/src/load/dirty.ts';
import {
  CHECK,
  checkSql,
  KEPT,
  MIGRATION,
  migrationSql,
  orphanRows,
  parseMigration,
  readStations,
} from '../scripts/gen-184-orphans.ts';

// #184 stage 2, PR B: the orphan migration and its check are the generator's output for their own rows. The census is
// not in the repository, so census → rows is the lead's local run (twice, no diff); CI holds what the files say.

const migration = readFileSync(MIGRATION, 'utf8');
const check = readFileSync(CHECK, 'utf8');

describe('the committed orphan migration (#184 PR B)', () => {
  const o = parseMigration(migration);

  it('is migrationSql of its own rows, byte for byte, and the check is checkSql of the same rows', () => {
    expect(migrationSql(o)).toBe(migration);
    expect(checkSql(o)).toBe(check);
  });

  it('lists the 12,175 orphans of 10 primary series, none of Megen Q F103, all before DATA_FLOOR', () => {
    expect(o.rows).toHaveLength(12_175);
    expect(o.keys).toHaveLength(10);
    expect(o.keys).not.toContain(KEPT);
    expect([...o.keys].sort()).toEqual(o.keys);
    const floor = Date.parse(DATA_FLOOR) / 1000;
    const seen = new Set<string>();
    for (const r of o.rows) {
      expect(r.ix).toBeGreaterThanOrEqual(1);
      expect(r.ix).toBeLessThanOrEqual(o.keys.length);
      expect(r.epoch).toBeLessThan(floor);
      expect(r.epoch % 3600).toBe(0);
      expect(Number.isFinite(r.value)).toBe(true);
      seen.add(`${r.ix} ${r.epoch}`);
    }
    expect(seen.size).toBe(o.rows.length);
  });

  it('names only registered NL-1 primaries that have a registered /GEM24H twin', () => {
    const byKey = new Map(readStations().map((s) => [s.provider_key, s]));
    for (const key of o.keys) {
      expect(byKey.get(key)?.role, key).toBe('primary');
      expect(byKey.get(`${key}/GEM24H`)?.role, key).toBe('twin');
      expect(byKey.get(`${key}/GEM24H`)?.aggregate, key).toBe('mean');
    }
  });

  it('is one DO block with an empty down: no grant, role, view or other table statement', () => {
    const up = migration.slice(migration.indexOf('-- migrate:up'), migration.indexOf('-- migrate:down'));
    const down = migration.slice(migration.indexOf('-- migrate:down'));
    expect(up.match(/^DO \$\$/gm)).toHaveLength(1);
    expect(down.split('\n').filter((l) => l !== '' && !l.startsWith('--'))).toEqual([]);
    expect(up).not.toMatch(/\b(GRANT|REVOKE|CREATE|ALTER|DROP|TRUNCATE|EXECUTE)\b/);
    // Writes only to obs (the listed rows) and its two rollups (ON CONFLICT … DO UPDATE is the upsert's own).
    expect([...up.matchAll(/\b(?:DELETE FROM|INSERT INTO|(?<!DO )UPDATE)\s+(\w+)/g)].map((m) => m[1]).sort()).toEqual([
      'obs',
      'obs_1d',
      'obs_1d',
      'obs_1h',
      'obs_1h',
    ]);
  });

  it("recomputes the buckets with the store's own expressions (pinned, review CR-9: the migration is frozen)", () => {
    const store = readFileSync(new URL('../apps/server/src/load/store.ts', import.meta.url), 'utf8');
    const squash = (s: string) => s.replace(/\s+/g, ' ');
    for (const part of [
      'SELECT o.series_id, t.bucket, min(o.value), max(o.value), avg(o.value)::real, (array_agg(o.value ORDER BY o.ts DESC))[1], count(*)::int, bit_or(o.qc)',
      'ON CONFLICT (series_id, bucket) DO UPDATE SET vmin = EXCLUDED.vmin, vmax = EXCLUDED.vmax, vavg = EXCLUDED.vavg, vlast = EXCLUDED.vlast, n = EXCLUDED.n, qc_or = EXCLUDED.qc_or',
    ]) {
      expect(squash(store), 'store.ts changed its rollup: the applied migration no longer matches it').toContain(part);
      expect(squash(migration)).toContain(part);
    }
  });

  it('the check is one read-only SELECT that it rolls back', () => {
    const body = check
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n');
    expect(body.trim().startsWith('BEGIN READ ONLY;')).toBe(true);
    expect(body.trim().endsWith('ROLLBACK;')).toBe(true);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|COMMIT)\b/);
  });
});

describe('orphanRows (the census is untrusted data)', () => {
  const A = 'a.b/Q/NVT/other:F006';
  const B = 'c/WATHTE/NAP/other:F007';
  const stations = [
    { source: 'NL-1', provider_key: A, role: 'primary' },
    { source: 'NL-1', provider_key: `${A}/GEM24H`, role: 'twin', aggregate: 'mean' },
    { source: 'NL-1', provider_key: B, role: 'primary' },
    { source: 'NL-1', provider_key: `${B}/GEM24H`, role: 'twin', aggregate: 'mean' },
    { source: 'NL-1', provider_key: KEPT, role: 'primary' },
  ];
  const line = (series: unknown, ts: unknown, value: unknown) => JSON.stringify({ orphan: { series, ts, value } });
  const census = (lines: string[], orphan = lines.length) =>
    [...lines, JSON.stringify({ group: { code: 'x' } }), JSON.stringify({ totals: { orphan } }), ''].join('\n');

  it('keeps the orphans outside Megen Q F103, sorted by key and instant, with 1-based key indexes', () => {
    const o = orphanRows(
      census([
        line(B, '2001-01-02T07:00:00.000Z', 4438),
        line(A, '1990-01-02T23:00:00.000Z', 123.45),
        line(KEPT, '2024-03-01T00:10:00.000Z', 1051),
        line(A, '1990-01-01T23:00:00.000Z', 120),
      ]),
      stations,
    );
    expect(o.keys).toEqual([A, B]);
    expect(o.rows).toEqual([
      { ix: 1, epoch: Date.parse('1990-01-01T23:00:00Z') / 1000, value: 120 },
      { ix: 1, epoch: Date.parse('1990-01-02T23:00:00Z') / 1000, value: 123.45 },
      { ix: 2, epoch: Date.parse('2001-01-02T07:00:00Z') / 1000, value: 4438 },
    ]);
  });

  it.each([
    ['a key that is no NL-1 key', [line('a.b/Q/NVT/F006', '1990-01-01T23:00:00.000Z', 1)], /not an NL-1 key/],
    ['an instant that is no UTC instant', [line(A, '1990-01-01T23:00:00+01:00', 1)], /not a UTC instant/],
    ['a daily mean off the whole hour', [line(A, '1990-01-01T23:10:00.000Z', 1)], /not on a whole hour/],
    ['a value that is no number', [line(A, '1990-01-01T23:00:00.000Z', '1')], /not a finite number/],
    [
      'the same series and instant twice',
      [line(A, '1990-01-01T23:00:00.000Z', 1), line(A, '1990-01-01T23:00:00.000Z', 1)],
      /twice/,
    ],
    ['an instant at DATA_FLOOR', [line(A, '2026-08-01T00:00:00.000Z', 1)], /DATA_FLOOR/],
    [
      'a series the registry does not hold as an NL-1 primary',
      [line('z/Q/NVT/other:F001', '1990-01-01T23:00:00.000Z', 1)],
      /not a registered NL-1 primary/,
    ],
  ])('refuses %s', (_name, lines, error) => {
    expect(() => orphanRows(census(lines), stations)).toThrow(error);
  });

  it('refuses a primary without its daily-mean twin', () => {
    const noTwin = stations.filter((s) => s.provider_key !== `${A}/GEM24H`);
    expect(() => orphanRows(census([line(A, '1990-01-01T23:00:00.000Z', 1)]), noTwin)).toThrow(/no registered/);
  });

  it('refuses a census with no orphan outside Megen Q F103 (nothing to delete, review CR-4)', () => {
    expect(() => orphanRows(census([line(KEPT, '2024-03-01T00:10:00.000Z', 1051)]), stations)).toThrow(
      /nothing to delete/,
    );
  });

  it('refuses a census whose totals do not count the orphans read, or that has no totals line', () => {
    expect(() => orphanRows(census([line(A, '1990-01-01T23:00:00.000Z', 1)], 2), stations)).toThrow(/totals/);
    expect(() => orphanRows(`${line(A, '1990-01-01T23:00:00.000Z', 1)}\n`, stations)).toThrow(/no totals line/);
  });

  it('round-trips: parseMigration(migrationSql(o)) is o', () => {
    const o = orphanRows(
      census([line(A, '1990-01-01T23:00:00.000Z', -0.5), line(B, '2001-01-02T07:00:00.000Z', 1e-7)]),
      stations,
    );
    expect(parseMigration(migrationSql(o))).toEqual(o);
  });
});
