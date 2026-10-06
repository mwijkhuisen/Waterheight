import { expect, test } from '@playwright/test';
import { expectNoSeriousAxe, finish, open, start, stationList } from './helpers.ts';

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
  await page.getByRole('radio', { name: 'Afvoer' }).check();
  await expect(table.locator('thead th').nth(4)).toHaveText('Afvoer');
  await page.getByRole('radio', { name: 'Verandering in 24 uur' }).check();
  await expect(table.locator('thead th').nth(4)).toHaveText('Verandering 24 u');
  await expect.poll(() => new URL(page.url()).searchParams.get('mode')).toBe('delta');

  // No map: no canvas, no toggle, no request for the map chunk, its worker, a tile or the style assets.
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Weergave', exact: true })).toHaveCount(0);
  expect(
    s.log.requests
      .map((u) => new URL(u).pathname)
      .filter((p) => /createMap|maplibre|\/tiles\/|\/assets\/map\//i.test(p)),
  ).toEqual([]);
  expect(s.log.workers).toEqual([]);

  // The station list opens a station next to the table, and axe is content with it all.
  await stationList(page).selectOption('nl.e2e.dst');
  await expect(page.locator('aside').getByRole('heading', { level: 2, name: 'E2E DST' })).toBeVisible();
  await expect(page.locator('aside').locator('strong').first()).toHaveText('444');
  await expectNoSeriousAxe(page);
  await finish(page, s);
});
