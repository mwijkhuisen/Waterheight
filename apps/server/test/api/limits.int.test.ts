import { type ChildProcess, spawn } from 'node:child_process';
import { type AddressInfo, createServer, connect as netConnect } from 'node:net';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Limiter } from '../../src/api/limiter.ts';
import { Semaphore } from '../../src/api/semaphore.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { seedAudienceFixture } from '../db/seed.ts';
import { createTestDb, type TestDb } from '../db/testdb.ts';
import { ask, CODINGS, captureLog, iso, type Req } from './sweep.ts';

// P9b (issue #24 "Malformed or oversized input -> 400 without a DB query. Over-rate -> 429 with Retry-After. A
// saturated semaphore -> 503 with Retry-After. 50 identical concurrent requests -> 1 DB query"; C1, C5, C22): the
// hardening of the pipeline against a real PostgreSQL 18, as the real `rws_api` login, with the pool's `connect` and
// the driver's `query` spied, so "no DB query" is a count of real calls and not an inference.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const T = iso(NOW - 2 * HOUR);

let t: TestDb;
let api: Db;
let window: DisplayWindow;
let ids: Record<string, number>;
const logs: string[] = [];

const mk = (extra: Parameters<typeof createApp>[0] = {}, db: Db['db'] = api.db) =>
  createApp({ db, window, now: () => new Date(NOW), log: captureLog(logs), ...extra });
const get = (path: string, label = path): Req => ({ path, label });
const spies = () => ({
  connect: vi.spyOn(api.pool, 'connect'),
  query: vi.spyOn(pg.Client.prototype, 'query'),
});
const ERR = (code: string) => `{"error":"${code}","attribution":[]}`;
/** A client in the documentation range (not private, so the limiter keys on it), one per test. */
let nextClient = 10;
const client = () => `203.0.113.${nextClient++}`;
/**
 * One GET over a raw socket: the global fetch and node:http are intercepted by msw (onUnhandledRequest: 'error') in
 * every test file, and this one talks to a real child process on loopback.
 */
const rawGet = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; headers: Record<string, string>; text: string }>((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1');
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      data += d;
    });
    sock.once('error', reject);
    sock.once('close', () => {
      const [head = '', ...rest] = data.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const status = Number((lines[0] ?? '').split(' ')[1]);
      const hs: Record<string, string> = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) hs[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve({ status, headers: hs, text: rest.join('\r\n\r\n') });
    });
    sock.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')}\r\n`,
    );
  });

const one = (app: ReturnType<typeof createApp>, req: Req, who?: string) => ask(app, req, 'identity', who);

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  const opened = openDb(dbConfig({ DATABASE_URL: t.urlFor('rws_api') }, 'rws_api') as DbConfig, { max: 10 });
  api = opened;
  window = new DisplayWindow(api.db);
  expect(await window.refresh()).toBe(true);
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await api?.close();
  await t?.drop();
});

describe('malformed or oversized input is a 400 before any database query (C22)', () => {
  const win = `from=${iso(NOW - DAY)}&to=${iso(NOW)}`;
  const id = () => ids.public;
  const CASES: [string, () => Req, number, string][] = [
    ['an unknown parameter', () => get(`/api/v1/snapshot?t=${T}&zz=1`), 400, 'unknown_parameter'],
    ['an unknown parameter on /meta', () => get('/api/v1/meta?zz=1'), 400, 'unknown_parameter'],
    ['a repeated parameter', () => get(`/api/v1/snapshot?t=${T}&t=${T}`), 400, 'repeated_parameter'],
    ['a value over 32 characters', () => get(`/api/v1/snapshot?t=${'2'.repeat(40)}`), 400, 'bad_parameter'],
    ['a query string over 256 bytes', () => get(`/api/v1/snapshot?t=${T}&a=${'x'.repeat(300)}`), 400, 'bad_parameter'],
    [
      'a query string over 256 bytes on /series',
      () => get(`/api/v1/series/${id()}?${win}&${'k'.repeat(300)}`),
      400,
      'bad_parameter',
    ],
    ['v = 0', () => get(`/api/v1/snapshot?t=${T}&v=0`), 400, 'bad_parameter'],
    ['v = 1000000', () => get(`/api/v1/snapshot?t=${T}&v=1000000`), 400, 'bad_parameter'],
    ['v = a', () => get(`/api/v1/snapshot?t=${T}&v=a`), 400, 'bad_parameter'],
    ['v = 01', () => get(`/api/v1/snapshot?t=${T}&v=01`), 400, 'bad_parameter'],
    ['a bad v on /series', () => get(`/api/v1/series/${id()}?${win}&v=-1`), 400, 'bad_parameter'],
    ['v on /series/{id}/forecast', () => get(`/api/v1/series/${id()}/forecast?v=1`), 400, 'unknown_parameter'],
    ['a bad id', () => get(`/api/v1/series/abc?${win}`), 400, 'bad_parameter'],
    ['an id of 0', () => get(`/api/v1/series/0?${win}`), 400, 'bad_parameter'],
    ['an id past int4', () => get(`/api/v1/series/99999999999?${win}`), 400, 'bad_parameter'],
    ['a bad id on /forecast', () => get('/api/v1/series/abc/forecast'), 400, 'bad_parameter'],
    [
      'a span over the cap',
      () => get(`/api/v1/series/${id()}?from=${iso(NOW - 20 * DAY)}&to=${iso(NOW)}&res=raw`),
      400,
      'span_too_long',
    ],
    ['a t before the display window', () => get(`/api/v1/snapshot?t=${iso(NOW - 400 * DAY)}`), 400, 'out_of_range'],
    ['a t beyond now + 48 h', () => get(`/api/v1/snapshot?t=${iso(NOW + 5 * DAY)}`), 400, 'out_of_range'],
    [
      'a from before the display window',
      () => get(`/api/v1/series/${id()}?from=${iso(NOW - 400 * DAY)}&to=${iso(NOW)}`),
      400,
      'out_of_range',
    ],
    ['no t at all', () => get('/api/v1/snapshot'), 400, 'bad_parameter'],
    ['a query on /health', () => get('/api/v1/health?zz=1'), 400, 'unknown_parameter'],
    ['a query on /openapi.json', () => get('/api/v1/openapi.json?zz=1'), 400, 'unknown_parameter'],
    [
      'a method the route does not take',
      () => ({ method: 'POST', path: '/api/v1/snapshot', body: '{}', label: 'POST' }),
      405,
      'method_not_allowed',
    ],
    [
      'a beacon of the wrong type',
      () => ({ method: 'POST', path: '/api/v1/beacon', type: 'text/plain', body: 'x', label: 'b' }),
      415,
      'unsupported_type',
    ],
    [
      'an oversized beacon',
      () => ({ method: 'POST', path: '/api/v1/beacon', type: 'application/json', body: 'x'.repeat(9000), label: 'b' }),
      413,
      'too_large',
    ],
    [
      'a beacon with a query',
      () => ({ method: 'POST', path: '/api/v1/beacon?a=1', type: 'application/json', body: '{}', label: 'b' }),
      400,
      'unknown_parameter',
    ],
    [
      'a beacon that is not JSON',
      () => ({ method: 'POST', path: '/api/v1/beacon', type: 'application/json', body: '{x', label: 'b' }),
      400,
      'bad_parameter',
    ],
  ];

  it('answers each with its status, the fixed body and no-store, and opens no connection, runs no query', async () => {
    const app = mk();
    const { connect, query } = spies();
    for (const [what, req, status, code] of CASES) {
      for (const coding of CODINGS) {
        const a = await ask(app, req(), coding);
        expect([a.status, a.text, a.headerMap['cache-control']], `${what} [${coding}]`).toEqual([
          status,
          ERR(code),
          'no-store',
        ]);
        expect(a.headerMap['content-encoding'], what).toBeUndefined();
        if (status === 405) expect(a.headerMap.allow, what).toBe('GET, HEAD');
      }
    }
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    // The spy sees real work: a valid request opens connections and runs queries.
    expect((await one(app, get(`/api/v1/snapshot?t=${T}`))).status).toBe(200);
    expect(connect).toHaveBeenCalled();
    expect(query).toHaveBeenCalled();
  });

  it('the same refusals with the limiter on, and 400s cost the client a token like any request', async () => {
    const limiter = new Limiter({ now: () => 0 });
    const app = mk({ limiter });
    const { connect } = spies();
    const who = client();
    for (const [what, req, status] of CASES.slice(0, 6)) {
      const a = await one(app, req(), who);
      expect(a.status, what).toBe(status);
    }
    expect(connect).not.toHaveBeenCalled();
    // 6 tokens taken of 120: 114 more are allowed, the 115th is a 429 whatever it asks.
    for (let i = 0; i < 114; i++) expect((await one(app, get('/api/v1/snapshot?zz=1'), who)).status).toBe(400);
    const over = await one(app, get(`/api/v1/snapshot?t=${T}`), who);
    expect([over.status, over.text]).toEqual([429, ERR('rate_limited')]);
  });
});

describe('over the rate: 429 with Retry-After, before validation and before any query', () => {
  const clockedApp = () => {
    const clock = { ms: 1_000_000 };
    const limiter = new Limiter({ now: () => clock.ms });
    return { clock, limiter, app: mk({ limiter }) };
  };
  const burst = async (app: ReturnType<typeof createApp>, req: Req, who: string, n: number) => {
    const out: Awaited<ReturnType<typeof one>>[] = [];
    for (let i = 0; i < n; i++) out.push(await one(app, req, who));
    return out;
  };

  it('the general bucket (30/s, burst 120) refuses the 121st request, with Retry-After >= 1 and no-store', async () => {
    const { clock, app } = clockedApp();
    const who = client();
    const all = await burst(app, get('/api/v1/openapi.json'), who, 121);
    expect(all.slice(0, 120).every((a) => a.status === 200)).toBe(true);
    const last = all[120];
    expect([last?.status, last?.text, last?.headerMap['cache-control']]).toEqual([
      429,
      ERR('rate_limited'),
      'no-store',
    ]);
    expect(Number(last?.headerMap['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(last?.headerMap['retry-after']).toMatch(/^[1-9][0-9]*$/);
    // A refused request takes nothing: still refused until time passes, then served again.
    expect((await one(app, get('/api/v1/openapi.json'), who)).status).toBe(429);
    clock.ms += 1_000;
    expect((await one(app, get('/api/v1/openapi.json'), who)).status).toBe(200);
  });

  it('another client is unaffected, whatever header a client sends to look like someone else (X-Forwarded-For is ignored)', async () => {
    const { app } = clockedApp();
    const a = client();
    const b = client();
    for (let i = 0; i < 120; i++) {
      const res = await app.request('/api/v1/openapi.json', {
        headers: {
          'x-rws-client': a,
          'x-forwarded-for': `198.51.100.${i % 250}`,
          forwarded: `for=198.51.100.${i % 250}`,
          'x-real-ip': '198.51.100.77',
        },
      });
      expect(res.status).toBe(200);
    }
    const spoof = await app.request('/api/v1/openapi.json', {
      headers: { 'x-rws-client': a, 'x-forwarded-for': '198.51.100.250' },
    });
    expect(spoof.status).toBe(429);
    expect((await one(app, get('/api/v1/openapi.json'), b)).status).toBe(200);
  });

  it('the heavy bucket (5/s, burst 20) refuses the 21st /series request and also takes from the general bucket', async () => {
    const { app } = clockedApp();
    const who = client();
    const series = get('/api/v1/series/abc?from=2026-10-01T00:00Z&to=2026-10-02T00:00Z');
    const all = await burst(app, series, who, 21);
    expect(all.slice(0, 20).map((a) => a.status)).toEqual(Array.from({ length: 20 }, () => 400));
    expect([all[20]?.status, all[20]?.text]).toEqual([429, ERR('rate_limited')]);
    expect(Number(all[20]?.headerMap['retry-after'])).toBeGreaterThanOrEqual(1);
    // The general bucket lost 20 tokens to them and has 100 left: a /meta burst of 100 passes, the 101st is refused.
    const rest = await burst(app, get('/api/v1/openapi.json'), who, 101);
    expect(rest.slice(0, 100).every((x) => x.status === 200)).toBe(true);
    expect(rest[100]?.status).toBe(429);
    // /forecast is heavy too.
    const f = clockedApp();
    const w2 = client();
    const fc = await burst(f.app, get('/api/v1/series/abc/forecast'), w2, 21);
    expect(fc[20]?.status).toBe(429);
  });

  it('the beacon bucket (1/s, burst 10) is its own: the 11th POST is a 429, a GET of the same client is not', async () => {
    const { app } = clockedApp();
    const who = client();
    const post: Req = {
      method: 'POST',
      path: '/api/v1/beacon',
      type: 'application/json',
      body: JSON.stringify({ kind: 'client_error', message: 'm', url: 'u' }),
      label: 'beacon',
    };
    const all = await burst(app, post, who, 11);
    expect(all.slice(0, 10).map((a) => a.status)).toEqual(Array.from({ length: 10 }, () => 204));
    expect([all[10]?.status, all[10]?.text]).toEqual([429, ERR('rate_limited')]);
    expect((await one(app, get('/api/v1/openapi.json'), who)).status).toBe(200);
  });

  it('keys by the /64 of an IPv6 client, the IPv4 of a mapped one, and never limits a bridge peer into a lockout', async () => {
    const { app } = clockedApp();
    // Two addresses of one /64 share a bucket.
    const net = '2001:db8:aa:bb';
    for (let i = 0; i < 120; i++)
      expect((await one(app, get('/api/v1/openapi.json'), `${net}::${(i % 2) + 1}`)).status).toBe(200);
    expect((await one(app, get('/api/v1/openapi.json'), `${net}:ffff:ffff:ffff:ffff`)).status).toBe(429);
    expect((await one(app, get('/api/v1/openapi.json'), '2001:db8:aa:cc::1')).status).toBe(200);
    // An IPv4-mapped address is its IPv4.
    for (let i = 0; i < 120; i++) await one(app, get('/api/v1/openapi.json'), '::ffff:203.0.113.200');
    expect((await one(app, get('/api/v1/openapi.json'), '203.0.113.200')).status).toBe(429);
    // A private or loopback peer (a Docker bridge gateway: C7) has a bucket 100 times larger, never one for everyone.
    for (let i = 0; i < 300; i++) expect((await one(app, get('/api/v1/openapi.json'), '172.18.0.1')).status).toBe(200);
  });

  it('refuses before validation and before the database: a valid snapshot request over the rate opens no connection', async () => {
    const { app } = clockedApp();
    const who = client();
    await burst(app, get('/api/v1/openapi.json'), who, 120);
    const { connect, query } = spies();
    const over = await one(app, get(`/api/v1/snapshot?t=${T}`), who);
    expect([over.status, over.text]).toEqual([429, ERR('rate_limited')]);
    const bad = await one(app, get('/api/v1/snapshot?zz=1'), who);
    expect(bad.status).toBe(429);
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('never limits what is not under /api/v1: the limiter sits on that tree only', async () => {
    const { app } = clockedApp();
    const who = client();
    for (let i = 0; i < 400; i++) expect((await one(app, get('/healthz'), who)).status).toBe(200);
    expect((await one(app, get('/api/v1/openapi.json'), who)).status).toBe(200);
  });

  it('and createApp without a limiter (every other test) never limits', async () => {
    const app = mk();
    const who = client();
    for (let i = 0; i < 200; i++) expect((await one(app, get('/api/v1/openapi.json'), who)).status).toBe(200);
  });
});

describe('the production wiring: the api role of main.ts always has the limiter (C1)', () => {
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill('SIGKILL');
  });

  it('answers 429 with Retry-After once a client is over the burst, whatever X-Forwarded-For says', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const main = new URL('../../src/main.ts', import.meta.url).pathname;
    const proc = spawn(process.execPath, ['--no-experimental-webstorage', main, 'api'], {
      env: { PATH: process.env.PATH, DATABASE_URL: t.urlFor('rws_api'), HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let err = '';
    const listening = new Promise<void>((resolve, reject) => {
      proc.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
        if (err.includes('api listening')) resolve();
      });
      proc.once('exit', (code) => reject(new Error(`api exited ${code}: ${err}`)));
      setTimeout(() => reject(new Error(`api did not listen: ${err}`)), 20_000).unref();
    });
    await listening;
    const who = '203.0.113.99';
    const hit = (i: number) =>
      rawGet(port, '/api/v1/meta', { 'x-rws-client': who, 'x-forwarded-for': `198.51.100.${i % 250}` });
    const all = await Promise.all(Array.from({ length: 300 }, (_, i) => hit(i)));
    const refused = all.filter((r) => r.status === 429);
    expect(refused.length).toBeGreaterThan(100);
    expect(all.filter((r) => r.status === 200).length).toBeGreaterThan(100);
    const first = refused[0] as (typeof all)[number];
    expect(first.headers['retry-after']).toMatch(/^[1-9][0-9]*$/);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.text).toBe(ERR('rate_limited'));
    // Another client is served; the liveness probe is outside the tree and never limited.
    expect((await rawGet(port, '/api/v1/meta', { 'x-rws-client': '203.0.113.100' })).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await rawGet(port, '/healthz', { 'x-rws-client': who })).status).toBe(200);
    // Stop it as a SIGTERM does.
    const exited = new Promise<number | null>((resolve) => {
      proc.removeAllListeners('exit');
      proc.once('exit', (code) => resolve(code));
    });
    proc.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 90_000);
});

describe('a saturated semaphore is a 503 with Retry-After, released on every path', () => {
  /** Holds the permit through a real database read of `ms` milliseconds. */
  const hold = (semaphore: Semaphore, ms: number) =>
    semaphore.run(async () => {
      await sql`SELECT pg_sleep(${ms / 1000})`.execute(api.db);
    });
  const sleepUntilHeld = async (semaphore: Semaphore, permits: number) => {
    for (let i = 0; i < 200 && semaphore.state.free > permits - 1; i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('answers 503 busy with Retry-After: 2 for a miss while the permit is held, and 200 after it is released', async () => {
    const semaphore = new Semaphore({ permits: 1, maxWaiters: 0 });
    const app = mk({ semaphore });
    const held = hold(semaphore, 800);
    await sleepUntilHeld(semaphore, 1);
    expect(semaphore.state).toEqual({ free: 0, waiting: 0 });
    const { connect } = spies();
    for (const coding of CODINGS) {
      const a = await ask(app, get(`/api/v1/snapshot?t=${T}`), coding);
      expect([a.status, a.text, a.headerMap['retry-after'], a.headerMap['cache-control']], coding).toEqual([
        503,
        ERR('busy'),
        '2',
        'no-store',
      ]);
    }
    // /series and /forecast too: every miss path takes a permit.
    const win = `from=${iso(NOW - DAY)}&to=${iso(NOW)}`;
    for (const path of [
      `/api/v1/series/${ids.public}?${win}`,
      `/api/v1/series/${ids.public}/forecast`,
      '/api/v1/meta',
      '/api/v1/stations',
    ])
      expect((await one(app, get(path))).status, path).toBe(503);
    expect(connect).not.toHaveBeenCalled();
    await held;
    expect(semaphore.state).toEqual({ free: 1, waiting: 0 });
    // Nothing negative was kept: every one of the same requests is 200 now.
    for (const path of [`/api/v1/snapshot?t=${T}`, `/api/v1/series/${ids.public}?${win}`, '/api/v1/meta'])
      expect((await one(app, get(path))).status, path).toBe(200);
    expect(semaphore.state).toEqual({ free: 1, waiting: 0 });
  });

  it('waits for a permit for a moment: a waiter that fits is served after the release, one that does not fit is a 503', async () => {
    const semaphore = new Semaphore({ permits: 1, maxWaiters: 1, waitMs: 5_000 });
    const app = mk({ semaphore });
    const held = hold(semaphore, 600);
    await sleepUntilHeld(semaphore, 1);
    const waiter = one(app, get(`/api/v1/snapshot?t=${iso(NOW - 3 * HOUR)}`));
    for (let i = 0; i < 200 && semaphore.state.waiting < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(semaphore.state.waiting).toBe(1);
    const refused = await one(app, get(`/api/v1/snapshot?t=${iso(NOW - 4 * HOUR)}`));
    expect([refused.status, refused.text, refused.headerMap['retry-after']]).toEqual([503, ERR('busy'), '2']);
    await held;
    expect((await waiter).status).toBe(200);
    expect(semaphore.state).toEqual({ free: 1, waiting: 0 });
  });

  it('releases the permit when the read fails: a closed pool, and a statement_timeout (57014)', async () => {
    const semaphore = new Semaphore({ permits: 2 });
    // A pool that is closed: every read throws.
    const dead = openDb(dbConfig({ DATABASE_URL: t.urlFor('rws_api') }, 'rws_api') as DbConfig, { max: 1 });
    await sql`SELECT 1`.execute(dead.db); // a Kysely that never ran a query has no driver to destroy
    await dead.close();
    const lines: string[] = [];
    const broken = createApp({ db: dead.db, window, now: () => new Date(NOW), semaphore, log: captureLog(lines) });
    for (const path of [`/api/v1/snapshot?t=${T}`, '/api/v1/stations', '/api/v1/meta']) {
      const a = await one(broken, get(path));
      expect([a.status, a.text, a.headerMap['cache-control']], path).toEqual([503, ERR('unavailable'), 'no-store']);
      expect(semaphore.state, path).toEqual({ free: 2, waiting: 0 });
    }
    expect(lines.length).toBeGreaterThan(0);
    // The role's own statement_timeout (2 s): a read that waits on a lock held by another session is cancelled by the
    // server (57014) after 2 s, and the permit is back by then.
    const timed = createApp({ db: api.db, window, now: () => new Date(NOW), semaphore, log: captureLog(lines) });
    await t.admin.query('BEGIN');
    try {
      await t.admin.query('LOCK TABLE series IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      const pending = one(timed, get(`/api/v1/snapshot?t=${iso(NOW - 5 * HOUR)}`));
      await new Promise((r) => setTimeout(r, 500));
      expect(semaphore.state).toEqual({ free: 1, waiting: 0 }); // held by the blocked read
      const a = await pending;
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect([a.status, a.text, a.headerMap['cache-control']]).toEqual([503, ERR('unavailable'), 'no-store']);
      expect(semaphore.state).toEqual({ free: 2, waiting: 0 });
      expect(lines.some((l) => l.includes('57014'))).toBe(true);
    } finally {
      await t.admin.query('ROLLBACK');
    }
    expect((await one(timed, get(`/api/v1/snapshot?t=${iso(NOW - 5 * HOUR)}`))).status).toBe(200);
    // The semaphore itself: a driver error inside its permit gives the permit back.
    const direct = new Semaphore({ permits: 1 });
    await expect(direct.run(() => sql`SELECT 1/0`.execute(api.db))).rejects.toMatchObject({ code: '22012' });
    expect(direct.state).toEqual({ free: 1, waiting: 0 });
  });
});

describe('health under saturation (C5)', () => {
  const state = { ms: NOW };
  const clocked = (extra: Parameters<typeof createApp>[0] = {}, db: Db['db'] = api.db) =>
    createApp({ db, window, now: () => new Date(state.ms), log: captureLog(logs), ...extra });
  const holdFor = (semaphore: Semaphore) => {
    let release: () => void = () => undefined;
    const held = semaphore.run(() => new Promise<void>((r) => (release = r)));
    return { release: () => release(), held };
  };

  for (const path of ['/api/v1/health', '/api/v1/health/sources']) {
    it(`${path}: with no permit it answers the last good body (at most 60 s old) with X-Stale and no-store, then 503 busy`, async () => {
      state.ms = NOW;
      const semaphore = new Semaphore({ permits: 1, maxWaiters: 0 });
      const app = clocked({ semaphore });
      const good = await one(app, get(path));
      expect(good.status).toBe(200);
      expect(good.headerMap['cache-control']).toBe('public, max-age=30');
      expect(good.headerMap['x-stale']).toBeUndefined();
      const { release, held } = holdFor(semaphore);
      await new Promise((r) => setTimeout(r, 20));
      expect(semaphore.state.free).toBe(0);
      // Inside the 30 s cache: still the fresh answer, no permit needed.
      state.ms = NOW + 20_000;
      expect((await one(app, get(path))).headerMap['x-stale']).toBeUndefined();
      // Expired, and the permit is held: the last good body, marked stale.
      state.ms = NOW + 40_000;
      const stale = await one(app, get(path));
      expect([stale.status, stale.headerMap['cache-control'], stale.headerMap['x-stale'], stale.text]).toEqual([
        200,
        'no-store',
        '1',
        good.text,
      ]);
      // Older than 60 s: no stale body is served, the answer is the 503 busy.
      state.ms = NOW + 70_000;
      const busy = await one(app, get(path));
      expect([busy.status, busy.text, busy.headerMap['retry-after'], busy.headerMap['cache-control']]).toEqual([
        503,
        ERR('busy'),
        '2',
        'no-store',
      ]);
      release();
      await held;
      // The permit is back: a fresh computation, no stale mark.
      const fresh = await one(app, get(path));
      expect([fresh.status, fresh.headerMap['x-stale'], fresh.headerMap['cache-control']]).toEqual([
        200,
        undefined,
        'public, max-age=30',
      ]);
      expect(semaphore.state).toEqual({ free: 1, waiting: 0 });
    });

    it(`${path}: with no good body yet and no permit it is a 503 busy with Retry-After, and nothing is cached`, async () => {
      state.ms = NOW;
      const semaphore = new Semaphore({ permits: 1, maxWaiters: 0 });
      const app = clocked({ semaphore });
      const { release, held } = holdFor(semaphore);
      await new Promise((r) => setTimeout(r, 20));
      const a = await one(app, get(path));
      expect([a.status, a.text, a.headerMap['retry-after']]).toEqual([503, ERR('busy'), '2']);
      release();
      await held;
      expect((await one(app, get(path))).status).toBe(200);
    });
  }

  it('a real database error stays the cached 503 health body (the watchdog sees down), retried only after 5 s', async () => {
    state.ms = NOW;
    const dead = openDb(dbConfig({ DATABASE_URL: t.urlFor('rws_api') }, 'rws_api') as DbConfig, { max: 1 });
    await sql`SELECT 1`.execute(dead.db); // a Kysely that never ran a query has no driver to destroy
    await dead.close();
    const lines: string[] = [];
    const app = createApp({
      db: dead.db,
      window,
      now: () => new Date(state.ms),
      log: captureLog(lines),
      semaphore: new Semaphore({ permits: 2 }),
    });
    const down = '{"status":"down","error":"unavailable","attribution":[]}';
    for (let i = 0; i < 3; i++) {
      const a = await one(app, get('/api/v1/health'));
      expect([a.status, a.text, a.headerMap['cache-control'], a.headerMap['x-stale']]).toEqual([
        503,
        down,
        'no-store',
        undefined,
      ]);
    }
    expect(lines.length).toBe(1); // one attempt: the error was cached
    state.ms = NOW + 6_000;
    expect((await one(app, get('/api/v1/health'))).status).toBe(503);
    expect(lines.length).toBe(2);
  });
});

describe('50 identical concurrent requests are one database computation', () => {
  const cold = (n: number) => `/api/v1/snapshot?t=${iso(NOW - n * HOUR - 17 * 60_000)}`;

  it('50 cold /snapshot requests: the queries of ONE computation, 50 identical bodies', async () => {
    // What one computation costs, measured on a request of its own.
    const probe = mk();
    const m1 = spies();
    expect((await one(probe, get(cold(5)))).status).toBe(200);
    const single = { connect: m1.connect.mock.calls.length, query: m1.query.mock.calls.length };
    expect(single.connect).toBe(2); // the classification's static rows, and the read at t
    expect(single.query).toBeGreaterThan(2);
    vi.restoreAllMocks();

    const app = mk();
    const { connect, query } = spies();
    const all = await Promise.all(Array.from({ length: 50 }, () => one(app, get(cold(6)))));
    expect(all.map((a) => a.status)).toEqual(Array.from({ length: 50 }, () => 200));
    expect(new Set(all.map((a) => a.text)).size).toBe(1);
    expect(connect.mock.calls.length).toBe(single.connect);
    expect(query.mock.calls.length).toBe(single.query);
    // A 51st, served from the cache: no query at all.
    expect((await one(app, get(cold(6)))).text).toBe(all[0]?.text);
    expect(connect.mock.calls.length).toBe(single.connect);
    expect(query.mock.calls.length).toBe(single.query);
  });

  it('50 requests split across identity, gzip and zstd: still one computation, the same body in each coding', async () => {
    const probe = mk();
    const m1 = spies();
    await one(probe, get(cold(8)));
    const single = m1.query.mock.calls.length;
    vi.restoreAllMocks();

    const app = mk();
    const { connect, query } = spies();
    const all = await Promise.all(
      Array.from({ length: 50 }, (_, i) => ask(app, get(cold(9)), CODINGS[i % 3] as (typeof CODINGS)[number])),
    );
    expect(all.map((a) => a.status)).toEqual(Array.from({ length: 50 }, () => 200));
    expect(new Set(all.map((a) => a.text)).size).toBe(1);
    expect(all.filter((a) => a.coding === 'gzip').every((a) => a.encoding === 'gzip')).toBe(true);
    expect(all.filter((a) => a.coding === 'zstd').every((a) => a.encoding === 'zstd')).toBe(true);
    expect(all.filter((a) => a.coding === 'identity').every((a) => a.encoding === null)).toBe(true);
    expect(connect.mock.calls.length).toBe(2);
    expect(query.mock.calls.length).toBe(single);
  });

  it('50 concurrent /series and /forecast requests are one computation each, and distinct keys are not merged', async () => {
    const app = mk();
    const win = `from=${iso(NOW - DAY)}&to=${iso(NOW)}`;
    await one(app, get(cold(1))); // warm the static rows: a computation is now one connection
    const { connect } = spies();
    const same = await Promise.all(
      Array.from({ length: 50 }, () => one(app, get(`/api/v1/series/${ids.public}?${win}`))),
    );
    expect(new Set(same.map((a) => a.text)).size).toBe(1);
    expect(connect.mock.calls.length).toBe(1);
    const forecast = await Promise.all(
      Array.from({ length: 50 }, () => one(app, get(`/api/v1/series/${ids.public}/forecast`))),
    );
    expect(new Set(forecast.map((a) => a.text)).size).toBe(1);
    expect(connect.mock.calls.length).toBe(2);
    // Ten distinct keys are ten computations (and a mixed flood of 50 over 10 keys, ten).
    const keys = Array.from({ length: 10 }, (_, i) => get(cold(20 + i)));
    const before = connect.mock.calls.length;
    await Promise.all(Array.from({ length: 50 }, (_, i) => one(app, keys[i % 10] as Req)));
    expect(connect.mock.calls.length - before).toBe(10);
  });

  it('a failed computation is not shared as a body or cached: each waiter gets a fresh fixed 503, and the next call recomputes', async () => {
    const semaphore = new Semaphore({ permits: 1, maxWaiters: 0 });
    const app = mk({ semaphore });
    const held = semaphore.run(() => sql`SELECT pg_sleep(0.5)`.execute(api.db));
    await new Promise((r) => setTimeout(r, 20));
    const all = await Promise.all(Array.from({ length: 20 }, () => one(app, get(cold(30)))));
    expect(new Set(all.map((a) => `${a.status} ${a.text}`))).toEqual(new Set([`503 ${ERR('busy')}`]));
    await held;
    const ok = await one(app, get(cold(30)));
    expect(ok.status).toBe(200);
  });
});
