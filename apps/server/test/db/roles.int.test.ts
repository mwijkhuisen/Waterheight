import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { familyViews, VIEWS } from '../../src/db/audience.ts';
import { OWNER_CANARY, seedAudienceFixture, WITHHELD_CANARY } from './seed.ts';
import { createTestDb, LOGIN_ROLES, sqlState, type TestDb, testPassword } from './testdb.ts';

// Roles and privileges (issue #17, A§12.2): real scram-sha-256 logins, so each
// role's own settings apply. 42501 is "permission denied".

let t: TestDb;
let api: pg.Client;
let publish: pg.Client;
let owner: pg.Client;
let load: pg.Client;

const PUB = VIEWS.public;
const OWN = VIEWS.owner;

beforeAll(async () => {
  t = await createTestDb();
  await seedAudienceFixture(t.admin);
  api = await t.connectAs('rws_api');
  publish = await t.connectAs('rws_publish');
  owner = await t.connectAs('rws_owner_api');
  load = await t.connectAs('rws_load');
});

afterAll(async () => {
  await t.drop();
});

const BASE_TABLES = [
  'source',
  'series',
  'station',
  'obs',
  'obs_latest',
  'reference_value',
  'forecast_run',
  'ingest_batch',
  'source_health',
  'series_eff',
];

describe.each([
  ['rws_api', () => api],
  ['rws_publish', () => publish],
] as const)('%s (public reader)', (_role, client) => {
  it('is read-only with a 2 s statement timeout', async () => {
    const { rows } = await client().query(
      "SELECT current_setting('default_transaction_read_only') AS ro, current_setting('statement_timeout') AS st",
    );
    expect(rows).toEqual([{ ro: 'on', st: '2s' }]);
    expect(await sqlState(client(), 'SELECT pg_sleep(3)')).toBe('57014');
  });

  it('cannot read a base table or the internal view', async () => {
    for (const table of BASE_TABLES)
      expect(await sqlState(client(), `SELECT 1 FROM ${table} LIMIT 1`), table).toBe('42501');
  });

  it('cannot read any owner view', async () => {
    for (const view of familyViews('owner'))
      expect(await sqlState(client(), `SELECT 1 FROM ${view} LIMIT 1`), view).toBe('42501');
  });

  it('can read every public view', async () => {
    for (const view of familyViews('public'))
      expect(await sqlState(client(), `SELECT 1 FROM ${view} LIMIT 1`), view).toBe('ok');
  });

  it('cannot INSERT, UPDATE or DELETE, even after switching its read-only default off', async () => {
    // The views are joins (not updatable, 55000) and the role has no write grant on anything (42501).
    const refused = ['42501', '55000'];
    await client().query('SET default_transaction_read_only = off');
    try {
      expect(refused).toContain(await sqlState(client(), `INSERT INTO ${PUB.obs} VALUES (1, now(), 1, 0)`));
      expect(refused).toContain(await sqlState(client(), `UPDATE ${PUB.obs} SET value = 0`));
      expect(refused).toContain(await sqlState(client(), `DELETE FROM ${PUB.obs}`));
      expect(refused).toContain(await sqlState(client(), `DELETE FROM ${PUB.sourceHealth}`));
      expect(await sqlState(client(), 'INSERT INTO obs VALUES (1, now(), 1, 0, 1)')).toBe('42501');
      expect(await sqlState(client(), 'DELETE FROM obs')).toBe('42501');
      expect(await sqlState(client(), "UPDATE source SET audience = 'public'")).toBe('42501');
      expect(await sqlState(client(), 'CREATE TABLE x (i int)')).toBe('42501');
      expect(await sqlState(client(), 'CREATE TEMP TABLE x (i int)')).toBe('42501');
      expect(await sqlState(client(), "SELECT ensure_partitions(now(), now() + interval '1 day')")).toBe('42501');
    } finally {
      await client().query('SET default_transaction_read_only = on');
    }
  });

  it('sees no row of the withheld canary or the owner canary', async () => {
    for (const view of [PUB.obs, PUB.obsLatest, PUB.api.obs]) {
      const { rows } = await client().query(
        `SELECT count(*)::int AS n FROM ${view} WHERE value IN ($1::real, $2::real)`,
        [WITHHELD_CANARY, OWNER_CANARY],
      );
      expect(rows, view).toEqual([{ n: 0 }]);
    }
    const { rows } = await client().query(`SELECT count(*)::int AS n FROM ${PUB.obs}`);
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it('cannot become another role', async () => {
    expect(await sqlState(client(), 'SET ROLE rws_owner')).toBe('42501');
    expect(await sqlState(client(), 'SET ROLE rws_owner_api')).toBe('42501');
    expect(await sqlState(client(), 'SET ROLE rws_load')).toBe('42501');
  });
});

// Review S2: read-only and the 2 s timeout are session defaults a hostile session can switch off. What holds
// then: no large object can be made or written, the loader lock cannot be taken, temp files stay capped.
describe.each([
  ['rws_api', () => api],
  ['rws_publish', () => publish],
  ['rws_owner_api', () => owner],
] as const)('%s with its session defaults switched off', (_role, client) => {
  it('can neither create, open nor write a large object, nor take the loader lock', async () => {
    await client().query("SET default_transaction_read_only = off; SET statement_timeout = '0'");
    try {
      for (const call of [
        "SELECT lo_from_bytea(0, '\\x00')",
        'SELECT lo_create(0)',
        'SELECT lo_creat(-1)',
        'SELECT lo_open(1, 131072)',
        "SELECT lo_put(1, 0, '\\x00')",
        "SELECT lowrite(0, '\\x00')",
        'SELECT lo_truncate(0, 0)',
        'SELECT lo_truncate64(0, 0)',
        'SELECT lo_unlink(1)',
        "SELECT lo_import('/etc/hostname')",
        "SELECT lo_import('/etc/hostname', 1)",
      ])
        expect(await sqlState(client(), call), call).toBe('42501');
      await client().query('BEGIN');
      try {
        expect(await sqlState(client(), "SELECT 1 FROM app_meta WHERE key = 'loader_lock' FOR UPDATE")).toBe('42501');
      } finally {
        await client().query('ROLLBACK');
      }
      expect((await t.admin.query('SELECT count(*)::int AS n FROM pg_largeobject_metadata')).rows).toEqual([{ n: 0 }]);
    } finally {
      await client().query("SET default_transaction_read_only = on; SET statement_timeout = '2s'");
    }
  });

  it('cannot raise its temp_file_limit (a superuser-only setting)', async () => {
    expect((await client().query("SELECT current_setting('temp_file_limit') AS l")).rows).toEqual([{ l: '256MB' }]);
    for (const set of ['SET temp_file_limit = -1', "SET temp_file_limit = '1TB'", 'RESET temp_file_limit'])
      expect(await sqlState(client(), set), set).toBe('42501');
  });
});

describe('rws_owner_api (owner reader)', () => {
  it('is read-only with a 2 s statement timeout and is not the object owner', async () => {
    const { rows } = await owner.query(
      "SELECT current_setting('default_transaction_read_only') AS ro, current_setting('statement_timeout') AS st, current_user AS cu",
    );
    expect(rows).toEqual([{ ro: 'on', st: '2s', cu: 'rws_owner_api' }]);
    expect(await sqlState(owner, 'SET ROLE rws_owner')).toBe('42501');
  });

  it('cannot read a base table or any public view, and can read every owner view', async () => {
    for (const table of BASE_TABLES)
      expect(await sqlState(owner, `SELECT 1 FROM ${table} LIMIT 1`), table).toBe('42501');
    for (const view of familyViews('public'))
      expect(await sqlState(owner, `SELECT 1 FROM ${view} LIMIT 1`), view).toBe('42501');
    for (const view of familyViews('owner'))
      expect(await sqlState(owner, `SELECT 1 FROM ${view} LIMIT 1`), view).toBe('ok');
  });

  it('cannot write', async () => {
    await owner.query('SET default_transaction_read_only = off');
    try {
      expect(['42501', '55000']).toContain(await sqlState(owner, `INSERT INTO ${OWN.obs} VALUES (1, now(), 1, 0)`));
      expect(['42501', '55000']).toContain(await sqlState(owner, `DELETE FROM ${OWN.obs}`));
      expect(await sqlState(owner, 'INSERT INTO obs VALUES (1, now(), 1, 0, 1)')).toBe('42501');
      expect(await sqlState(owner, 'DELETE FROM obs')).toBe('42501');
      expect(await sqlState(owner, "UPDATE source SET audience = 'public'")).toBe('42501');
    } finally {
      await owner.query('SET default_transaction_read_only = on');
    }
  });

  it('sees the owner canary through the owner views and never the withheld canary', async () => {
    for (const view of [OWN.obs, OWN.obsLatest, OWN.api.obs]) {
      const { rows } = await owner.query(
        `SELECT count(*) FILTER (WHERE value = $1::real)::int AS owner_canary,
                count(*) FILTER (WHERE value = $2::real)::int AS withheld
         FROM ${view}`,
        [OWNER_CANARY, WITHHELD_CANARY],
      );
      expect((rows[0] as { owner_canary: number }).owner_canary, view).toBeGreaterThan(0);
      expect((rows[0] as { withheld: number }).withheld, view).toBe(0);
    }
  });

  it('has a connection limit of 4', async () => {
    const extra: pg.Client[] = [];
    try {
      // `owner` is the first connection.
      for (let i = 0; i < 3; i++) extra.push(await t.connectAs('rws_owner_api'));
      await expect(t.connectAs('rws_owner_api')).rejects.toMatchObject({ code: '53300' });
    } finally {
      await Promise.all(extra.map((c) => c.end()));
    }
  });
});

describe('rws_load (the loader)', () => {
  it('writes its own tables and creates partitions only through the function', async () => {
    expect(await sqlState(load, "SELECT ensure_partitions(now(), now() + interval '1 day')")).toBe('ok');
    expect(await sqlState(load, 'CREATE TABLE x (i int)')).toBe('42501');
    expect(
      await sqlState(
        load,
        "CREATE TABLE obs_2031_01 PARTITION OF obs FOR VALUES FROM ('2031-01-01') TO ('2031-02-01')",
      ),
    ).toBe('42501');
    const id = (await t.admin.query<{ id: number }>("SELECT id FROM series WHERE provider_key = 'public'")).rows[0]?.id;
    expect(await sqlState(load, 'INSERT INTO obs VALUES ($1, now() - interval $$1 minute$$, 1, 0, 1)', [id])).toBe(
      'ok',
    );
  });

  it('can never change the registry: audiences, channel flags and private_basis are read-only to it', async () => {
    expect(await sqlState(load, 'SELECT audience FROM source LIMIT 1')).toBe('ok');
    expect(await sqlState(load, "UPDATE source SET audience = 'public' WHERE id = 'BE-3'")).toBe('42501');
    expect(await sqlState(load, 'UPDATE source SET lic_api = true')).toBe('42501');
    expect(await sqlState(load, "UPDATE series SET audience = 'public'")).toBe('42501');
    expect(await sqlState(load, 'UPDATE series SET lic_override = NULL')).toBe('42501');
    expect(
      await sqlState(
        load,
        "INSERT INTO series (station_id, source_id, quantity, provider_key, native_unit, to_canonical, native_step, expected_step, staleness_limit, role) VALUES ('nl.rws.public', 'NL-1', 'Q', 'x', 'm³/s', 1, '15 min', '15 min', '45 min', 'primary')",
      ),
    ).toBe('42501');
    expect(await sqlState(load, 'DELETE FROM attribution')).toBe('42501');
  });

  it('takes the loader lock, a row lock that waits at most 30 s', async () => {
    await load.query('BEGIN');
    try {
      await load.query("SET LOCAL lock_timeout = '30s'");
      expect((await load.query("SELECT key FROM app_meta WHERE key = 'loader_lock' FOR UPDATE")).rows).toEqual([
        { key: 'loader_lock' },
      ]);
      // A second loader session waits for it, and gives up at its lock_timeout (a transient stall).
      const other = await t.connectAs('rws_load');
      await other.query("SET lock_timeout = '100ms'");
      expect(await sqlState(other, "SELECT 1 FROM app_meta WHERE key = 'loader_lock' FOR UPDATE")).toBe('55P03');
      await other.end();
    } finally {
      await load.query('ROLLBACK');
    }
  });

  it('cannot delete observations, rewrite the revision log, or read the reader views', async () => {
    expect(await sqlState(load, 'DELETE FROM obs')).toBe('42501');
    expect(await sqlState(load, 'TRUNCATE obs')).toBe('42501');
    expect(await sqlState(load, 'UPDATE obs_revision SET new_value = 0')).toBe('42501');
    expect(await sqlState(load, 'DELETE FROM obs_revision')).toBe('42501');
    expect(await sqlState(load, 'DELETE FROM ingest_batch')).toBe('42501');
    expect(await sqlState(load, `SELECT 1 FROM ${OWN.obs} LIMIT 1`)).toBe('42501');
    expect(await sqlState(load, 'CREATE TEMP TABLE x (i int)')).toBe('42501');
  });
});

describe('rws_migrator and rws_backup', () => {
  it('rws_migrator acts as rws_owner from its first statement and owns nothing itself', async () => {
    const migrator = await t.connectAs('rws_migrator');
    const { rows } = await migrator.query('SELECT session_user AS su, current_user AS cu');
    expect(rows).toEqual([{ su: 'rws_migrator', cu: 'rws_owner' }]);
    const owned = await t.admin.query(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(relowner) <> 'rws_owner'",
    );
    expect(owned.rows).toEqual([]);
    await migrator.end();
  });

  it('rws_backup reads every table and writes none; it has no password', async () => {
    await t.admin.query('SET ROLE rws_backup');
    try {
      expect(await sqlState(t.admin, 'SELECT count(*) FROM obs')).toBe('ok');
      expect(await sqlState(t.admin, 'SELECT private_basis FROM source')).toBe('ok');
      expect(await sqlState(t.admin, 'DELETE FROM obs')).toBe('42501');
      expect(await sqlState(t.admin, "UPDATE source SET audience = 'public'")).toBe('42501');
    } finally {
      await t.admin.query('RESET ROLE');
    }
    const { rows } = await t.admin.query(
      "SELECT a.rolpassword IS NULL AS no_password, r.rolconfig FROM pg_authid a JOIN pg_roles r USING (rolname) WHERE rolname = 'rws_backup'",
    );
    expect(rows).toEqual([{ no_password: true, rolconfig: ['default_transaction_read_only=on'] }]);
  });

  it('rws_owner cannot log in, and no application role is a superuser or may create roles', async () => {
    const { rows } = await t.admin.query(
      "SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolconnlimit FROM pg_roles WHERE rolname LIKE 'rws\\_%' ORDER BY 1",
    );
    const off = {
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolreplication: false,
    };
    expect(rows).toEqual([
      { rolname: 'rws_api', rolcanlogin: true, ...off, rolconnlimit: 12 },
      { rolname: 'rws_backup', rolcanlogin: true, ...off, rolconnlimit: 2 },
      { rolname: 'rws_load', rolcanlogin: true, ...off, rolconnlimit: 6 },
      { rolname: 'rws_migrator', rolcanlogin: true, ...off, rolconnlimit: 3 },
      { rolname: 'rws_owner', rolcanlogin: false, ...off, rolconnlimit: -1 },
      { rolname: 'rws_owner_api', rolcanlogin: true, ...off, rolconnlimit: 4 },
      { rolname: 'rws_publish', rolcanlogin: true, ...off, rolconnlimit: 6 },
    ]);
    // A wrong password is refused (scram), and so is a role without one.
    const url = new URL(process.env.DATABASE_URL as string);
    const attempt = (user: string, password: string) =>
      new pg.Client({ host: url.hostname, port: Number(url.port), database: t.name, user, password }).connect();
    await expect(attempt('rws_api', 'wrong')).rejects.toMatchObject({ code: '28P01' });
    await expect(attempt('rws_backup', testPassword('rws_backup'))).rejects.toMatchObject({ code: '28P01' });
    await expect(attempt('rws_owner', 'x')).rejects.toMatchObject({ code: expect.stringMatching(/^28/) });
  });
});

describe('the database itself', () => {
  it('rejects an owner source without private_basis, and a private_basis on a non-owner source', async () => {
    const insert = (audience: string, basis: string | null, bulk = false) =>
      sqlState(
        t.admin,
        `INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export,
                             lic_history_export, capture_enabled)
         VALUES ('FR-9', 'rws', 'x', $1::audience, $2::jsonb, true, true, $3, true, true)`,
        [audience, basis, bulk],
      );
    const basis = '{"clause": "c", "url": "https://example.org", "retrieved": "2026-09-24"}';
    expect(await insert('owner', null)).toBe('23514');
    expect(await insert('owner', '{"clause": "c"}')).toBe('23514');
    expect(await insert('owner', '"text"')).toBe('23514');
    expect(await insert('owner', basis, true)).toBe('23514');
    expect(await insert('public', basis)).toBe('23514');
    expect(await sqlState(t.admin, "UPDATE source SET private_basis = NULL WHERE id = 'BE-3'")).toBe('23514');
    expect(await sqlState(t.admin, "UPDATE source SET audience = 'owner' WHERE id = 'NL-1'")).toBe('23514');
    expect(await insert('owner', basis)).toBe('ok');
    await t.admin.query("DELETE FROM source WHERE id = 'FR-9'");
  });

  it('rejects a malformed licence override and NaN or infinite values', async () => {
    const override = (json: string) =>
      sqlState(t.admin, "UPDATE series SET lic_override = $1::jsonb WHERE provider_key = 'public2'", [json]);
    expect(await override('{"api": "no"}')).toBe('23514');
    expect(await override('{"lic_api": false}')).toBe('23514');
    expect(await override('[]')).toBe('23514');
    expect(await override('{"api": false, "display": true}')).toBe('ok');
    await t.admin.query("UPDATE series SET lic_override = NULL WHERE provider_key = 'public2'");
    const id = (await t.admin.query<{ id: number }>("SELECT id FROM series WHERE provider_key = 'public'")).rows[0]?.id;
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      expect(
        await sqlState(t.admin, 'INSERT INTO obs VALUES ($1, now() - interval $$2 minutes$$, $2::real, 0, 1)', [
          id,
          bad,
        ]),
        bad,
      ).toBe('23514');
    }
  });

  it('keeps the privilege matrix of every relation and function equal to the committed golden', async () => {
    // After a new partition: partitions must not open anything.
    await t.admin.query("SELECT ensure_partitions(now() + interval '60 days', now() + interval '70 days')");
    const roles = [...LOGIN_ROLES, 'rws_backup', 'public'];
    const { rows } = await t.admin.query<{ name: string; kind: string; owner: string; role: string; privs: string }>(
      `WITH rel AS (
         SELECT c.oid, c.relname AS name, c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'S') AND NOT c.relispartition
           AND c.relname <> 'schema_migrations')
       SELECT rel.name, rel.kind, rel.owner, r.role,
              concat_ws(',',
                CASE WHEN rel.kind <> 'S' AND has_table_privilege(r.role, rel.oid, 'SELECT') THEN 'SELECT' END,
                CASE WHEN rel.kind <> 'S' AND has_table_privilege(r.role, rel.oid, 'INSERT') THEN 'INSERT' END,
                CASE WHEN rel.kind <> 'S' AND has_table_privilege(r.role, rel.oid, 'UPDATE') THEN 'UPDATE' END,
                CASE WHEN rel.kind <> 'S' AND has_table_privilege(r.role, rel.oid, 'DELETE') THEN 'DELETE' END,
                CASE WHEN rel.kind <> 'S' AND has_table_privilege(r.role, rel.oid, 'TRUNCATE') THEN 'TRUNCATE' END,
                CASE WHEN rel.kind = 'S' AND has_sequence_privilege(r.role, rel.oid, 'USAGE') THEN 'USAGE' END) AS privs
       FROM rel CROSS JOIN unnest($1::text[]) AS r(role)
       ORDER BY rel.name, r.role`,
      [roles],
    );
    const matrix: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      expect(r.owner, r.name).toBe('rws_owner');
      const row = matrix[r.name] ?? {};
      matrix[r.name] = row;
      if (r.privs !== '') row[r.role] = r.privs;
    }
    // Partitions are reached through their parent only.
    const parts = await t.admin.query(
      `SELECT c.relname FROM pg_class c WHERE c.relispartition AND c.relkind = 'r' AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) r(role) WHERE r.role NOT IN ('rws_backup') AND has_table_privilege(r.role, c.oid, 'SELECT'))`,
      [roles],
    );
    expect(parts.rows).toEqual([]);
    // Every function in the schema (extension functions aside): who may execute it.
    const fn = await t.admin.query<{ name: string; role: string }>(
      `SELECT p.oid::regprocedure::text AS name, r.role
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       CROSS JOIN unnest($1::text[]) AS r(role)
       WHERE n.nspname = 'public' AND has_function_privilege(r.role, p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
       ORDER BY 1, 2`,
      [roles],
    );
    const functions: Record<string, string[]> = {};
    for (const r of fn.rows) functions[r.name] = [...(functions[r.name] ?? []), r.role];
    const schema = await t.admin.query<{ role: string; usage: boolean; create: boolean }>(
      `SELECT r.role, has_schema_privilege(r.role, 'public', 'USAGE') AS usage, has_schema_privilege(r.role, 'public', 'CREATE') AS create
       FROM unnest($1::text[]) AS r(role) WHERE r.role <> 'public' ORDER BY 1`,
      [roles],
    );
    const actual = {
      relations: matrix,
      functions,
      schema_public: Object.fromEntries(
        schema.rows.map((r) => [r.role, `${r.usage ? 'USAGE' : ''}${r.create ? ',CREATE' : ''}`]),
      ),
    };
    const golden = new URL('./privileges.golden.json', import.meta.url);
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
  });

  it('ensure_partitions is a locked-down SECURITY DEFINER function', async () => {
    const { rows } = await t.admin.query(
      "SELECT prosecdef, proconfig, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'ensure_partitions'",
    );
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], owner: 'rws_owner' }]);
  });
});
