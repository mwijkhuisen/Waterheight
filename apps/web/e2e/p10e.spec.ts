import { expect, type Locator, type Page, test } from '@playwright/test';
import { attributionText } from '../src/lib/attribution.ts';
import { PAGE_ROUTES } from '../src/lib/routes.ts';
import {
  attributionButton,
  barNav,
  chooseView,
  expandTimebar,
  expectNoSeriousAxe,
  finish,
  mapReady,
  menuButton,
  modeSummary,
  msg,
  open,
  openAttribution,
  openMenu,
  panelOf,
  param,
  pickStation,
  searchBox,
  searchButton,
  settled,
  slider,
  start,
  timebarMore,
  timebarOf,
  viewSummary,
  type W,
} from './helpers.ts';

// P10e acceptance (issue #101), the PUBLIC site on Chromium, Firefox and WebKit: the full-screen map under a bar that
// stays at the top, the mode and view disclosures, the station search, the collapsed and expanded timebar, the
// credits moved into the "Bronnen" disclosure and the slim footer of the pages. Against the e2e build under the
// production headers with the e2e api (a fixed clock: NOW, 2026-10-26T12:00Z).

const nl = (key: string, args: Record<string, string | number> = {}) => msg('nl', key, args);
const HOSTILE = 'nl.e2e.xss';

test.beforeEach(async ({ page, browserName }) => {
  // WebKit must run without Temporal to prove the polyfill path (as in app.spec.ts).
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (b === null) throw new Error('no box');
  return b;
};
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The map is up with its stations (nl.e2e.xss has a value), the page itself has not scrolled. */
const ready = async (page: Page, path = '/', slide = 'Tijdlijn') => {
  await open(page, path, slide);
  await mapReady(page);
  await settled(page);
};

// ---------------------------------------------------------------- the bar and the pages

test('the bar stays at the top while an information page scrolls; the page ends in a slim footer', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto('/methode');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const bar = page.getByRole('banner');
  await expect(bar).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(900);
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  expect((await box(bar)).y).toBe(0);
  // The slim footer: the disclaimer line and the notices link, no source list, no page links.
  const footer = page.getByRole('contentinfo');
  await footer.scrollIntoViewIfNeeded();
  await expect(footer.getByText(nl('disclaimer'), { exact: true })).toBeVisible();
  await expect(footer.getByRole('link', { name: nl('notices_link') })).toHaveAttribute(
    'href',
    '/third-party-notices.txt',
  );
  await expect(footer.getByRole('navigation')).toHaveCount(0);
  await expect(footer.getByRole('heading')).toHaveCount(0);
  await finish(page, s);
});

test('the bar links the nine pages: in a row from 80rem, behind the menu button below', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/over');
  const links = barNav(page).getByRole('link');
  await expect(links).toHaveCount(9);
  await expect(menuButton(page)).toBeHidden();
  for (const [i, r] of PAGE_ROUTES.entries()) await expect(links.nth(i)).toHaveAttribute('href', r.nl);
  await expect(barNav(page).locator('a[aria-current="page"]')).toHaveAttribute('href', '/over');

  // 390 px: the same nav is a popover under the bar. Escape closes it and the focus returns to the button.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(menuButton(page)).toBeVisible();
  await expect(barNav(page)).toBeHidden();
  // The button says whether the menu is open in every browser (review round 1: a popover button has no aria-expanded
  // of its own in the DOM).
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  await menuButton(page).click();
  await expect(barNav(page)).toBeVisible();
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(barNav(page).getByRole('link')).toHaveCount(9);
  expect((await box(barNav(page))).y).toBeGreaterThanOrEqual((await box(page.getByRole('banner'))).height - 1);
  await page.keyboard.press('Escape');
  await expect(barNav(page)).toBeHidden();
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton(page)).toBeFocused();
  // And it is reachable by the keyboard alone.
  await page.keyboard.press('Enter');
  await expect(barNav(page)).toBeVisible();
  await barNav(page)
    .getByRole('link', { name: nl('page_sources_title'), exact: true })
    .click();
  await expect(page).toHaveURL(/\/bronnen$/);
  await finish(page, s);
});

// Review round 1: the nine links measured, not estimated. From 80rem they are one row between the name and the tools
// (on the map, whose bar also holds the magnifier, in both languages); at 360 px the bar holds the menu button.
test('the bar fits: the nine links in one row at 1280x720 and 1366x768, the menu at 360x640', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const right = (b: { x: number; width: number }) => b.x + b.width;
  for (const [path, locale] of [
    ['/', 'nl'],
    ['/en/', 'en'],
  ] as const)
    for (const [width, height] of [
      [1280, 720],
      [1366, 768],
      [360, 640],
    ] as const) {
      const at = `${path} ${width}x${height}`;
      await page.setViewportSize({ width, height });
      await open(page, path, locale === 'nl' ? 'Tijdlijn' : 'Timeline');
      await expect(searchButton(page, locale)).toBeVisible();
      const banner = page.getByRole('banner');
      const bar = await box(banner);
      expect(bar.height, `${at}: bar height`).toBeCloseTo(56, 0);
      const brand = await box(banner.locator('h1'));
      const tools = await box(searchButton(page, locale).locator('xpath=../..'));
      expect(right(tools), `${at}: tools inside the window`).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${at}: no scroll`).toBe(0);
      if (width < 1280) {
        await expect(menuButton(page, locale)).toBeVisible();
        const menu = await box(menuButton(page, locale));
        expect(menu.x, `${at}: menu after the name`).toBeGreaterThanOrEqual(right(brand));
        expect(right(menu), `${at}: menu before the tools`).toBeLessThanOrEqual(tools.x);
        continue;
      }
      await expect(menuButton(page, locale)).toBeHidden();
      const links = await barNav(page, locale)
        .getByRole('link')
        .evaluateAll((as) => as.map((a) => a.getBoundingClientRect().toJSON() as DOMRect));
      expect(links).toHaveLength(9);
      for (const l of links) {
        expect(l.y, `${at}: one row`).toBeCloseTo(links[0]?.y ?? 0, 0);
        expect(l.y + l.height, `${at}: inside the bar`).toBeLessThanOrEqual(bar.y + bar.height);
      }
      expect(links[0]?.x ?? 0, `${at}: links after the name`).toBeGreaterThanOrEqual(right(brand));
      expect(right(links[8] ?? brand), `${at}: links before the tools`).toBeLessThanOrEqual(tools.x);
    }
  await finish(page, s);
});

test('the beta notice is a compact link to the disclaimer; the language link keeps the view', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${HOSTILE}`);
  const beta = page.getByRole('banner').getByRole('link', { name: nl('beta_banner'), exact: false });
  await expect(beta).toHaveAttribute('href', '/disclaimer');
  await expect(beta).toHaveText(nl('beta_short'));
  await expect(page.getByRole('banner').getByRole('link', { name: 'English' })).toHaveAttribute(
    'href',
    new RegExp(`^/en/\\?.*s=${HOSTILE}`),
  );
  await finish(page, s);
});

// ---------------------------------------------------------------- the full-screen map

test('the map fills the window under the bar: no page scrollbar, no footer', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await ready(page);
    const m = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight - innerHeight,
      across: document.documentElement.scrollWidth - innerWidth,
    }));
    expect(m.scroll, `${width}x${height}: vertical scroll`).toBeLessThanOrEqual(0);
    expect(m.across, `${width}x${height}: horizontal scroll`).toBeLessThanOrEqual(0);
    const bar = await box(page.getByRole('banner'));
    const map = await box(page.locator('.maplibregl-map'));
    expect(map.y, `${width}x${height}: map starts under the bar`).toBeCloseTo(bar.y + bar.height, 0);
    expect(map.y + map.height, `${width}x${height}: map ends at the window's edge`).toBeCloseTo(height, 0);
    expect(map.width).toBeCloseTo(width, 0);
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
  }
  await finish(page, s);
});

test('a bar of a fractional height never makes the map a sliver too tall', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await ready(page);
  // A root font size of 15.2 px makes the 3.5rem bar 53.2 px: offsetHeight would round it down to 53 (review round 1).
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '15.2px';
  });
  const chrome = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--chrome-h'));
  await expect.poll(chrome).not.toBe('56px');
  expect(await chrome()).toBe('54px');
  const m = await page.evaluate(() => {
    const bar = document.querySelector('header')?.getBoundingClientRect();
    const main = document.querySelector('main')?.getBoundingClientRect();
    return { bottom: (bar?.height ?? 0) + (main?.height ?? 0), height: innerHeight };
  });
  expect(m.bottom).toBeLessThanOrEqual(m.height);
  await finish(page, s);
});

// ---------------------------------------------------------------- the mode and the view

test('the mode and view disclosures work by keyboard; the URL follows the mode', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  const mode = modeSummary(page);
  await expect(mode).toHaveText(nl('mode_summary', { mode: nl('mode_state') }));
  await expect(viewSummary(page)).toHaveText(nl('view_summary', { view: nl('view_map') }));
  await expect(page.getByRole('radio', { name: nl('mode_delta'), exact: true })).toBeHidden();

  await mode.focus();
  await page.keyboard.press('Enter');
  const state = page.getByRole('radio', { name: nl('mode_state'), exact: true });
  await expect(state).toBeVisible();
  await state.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: nl('mode_delta'), exact: true })).toBeChecked();
  await expect.poll(() => param(page, 'mode')).toBe('delta');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: nl('mode_q'), exact: true })).toBeChecked();
  await expect.poll(() => param(page, 'mode')).toBe('q');
  await expect(mode).toHaveText(nl('mode_summary', { mode: nl('mode_q') }));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('radio', { name: nl('mode_q'), exact: true })).toBeHidden();
  await expect(mode).toBeFocused();

  // The view: Enter on "Tabel" closes the disclosure and returns the focus to its summary; the table replaces the map.
  await viewSummary(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: nl('view_map'), exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: nl('view_table'), exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('table')).toHaveCount(1);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await expect(viewSummary(page)).toHaveText(nl('view_summary', { view: nl('view_table') }));
  await expect(viewSummary(page)).toBeFocused();
  // In the table view both disclosures stay, and the table is the rest of the window: it scrolls inside, not the page.
  await expect(mode).toBeVisible();
  const m = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  expect(m).toBeLessThanOrEqual(0);
  await chooseView(page, 'map');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(1);
  await finish(page, s);
});

// ---------------------------------------------------------------- the search

test('the search: a partial query without diacritics finds Lobith; Enter opens the panel with the focus in it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await expect(searchBox(page)).toHaveCount(0);
  await searchButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(searchBox(page)).toBeFocused();
  await expect(searchButton(page)).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.type('lobit');
  const options = page.locator('[role="option"]');
  await expect(options.first()).toHaveText(/^Lobith/);
  await expect(searchBox(page)).toHaveAttribute(
    'aria-activedescendant',
    (await options.first().getAttribute('id')) ?? '',
  );
  expect(await options.count()).toBeLessThanOrEqual(20);
  await page.keyboard.press('Enter');
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText(/^Lobith/);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  expect(param(page, 's')).toMatch(/^nl\.rws\.lobith/);
  // The typed text stayed out of the URL.
  expect(page.url()).not.toContain('lobit&');
  expect(page.url()).not.toMatch(/[?&]q=/);
  await expect(searchBox(page)).toHaveCount(0);
  // Closing a panel that no button opened returns the focus to the magnifier.
  await panelOf(page)
    .getByRole('button', { name: nl('panel_close') })
    .click();
  await expect(panelOf(page)).toHaveCount(0);
  await expect(searchButton(page)).toBeFocused();
  await finish(page, s);
});

test('the search: arrows move the active result, Escape closes it and returns the focus to the magnifier', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await searchButton(page).click();
  await searchBox(page).fill('e2e');
  const options = page.locator('[role="option"]');
  expect(await options.count()).toBeGreaterThan(1);
  const first = (await options.nth(0).getAttribute('id')) ?? '';
  const second = (await options.nth(1).getAttribute('id')) ?? '';
  await expect(searchBox(page)).toHaveAttribute('aria-activedescendant', first);
  await page.keyboard.press('ArrowDown');
  await expect(searchBox(page)).toHaveAttribute('aria-activedescendant', second);
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(searchBox(page)).toHaveAttribute('aria-activedescendant', first);
  // The field takes at most 100 characters (review round 1).
  await expect(searchBox(page)).toHaveAttribute('maxlength', '100');
  // Down the whole list of 20: the active option scrolls into sight in the list (review round 1).
  await searchBox(page).fill('e');
  await expect(options).toHaveCount(20);
  for (let i = 0; i < 17; i++) await page.keyboard.press('ArrowDown');
  const active = page.locator('[role="option"][aria-selected="true"]');
  await expect(active).toHaveAttribute('id', (await options.nth(17).getAttribute('id')) ?? '');
  await expect
    .poll(async () => {
      const [o, l] = [await box(active), await box(page.getByRole('listbox'))];
      return o.y >= l.y - 1 && o.y + o.height <= l.y + l.height + 1;
    })
    .toBe(true);
  // No match says so; a diacritics-free, upper-case query still matches.
  await searchBox(page).fill('zzzzzz');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
  await expect(page.getByText(nl('search_none'), { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(searchBox(page)).toHaveCount(0);
  await expect(searchButton(page)).toBeFocused();
  await expect(panelOf(page)).toHaveCount(0);
  // A click on a result opens it, too.
  await searchButton(page).click();
  await searchBox(page).fill('E2E DST');
  await page.getByRole('option', { name: /E2E DST/ }).click();
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await finish(page, s);
});

// Review round 1: where a click does not focus a button (WebKit, Firefox on macOS) the press blurred the open field or
// panel to nothing, which closed it, and the click opened it again. The press now focuses the toggle itself.
test('a press on the magnifier or on Bronnen keeps the focus in the control; the click closes it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  // The browsers of this suite (Linux builds) focus a button on a click. Safari's default action is emulated: after
  // the page's own handlers, a press on a button that nobody prevented moves the focus to nothing.
  await page.evaluate(() =>
    addEventListener('mousedown', (e) => {
      if (e.defaultPrevented || !(e.target instanceof Element) || e.target.closest('button') === null) return;
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }),
  );
  const press = async (target: Locator, during: () => Promise<void>) => {
    const b = await box(target);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await during();
    await page.mouse.up();
  };

  await searchButton(page).click();
  await expect(searchBox(page)).toBeFocused();
  await press(searchButton(page), async () => {
    await expect(searchButton(page)).toBeFocused();
    await expect(searchBox(page)).toHaveCount(1);
  });
  await expect(searchBox(page)).toHaveCount(0);
  await expect(searchButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(searchButton(page)).toBeFocused();

  const button = attributionButton(page);
  // Closed, the button points at no element (review round 1: aria-controls only while the panel exists).
  await expect(button).not.toHaveAttribute('aria-controls');
  const panel = await openAttribution(page);
  await expect(button).toHaveAttribute('aria-controls', (await panel.getAttribute('id')) ?? '-');
  await panel.focus();
  await press(button, async () => {
    await expect(button).toBeFocused();
    await expect(panel).toBeVisible();
  });
  await expect(panel).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await finish(page, s);
});

test('closing the panel returns the focus to the table button that opened it', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await chooseView(page, 'table');
  // The table has 100 rows a page: its first station button.
  const button = page.locator('table tbody th button').first();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  await panelOf(page)
    .getByRole('button', { name: nl('panel_close') })
    .click();
  await expect(button).toBeFocused();
  await finish(page, s);
});

// ---------------------------------------------------------------- the panel as a drawer

test('the station panel is a drawer over the map: the map keeps its size; below 48rem it is a sheet', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  const before = await box(page.locator('.maplibregl-map'));
  await pickStation(page, 'E2E DST', /E2E DST/);
  await expect(panelOf(page)).toBeVisible();
  const map = await box(page.locator('.maplibregl-map'));
  expect(map.width).toBe(before.width);
  expect(map.height).toBe(before.height);
  const bar = await box(page.getByRole('banner'));
  const drawer = await box(panelOf(page));
  expect(drawer.y).toBeCloseTo(bar.y + bar.height, 0);
  expect(drawer.x + drawer.width).toBeCloseTo(1440, 0);
  expect(drawer.width).toBeLessThan(500);
  // The timebar keeps clear of the drawer.
  expect(overlaps(await box(timebarOf(page)), drawer)).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await box(panelOf(page))).width).toBeCloseTo(390, 0);
  const sheet = await box(panelOf(page));
  const timebar = await box(timebarOf(page));
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(timebar.y + 1);
  await finish(page, s);
});

// A deep link opens the map with the station in the part the drawer leaves free (1024x768: the drawer is 26rem), the
// popup's close button beside the drawer, and (review round 1) no camera padding left behind for later zooms.
test('a deep-linked station is in the part the drawer leaves free; the camera keeps no padding', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, '/?s=nl.e2e.dst');
  await mapReady(page);
  const drawer = await box(panelOf(page));
  expect(drawer.x).toBeCloseTo(1024 - 26 * 16, 0);
  const tip = await box(page.locator('.maplibregl-popup-tip'));
  const x = tip.x + tip.width / 2;
  expect(x).toBeGreaterThan(0);
  expect(x).toBeLessThan(drawer.x);
  // In the middle of the free part.
  expect(x).toBeCloseTo(drawer.x / 2, -2);
  expect(overlaps(await box(page.locator('.maplibregl-popup-close-button')), drawer)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as W).__rws?.map?.getPadding())).toEqual({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
  await finish(page, s);
});

// Review round 1: what the sheet covers was still focusable (the map canvas, MapLibre's button, the table's rows) and
// the status lines were under it. Now the view is hidden while the sheet is open, the status lines are a band above
// it, and the focus still returns to the opener once the sheet is gone.
test('below 48rem the sheet hides the view under it, the status lines stand above it, the focus returns', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 390, height: 844 });
  // A t after now in the Δh mode: a status line ("after now the change shows nothing").
  await open(page, '/?s=nl.e2e.dst&mode=delta&t=2026-10-26T14:00Z');
  await mapReady(page);
  const sheet = panelOf(page);
  await expect(sheet.getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(page.locator('.maplibregl-canvas')).toBeHidden();
  await expect(page.locator('.maplibregl-ctrl-attrib-button')).toBeHidden();
  await expect(modeSummary(page)).toBeHidden();
  const chip = page.getByText(nl('dh_future_note'), { exact: true });
  await expect(chip).toBeVisible();
  const close = sheet.getByRole('button', { name: nl('panel_close') });
  expect((await box(chip)).y + (await box(chip)).height).toBeLessThanOrEqual((await box(sheet)).y + 1);
  expect(overlaps(await box(chip), await box(close))).toBe(false);
  // Shift+Tab from the sheet's close button never lands on the map under the sheet, or on anything hidden.
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(() => {
      const el = document.activeElement;
      return el !== null && el.closest('.maplibregl-map') === null && el.checkVisibility();
    }),
  ).toBe(true);
  await close.click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(modeSummary(page)).toBeVisible();
  await expect(searchButton(page)).toBeFocused();

  // The table's row button is hidden under the sheet, and takes the focus back once the sheet closes.
  await chooseView(page, 'table');
  const row = page.locator('table tbody th button').first();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(sheet.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(row).toBeHidden();
  await sheet.getByRole('button', { name: nl('panel_close') }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row).toBeFocused();
  await finish(page, s);
});

// ---------------------------------------------------------------- the timebar

test('the timebar is collapsed at the start and expands to the full bar of P10d', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  const bar = timebarOf(page);
  const more = timebarMore(page);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toHaveAttribute('aria-controls', /.+/);
  // Collapsed: the time with its label, the short slider, the steps, play and "Nu".
  await expect(slider(page)).toBeVisible();
  await expect(bar.getByText(/13:00 CET$/)).toBeVisible();
  for (const name of ['step_back', 'step_forward', 'play'])
    await expect(bar.getByRole('button', { name: nl(name) })).toBeVisible();
  await expect(bar.getByRole('button', { name: nl('to_now'), exact: true })).toBeVisible();
  // ...and none of the rest.
  await expect(page.getByLabel(nl('date_label'), { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(nl('time_label'), { exact: true })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: nl('play_reverse') })).toHaveCount(0);
  await expect(bar.getByText(nl('live_note'))).toHaveCount(0);
  const small = await box(bar);
  // Over the map at the bottom centre.
  expect(small.x + small.width / 2).toBeCloseTo(720, -1);
  expect(small.y + small.height).toBeGreaterThan(800);
  expect(small.width).toBeLessThanOrEqual(46 * 16 + 1);

  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel(nl('date_label'), { exact: true })).toBeVisible();
  await expect(page.getByLabel(nl('time_label'), { exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: nl('play_reverse') })).toBeVisible();
  await expect(bar.getByText(nl('live_note'))).toBeVisible();
  const big = await box(bar);
  expect(big.height).toBeGreaterThan(small.height);
  expect(big.y + big.height).toBeCloseTo(small.y + small.height, 0);
  // The legend and the credits stand above the bar, never under it.
  const legend = await box(page.locator('summary', { hasText: nl('legend_heading') }));
  const sources = await box(attributionButton(page));
  expect(overlaps(big, legend)).toBe(false);
  expect(overlaps(big, sources)).toBe(false);

  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel(nl('date_label'), { exact: true })).toHaveCount(0);
  await finish(page, s);
});

// Review round 1: collapsing took away the reverse button, the only pause of reverse play, and the play left behind
// switched it to forward play.
test('collapsing the timebar stops reverse play', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'dh');
  // P11b: reverse play runs hour by hour in the Δh and Q modes (twelve hours a second at the normal speed)
  await open(page, '/?mode=delta&t=2026-10-24T12:00Z');
  await expandTimebar(page);
  const bar = timebarOf(page);
  await bar.getByRole('button', { name: nl('play_reverse'), exact: true }).click();
  await expect(bar.getByRole('button', { name: nl('pause'), exact: true })).toHaveCount(1);
  await expect.poll(() => param(page, 't'), { timeout: 10_000 }).not.toBe('2026-10-24T12:00Z');
  await timebarMore(page).click();
  await expect(timebarMore(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(bar.getByRole('button', { name: nl('pause'), exact: true })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: nl('play'), exact: true })).toBeVisible();
  const stopped = await slider(page).inputValue();
  // Play ticks several times a second: two and a half seconds later the slider has not moved.
  await page.waitForTimeout(2500);
  await expect(slider(page)).toHaveValue(stopped);
  await finish(page, s);
});

test('at 390x844 the timebar covers neither the legend button nor the panel close button', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const legend = page.locator('summary', { hasText: nl('legend_heading') });
  for (const expanded of [false, true]) {
    if (expanded) await expandTimebar(page);
    const bar = await box(timebarOf(page));
    expect(bar.x).toBe(0);
    expect(bar.width).toBeCloseTo(390, 0);
    expect(bar.y + bar.height).toBeCloseTo(844, 0);
    expect(overlaps(bar, await box(legend)), `legend, expanded=${expanded}`).toBe(false);
    expect(overlaps(bar, await box(attributionButton(page))), `credits, expanded=${expanded}`).toBe(false);
  }
  await pickStation(page, 'E2E DST', /E2E DST/);
  const close = panelOf(page).getByRole('button', { name: nl('panel_close') });
  await expect(close).toBeVisible();
  expect(overlaps(await box(timebarOf(page)), await box(close))).toBe(false);
  expect(overlaps(await box(timebarOf(page)), await box(legend))).toBe(false);
  await finish(page, s);
});

// ---------------------------------------------------------------- the credits

test('the Bronnen disclosure lists every credit the footer listed for that t, and links to the sources page', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  const meta = (await (await page.request.get('/data/v1/meta.json')).json()) as {
    sources: {
      id: string;
      attribution: { text: string; url: string | null; lang: string | null; needsDate: boolean }[];
    }[];
  };
  // What the footer listed: the attribution of every source of /meta with the Amsterdam date of t in the text, once
  // for each (language, link, text).
  const date = '26 oktober 2026';
  const expected = new Map<string, { text: string; href: string | null; lang: string | null }>();
  for (const source of meta.sources)
    for (const a of source.attribution) {
      const text = attributionText(a.text, a.needsDate, date);
      const href = a.url?.startsWith('https://') ? a.url : null;
      expected.set(`${a.lang}|${href}|${text}`, { text, href, lang: a.lang });
    }
  expect(expected.size).toBeGreaterThan(3);

  const button = attributionButton(page);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: nl('attribution_panel_label') })).toHaveCount(0);
  const panel = await openAttribution(page);
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const items = panel.locator('ul > li');
  await expect(items).toHaveCount(expected.size);
  const listed = await items.evaluateAll((lis) =>
    lis.map((li) => ({
      text: li.textContent ?? '',
      href: li.querySelector('a')?.getAttribute('href') ?? null,
      lang: li.getAttribute('lang'),
    })),
  );
  expect(listed).toEqual([...expected.values()]);
  // The date duty (FR-1, FR-3, CH-1, CH-3): the date of t, never the registry's placeholder.
  await expect(panel.locator('ul')).toContainText(date);
  await expect(panel.locator('ul')).not.toContainText(/\[date de mise à jour\]|\(Bezugsdatum\)|<date>|<datum>/);
  await expect(panel.locator('ul')).toContainText('(Bezugsdatum: 26 oktober 2026)');
  await expect(panel.locator('ul')).toContainText('© VIGICRUES – www.vigicrues.gouv.fr, 26 oktober 2026,');
  // The map's own credits, the disclaimer line and the links.
  await expect(panel).toContainText('vallen niet onder de ODbL');
  await expect(panel.locator('a[href="https://www.openstreetmap.org/copyright"]')).toHaveCount(1);
  await expect(panel.getByText(nl('disclaimer'), { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: nl('page_sources_title'), exact: true })).toHaveAttribute(
    'href',
    '/bronnen',
  );
  await expect(panel.getByRole('link', { name: nl('notices_link') })).toHaveAttribute(
    'href',
    '/third-party-notices.txt',
  );
  // Only text nodes: no element but links in the list items, nothing from the provider is markup.
  expect(await panel.locator('ul > li *:not(a)').count()).toBe(0);

  // Escape closes it and the focus returns to the button.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await finish(page, s);
});

test('the credits are there in the table view and the English page too', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page, '/en/', 'Timeline');
  await chooseView(page, 'table', 'en');
  const panel = await openAttribution(page, 'en');
  await expect(panel.getByRole('link', { name: msg('en', 'page_sources_title'), exact: true })).toHaveAttribute(
    'href',
    '/en/sources',
  );
  await expect(panel.getByText(msg('en', 'disclaimer'), { exact: true })).toBeVisible();
  await finish(page, s);
});

// Review round 1: beside a drawer the panel was as wide as the window and its start was cut off; in a short window
// (200% zoom of 1440x900) its top went above the map and the heading was cut off.
test('the Bronnen panel stays inside the window: beside the drawer, and in a short window', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 768, height: 1024 });
  await open(page, '/?s=nl.e2e.dst');
  await mapReady(page);
  const drawer = await box(panelOf(page));
  let panel = await box(await openAttribution(page));
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(drawer.x);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 720, height: 450 });
  await ready(page);
  await expandTimebar(page);
  const opened = await openAttribution(page);
  panel = await box(opened);
  const bar = await box(page.getByRole('banner'));
  expect(panel.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(overlaps(panel, await box(timebarOf(page)))).toBe(false);
  // Its heading is in sight; the rest scrolls inside the panel.
  await expect(opened.getByRole('heading', { level: 2 })).toBeInViewport();
  await finish(page, s);
});

// ---------------------------------------------------------------- axe

test('axe: the map, the opened controls and the table view', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1024, height: 768 });
  await ready(page);
  await expandTimebar(page);
  await expectNoSeriousAxe(page);
  // Open, the credits cover the legend and MapLibre's text: axe judges the panel alone.
  await openAttribution(page);
  await expectNoSeriousAxe(page, 'section[aria-label]', false);
  await page.keyboard.press('Escape');
  await modeSummary(page).click();
  await expectNoSeriousAxe(page);
  await chooseView(page, 'table');
  await expectNoSeriousAxe(page, undefined, false);
  await openMenu(page);
  await expectNoSeriousAxe(page, undefined, false);
  await finish(page, s);
});
