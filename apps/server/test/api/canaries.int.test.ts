import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARIES, CANARY_RENDERINGS } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Channel, ROUTES } from '../../src/api/channels.ts';
import { DayVersions } from '../../src/api/versions.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { type ChannelAudience, VIEWS } from '../../src/db/audience.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { NEVER_PUBLIC, seedAudienceFixture, WITHHELD_KEYS } from '../db/seed.ts';
import { createTestDb, type LoginRole, type TestDb } from '../db/testdb.ts';
import { walk } from '../publish/tree.ts';
import { ask, CODINGS, captureLog, grep, iso, type Piece, prng, type Req, seriesIdsOf } from './sweep.ts';

// P9b (plan 4.10, C8; issue #24): the withheld canary and the channel canary over every route of both APIs and every
// file of both publishers. The route table (ROUTES) is iterated, so a route added to it without a generator here fails
// the test, and /frames is swept the day #26 builds it. Every route is asked with identity, gzip and zstd, valid and
// refused, as the public and as the owner API; every body, header value, log call of the apps and every file of both
// publisher trees (siblings decompressed) is searched.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const GRID = 600_000;
const floor = (ms: number) => Math.floor(ms / GRID) * GRID;

/**
 * The channel canary: a display-only series carries 654321.987. A `real` cannot hold it, PostgreSQL prints the stored
 * value as 654322 (C8: assert it below). It is a constant of this file and never in CANARY_RENDERINGS, because the
 * public publisher must write it (display channel).
 */
const CHANNEL = { text: '654321.987', real: '654322' } as const;
const CHANNEL_NEEDLES = [CHANNEL.text, /(?<![0-9.])654322(?![0-9])/] as const;
/** A series without history_export: a value older than its source's window (72 h here) and one inside it. */
const HIST = { old: '555555.5', fresh: '666666.5' } as const;
const WINDOW_HOURS = 72;

const WITHHELD_RENDERINGS = [CANARIES.withheld.text, CANARIES.withheld.real] as const;
const OWNER_RENDERINGS = [CANARIES.owner.text, CANARIES.owner.real] as const;
const WITHHELD_TOKENS = [
  'nl.canary.withheld',
  'nl.rws.narrowed-off',
  'de.wsv.mirror',
  'de.wsv.twin',
  'withheld canary',
];

let t: TestDb;
let ids: Record<string, number>;
const dirs: string[] = [];
const dbs: Db[] = [];
const logs: string[] = [];
const files: Record<ChannelAudience, Map<string, string>> = { public: new Map(), owner: new Map() };
const apps = {} as Record<ChannelAudience, ReturnType<typeof createApp>>;
const versions = {} as Record<ChannelAudience, DayVersions>;
const q = (text: string, values: unknown[] = []) => t.admin.query(text, values);

const open = (role: LoginRole, max: number): Db => {
  const db = openDb(dbConfig({ DATABASE_URL: t.urlFor(role) }, role) as DbConfig, { max });
  dbs.push(db);
  return db;
};

/** What each family's route table is asked (a valid request, a refused one): one generator per served route. */
type Ctx = { ids: number[]; instants: string[]; future: string[]; now: number };
const get = (path: string, label = path): Req => ({ path, label });
const GENERATORS: Record<string, (c: Ctx) => Req[]> = {
  '/api/v1/meta': () => [get('/api/v1/meta'), get('/api/v1/meta?zz=1')],
  '/api/v1/stations': () => [get('/api/v1/stations'), get('/api/v1/stations?zz=1')],
  '/api/v1/snapshot': (c) => [
    ...c.instants.flatMap((i) => [
      get(`/api/v1/snapshot?t=${i}`),
      get(`/api/v1/snapshot?t=${i}&v=1`),
      get(`/api/v1/snapshot?t=${i}&v=7`),
    ]),
    ...c.future.flatMap((i) => [get(`/api/v1/snapshot?t=${i}`), get(`/api/v1/snapshot?t=${i}&v=1`)]),
    get('/api/v1/snapshot'),
    get('/api/v1/snapshot?t=nonsense'),
    get(`/api/v1/snapshot?t=${iso(c.now)}&zz=1`),
    get(`/api/v1/snapshot?t=${iso(c.now)}&t=${iso(c.now)}`),
    get(`/api/v1/snapshot?t=${iso(c.now)}&v=0`),
    get(`/api/v1/snapshot?t=${iso(c.now)}&v=1000000`),
    get(`/api/v1/snapshot?t=${iso(c.now + 3 * DAY)}`),
    get(`/api/v1/snapshot?t=${iso(c.now - 400 * DAY)}`),
  ],
  '/api/v1/series/:id': (c) => [
    ...c.ids.flatMap((id) => [
      get(`/api/v1/series/${id}?from=${iso(c.now - 13 * DAY)}&to=${iso(c.now)}`),
      get(`/api/v1/series/${id}?from=${iso(c.now - 13 * DAY)}&to=${iso(c.now)}&v=1`),
      get(`/api/v1/series/${id}?from=${iso(c.now - 13 * DAY)}&to=${iso(c.now)}&v=7`),
      get(`/api/v1/series/${id}?from=${iso(c.now - 45 * DAY)}&to=${iso(c.now)}&res=1h`),
      get(`/api/v1/series/${id}?from=${iso(c.now - 45 * DAY)}&to=${iso(c.now)}&res=1d`),
      get(`/api/v1/series/${id}?from=${iso(c.now - 6 * DAY)}&to=${iso(c.now - 3 * DAY)}`),
    ]),
    get('/api/v1/series/abc?from=2026-10-01T00:00Z&to=2026-10-02T00:00Z'),
    get('/api/v1/series/0?from=2026-10-01T00:00Z&to=2026-10-02T00:00Z'),
    get('/api/v1/series/99999999999?from=2026-10-01T00:00Z&to=2026-10-02T00:00Z'),
    get(`/api/v1/series/${c.ids[0]}?from=${iso(c.now - 13 * DAY)}`),
    get(`/api/v1/series/${c.ids[0]}?from=${iso(c.now - 13 * DAY)}&to=${iso(c.now)}&zz=1`),
    get(`/api/v1/series/${c.ids[0]}?from=${iso(c.now - 40 * DAY)}&to=${iso(c.now)}&res=raw`),
    get(`/api/v1/series/${c.ids[0]}?from=${iso(c.now - 13 * DAY)}&to=${iso(c.now)}&v=a`),
  ],
  '/api/v1/series/:id/forecast': (c) => [
    ...c.ids.flatMap((id) => [
      get(`/api/v1/series/${id}/forecast`),
      get(`/api/v1/series/${id}/forecast?asof=${iso(c.now)}`),
      get(`/api/v1/series/${id}/forecast?asof=${iso(c.now - 3 * HOUR)}`),
    ]),
    get(`/api/v1/series/${c.ids[0]}/forecast?v=1`),
    get('/api/v1/series/abc/forecast'),
    get('/api/v1/series/99999999999/forecast'),
  ],
  '/api/v1/health': () => [get('/api/v1/health'), get('/api/v1/health?zz=1')],
  '/api/v1/health/sources': () => [get('/api/v1/health/sources'), get('/api/v1/health/sources?zz=1')],
  '/api/v1/openapi.json': () => [get('/api/v1/openapi.json'), get('/api/v1/openapi.json?zz=1')],
  '/api/v1/beacon': () => [
    {
      method: 'POST',
      path: '/api/v1/beacon',
      type: 'application/reports+json',
      body: JSON.stringify([
        {
          type: 'csp-violation',
          age: 5,
          url: 'https://example.org/',
          user_agent: 'ua',
          body: { blockedURL: 'inline' },
        },
      ]),
      label: 'beacon reports+json',
    },
    {
      method: 'POST',
      path: '/api/v1/beacon',
      type: 'application/csp-report',
      body: JSON.stringify({
        'csp-report': { 'document-uri': 'https://example.org/', 'violated-directive': 'script-src' },
      }),
      label: 'beacon csp-report',
    },
    {
      method: 'POST',
      path: '/api/v1/beacon',
      type: 'application/json',
      body: JSON.stringify({ kind: 'client_error', message: 'boom', url: 'https://example.org/' }),
      label: 'beacon json',
    },
    { method: 'POST', path: '/api/v1/beacon', type: 'text/plain', body: 'x', label: 'beacon 415' },
    { method: 'POST', path: '/api/v1/beacon', type: 'application/json', body: 'x'.repeat(9000), label: 'beacon 413' },
    { method: 'POST', path: '/api/v1/beacon', type: 'application/json', body: '{not json', label: 'beacon bad json' },
    { method: 'POST', path: '/api/v1/beacon?zz=1', type: 'application/json', body: '{}', label: 'beacon query' },
    get('/api/v1/beacon', 'beacon GET'),
  ],
};
/** Routes listed but not served yet: asked anyway, they must answer the plain 404. */
const PLANNED_PATHS = (id: number) => ({
  '/api/v1/stations/:id': `/api/v1/stations/${id}`,
  '/api/v1/frames': '/api/v1/frames',
});

/** The requests every route also gets: a method the route does not take, the HEAD, a query over 256 bytes. */
const common = (path: string, method: string): Req[] =>
  method === 'GET'
    ? [
        { method: 'POST', path, body: '{}', type: 'application/json', label: `${path} POST` },
        { method: 'PUT', path, body: '{}', type: 'application/json', label: `${path} PUT` },
        { method: 'DELETE', path, label: `${path} DELETE` },
        { method: 'OPTIONS', path, label: `${path} OPTIONS` },
        { method: 'HEAD', path, label: `${path} HEAD` },
        get(`${path}${path.includes('?') ? '&' : '?'}a=${'x'.repeat(300)}`, `${path} oversized query`),
      ]
    : [{ method: 'PUT', path, body: '{}', type: 'application/json', label: `${path} PUT` }];

/** Both families' answers to every request, in every coding. */
const pieces: Piece[] = [];
const statuses = new Set<number>();

/** The channel of the route a piece answers (the sweep tags it). */
const channelOf = (p: Piece) => p.tags?.find((x) => x.startsWith('channel:'))?.slice(8) as Channel | undefined;
const inFamily = (p: Piece, family: ChannelAudience) => p.tags?.includes(`family:${family}`) === true;

async function sweep(family: ChannelAudience, ctx: Ctx) {
  const app = apps[family];
  const routes = ROUTES.filter((r) => !r.planned);
  for (const route of routes) {
    const gen = GENERATORS[route.path];
    if (gen === undefined) continue;
    const reqs = [...gen(ctx), ...common(route.path.replace(':id', String(ctx.ids[0])), route.method)];
    for (const req of reqs) {
      const answers = await Promise.all(CODINGS.map((c) => ask(app, req, c)));
      const first = answers[0];
      if (first === undefined) throw new Error('no answer');
      for (const a of answers) {
        statuses.add(a.status);
        expect(a.status, `${family} ${req.label} ${a.coding}`).toBe(first.status);
        if (a.status === 200) expect(a.text, `${family} ${req.label} ${a.coding}`).toBe(first.text);
        pieces.push({
          label: `${family} ${req.method ?? 'GET'} ${req.label} [${a.coding}] -> ${a.status}`,
          text: `${a.headers}\n\n${a.text}`,
          tags: [`family:${family}`, `channel:${route.channel}`, `route:${route.path}`, 'response'],
        });
      }
    }
  }
  for (const [path, url] of Object.entries(PLANNED_PATHS(ctx.ids[0] as number))) {
    for (const coding of CODINGS) {
      const a = await ask(apps[family], get(url), coding);
      expect(a.status, `${family} planned ${path}`).toBe(404);
      pieces.push({
        label: `${family} planned ${path} [${coding}]`,
        text: `${a.headers}\n\n${a.text}`,
        tags: [`family:${family}`, 'channel:api', 'response'],
      });
    }
  }
}

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  await q(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [iso(NOW - 50 * DAY)]);
  await q(`SELECT ensure_partitions(now() - interval '45 days', now() + interval '10 days')`);

  // Identifiers a leak could ride on: a provider key of every withheld series that no other row shares.
  for (const key of WITHHELD_KEYS)
    await q('UPDATE series SET provider_key = $2 WHERE id = $1', [ids[key], `WTHLD-KEY-${key}`]);

  // Attribution rows, so that bodies attribute (a source without a row gives no entry): the public sources of the
  // fixture, dated where the real registry dates them, and two owner ones.
  await q(`
    INSERT INTO attribution (source_id, ord, lang, text, needs_date, date_kind, required) VALUES
      ('DE-1', 0, 'de', 'DE1-ATTRIBUTION', false, NULL, false),
      ('CH-1', 0, 'de', 'CH1-ATTRIBUTION', true, 'retrieval', true),
      ('CH-3', 0, 'de', 'CH3-ATTRIBUTION', true, 'retrieval', true),
      ('CH-4', 0, 'de', 'CH4-ATTRIBUTION', true, 'retrieval', true),
      ('BE-3', 0, 'fr', 'BE3-ATTRIBUTION', false, NULL, true),
      ('CANARY-OWNER', 0, 'nl', 'OWNERCANARY-ATTRIBUTION', false, NULL, true)`);

  // The channel canary (C8): 654321.987 on the display-only series, in every table a display answer reads.
  const wide = (series: number, from: number, to: number, value: string, qc = 1) =>
    q(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id)
       SELECT $1, to_timestamp(k / 1000.0), ${value}, ${qc}, 1 FROM generate_series($2::bigint, $3::bigint, ${GRID}) k
       ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value`,
      [series, floor(from), floor(to)],
    );
  await wide(ids.displayOnly as number, NOW - 4 * DAY, NOW, CHANNEL.text);
  await q('UPDATE obs SET value = 654321.987 WHERE series_id = $1', [ids.displayOnly]);
  await q('UPDATE obs_latest SET value = 654321.987 WHERE series_id = $1', [ids.displayOnly]);
  for (const table of ['obs_1h', 'obs_1d'])
    await q(
      `UPDATE ${table} SET vmin = 654321.987, vmax = 654321.987, vavg = 654321.987, vlast = 654321.987 WHERE series_id = $1`,
      [ids.displayOnly],
    );
  // A forecast run of a public source with the channel value too: the display channel may show it, /series/{id}/forecast may not.
  const run = await q(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
     VALUES ($1, 'CH-4', now() - interval '1 hour', date_trunc('hour', now()) - interval '1 hour',
             now() + interval '6 hours', now() - interval '1 hour', decode(md5('p9b-channel'), 'hex'), 'deterministic')
     RETURNING id`,
    [ids.displayOnly],
  );
  await q(
    `INSERT INTO forecast_value (run_id, valid_ts, value)
     SELECT $1, date_trunc('hour', now()) + h * interval '1 hour', 654321.987 FROM generate_series(-1, 5) h`,
    [(run.rows[0] as { id: string }).id],
  );

  // The history canary: CH-3 (no history_export) gets a 72 h window; values older than it are marked, values inside it too.
  await q(`UPDATE source SET history_window = '${WINDOW_HOURS} hours' WHERE id = 'CH-3'`);
  const cut = NOW - WINDOW_HOURS * HOUR;
  await wide(ids.window as number, NOW - 84 * HOUR, cut - GRID, HIST.old);
  await wide(ids.window as number, cut + 3 * HOUR, NOW, HIST.fresh);
  await q(`UPDATE obs SET value = ${HIST.old} WHERE series_id = $1 AND ts < to_timestamp($2 / 1000.0)`, [
    ids.window,
    cut,
  ]);
  await q(`UPDATE obs SET value = ${HIST.fresh} WHERE series_id = $1 AND ts >= to_timestamp($2 / 1000.0)`, [
    ids.window,
    cut,
  ]);
  await q(`UPDATE obs_latest SET value = ${HIST.fresh} WHERE series_id = $1`, [ids.window]);
  for (const table of ['obs_1h', 'obs_1d']) {
    const mark = (value: string, cmp: string) =>
      q(
        `UPDATE ${table} SET vmin = ${value}, vmax = ${value}, vavg = ${value}, vlast = ${value}
         WHERE series_id = $1 AND bucket ${cmp} to_timestamp($2 / 1000.0)`,
        [ids.window, cut],
      );
    await mark(HIST.old, '<');
    await mark(HIST.fresh, '>=');
  }

  // Both publishers, into temp dirs (siblings decompressed and byte-compared by walk()).
  for (const [family, role] of [
    ['public', 'rws_publish'],
    ['owner', 'rws_owner_api'],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), `rws-p9b-canary-${family}-`));
    dirs.push(dir);
    const db = open(role, family === 'public' ? 3 : 2);
    await publishOnce(db.db, family, dir, { now: NOW, settledDays: 2 });
    files[family] = walk(dir);
    await db.close();
  }

  // Both APIs, as the real roles, with the real display window and day versions.
  const log = captureLog(logs);
  for (const [family, role, max] of [
    ['public', 'rws_api', 10],
    ['owner', 'rws_owner_api', 2],
  ] as const) {
    const db = open(role, max);
    const window = new DisplayWindow(db.db, undefined, family);
    expect(await window.refresh()).toBe(true);
    const v = new DayVersions(db.db, family);
    expect(await v.refresh()).toBe(true);
    versions[family] = v;
    apps[family] = createApp({ family, db: db.db, window, versions: v, now: () => new Date(NOW), log, beaconLog: log });
  }

  const rnd = prng(20261005);
  const start = NOW - 48 * DAY;
  const hour = Math.floor(NOW / HOUR) * HOUR;
  const instants = [
    ...[hour - 40 * DAY, hour - 10 * DAY, hour, floor(NOW), floor(NOW) - 2 * HOUR, floor(NOW) - 3 * DAY].map((x) =>
      iso(x + GRID),
    ),
    ...Array.from({ length: 10 }, () => iso(floor(start + rnd() * (NOW - start)))),
  ];
  const ctx: Ctx = {
    ids: Object.values(ids),
    instants,
    future: [iso(NOW + HOUR), iso(NOW + 47 * HOUR)],
    now: NOW,
  };
  await sweep('public', ctx);
  await sweep('owner', ctx);
  for (const family of ['public', 'owner'] as const)
    for (const [rel, text] of files[family])
      pieces.push({ label: `${family} file ${rel}`, text, tags: [`family:${family}`, 'file'] });
  for (const line of logs) pieces.push({ label: 'log', text: line, tags: ['log'] });
}, 600_000);

afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const v of Object.values(versions)) v.stop();
  await Promise.allSettled(dbs.map((d) => d.close()));
  await t?.drop();
});

describe('the sweep covers the whole route table', () => {
  it('has a generator for every served route and for no route that is not in ROUTES', () => {
    const served = ROUTES.filter((r) => !r.planned);
    for (const r of served) expect(Object.keys(GENERATORS), `${r.path}: add it to the sweep`).toContain(r.path);
    for (const path of Object.keys(GENERATORS)) expect(ROUTES.map((r) => r.path)).toContain(path);
    // The planned routes are asked for the plain 404 until their handler exists (then they need a generator).
    for (const r of ROUTES.filter((x) => x.planned)) expect(Object.keys(PLANNED_PATHS(1))).toContain(r.path);
  });

  it('asked valid and refused requests of both APIs in every coding, and logged', () => {
    expect([...statuses].sort()).toEqual([200, 204, 400, 404, 405, 413, 415]);
    for (const family of ['public', 'owner'] as const) {
      const mine = pieces.filter((p) => inFamily(p, family) && p.tags?.includes('response'));
      expect(mine.length).toBeGreaterThan(600);
      expect(mine.filter((p) => p.label.endsWith('-> 200')).length).toBeGreaterThan(250);
      expect(files[family].size).toBeGreaterThan(300);
    }
    expect(logs.length).toBeGreaterThan(5);
  });

  it('the data the sweep looks for exists in the base tables (the old history value, the withheld value, the channel value)', async () => {
    const n = async (sql: string, args: unknown[] = []) => Number(((await q(sql, args)).rows[0] as { n: string }).n);
    expect(
      await n('SELECT count(*) AS n FROM obs WHERE series_id = $1 AND value = 555555.5::real', [ids.window]),
    ).toBeGreaterThan(50);
    expect(
      await n('SELECT count(*) AS n FROM obs WHERE series_id = $1 AND value = 666666.5::real', [ids.window]),
    ).toBeGreaterThan(50);
    expect(
      await n('SELECT count(*) AS n FROM obs_1d WHERE series_id = $1 AND vlast = 555555.5::real', [ids.window]),
    ).toBe(1);
    expect(
      await n('SELECT count(*) AS n FROM obs WHERE series_id = ANY($1) AND value = 123456.789::real', [
        WITHHELD_KEYS.map((k) => ids[k]),
      ]),
    ).toBe(4 * 3);
    expect(
      await n('SELECT count(*) AS n FROM obs WHERE series_id = $1 AND value = 654321.987::real', [ids.displayOnly]),
    ).toBeGreaterThan(500);
  });

  it('the canary renders as the tests grep it: a real prints 654321.987 as 654322', async () => {
    const r = await q('SELECT 654321.987::real::text AS t');
    expect((r.rows[0] as { t: string }).t).toBe(CHANNEL.real);
    expect(CHANNEL.text).not.toBe(CHANNEL.real);
  });
});

describe('withheld canary', { timeout: 120_000 }, () => {
  it('appears nowhere: no body, header, log call or publisher file, public or owner', () => {
    const needles = [...WITHHELD_RENDERINGS, ...WITHHELD_TOKENS, ...WITHHELD_KEYS.map((k) => `WTHLD-KEY-${k}`)];
    expect(grep(pieces, needles)).toEqual([]);
  });

  it('is in no series list of any body or file (structural: the series ids of the withheld, narrowed, mirror and twin series)', () => {
    const hidden = new Set(WITHHELD_KEYS.map((k) => ids[k] as number));
    let parsed = 0;
    for (const p of pieces) {
      if (p.tags?.includes('log')) continue;
      const body = p.tags?.includes('file') ? p.text : p.text.slice(p.text.indexOf('\n\n') + 2);
      if (body === '' || !body.startsWith('{')) continue;
      parsed++;
      for (const id of seriesIdsOf(JSON.parse(body))) expect(hidden.has(id), `${p.label}: series ${id}`).toBe(false);
    }
    expect(parsed).toBeGreaterThan(500);
  });

  it('is asked for by id: the withheld series answers the same 404 as an unknown one, in both APIs', async () => {
    for (const family of ['public', 'owner'] as const) {
      for (const key of WITHHELD_KEYS) {
        const win = `from=${iso(NOW - 13 * DAY)}&to=${iso(NOW)}`;
        const a = await ask(apps[family], get(`/api/v1/series/${ids[key]}?${win}`), 'identity');
        const b = await ask(
          apps[family],
          get(`/api/v1/series/${Math.max(...Object.values(ids)) + 1000}?${win}`),
          'identity',
        );
        expect([a.status, a.text, a.headerMap['cache-control']], `${family} ${key}`).toEqual([404, b.text, 'no-store']);
        expect(a.text).toBe('{"error":"not_found","attribution":[]}');
        const f = await ask(apps[family], get(`/api/v1/series/${ids[key]}/forecast`), 'identity');
        expect([f.status, f.text], `${family} ${key} forecast`).toEqual([404, a.text]);
      }
    }
  });

  it('would be found: the grep finds the value in a body that holds it, in either rendering', () => {
    for (const r of WITHHELD_RENDERINGS) {
      expect(grep([{ label: 'body', text: `{"value":${r}}` }], WITHHELD_RENDERINGS)).toHaveLength(1);
      expect(grep([{ label: 'file', text: `x${r}y` }], WITHHELD_RENDERINGS)).toHaveLength(1);
    }
    expect(grep([{ label: 'body', text: '{"value":100}' }], WITHHELD_RENDERINGS)).toEqual([]);
  });

  it('would be found if a view lost its audience predicate: a copy of the series view without it shows the withheld series', async () => {
    const def = (await q('SELECT pg_get_viewdef($1::regclass, true) AS d', [VIEWS.public.series])).rows[0] as {
      d: string;
    };
    // Drop the effective-audience test (a single audience prints as `= 'public'::audience`, several as `= ANY`).
    const where = def.d.slice(def.d.lastIndexOf('WHERE'));
    const stripped = def.d.replace(
      where,
      where.replace(/e\.audience (?:= ANY \(ARRAY\[[^\]]*\]\)|= '[a-z]+'::audience)(?: AND )?/, ''),
    );
    expect(stripped, 'the audience predicate was not found in the view definition').not.toBe(def.d);
    expect(stripped.slice(stripped.lastIndexOf('WHERE'))).not.toMatch(/audience/);
    await q('CREATE SCHEMA IF NOT EXISTS scratch');
    await q(`CREATE OR REPLACE VIEW scratch.series_without_audience AS ${stripped}`);
    const real = (await q(`SELECT id FROM ${VIEWS.public.series}`)).rows as { id: number }[];
    const loose = (await q('SELECT id, station_id, source_id FROM scratch.series_without_audience')).rows as {
      id: number;
      station_id: string;
    }[];
    for (const key of ['withheld', 'narrowedOff', 'ownerCanary', 'narrowedOwner'] as const) {
      expect(
        real.map((r) => r.id),
        `the family view hides ${key}`,
      ).not.toContain(ids[key]);
      expect(
        loose.map((r) => r.id),
        `the copy without the predicate shows ${key}`,
      ).toContain(ids[key]);
    }
    // And what the sweep greps would then hit: the station id and the series id of the withheld series.
    const body = JSON.stringify({
      stations: loose.map((r) => ({ id: r.station_id, series: [{ id: r.id, quantity: 'H' }] })),
    });
    expect(grep([{ label: 'scratch body', text: body }], WITHHELD_TOKENS).length).toBeGreaterThan(0);
    expect(seriesIdsOf(JSON.parse(body)).has(ids.withheld as number)).toBe(true);
  });
});

describe('owner canary stays on its side of the sweep', () => {
  it('is in no public body, header, log call or file (the audience fixture NEVER_PUBLIC list included)', () => {
    const publicSide = pieces.filter((p) => inFamily(p, 'public') || p.tags?.includes('log'));
    // The log holds both apps' calls; the owner app's own are never public, so only the public pieces are asked here.
    const ownerLog = (p: Piece) => p.tags?.includes('log') === true;
    const hits = grep(
      publicSide.filter((p) => !ownerLog(p)),
      [...NEVER_PUBLIC, ...CANARY_RENDERINGS, 'BE3-ATTRIBUTION', 'OWNERCANARY-ATTRIBUTION'],
    );
    expect(hits).toEqual([]);
  });

  it('is in no log call of either app: the logs carry fixed codes, never a value or an identifier', () => {
    const lines = pieces.filter((p) => p.tags?.includes('log'));
    expect(lines.length).toBeGreaterThan(5);
    expect(grep(lines, [...OWNER_RENDERINGS, ...WITHHELD_RENDERINGS, 'nl.canary.owner', 'CANARY-OWNER'])).toEqual([]);
  });

  it('is in the owner outputs (so the sweep can see it): owner /snapshot and the owner publisher files', () => {
    const ownerHits = grep(
      pieces.filter((p) => inFamily(p, 'owner')),
      OWNER_RENDERINGS,
    );
    expect(ownerHits.length).toBeGreaterThan(5);
    expect(ownerHits.some((h) => h.label.includes('/api/v1/snapshot'))).toBe(true);
    expect(ownerHits.some((h) => h.label.includes('file latest.json'))).toBe(true);
    expect(
      grep(
        pieces.filter((p) => p.tags?.includes('file') && inFamily(p, 'owner')),
        ['OWNERCANARY-ATTRIBUTION'],
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('channel canary', { timeout: 120_000 }, () => {
  it('is in the static files (latest, recent and settled) and in /snapshot, public and owner', () => {
    for (const family of ['public', 'owner'] as const) {
      const f = [...files[family]]
        .filter(([, text]) => grep([{ label: '', text }], CHANNEL_NEEDLES).length > 0)
        .map(([rel]) => rel);
      expect(f, family).toContain('latest.json');
      expect(
        f.some((r) => r.startsWith('recent/')),
        `${family} recent`,
      ).toBe(true);
      // The owner publisher precomputes no settled snapshot (A§9.3: the owner API serves them).
      expect(
        f.some((r) => r.startsWith('settled/')),
        `${family} settled`,
      ).toBe(family === 'public');
      const snap = grep(
        pieces.filter((p) => inFamily(p, family) && p.tags?.includes('route:/api/v1/snapshot')),
        CHANNEL_NEEDLES,
      );
      expect(snap.length, `${family} /snapshot`).toBeGreaterThan(0);
    }
  });

  it('is in no response of an api-channel route, a meta-channel route or an unserved one, public or owner: iterated over ROUTES', () => {
    const apiRoutes = ROUTES.filter((r) => r.channel === 'api').map((r) => r.path);
    expect(apiRoutes).toContain('/api/v1/series/:id');
    expect(apiRoutes).toContain('/api/v1/series/:id/forecast');
    expect(apiRoutes).toContain('/api/v1/frames');
    for (const channel of ['api', 'meta'] as const) {
      const mine = pieces.filter((p) => channelOf(p) === channel);
      expect(mine.length, channel).toBeGreaterThan(100);
      expect(grep(mine, CHANNEL_NEEDLES), channel).toEqual([]);
    }
    // Not through the display routes that carry no observation either.
    for (const path of ['/api/v1/meta', '/api/v1/stations'])
      expect(
        grep(
          pieces.filter((p) => p.tags?.includes(`route:${path}`)),
          CHANNEL_NEEDLES,
        ),
        path,
      ).toEqual([]);
  });

  it('is asked for by id on the api channel: the display-only series answers the plain 404 there, a public series 200', async () => {
    for (const family of ['public', 'owner'] as const) {
      const win = `from=${iso(NOW - 13 * DAY)}&to=${iso(NOW)}`;
      const a = await ask(apps[family], get(`/api/v1/series/${ids.displayOnly}?${win}`), 'identity');
      expect([a.status, a.text], family).toEqual([404, '{"error":"not_found","attribution":[]}']);
      const f = await ask(apps[family], get(`/api/v1/series/${ids.displayOnly}/forecast`), 'identity');
      expect([f.status, f.text], family).toEqual([404, a.text]);
      const ok = await ask(apps[family], get(`/api/v1/series/${ids.public}?${win}`), 'identity');
      expect(ok.status, family).toBe(200);
    }
  });

  it('would be found: the grep finds either rendering of the channel value', () => {
    for (const body of [`{"value":${CHANNEL.text}}`, `{"value":${CHANNEL.real},"qc":1}`])
      expect(grep([{ label: 'b', text: body }], CHANNEL_NEEDLES)).toHaveLength(1);
    expect(grep([{ label: 'b', text: '{"value":6543221}' }], CHANNEL_NEEDLES)).toEqual([]);
  });
});

describe('history window', { timeout: 120_000 }, () => {
  it('a series without history_export shows nothing older than its window on any channel, in any file or answer', () => {
    expect(grep(pieces, [HIST.old])).toEqual([]);
  });

  it('shows what is inside the window: /series, /snapshot and latest.json', () => {
    const fresh = grep(pieces, [HIST.fresh]);
    expect(fresh.some((h) => h.label.includes('/api/v1/series/') && h.label.startsWith('public'))).toBe(true);
    expect(fresh.some((h) => h.label.includes('/api/v1/snapshot'))).toBe(true);
    // P9a (C5): a series without history_export is in latest.json (inside its window) and never in a recent or settled
    // file, which are history.
    expect(fresh.filter((h) => h.label.includes(' file ')).map((h) => h.label.replace(/^\w+ file /, ''))).toEqual([
      'latest.json',
      'latest.json',
    ]);
  });
});
