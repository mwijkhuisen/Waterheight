import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Channel, channelViews, ROUTES, type RouteDef } from '../../src/api/channels.ts';
import { createApp } from '../../src/app.ts';
import { type ChannelAudience, VIEWS } from '../../src/db/audience.ts';

// C21, the bulk_export guard (P9b): every route names its licence channel, a route reads its views only through
// channelViews, and a route tagged `export` fails before it reads anything.

const FAMILIES: ChannelAudience[] = ['public', 'owner'];
const API_DIR = new URL('../../src/api/', import.meta.url).pathname;
const apiSources = () =>
  readdirSync(API_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(API_DIR, f), 'utf8') }));

describe('channelViews', () => {
  it.each(FAMILIES)('export throws no_export_channel for the %s family', (family) => {
    expect(() => channelViews(family, 'export')).toThrow(expect.objectContaining({ code: 'no_export_channel' }));
  });

  it.each(FAMILIES)('api is the api views of the %s family', (family) => {
    expect(channelViews(family, 'api')).toBe(VIEWS[family].api);
    expect(channelViews(family, 'api')).toEqual(VIEWS[family].api);
  });

  it.each(FAMILIES)('display is the display views of the %s family', (family) => {
    expect(channelViews(family, 'display')).toBe(VIEWS[family]);
  });

  it.each(FAMILIES)('meta holds the views without an observation value, and nothing else (%s)', (family) => {
    const v = channelViews(family, 'meta');
    expect(Object.keys(v).sort()).toEqual(
      ['attribution', 'dayVersion', 'ingestBatch', 'meta', 'source', 'sourceHealth', 'twinCheck'].sort(),
    );
    for (const [k, name] of Object.entries(v))
      expect(name, k).toBe((VIEWS[family] as unknown as Record<string, string>)[k]);
  });

  it('a route tagged export fails before any read', () => {
    const route: RouteDef = {
      path: '/api/v1/export/series',
      method: 'GET',
      channel: 'export',
      rate: 'heavy',
      versioned: false,
      planned: false,
    };
    let read = false;
    // What a handler does first: take its views from its channel, then query.
    const handler = (family: ChannelAudience) => {
      const V = channelViews(family, route.channel as 'export');
      read = true;
      return V;
    };
    for (const family of FAMILIES)
      expect(() => handler(family)).toThrow(expect.objectContaining({ code: 'no_export_channel' }));
    expect(read).toBe(false);
  });

  it('no route of the table serves the export channel yet', () => {
    expect(ROUTES.filter((r) => r.channel === 'export')).toEqual([]);
  });
});

describe('ROUTES', () => {
  it('has unique method and path pairs, and unique paths', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const paths = ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('is GET everywhere except the beacon, which is the one POST', () => {
    expect(ROUTES.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path])).toEqual([
      ['POST', '/api/v1/beacon'],
    ]);
    for (const r of ROUTES) expect(r.path.startsWith('/api/v1/'), r.path).toBe(true);
  });

  it('every channel and rate class is one the code knows', () => {
    const channels: Channel[] = ['display', 'api', 'export', 'meta'];
    for (const r of ROUTES) {
      expect(channels, r.path).toContain(r.channel);
      expect(['general', 'heavy', 'beacon'], r.path).toContain(r.rate);
    }
  });

  it('the beacon is the only beacon-class route and the series routes are heavy', () => {
    expect(ROUTES.filter((r) => r.rate === 'beacon').map((r) => r.path)).toEqual(['/api/v1/beacon']);
    for (const r of ROUTES.filter((x) => x.path.startsWith('/api/v1/series/'))) expect(r.rate).toBe('heavy');
  });

  it('only /stations/:id is planned, not built', () => {
    expect(ROUTES.filter((r) => r.planned).map((r) => r.path)).toEqual(['/api/v1/stations/:id']);
  });
});

describe('the api channel is read through channelViews only', () => {
  it('no file of src/api other than channels.ts reaches an api view by another way', () => {
    const patterns: [string, RegExp][] = [
      ['VIEWS[..].api', /VIEWS\s*\[[^\]]*\]\s*\.\s*api\b/],
      ['.api. access', /\.api\./],
      ['V.api', /\bV\.api\b/],
      ['destructured api', /\{[^}]*\bapi\b[^}]*\}\s*=\s*VIEWS/],
    ];
    const found: string[] = [];
    for (const { file, text } of apiSources()) {
      if (file === 'channels.ts') continue;
      for (const [label, re] of patterns) if (re.test(text)) found.push(`${file}: ${label}`);
    }
    expect(found).toEqual([]);
  });

  it('the scan sees what it should: it flags a planted access', () => {
    const planted = ['const V = VIEWS[family].api;', 'const x = V.api.series;', 'const { api } = VIEWS.public;'];
    const re = [/VIEWS\s*\[[^\]]*\]\s*\.\s*api\b/, /\bV\.api\b/, /\{[^}]*\bapi\b[^}]*\}\s*=\s*VIEWS/];
    expect(planted.map((p, i) => re[i]?.test(p))).toEqual([true, true, true]);
  });

  it('every built route of the api channel has a handler that reads channelViews(.., "api")', () => {
    const handlers: Record<string, string> = {
      '/api/v1/series/:id': 'data.ts',
      '/api/v1/series/:id/forecast': 'forecast-at.ts',
      '/api/v1/frames': 'data.ts',
    };
    const apiRoutes = ROUTES.filter((r) => r.channel === 'api' && r.method === 'GET' && !r.planned);
    expect(apiRoutes.map((r) => r.path).sort()).toEqual(Object.keys(handlers).sort());
    const sources = new Map(apiSources().map((s) => [s.file, s.text]));
    for (const r of apiRoutes) {
      const file = handlers[r.path] as string;
      const text = sources.get(file);
      expect(text, file).toBeDefined();
      expect(text, `${file} for ${r.path}`).toMatch(/channelViews\(\s*family\s*,\s*'api'\s*\)/);
    }
  });

  it('no handler asks channelViews for the display channel where the route is api', () => {
    const sources = new Map(apiSources().map((s) => [s.file, s.text]));
    for (const file of ['forecast-at.ts']) {
      const calls = [...(sources.get(file) ?? '').matchAll(/channelViews\([^)]*\)/g)].map((m) => m[0]);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const c of calls) expect(c, file).toMatch(/'api'/);
    }
  });
});

describe('the served routes are the route table (review F8)', () => {
  it('every route the app registers under /api/v1 is a non-planned entry of ROUTES with its method, and back', () => {
    const app = createApp({ sections: new Map() });
    const served = new Set(
      app.routes
        .filter((r) => r.path.startsWith('/api/v1/') && !r.path.endsWith('*') && r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    );
    const table = new Set(ROUTES.filter((r) => !r.planned).map((r) => `${r.method} ${r.path}`));
    expect([...served].sort()).toEqual([...table].sort());
    // Nothing planned is served yet: a route that is built must leave `planned` (and so join the canary sweeps).
    for (const r of ROUTES.filter((x) => x.planned)) expect(served.has(`${r.method} ${r.path}`), r.path).toBe(false);
  });
});
