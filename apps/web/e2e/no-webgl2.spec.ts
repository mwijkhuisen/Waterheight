import { expect, test } from '@playwright/test';
import {
  chooseMode,
  expectNoSeriousAxe,
  FRAMES_FILE,
  finish,
  open,
  pickStation,
  SNAPSHOT_PATH,
  start,
  viewSummary,
  XSS,
} from './helpers.ts';

// P10a (C5): the `no-webgl2` project (Chromium with --disable-3d-apis: the browser itself has no WebGL2, not a patched
// getContext as in app.spec.ts). The page shows its notice and the table, the map chunk is never requested, the table
// works (paging, the mode column, a row opens the panel) and axe finds no serious or critical issue.

test('the browser has no WebGL2; the table replaces the map and works', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  // A tall viewport: axe cannot decide the colour contrast of rows that the scroll area clips.
  await page.setViewportSize({ width: 1024, height: 12_000 });
  await open(page, '/');
  expect(await page.evaluate(() => document.createElement('canvas').getContext('webgl2'))).toBeNull();

  await expect(page.getByRole('status').filter({ hasText: 'WebGL2' })).toContainText(
    'Deze browser kan de kaart niet tonen (geen WebGL2)',
  );
  const table = page.locator('table');
  await expect(table).toHaveCount(1);
  // 100 rows a page, a pager that says where it is.
  await expect(table.locator('tbody tr')).toHaveCount(100);
  await expect(page.getByText(/^Stations 1–100 van \d+$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vorige' })).toBeDisabled();
  await page.getByRole('button', { name: 'Volgende' }).click();
  await expect(page.getByText(/^Stations 101–200 van \d+$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vorige' })).toBeEnabled();
  await page.getByRole('button', { name: 'Vorige' }).click();

  // The mode column follows the mode radios.
  await expect(table.locator('thead th').nth(4)).toHaveText('Toestand');
  // (P10e: the radios are in the mode disclosure over the top left)
  await chooseMode(page, 'q');
  await expect(table.locator('thead th').nth(4)).toHaveText('Afvoer');
  await chooseMode(page, 'delta');
  await expect(table.locator('thead th').nth(4)).toHaveText('Verandering 24 u');
  await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('delta');

  // No map: no canvas, no toggle, no request for the map chunk, its worker, a tile or the style assets.
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await expect(viewSummary(page)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Weergave', exact: true })).toHaveCount(0);
  // P10e: the table fills the window under the bar and scrolls inside it: the page itself does not scroll.
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
  expect(
    await page.locator('table').evaluate((el) => {
      const wrap = el.closest('div');
      return wrap === null ? null : getComputedStyle(wrap).overflowY;
    }),
  ).toBe('auto');
  expect(
    s.log.requests
      .map((u) => new URL(u).pathname)
      .filter((p) => /createMap|maplibre|\/tiles\/|\/assets\/map\//i.test(p)),
  ).toEqual([]);
  expect(s.log.workers).toEqual([]);

  // The search (P10e: the magnifier replaces the station list) opens a station over the table, and axe is content
  // with it all.
  await pickStation(page, 'E2E DST', /E2E DST/);
  await expect(page.locator('aside').getByRole('heading', { level: 2, name: 'E2E DST' })).toBeVisible();
  await expect(page.locator('aside').locator('strong').first()).toHaveText('444');
  await expectNoSeriousAxe(page);
  await finish(page, s);
});

// P11a (issue #26): without WebGL2 there is no map and no flow code, but the station panel over the table still has its
// upstream chain (a list on the reach graph, not a map feature), and the flow clock never ran.
test('without WebGL2 a station of the table shows its upstream chain, and the flow clock never ran', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await expect(page.locator('table')).toHaveCount(1);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await pickStation(page, 'Lobith', /Lobith/);
  await expect(page.locator('aside').getByRole('heading', { level: 2, name: /Lobith/ })).toBeVisible();
  const chain = page
    .locator('aside section')
    .filter({ has: page.getByRole('heading', { level: 3, name: 'Stroomopwaarts' }) });
  await expect(chain).toBeVisible();
  await expect(chain.locator('xpath=./ul/li[button]').first()).toContainText(/Emmerich/i);
  // No toggle (it belongs to the map), no flow request, no clock.
  await expect(page.getByRole('button', { name: 'Stroming animeren' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __rwsFlowFrames?: number }).__rwsFlowFrames ?? 0)).toBe(0);
  expect(s.log.requests.map((u) => new URL(u).pathname).filter((p) => /flowLayer|\/tiles\/rivers-/i.test(p))).toEqual(
    [],
  );
  await expectNoSeriousAxe(page);
  await finish(page, s);
});

// P11b (issue #26): the table plays from the hourly frames like the map would: the same rows change hour by hour (the
// hostile station's measured time moves on), nothing of the snapshot path is asked while it plays, and Pause brings it back.
test('without WebGL2 the table plays hour by hour from the frames, with no snapshot request', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, '/?mode=delta&t=2026-10-25T02:00Z');
  await expect(page.locator('table')).toHaveCount(1);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  const row = page.locator('table tbody tr').filter({ hasText: XSS });
  const measured = () => row.locator('time').getAttribute('datetime');
  await expect(row).toHaveCount(1);
  const before = await measured();
  const mark = s.log.requests.length;
  await page.getByRole('button', { name: 'Afspelen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pauzeren', exact: true })).toBeVisible();
  // The row's measured hour moves on while playing: at least three different hours are seen.
  const seen = new Set<string | null>([before]);
  await expect
    .poll(async () => seen.add(await measured()).size, { timeout: 30_000, intervals: [100] })
    .toBeGreaterThanOrEqual(4);
  const stop = s.log.requests.length;
  await page.getByRole('button', { name: 'Pauzeren', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Afspelen', exact: true })).toBeVisible();
  const during = s.log.requests.slice(mark, stop).map((u) => new URL(u).pathname);
  expect(during.filter((p) => SNAPSHOT_PATH.test(p))).toEqual([]);
  expect(during.filter((p) => FRAMES_FILE.test(p)).length).toBeGreaterThan(0);
  await finish(page, s);
});
