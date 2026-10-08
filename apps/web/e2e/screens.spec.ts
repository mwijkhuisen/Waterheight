import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  expandTimebar,
  finish,
  mapReady,
  menuButton,
  msg,
  open,
  openAttribution,
  openMenu,
  panelOf,
  searchBox,
  searchButton,
  settled,
  start,
  timebarMore,
  timebarOf,
} from './helpers.ts';

// P10d/P10e screenshots for the owner's visual check (Chromium, the `cvd` project runs this file): the viewer at 1440×900
// and 390×844 with the panel open (forecast and thresholds), the panel's Tabel view, the legend collapsed and open, the
// timebar in the repeated DST hour; and (P10e) the full-screen map (`map-full`), the search open (`search-open`), the
// menu open (`menu-open`, at 390 px and at 1024×768), the timebar collapsed and expanded and the credits open
// (`attribution-open`). CI uploads test-results/ in the `e2e-test-results` artifact. They assert only that the pages
// are clean; the looking is the owner's.

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

    // the legend, collapsed as it starts (KG-251), then opened
    await page.goto('/');
    await mapReady(page);
    await page.locator('.maplibregl-map').scrollIntoViewIfNeeded();
    await shot(page, `${size.name}-legend-collapsed`);
    await page.locator('summary', { hasText: msg('nl', 'legend_heading') }).click();
    await shot(page, `${size.name}-legend-open`);

    // P10e: the full-screen map with nothing open, the search, the menu (where there is one), the timebar both ways
    // and the credits
    await page.goto('/');
    await mapReady(page);
    await settled(page);
    await shot(page, `${size.name}-map-full`);
    await searchButton(page).click();
    await searchBox(page).fill('e2e');
    await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible();
    await shot(page, `${size.name}-search-open`);
    await page.keyboard.press('Escape');
    await expect(searchBox(page)).toHaveCount(0);
    if (await menuButton(page).isVisible()) {
      await openMenu(page);
      await shot(page, `${size.name}-menu-open`);
      await page.keyboard.press('Escape');
    }
    await shot(page, `${size.name}-timebar-collapsed`);
    await expandTimebar(page);
    await shot(page, `${size.name}-timebar-expanded`);
    await timebarMore(page).click();
    await openAttribution(page);
    await shot(page, `${size.name}-attribution-open`);

    // the timebar in the repeated hour of the DST night (the choice of the hour is in the expanded bar)
    await page.goto('/?t=2026-10-25T00:30Z');
    await expect(timebarOf(page)).toBeVisible();
    await expandTimebar(page);
    await timebarOf(page).scrollIntoViewIfNeeded();
    await shot(page, `${size.name}-timebar-dst`);
    await finish(page, s);
  });
}

// P10e: below 80rem the page links are behind the menu button; 390 px shows it above, and so does a 1024 px window.
test('P10e screenshot: the menu open at 1024x768', async ({ page, context, baseURL }) => {
  mkdirSync(OUT, { recursive: true });
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, '/');
  await mapReady(page);
  await openMenu(page);
  await shot(page, '1024x768-menu-open');
  await finish(page, s);
});
