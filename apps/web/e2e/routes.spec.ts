import { type APIResponse, expect, test } from '@playwright/test';
import { PAGE_ROUTES } from '../src/lib/routes.ts';
import { productionCsp, securityTxt, siteHeaders } from './headers.ts';

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
    expect(await res.text(), path).toBe(JSON.stringify({ error, attribution: [] }));
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

test('any method but GET and HEAD is a 405 with Allow: GET, HEAD and the site headers, on every route', async ({
  request,
}) => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await request.fetch('/api/v1/meta', { method });
    expect(res.status(), method).toBe(405);
    expect(res.headers().allow, method).toBe('GET, HEAD');
    expectSiteHeaders(res);
  }
  // Any case under /api/v1/, the pages, an app route, the assets and the rest: never file_server's bare 405 (SR-3).
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(await (await request.get('/')).text())?.[1];
  expect(asset).toBeDefined();
  for (const path of [
    '/API/v1/stations',
    '/',
    '/en/',
    '/en/foo',
    asset ?? '',
    '/assets/x.js',
    '/healthz',
    '/status/x',
  ]) {
    const res = await request.post(path);
    expect(res.status(), path).toBe(405);
    expect(res.headers().allow, path).toBe('GET, HEAD');
    expect(res.headers()['cache-control'], path).toBeUndefined();
    expectSiteHeaders(res);
  }
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

test('a miss under /assets, /tiles or /status/, and the files that do not exist, are bare 404s, never HTML', async ({
  request,
}) => {
  // (/status itself is a page since P10b; the 404 shells are never served under their own names either)
  for (const path of [
    '/assets/no-such-file.js',
    '/assets/no-such-file',
    '/assets',
    '/assets/',
    '/tiles/x',
    '/tiles',
    '/status/x',
    '/favicon.ico',
    '/robots.txt',
    '/missing.txt',
    '/en/missing.png',
    '/404.html',
    '/en/404.html',
    '/404.HTML',
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()['content-type'] ?? '', path).not.toMatch(/html/);
    expect(res.headers()['cache-control'] ?? '', path).not.toMatch(/immutable|max-age=[1-9]/);
    expect(await res.text(), path).not.toMatch(/<html|<!doctype/i);
    expectSiteHeaders(res);
  }
});

// P10b: the pages are the exact paths of src/lib/routes.ts (the map and eight information pages in both languages, 18
// paths); /status is one of them. Any other path is a real 404 that carries the 404 shell of its language.
test('the pages answer 200 with the shell of their language; /en redirects to /en/', async ({ request, baseURL }) => {
  for (const r of PAGE_ROUTES)
    for (const lang of ['nl', 'en'] as const) {
      const res = await request.get(r[lang]);
      expect(res.status(), r[lang]).toBe(200);
      expect(res.headers()['content-type'], r[lang]).toMatch(/^text\/html/);
      expect(await res.text(), r[lang]).toContain(`<html lang="${lang}"`);
      expectSiteHeaders(res);
      // ADR-0016: no inline script or style is ever allowed, on any page.
      const csp = res.headers()['content-security-policy'] ?? '';
      expect(csp, r[lang]).not.toContain("'unsafe-inline'");
      expect(csp, r[lang]).not.toContain("'unsafe-eval'");
      expect(csp, r[lang]).toBe(productionCsp());
    }
  // The shells are served for the pages, and /index.html is the map as well.
  expect((await request.get('/index.html')).status()).toBe(200);

  const redirect = await request.get('/en', { maxRedirects: 0 });
  expect(redirect.status()).toBe(308);
  expect(new URL(redirect.headers().location ?? '', new URL('/en', baseURL)).pathname).toBe('/en/');
  expectSiteHeaders(redirect);
});

test('any other path is a 404 with the 404 shell of its language, never a page', async ({ request }) => {
  // (/status/ and anything else under it is Caddy's own bare 404 for the production status files, tested above)
  for (const [path, lang, heading] of [
    ['/niet-hier-p10b', 'nl', 'Pagina niet gevonden'],
    ['/some-route', 'nl', 'Pagina niet gevonden'],
    ['/over/', 'nl', 'Pagina niet gevonden'],
    ['/Over', 'nl', 'Pagina niet gevonden'],
    ['/EN/about', 'nl', 'Pagina niet gevonden'],
    ['/en/not-here-p10b', 'en', 'Page not found'],
    ['/en/some/app/route', 'en', 'Page not found'],
    ['/en/about/', 'en', 'Page not found'],
    ['/en//about', 'en', 'Page not found'],
  ] as const) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expectSiteHeaders(res);
    expect(res.headers()['cache-control'], path).toBe('no-cache');
    expect(res.headers()['content-type'], path).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html, path).toContain(`<html lang="${lang}"`);
    // The shell carries its own heading, so the 404 page says what it is before any script runs.
    expect(html, path).toContain(`<h1>${heading}</h1>`);
  }
});

// Only the real Caddy matches page paths the way production does: Caddy keeps a doubled slash in `{path}`, so a
// path that only looks like a page is no page (the stand-in's URL parser reads '//over' as a host, so it cannot say).
test('the real Caddy matches page paths exactly: a doubled slash, the other case and the shells are no pages', async ({
  request,
  baseURL,
}) => {
  test.skip(process.env.E2E_BASE_URL === undefined, 'needs the real Caddy (CI): the stand-in is not production');
  const origin = new URL(baseURL ?? '').origin;
  for (const path of ['/Over', '//over', '/EN/about', '//404.html']) {
    // (an absolute URL, so that '//over' is a path and not a host)
    const res = await request.get(`${origin}${path}`);
    expect(res.status(), path).toBe(404);
    expectSiteHeaders(res);
  }
});

test('the pages and the 404 shells are revalidated on every use (no-cache); the assets stay immutable', async ({
  request,
}) => {
  // A page kept past a deploy would ask for asset names the new image no longer has (CR-6).
  for (const path of ['/', '/index.html', '/en/', '/over', '/en/status', '/third-party-notices.txt']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['cache-control'], path).toBe('no-cache');
  }
  for (const path of ['/en/some/app/route', '/some-route'])
    expect((await request.get(path)).headers()['cache-control'], path).toBe('no-cache');
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(await (await request.get('/')).text())?.[1] ?? '';
  expect((await request.get(asset)).headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await request.get('/api/v1/meta')).headers()['cache-control']).toBe('public, max-age=60');
  for (const path of ['/assets/no-such-file.js', '/tiles/x', '/status/x', '/api/x'])
    expect((await request.get(path)).headers()['cache-control'], path).toBeUndefined();
});

// P12a, RFC 9116: the one file under /.well-known; every other dotfile stays a 404 (the route sits before it).
test('/.well-known/security.txt is plain text with the site headers; any other dotfile is a 404', async ({
  request,
}) => {
  const res = await request.get('/.well-known/security.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(res.headers()['cache-control']).toBe('no-cache');
  expectSiteHeaders(res);
  const body = await res.text();
  expect(body).toBe(securityTxt('localhost'));
  expect(body).toMatch(/^Contact: mailto:security@localhost$/m);
  for (const path of ['/.well-known/other', '/.well-known/', '/.env', '/.well-known/security.txt.bak']) {
    const miss = await request.get(path);
    expect(miss.status(), path).toBe(404);
    expect(miss.headers()['content-type'] ?? '', path).not.toMatch(/html/);
  }
});

test('/third-party-notices.txt is plain text and names maplibre-gl@6.11.2', async ({ request }) => {
  const res = await request.get('/third-party-notices.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^text\/plain/);
  expect(await res.text()).toContain('maplibre-gl@6.11.2');
  expectSiteHeaders(res);
});

// P10c: the brand's favicon, a file at the root like the notices (Caddy's @file): revalidated, never immutable.
test('/favicon.svg is the SVG favicon from our origin; /favicon.ico stays a bare 404', async ({ request }) => {
  const res = await request.get('/favicon.svg');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^image\/svg\+xml/);
  expect(res.headers()['cache-control']).toBe('no-cache');
  expect(await res.text()).not.toMatch(/<script|\son[a-z]+=|href=/i);
  expectSiteHeaders(res);
});

// P6b: the river files that rws-rivers-refresh installs (prepare-tiles.ts writes the e2e release 20261003).
const RIVERS = '20261003';
const IMMUTABLE = 'public, max-age=31536000, immutable';

test('the rivers manifest is JSON, cached 60 s, and names the three files of the release', async ({ request }) => {
  const res = await request.get('/data/v1/rivers/manifest.json');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(JSON_TYPE);
  expect(res.headers()['cache-control']).toBe('public, max-age=60');
  const m = await res.json();
  expect(m.current.version).toBe(RIVERS);
  expect(m.current.tiles.file).toBe(`rivers-${RIVERS}.pmtiles`);
  expect(m.previous).toBeNull();
  expectSiteHeaders(res);
});

test('the reaches file is immutable JSON; any other path under /data/v1/rivers is a bare 404', async ({ request }) => {
  const res = await request.get(`/data/v1/rivers/reaches-${RIVERS}.json`);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe(IMMUTABLE);
  expect((await res.json()).version).toBe(RIVERS);
  expectSiteHeaders(res);
  for (const path of [
    '/data/v1/rivers/reaches-20269999.json',
    '/data/v1/rivers/',
    '/data/v1/rivers',
    '/data/v1/rivers/Manifest.json',
    '/data/v1/rivers/x.txt',
  ]) {
    const miss = await request.get(path);
    expect(miss.status(), path).toBe(404);
    expect(miss.headers()['cache-control'], path).toBeUndefined();
    expectSiteHeaders(miss);
  }
});

test('the river tiles take one range like the basemap tiles: 206 immutable, no range 416, a miss 404', async ({
  request,
}) => {
  const path = `/tiles/rivers-${RIVERS}.pmtiles`;
  const ok = await request.get(path, { headers: { Range: 'bytes=0-15' } });
  expect(ok.status()).toBe(206);
  expect(ok.headers()['cache-control']).toBe(IMMUTABLE);
  expect((await ok.body()).subarray(0, 7).toString('latin1')).toBe('PMTiles');
  expectSiteHeaders(ok);
  expect((await request.get(path)).status()).toBe(416);
  expect((await request.get(path, { headers: { Range: 'bytes=0-' } })).status()).toBe(416);
  const miss = await request.get('/tiles/rivers-20269999.pmtiles', { headers: { Range: 'bytes=0-15' } });
  expect(miss.status()).toBe(404);
  expect(miss.headers()['cache-control']).toBeUndefined();
});

test('the ODbL download is gzip data: application/gzip, no Content-Encoding, immutable; the rest of /downloads is 404', async ({
  request,
}) => {
  const res = await request.get(`/downloads/rivers-${RIVERS}.geojson.gz`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/gzip');
  expect(res.headers()['content-encoding']).toBeUndefined();
  expect(res.headers()['cache-control']).toBe(IMMUTABLE);
  const body = await res.body();
  expect([body[0], body[1]]).toEqual([0x1f, 0x8b]);
  expectSiteHeaders(res);
  for (const path of ['/downloads/rivers-20269999.geojson.gz', '/downloads/', '/downloads', '/downloads/x.gz']) {
    const miss = await request.get(path);
    expect(miss.status(), path).toBe(404);
    expect(miss.headers()['cache-control'], path).toBeUndefined();
  }
});
