import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { finish, mapReady, msg, open, panelOf, settled, start, timebarOf } from './helpers.ts';

// P10d screenshots for the owner's visual check (Chromium, the `cvd` project runs this file): the viewer at 1440×900 and
// 390×844 with the panel open (forecast and thresholds), the panel's Tabel view, the legend collapsed and the timebar
// in the repeated DST hour. CI uploads test-results/ in the `e2e-test-results` artifact. They assert only that the
// pages are clean; the looking is the owner's.

const OUT = join('test-results', 'screens');
const SIZES = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
] as const;

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });

for (const size of SIZES) {
  test(`P10d screenshots at ${size.name}`, async ({ page, context, baseURL }) => {
    mkdirSync(OUT, { recursive: true });
    const s = await start(page, context, baseURL, 'state');
    await page.setViewportSize({ width: size.width, height: size.height });

    // the map with the panel open: a station with a forecast run and an NL-4 threshold zone
    await open(page, '/?s=nl.e2e.xss');
    await mapReady(page);
    await settled(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `${size.name}-map-panel`);
    await page.screenshot({
      path: join(OUT, `${size.name}-map-panel-full.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await panelOf(page).scrollIntoViewIfNeeded();
    await shot(page, `${size.name}-panel-chart`);

    // the panel's Tabel view
    await panelOf(page)
      .getByRole('group', { name: msg('nl', 'panel_view_label') })
      .getByRole('radio', { name: msg('nl', 'panel_view_table'), exact: true })
      .check();
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    await shot(page, `${size.name}-panel-table`);

    // the legend, collapsed
    await page.goto('/');
    await mapReady(page);
    await page.locator('summary', { hasText: msg('nl', 'legend_heading') }).click();
    await page.locator('.maplibregl-map').scrollIntoViewIfNeeded();
    await shot(page, `${size.name}-legend-collapsed`);

    // the timebar in the repeated hour of the DST night
    await page.goto('/?t=2026-10-25T00:30Z');
    await expect(timebarOf(page)).toBeVisible();
    await timebarOf(page).scrollIntoViewIfNeeded();
    await shot(page, `${size.name}-timebar-dst`);
    await finish(page, s);
  });
}
