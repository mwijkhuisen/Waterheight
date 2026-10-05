import { CANARIES } from '@rws/contracts';
import {
  OwnerHealthAnswer,
  OwnerHealthSourcesAnswer,
  OwnerMetaAnswer,
  OwnerSeriesAnswer,
  OwnerSeriesForecastAnswer,
  OwnerSnapshotAnswer,
  OwnerStationsAnswer,
} from '@rws/contracts/api-owner';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DayVersions } from '../../src/api/versions.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { FORECAST_AT, OBS_AT, OWNER_ONLY_VIEWS, PUBLIC_ONLY_VIEWS, VIEWS } from '../../src/db/audience.ts';
import type { Db } from '../../src/db/pool.ts';
import { API_POOL, openApiDb } from '../../src/main.ts';
import { NEVER_OWNER, OWNER_CANARY_REAL, seedAudienceFixture } from '../db/seed.ts';
import { createTestDb, sqlState, type TestDb } from '../db/testdb.ts';
import { ask, CODINGS, captureLog, iso, type Req } from './sweep.ts';

// P9b (plan 4.9, C15; issue #24 task 10): the owner API `api --audience owner` as the real rws_owner_api login: the
// same routes with `audience: "owner"` in every answer, the owner wire schemas, `Cache-Control: private, no-store`
// whatever `v` says, attribution that names the owner sources the body holds, a pool of at most 2 connections, the two
// roles' grants, and the public API's refusal to tell an owner-only series from an unknown one.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const HOUR_START = Math.floor(NOW / HOUR) * HOUR;

let t: TestDb;
let ids: Record<string, number>;
let ownerDb: Db;
let publicDb: Db;
let owner: ReturnType<typeof createApp>;
let pub: ReturnType<typeof createApp>;
let versions: DayVersions;
const logs: string[] = [];
const get = (path: string): Req => ({ path, label: path });
const json = async (app: ReturnType<typeof createApp>, path: string) => {
  const a = await ask(app, get(path), 'identity');
  return { ...a, body: JSON.parse(a.text) as Record<string, unknown> };
};

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  await t.admin.query(`
    INSERT INTO attribution (source_id, ord, lang, text, needs_date, date_kind, required) VALUES
      ('DE-1', 0, 'de', 'DE1-ATTRIBUTION', false, NULL, false),
      ('CH-1', 0, 'de', 'CH1-ATTRIBUTION', true, 'retrieval', true),
      ('BE-3', 0, 'fr', 'Sources des donnees : Service public de Wallonie (SPW)', false, NULL, true),
      ('DE-2', 0, 'de', 'BfG-CREDIT', false, NULL, true),
      ('CANARY-OWNER', 0, 'nl', 'OWNERCANARY-ATTRIBUTION', false, NULL, true)`);
  await t.admin.query(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [
    iso(NOW - 50 * DAY),
  ]);
  // Runs issued before the current bucket, so that the default asof (now's bucket) sees them: the owner canary's own,
  // and an owner run (DE-2, the BfG credit) on a public series.
  for (const [series, source, value] of [
    [ids.ownerCanary, 'CANARY-OWNER', CANARIES.owner.value],
    [ids.public, 'DE-2', 201],
  ] as const) {
    const run = await t.admin.query<{ id: string }>(
      `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
       VALUES ($1::int, $2::text, $3::timestamptz, $3::timestamptz, $4::timestamptz, $3::timestamptz,
               decode(md5('p9b-owner-' || $2::text), 'hex'), 'deterministic') RETURNING id`,
      [series, source, iso(NOW - 2 * HOUR), iso(NOW + 6 * HOUR)],
    );
    await t.admin.query(
      `INSERT INTO forecast_value (run_id, valid_ts, value)
       SELECT $1, $2::timestamptz + g * interval '1 hour', $3::real FROM generate_series(0, 8) g`,
      [(run.rows[0] as { id: string }).id, iso(NOW - 2 * HOUR), value],
    );
  }
  const owned = openApiDb({ DATABASE_URL: t.urlFor('rws_owner_api') }, undefined, 'owner');
  const open = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
  if (typeof owned === 'string' || typeof open === 'string') throw new Error('no database');
  ownerDb = owned;
  publicDb = open;
  const ownerWindow = new DisplayWindow(ownerDb.db, undefined, 'owner');
  expect(await ownerWindow.refresh()).toBe(true);
  versions = new DayVersions(ownerDb.db, 'owner');
  expect(await versions.refresh()).toBe(true);
  const publicWindow = new DisplayWindow(publicDb.db);
  expect(await publicWindow.refresh()).toBe(true);
  const log = captureLog(logs);
  owner = createApp({
    family: 'owner',
    db: ownerDb.db,
    window: ownerWindow,
    versions,
    now: () => new Date(NOW),
    log,
    beaconLog: log,
  });
  pub = createApp({ db: publicDb.db, window: publicWindow, now: () => new Date(NOW), log });
}, 120_000);

afterAll(async () => {
  versions?.stop();
  await Promise.allSettled([ownerDb?.close(), publicDb?.close()]);
  await t?.drop();
});

describe('the owner API serves every route as the owner role', () => {
  const win = () => `from=${iso(NOW - 13 * DAY)}&to=${iso(NOW)}`;
  const PRIVATE = 'private, no-store';

  it('/meta, /stations, /snapshot (now, past, with v, future), /series, /series/{id}/forecast: audience "owner", the owner wire schema, private no-store', async () => {
    const cases: [string, (b: unknown) => unknown][] = [
      ['/api/v1/meta', (b) => OwnerMetaAnswer.parse(b)],
      ['/api/v1/stations', (b) => OwnerStationsAnswer.parse(b)],
      [`/api/v1/snapshot?t=${iso(HOUR_START)}`, (b) => OwnerSnapshotAnswer.parse(b)],
      [`/api/v1/snapshot?t=${iso(HOUR_START - 10 * DAY)}`, (b) => OwnerSnapshotAnswer.parse(b)],
      [`/api/v1/snapshot?t=${iso(HOUR_START - 10 * DAY)}&v=1`, (b) => OwnerSnapshotAnswer.parse(b)],
      [`/api/v1/snapshot?t=${iso(NOW + 3 * HOUR)}`, (b) => OwnerSnapshotAnswer.parse(b)],
      [`/api/v1/series/${ids.ownerCanary}?${win()}`, (b) => OwnerSeriesAnswer.parse(b)],
      [`/api/v1/series/${ids.onlyOwner}?${win()}&v=1`, (b) => OwnerSeriesAnswer.parse(b)],
      [
        `/api/v1/series/${ids.public}?from=${iso(NOW - 45 * DAY)}&to=${iso(NOW)}&res=1d&v=1`,
        (b) => OwnerSeriesAnswer.parse(b),
      ],
      [`/api/v1/series/${ids.ownerCanary}/forecast`, (b) => OwnerSeriesForecastAnswer.parse(b)],
      [`/api/v1/series/${ids.public}/forecast`, (b) => OwnerSeriesForecastAnswer.parse(b)],
      ['/api/v1/health', (b) => OwnerHealthAnswer.parse(b)],
      ['/api/v1/health/sources', (b) => OwnerHealthSourcesAnswer.parse(b)],
    ];
    for (const [path, parse] of cases) {
      for (const coding of CODINGS) {
        const a = await ask(owner, get(path), coding);
        expect(a.status, `${path} [${coding}]`).toBe(200);
        const body = JSON.parse(a.text) as Record<string, unknown>;
        expect(body.audience, path).toBe('owner');
        expect(() => parse(body), path).not.toThrow();
        expect(a.headerMap['cache-control'], path).toBe(PRIVATE);
        expect(a.headers, path).not.toMatch(/access-control|immutable|public/i);
      }
    }
  });

  it('a correct v on a settled day is still private, no-store (the app sends it itself: invariant 11)', async () => {
    expect(versions.loaded).toBe(true);
    const past = HOUR_START - 10 * DAY;
    for (const path of [
      `/api/v1/snapshot?t=${iso(past)}&v=${versions.versionOf(iso(past).slice(0, 10))}`,
      `/api/v1/series/${ids.public}?from=${iso(past - DAY)}&to=${iso(past)}&v=1`,
    ]) {
      const a = await ask(owner, get(path), 'identity');
      expect([a.status, a.headerMap['cache-control']], path).toEqual([200, PRIVATE]);
    }
    // The same request of the public API is the immutable one's age class, never immutable here without a bumped day.
    const openapi = await ask(owner, get('/api/v1/openapi.json'), 'identity');
    expect(openapi.headerMap['cache-control']).toBe(PRIVATE);
  });

  it('/openapi.json is the owner document: the owner schemas with audience and the owner title', async () => {
    const doc = (await json(owner, '/api/v1/openapi.json')).body as {
      info: { title: string };
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(doc.info.title).toBe('Waterheight owner API');
    expect(doc.components.schemas.Snapshot?.properties).toHaveProperty('audience');
    const publicDoc = (await json(pub, '/api/v1/openapi.json')).body as typeof doc;
    expect(publicDoc.info.title).not.toBe(doc.info.title);
    expect(publicDoc.components.schemas.Snapshot?.properties).not.toHaveProperty('audience');
  });

  it('shows the owner sources and their attribution where the body names them (SPW, BfG, the canary), and none of the off rows', async () => {
    const snap = await json(owner, `/api/v1/snapshot?t=${iso(HOUR_START)}`);
    const text = snap.text;
    expect(text).toContain(OWNER_CANARY_REAL);
    const sources = (snap.body.attribution as { source: string; text: string }[]).map((a) => a.source);
    expect(sources).toContain('CANARY-OWNER');
    expect(sources).toContain('BE-3');
    expect(sources).toContain('NL-1');
    expect((snap.body.attribution as { text: string }[]).map((a) => a.text)).toContain('OWNERCANARY-ATTRIBUTION');
    expect((snap.body.attribution as { text: string }[]).map((a) => a.text)).toContain(
      'Sources des donnees : Service public de Wallonie (SPW)',
    );
    // /series of the canary: its own source; /forecast of it: the run's source.
    const series = await json(owner, `/api/v1/series/${ids.ownerCanary}?${win()}`);
    expect((series.body.attribution as { source: string }[]).map((a) => a.source)).toEqual(['CANARY-OWNER']);
    expect(series.text).toContain(OWNER_CANARY_REAL);
    const run = await json(owner, `/api/v1/series/${ids.ownerCanary}/forecast`);
    expect((run.body.attribution as { source: string }[]).map((a) => a.source)).toEqual(['CANARY-OWNER']);
    expect(run.text).toContain(OWNER_CANARY_REAL);
    // An owner run (DE-2) on a public series: the owner API names it and its credit; the public API never does.
    const bfg = await json(owner, `/api/v1/series/${ids.public}/forecast`);
    expect((bfg.body.attribution as { source: string }[]).map((a) => a.source).sort()).toEqual(['DE-2', 'NL-1']);
    expect((bfg.body.run as { source: string }).source).toBe('DE-2');
    expect((await json(pub, `/api/v1/series/${ids.public}/forecast`)).text).not.toMatch(/DE-2|BfG/);
    // The owner API holds the public rows too, and none of the withheld ones.
    const everything = [
      snap.text,
      series.text,
      (await json(owner, '/api/v1/stations')).text,
      (await json(owner, '/api/v1/meta')).text,
    ];
    for (const body of everything) for (const never of NEVER_OWNER) expect(body, never).not.toContain(never);
    const stations = (await json(owner, '/api/v1/stations')).body as { stations: { id: string }[] };
    expect(stations.stations.map((s) => s.id)).toEqual(
      expect.arrayContaining(['nl.canary.owner', 'be.spw.only-owner', 'nl.rws.public']),
    );
  });

  it('the owner API is as strict as the public one: the same refusals, with an empty attribution, never cached', async () => {
    for (const [path, status, code] of [
      ['/api/v1/snapshot?t=bad', 400, 'bad_parameter'],
      [`/api/v1/snapshot?t=${iso(HOUR_START)}&zz=1`, 400, 'unknown_parameter'],
      [`/api/v1/series/${ids.ownerCanary}/forecast?v=1`, 400, 'unknown_parameter'],
      ['/api/v1/series/99999999?from=2026-10-01T00:00Z&to=2026-10-02T00:00Z', 404, 'not_found'],
      ['/api/v1/nope', 404, 'not_found'],
    ] as const) {
      const a = await ask(owner, get(path), 'identity');
      expect(a.status, path).toBeGreaterThanOrEqual(400);
      expect([a.status, a.text], path).toEqual([status, `{"error":"${code}","attribution":[]}`]);
      expect(a.headerMap['cache-control'], path).toBe('no-store');
    }
    // The owner API is as strict about methods: no export, no write.
    const post = await ask(owner, { method: 'POST', path: '/api/v1/snapshot', body: '{}', label: 'post' }, 'identity');
    expect([post.status, post.headerMap.allow]).toEqual([405, 'GET, HEAD']);
    for (const path of ['/api/v1/export', '/api/v1/export.csv', '/api/v1/series/1/export', '/api/v1/download'])
      expect((await ask(owner, get(path), 'identity')).status, path).toBe(404);
  });
});

describe('the public API tells an owner-only series from an unknown or an api-off one in no way', () => {
  it('answers a byte-identical 404, body and headers, for /series and /series/{id}/forecast, in every coding', async () => {
    const unknown = Math.max(...Object.values(ids)) + 1000;
    const win = `from=${iso(NOW - 13 * DAY)}&to=${iso(NOW)}`;
    const hidden = ['onlyOwner', 'ownerCanary', 'narrowedOwner', 'noApi', 'displayOnly', 'withheld', 'mirror'] as const;
    for (const coding of CODINGS) {
      for (const [route, query] of [
        ['', `?${win}`],
        ['/forecast', ''],
      ] as const) {
        const reference = await ask(pub, get(`/api/v1/series/${unknown}${route}${query}`), coding);
        expect(reference.status).toBe(404);
        expect(reference.text).toBe('{"error":"not_found","attribution":[]}');
        for (const key of hidden) {
          const a = await ask(pub, get(`/api/v1/series/${ids[key]}${route}${query}`), coding);
          expect(a.status, `${key} ${route}`).toBe(404);
          expect(a.text, `${key} ${route}`).toBe(reference.text);
          expect(a.headerMap, `${key} ${route} headers`).toEqual(reference.headerMap);
        }
      }
    }
    // The owner API does know the owner-only ones (the same ids answer 200 there).
    for (const key of ['onlyOwner', 'ownerCanary', 'narrowedOwner'] as const)
      expect((await ask(owner, get(`/api/v1/series/${ids[key]}?${win}`), 'identity')).status, key).toBe(200);
  });
});

describe('the pool of the owner api', () => {
  it('is rws_owner_api through a pool of 2: read-only, a 2 s statement timeout, a role limit that leaves the publisher room', async () => {
    expect(API_POOL.owner).toBe(2);
    expect(ownerDb.pool.options.max).toBe(2);
    const { rows } = await ownerDb.pool.query(
      'SELECT current_user AS u, current_setting($1) AS timeout, current_setting($2) AS read_only',
      ['statement_timeout', 'default_transaction_read_only'],
    );
    expect(rows).toEqual([{ u: 'rws_owner_api', timeout: '2s', read_only: 'on' }]);
    const limit = await t.admin.query<{ n: number }>(
      `SELECT rolconnlimit AS n FROM pg_roles WHERE rolname = 'rws_owner_api'`,
    );
    // 4 for the role: this pool (2) and the owner publisher's (2).
    expect(limit.rows[0]?.n).toBe(4);
  });

  it('never holds more than 2 connections under 10 concurrent distinct computations; the rest are 200 or a fixed 503 busy', async () => {
    // Load the window of this app through the same pool before the burst.
    const window = new DisplayWindow(ownerDb.db, undefined, 'owner');
    expect(await window.refresh()).toBe(true);
    const app = createApp({ family: 'owner', db: ownerDb.db, window, now: () => new Date(NOW) });
    let peakPool = 0;
    let peakServer = 0;
    const timer = setInterval(() => {
      peakPool = Math.max(peakPool, ownerDb.pool.totalCount);
      void t.admin
        .query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'rws_owner_api'`)
        .then((r) => {
          peakServer = Math.max(peakServer, r.rows[0]?.n ?? 0);
        });
    }, 3);
    try {
      const all = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          ask(app, get(`/api/v1/snapshot?t=${iso(HOUR_START - (i + 3) * HOUR)}`), 'identity'),
        ),
      );
      const statuses = all.map((a) => a.status);
      expect(
        statuses.every((s) => s === 200 || s === 503),
        statuses.join(),
      ).toBe(true);
      expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(2);
      for (const a of all.filter((x) => x.status === 503)) {
        expect(a.text).toBe('{"error":"busy","attribution":[]}');
        expect(a.headerMap['retry-after']).toBe('2');
      }
    } finally {
      clearInterval(timer);
    }
    peakPool = Math.max(peakPool, ownerDb.pool.totalCount);
    expect(peakPool).toBeGreaterThan(0);
    expect(peakPool).toBeLessThanOrEqual(2);
    expect(peakServer).toBeLessThanOrEqual(2);
  });
});

describe('the roles read their own family and nothing of the other', () => {
  let api: pg.Client;
  let ownerClient: pg.Client;
  beforeAll(async () => {
    api = await t.connectAs('rws_api');
    ownerClient = await t.connectAs('rws_owner_api');
  });

  const flat = (v: object): string[] =>
    Object.values(v).flatMap((x) => (typeof x === 'string' ? [x] : flat(x as object)));

  it('rws_api is refused (42501) on every owner view, on each owner-only view and on both owner functions', async () => {
    const views = [...flat(VIEWS.owner), ...flat(OWNER_ONLY_VIEWS)];
    expect(views.length).toBeGreaterThan(25);
    for (const view of views) expect(await sqlState(api, `SELECT 1 FROM ${view} LIMIT 1`), view).toBe('42501');
    expect(await sqlState(api, `SELECT * FROM ${OBS_AT.owner}(now()) LIMIT 1`)).toBe('42501');
    expect(await sqlState(api, `SELECT * FROM ${FORECAST_AT.owner}(now(), now()) LIMIT 1`)).toBe('42501');
    // And it reads its own: the control that the query itself is sound.
    expect(await sqlState(api, `SELECT 1 FROM ${VIEWS.public.series} LIMIT 1`)).toBe('ok');
  });

  it('rws_owner_api is refused (42501) on the public-only views, the public family and the public functions, and reads its own', async () => {
    for (const view of [...flat(PUBLIC_ONLY_VIEWS), ...flat(VIEWS.public)])
      expect(await sqlState(ownerClient, `SELECT 1 FROM ${view} LIMIT 1`), view).toBe('42501');
    expect(await sqlState(ownerClient, `SELECT * FROM ${OBS_AT.public}(now()) LIMIT 1`)).toBe('42501');
    expect(await sqlState(ownerClient, `SELECT * FROM ${FORECAST_AT.public}(now(), now()) LIMIT 1`)).toBe('42501');
    expect(await sqlState(ownerClient, `SELECT 1 FROM ${VIEWS.owner.series} LIMIT 1`)).toBe('ok');
    // Neither reads a base table.
    for (const client of [api, ownerClient])
      for (const table of ['obs', 'series', 'source', 'attribution', 'app_meta'])
        expect(await sqlState(client, `SELECT 1 FROM ${table} LIMIT 1`), table).toBe('42501');
  });

  it('the canary is in the owner family and in no public view: read through the views, not the API', async () => {
    const own = await ownerClient.query(`SELECT value FROM ${VIEWS.owner.obs} WHERE series_id = $1`, [ids.ownerCanary]);
    expect(own.rows.length).toBeGreaterThan(0);
    expect(String((own.rows[0] as { value: number }).value)).toBe(String(Math.fround(CANARIES.owner.value)));
    const pubRows = await api.query(`SELECT value FROM ${VIEWS.public.obs} WHERE series_id = $1`, [ids.ownerCanary]);
    expect(pubRows.rows).toEqual([]);
  });
});
