import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { PAGE_ROUTES } from '../src/lib/routes.ts';
import { robotsTxt, sitemapXml } from './headers.ts';
import { expectNoSeriousAxe, finish, msg, start } from './helpers.ts';

// P12b (A15): the public site in its LAUNCH phase (deploy/web/phase-launch.caddy; issue #27). CI runs a second real Caddy
// with RWS_SITE_PHASE=launch and RWS_DOMAIN=localhost:8444 (E2E_BASE_URL_LAUNCH, ci.yml job e2e); locally a third instance
// of the stand-in (server.ts, E2E_SITE_PHASE=launch, port 4445) answers for it. Every other spec expects the prelaunch
// phase (routes.spec.ts). What the launch changes, and only that: the pages lose X-Robots-Tag, robots.txt and the sitemap
// exist with absolute URLs of the configured domain, the Open Graph tags are absolute and the image is ours; the data
// paths and the 404 shells keep noindex, and the legal pages are still clean (axe, 0 CSP violations).

const launch =
  process.env.E2E_BASE_URL_LAUNCH ?? (process.env.E2E_BASE_URL === undefined ? 'https://localhost:4445' : undefined);
test.use({ ...(launch === undefined ? {} : { baseURL: launch }) });

test.beforeEach(({ browserName }) => {
  test.skip(launch === undefined, 'needs the launch-phase site (E2E_BASE_URL_LAUNCH): CI has one');
  test.skip(
    browserName !== 'chromium',
    'one browser is enough for the launch phase: runs once, in the chromium project',
  );
});

const origin = new URL(launch ?? 'https://localhost').origin;
const host = new URL(launch ?? 'https://localhost').host;
const PATHS = PAGE_ROUTES.flatMap((r) => [r.nl, r.en]);
/** The owner sources of registry/sources.yaml (the DE-2 flip changes no line here), the canary and the owner host. */
const OWNER_ID = new RegExp(
  `\\b(?:${(
    parse(readFileSync(new URL('../../../registry/sources.yaml', import.meta.url), 'utf8')) as {
      sources: { id: string; audience: string }[];
    }
  ).sources
    .filter((s) => s.audience === 'owner' && !s.id.startsWith('CANARY-'))
    .map((s) => s.id)
    .join('|')})\\b|CANARY|owner\\.`,
  'i',
);

test('robots.txt: plain text, 5 minutes, the sitemap of the configured domain, /api/ disallowed, no noindex on it', async ({
  request,
}) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(res.headers()['cache-control']).toBe('public, max-age=300');
  expect(res.headers()['x-robots-tag']).toBeUndefined();
  const body = await res.text();
  expect(body).toBe(robotsTxt(host));
  expect(body).toMatch(/^User-agent: \*$/m);
  for (const dir of ['api', 'tiles', 'data', 'downloads']) expect(body).toContain(`\nDisallow: /${dir}/\n`);
  expect(body).toContain(`Sitemap: ${origin}/sitemap.xml\n`);
  expect(body).not.toMatch(OWNER_ID);
});

test('sitemap.xml: XML, 5 minutes, the 18 pages of routes.ts with hreflang nl, en and x-default, absolute and of this origin', async ({
  request,
}) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/xml; charset=utf-8');
  expect(res.headers()['cache-control']).toBe('public, max-age=300');
  expect(res.headers()['x-robots-tag']).toBeUndefined();
  const body = await res.text();
  expect(body).toBe(sitemapXml(host));
  expect(body).not.toMatch(OWNER_ID);
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs).toEqual(PATHS.map((p) => `${origin}${p}`));
  const entries = body.split('<url>').slice(1);
  for (const route of PAGE_ROUTES) {
    for (const lang of ['nl', 'en'] as const) {
      const entry = entries.find((e) => e.startsWith(`<loc>${origin}${route[lang]}</loc>`)) ?? '';
      expect(entry, route[lang]).toContain(`<xhtml:link rel="alternate" hreflang="nl" href="${origin}${route.nl}"/>`);
      expect(entry, route[lang]).toContain(`<xhtml:link rel="alternate" hreflang="en" href="${origin}${route.en}"/>`);
      expect(entry, route[lang]).toContain(
        `<xhtml:link rel="alternate" hreflang="x-default" href="${origin}${route.nl}"/>`,
      );
    }
  }
  // every URL the file names is on this origin
  const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? '');
  expect(hrefs).toHaveLength(PATHS.length * 3);
  for (const url of hrefs) expect(url.startsWith(`${origin}/`), url).toBe(true);
});

test('no X-Robots-Tag on any of the 18 pages; the data paths and the 404 shells say noindex', async ({ request }) => {
  for (const path of PATHS) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['x-robots-tag'], path).toBeUndefined();
  }
  for (const path of [
    '/api/v1/meta',
    '/api/x',
    '/data/v1/meta.json',
    '/data/v1/nothing',
    '/status/capture.json',
    '/status/x',
    '/tiles/manifest.json',
    '/tiles/x',
    '/runtime-config.json',
    // the two 404 shells, a page that is none, in both languages
    '/niet-hier-launch',
    '/en/not-here-launch',
  ]) {
    const res = await request.get(path);
    expect(res.headers()['x-robots-tag'], path).toBe('noindex');
  }
});

for (const locale of ['nl', 'en'] as const)
  test(`Open Graph (${locale}): title, description, type, card, and an absolute og:image of this origin that is served`, async ({
    page,
    request,
  }) => {
    const path = locale === 'nl' ? '/' : '/en/';
    const html = await (await request.get(path)).text();
    // the templates module left no delimiter behind
    expect(html).not.toContain('[[');
    expect(html).not.toContain(']]');
    await page.goto(path);
    const meta = (property: string) => page.locator(`meta[property="${property}"]`).getAttribute('content');
    // the rendered value, as a crawler reads it
    expect(await meta('og:image')).toBe(`${origin}/og.png`);
    // no og:url: one shell serves every page of a language, so it would name the wrong one (the sitemap does)
    expect(await page.locator('meta[property="og:url"]').count()).toBe(0);
    expect(await meta('og:title')).toBe(msg(locale, 'site_title'));
    expect(await meta('og:description')).toBe(msg(locale, 'meta_description'));
    expect(await meta('og:type')).toBe('website');
    expect(await meta('og:image:width')).toBe('1200');
    expect(await meta('og:image:height')).toBe('630');
    expect(await page.locator('meta[name="twitter:card"]').getAttribute('content')).toBe('summary_large_image');
    // the image: same origin, 200, a PNG of 1200 x 630
    const image = await request.get((await meta('og:image')) ?? '');
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/png');
    const png = await image.body();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

// The four legal pages in both languages (E5): the launch phase changes nothing a visitor sees, so each is clean.
const LEGAL = ['disclaimer', 'colophon', 'privacy', 'accessibility'] as const;
for (const id of LEGAL)
  for (const locale of ['nl', 'en'] as const) {
    const path = PAGE_ROUTES.find((r) => r.id === id)?.[locale] ?? '';
    test(`${path}: 200, its heading, the beta notice, axe clean and 0 CSP violations`, async ({
      page,
      context,
      baseURL,
    }) => {
      const s = await start(page, context, baseURL);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['x-robots-tag']).toBeUndefined();
      await expect(page.locator('h1')).toHaveText(msg(locale, id === 'disclaimer' ? 'disclaimer' : `page_${id}_title`));
      await expect(page.locator('main [role="status"], main [role="alert"]')).toHaveCount(0);
      await expect(page.getByRole('banner').getByRole('link', { name: msg(locale, 'beta_banner') })).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      await expectNoSeriousAxe(page);
      await finish(page, s);
    });
  }
