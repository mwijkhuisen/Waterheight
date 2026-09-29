import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A real PostgreSQL, never a mock (ADR-0015): the SessionStart hook's cluster on
// port 5433 in agent sessions, the digest-pinned service container in CI.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set: test:integration needs a real PostgreSQL 18');

const client = new pg.Client({ connectionString: url });

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('integration database', () => {
  it('is PostgreSQL 18 or newer', async () => {
    const { rows } = await client.query<{ v: string }>("select current_setting('server_version_num') as v");
    expect(Number(rows[0]?.v)).toBeGreaterThanOrEqual(180000);
  });

  it('uses the builtin C.UTF-8 locale provider (A§3)', async () => {
    const { rows } = await client.query<{ provider: string; locale: string | null }>(
      'select datlocprovider as provider, datlocale as locale from pg_database where datname = current_database()',
    );
    expect(rows).toEqual([{ provider: 'b', locale: 'C.UTF-8' }]);
  });

  it('round-trips a temporal key with WITHOUT OVERLAPS', async () => {
    await client.query('begin');
    try {
      await client.query('create extension if not exists btree_gist');
      await client.query(
        'create temp table t (id int, valid tstzrange, primary key (id, valid without overlaps)) on commit drop',
      );
      await client.query("insert into t values (1, '[2026-01-01,2026-02-01)')");
      await expect(client.query("insert into t values (1, '[2026-01-15,2026-03-01)')")).rejects.toThrow(
        /conflicting key value/,
      );
    } finally {
      await client.query('rollback');
    }
  });
});
