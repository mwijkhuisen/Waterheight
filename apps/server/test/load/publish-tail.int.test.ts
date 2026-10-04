import { CANARIES } from '@rws/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWS } from '../../src/db/audience.ts';
import type { Db } from '../../src/db/pool.ts';
import { CANARY_KEY } from '../../src/load/canary.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { type Harness, harness } from './harness.ts';

// P9a: migrate's tail under the loader lock (§9 C1, C4, C10): the owner canary seeded idempotently and visible to the
// owner family only, the registry bump (first run stores, additions nothing, narrowing bumps display_start..today − 2)
// and the 3-day prune of the dirty log.

const NOW = new Date('2026-10-04T12:00:00Z');
let h: Harness;
let migrator: Db;

const versions = async (family: 'public' | 'owner') =>
  (await h.t.admin.query('SELECT value FROM app_meta WHERE key = $1', [`day_versions:${family}`])).rows[0]?.value as
    | Record<string, { v: number; reason: string }>
    | undefined;
const counts = async () => {
  const n: number[] = [];
  for (const t of [
    'obs',
    'obs_latest',
    'obs_1h',
    'obs_1d',
    'reference_value',
    'forecast_run',
    'forecast_value',
    'series',
    'station',
  ])
    n.push(await h.count(t));
  return n;
};

beforeAll(async () => {
  h = await harness();
  migrator = h.dbAs('rws_migrator', 1);
});

afterAll(async () => {
  await h.close();
});

describe('migrate publish tail', { timeout: 60_000 }, () => {
  it('seeds the owner canary once, stores the visible registry and bumps nothing on the first run', async () => {
    const first = await publishTail(migrator.db, NOW);
    expect(first).toEqual({ canaries: 1, bumped: {}, pruned: 0 });
    const before = await counts();
    expect(await publishTail(migrator.db, NOW)).toEqual({ canaries: 1, bumped: {}, pruned: 0 });
    expect(await counts()).toEqual(before);
    expect(await versions('public')).toBeUndefined();
    expect(await versions('owner')).toBeUndefined();
    const { rows } = await h.t.admin.query("SELECT key FROM app_meta WHERE key LIKE 'registry_visible:%' ORDER BY key");
    expect(rows.map((r) => r.key)).toEqual(['registry_visible:owner', 'registry_visible:public']);
  });

  it('shows the canary to the owner family and never to the public one', async () => {
    const id = await h.seriesId(CANARY_KEY);
    const read = async (db: Db, family: 'public' | 'owner') => {
      const v = VIEWS[family];
      const latest = await sql<{ value: number }>`
        SELECT value FROM ${sql.table(v.obsLatest)} WHERE series_id = ${id}`.execute(db.db);
      const fc = await sql<{ value: number }>`
        SELECT fv.value FROM ${sql.table(v.forecastValue)} fv JOIN ${sql.table(v.forecastRun)} fr ON fr.id = fv.run_id
        WHERE fr.series_id = ${id}`.execute(db.db);
      const ref = await sql<{ value: number }>`
        SELECT value FROM ${sql.table(v.reference)} WHERE series_id = ${id}`.execute(db.db);
      return [latest.rows, fc.rows, ref.rows].map((r) => r.map((x) => x.value));
    };
    // The value columns are real: the canary reads back as its `real` rendering.
    const real = Number(CANARIES.owner.real);
    expect(await read(h.dbAs('rws_owner_api'), 'owner')).toEqual([[real], [real], [real]]);
    expect(await read(h.dbAs('rws_publish'), 'public')).toEqual([[], [], []]);
  });

  it('narrowing a public series bumps both families from display_start to today − 2; a staleness change is registry', async () => {
    await h.t.admin.query(`UPDATE series SET lic_override = '{"display": false}' WHERE provider_key = $1`, [
      '9598e4cb-0849-401e-bba0-689234b27644/W',
    ]);
    expect((await publishTail(migrator.db, NOW)).bumped).toEqual({ public: 'narrowed', owner: 'narrowed' });
    const pub = (await versions('public')) ?? {};
    expect(Object.keys(pub).sort()).toEqual(
      Array.from({ length: 40 }, (_, i) =>
        new Date(Date.parse('2026-08-24') + i * 86_400_000).toISOString().slice(0, 10),
      ),
    );
    expect(pub['2026-10-02']).toMatchObject({ v: 2, reason: 'narrowed' });
    expect(await publishTail(migrator.db, NOW)).toMatchObject({ bumped: {} });

    await h.t.admin.query(
      `UPDATE series SET staleness_limit = staleness_limit + interval '1 hour' WHERE provider_key = $1`,
      [CANARY_KEY],
    );
    expect((await publishTail(migrator.db, NOW)).bumped).toEqual({ owner: 'registry' });
    expect((await versions('owner'))?.['2026-08-24']).toMatchObject({ v: 3, reason: 'registry' });
  });

  it('prunes dirty rows older than 3 days', async () => {
    await h.t.admin.query(`
      INSERT INTO publish_dirty (family, kind, from_ts, to_ts, created_at) VALUES
        ('public', 'obs', '2026-09-30', '2026-09-30', '2026-10-01T11:59:00Z'),
        ('owner', 'obs', '2026-09-30', '2026-09-30', '2026-10-01T12:01:00Z')`);
    expect((await publishTail(migrator.db, NOW)).pruned).toBe(1);
    expect(await h.count('publish_dirty')).toBe(1);
  });
});
