import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { visibleSources } from '../../src/api/forecast.ts';
import type { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { fakeDb } from './fake-db.ts';

// The brownout (P12a, A§9.2) through the real app on a database that answers nothing: every refusal happens before
// any query, the fixed documents come from empty rows. The flag is injected, so no file is involved.

const NOW = new Date('2026-10-26T12:00:00Z');
const DAY = 86_400_000;
const window = { current: { dataEpochMs: 0, displayStartMs: Date.parse('2026-08-24T00:00:00Z') } };
const db = fakeDb(async (q) =>
  q.sql.includes(`"${VIEWS.public.source}"`)
    ? { rows: [...visibleSources('public')].map((id) => ({ id })) }
    : { rows: [] },
);

const appWith = (on: { value: boolean }, family: 'public' | 'owner' = 'public'): Hono =>
  createApp({
    family,
    db,
    window: window as unknown as DisplayWindow,
    now: () => NOW,
    sections: new Map(),
    brownout: () => on.value,
  });
const series = (query: string) => `/api/v1/series/1?${query}`;
const iso = (ms: number) => new Date(ms).toISOString();
const span = (days: number, res?: string) =>
  `from=${iso(NOW.getTime() - days * DAY)}&to=${iso(NOW.getTime())}${res === undefined ? '' : `&res=${res}`}`;

describe('brownout on the public api', () => {
  it('refuses an explicit res=raw with 503 brownout, X-Brownout, no-store, and only while on', async () => {
    const flag = { value: true };
    const app = appWith(flag);
    const res = await app.request(series(span(1, 'raw')));
    expect(res.status).toBe(503);
    expect(res.headers.get('x-brownout')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"error":"brownout","attribution":[]}');
    // Off: the same request passes validation (the empty database then has no such series: 404).
    flag.value = false;
    const off = await app.request(series(span(1, 'raw')));
    expect(off.status).toBe(404);
    expect(off.headers.get('x-brownout')).toBeNull();
  });

  it('caps the span at 30 days (span_too_long, 400) and lets 30 days through', async () => {
    const app = appWith({ value: true });
    for (const q of [span(31), span(31, '1h'), span(60, '1d')]) {
      const res = await app.request(series(q));
      expect([res.status, await res.text()], q).toEqual([400, '{"error":"span_too_long","attribution":[]}']);
      expect(res.headers.get('x-brownout')).toBeNull();
    }
    expect((await app.request(series(span(30)))).status).toBe(404); // valid, the series is unknown here
    expect((await app.request(series(span(30, '1h')))).status).toBe(404);
  });

  it('raises the mutable TTLs and keeps the shape of the header', async () => {
    const flag = { value: true };
    const app = appWith(flag);
    const cache = async (path: string) => (await app.request(path)).headers.get('cache-control');
    expect(await cache('/api/v1/meta')).toBe('public, max-age=300');
    expect(await cache('/api/v1/stations')).toBe('public, max-age=1500');
    expect(await cache('/api/v1/openapi.json')).toBe('public, max-age=1500');
    expect(await cache('/api/v1/snapshot?t=2026-10-26T12:00:00Z')).toBe(
      'public, max-age=300, stale-while-revalidate=300',
    );
    expect(await cache('/api/v1/snapshot?t=2026-10-26T11:00:00Z')).toBe('public, max-age=3000');
    flag.value = false;
    expect(await cache('/api/v1/openapi.json')).toBe('public, max-age=300');
    expect(await cache('/api/v1/snapshot?t=2026-10-26T11:00:00Z')).toBe('public, max-age=600');
  });
});

describe('brownout on the owner api', () => {
  it('is ignored: no brownout refusal, no span cap, the owner no-store', async () => {
    const app = appWith({ value: true }, 'owner');
    const raw = await app.request(series(span(1, 'raw')));
    expect(raw.headers.get('x-brownout')).toBeNull();
    expect(await raw.text()).not.toContain('brownout');
    const long = await app.request(series(span(60, '1d')));
    expect(await long.text()).not.toContain('span_too_long');
    expect((await app.request('/api/v1/openapi.json')).headers.get('cache-control')).toBe('private, no-store');
  });
});
