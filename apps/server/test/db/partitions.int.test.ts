import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, sqlState, type TestDb } from './testdb.ts';

// Partitions (issue #17; A§8): created only by ensure_partitions(), one per
// UTC month from 2026-01-01 on and one per UTC year of obs before it (P14a
// backfill); no default partition, so a row beyond the horizon fails loudly.

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

  it('before 2026 only obs gets a partition (yearly): 1999 is no longer refused, and forecast_value still gets none', async () => {
    const { rows } = await t.admin.query(
      "SELECT ensure_partitions('1999-12-31T00:00:00Z', '1999-12-31T12:00:00Z') AS n",
    );
    // obs_y1999 only: forecast_value has no partition below 2026-01-01, so its 2000 floor never matters.
    expect(rows).toEqual([{ n: 1 }]);
    const all = await partitions();
    expect(all.find((p) => p.name === 'obs_y1999')?.bound).toBe(
      "FOR VALUES FROM ('1999-01-01 00:00:00+00') TO ('2000-01-01 00:00:00+00')",
    );
    expect(all.filter((p) => p.name.startsWith('forecast_value_')).every((p) => p.name >= 'forecast_value_2026_')).toBe(
      true,
    );
    expect(await sqlState(t.admin, "INSERT INTO obs VALUES ($1, '1999-12-31T23:45:00Z', 1, 0, 1)", [series])).toBe(
      'ok',
    );
    expect(
      await sqlState(
        t.admin,
        "INSERT INTO forecast_value (run_id, valid_ts, value) VALUES (1, '1999-12-31T23:45:00Z', 1)",
      ),
    ).toBe('23514');
  });

  it('refuses ranges that make no sense or would create a flood of partitions', async () => {
    const call = (from: string, to: string) =>
      sqlState(t.admin, 'SELECT ensure_partitions($1::timestamptz, $2::timestamptz)', [from, to]);
    expect(await call('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).toBe('22023');
    // The 3700-day span guard is for the monthly part (from 2026-01-01 on) only.
    expect(await call('2026-01-01T00:00:00Z', '2036-10-01T00:00:00Z')).toBe('22023');
    expect(await call('1899-12-31T23:59:59Z', '1900-01-01T00:00:00Z')).toBe('22023');
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

// The yearly partitions of obs before the epoch (P14a, plan §3.8). Its own database: the guard test below puts a
// hand-made monthly partition under the boundary, which the other cases must not see.
describe('ensure_partitions: yearly obs partitions before 2026-01-01', { timeout: 60_000 }, () => {
  let y: TestDb;
  const call = (from: string, to: string) =>
    y.admin.query<{ n: number }>('SELECT ensure_partitions($1::timestamptz, $2::timestamptz) AS n', [from, to]);
  const state = (from: string, to: string) =>
    sqlState(y.admin, 'SELECT ensure_partitions($1::timestamptz, $2::timestamptz)', [from, to]);
  // Every leaf partition of obs with its bounds as UTC ISO strings, by lower bound.
  const tree = async () =>
    (
      await y.admin.query<{ name: string; lo: string; hi: string }>(
        `SELECT c.relname AS name,
                to_char((m[1]::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS lo,
                to_char((m[2]::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hi
         FROM pg_partition_tree('obs') pt JOIN pg_class c ON c.oid = pt.relid
         CROSS JOIN LATERAL regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \\(''([^'']+)''\\) TO \\(''([^'']+)''\\)') AS b(m)
         WHERE pt.isleaf ORDER BY 2`,
      )
    ).rows;

  beforeAll(async () => {
    y = await createTestDb();
  });
  afterAll(async () => {
    await y.drop();
  });

  it('creates whole years for obs only, in any order, and is idempotent', async () => {
    // Half-year ranges still give whole years; the later year first.
    expect((await call('1997-03-01T00:00:00Z', '1997-04-01T00:00:00Z')).rows).toEqual([{ n: 1 }]);
    expect((await call('1995-06-01T00:00:00Z', '1996-02-01T00:00:00Z')).rows).toEqual([{ n: 2 }]);
    expect((await call('1995-06-01T00:00:00Z', '1997-12-31T23:59:59Z')).rows).toEqual([{ n: 0 }]);
    expect((await tree()).map((p) => [p.name, p.lo, p.hi])).toEqual([
      ['obs_y1995', '1995-01-01T00:00:00Z', '1996-01-01T00:00:00Z'],
      ['obs_y1996', '1996-01-01T00:00:00Z', '1997-01-01T00:00:00Z'],
      ['obs_y1997', '1997-01-01T00:00:00Z', '1998-01-01T00:00:00Z'],
    ]);
    const { rows } = await y.admin.query(
      "SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'forecast_value'::regclass",
    );
    expect(rows).toEqual([{ n: 0 }]);
    // A range that ends exactly on the boundary does not touch 2026.
    expect((await call('2025-12-31T00:00:00Z', '2025-12-31T23:59:59Z')).rows).toEqual([{ n: 1 }]);
    expect((await call('2025-12-31T00:00:00Z', '2025-12-31T23:59:59Z')).rows).toEqual([{ n: 0 }]);
  });

  it('tiles without overlap or gap: the last yearly ends exactly at 2026-01-01, where the monthlies begin', async () => {
    // One call across the boundary: yearlies up to 2025, then both tables' months from 2026-01.
    expect((await call('1998-01-01T00:00:00Z', '2026-02-10T00:00:00Z')).rows).toEqual([{ n: 27 + 4 }]);
    const parts = await tree();
    const yearly = parts.filter((p) => p.name.startsWith('obs_y'));
    expect(yearly).toHaveLength(31);
    expect(parts[0]?.lo).toBe('1995-01-01T00:00:00Z');
    for (let i = 1; i < parts.length; i++) expect(parts[i]?.lo, parts[i]?.name).toBe(parts[i - 1]?.hi);
    expect(yearly.at(-1)).toEqual({ name: 'obs_y2025', lo: '2025-01-01T00:00:00Z', hi: '2026-01-01T00:00:00Z' });
    expect(parts.slice(yearly.length).map((p) => p.name)).toEqual(['obs_2026_01', 'obs_2026_02']);
    expect(parts[yearly.length]?.lo).toBe('2026-01-01T00:00:00Z');
    // forecast_value: months from 2026-01 only.
    const fv = await y.admin.query<{ relname: string }>(
      "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'forecast_value'::regclass ORDER BY 1",
    );
    expect(fv.rows.map((r) => r.relname)).toEqual(['forecast_value_2026_01', 'forecast_value_2026_02']);
    // Repeating the whole call changes nothing.
    expect((await call('1998-01-01T00:00:00Z', '2026-02-10T00:00:00Z')).rows).toEqual([{ n: 0 }]);
    expect(await tree()).toEqual(parts);
  });

  it('has no default partition, and a yearly partition is complete (key, BRIN, foreign key, owner, no helper CHECK)', async () => {
    const def = await y.admin.query(
      "SELECT count(*)::int AS n FROM pg_class c WHERE c.relispartition AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'",
    );
    expect(def.rows).toEqual([{ n: 0 }]);
    const { rows } = await y.admin.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner,
              (SELECT array_agg(indexdef ORDER BY indexdef) FROM pg_indexes WHERE tablename = c.relname) AS indexes,
              (SELECT array_agg(conname || ':' || contype::text ORDER BY conname) FROM pg_constraint WHERE conrelid = c.oid) AS constraints
       FROM pg_class c WHERE c.relname = 'obs_y1996'`,
    );
    const r = rows[0] as { owner: string; indexes: string[]; constraints: string[] };
    expect(r.owner).toBe('rws_owner');
    expect(r.indexes.some((i) => i.includes('UNIQUE INDEX') && i.includes('(series_id, ts)'))).toBe(true);
    expect(r.indexes.some((i) => i.includes('USING brin (ts)'))).toBe(true);
    expect(r.constraints.filter((c) => c.endsWith(':f'))).toHaveLength(1);
    expect(r.constraints.some((c) => c.includes('_bounds'))).toBe(false);
    // The gap year 1994 and the future beyond the last monthly have no partition: loud failure.
    expect(await sqlState(y.admin, "INSERT INTO obs VALUES (1, '1994-06-01T00:00:00Z', 1, 0, 1)")).toBe('23514');
    expect(await sqlState(y.admin, "INSERT INTO obs VALUES (1, '2026-03-01T00:00:00Z', 1, 0, 1)")).toBe('23514');
  });

  it('is a locked-down SECURITY DEFINER function: prosecdef and the fixed search_path', async () => {
    const { rows } = await y.admin.query(
      "SELECT prosecdef, proconfig, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'ensure_partitions'",
    );
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], owner: 'rws_owner' }]);
    // The loader role may still call it, in any session zone.
    const load = await y.connectAs('rws_load');
    await load.query("SET TIME ZONE 'America/Los_Angeles'");
    expect(
      (await load.query("SELECT ensure_partitions('1990-07-01T00:00:00Z', '1990-07-02T00:00:00Z') AS n")).rows,
    ).toEqual([{ n: 1 }]);
    await load.end();
    expect((await tree())[0]).toEqual({ name: 'obs_y1990', lo: '1990-01-01T00:00:00Z', hi: '1991-01-01T00:00:00Z' });
  });

  it('refuses obs before 1900-01-01 and accepts 1900 itself', async () => {
    expect(await state('1899-12-31T23:59:59Z', '1900-01-02T00:00:00Z')).toBe('22023');
    expect((await call('1900-01-01T00:00:00Z', '1900-01-02T00:00:00Z')).rows).toEqual([{ n: 1 }]);
    expect((await tree())[0]?.name).toBe('obs_y1900');
  });

  it('refuses to make a yearly partition while a monthly obs partition lies below the boundary, and makes nothing', async () => {
    await y.admin.query("CREATE TABLE obs_1960_03 PARTITION OF obs FOR VALUES FROM ('1960-03-01') TO ('1960-04-01')");
    try {
      const before = await tree();
      expect(await state('1985-01-01T00:00:00Z', '1985-06-01T00:00:00Z')).toBe('55000');
      // Also when the range itself only reaches into 2025: the layout is mixed, a human decides.
      expect(await state('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z')).toBe('55000');
      expect(await tree()).toEqual(before);
      // From the boundary on nothing changes: the monthly code does not read the tree.
      expect(await state('2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z')).toBe('ok');
    } finally {
      await y.admin.query('DROP TABLE obs_1960_03');
    }
    expect(await state('1985-01-01T00:00:00Z', '1985-06-01T00:00:00Z')).toBe('ok');
  });
});
