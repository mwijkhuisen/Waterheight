import { spawnSync } from 'node:child_process';
import { type AddressInfo, createServer } from 'node:net';
import {
  type ApiErrorCode,
  CANARY_RENDERINGS,
  Health,
  HealthSources,
  Meta,
  Series,
  Snapshot,
  Stations,
} from '@rws/contracts';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import type { Db } from '../../src/db/pool.ts';
import { API_POOL_MAX, openApiDb } from '../../src/main.ts';
import { NEVER_PUBLIC, seedAudienceFixture } from '../db/seed.ts';
import { createTestDb, type TestDb } from '../db/testdb.ts';

// The public data routes against a real PostgreSQL 18, read as the real
// `rws_api` login through the production pool code (openApiDb): the evidence
// for the P4a acceptance criteria. One part runs on a fixed clock (the DST
// night of 2026-10-25), one on the real clock over the audience fixture.

const DAY = 86_400_000;
const NOW = new Date('2026-10-26T12:00:00Z');
const SWR = 'public, max-age=60, stale-while-revalidate=300';
const MY_SERIES = ['dst', 'dense'];

let t: TestDb;
let api: Db;
let display: DisplayWindow;
let ids: Record<string, number>;

const sid = (key: string): number => {
  const id = ids[key];
  if (id === undefined) throw new Error(`no seeded series ${key}`);
  return id;
};

type Got = { status: number; text: string; headers: Headers; cache: string | null; json: () => unknown };
/** Every body this file has received, scanned for leaks at the end. */
const everything: { label: string; text: string; headers: Headers }[] = [];

async function get(app: Hono, path: string, init?: RequestInit): Promise<Got> {
  const res = await app.request(path, init);
  const text = await res.text();
  everything.push({ label: `${init?.method ?? 'GET'} ${path}`, text, headers: res.headers });
  return {
    status: res.status,
    text,
    headers: res.headers,
    cache: res.headers.get('cache-control'),
    json: () => JSON.parse(text) as unknown,
  };
}

const appAt = (now: Date, extra: { build?: string } = {}) =>
  createApp({ db: api.db, window: display, now: () => now, ...extra });

async function setDisplayStart(iso: string) {
  await t.admin.query(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [iso]);
  expect(await display.refresh()).toBe(true);
}

const spies = () => ({ connect: vi.spyOn(api.pool, 'connect'), query: vi.spyOn(api.pool, 'query') });

beforeAll(async () => {
  t = await createTestDb();
  const fixture = await seedAudienceFixture(t.admin);
  await t.admin.query(`SELECT ensure_partitions('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
  await t.admin.query(
    `INSERT INTO station (id, name, country, tier) VALUES ('nl.rws.dst', 'DST', 'NL', 1), ('nl.rws.dense', 'Dense', 'NL', 2)`,
  );
  const add = async (station: string, key: string, step: string) =>
    (
      await t.admin.query<{ id: number }>(
        `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                             native_step, expected_step, staleness_limit, role)
         VALUES ($1, 'NL-1', 'H', 'stage', $2, 'cm', 1, 'LOCAL', $3::interval, $3::interval, '45 min', 'primary')
         RETURNING id`,
        [station, key, step],
      )
    ).rows[0]?.id as number;
  const dst = await add('nl.rws.dst', 'dst', '15 min');
  const dense = await add('nl.rws.dense', 'dense', '1 min');
  // An inactive public series that holds the data of `public`: in no answer, and /series is the plain 404.
  await t.admin.query(`INSERT INTO station (id, name, country, tier) VALUES ('nl.rws.inactive', 'Inactive', 'NL', 1)`);
  const inactive = await add('nl.rws.inactive', 'inactive', '15 min');
  await t.admin.query('UPDATE series SET active = false WHERE id = $1', [inactive]);
  await t.admin.query(
    'INSERT INTO obs (series_id, ts, value, qc, batch_id) SELECT $1, ts, value, qc, batch_id FROM obs WHERE series_id = $2',
    [inactive, fixture.public],
  );
  await t.admin.query(
    `INSERT INTO obs_1d (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
     SELECT $1, bucket, vmin, vmax, vavg, vlast, n, qc_or FROM obs_1d WHERE series_id = $2`,
    [inactive, fixture.public],
  );
  ids = { ...fixture, dst, dense, inactive };

  // The DST night: 02:30+02:00 is 00:30Z and 02:30+01:00 is 01:30Z, with a 45 min staleness limit
  // neither value can reach the other's bucket.
  for (const [ts, value, qc] of [
    ['2026-10-24T12:00:00Z', 50, 1],
    ['2026-10-25T00:30:00Z', 111, 2],
    ['2026-10-25T01:30:00Z', 222, 1],
    ['2026-10-25T12:00:00Z', 333, 5],
    ['2026-10-26T11:50:00Z', 444, 1],
  ] as const)
    await t.admin.query(`INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, $4, 1)`, [
      dst,
      ts,
      value,
      qc,
    ]);
  await t.admin.query(
    `INSERT INTO obs_1h (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or) VALUES
       ($1, '2026-10-25T00:00:00Z', 111, 111, 111, 111, 1, 2), ($1, '2026-10-25T01:00:00Z', 222, 222, 222, 222, 1, 1)`,
    [dst],
  );
  await t.admin.query(
    `INSERT INTO obs_1d (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or) VALUES
       ($1, '2026-10-24T00:00:00Z', 50, 50, 50, 50, 1, 1), ($1, '2026-10-25T00:00:00Z', 111, 333, 222, 333, 3, 7)`,
    [dst],
  );
  // One value a minute for 14 days: more than the 20,000 points one answer may hold. value = minute index.
  await t.admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT $1::int, g, (row_number() OVER (ORDER BY g) - 1)::real, 1, 1
     FROM generate_series('2026-10-12T00:00:00Z'::timestamptz, '2026-10-25T23:59:00Z'::timestamptz, interval '1 minute') g`,
    [dense],
  );

  const opened = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
  if (typeof opened === 'string') throw new Error(opened);
  api = opened;
  display = new DisplayWindow(api.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await api.close();
  await t.drop();
});

describe('the api database role and its pool', () => {
  it('is rws_api through a pool of 10: read-only, with a 2 s statement timeout', async () => {
    expect(API_POOL_MAX).toBe(10);
    expect(api.pool.options.max).toBe(API_POOL_MAX);
    const { rows } = await api.pool.query(
      'SELECT current_user AS u, current_setting($1) AS timeout, current_setting($2) AS read_only',
      ['statement_timeout', 'default_transaction_read_only'],
    );
    expect(rows).toEqual([{ u: 'rws_api', timeout: '2s', read_only: 'on' }]);
    // The role's own connection limit leaves room above the pool.
    const limit = await t.admin.query<{ n: number }>(
      `SELECT rolconnlimit AS n FROM pg_roles WHERE rolname = 'rws_api'`,
    );
    expect(limit.rows[0]?.n).toBeGreaterThan(API_POOL_MAX);
  });

  it('cancels a statement after 2 s (57014) and refuses every write (25006)', async () => {
    const state = async (text: string) => {
      try {
        await api.pool.query(text);
        return 'ok';
      } catch (err) {
        return (err as { code?: string }).code;
      }
    };
    const started = Date.now();
    expect(await state('SELECT pg_sleep(3)')).toBe('57014');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    for (const write of [
      `INSERT INTO app_meta (key, value) VALUES ('zz', '1')`,
      `UPDATE app_meta SET value = '1'`,
      'DELETE FROM app_meta',
      'CREATE TABLE zz (a int)',
    ])
      expect(await state(write), write).toBe('25006');
  });

  it('never opens more than 10 connections, however many queries are waiting', async () => {
    let peak = 0;
    const timer = setInterval(() => {
      peak = Math.max(peak, api.pool.totalCount);
    }, 5);
    try {
      await Promise.all(Array.from({ length: 30 }, () => api.pool.query('SELECT pg_sleep(0.1)')));
    } finally {
      clearInterval(timer);
    }
    peak = Math.max(peak, api.pool.totalCount);
    expect(peak).toBe(API_POOL_MAX);
  });
});

describe('on the fixed clock of 2026-10-26T12:00Z', () => {
  beforeAll(async () => {
    await setDisplayStart('2026-10-01T00:00:00Z');
  });

  /** Every case is a 400 with the fixed body, nothing of the request in it, and no query at all. */
  async function expectRefused(app: Hono, cases: [string, string, ApiErrorCode][]) {
    const { connect, query } = spies();
    try {
      for (const [label, path, code] of cases) {
        const res = await get(app, path);
        expect(res.status, label).toBe(400);
        expect(res.text, label).toBe(JSON.stringify({ error: code }));
        expect(res.cache, label).toBe('no-store');
        const url = new URL(path, 'http://x');
        const echoes = [...url.searchParams].flat().concat(url.pathname.split('/').pop() ?? '');
        for (const echo of echoes.filter((e) => e.length >= 6)) expect(res.text, label).not.toContain(echo);
        expect(connect, label).not.toHaveBeenCalled();
        expect(query, label).not.toHaveBeenCalled();
      }
    } finally {
      vi.restoreAllMocks();
    }
  }

  it('refuses every invalid request with a fixed 400 before any database query', async () => {
    const app = appAt(NOW);
    const snap = '/api/v1/snapshot?t=';
    const series = (q: string, id: string | number = sid('dst')) => `/api/v1/series/${id}?${q}`;
    const span = 'from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z';
    await expectRefused(app, [
      // t: format
      ['t without an offset', `${snap}2026-10-25T12:00:00`, 'bad_parameter'],
      ['t without a time', `${snap}2026-10-25`, 'bad_parameter'],
      ['t of 33 characters', `${snap}2026-10-25T12:00:00.1234567%2B01:00`, 'bad_parameter'],
      ['t of 37 characters', `${snap}2026-10-25T12:00:00.1234567890123456Z`, 'bad_parameter'],
      ['t of 200 characters', `${snap}${'9'.repeat(200)}`, 'bad_parameter'],
      ['a lowercase z', `${snap}2026-10-25T12:00:00z`, 'bad_parameter'],
      ['a lowercase t', `${snap}2026-10-25t12:00:00Z`, 'bad_parameter'],
      ['the offset -00:00', `${snap}2026-10-25T12:00:00-00:00`, 'bad_parameter'],
      ['a + that is not encoded', `${snap}2026-10-25T14:00:00+02:00`, 'bad_parameter'],
      ['the offset +24:00', `${snap}2026-10-25T14:00:00%2B24:00`, 'bad_parameter'],
      ['the offset +01:60', `${snap}2026-10-25T14:00:00%2B01:60`, 'bad_parameter'],
      ['February 30', `${snap}2026-02-30T12:00:00Z`, 'bad_parameter'],
      ['February 29 of a common year', `${snap}2026-02-29T12:00:00Z`, 'bad_parameter'],
      ['month 13', `${snap}2026-13-01T00:00:00Z`, 'bad_parameter'],
      ['day 00', `${snap}2026-10-00T00:00:00Z`, 'bad_parameter'],
      ['hour 24', `${snap}2026-10-25T24:00:00Z`, 'bad_parameter'],
      ['minute 60', `${snap}2026-10-25T12:60:00Z`, 'bad_parameter'],
      ['second 60', `${snap}2026-10-25T12:00:60Z`, 'bad_parameter'],
      ['a leap second', `${snap}2026-12-31T23:59:60Z`, 'bad_parameter'],
      ['year 1899', `${snap}1899-12-31T23:59:59Z`, 'bad_parameter'],
      ['year 2100', `${snap}2100-01-01T00:00:00Z`, 'bad_parameter'],
      ['markup', `${snap}%3Cscript%3Ealertbadparam%3C/script%3E`, 'bad_parameter'],
      ['a missing t', '/api/v1/snapshot', 'bad_parameter'],
      ['an empty t', snap, 'bad_parameter'],
      // t: range
      ['t before displayStart', `${snap}2026-09-30T23:59:59Z`, 'out_of_range'],
      ['t years before displayStart', `${snap}1999-01-01T00:00:00Z`, 'out_of_range'],
      ['t 5 min 1 s ahead of now', `${snap}2026-10-26T12:05:01Z`, 'out_of_range'],
      ['t in 2099', `${snap}2099-12-31T23:59:59Z`, 'out_of_range'],
      // parameters
      ['an unknown parameter', `${snap}2026-10-25T12:00:00Z&zzfoobar=1`, 'unknown_parameter'],
      ['an unknown parameter and no t', '/api/v1/snapshot?zzfoobar=1', 'unknown_parameter'],
      ['a repeated t', `${snap}2026-10-25T12:00:00Z&t=2026-10-25T12:10:00Z`, 'repeated_parameter'],
      ['a repeated unknown key', '/api/v1/snapshot?zzfoobar=1&zzfoobar=2', 'repeated_parameter'],
      ['meta with a parameter', '/api/v1/meta?zzfoobar=1', 'unknown_parameter'],
      ['stations with a parameter', '/api/v1/stations?zzfoobar=1', 'unknown_parameter'],
      ['openapi with a parameter', '/api/v1/openapi.json?zzfoobar=1', 'unknown_parameter'],
      ['openapi with a repeated parameter', '/api/v1/openapi.json?zzfoobar=1&zzfoobar=2', 'repeated_parameter'],
      ['openapi with a value of 33 characters', `/api/v1/openapi.json?zzfoobar=${'x'.repeat(33)}`, 'bad_parameter'],
      // series: the id
      ['an id that is not a number', `/api/v1/series/abcdefgh?${span}`, 'bad_parameter'],
      ['a decimal id', `/api/v1/series/1.5?${span}`, 'bad_parameter'],
      ['id 0', `/api/v1/series/0?${span}`, 'bad_parameter'],
      ['a negative id', `/api/v1/series/-1?${span}`, 'bad_parameter'],
      ['an id with a leading zero', `/api/v1/series/0000007?${span}`, 'bad_parameter'],
      ['id 2147483648', `/api/v1/series/2147483648?${span}`, 'bad_parameter'],
      ['an id of 11 digits', `/api/v1/series/99999999999?${span}`, 'bad_parameter'],
      // series: from and to
      ['no from and to', `/api/v1/series/${sid('dst')}`, 'bad_parameter'],
      ['no from', series('to=2026-10-26T00:00:00Z'), 'bad_parameter'],
      ['no to', series('from=2026-10-25T00:00:00Z'), 'bad_parameter'],
      ['from equal to', series('from=2026-10-25T12:00:00Z&to=2026-10-25T12:00:00Z'), 'bad_parameter'],
      ['from after to', series('from=2026-10-25T12:00:00Z&to=2026-10-25T00:00:00Z'), 'bad_parameter'],
      ['from and to in one bucket', series('from=2026-10-25T12:00:01Z&to=2026-10-25T12:09:59Z'), 'bad_parameter'],
      ['to in lowercase', series('from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00z'), 'bad_parameter'],
      ['to with a second 60', series('from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:60Z'), 'bad_parameter'],
      ['to 10 min 1 s ahead of now', series('from=2026-10-25T12:00:00Z&to=2026-10-26T12:10:01Z'), 'out_of_range'],
      ['from before displayStart', series('from=2026-09-30T23:59:59Z&to=2026-10-02T00:00:00Z'), 'out_of_range'],
      // series: res and the span
      ['an unknown res', series(`${span}&res=2h`), 'bad_parameter'],
      ['an empty res', series(`${span}&res=`), 'bad_parameter'],
      ['res in capitals', series(`${span}&res=RAW`), 'bad_parameter'],
      ['a repeated res', series(`${span}&res=raw&res=1h`), 'repeated_parameter'],
      ['an unknown series parameter', series(`${span}&zzfoobar=1`), 'unknown_parameter'],
      ['15 days of raw', series('from=2026-10-10T00:00:00Z&to=2026-10-25T00:00:00Z&res=raw'), 'span_too_long'],
      [
        '14 days and 10 min of raw',
        series('from=2026-10-11T23:50:00Z&to=2026-10-26T00:00:00Z&res=raw'),
        'span_too_long',
      ],
    ]);
  });

  it('refuses a span over the cap of its resolution, and accepts a span at the cap', async () => {
    await setDisplayStart('2010-01-01T00:00:00Z');
    try {
      const app = appAt(NOW);
      const to = '2026-10-26T12:00:00Z';
      const from = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
      const path = (days: number, res = '') => `/api/v1/series/${sid('dst')}?from=${from(days)}&to=${to}${res}`;
      await expectRefused(app, [
        ['3661 days, no res', path(3661), 'span_too_long'],
        ['3661 days of 1d', path(3661, '&res=1d'), 'span_too_long'],
        ['6000 days of 1d', path(6000, '&res=1d'), 'span_too_long'],
        ['367 days of 1h', path(367, '&res=1h'), 'span_too_long'],
        ['15 days of raw', path(15, '&res=raw'), 'span_too_long'],
      ]);
      // At the cap: accepted, so the database is asked (a fresh cache per case: res=raw and no res share a key).
      const { connect } = spies();
      for (const [days, res, want] of [
        [14, 'raw', 'raw'],
        [366, '1h', '1h'],
        [3660, '1d', '1d'],
        [14, '', 'raw'],
        [15, '', '1h'],
        [366, '', '1h'],
        [367, '', '1d'],
        [3660, '', '1d'],
      ] as const) {
        const before = connect.mock.calls.length;
        const got = await get(appAt(NOW), path(days, res === '' ? '' : `&res=${res}`));
        expect(got.status, `${days} d ${res}`).toBe(200);
        const body = Series.parse(got.json());
        expect(body.res, `${days} d ${res}`).toBe(want);
        expect(body.truncated).toBe(false);
        expect(connect.mock.calls.length, `${days} d ${res}`).toBeGreaterThan(before);
      }
    } finally {
      await setDisplayStart('2026-10-01T00:00:00Z');
    }
  });

  it('accepts the boundaries of the range, and a request that is accepted does query', async () => {
    const { connect } = spies();
    const cases: [string, string][] = [
      ['t at now + 5 min', '/api/v1/snapshot?t=2026-10-26T12:05:00Z'],
      ['t at displayStart', '/api/v1/snapshot?t=2026-10-01T00:00:00Z'],
      ['t in the bucket of displayStart', '/api/v1/snapshot?t=2026-10-01T00:09:59Z'],
      ['t of 32 characters', '/api/v1/snapshot?t=2026-10-25T12:00:00.123456%2B01:00'],
    ];
    // The 32 characters 2026-10-25T12:00:00.123456+01:00 are 11:00:00 UTC.
    const expected = [
      '2026-10-26T12:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-10-25T11:00:00.000Z',
    ];
    for (const [i, [label, path]] of cases.entries()) {
      const before = connect.mock.calls.length;
      const res = await get(appAt(NOW), path);
      expect(res.status, label).toBe(200);
      expect(Snapshot.parse(res.json()).t, label).toBe(expected[i]);
      expect(connect.mock.calls.length, label).toBeGreaterThan(before);
    }

    // to at now + 10 min: the half-open [11:00, 12:10) holds the 11:50 value.
    const before = connect.mock.calls.length;
    const res = await get(appAt(NOW), `/api/v1/series/${sid('dst')}?from=2026-10-26T11:00:00Z&to=2026-10-26T12:10:00Z`);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      id: sid('dst'),
      from: '2026-10-26T11:00:00.000Z',
      to: '2026-10-26T12:10:00.000Z',
      truncated: false,
      res: 'raw',
      points: [{ ts: '2026-10-26T11:50:00.000Z', value: 444, qc: 1 }],
    });
    expect(connect.mock.calls.length).toBeGreaterThan(before);
    // The highest id is valid, and unknown.
    const top = await get(appAt(NOW), `/api/v1/series/2147483647?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z`);
    expect([top.status, top.text, top.cache]).toEqual([404, '{"error":"not_found"}', 'no-store']);
  });

  it('sends Cache-Control by the age of the quantised instant, never immutable and never a CORS header', async () => {
    const app = appAt(NOW);
    const heard: Got[] = [];
    const ok = async (path: string, cache: string) => {
      const res = await get(app, path, { headers: { Origin: 'https://example.org' } });
      heard.push(res);
      expect(res.status, path).toBe(200);
      expect(res.cache, path).toBe(cache);
      expect(res.headers.get('content-type'), path).toBe('application/json');
    };
    const snap = (instant: string) => `/api/v1/snapshot?t=${instant}`;
    await ok(snap('2026-10-26T12:00:00Z'), SWR);
    await ok(snap('2026-10-26T12:04:00Z'), SWR);
    await ok(snap('2026-10-26T11:50:00Z'), 'public, max-age=600');
    await ok(snap('2026-10-24T12:10:00Z'), 'public, max-age=600'); // 47 h 50 min
    await ok(snap('2026-10-24T12:09:59Z'), 'public, max-age=86400'); // floors to 12:00: exactly 48 h
    await ok(snap('2026-10-24T12:00:00Z'), 'public, max-age=86400'); // exactly 48 h
    await ok(snap('2026-10-02T00:00:00Z'), 'public, max-age=86400');
    const by = (to: string) => {
      const from = new Date(Date.parse(to) - DAY).toISOString();
      return `/api/v1/series/${sid('dst')}?from=${from}&to=${to}`;
    };
    await ok(by('2026-10-26T12:00:00Z'), SWR);
    await ok(by('2026-10-26T12:04:00Z'), SWR);
    await ok(by('2026-10-24T12:10:00Z'), 'public, max-age=600');
    await ok(by('2026-10-24T12:00:00Z'), 'public, max-age=86400');
    await ok(`${by('2026-10-26T12:00:00Z')}&res=1h`, SWR);
    await ok(`${by('2026-10-24T12:00:00Z')}&res=1d`, 'public, max-age=86400');
    await ok('/api/v1/meta', 'public, max-age=60');
    await ok('/api/v1/stations', 'public, max-age=300');
    await ok('/api/v1/openapi.json', 'public, max-age=300');
    await ok('/api/v1/health', 'public, max-age=30');
    await ok('/api/v1/health/sources', 'public, max-age=30');

    // Errors are never cached.
    const refused: [Got, number][] = [
      [await get(app, snap('2026-10-25T12:00:00')), 400],
      [await get(app, '/api/v1/nope'), 404],
      [await get(app, '/api/v1/meta/'), 404],
      [await get(app, `/api/v1/series/999999?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z`), 404],
      [await get(app, '/api/v1/meta', { method: 'POST' }), 405],
      [await get(app, snap('2026-10-25T12:00:00Z'), { method: 'PUT' }), 405],
      [await get(app, '/api/v1/health', { method: 'DELETE' }), 405],
      [await get(app, '/api/v1/nope', { method: 'PATCH' }), 405],
      [
        await get(app, '/api/v1/meta', {
          method: 'OPTIONS',
          headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET' },
        }),
        405,
      ],
    ];
    for (const [res, status] of refused) {
      heard.push(res);
      expect(res.status, res.text).toBe(status);
      expect(res.cache, res.text).toBe('no-store');
      if (status === 405) {
        expect(res.headers.get('allow')).toBe('GET, HEAD');
        expect(res.text).toBe('{"error":"method_not_allowed"}');
      }
      if (status === 404) expect(res.text).toBe('{"error":"not_found"}');
    }
    for (const res of heard) {
      for (const [name, value] of res.headers) {
        expect(value, name).not.toContain('immutable');
        expect(name.startsWith('access-control-'), name).toBe(false);
      }
    }
  });

  it('keys the cache by the quantised instant: the DST night, one query per canonical key', async () => {
    const app = appAt(NOW);
    const first = await get(app, '/api/v1/snapshot?t=2026-10-25T02:30%2B02:00');
    expect(first.status).toBe(200);
    const dstOf = (res: Got) => Snapshot.parse(res.json()).values.filter((v) => v.series === sid('dst'));
    expect(Snapshot.parse(first.json()).t).toBe('2026-10-25T00:30:00.000Z');
    expect(dstOf(first)).toEqual([
      { series: sid('dst'), ts: '2026-10-25T00:30:00.000Z', value: 111, qc: 2, ageSeconds: 0 },
    ]);
    const second = await get(app, '/api/v1/snapshot?t=2026-10-25T02:30%2B01:00');
    expect(Snapshot.parse(second.json()).t).toBe('2026-10-25T01:30:00.000Z');
    expect(dstOf(second)).toEqual([
      { series: sid('dst'), ts: '2026-10-25T01:30:00.000Z', value: 222, qc: 1, ageSeconds: 0 },
    ]);

    const fresh = appAt(NOW);
    const { connect } = spies();
    const a = await get(fresh, '/api/v1/snapshot?t=2026-10-25T00:30Z');
    const asked = connect.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    const b = await get(fresh, '/api/v1/snapshot?t=2026-10-25T00:39:59Z');
    expect(b.text).toBe(a.text);
    expect(connect.mock.calls.length).toBe(asked);
    // The same instant written as an offset is the same key.
    const c = await get(fresh, '/api/v1/snapshot?t=2026-10-25T02:35:00%2B02:00');
    expect(c.text).toBe(a.text);
    expect(connect.mock.calls.length).toBe(asked);
    // A second distinct key does ask.
    const d = await get(fresh, '/api/v1/snapshot?t=2026-10-25T00:40Z');
    expect(Snapshot.parse(d.json()).t).toBe('2026-10-25T00:40:00.000Z');
    expect(connect.mock.calls.length).toBeGreaterThan(asked);
  });

  it('shares one query between concurrent requests of one key', async () => {
    const app = appAt(NOW);
    const { connect } = spies();
    const all = await Promise.all(
      Array.from({ length: 20 }, () => get(app, '/api/v1/snapshot?t=2026-10-25T12:00:00Z')),
    );
    expect(new Set(all.map((r) => r.text)).size).toBe(1);
    expect(all.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 200));
    const asked = connect.mock.calls.length;
    expect(asked).toBe(1);
    // Another key opens its own query.
    await get(app, '/api/v1/snapshot?t=2026-10-25T12:10:00Z');
    expect(connect.mock.calls.length).toBe(2);
  });

  it('/series holds [from, to), floors both to the grid, and answers each resolution with its own fields', async () => {
    const app = appAt(NOW);
    const path = (q: string) => `/api/v1/series/${sid('dst')}?${q}`;
    // The 00:30 value is in, the 01:30 value is out; 00:39 floors to 00:30.
    const half = await get(app, path('from=2026-10-25T00:39:00Z&to=2026-10-25T01:30:00Z'));
    expect(half.json()).toEqual({
      id: sid('dst'),
      from: '2026-10-25T00:30:00.000Z',
      to: '2026-10-25T01:30:00.000Z',
      truncated: false,
      res: 'raw',
      points: [{ ts: '2026-10-25T00:30:00.000Z', value: 111, qc: 2 }],
    });
    const day = 'from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z';
    const raw = await get(app, path(day));
    expect(Series.parse(raw.json())).toEqual({
      id: sid('dst'),
      from: '2026-10-25T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
      truncated: false,
      res: 'raw',
      points: [
        { ts: '2026-10-25T00:30:00.000Z', value: 111, qc: 2 },
        { ts: '2026-10-25T01:30:00.000Z', value: 222, qc: 1 },
        { ts: '2026-10-25T12:00:00.000Z', value: 333, qc: 5 },
      ],
    });
    expect(Series.parse((await get(app, path(`${day}&res=raw`))).json())).toEqual(Series.parse(raw.json()));
    const hourly = await get(app, path(`${day}&res=1h`));
    expect(hourly.json()).toEqual({
      id: sid('dst'),
      from: '2026-10-25T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
      truncated: false,
      res: '1h',
      points: [
        { bucket: '2026-10-25T00:00:00.000Z', vmin: 111, vmax: 111, vavg: 111, vlast: 111, n: 1, qcOr: 2 },
        { bucket: '2026-10-25T01:00:00.000Z', vmin: 222, vmax: 222, vavg: 222, vlast: 222, n: 1, qcOr: 1 },
      ],
    });
    const daily = await get(app, path('from=2026-10-24T00:00:00Z&to=2026-10-26T00:00:00Z&res=1d'));
    expect(daily.json()).toEqual({
      id: sid('dst'),
      from: '2026-10-24T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
      truncated: false,
      res: '1d',
      points: [
        { bucket: '2026-10-24T00:00:00.000Z', vmin: 50, vmax: 50, vavg: 50, vlast: 50, n: 1, qcOr: 1 },
        { bucket: '2026-10-25T00:00:00.000Z', vmin: 111, vmax: 333, vavg: 222, vlast: 333, n: 3, qcOr: 7 },
      ],
    });
    // Without res: the finest resolution whose cap holds the span (20 days is over the raw cap of 14).
    const wide = await get(app, path('from=2026-10-06T12:00:00Z&to=2026-10-26T12:00:00Z'));
    expect(Series.parse(wide.json()).res).toBe('1h');
  });

  it('cuts an answer at 20,000 points and says so', async () => {
    const app = appAt(NOW);
    const path = (q: string) => `/api/v1/series/${sid('dense')}?${q}`;
    // 14 days, one value a minute: 20,160 values exist.
    const cut = Series.parse((await get(app, path('from=2026-10-12T00:00:00Z&to=2026-10-26T00:00:00Z'))).json());
    expect(cut).toMatchObject({ res: 'raw', truncated: true });
    expect(cut.points).toHaveLength(20_000);
    const points = cut.points as { ts: string; value: number; qc: number }[];
    expect(points[0]).toEqual({ ts: '2026-10-12T00:00:00.000Z', value: 0, qc: 1 });
    expect(points[19_999]).toEqual({ ts: '2026-10-25T21:19:00.000Z', value: 19_999, qc: 1 });
    // Ascending: the cut drops the end of the span, not its start.
    expect(points.every((p, i) => i === 0 || p.ts > (points[i - 1] as { ts: string }).ts)).toBe(true);
    // An hour of it is whole.
    const hour = Series.parse((await get(app, path('from=2026-10-25T00:00:00Z&to=2026-10-25T01:00:00Z'))).json());
    expect(hour.truncated).toBe(false);
    expect(hour.points).toHaveLength(60);
    const hourPoints = hour.points as { ts: string; value: number }[];
    expect(hourPoints[0]).toMatchObject({ ts: '2026-10-25T00:00:00.000Z', value: 18_720 });
    expect(hourPoints[59]).toMatchObject({ ts: '2026-10-25T00:59:00.000Z', value: 18_779 });
  });

  it('answers 200 bodies that match their contracts; meta carries the build and the window of app_meta', async () => {
    const app = appAt(NOW);
    const meta = await get(app, '/api/v1/meta');
    expect(Meta.parse(meta.json())).toEqual({
      now: '2026-10-26T12:00:00.000Z',
      dataEpoch: '2026-10-02T00:00:00.000Z',
      displayStart: '2026-10-01T00:00:00.000Z',
      build: 'dev',
      // The public sources with an active display series; CH-2 has no display channel.
      sources: [
        { id: 'CH-1', attribution: [] },
        { id: 'CH-3', attribution: [] },
        { id: 'CH-4', attribution: [] },
        { id: 'DE-1', attribution: [] },
        {
          id: 'NL-1',
          attribution: [{ lang: 'nl', text: 'PUBLIC-ATTRIBUTION', url: null, required: false, needsDate: false }],
        },
      ],
    });
    const stored = Object.fromEntries(
      (
        await t.admin.query<{ key: string; v: string }>(
          `SELECT key, value #>> '{}' AS v FROM app_meta WHERE key IN ('display_start', 'data_epoch')`,
        )
      ).rows.map((r) => [r.key, new Date(r.v).toISOString()]),
    );
    expect(stored).toEqual({ display_start: '2026-10-01T00:00:00.000Z', data_epoch: '2026-10-02T00:00:00.000Z' });
    // The build is the value passed in.
    const build = 'abcdef0123456789abcdef0123456789abcdef01';
    expect(Meta.parse((await get(appAt(NOW, { build }), '/api/v1/meta')).json()).build).toBe(build);

    expect(Snapshot.parse((await get(app, '/api/v1/snapshot?t=2026-10-25T01:30Z')).json()).t).toBe(
      '2026-10-25T01:30:00.000Z',
    );
    expect(Health.parse((await get(app, '/api/v1/health')).json()).sources.total).toBeGreaterThan(0);
    expect(HealthSources.parse((await get(app, '/api/v1/health/sources')).json()).sources.length).toBeGreaterThan(0);
    const doc = (await get(app, '/api/v1/openapi.json')).json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/v1/health',
      '/api/v1/health/sources',
      '/api/v1/meta',
      '/api/v1/openapi.json',
      '/api/v1/series/{id}',
      '/api/v1/snapshot',
      '/api/v1/stations',
    ]);
  });

  it('/stations lists the display channel: active primary series of public sources, with units and data since', async () => {
    const app = appAt(NOW);
    const res = await get(app, '/api/v1/stations');
    expect(res.status).toBe(200);
    // dataSince is the first UTC day of the daily rollup the display channel shows: the history window of CH-3
    // hides its day 40 days back.
    const since = async (key: string) => {
      const { rows } = await t.admin.query<{ d: Date | null }>(
        `SELECT ${key === 'window' ? 'max' : 'min'}(bucket) AS d FROM obs_1d WHERE series_id = $1`,
        [sid(key)],
      );
      return rows[0]?.d?.toISOString() ?? null;
    };
    const station = async (
      id: string,
      name: string,
      country: string,
      tier: number,
      key: string,
      source: string,
      step: number,
      dataSince?: string | null,
    ) => ({
      id,
      name,
      waterName: null,
      country,
      lon: null,
      lat: null,
      tier,
      flags: { tidal: null, impounded: null },
      series: [
        {
          id: sid(key),
          source,
          quantity: 'H',
          valueKind: 'stage',
          unit: 'cm',
          datum: 'LOCAL',
          nativeUnit: 'cm',
          expectedStepSeconds: step,
          stalenessLimitSeconds: 2700,
          dataSince: dataSince === undefined ? await since(key) : dataSince,
        },
      ],
    });
    expect(Stations.parse(res.json())).toEqual({
      stations: [
        await station('ch.bafu.display-only', 'display only', 'CH', 2, 'displayOnly', 'CH-1', 900),
        await station('ch.bafu.window', 'history window', 'CH', 2, 'window', 'CH-3', 900),
        await station('ch.bafu.window-export', 'history window with export', 'CH', 2, 'windowExport', 'CH-4', 900),
        await station('de.wsv.no-api', 'series without api', 'DE', 2, 'noApi', 'DE-1', 900),
        await station('nl.rws.dense', 'Dense', 'NL', 2, 'dense', 'NL-1', 60, null),
        await station('nl.rws.dst', 'DST', 'NL', 1, 'dst', 'NL-1', 900, '2026-10-24T00:00:00.000Z'),
        await station('nl.rws.public', 'Public', 'NL', 1, 'public', 'NL-1', 900),
        await station('nl.rws.public2', 'Public 2', 'NL', 1, 'public2', 'NL-1', 900),
      ],
    });
    // The two dates the rollups give: today's bucket for the windowed series, 40 days back for the others.
    const dates = Stations.parse(res.json()).stations.map((s) => s.series[0]?.dataSince);
    expect(dates[1]).not.toBe(dates[2]);
    expect(Date.parse(dates[2] as string)).toBeLessThan(Date.parse(dates[1] as string));
  });

  it('answers HEAD like GET without a body', async () => {
    const app = appAt(NOW);
    for (const [path, status, cache] of [
      ['/api/v1/snapshot?t=2026-10-26T12:00:00Z', 200, SWR],
      ['/api/v1/snapshot?t=2026-10-24T12:00:00Z', 200, 'public, max-age=86400'],
      [`/api/v1/series/${sid('dst')}?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z`, 200, 'public, max-age=600'],
      ['/api/v1/meta', 200, 'public, max-age=60'],
      ['/api/v1/stations', 200, 'public, max-age=300'],
      ['/api/v1/openapi.json', 200, 'public, max-age=300'],
      ['/api/v1/snapshot?t=bad', 400, 'no-store'],
      ['/api/v1/nope', 404, 'no-store'],
    ] as const) {
      const full = await get(app, path);
      const head = await get(app, path, { method: 'HEAD' });
      expect(full.status, path).toBe(status);
      expect(head.status, path).toBe(status);
      expect(full.text, path).not.toBe('');
      expect(head.text, path).toBe('');
      expect(head.cache, path).toBe(cache);
      expect(full.cache, path).toBe(cache);
    }
  });
});

describe('without the display window', () => {
  it('answers 503 unavailable with no query, while /stations and the query checks still work', async () => {
    const cold = new DisplayWindow(api.db);
    expect(cold.current).toBeUndefined();
    const app = createApp({ db: api.db, window: cold, now: () => NOW });
    const { connect, query } = spies();
    for (const path of [
      '/api/v1/snapshot?t=2026-10-25T12:00:00Z',
      `/api/v1/series/${sid('dst')}?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z`,
      '/api/v1/meta',
    ]) {
      const res = await get(app, path);
      expect(res.status, path).toBe(503);
      expect(res.text, path).toBe('{"error":"unavailable"}');
      expect(res.cache, path).toBe('no-store');
    }
    // These need no window: validated first, with no query.
    for (const path of ['/api/v1/meta?zzfoobar=1', '/api/v1/stations?zzfoobar=1']) {
      const res = await get(app, path);
      expect([res.status, res.text, res.cache], path).toEqual([400, '{"error":"unknown_parameter"}', 'no-store']);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    // /stations needs the database, not the window.
    const stations = await get(app, '/api/v1/stations');
    expect(stations.status).toBe(200);
    expect(Stations.parse(stations.json()).stations.length).toBeGreaterThan(0);
    expect(connect).toHaveBeenCalled();
    // The OpenAPI document needs neither.
    const doc = await get(createApp(), '/api/v1/openapi.json');
    expect(doc.status).toBe(200);
    expect((doc.json() as { openapi: string }).openapi).toBe('3.1.0');
  });
});

describe('the api role of main.ts', () => {
  it('loads the display window before it listens: its very first request is served', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const child = spawnSync(
      process.execPath,
      ['--no-experimental-webstorage', new URL('./api-child.ts', import.meta.url).pathname],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: process.env.PATH, DATABASE_URL: t.urlFor('rws_api'), HOST: '127.0.0.1', PORT: String(port) },
      },
    );
    const lines = child.stdout
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const answer = lines.find((l) => 'status' in l) as { status: number; body: string } | undefined;
    // Until the first load the window answers 503, and start() tries again only after 10 s.
    expect(answer?.status, child.stdout + child.stderr).toBe(200);
    expect(Meta.parse(JSON.parse(answer?.body ?? '')).displayStart).toBe(
      new Date(display.current?.displayStartMs ?? 0).toISOString(),
    );
    expect(lines.at(-1)).toEqual({ exit: 0 });
  });
});

describe('on the real clock: channels and canaries', () => {
  /** The three instants the fixture stores observations at: 40 days back, 10 days back and the current hour. */
  let hours: Date[];
  const app = () => createApp({ db: api.db, window: display, now: () => new Date() });
  const mine = new Set<number>();
  const keysOf = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.flatMap(keysOf)
      : v !== null && typeof v === 'object'
        ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)])
        : [];
  /** No secret, no canary and no private_basis in a body, and no such key in its JSON. */
  const clean = (label: string, text: string) => {
    for (const term of [...NEVER_PUBLIC, ...CANARY_RENDERINGS]) expect(text, `${label}: ${term}`).not.toContain(term);
    for (const key of keysOf(JSON.parse(text))) expect(key, label).not.toMatch(/private_basis|clause/i);
  };

  beforeAll(async () => {
    for (const key of MY_SERIES) mine.add(sid(key));
    await setDisplayStart(new Date(Date.now() - 50 * DAY).toISOString());
    const { rows } = await t.admin.query<{ ts: Date }>('SELECT ts FROM obs WHERE series_id = $1 ORDER BY ts', [
      sid('public'),
    ]);
    hours = rows.map((r) => r.ts);
    expect(hours).toHaveLength(3);
  });

  const HIDDEN = [
    'ownerCanary',
    'withheld',
    'narrowedOwner',
    'narrowedOff',
    'onlyOwner',
    'mirror',
    'twin',
    'noDisplay',
    'widenAudience',
    'inactive',
  ];
  const DISPLAYED = ['public', 'public2', 'noApi', 'displayOnly', 'window', 'windowExport'];

  it('/snapshot shows the display channel only: api-off series are in, owner, off, mirror, twin and inactive are not', async () => {
    const instants = [
      // 40 days back: the history window of CH-3 (30 days, no history export) hides its value.
      { at: hours[0] as Date, keys: DISPLAYED.filter((k) => k !== 'window') },
      { at: hours[1] as Date, keys: DISPLAYED },
      { at: hours[2] as Date, keys: DISPLAYED },
    ];
    for (const { at, keys } of instants) {
      const iso = at.toISOString();
      const res = await get(app(), `/api/v1/snapshot?t=${iso}`);
      expect(res.status, iso).toBe(200);
      clean(iso, res.text);
      const body = Snapshot.parse(res.json());
      expect(body.t).toBe(iso);
      // Only the fixture's series: the fixed-clock series of this file hold values in October 2026.
      const values = body.values.filter((v) => !mine.has(v.series));
      expect(values, iso).toEqual(
        keys
          .map(sid)
          .sort((a, b) => a - b)
          .map((series) => ({ series, ts: iso, value: 100, qc: 1, ageSeconds: 0 })),
      );
      for (const key of HIDDEN)
        expect(
          body.values.map((v) => v.series),
          `${iso} ${key}`,
        ).not.toContain(sid(key));
    }
  });

  it('/series answers the api channel only: display-only, inactive and every non-public series are 404', async () => {
    const instant = (ms: number) => new Date(ms).toISOString();
    const from = instant(Date.now() - 13 * DAY);
    const to = instant(Date.now() + 10 * 60_000);
    const from1d = instant(Date.now() - 45 * DAY);
    const served = ['public', 'public2', 'window', 'windowExport', 'dst', 'dense'];
    const buckets = async (key: string) =>
      (
        await t.admin.query<{ bucket: Date }>('SELECT bucket FROM obs_1d WHERE series_id = $1 ORDER BY bucket', [
          sid(key),
        ])
      ).rows.map((r) => r.bucket.toISOString());
    const live = app();
    for (const key of Object.keys(ids)) {
      const id = sid(key);
      const raw = await get(live, `/api/v1/series/${id}?from=${from}&to=${to}`);
      const daily = await get(live, `/api/v1/series/${id}?from=${from1d}&to=${to}&res=1d`);
      if (!served.includes(key)) {
        for (const res of [raw, daily]) {
          expect([res.status, res.text, res.cache], key).toEqual([404, '{"error":"not_found"}', 'no-store']);
        }
        continue;
      }
      expect(raw.status, key).toBe(200);
      expect(daily.status, key).toBe(200);
      clean(key, raw.text);
      clean(key, daily.text);
      if (MY_SERIES.includes(key)) continue;
      // Rows 10 days back and now; the 40 day row is outside the span (and, for CH-3, outside its window).
      expect(Series.parse(raw.json()).points, key).toEqual(
        [hours[1], hours[2]].map((h) => ({ ts: (h as Date).toISOString(), value: 100, qc: 1 })),
      );
      // Rollup days: 40 days back and today; CH-3's window hides the first.
      const days = (await buckets(key)).slice(key === 'window' ? -1 : 0);
      expect(Series.parse(daily.json()).points, key).toEqual(
        days.map((bucket) => ({ bucket, vmin: 100, vmax: 100, vavg: 100, vlast: 100, n: 1, qcOr: 1 })),
      );
    }
    const none = await get(live, `/api/v1/series/${Math.max(...Object.values(ids)) + 1}?from=${from}&to=${to}`);
    expect([none.status, none.text]).toEqual([404, '{"error":"not_found"}']);
  });

  it('/meta and /stations name no owner, off, mirror, twin or inactive series, source or attribution', async () => {
    const meta = await get(app(), '/api/v1/meta');
    clean('meta', meta.text);
    const body = Meta.parse(meta.json());
    expect(Math.abs(Date.parse(body.now) - Date.now())).toBeLessThan(60_000);
    expect(body.displayStart).toBe(new Date(display.current?.displayStartMs ?? 0).toISOString());
    expect(body.sources.map((s) => s.id)).toEqual(['CH-1', 'CH-3', 'CH-4', 'DE-1', 'NL-1']);
    expect(body.sources.find((s) => s.id === 'NL-1')?.attribution.map((a) => a.text)).toEqual(['PUBLIC-ATTRIBUTION']);
    expect(body.sources.filter((s) => s.id !== 'NL-1').flatMap((s) => s.attribution)).toEqual([]);

    const stations = await get(app(), '/api/v1/stations');
    clean('stations', stations.text);
    const all = Stations.parse(stations.json()).stations;
    const seen = all.flatMap((s) => s.series.map((x) => x.id));
    expect(seen.sort((a, b) => a - b)).toEqual([...DISPLAYED, ...MY_SERIES].map(sid).sort((a, b) => a - b));
    for (const key of HIDDEN) expect(seen, key).not.toContain(sid(key));
    for (const s of all.flatMap((x) => x.series)) expect(s.unit).toBe(s.quantity === 'H' ? 'cm' : 'm³/s');
    expect(all.flatMap((x) => x.series).every((s) => s.quantity === 'H' && s.unit === 'cm')).toBe(true);
  });

  it('the documents and health leak nothing either', async () => {
    for (const path of ['/api/v1/openapi.json', '/api/v1/health', '/api/v1/health/sources']) {
      const res = await get(app(), path);
      expect(res.status, path).toBe(200);
      clean(path, res.text);
    }
  });
});

describe('nothing this file received leaks', () => {
  it('holds no secret, canary or private_basis in any body, 4xx and 5xx included', () => {
    expect(everything.length).toBeGreaterThan(150);
    for (const { label, text } of everything) {
      for (const term of [...NEVER_PUBLIC, ...CANARY_RENDERINGS]) expect(text, `${label}: ${term}`).not.toContain(term);
      expect(text, label).not.toMatch(/private_basis|SECRET/);
    }
  });

  it('sent no CORS header and no immutable cache directive, whatever the status', () => {
    for (const { label, headers } of everything) {
      for (const [name, value] of headers) {
        expect(name.startsWith('access-control-'), `${label}: ${name}`).toBe(false);
        expect(value, `${label}: ${name}`).not.toContain('immutable');
      }
    }
  });
});
