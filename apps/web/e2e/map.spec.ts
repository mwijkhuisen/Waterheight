import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { expectClean, instrument } from './clean.ts';
import { productionCsp, siteHeaders } from './headers.ts';

// P3 acceptance (issue #18), on Chromium, Firefox and WebKit, against the e2e
// build served with the exact production headers (site.caddy):
// - the map renders (pixel check) with 0 CSP violations and same-origin requests only;
// - the style renders z4–z14 of the fixture with no map error;
// - MapLibre is a lazy chunk, requested after the entry, and its worker a same-origin module URL;
// - WebKit without Temporal loads the polyfill chunk and formats dates; Chromium and Firefox never request it.

interface Spike {
  map: SpikeMap | null;
  errors: string[];
  stationsStyled: number;
  protocolUsers: () => number;
  temporal?: {
    impl: string;
    first: { hour: number; offset: string };
    second: { hour: number; offset: string };
    formatted: string;
  };
}
// The few MapLibre calls the tests make inside the page.
interface SpikeMap {
  loaded(): boolean;
  once(event: string, fn: () => void): void;
  jumpTo(o: { center: [number, number]; zoom: number }): void;
  getZoom(): number;
  areTilesLoaded(): boolean;
  queryRenderedFeatures(): { source: string }[];
  getFeatureState(f: { source: string; id: number }): Record<string, unknown>;
  setLayoutProperty(layer: string, name: string, value: string): void;
  triggerRepaint(): void;
  getCanvas(): HTMLCanvasElement;
}
type W = Window & { __spike: Spike; __csp: string[] };

const LOBITH: [number, number] = [6.1, 51.85];

async function openSpike(page: Page, path = '/_spike/') {
  const response = await page.goto(path);
  await page.waitForFunction(() => {
    const s = (window as unknown as W).__spike;
    return s?.map?.loaded() === true && s.stationsStyled === 200;
  });
  return response;
}

const atZoom = (page: Page, zoom: number) =>
  page.evaluate(
    async ([lon, lat, z]) => {
      const s = (window as unknown as W).__spike;
      const map = s.map as SpikeMap;
      const idle = new Promise<void>((r) => map.once('idle', r));
      map.jumpTo({ center: [lon, lat] as [number, number], zoom: z });
      await idle;
      const sources = map.queryRenderedFeatures().map((f) => f.source);
      return {
        zoom: map.getZoom(),
        tiles: map.areTilesLoaded(),
        planet: sources.filter((x) => x === 'planet').length,
        basemap: sources.filter((x) => x === 'basemap').length,
        errors: [...s.errors],
      };
    },
    [LOBITH[0], LOBITH[1], zoom] as const,
  );

test.beforeEach(async ({ page, browserName }) => {
  // WebKit must run without Temporal to prove the polyfill path; WebKit 26.6
  // ships it, so it is deleted before any page script runs.
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

test('WebGL2 is available (the map needs it; a missing GPU path is named here first)', async ({ page }) => {
  await page.goto('/healthz');
  const gl = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('webgl2');
    return ctx === null ? null : String(ctx.getParameter(ctx.VERSION));
  });
  expect(gl).toMatch(/WebGL 2/);
});

test('the spike renders under the production CSP, same-origin only', async ({ page, context, baseURL }) => {
  const log = await instrument(page, context, baseURL);
  const response = await openSpike(page);

  // Exactly the production headers, from the single source (site.caddy).
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toBe(productionCsp());
  for (const [name, value] of siteHeaders()) expect(headers[name.toLowerCase()], name).toBe(value);

  // MapLibre is a lazy chunk: the page names none of it (no script, no modulepreload), and the
  // browser asks for it only after every script the page names, the entry included.
  const html = (await response?.text()) ?? '';
  expect(html).not.toMatch(/createMap|maplibre/i);
  const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((m) => new URL(m[1] ?? '', log.origin).href);
  expect(
    // (the HTML's own entry: named after the page's entry file since the strict execution order of P10a)
    scripts.some((s) => /\/assets\/(main|spike_[a-z]{2})-[^/]+\.js$/.test(s)),
    'the entry script',
  ).toBe(true);
  const scriptsAt = scripts.map((s) => log.requests.indexOf(s));
  expect(Math.min(...scriptsAt), 'every page script is requested').toBeGreaterThanOrEqual(0);
  const mapAt = log.requests.findIndex((u) => /\/assets\/createMap-[^/]+\.js$/.test(u));
  expect(mapAt, 'createMap after the entry').toBeGreaterThan(Math.max(...scriptsAt));

  // The worker is a same-origin module script under /assets/, never blob:
  // (Firefox reports the URL as given to `new Worker`, so resolve it first).
  expect(log.workers.length).toBeGreaterThan(0);
  for (const w of log.workers) {
    expect(w).not.toMatch(/^blob:/);
    expect(new URL(w, log.origin).href).toMatch(new RegExp(`^${log.origin}/assets/maplibre-gl-worker-[^/]+\\.js$`));
  }

  // Pixel check at z12: the basemap alone (stations hidden) is not blank.
  await atZoom(page, 12);
  const pixels = (stationsVisible: boolean) =>
    page.evaluate(async (visible) => {
      const map = (window as unknown as W).__spike.map as SpikeMap;
      map.setLayoutProperty('stations', 'visibility', visible ? 'visible' : 'none');
      await new Promise<void>((r) => {
        map.once('idle', r);
        map.triggerRepaint();
      });
      const c = map.getCanvas();
      const t = document.createElement('canvas');
      t.width = c.width;
      t.height = c.height;
      const ctx = t.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, t.width, t.height).data;
      const counts = new Map<number, number>();
      const near = (r: number, g: number, b: number) => {
        let n = 0;
        for (let i = 0; i < d.length; i += 4)
          if (
            Math.abs((d[i] ?? 0) - r) <= 2 &&
            Math.abs((d[i + 1] ?? 0) - g) <= 2 &&
            Math.abs((d[i + 2] ?? 0) - b) <= 2
          )
            n++;
        return n;
      };
      for (let i = 0; i < d.length; i += 4) {
        const k = (((d[i] ?? 0) >> 3) << 10) | (((d[i + 1] ?? 0) >> 3) << 5) | ((d[i + 2] ?? 0) >> 3);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const total = d.length / 4;
      return {
        total,
        distinct: counts.size,
        nonDominant: 1 - Math.max(...counts.values()) / total,
        level0: near(0x8c, 0x51, 0x0a),
        level4: near(0x01, 0x66, 0x5e),
        magenta: near(0xff, 0x00, 0xff),
      };
    }, stationsVisible);
  const basemap = await pixels(false);
  expect(basemap.total).toBeGreaterThan(100_000);
  expect(basemap.distinct).toBeGreaterThan(8);
  expect(basemap.nonDominant).toBeGreaterThan(0.02);

  // Stations: coloured by feature-state (the fallback colour, magenta, never shows).
  const stations = await pixels(true);
  expect(stations.level0).toBeGreaterThan(0);
  expect(stations.level4).toBeGreaterThan(0);
  expect(stations.magenta).toBe(0);
  expect(
    await page.evaluate(() =>
      ((window as unknown as W).__spike.map as SpikeMap).getFeatureState({ source: 'stations', id: 7 }),
    ),
  ).toEqual({ level: 2 });

  // The attribution is our constant: OSM credit linked to its copyright page, plus Protomaps.
  const attribution = page.locator('.maplibregl-ctrl-attrib-inner');
  await expect(attribution).toHaveText('© OpenStreetMap contributors · Protomaps');
  expect(await attribution.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual([
    'https://www.openstreetmap.org/copyright',
  ]);

  // The request log covers what the map loads: worker, style chunk, glyphs, sprite, tiles, manifest.
  const paths = log.requests.map((u) => new URL(u).pathname);
  expect(paths).toContain('/tiles/manifest.json');
  expect(paths.some((p) => /^\/tiles\/basemap-[0-9]{8}\.pmtiles$/.test(p))).toBe(true);
  expect(paths.some((p) => /^\/tiles\/planet-z6-[0-9]{8}\.pmtiles$/.test(p))).toBe(true);
  expect(paths.some((p) => /^\/assets\/map\/028c18f\/fonts\/.+\.pbf$/.test(decodeURIComponent(p)))).toBe(true);
  expect(paths.some((p) => /^\/assets\/map\/028c18f\/sprites\/v4\/white(@2x)?\.(json|png)$/.test(p))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as W).__spike.errors)).toEqual([]);
  await expectClean(page, log);
});

test('z4–z14 at Lobith: planet below z7, the regional extract from z7, no map error', async ({
  page,
  context,
  baseURL,
}) => {
  const log = await instrument(page, context, baseURL);
  await openSpike(page);
  for (let zoom = 4; zoom <= 14; zoom++) {
    const at = await atZoom(page, zoom);
    expect(at.zoom).toBe(zoom);
    expect(at.tiles, `tiles loaded at z${zoom}`).toBe(true);
    expect(at.errors, `map errors at z${zoom}`).toEqual([]);
    if (zoom < 7) expect(at.planet, `planet features at z${zoom}`).toBeGreaterThan(0);
    else expect(at.basemap, `basemap features at z${zoom}`).toBeGreaterThan(0);
  }
  // A style layer naming a source-layer the tiles lack is only a console warning in MapLibre.
  expect(
    log.console.filter((l) => /does not exist on source|Unable to|Failed to|could not be loaded/i.test(l)),
  ).toEqual([]);
  await expectClean(page, log);
});

test('unmount removes the map and drops its protocol hold; remount works', async ({ page, context, baseURL }) => {
  const log = await instrument(page, context, baseURL);
  await openSpike(page);
  const state = () =>
    page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas.maplibregl-canvas').length,
      users: (window as unknown as W).__spike.protocolUsers(),
      map: (window as unknown as W).__spike.map !== null,
    }));
  expect(await state()).toEqual({ canvases: 1, users: 1, map: true });
  await page.getByRole('button', { name: 'Kaart verbergen' }).click();
  await page.waitForFunction(() => (window as unknown as W).__spike.map === null);
  expect(await state()).toEqual({ canvases: 0, users: 0, map: false });
  await page.getByRole('button', { name: 'Kaart tonen' }).click();
  await page.waitForFunction(() => {
    const s = (window as unknown as W).__spike;
    return s.map?.loaded() === true && s.stationsStyled === 200;
  });
  expect(await state()).toEqual({ canvases: 1, users: 1, map: true });
  await expectClean(page, log);
});

test('Temporal: native where present; WebKit without it loads the polyfill', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  const log = await instrument(page, context, baseURL);
  await page.goto('/en/_spike/');
  const t = await page
    .waitForFunction(() => (window as unknown as W).__spike.temporal)
    .then((h) => h.jsonValue() as Promise<NonNullable<Spike['temporal']>>);
  const native = await page.evaluate(() =>
    Function.prototype.toString.call(Temporal.Instant).includes('[native code]'),
  );
  // The polyfill is its own lazy chunk: requested only where Temporal is missing.
  const polyfill = log.requests.filter((u) => /\/assets\/global\.esm-[^/]+\.js$/.test(u));
  if (browserName === 'webkit') {
    expect(t.impl).toBe('polyfill');
    expect(native).toBe(false);
    expect(polyfill).toHaveLength(1);
  } else {
    expect(t.impl).toBe('native');
    expect(native).toBe(true);
    expect(polyfill).toEqual([]);
  }
  // 2026-10-25, the DST fall-back: 02:30 local happens twice, first in CEST then in CET.
  expect(t.first).toEqual({ hour: 2, offset: '+02:00' });
  expect(t.second).toEqual({ hour: 2, offset: '+01:00' });
  expect(t.formatted).toMatch(/2026/);
  expect(t.formatted).toMatch(/02[:.]30/);
  await expectClean(page, log);
});

for (const path of ['/_spike/', '/en/_spike/'])
  test(`axe finds no violation on ${path}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'axe runs once, in Chromium');
    await openSpike(page, path);
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
