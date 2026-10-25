import { expect, type Page, test } from '@playwright/test';
import { expectClean } from './clean.ts';
import { finish, msg, type Session, SNAPSHOT_PATH, slider, start } from './helpers.ts';

// O4 (#220): the boot reads of the home route are used once (they start in main.tsx before Temporal and the query
// takes them over), the information pages make no data request at all, and a station panel chunk that cannot load shows
// an alert with a way out. The PUBLIC site on Chromium, Firefox and WebKit, under the clean-page log.

const paths = (s: Session) => s.log.requests.map((u) => new URL(u).pathname);
const count = (s: Session, path: string) => paths(s).filter((p) => p === path).length;
/** The first snapshot read has started (latest.json or a recent/settled file): the home route has finished booting. */
const snapshotRead = (s: Session) =>
  expect.poll(() => paths(s).some((p) => SNAPSHOT_PATH.test(p)), { message: 'a snapshot read' }).toBe(true);
/** A short quiet period: a second boot read would have started by now. */
const quiet = (page: Page) => page.waitForTimeout(1500);

const BOOT = ['/runtime-config.json', '/data/v1/meta.json', '/data/v1/stations.json', '/data/v1/status.json'];

test('the home route reads runtime-config, meta, stations and status once each', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL);
  await page.goto('/');
  await expect(slider(page)).toBeVisible();
  await snapshotRead(s);
  await quiet(page);
  for (const p of BOOT) expect.soft(count(s, p), p).toBe(1);
  await finish(page, s);
});

test('a valid ?mode= never reads status.json; meta and stations still once', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL);
  await page.goto('/?mode=delta');
  await expect(slider(page)).toBeVisible();
  await snapshotRead(s);
  await quiet(page);
  expect.soft(count(s, '/data/v1/status.json')).toBe(0);
  for (const p of BOOT.slice(0, 3)) expect.soft(count(s, p), p).toBe(1);
  await finish(page, s);
});

// About and Disclaimer render static prose and OfficialLinks (no data part), so they are the pages that read nothing:
// the Sources, Status, Method and Colophon pages read sources.json, status.json or the stations.
for (const [name, path] of [
  ['About (nl)', '/over'],
  ['About (en)', '/en/about'],
  ['Disclaimer (nl)', '/disclaimer'],
  ['Disclaimer (en)', '/en/disclaimer'],
] as const) {
  test(`${name} reads only runtime-config.json: no data, map chunk, tiles manifest or style`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    await page.waitForLoadState('load');
    await quiet(page);
    expect(count(s, '/runtime-config.json')).toBe(1);
    const p = paths(s);
    expect(p.filter((x) => x.startsWith('/data/') || x.startsWith('/api/'))).toEqual([]);
    expect(p.filter((x) => x === '/tiles/manifest.json')).toEqual([]);
    expect(p.filter((x) => /\/(createMap|style(-[a-z]+)?)-[^/]+\.(js|css)$/.test(x))).toEqual([]);
    expect(p.filter((x) => /\/assets\/.*(maplibre|createMap|style-)/i.test(x))).toEqual([]);
    await finish(page, s);
  });
}

test('the Status page reads status.json once', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL);
  await page.goto('/status');
  await expect(page.locator('main h1')).toBeVisible();
  await expect.poll(() => count(s, '/data/v1/status.json')).toBe(1);
  await page.waitForLoadState('load');
  await quiet(page);
  expect(count(s, '/data/v1/status.json')).toBe(1);
  await finish(page, s);
});

// A station panel chunk that cannot load (O4): an alert in the panel's own opaque box, a way out, never a blank stage.
// settled()/idle() are not used: no aside ever appears here.
for (const [name, size] of [
  ['the default viewport', undefined],
  ['a 375 px wide viewport', { width: 375, height: 700 }],
] as const) {
  test(`a station panel chunk that fails shows the alert with a close button (${name})`, async ({
    page,
    context,
    baseURL,
  }) => {
    if (size !== undefined) await page.setViewportSize(size);
    const s = await start(page, context, baseURL);
    await page.route(/\/assets\/StationPanel-[^/]+\.js$/, (r) => r.abort());
    await page.goto('/?s=nl.e2e.dst');
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(msg('nl', 'data_unavailable'));
    await expect(alert.getByRole('link', { name: msg('nl', 'page_reload') })).toBeVisible();
    await expect(alert).toBeInViewport();
    await expect(page.locator('aside')).toHaveCount(0);
    const close = page.getByRole('button', { name: msg('nl', 'panel_close') });
    await expect(close).toBeInViewport();
    await close.click();
    await expect(alert).toHaveCount(0);
    await expect(close).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('s')).toBe(false);
    await expect(slider(page)).toBeVisible();
    await expect(page.locator('canvas.maplibregl-canvas')).toBeInViewport();
    // The aborted same-origin chunk is the only failed request (instrument() records it as failed, not as a third party).
    expect(s.log.failed.length).toBeGreaterThan(0);
    expect(s.log.failed.filter((l) => !/\/assets\/StationPanel-[^/]+\.js$/.test(l))).toEqual([]);
    // WebKit words an aborted route "Blocked by Web Inspector", which expectClean's blocked-request check cannot tell from a
    // CSP block: that one entry, now asserted to be the aborted chunk, is taken out of the log before it runs.
    s.log.failed.length = 0;
    expect(s.dialogs).toEqual([]);
    await expectClean(page, s.log);
  });
}
