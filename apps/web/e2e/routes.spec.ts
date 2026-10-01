import { type APIResponse, expect, test } from '@playwright/test';
import { siteHeaders } from './headers.ts';

// P4b routes (issue #19): what the site answers for the api, the assets, the app routes and everything else,
// against the stand-in for Caddy (server.ts) locally and the real Caddy with site.caddy in CI. No browser is
// needed: the `request` fixture runs once, in the chromium project. The e2e api's clock is 2026-10-26T12:00Z.

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'no browser involved: runs once, in the chromium project');
});

/** Every answer of the site, whatever its status, carries the A§12.2 headers and names no software. */
function expectSiteHeaders(res: APIResponse) {
  const headers = res.headers();
  expect(headers['x-robots-tag']).toBe('noindex');
  for (const [name, value] of siteHeaders()) expect(headers[name.toLowerCase()], name).toBe(value);
  expect(headers.server, 'no Server header').toBeUndefined();
  expect(headers.via, 'no Via header').toBeUndefined();
}

const JSON_TYPE = /^application\/json(;|$)/;

test('GET /api/v1/meta: JSON, cached 60 s, the build and the two public sources', async ({ request }) => {
  const res = await request.get('/api/v1/meta');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(JSON_TYPE);
  expect(res.headers()['cache-control']).toBe('public, max-age=60');
  expectSiteHeaders(res);
  const body = (await res.json()) as { build: string; now: string; sources: { id: string }[] };
  expect(body.build).toBe('dev');
  expect(body.now).toBe('2026-10-26T12:00:00.000Z');
  expect(body.sources.map((s) => s.id)).toEqual(expect.arrayContaining(['NL-1', 'DE-1']));
});

test('HEAD /api/v1/meta answers like GET without a body', async ({ request }) => {
  const res = await request.head('/api/v1/meta');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('public, max-age=60');
  expectSiteHeaders(res);
  expect((await res.body()).length).toBe(0);
});

test('GET /api/v1/stations: JSON, cached 300 s, the e2e stations among the registry', async ({ request }) => {
  const res = await request.get('/api/v1/stations');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(JSON_TYPE);
  expect(res.headers()['cache-control']).toBe('public, max-age=300');
  expectSiteHeaders(res);
  const body = (await res.json()) as { stations: { id: string }[] };
  expect(body.stations.length).toBeGreaterThan(260);
  expect(body.stations.map((s) => s.id)).toEqual(expect.arrayContaining(['nl.e2e.xss', 'nl.e2e.gap', 'nl.e2e.dst']));
});

// The seed holds values from 2026-10-24: before it, a snapshot is empty (and cached for a day all the same).
for (const [t, cache, seeded] of [
  ['2026-10-26T12:00Z', 'public, max-age=60, stale-while-revalidate=300', true],
  ['2026-10-25T00:30Z', 'public, max-age=600', true],
  ['2026-10-20T00:00Z', 'public, max-age=86400', false],
] as const)
  test(`GET /api/v1/snapshot?t=${t}: ${cache}`, async ({ request }) => {
    const res = await request.get(`/api/v1/snapshot?t=${t}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(JSON_TYPE);
    expect(res.headers()['cache-control']).toBe(cache);
    expectSiteHeaders(res);
    const body = (await res.json()) as { t: string; values: unknown[] };
    expect(body.t).toBe(`${t.slice(0, 16)}:00.000Z`);
    if (seeded) expect(body.values.length).toBeGreaterThan(300);
    else expect(body.values).toEqual([]);
  });

test('the api answers its own refusals as fixed JSON codes, never cached', async ({ request }) => {
  for (const [path, status, error] of [
    ['/api/v1/meta?x=1', 400, 'unknown_parameter'],
    ['/api/v1/snapshot?t=2026-10-26T12:00Z&t=2026-10-26T11:00Z', 400, 'repeated_parameter'],
    ['/api/v1/snapshot?t=2026-10-26T12:00', 400, 'bad_parameter'],
    ['/api/v1/snapshot?t=2030-01-01T00:00Z', 400, 'out_of_range'],
    ['/api/v1/x', 404, 'not_found'],
    ['/api/v1/series/0', 400, 'bad_parameter'],
    ['/api/v1/series/999999?from=2026-10-26T00:00Z&to=2026-10-26T06:00Z', 404, 'not_found'],
  ] as const) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(status);
    expect(res.headers()['content-type'], path).toMatch(JSON_TYPE);
    expect(res.headers()['cache-control'], path).toBe('no-store');
    expect(await res.text(), path).toBe(JSON.stringify({ error }));
    expectSiteHeaders(res);
  }
});

test('GET /api/v1/openapi.json is the OpenAPI 3.1 document', async ({ request }) => {
  const res = await request.get('/api/v1/openapi.json');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(JSON_TYPE);
  expect(res.headers()['cache-control']).toBe('public, max-age=300');
  expectSiteHeaders(res);
  const body = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
  expect(body.openapi).toBe('3.1.0');
  expect(Object.keys(body.paths)).toEqual(expect.arrayContaining(['/api/v1/meta', '/api/v1/snapshot']));
});

test('another method under /api/v1/ is a 405 with Allow: GET, HEAD', async ({ request }) => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await request.fetch('/api/v1/meta', { method });
    expect(res.status(), method).toBe(405);
    expect(res.headers().allow, method).toBe('GET, HEAD');
    expectSiteHeaders(res);
  }
  // Any case, any path under /api/v1/.
  const res = await request.post('/API/v1/stations');
  expect(res.status()).toBe(405);
  expect(res.headers().allow).toBe('GET, HEAD');
});

test('the wrong case and the rest of /api are a 404', async ({ request }) => {
  for (const path of ['/API/v1/meta', '/api', '/api/', '/api/v1', '/api/x', '/api/v1/.hidden']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()['content-type'] ?? '', path).not.toMatch(/html/);
    expectSiteHeaders(res);
  }
});

test('a GET with a body over the limit is a 413', async ({ request }) => {
  // The api reads no request body; at most 1 KB reaches it. (Caddy's 413 comes without the site headers, KG-107.)
  const res = await request.fetch('/api/v1/meta', { method: 'GET', data: 'x'.repeat(2048) });
  expect(res.status()).toBe(413);
});

test('a miss under /assets, /tiles or /status, and the files that do not exist, are 404s, never HTML', async ({
  request,
}) => {
  for (const path of [
    '/assets/no-such-file.js',
    '/assets/no-such-file',
    '/assets',
    '/assets/',
    '/tiles/x',
    '/tiles',
    '/status/x',
    '/status',
    '/favicon.ico',
    '/robots.txt',
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()['content-type'] ?? '', path).not.toMatch(/html/);
    expect(res.headers()['cache-control'] ?? '', path).not.toMatch(/immutable|max-age=[1-9]/);
    expect(await res.text(), path).not.toMatch(/<html|<!doctype/i);
    expectSiteHeaders(res);
  }
});

test('app routes answer the page of their language; /en redirects to /en/', async ({ request, baseURL }) => {
  const en = await request.get('/en/some/app/route');
  expect(en.status()).toBe(200);
  expect(en.headers()['content-type']).toMatch(/^text\/html/);
  expect(await en.text()).toContain('<html lang="en"');
  expectSiteHeaders(en);

  const nl = await request.get('/some-route');
  expect(nl.status()).toBe(200);
  expect(nl.headers()['content-type']).toMatch(/^text\/html/);
  expect(await nl.text()).toContain('<html lang="nl"');
  expectSiteHeaders(nl);

  for (const [path, lang] of [
    ['/', 'nl'],
    ['/en/', 'en'],
  ] as const) {
    const page = await request.get(path);
    expect(page.status(), path).toBe(200);
    expect(await page.text(), path).toContain(`<html lang="${lang}"`);
    expect(page.headers()['cache-control'] ?? '', path).not.toMatch(/immutable/);
  }

  const redirect = await request.get('/en', { maxRedirects: 0 });
  expect(redirect.status()).toBe(308);
  expect(new URL(redirect.headers().location ?? '', new URL('/en', baseURL)).pathname).toBe('/en/');
  expectSiteHeaders(redirect);
});

test('/third-party-notices.txt is plain text and names maplibre-gl@6.11.1', async ({ request }) => {
  const res = await request.get('/third-party-notices.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^text\/plain/);
  expect(await res.text()).toContain('maplibre-gl@6.11.1');
  expectSiteHeaders(res);
});
