import { dayOf } from '@rws/contracts';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DayVersions, IMMUTABLE } from '../../src/api/versions.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import type { Db } from '../../src/db/pool.ts';
import { openApiDb } from '../../src/main.ts';
import { seedAudienceFixture } from '../db/seed.ts';
import { createTestDb, type TestDb } from '../db/testdb.ts';
import { ask, iso, type Req } from './sweep.ts';

// P9b (plan 4.5, C6, C20; issue #24 task 5, KG-114): `v` and immutable answers, and the history cap, against a real
// PostgreSQL 18 as `rws_api`. An answer is `immutable` only when the request's `v` equals the current version of every
// UTC day it spans (in memory and as stored when the answer was computed) and every one of those days is settled;
// anything else keeps the age class. A series without history_export is never immutable and is kept no longer than
// its source's window.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const GRID = 600_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
/** Settled days: a version bumped one (3), the neighbour left at the default (1), a far one, and the unsettled ones. */
const D10 = dayStart(NOW - 10 * DAY);
const D9 = D10 + DAY;
const D40 = dayStart(NOW - 40 * DAY);
const SWR = 'public, max-age=60, stale-while-revalidate=300';
const AGE_OLD = 'public, max-age=86400';

let t: TestDb;
let api: Db;
let window: DisplayWindow;
let ids: Record<string, number>;
let versions: DayVersions;
const q = (text: string, values: unknown[] = []) => t.admin.query(text, values);

const get = (path: string): Req => ({ path, label: path });
const spies = () => ({ connect: vi.spyOn(api.pool, 'connect') });
const setVersions = (map: Record<string, number>) =>
  q(
    `INSERT INTO app_meta (key, value) VALUES ('day_versions:public', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify(
        Object.fromEntries(Object.entries(map).map(([d, v]) => [d, { v, reason: 'revision', at: iso(NOW - 5 * DAY) }])),
      ),
    ],
  );
const app = (extra: Parameters<typeof createApp>[0] = {}) =>
  createApp({ db: api.db, window, versions, now: () => new Date(NOW), ...extra });
const cc = async (a: ReturnType<typeof createApp>, path: string) => {
  const r = await ask(a, get(path), 'identity');
  return { status: r.status, cache: r.headerMap['cache-control'], text: r.text };
};
const snap = (at: number, v?: number) => `/api/v1/snapshot?t=${iso(at)}${v === undefined ? '' : `&v=${v}`}`;
const series = (id: number, from: number, to: number, v?: number, res = '') =>
  `/api/v1/series/${id}?from=${iso(from)}&to=${iso(to)}${res}${v === undefined ? '' : `&v=${v}`}`;

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  await q(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [iso(NOW - 50 * DAY)]);
  await q(`SELECT ensure_partitions(now() - interval '45 days', now() + interval '10 days')`);
  // A public series with a value at noon of each day under test (history_export on: no cap).
  for (const d of [D40, D10, D9, dayStart(NOW - DAY), dayStart(NOW)])
    await q('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 100, 1, 1) ON CONFLICT DO NOTHING', [
      ids.public,
      iso(d + 12 * HOUR),
    ]);
  await setVersions({ [dayOf(D10)]: 3 });
  const opened = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
  if (typeof opened === 'string') throw new Error(opened);
  api = opened;
  window = new DisplayWindow(api.db);
  expect(await window.refresh()).toBe(true);
  versions = new DayVersions(api.db, 'public');
  expect(await versions.refresh()).toBe(true);
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  versions?.stop();
  await api?.close();
  await t?.drop();
});

describe('`v` and immutable answers', () => {
  it('reads the stored versions: a bumped day, and the default 1 of a day with no row', () => {
    expect(versions.loaded).toBe(true);
    expect(versions.versionOf(dayOf(D10))).toBe(3);
    expect(versions.versionOf(dayOf(D9))).toBe(1);
    expect(versions.versionOf(dayOf(D40))).toBe(1);
  });

  it('/snapshot: the current v of a settled day is immutable, a stale v or none is the age class, and the body is the same', async () => {
    const a = app();
    const at = D10 + 12 * HOUR;
    const right = await cc(a, snap(at, 3));
    expect([right.status, right.cache]).toEqual([200, IMMUTABLE]);
    expect(IMMUTABLE).toBe('public, max-age=31536000, immutable');
    for (const v of [1, 2, 4, 999_999])
      expect(await cc(a, snap(at, v)), `v=${v}`).toMatchObject({ status: 200, cache: AGE_OLD });
    const bare = await cc(a, snap(at));
    expect([bare.status, bare.cache]).toEqual([200, AGE_OLD]);
    // The bytes are one function of the data: the immutable body is the age-class body.
    expect(right.text).toBe(bare.text);
    expect(right.text).toContain('"value":100');
    // A day with no stored version is version 1: v=1 is current there, v=2 is not.
    expect((await cc(a, snap(D40 + 12 * HOUR, 1))).cache).toBe(IMMUTABLE);
    expect((await cc(a, snap(D40 + 12 * HOUR, 2))).cache).toBe(AGE_OLD);
  });

  it('is never immutable for a day that is not settled, whatever v says', async () => {
    const a = app();
    // Yesterday (inside 48 h): 600 s. Today (the current bucket): the 60 s class. Neither is immutable at v=1.
    const yesterday = await cc(a, snap(dayStart(NOW - DAY) + 12 * HOUR, 1));
    expect([yesterday.status, yesterday.cache]).toEqual([200, 'public, max-age=600']);
    const now = await cc(a, snap(Math.floor(NOW / GRID) * GRID, 1));
    expect([now.status, now.cache]).toEqual([200, SWR]);
    // D is settled iff D + 1 day <= now - 48 h: three days back always is, two days back never is.
    expect((await cc(a, snap(dayStart(NOW - 3 * DAY) + 12 * HOUR, 1))).cache).toBe(IMMUTABLE);
    expect((await cc(a, snap(dayStart(NOW - 2 * DAY) + 12 * HOUR, 1))).cache).not.toContain('immutable');
    // A future snapshot is never immutable either.
    expect((await cc(a, `/api/v1/snapshot?t=${iso(NOW + 3 * HOUR)}&v=1`)).cache).not.toContain('immutable');
  });

  it('without loaded versions (no DayVersions in the app) nothing is immutable', async () => {
    const bare = createApp({ db: api.db, window, now: () => new Date(NOW) });
    expect((await cc(bare, snap(D10 + 12 * HOUR, 3))).cache).toBe(AGE_OLD);
    expect((await cc(bare, snap(D40 + 12 * HOUR, 1))).cache).toBe(AGE_OLD);
    const cold = createApp({
      db: api.db,
      window,
      versions: new DayVersions(api.db, 'public'),
      now: () => new Date(NOW),
    });
    expect((await cc(cold, snap(D10 + 12 * HOUR, 3))).cache).toBe(AGE_OLD);
  });

  it('/series: immutable only when v is current for every spanned day; a span of days of different versions never is', async () => {
    const a = app();
    const id = ids.public as number;
    // One whole day: D10 (version 3).
    expect((await cc(a, series(id, D10, D10 + DAY, 3))).cache).toBe(IMMUTABLE);
    expect((await cc(a, series(id, D10, D10 + DAY, 3, '&res=1h'))).cache).toBe(IMMUTABLE);
    expect((await cc(a, series(id, D10, D10 + DAY, 3, '&res=1d'))).cache).toBe(IMMUTABLE);
    expect((await cc(a, series(id, D10, D10 + DAY, 1))).cache).toBe(AGE_OLD);
    expect((await cc(a, series(id, D10, D10 + DAY))).cache).toBe(AGE_OLD);
    // D40 only: version 1.
    expect((await cc(a, series(id, D40, D40 + DAY, 1))).cache).toBe(IMMUTABLE);
    // D10 and D9 together: versions 3 and 1, so no v is right for both.
    for (const v of [1, 3])
      expect((await cc(a, series(id, D10 + 12 * HOUR, D9 + 12 * HOUR, v))).cache, `v=${v}`).toBe(AGE_OLD);
    // A span that reaches today: not settled.
    const open = await cc(a, series(id, dayStart(NOW - DAY), NOW, 1));
    expect(open.status).toBe(200);
    expect(open.cache).not.toContain('immutable');
    // `to` is exclusive: a span that ends exactly at the end of D10 holds D10 only (and ends at D9's first instant).
    expect((await cc(a, series(id, D10 + 6 * HOUR, D9, 3))).cache).toBe(IMMUTABLE);
  });

  it('/series/{id}/forecast takes no v (unknown_parameter, 400, no-store) and is never immutable', async () => {
    const a = app();
    const withV = await cc(a, `/api/v1/series/${ids.public}/forecast?v=1`);
    expect([withV.status, withV.cache, withV.text]).toEqual([
      400,
      'no-store',
      '{"error":"unknown_parameter","attribution":[]}',
    ]);
    const bare = await cc(a, `/api/v1/series/${ids.public}/forecast`);
    expect([bare.status, bare.cache]).toEqual([200, 'public, max-age=300']);
  });

  it('a 400, a 404 and a 503 are never immutable, not even for the right v on a settled day', async () => {
    const a = app();
    const id = ids.public as number;
    const refusals: [string, number][] = [
      [`/api/v1/snapshot?t=${iso(D10 + 12 * HOUR)}&v=0`, 400],
      [`/api/v1/snapshot?t=${iso(D10 + 12 * HOUR)}&v=a`, 400],
      [`/api/v1/snapshot?t=${iso(D10 + 12 * HOUR)}&v=3&v=3`, 400],
      [`/api/v1/snapshot?t=${iso(NOW - 400 * DAY)}&v=1`, 400],
      [`/api/v1/series/${id + 100_000}?from=${iso(D10)}&to=${iso(D10 + DAY)}&v=3`, 404],
      [`/api/v1/series/${ids.displayOnly}?from=${iso(D10)}&to=${iso(D10 + DAY)}&v=3`, 404],
      [`/api/v1/series/${ids.withheld}?from=${iso(D10)}&to=${iso(D10 + DAY)}&v=3`, 404],
    ];
    for (const [path, status] of refusals) {
      const r = await cc(a, path);
      expect([r.status, r.cache], path).toEqual([status, 'no-store']);
    }
    // A failing read: the 503 carries no-store as well.
    const dead = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
    if (typeof dead === 'string') throw new Error(dead);
    await sql`SELECT 1`.execute(dead.db); // a Kysely that never ran a query has no driver to destroy
    await dead.close();
    const broken = createApp({ db: dead.db, window, versions, now: () => new Date(NOW) });
    const r = await cc(broken, snap(D10 + 12 * HOUR, 3));
    expect([r.status, r.cache]).toEqual([503, 'no-store']);
  });
});

describe('a version bump', () => {
  it('turns the old v URL into the age class and the new v URL into the immutable one; the key changed, so the body is recomputed', async () => {
    const a = app();
    const at = D10 + 12 * HOUR;
    const warm = await cc(a, snap(at, 3));
    expect(warm.cache).toBe(IMMUTABLE);
    // Served from the cache: no connection.
    let { connect } = spies();
    expect((await cc(a, snap(at, 3))).cache).toBe(IMMUTABLE);
    expect(connect).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    // The loader bumps D10 to 4 (a revision of a settled day); the api learns it at its next refresh (every 10 s).
    await setVersions({ [dayOf(D10)]: 4 });
    expect(await versions.refresh()).toBe(true);
    expect(versions.versionOf(dayOf(D10))).toBe(4);
    ({ connect } = spies());
    const stale = await cc(a, snap(at, 3));
    expect([stale.status, stale.cache]).toEqual([200, AGE_OLD]);
    // The key holds the in-memory version, so the old key is not reused: the answer was computed again.
    expect(connect).toHaveBeenCalled();
    const asked = connect.mock.calls.length;
    const fresh = await cc(a, snap(at, 4));
    expect([fresh.status, fresh.cache]).toEqual([200, IMMUTABLE]);
    expect(connect.mock.calls.length).toBe(asked); // the same key as the stale one: computed once for both
    expect(fresh.text).toBe(stale.text);
    // And back to the cache: no further connection for either v.
    await cc(a, snap(at, 3));
    await cc(a, snap(at, 4));
    expect(connect.mock.calls.length).toBe(asked);
  });

  it('is never immutable for a v that matches the memory but not the stored version of its own computation (a bump the api has not seen yet)', async () => {
    const a = app();
    const other = D10 + 15 * HOUR; // an instant no request has asked for: a cold key
    await setVersions({ [dayOf(D10)]: 5 }); // stored 5, the api's memory still 4
    expect(versions.versionOf(dayOf(D10))).toBe(4);
    const behind = await cc(a, snap(other, 4));
    expect([behind.status, behind.cache]).toEqual([200, AGE_OLD]);
    expect(await versions.refresh()).toBe(true);
    // Caught up: v=5 is current in both, on a new key.
    expect((await cc(a, snap(D10 + 16 * HOUR, 5))).cache).toBe(IMMUTABLE);
    expect((await cc(a, snap(D10 + 16 * HOUR, 4))).cache).toBe(AGE_OLD);
    await setVersions({ [dayOf(D10)]: 3 }); // leave the state as the first test of the file found it
    expect(await versions.refresh()).toBe(true);
  });

  it('a failed refresh keeps the last versions (an unreadable view never makes an old v immutable)', async () => {
    const dead = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
    if (typeof dead === 'string') throw new Error(dead);
    const v = new DayVersions(dead.db, 'public');
    v.set(new Map([[dayOf(D10), 3]]));
    await sql`SELECT 1`.execute(dead.db); // a Kysely that never ran a query has no driver to destroy
    await dead.close();
    expect(await v.refresh()).toBe(false);
    expect(v.versionOf(dayOf(D10))).toBe(3);
    expect(v.loaded).toBe(true);
  });
});

describe('KG-114: a series without history_export is kept no longer than its window and is never immutable', () => {
  const WINDOW_HOURS = 120;
  const WINDOW = WINDOW_HOURS * HOUR;
  const grid = (ms: number) => Math.floor(ms / GRID) * GRID;
  // A value of CH-3 at G (100 h back, on a settled day): 20 h left in its 120 h window.
  const G = grid(NOW) - 100 * HOUR;
  const left = (ts: number, now = NOW) => Math.floor((WINDOW - (now - ts)) / 1000);

  beforeAll(async () => {
    await q(`UPDATE source SET history_window = '${WINDOW_HOURS} hours' WHERE id = 'CH-3'`);
    await q(`DELETE FROM obs WHERE series_id = $1`, [ids.window]);
    for (const ts of [G, G + 20 * HOUR, grid(NOW) - HOUR])
      await q('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 321, 1, 1)', [ids.window, iso(ts)]);
    // The day of the oldest value is settled and at version 2 (D10 keeps its 3).
    await setVersions({ [dayOf(D10)]: 3, [dayOf(G)]: 2 });
    expect(await versions.refresh()).toBe(true);
  });

  it('/series: max-age is the time left of the window (the age class when that is longer), never immutable, even for the right v', async () => {
    const a = app();
    const id = ids.window as number;
    // The range ends 99 h back: the age class is one day, the window leaves 20 h.
    const path = (v?: number) => series(id, G - HOUR, G + HOUR, v);
    for (const v of [undefined, 2, 1]) {
      const r = await cc(a, path(v));
      expect([r.status, r.cache], `v=${v}`).toEqual([200, `public, max-age=${left(G)}`]);
      expect(r.text).toContain('"value":321');
    }
    expect(left(G)).toBeLessThanOrEqual(20 * 3600);
    // Another series of a source with history_export, the same span: not capped.
    expect((await cc(a, series(ids.public as number, D10, D10 + DAY, 3))).cache).toBe(IMMUTABLE);
    // A span of the same series that holds no value of it older than the window's last hour: capped by the newest only.
    const recent = await cc(a, series(id, grid(NOW) - 2 * HOUR, grid(NOW), undefined, '&res=raw'));
    expect(recent.status).toBe(200);
    expect(recent.cache).not.toContain('immutable');
  });

  it('/snapshot: a snapshot that holds such a value is capped the same way, and a snapshot without one is not', async () => {
    const a = app();
    const withValue = await cc(a, snap(G, 2));
    expect([withValue.status, withValue.cache]).toEqual([200, `public, max-age=${left(G)}`]);
    expect(withValue.text).toContain('"value":321');
    // t = 40 days back: CH-3 has no value there (and its window would hide it): an ordinary settled day, v=1 immutable.
    const old = await cc(a, snap(D40 + 12 * HOUR, 1));
    expect([old.status, old.cache]).toEqual([200, IMMUTABLE]);
  });

  it('no-store once the oldest value has left the window (the answer is a moment from not being served at all)', async () => {
    // The app's clock runs 5 minutes ahead of the database: a value 4 minutes inside its window is still shown by
    // the views and is past it for the app: nothing may keep it.
    const ts = NOW - WINDOW + 4 * 60_000;
    await q('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 322, 1, 1)', [ids.window, iso(ts)]);
    const ahead = app({ now: () => new Date(NOW + 5 * 60_000) });
    const r = await cc(ahead, series(ids.window as number, grid(ts) - GRID, grid(ts) + 2 * GRID));
    expect([r.status, r.cache, r.text.includes('"value":322')]).toEqual([200, 'no-store', true]);
    // The view hides it itself once the window passes in the database too: nothing to cap, an empty answer.
    await q(`UPDATE source SET history_window = '1 hour' WHERE id = 'CH-3'`);
    const gone = await cc(app(), series(ids.window as number, grid(ts) - GRID, grid(ts) + 2 * GRID));
    expect(gone.status).toBe(200);
    expect(gone.text).not.toContain('"value":322');
    await q(`UPDATE source SET history_window = '${WINDOW_HOURS} hours' WHERE id = 'CH-3'`);
  });
});
