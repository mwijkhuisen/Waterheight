import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, sqlState, type TestDb } from './testdb.ts';

// Partitions (issue #17; A§8): created only by ensure_partitions(), one per
// UTC month; no default partition, so a row beyond the horizon fails loudly.

let t: TestDb;
let series: number;

beforeAll(async () => {
  t = await createTestDb();
  await t.admin.query(`
    INSERT INTO provider (id, name, country) VALUES ('wsv', 'WSV', 'DE');
    INSERT INTO source (id, provider_id, name, audience, lic_display, lic_api, lic_bulk_export, lic_history_export, capture_enabled)
      VALUES ('DE-1', 'wsv', 'x', 'public', true, true, true, true, true);
    INSERT INTO station (id, name, country, tier) VALUES ('de.wsv.1', 'x', 'DE', 1);`);
  series = (
    await t.admin.query<{ id: number }>(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role)
       VALUES ('de.wsv.1', 'DE-1', 'H', 'stage', 'k', 'cm', 1, 'NHN', '15 min', '15 min', '45 min', 'primary') RETURNING id`,
    )
  ).rows[0]?.id as number;
});

afterAll(async () => {
  await t.drop();
});

const partitions = async () =>
  (
    await t.admin.query<{ name: string; bound: string }>(
      `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE c.relkind = 'r' ORDER BY 1`,
    )
  ).rows;

describe('ensure_partitions', () => {
  it('starts with no partition at all: the migration creates none and there is no default partition', async () => {
    expect(await partitions()).toEqual([]);
    expect(await sqlState(t.admin, "INSERT INTO obs VALUES ($1, '2026-10-01T00:00:00Z', 1, 0, 1)", [series])).toBe(
      '23514',
    );
  });

  it('a batch that crosses a month boundary gets both months, as the loader role', async () => {
    const load = await t.connectAs('rws_load');
    // A session in another zone must still get UTC months.
    await load.query("SET TIME ZONE 'Europe/Amsterdam'");
    const created = await load.query("SELECT ensure_partitions('2026-09-30T23:45:00Z', '2026-10-01T00:15:00Z') AS n");
    expect(created.rows).toEqual([{ n: 4 }]);
    expect(await partitions()).toEqual([
      {
        name: 'forecast_value_2026_09',
        bound: "FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00')",
      },
      {
        name: 'forecast_value_2026_10',
        bound: "FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')",
      },
      { name: 'obs_2026_09', bound: "FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00')" },
      { name: 'obs_2026_10', bound: "FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')" },
    ]);
    await load.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES
         ($1, '2026-09-30T23:45:00Z', 1, 0, 1), ($1, '2026-10-01T00:00:00Z', 2, 0, 1), ($1, '2026-10-01T00:15:00Z', 3, 0, 1)`,
      [series],
    );
    const { rows } = await t.admin.query(
      'SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM obs GROUP BY 1 ORDER BY 1',
    );
    expect(rows).toEqual([
      { part: 'obs_2026_09', n: 1 },
      { part: 'obs_2026_10', n: 2 },
    ]);
    // Idempotent: nothing to create the second time.
    expect(
      (await load.query("SELECT ensure_partitions('2026-09-30T23:45:00Z', '2026-10-01T00:15:00Z') AS n")).rows,
    ).toEqual([{ n: 0 }]);
    await load.end();
  });

  it('a partition is complete: primary key, BRIN index, foreign key, owner, and no leftover helper constraint', async () => {
    const { rows } = await t.admin.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner,
              (SELECT array_agg(indexdef ORDER BY indexdef) FROM pg_indexes WHERE tablename = c.relname) AS indexes,
              (SELECT array_agg(conname || ':' || contype::text ORDER BY conname) FROM pg_constraint WHERE conrelid = c.oid) AS constraints
       FROM pg_class c WHERE c.relname = 'obs_2026_10'`,
    );
    const r = rows[0] as { owner: string; indexes: string[]; constraints: string[] };
    expect(r.owner).toBe('rws_owner');
    expect(r.indexes.some((i) => i.includes('UNIQUE INDEX') && i.includes('(series_id, ts)'))).toBe(true);
    expect(r.indexes.some((i) => i.includes('USING brin (ts)'))).toBe(true);
    expect(r.constraints.filter((c) => c.endsWith(':f'))).toHaveLength(1);
    expect(r.constraints.filter((c) => c.endsWith(':p'))).toHaveLength(1);
    expect(r.constraints.some((c) => c.includes('_bounds'))).toBe(false);
    // The value and qc checks of the parent hold in the partition.
    expect(await sqlState(t.admin, "INSERT INTO obs VALUES ($1, '2026-10-02T00:00:00Z', 1, 5000, 1)", [series])).toBe(
      '23514',
    );
    expect(await sqlState(t.admin, "INSERT INTO obs VALUES (999999, '2026-10-02T00:00:00Z', 1, 0, 1)")).toBe('23503');
  });

  it('an insert beyond the partition horizon fails loudly', async () => {
    expect(await sqlState(t.admin, "INSERT INTO obs VALUES ($1, '2026-12-01T00:00:00Z', 1, 0, 1)", [series])).toBe(
      '23514',
    );
    expect(await sqlState(t.admin, "INSERT INTO obs VALUES ($1, '2026-08-31T23:59:59Z', 1, 0, 1)", [series])).toBe(
      '23514',
    );
    const { rows } = await t.admin.query(
      "SELECT count(*)::int AS n FROM pg_class c WHERE c.relispartition AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('covers the August 2026 seeds through three months ahead in one call', async () => {
    const { rows } = await t.admin.query(
      "SELECT ensure_partitions('2026-08-24T00:00:00Z', now() + interval '3 months') AS n",
    );
    expect((rows[0] as { n: number }).n).toBeGreaterThanOrEqual(2);
    const names = (await partitions()).map((p) => p.name);
    expect(names).toContain('obs_2026_08');
    expect(names).toContain('forecast_value_2026_08');
  });

  it('refuses ranges that make no sense or would create a flood of partitions', async () => {
    const call = (from: string, to: string) =>
      sqlState(t.admin, 'SELECT ensure_partitions($1::timestamptz, $2::timestamptz)', [from, to]);
    expect(await call('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).toBe('22023');
    expect(await call('1999-12-31T00:00:00Z', '2026-10-01T00:00:00Z')).toBe('22023');
    expect(await call('2026-10-01T00:00:00Z', '2036-10-01T00:00:00Z')).toBe('22023');
    expect(await sqlState(t.admin, 'SELECT ensure_partitions(NULL, now())')).toBe('22023');
  });

  it('cannot be hijacked through a temporary object or the caller search_path', async () => {
    // The attacker's session has a temp table named like the parent and a hostile search_path.
    await t.admin.query(`
      CREATE TEMP TABLE obs (series_id int, ts timestamptz);
      CREATE TEMP TABLE obs_2027_01 (x int);
      SET search_path = pg_temp, public;`);
    try {
      await t.admin.query("SELECT ensure_partitions('2027-01-05T00:00:00Z', '2027-01-06T00:00:00Z')");
      const { rows } = await t.admin.query(
        "SELECT n.nspname, pg_get_expr(c.relpartbound, c.oid) IS NOT NULL AS is_partition FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'obs_2027_01' ORDER BY 1",
      );
      expect(rows.filter((r) => r.nspname === 'public')).toEqual([{ nspname: 'public', is_partition: true }]);
    } finally {
      await t.admin.query('RESET search_path; DROP TABLE pg_temp.obs; DROP TABLE pg_temp.obs_2027_01;');
    }
  });
});
