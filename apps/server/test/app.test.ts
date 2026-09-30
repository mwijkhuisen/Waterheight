import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

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

  it('everything else under /api/ is a 404, and only GET is served', async () => {
    const app = createApp();
    for (const path of ['/api/', '/api/v1', '/api/v1/', '/api/v1/stations', '/api/v1/health/', '/api/v1/health/x'])
      expect((await app.request(path)).status, path).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
      expect((await app.request('/api/v1/health', { method })).status, method).toBe(404);
  });

  it('logs a fixed code once per attempt, never per request', async () => {
    const lines: unknown[] = [];
    const app = createApp({ log: { error: ((o: unknown) => lines.push(o)) as never } });
    for (let i = 0; i < 5; i += 1) await app.request('/api/v1/health');
    expect(lines).toEqual([{ code: 'no_database', route: '/api/v1/health' }]);
  });
});
