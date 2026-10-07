import { expect, test } from '@playwright/test';
import { chooseMode, expectNoSeriousAxe, finish, open, pickStation, start, viewSummary } from './helpers.ts';

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
