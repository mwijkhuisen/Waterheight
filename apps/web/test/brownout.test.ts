import { describe, expect, it } from 'vitest';
import { seriesPath } from '../src/lib/data/api.ts';
import { type Fetcher, loadMeta } from '../src/lib/data/chain.ts';

// P12a: the web side of the brownout flag: meta.json carries it, the API's meta never does, and the chart asks hourly
// (the API refuses raw while the brownout is on).

const NOW = '2026-10-26T12:00:00.000Z';
const base = {
  now: NOW,
  dataEpoch: '2026-10-24T00:00:00Z',
  displayStart: '2026-10-24T00:00:00Z',
  build: 'dev',
  sources: [],
  forecastHorizons: [],
  attribution: [],
};
const staticMeta = (extra: Record<string, unknown>) => ({
  ...base,
  schemaVersion: 1,
  generatedAt: NOW,
  dayVersions: {},
  degraded: false,
  latestFrom: null,
  ...extra,
});
const fetcher =
  (bodies: Record<string, unknown>): Fetcher =>
  async (path) =>
    path in bodies ? new Response(JSON.stringify(bodies[path])) : new Response('', { status: 404 });

describe('brownout in meta', () => {
  it('meta.json states it; absent means off; the API fallback never states it', async () => {
    const on = await loadMeta(fetcher({ '/data/v1/meta.json': staticMeta({ brownout: true }) }));
    expect(on.brownout).toBe(true);
    const off = await loadMeta(fetcher({ '/data/v1/meta.json': staticMeta({ brownout: false }) }));
    expect(off.brownout).toBe(false);
    const absent = await loadMeta(fetcher({ '/data/v1/meta.json': staticMeta({}) }));
    expect(absent.brownout).toBeUndefined();
    const api = await loadMeta(fetcher({ '/api/v1/meta': base }));
    expect(api.brownout).toBeUndefined();
  });

  it('a non-boolean flag fails the static parse, so the API fallback answers', async () => {
    const f = fetcher({ '/data/v1/meta.json': staticMeta({ brownout: 'yes' }), '/api/v1/meta': base });
    expect((await loadMeta(f)).dayVersions).toEqual({});
  });
});

describe('seriesPath', () => {
  const from = Date.parse('2026-10-25T00:00:00Z');
  const to = Date.parse('2026-10-26T00:00:00Z');
  it('asks raw, or hourly in a brownout', () => {
    expect(seriesPath(7, from, to)).toMatch(/^\/api\/v1\/series\/7\?from=.+&to=.+&res=raw$/);
    expect(seriesPath(7, from, to, true)).toMatch(/&res=1h$/);
    expect(seriesPath(7, from, to, true).replace('1h', 'raw')).toBe(seriesPath(7, from, to));
  });
});
