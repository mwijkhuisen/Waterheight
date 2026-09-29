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
