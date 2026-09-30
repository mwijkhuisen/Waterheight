import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWS } from '../../src/db/audience.ts';
import { seedAudienceFixture } from './seed.ts';
import { createTestDb, sqlState, type TestDb } from './testdb.ts';

// Licence channels inside each audience (issue #17 †; A§6, A§9.2; catalogue §0.7).

let t: TestDb;
let api: pg.Client;
let owner: pg.Client;
let ids: Record<string, number>;

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  api = await t.connectAs('rws_api');
  owner = await t.connectAs('rws_owner_api');
});

afterAll(async () => {
  await t.drop();
});

const count = async (client: pg.Client, view: string, id: number | undefined, where = 'true') =>
  (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${view} WHERE series_id = $1 AND ${where}`, [id]))
    .rows[0]?.n;
const has = async (client: pg.Client, view: string, id: number | undefined) =>
  (await client.query(`SELECT 1 FROM ${view} WHERE id = $1`, [id])).rowCount === 1;

describe.each([
  ['public', () => api, VIEWS.public],
  ['owner', () => owner, VIEWS.owner],
] as const)('%s family', (_name, client, V) => {
  it('a series whose effective api flag is off is in the display views and not in the api views', async () => {
    for (const key of ['displayOnly', 'noApi'] as const) {
      expect(await has(client(), V.series, ids[key]), key).toBe(true);
      expect(await has(client(), V.api.series, ids[key]), key).toBe(false);
      expect(await count(client(), V.obs, ids[key]), key).toBe(3);
      expect(await count(client(), V.obsLatest, ids[key]), key).toBe(1);
      expect(await count(client(), V.obs1h, ids[key]), key).toBe(2);
      for (const view of [V.api.obs, V.api.obs1h, V.api.obs1d])
        expect(await count(client(), view, ids[key]), view).toBe(0);
    }
    // A series with every channel on is in both.
    expect(await has(client(), V.api.series, ids.public)).toBe(true);
    expect(await count(client(), V.api.obs, ids.public)).toBe(3);
  });

  it('a series whose display flag is off is in neither, and an override cannot switch it on', async () => {
    for (const view of [V.series, V.api.series]) expect(await has(client(), view, ids.noDisplay), view).toBe(false);
    for (const view of [V.obs, V.obsLatest, V.obs1h, V.obs1d, V.api.obs]) {
      expect(await count(client(), view, ids.noDisplay), view).toBe(0);
    }
  });

  it('rows older than history_window are hidden unless history_export is on', async () => {
    // CH-3: 30-day window, no history export: the 40-day-old row is hidden on every channel.
    for (const view of [V.obs, V.api.obs]) {
      expect(await count(client(), view, ids.window), view).toBe(2);
      expect(await count(client(), view, ids.window, "ts < now() - interval '30 days'"), view).toBe(0);
    }
    for (const view of [V.obs1h, V.obs1d, V.api.obs1h, V.api.obs1d])
      expect(await count(client(), view, ids.window), view).toBe(1);
    // CH-4: the same window with history export: everything is visible.
    for (const view of [V.obs, V.api.obs]) expect(await count(client(), view, ids.windowExport), view).toBe(3);
    for (const view of [V.obs1h, V.obs1d]) expect(await count(client(), view, ids.windowExport), view).toBe(2);
  });
});

describe('narrowing only', () => {
  it('a series override narrows a channel of its own series and of no other', async () => {
    await t.admin.query(`UPDATE series SET lic_override = '{"history_export": false}' WHERE id = $1`, [
      ids.windowExport,
    ]);
    try {
      expect(await count(api, VIEWS.public.obs, ids.windowExport)).toBe(2);
      expect(await count(api, VIEWS.public.obs, ids.public)).toBe(3);
    } finally {
      await t.admin.query('UPDATE series SET lic_override = NULL WHERE id = $1', [ids.windowExport]);
    }
  });

  it('the owner family never widens a public source: what is hidden publicly by a channel is hidden for the owner too', async () => {
    for (const key of ['displayOnly', 'noApi', 'noDisplay', 'window'] as const) {
      for (const pair of [
        [VIEWS.public.obs, VIEWS.owner.obs],
        [VIEWS.public.api.obs, VIEWS.owner.api.obs],
        [VIEWS.public.obs1d, VIEWS.owner.obs1d],
      ] as const) {
        expect(await count(owner, pair[1], ids[key]), `${key} ${pair[1]}`).toBe(await count(api, pair[0], ids[key]));
      }
    }
  });

  it('a source with an unknown window and no history export shows nothing (fail closed)', async () => {
    await t.admin.query("UPDATE source SET history_window = '0' WHERE id = 'CH-3'");
    try {
      expect(await count(api, VIEWS.public.obs, ids.window)).toBe(0);
      expect(await count(owner, VIEWS.owner.obs, ids.window)).toBe(0);
    } finally {
      await t.admin.query("UPDATE source SET history_window = '720 hours' WHERE id = 'CH-3'");
    }
  });
});

describe('the history window does not depend on the session time zone (review S3)', () => {
  it('holds hours and smaller only: a day or month part is refused', async () => {
    const set = (w: string) =>
      sqlState(t.admin, `UPDATE source SET history_window = $1::interval WHERE id = 'CH-3'`, [w]);
    try {
      for (const bad of ['30 days', '1 mon', '1 year', '29 days 24 hours', '-1 hour'])
        expect(await set(bad), bad).toBe('23514');
      for (const good of ['0', '720 hours', '90 minutes']) expect(await set(good), good).toBe('ok');
    } finally {
      await t.admin.query("UPDATE source SET history_window = '720 hours' WHERE id = 'CH-3'");
    }
  });

  it('a reader session in a hostile time zone sees exactly the rows it sees in UTC', async () => {
    // Rows an hour inside and an hour outside the 720-hour window of CH-3 (no history export).
    await t.admin.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id)
       SELECT $1, now() - interval '720 hours' + d * interval '1 hour', 100, 1, 1 FROM unnest(ARRAY[-1, 1]) d`,
      [ids.window],
    );
    // A zone whose summer time (UTC-10) began ten days ago, after 14 hours ahead of UTC: 30 days back crosses
    // its switch, so `now() - interval '30 days'` would move by 24 hours here. Hours never do.
    const doy = (daysFromNow: number) => {
      const d = new Date(Date.now() + daysFromNow * 86_400_000);
      const day = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
      // Julian day n (1–365) never counts 29 February.
      return Math.min(365, day);
    };
    const hostile = `XXX-14YYY+10,J${doy(-10)},J${doy(10)}`;
    const visible = async () => [
      await count(api, VIEWS.public.obs, ids.window),
      (await api.query(`SELECT ts FROM ${VIEWS.public.obs} WHERE series_id = $1 ORDER BY ts`, [ids.window])).rows,
      await count(owner, VIEWS.owner.obs, ids.window),
    ];
    const utc = await visible();
    expect(utc[0]).toBe(3);
    for (const client of [api, owner]) await client.query(`SET TIME ZONE '${hostile}'`);
    try {
      const shift = await api.query(
        "SELECT extract(epoch FROM (now() - interval '720 hours') - (now() - interval '30 days'))::int AS s",
      );
      expect(shift.rows).toEqual([{ s: 86_400 }]);
      expect(await visible()).toEqual(utc);
    } finally {
      for (const client of [api, owner]) await client.query("SET TIME ZONE 'UTC'");
    }
  });
});
