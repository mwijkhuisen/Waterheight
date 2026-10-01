import { describe, expect, it, vi } from 'vitest';
import type { DisplayWindow } from '../src/api/window.ts';
import { createApp } from '../src/app.ts';
import { openApiDb } from '../src/main.ts';
import { fakeDb } from './api/fake-db.ts';

describe('GET /healthz', () => {
  it('answers 200 with a status and nothing else', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('leaks no version or server header', async () => {
    const res = await createApp().request('/healthz');
    const text = JSON.stringify([...res.headers]) + (await res.text());
    expect(text).not.toMatch(/version|hono|node|\d+\.\d+\.\d+/i);
  });

  it('serves nothing else', async () => {
    expect((await createApp().request('/')).status).toBe(404);
    expect((await createApp().request('/healthz', { method: 'POST' })).status).toBe(404);
  });
});

describe('the health routes without a database', () => {
  const unavailable = '{"status":"down","error":"unavailable"}';

  it('answer 503 with a fixed body and no caching, while /healthz stays 200', async () => {
    const app = createApp();
    for (const path of ['/api/v1/health', '/api/v1/health/sources']) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe(unavailable);
    }
    expect(await (await app.request('/healthz')).json()).toEqual({ status: 'ok' });
  });

  it('answer 400 to any query parameter before anything else, without echoing it', async () => {
    const res = await createApp().request('/api/v1/health?leak=SECRET');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"error":"unknown_parameter"}');
    expect((await createApp().request('/api/v1/health/sources?x=1')).status).toBe(400);
  });

  it('everything else under /api/ is a 404, and only GET and HEAD are served', async () => {
    const app = createApp();
    for (const path of ['/api/', '/api/v1', '/api/v1/', '/api/v1/health/', '/api/v1/health/x', '/api/v1/stations/']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe('{"error":"not_found"}');
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await app.request('/api/v1/health', { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect([...res.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('logs a fixed code once per attempt, never per request', async () => {
    const lines: unknown[] = [];
    const app = createApp({ log: { error: ((o: unknown) => lines.push(o)) as never } });
    for (let i = 0; i < 5; i += 1) await app.request('/api/v1/health');
    expect(lines).toEqual([{ code: 'no_database', route: '/api/v1/health' }]);
  });
});

describe('the data routes without a database', () => {
  it('answer 503 with a fixed body and no caching; the OpenAPI document needs none', async () => {
    const app = createApp();
    for (const path of [
      '/api/v1/meta',
      '/api/v1/stations',
      '/api/v1/snapshot?t=2026-10-01T00:00Z',
      '/api/v1/series/1?from=2026-09-30T00:00Z&to=2026-10-01T00:00Z',
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('{"error":"unavailable"}');
    }
    const doc = await app.request('/api/v1/openapi.json');
    expect(doc.status).toBe(200);
    expect(doc.headers.get('cache-control')).toBe('public, max-age=300');
    expect(((await doc.json()) as { openapi: string }).openapi).toBe('3.1.0');
  });
});

describe('the data routes when the database fails', () => {
  it('answer 503 with a fixed body, log one fixed code per computation and cache nothing', async () => {
    const dead = openApiDb({ DATABASE_URL: 'postgres://nobody:secret@127.0.0.1:1/nowhere' });
    if (typeof dead === 'string') throw new Error(dead);
    const lines: unknown[] = [];
    const window = { current: { dataEpochMs: 0, displayStartMs: Date.parse('2026-08-24T00:00:00Z') } };
    const app = createApp({
      db: dead.db,
      window: window as unknown as DisplayWindow,
      now: () => new Date('2026-10-01T12:00:00Z'),
      log: { error: ((o: unknown) => lines.push(o)) as never },
    });
    try {
      const path = '/api/v1/snapshot?t=2026-10-01T11:00Z';
      const answers = await Promise.all([1, 2, 3].map(() => app.request(path)));
      for (const res of answers) {
        expect(res.status).toBe(503);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.text()).toBe('{"error":"unavailable"}');
      }
      // Three callers of one key share one computation, so one line, with a code and nothing else.
      expect(lines).toEqual([{ code: 'ECONNREFUSED', route: 'snapshot' }]);
      expect((await app.request(path)).status).toBe(503);
      expect(lines).toHaveLength(2);
    } finally {
      await dead.close();
    }
  });
});

describe('the in-flight cap of the data routes', () => {
  it('refuses a 65th distinct key in flight with 503 busy, joins a key in flight, and never refuses /meta or /stations', async () => {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let waiting = 0;
    // A snapshot (a statement with a parameter) waits; the fixed reads of /meta and /stations find no rows at once.
    const db = fakeDb(async (q) => {
      if (q.parameters.length > 0) {
        waiting += 1;
        await held;
      }
      return { rows: [] };
    });
    const window = { current: { dataEpochMs: 0, displayStartMs: Date.parse('2026-08-24T00:00:00Z') } };
    const app = createApp({
      db,
      window: window as unknown as DisplayWindow,
      now: () => new Date('2026-10-01T12:00:00Z'),
    });
    const path = (i: number) =>
      `/api/v1/snapshot?t=${new Date(Date.parse('2026-10-01T00:00:00Z') + i * 600_000).toISOString()}`;
    const first = Array.from({ length: 64 }, (_, i) => app.request(path(i)));
    await vi.waitFor(() => expect(waiting).toBe(64));

    const busy = await app.request(path(64));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect(busy.headers.get('cache-control')).toBe('no-store');
    expect(await busy.text()).toBe('{"error":"busy"}');
    const joined = app.request(path(0));
    // The fixed keys are a closed set: the cap never refuses them (review SR-1).
    for (const fixed of ['/api/v1/meta', '/api/v1/stations']) {
      const res = await app.request(fixed);
      expect(res.status, fixed).toBe(200);
      expect(res.headers.get('cache-control'), fixed).not.toBe('no-store');
    }
    expect(waiting).toBe(64);

    release();
    expect((await Promise.all([...first, joined])).map((r) => r.status)).toEqual(Array(65).fill(200));
    expect((await app.request(path(64))).status).toBe(200);
  });
});
