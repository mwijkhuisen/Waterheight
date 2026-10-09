import { expect, type Page, test } from '@playwright/test';
import { expectClean } from './clean.ts';
import {
  type W as BaseW,
  barNav,
  chooseView,
  escapeRx,
  expandTimebar,
  expectNoSeriousAxe,
  featureState,
  finish,
  type HookChart,
  mapReady,
  ms,
  NOW,
  open,
  openAttribution,
  openMenu,
  openView,
  panelOf,
  pickStation,
  searchBox,
  searchButton,
  slider,
  start,
  textHosts,
  timebarTime,
  viewSummary,
  where,
  withoutWebGL2,
} from './helpers.ts';

// P4b acceptance (issue #19), on Chromium, Firefox and WebKit, against the e2e
// build served under the production headers with the e2e api behind it (a real
// PostgreSQL, the registry's 1,000 public stations (P5b), synthetic values, a fixed clock):
// - NL is the default and the language switch keeps t and s; the slider updates ?t= and the
//   marker states; a deep link restores the view; the slider works from the keyboard;
// - 02:30 CEST and 02:30 CET on 2026-10-25 are distinct selectable instants (scrubber and time input);
// - the table fallback renders with WebGL2 disabled, and the map chunk is never requested then;
// - a station named as an img tag with an onerror handler is inert in the popup, panel, table and chart tooltip;
// - 0 CSP violations, same-origin requests only, axe finds no serious or critical issue.

type W = BaseW & { __urls?: string[]; __webgl2?: number };
const RAW_NAME = '<img src=x onerror=alert(1)>';
const RAW_WATER = '<svg onload=alert(2)>';
/** The label of the xss station's NL-4 class (its own payload, so the name and water sweeps stay exact). */
const RAW_BASIS = 'Licht verhoogd (<img src=y onerror=alert(3)>)';

// ---------------------------------------------------------------- helpers

const tParam = (page: Page) => new URL(page.url()).searchParams.get('t');
/** Presses a key on the focused element and waits for the URL it must produce. */
async function press(
  page: Page,
  key: string,
  expectedT: string,
  valueTextEnd: RegExp,
  name?: string,
  urlT: string | null = expectedT,
) {
  const before = await slider(page, name).getAttribute('aria-valuetext');
  await page.keyboard.press(key);
  await expect.poll(() => tParam(page), { message: `t after ${key}` }).toBe(urlT);
  const after = slider(page, name);
  await expect(after).toHaveAttribute('aria-valuetext', valueTextEnd);
  expect(await after.getAttribute('aria-valuetext'), `valuetext after ${key}`).not.toBe(before);
  await expect(after).toHaveValue(ms(`${expectedT.slice(0, 16)}:00Z`));
  // The <time> element and the slider say the same, in UTC and in words.
  await expect(timebarTime(page)).toHaveAttribute('datetime', `${expectedT.slice(0, 16)}:00.000Z`);
  // (after now the slider's text adds "(verwachting)" to the time shown beside it)
  await expect(timebarTime(page)).toHaveText(
    ((await after.getAttribute('aria-valuetext')) ?? '').replace(/ \(verwachting\)$/, ''),
  );
}

/** Counts every URL the page writes (replaceState) in `window.__urls`; added before the page loads. */
const countUrlWrites = () => {
  const w = window as unknown as { __urls: string[] };
  w.__urls = [];
  const replace = history.replaceState.bind(history);
  history.replaceState = (...args: Parameters<History['replaceState']>) => {
    replace(...args);
    w.__urls.push(location.search);
  };
};
const urlWrites = (page: Page) => page.evaluate(() => (window as unknown as W).__urls ?? []);

test.beforeEach(async ({ page, browserName }) => {
  // WebKit must run without Temporal to prove the polyfill path; WebKit 26.6
  // ships it, so it is deleted before any page script runs.
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

// ---------------------------------------------------------------- language, URL state

test('NL is the default: language, heading, banner, disclaimer, and t is now', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // (P10e: the subtitle shows from 100rem, the nav is a row from 80rem)
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, '/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rivierkijker');
  // P10c: the subtitle under the name, and the two brand fonts loaded from our origin (the third-party check of this
  // test still passes).
  await expect(page.getByText('Waterstanden en afvoer van de rivieren naar Nederland', { exact: true })).toBeVisible();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    // (the family comes back quoted in some browsers and bare in others)
    return [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => `${f.family.replace(/["']/g, '')} ${f.weight}`);
  });
  expect(loaded).toEqual(expect.arrayContaining(['Bricolage Grotesque 700', 'Source Sans 3 400']));
  // (P10e: the banner is the compact "bèta" link of the bar; its accessible name carries the whole banner text and the
  // link text, and it goes to the disclaimer page)
  const beta = page.getByRole('banner').getByRole('link', {
    name: 'Bèta: deze site is in ontwikkeling. Gegevens kunnen ontbreken of onjuist zijn.',
  });
  await expect(beta).toHaveAttribute('href', '/disclaimer');
  await expect(beta).toHaveAccessibleName(/Lees de disclaimer$/);
  // The bar: the nine page links in their own navigation (P10e: a row from 80rem, below it behind the menu button).
  await expect(barNav(page).getByRole('link')).toHaveCount(9);
  await expect(barNav(page).getByRole('link', { name: 'Bronnen en licenties' })).toHaveAttribute('href', '/bronnen');
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(barNav(page)).toBeHidden();
  await openMenu(page);
  await expect(barNav(page).getByRole('link')).toHaveCount(9);
  await expect(barNav(page).getByRole('link', { name: 'Bronnen en licenties' })).toHaveAttribute('href', '/bronnen');
  await page.keyboard.press('Escape');
  await expect(barNav(page)).toBeHidden();
  // The credits (P10b footer, P10e "Bronnen" panel over the map): the disclaimer line, the credits of the sources of
  // /meta, each in its own language, then the map's credits and the third-party notices link.
  const panel = await openAttribution(page);
  await expect(panel.getByText('Geen officiële waarschuwingsdienst', { exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Bronnen');
  await expect(panel).toContainText('vallen niet onder de ODbL');
  await expect(panel.locator('a[href="https://www.openstreetmap.org/copyright"]')).toHaveCount(1);
  await expect(panel.locator('a[href="/third-party-notices.txt"]')).toHaveCount(1);
  await expect(panel.locator('li[lang="nl"]')).not.toHaveCount(0);
  await expect(panel.locator('li[lang="de"]')).not.toHaveCount(0);
  // The date duty of FR-1, FR-3 (Etalab) and CH-1, CH-3 (BAFU): the date of t, never the registry's placeholder; and
  // FR-3, which fills FR-1 series, is attributed in its own words (review SR-1). BAFU's placeholder keeps its word:
  // "(Bezugsdatum: 26 oktober 2026)" (the bare "(Bezugsdatum)" is the registry's placeholder).
  const credits = panel.locator('h2 + ul');
  await expect(credits).toContainText('26 oktober 2026');
  await expect(credits).not.toContainText(/\[date de mise à jour\]|\(Bezugsdatum\)|<date>|<datum>/);
  await expect(credits).toContainText('(Bezugsdatum: 26 oktober 2026)');
  await expect(credits).toContainText('© VIGICRUES – www.vigicrues.gouv.fr, 26 oktober 2026,');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // No t in the URL: now (the clock is fixed at 2026-10-26T12:00Z = 13:00 CET).
  await expect(slider(page)).toHaveValue(String(NOW.getTime()));
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /13:00 CET$/);
  await expect(timebarTime(page)).toHaveAttribute('datetime', '2026-10-26T12:00:00.000Z');
  expect(new URL(page.url()).search).toBe('');
  // Temporal: native where the browser has it; WebKit runs without it here (beforeEach), on the polyfill chunk.
  expect(s.log.requests.filter((u) => /\/assets\/global\.esm-[^/]+\.js$/.test(u))).toHaveLength(
    browserName === 'webkit' ? 1 : 0,
  );
  // The data comes from the static files (P9a): the runtime config, meta, stations and latest.json for now (debounced,
  // so it may come last), and not one request to the API for any of them.
  await expect
    .poll(() => s.log.requests.map((u) => new URL(u).pathname + new URL(u).search))
    .toEqual(
      expect.arrayContaining([
        '/runtime-config.json',
        '/data/v1/meta.json',
        '/data/v1/stations.json',
        '/data/v1/latest.json',
      ]),
    );
  expect(
    s.log.requests.map((u) => new URL(u).pathname).filter((p) => /^\/api\/v1\/(meta|stations|snapshot)$/.test(p)),
  ).toEqual([]);
  await finish(page, s);
});

test('the language switch keeps t and s, both ways', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  const english = page.getByRole('link', { name: 'English' });
  await expect(english).toHaveAttribute('href', '/en/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expectClean(page, s.log);

  await english.click();
  await expect.poll(() => where(page)).toBe('/en/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(slider(page, 'Timeline')).toBeVisible();
  // (P10e: the disclaimer line is in the "Bronnen" panel of the map)
  const credits = await openAttribution(page, 'en');
  await expect(credits.getByText('Not an official warning service', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(credits).toHaveCount(0);
  await expect(panelOf(page).getByRole('heading', { level: 2, name: 'E2E DST' })).toBeVisible();
  await expect(slider(page, 'Timeline')).toHaveAttribute('aria-valuetext', /02:30 CET/);
  await expect(slider(page, 'Timeline')).toHaveValue(ms('2026-10-25T01:30:00Z'));
  await expectClean(page, s.log);

  const dutch = page.getByRole('link', { name: 'Nederlands' });
  await expect(dutch).toHaveAttribute('href', '/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await dutch.click();
  await expect.poll(() => where(page)).toBe('/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(panelOf(page).getByRole('heading', { level: 2, name: 'E2E DST' })).toBeVisible();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /02:30 CET/);
  await finish(page, s);
});

test('the slider and the buttons update ?t= and the marker states', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await mapReady(page);

  // At 12:00Z nl.e2e.gap has no value (its last is 10:00Z, its limit 90 min); nl.e2e.xss has one.
  expect(await featureState(page, 'nl.e2e.gap')).toMatchObject({ has: false });
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true });

  await slider(page).focus();
  await page.keyboard.press('PageDown');
  await expect.poll(() => tParam(page)).toBe('2026-10-26T11:00Z');
  await page.keyboard.press('PageDown');
  await expect.poll(() => tParam(page)).toBe('2026-10-26T10:00Z');
  await expect.poll(() => featureState(page, 'nl.e2e.gap')).toMatchObject({ has: true });
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true });
  expect(s.log.requests.map((u) => new URL(u).pathname)).toContain('/data/v1/recent/2026-10-26/1000.json');

  // The buttons: one hour back and forward (P11b), then "Nu" (back to 12:00Z, where the gap station has no value).
  await page.getByRole('button', { name: '1 uur terug' }).click();
  await expect.poll(() => tParam(page)).toBe('2026-10-26T09:00Z');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /10:00 CET$/);
  await page.getByRole('button', { name: '1 uur vooruit' }).click();
  await expect.poll(() => tParam(page)).toBe('2026-10-26T10:00Z');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /11:00 CET$/);
  const now = page.getByRole('button', { name: 'Nu', exact: true });
  await now.click();
  // Choosing now is live mode again (P10a T7): no t in the URL, and the live note says so.
  await expect.poll(() => tParam(page)).toBeNull();
  // At the bound the button says so (aria-disabled) but keeps the focus, and does nothing (CR-10).
  await expect(now).toHaveAttribute('aria-disabled', 'true');
  await expect(now).not.toHaveAttribute('disabled');
  await expect(now).toBeFocused();
  // The timeline goes on after now (P8b: no station is selected, so it reaches the largest horizon of /meta).
  await expect(page.getByRole('button', { name: '1 uur vooruit' })).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('Enter');
  await expect(now).toBeFocused();
  expect(tParam(page)).toBeNull();
  // (P10e: the live note is in the expanded timebar)
  await expandTimebar(page);
  await expect(page.getByText('Live: ververst elke minuut', { exact: true })).toBeVisible();
  await expect.poll(() => featureState(page, 'nl.e2e.gap')).toMatchObject({ has: false });
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true });
  await finish(page, s);
});

test('a deep link restores the view: time, station, panel and the selected marker', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/en/?t=2026-10-25T00:30Z&s=nl.e2e.dst', 'Timeline');

  await expect(slider(page, 'Timeline')).toHaveValue(ms('2026-10-25T00:30:00Z'));
  await expect(slider(page, 'Timeline')).toHaveAttribute('aria-valuetext', /02:30 CEST/);
  // (P10e: the station <select> is gone; the panel and the selected marker below say which station is chosen)
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  const level = panel.getByRole('region', { name: 'Water level' });
  await expect(level.locator('strong')).toHaveText('111');
  // (P10d: the line reads "Last measurement: 111 cm NAP at <time>"; the number is still the only <strong>)
  await expect(level.locator('p', { has: page.locator('strong') })).toHaveText(
    /^Last measurement: 111 cm NAP at .+ CEST$/,
  );
  // The map is on the selected station and marks it.
  await expect.poll(() => featureState(page, 'nl.e2e.dst')).toMatchObject({ has: true, selected: true });
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ selected: false });
  await expect(page.locator('.maplibregl-popup-content > span')).toHaveText('E2E DST');
  expect(where(page)).toBe('/en/?t=2026-10-25T00:30Z&s=nl.e2e.dst');
  await finish(page, s);
});

test('a t or s that does not parse is dropped, never shown', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-02-30T10:00Z&s=nl.e2e.nope%3Cb%3E');
  // t falls back to now, s to no selection; nothing of either reaches the page.
  await expect(slider(page)).toHaveValue(String(NOW.getTime()));
  // (P10e: the station <select> is gone; "no selection" is no panel, no selected marker)
  await expect.poll(() => featureState(page, 'nl.e2e.dst')).toMatchObject({ selected: false });
  await expect(panelOf(page)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('nope');
  await expect(page.getByRole('link', { name: 'English' })).toHaveAttribute('href', '/en/');
  await finish(page, s);
});

// ---------------------------------------------------------------- the keyboard

test('the slider and the station search work from the keyboard alone', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');

  // Tab until the slider has the focus (a bound, so a missing tab stop fails instead of hanging).
  const isSlider = () =>
    page.evaluate(() => document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'range');
  let tabs = 0;
  while (!(await isSlider()) && tabs < 40) {
    await page.keyboard.press('Tab');
    tabs++;
  }
  expect(await isSlider(), `the slider is reachable by Tab (after ${tabs} presses)`).toBe(true);
  await expect(slider(page)).toBeFocused();

  // 2026-10-26 is winter time: 11:50Z is 12:50 CET.
  await press(page, 'ArrowLeft', '2026-10-26T11:50Z', /12:50 CET$/);
  // (now is live mode again: the URL has no t)
  await press(page, 'ArrowRight', '2026-10-26T12:00Z', /13:00 CET$/, undefined, null);
  await press(page, 'PageDown', '2026-10-26T11:00Z', /12:00 CET$/);
  await press(page, 'PageUp', '2026-10-26T12:00Z', /13:00 CET$/, undefined, null);
  await press(page, 'Home', '2026-08-24T00:00Z', /02:00 CEST$/);
  // End is the end of the track: after now, the forecast part (now + 48 h with no station selected), and "Nu" comes back.
  await press(page, 'End', '2026-10-28T12:00Z', /13:00 CET \(verwachting\)$/);
  await page.getByRole('button', { name: 'Nu', exact: true }).click();
  await expect.poll(() => tParam(page)).toBeNull();

  // The station search (P10e: the magnifier and its combobox replace the station list): open it, move to another
  // result by ArrowDown, choose it by Enter; then another station by typing its name.
  await searchButton(page).focus();
  await expect(searchButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.type('E2E');
  const options = page.getByRole('listbox').getByRole('option');
  expect(await options.count()).toBeGreaterThan(1);
  const firstName = (await options.nth(1).textContent()) ?? '';
  await page.keyboard.press('ArrowDown');
  await expect(searchBox(page)).toHaveAttribute(
    'aria-activedescendant',
    (await options.nth(1).getAttribute('id')) ?? '',
  );
  await page.keyboard.press('Enter');
  // (the t of now is no t: live mode)
  await expect.poll(() => where(page)).toMatch(/^\/\?s=nl\.e2e\./);
  expect((await panelOf(page).getByRole('heading', { level: 2 }).textContent()) ?? '').toBe(
    firstName.replace(/ \(.*\)$/, ''),
  );
  // Opened from the search, the focus is in the panel (its heading) and the search has closed.
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  await expect(searchBox(page)).toHaveCount(0);

  await searchButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('E2E D');
  await page.keyboard.press('Enter');
  await expect.poll(() => where(page)).toBe('/?s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(panelOf(page).getByRole('region', { name: 'Waterstand' }).locator('strong')).toHaveText('444');
  await finish(page, s);
});

test('a held arrow key keeps the timebar moving; the URL follows with few writes (CR-3)', async ({
  page,
  context,
  baseURL,
}) => {
  // WebKit throws after 100 replaceState calls in 30 s (Chromium ignores calls past its own limit): the state
  // moves at once, the URL at most every 400 ms, and it ends at the last value.
  const s = await start(page, context, baseURL, 'state');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(countUrlWrites);
  await open(page, '/?t=2026-10-20T00:00Z');
  await slider(page).focus();
  const began = Date.now();
  for (let i = 0; i < 150; i++) await page.keyboard.press('ArrowRight');
  const took = Date.now() - began;
  // 150 steps of ten minutes: 25 hours on.
  await expect(slider(page)).toHaveValue(ms('2026-10-21T01:00:00Z'));
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /03:00 CEST$/);
  await expect.poll(() => tParam(page)).toBe('2026-10-21T01:00Z');
  const writes = await urlWrites(page);
  expect(writes.at(-1)).toBe('?t=2026-10-21T01:00Z');
  // At most one write per 400 ms while the keys went down, plus the leading and the trailing one: never one per key,
  // and a slow runner (a longer run) cannot make this flaky.
  expect(writes.length, `${writes.length} URL writes in ${took} ms`).toBeLessThanOrEqual(Math.ceil(took / 400) + 2);
  expect(writes.length).toBeLessThan(150);
  expect(errors).toEqual([]);
  await finish(page, s);
});

test('a held key asks only where it stops: one series request, few snapshot files (SR-2)', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // Older than recent.json's 7 days (P10a T6): the chart asks the API for its span, which is what a held key must not
  // do at every step. (A t within 7 days reads the static recent.json and asks no series at all.)
  await open(page, '/?t=2026-10-10T12:00Z&s=nl.e2e.dst');
  // (no point of the chart exists before the data began, so `settled` has nothing to wait for: the page is idle)
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // The station's forecast (its horizon, P8b) is asked once, whatever t does; it is not a series of the chart.
  const urls = () => s.log.requests.map((u) => new URL(u));
  const asked = (route: string) =>
    urls().filter((u) => u.pathname.startsWith(`/api/v1/${route}`) && !u.pathname.endsWith('/forecast'));
  // No static file holds a day before the data began, so the snapshots (and the 24-hour change's second one) come from
  // the API, which a held key must ask only where it stops.
  const snapshotsAsked = () => urls().filter((u) => u.pathname === '/api/v1/snapshot').length;
  const before = { series: 1, snapshot: snapshotsAsked() };
  await expect.poll(() => asked('series').length).toBe(1);

  // Forty hours forward an hour at a time: the chart's span (six-hour blocks) would change six times on the way.
  await slider(page).focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press('PageUp');
  await expect.poll(() => tParam(page)).toBe('2026-10-12T04:00Z');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(panelOf(page).getByRole('region', { name: 'Waterstand' })).toContainText('Geen waarde op dit tijdstip');
  const series = asked('series').slice(before.series);
  // The live t would ask for every six-hour block on the way (six requests); the settled one asks where the keys
  // stopped. One more is allowed for a runner that pauses longer than the debounce between two presses.
  expect(series.length, series.map((u) => u.search).join(' ')).toBeLessThanOrEqual(2);
  expect(series.at(-1)?.search).toBe('?from=2026-10-05T06:00Z&to=2026-10-12T06:00Z&res=raw');
  expect(snapshotsAsked() - before.snapshot).toBeLessThanOrEqual(6);
  await finish(page, s);
});

test('while a new t loads, the values of the old one are marked busy and dimmed (CR-4)', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/data/v1/recent/2026-10-26/1100.json', async (route) => {
    await held;
    await route.continue();
  });
  await open(page, '/?s=nl.e2e.dst');
  const body = panelOf(page).locator('..');
  await expect(body).toHaveAttribute('aria-busy', 'false');
  await expect(panelOf(page).locator('strong')).toHaveText('444');
  await page.getByRole('button', { name: '1 uur terug' }).click();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /12:00 CET$/);
  // The panel still shows the value of 12:00Z, so the region says it is not current yet, and looks it.
  await expect(body).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => body.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.6);
  release();
  await expect(body).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => body.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await finish(page, s);
});

test('a date typed digit by digit is taken when complete; a year half typed is never clamped (CR-8)', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'typing into the segments of a date field is Chromium’s behaviour');
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-10-26T11:00Z'); // 12:00 CET
  await expandTimebar(page); // (P10e: the date and time fields are in the expanded timebar)
  const date = page.getByLabel('Datum', { exact: true });
  await date.focus();
  // The browser's locale (en-US) orders the segments month, day, year; on the way, 2026-01-26 and 0002-10-24
  // are complete dates outside the range: they are left alone, never moved to its edge.
  await page.keyboard.type('10242026');
  await expect(date).toHaveValue('2026-10-24');
  await expect(date).toBeFocused();
  await expect.poll(() => tParam(page)).toBe('2026-10-24T10:00Z'); // 12:00 CEST
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /12:00 CEST$/);
  await finish(page, s);
});

// ---------------------------------------------------------------- 2026-10-25, 02:30 twice

test('02:50 CEST is followed by 02:00 CET on the scrubber, and both 02:30 instants are reachable', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-10-25T00:50Z');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /02:50 CEST$/);
  await expect(slider(page)).toHaveValue(ms('2026-10-25T00:50:00Z'));

  await slider(page).focus();
  // The hour repeats: the clocks go from 02:50 CEST back to 02:00 CET.
  await press(page, 'ArrowRight', '2026-10-25T01:00Z', /02:00 CET$/);
  await press(page, 'ArrowRight', '2026-10-25T01:10Z', /02:10 CET$/);
  await press(page, 'ArrowRight', '2026-10-25T01:20Z', /02:20 CET$/);
  await press(page, 'ArrowRight', '2026-10-25T01:30Z', /02:30 CET$/);
  // ...and back to the first 02:30.
  for (const [t, label] of [
    ['2026-10-25T01:20Z', /02:20 CET$/],
    ['2026-10-25T01:10Z', /02:10 CET$/],
    ['2026-10-25T01:00Z', /02:00 CET$/],
    ['2026-10-25T00:50Z', /02:50 CEST$/],
    ['2026-10-25T00:40Z', /02:40 CEST$/],
    ['2026-10-25T00:30Z', /02:30 CEST$/],
  ] as const)
    await press(page, 'ArrowLeft', t, label);
  await finish(page, s);
});

test('02:30 CEST and 02:30 CET are two choices of the time input, with their own values', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-10-24T12:00Z&s=nl.e2e.dst');
  const level = () => panelOf(page).getByRole('region', { name: 'Waterstand' }).locator('strong');
  await expect(level()).toHaveText('50');
  await expect(page.getByRole('group', { name: /Dit uur komt twee keer voor/ })).toHaveCount(0);

  await expandTimebar(page); // (P10e: the date and time fields and the repeated-hour choice are in the expanded timebar)
  const date = page.getByLabel('Datum', { exact: true });
  const time = page.getByLabel('Tijd (Nederlandse tijd)', { exact: true });
  await date.fill('2026-10-25');
  await expect.poll(() => tParam(page)).toBe('2026-10-25T13:00Z'); // 14:00 CET, the time of day it had
  await time.fill('02:30');

  // 02:30 on that date happens twice: the one with the offset of the current t (14:00 CET) is taken, and the
  // choice appears.
  const choice = page.getByRole('group', { name: 'Dit uur komt twee keer voor (einde zomertijd). Welke bedoel je?' });
  await expect(choice).toBeVisible();
  await expect(choice.getByRole('radio')).toHaveCount(2);
  const cest = choice.getByRole('radio', { name: '02:30 CEST (UTC+02:00)' });
  const cet = choice.getByRole('radio', { name: '02:30 CET (UTC+01:00)' });
  await expect.poll(() => tParam(page)).toBe('2026-10-25T01:30Z');
  await expect(cet).toBeChecked();
  await expect(cest).not.toBeChecked();
  await expect(level()).toHaveText('222');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /02:30 CET$/);
  await expect(slider(page)).toHaveValue(ms('2026-10-25T01:30:00Z'));
  await expect(timebarTime(page)).toHaveAttribute('datetime', '2026-10-25T01:30:00.000Z');

  await cest.check();
  await expect.poll(() => tParam(page)).toBe('2026-10-25T00:30Z');
  await expect(cest).toBeChecked();
  await expect(cet).not.toBeChecked();
  await expect(level()).toHaveText('111');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /02:30 CEST$/);
  await expect(timebarTime(page)).toHaveAttribute('datetime', '2026-10-25T00:30:00.000Z');
  expect(where(page)).toBe('/?t=2026-10-25T00:30Z&s=nl.e2e.dst');

  // Another minute in the repeated hour keeps the offset it is in (CR-9): 02:40 CEST, then from 02:30 CET 02:40 CET.
  await expect(time).toHaveValue('02:30');
  await time.fill('02:40');
  await expect.poll(() => tParam(page)).toBe('2026-10-25T00:40Z');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /02:40 CEST$/);
  await choice.getByRole('radio', { name: '02:40 CET (UTC+01:00)' }).check();
  await expect.poll(() => tParam(page)).toBe('2026-10-25T01:40Z');
  await time.fill('02:30');
  await expect.poll(() => tParam(page)).toBe('2026-10-25T01:30Z');
  await expect(level()).toHaveText('222');
  await finish(page, s);
});

// ---------------------------------------------------------------- views and fallbacks

test('without WebGL2 the table replaces the map, and the map chunk is never requested', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.addInitScript(withoutWebGL2);
  await open(page, '/');

  await expect(page.getByRole('status').filter({ hasText: 'WebGL2' })).toContainText(
    'Deze browser kan de kaart niet tonen (geen WebGL2)',
  );
  const table = page.locator('table');
  await expect(table).toHaveCount(1);
  await expect(table.locator('caption')).toContainText(/^Stations op .*13:00 CET/);
  await expect(table.locator('thead th[scope="col"]')).toHaveText([
    'Station',
    'Water',
    'Bron',
    'Grootheid',
    'Toestand',
    'Waarde',
    'Gemeten',
    'Ouderdom',
    'Kenmerken',
  ]);
  // One row per series, 100 to a page (P10a T7), each starting with a row header; the pager says where it is.
  const api = (await (await request.get('/api/v1/stations')).json()) as { stations: { series: unknown[] }[] };
  const series = api.stations.reduce((n, st) => n + st.series.length, 0);
  expect(series).toBeGreaterThan(300);
  await expect(table.locator('tbody tr')).toHaveCount(100);
  await expect(table.locator('tbody th[scope="row"]')).toHaveCount(100);
  await expect(page.getByText(`Stations 1–100 van ${series}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vorige' })).toBeDisabled();

  // A station chosen in the search (P10e) brings its page into view.
  await pickStation(page, 'E2E DST', /E2E DST/);
  const row = (name: string) =>
    table.locator('tbody tr').filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(row('E2E DST')).toHaveCount(1);
  // Its value at 12:00Z is the one of 11:50Z (limit 45 min), ten minutes old; it has no reference, so no state.
  await expect(row('E2E DST').locator('td')).toHaveText([
    'E2E',
    'NL-1',
    'Waterstand',
    'geen referentie',
    '444 cm NAP',
    /12:50 CET$/,
    /^10\s?min$/,
    '',
  ]);
  await pickStation(page, 'E2E gap', /E2E gap/);
  await expect(row('E2E gap').locator('td')).toHaveText(['E2E', 'NL-1', 'Waterstand', '–', '–', '–', '–', '']);

  // No map: no view disclosure (P10e; it held the toggle), no canvas, and not a request for the map chunk, its worker,
  // the manifest or a tile.
  await expect(viewSummary(page)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Weergave', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kaart', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tabel', exact: true })).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  const paths = s.log.requests.map((u) => new URL(u).pathname);
  expect(paths.filter((p) => /createMap|maplibre|\/tiles\/|\/assets\/map\//i.test(p))).toEqual([]);
  expect(s.log.workers).toEqual([]);

  // A row selects its station and opens the panel with the focus on its heading (the search above opened that panel
  // already, so it is closed first).
  await panelOf(page).getByRole('button', { name: 'Station sluiten' }).click();
  await expect(panelOf(page)).toHaveCount(0);
  await expect.poll(() => where(page)).toBe('/');
  await row('E2E gap').getByRole('button', { name: 'E2E gap', exact: true }).click();
  await expect.poll(() => where(page)).toBe('/?s=nl.e2e.gap');
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { level: 2, name: 'E2E gap' })).toBeFocused();
  await expect(panel.getByRole('region', { name: 'Waterstand' })).toContainText('Geen waarde op dit tijdstip');
  await expect(row('E2E gap').getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await expect(row('E2E DST').getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  await finish(page, s);
});

test('when MapLibre cannot get its own WebGL2 context the notice and the table appear', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // The page's pre-check gets a real context; every later request (MapLibre's own) gets null.
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, ...a: unknown[]) => unknown;
    const w = window as unknown as { __webgl2: number };
    w.__webgl2 = 0;
    (HTMLCanvasElement.prototype as { getContext: unknown }).getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type !== 'webgl2') return get.call(this, type, ...rest);
      return w.__webgl2++ === 0 ? get.call(this, type, ...rest) : null;
    };
  });
  await open(page, '/');

  await expect(page.getByRole('status').filter({ hasText: 'De kaart kan niet worden geladen' })).toBeVisible();
  await expect(page.locator('table')).toHaveCount(1);
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(viewSummary(page)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Weergave', exact: true })).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  // The pre-check passed (call 1), then the map chunk was requested and asked for its own context (call 2 or more).
  expect(await page.evaluate(() => (window as unknown as W).__webgl2)).toBeGreaterThanOrEqual(2);
  expect(s.log.requests.map((u) => new URL(u).pathname).some((p) => /\/assets\/createMap-[^/]+\.js$/.test(p))).toBe(
    true,
  );
  // The table works as the fallback: a row opens the panel (the table pages at 100 rows, so a link names the station
  // whose page is in view).
  await page.goto('/?s=nl.e2e.gap');
  await expect(slider(page)).toBeVisible();
  await page.getByRole('button', { name: 'E2E DST', exact: true }).click();
  await expect.poll(() => where(page)).toBe('/?s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2, name: 'E2E DST' })).toBeFocused();
  await finish(page, s);
});

test('the view toggle reaches the table with WebGL2 present, and brings the map back', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await mapReady(page);
  const map = page.getByRole('button', { name: 'Kaart', exact: true });
  const tableButton = page.getByRole('button', { name: 'Tabel', exact: true });
  // P10e: the toggle lives in the view disclosure ("Weergave: Kaart"), closed at the start.
  await expect(viewSummary(page)).toHaveText('Weergave: Kaart');
  await expect(map).toBeHidden();
  await openView(page);
  await expect(page.getByRole('group', { name: 'Weergave', exact: true })).toBeVisible();
  await expect(map).toHaveAttribute('aria-pressed', 'true');
  await expect(tableButton).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(1);
  await expect(page.locator('table')).toHaveCount(0);
  // (the timebar's polite play status is always in the page, empty: only a filled status would be the fallback notice)
  await expect(page.getByRole('status').filter({ hasText: /\S/ })).toHaveCount(0); // no fallback notice when the map works

  await tableButton.click();
  // Choosing a view closes the disclosure; its summary says where we are.
  await expect(viewSummary(page)).toHaveText('Weergave: Tabel');
  await expect(tableButton).toBeHidden();
  await openView(page);
  await expect(tableButton).toHaveAttribute('aria-pressed', 'true');
  await expect(map).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('table')).toHaveCount(1);
  await expect(page.locator('table caption')).toContainText('Stations op');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  // (the table pages at 100 rows: the first page's station buttons, not the e2e station further down the list)
  await expect(page.locator('table tbody th button').first()).toBeVisible();

  await map.click();
  await openView(page);
  await expect(map).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(1);
  await mapReady(page);
  expect(await featureState(page, 'nl.e2e.gap')).toMatchObject({ has: false });
  await finish(page, s);
});

// The map unmounts with the table view; the station the map's popup showed stays selected through the round trip.
test('the selected station stays selected when the view switches to the table and back', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(page.locator('.maplibregl-popup-content > span')).toHaveText('E2E DST');

  await chooseView(page, 'table');
  await expect(page.locator('table')).toHaveCount(1);
  expect(where(page)).toBe('/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(page.getByRole('button', { name: 'E2E DST', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await chooseView(page, 'map');
  await expect.poll(() => featureState(page, 'nl.e2e.dst')).toMatchObject({ has: true, selected: true });
  expect(where(page)).toBe('/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(page.locator('.maplibregl-popup-content > span')).toHaveText('E2E DST');
  await finish(page, s);
});

test("the popup's own close button deselects the station", async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(page.locator('.maplibregl-popup-content > span')).toHaveText('E2E DST');
  await page.locator('.maplibregl-popup-close-button').click();
  await expect.poll(() => where(page)).toBe('/?t=2026-10-25T01:30Z');
  await expect(panelOf(page)).toHaveCount(0);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await expect.poll(() => featureState(page, 'nl.e2e.dst')).toMatchObject({ selected: false });
  // The focus goes to the magnifier (P10e: the station list is gone), not to the page body the removed button leaves
  // behind (CR-10).
  await expect(searchButton(page)).toBeFocused();
  await finish(page, s);
});

// ---------------------------------------------------------------- XSS (issue #19)

test('a station named as an img tag with onerror is inert: popup, panel, table and chart tooltip', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?s=nl.e2e.xss');
  await mapReady(page);

  const panel = panelOf(page);
  const popup = page.locator('.maplibregl-popup-content > span');
  // Panel heading, water name and popup hold the raw strings as text.
  await expect(panel.getByRole('heading', { level: 2 })).toBeVisible();
  expect(await panel.getByRole('heading', { level: 2 }).textContent()).toBe(RAW_NAME);
  const water = panel.locator('dd', { hasText: RAW_WATER });
  await expect(water).toBeVisible();
  expect(await water.textContent()).toBe(RAW_WATER);
  await expect(popup).toBeVisible();
  expect(await popup.textContent()).toBe(RAW_NAME);

  // Close it, then select the station by clicking its circle on the map.
  await panel.getByRole('button', { name: 'Station sluiten' }).click();
  await expect(panel).toHaveCount(0);
  await expect(popup).toHaveCount(0);
  await expect.poll(() => where(page)).toBe('/');
  const circle = await page.evaluate(
    async ([lon, lat]) => {
      const map = (window as unknown as W).__rws?.map;
      if (!map) throw new Error('no map');
      const idle = new Promise<void>((r) => map.once('idle', r));
      map.jumpTo({ center: [lon as number, lat as number], zoom: 12 });
      await idle;
      return map.project([lon as number, lat as number]);
    },
    [6.1, 51.85],
  );
  await page.locator('.maplibregl-canvas').click({ position: circle });
  await expect.poll(() => where(page)).toBe('/?s=nl.e2e.xss');
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
  expect(await panel.getByRole('heading', { level: 2 }).textContent()).toBe(RAW_NAME);
  await expect(popup).toBeVisible();
  expect(await popup.textContent()).toBe(RAW_NAME);

  // The chart: its tooltip is drawn on the canvas (richText), never as HTML.
  await page.waitForFunction(() => {
    const charts = [...((window as unknown as W).__rws?.charts ?? [])];
    const option = charts[0]?.getOption();
    return charts.length === 1 && (option?.series?.[0]?.data?.length ?? 0) > 100 && !!option?.tooltip?.[0];
  });
  const chartBox = panel.locator('div[role="img"]');
  const chartTags = () => chartBox.evaluate((el) => [...el.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()));
  const tagsBefore = await chartTags();
  expect(new Set(tagsBefore)).toEqual(new Set(['div', 'canvas']));
  const tip = await page.evaluate(async () => {
    const chart = [...((window as unknown as W).__rws?.charts ?? [])][0] as HookChart;
    const drawn = () =>
      chart
        .getZr()
        .storage.getDisplayList(true)
        .flatMap((e) => (typeof e.style?.text === 'string' ? [e.style.text] : []));
    const before = drawn();
    const option = chart.getOption();
    const data = option?.series?.[0]?.data ?? [];
    chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: data.length - 1 });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return {
      renderMode: option?.tooltip?.[0]?.renderMode,
      lastTs: (data.at(-1) as [number, number] | undefined)?.[0],
      before,
      after: drawn(),
    };
  });
  expect(tip.renderMode).toBe('richText');
  expect(tip.lastTs).toBe(NOW.getTime());
  // The tooltip was shown, as three lines of canvas text: the raw name, the time, the value with its unit...
  expect(tip.before.filter((t) => t.includes('onerror'))).toEqual([]);
  expect(tip.after.filter((t) => t.includes('onerror'))).toEqual([RAW_NAME]);
  const lines = tip.after.slice(tip.after.indexOf(RAW_NAME));
  expect(lines.slice(0, 3)).toEqual([
    RAW_NAME,
    expect.stringMatching(/13:00 CET$/),
    expect.stringMatching(/^gemeten: \d+([.,]\d+)? cm NAP$/),
  ]);
  // (the station's forecast run, issued before now, adds its own line, labelled with its agency)
  for (const extra of lines.slice(3)) expect(extra).toMatch(/^RWS · .+: \d+([.,]\d+)? cm NAP$/);
  // ...and not one element was added to the chart.
  expect(await chartTags()).toEqual(tagsBefore);

  // The sweep, map view: the raw strings sit only in text nodes of the heading and the popup (P10e: the station <select>
  // and its options are gone; the search's result list has its own sweep below).
  const sweep = async (view: 'map' | 'table') => {
    expect(await textHosts(page, 'onerror=alert(1)'), `name hosts in the ${view} view`).toEqual(
      view === 'map' ? ['h2', 'span'] : ['button', 'h2'],
    );
    expect(await textHosts(page, 'onload=alert(2)'), `water hosts in the ${view} view`).toEqual(
      view === 'map' ? ['dd'] : ['dd', 'td'],
    );
    // The basis label: the panel's basis row and, on the map, the popup line, as text.
    expect(await textHosts(page, 'onerror=alert(3)'), `basis hosts in the ${view} view`).toEqual(
      view === 'map' ? ['dd', 'p', 'span'] : ['dd', 'span'],
    );
    await expect(page.locator('img')).toHaveCount(0);
    await expect(page.locator('img[src="x"], img[src="y"]')).toHaveCount(0);
    await expect(page.locator('svg[onload]')).toHaveCount(0);
    await expect(page.locator('[onerror], [onload]')).toHaveCount(0);
  };
  await sweep('map');

  // The search's result list (what the <select>'s option was): the hostile name and water are text of an option, nothing
  // else, and no element or request comes of them.
  await searchButton(page).click();
  await searchBox(page).fill('onerror');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
  // (the option is a div[role=option] holding one text node: no element inside it)
  expect(await textHosts(page, 'onerror=alert(1)'), 'name hosts with the search open').toEqual(['div', 'h2', 'span']);
  expect(await textHosts(page, 'onload=alert(2)'), 'water hosts with the search open').toEqual(['dd', 'div']);
  expect(
    await page
      .getByRole('listbox')
      .getByRole('option')
      .evaluate((el) => el.childElementCount),
  ).toBe(0);
  await expect(page.locator('img')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(searchBox(page)).toHaveCount(0);

  // The table view, once: the station is still selected, its row button holds the raw name as text.
  await chooseView(page, 'table');
  const cell = page.locator('table tbody th button', { hasText: RAW_NAME });
  await expect(cell).toHaveCount(1);
  expect(await cell.textContent()).toBe(RAW_NAME);
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  expect(where(page)).toBe('/?s=nl.e2e.xss');
  expect(await panel.getByRole('heading', { level: 2 }).textContent()).toBe(RAW_NAME);
  await expect(page.locator('table tbody tr', { hasText: RAW_NAME }).locator('td').first()).toHaveText(RAW_WATER);
  await sweep('table');

  // Nothing was requested for `src=x` (a parsed <img> would have fetched /x), and no dialog opened.
  expect(s.log.requests.map((u) => new URL(u).pathname).filter((p) => p.endsWith('/x') || p.endsWith('/y'))).toEqual(
    [],
  );
  await finish(page, s);
});

// ---------------------------------------------------------------- state and basis (P7b)

for (const [path, kind, state, disclaimer, row] of [
  ['/?s=nl.e2e.xss', 'Waterstand', 'verhoogd', 'RWS Waterinfo-legenda, geen officiële waarschuwing', 'Grondslag'],
  ['/en/?s=nl.e2e.xss', 'Water level', 'elevated', 'RWS Waterinfo legend, not an official warning', 'Basis'],
] as const)
  test(`the popup and the panel show state and basis: ${path}`, async ({ page, context, baseURL }) => {
    const s = await start(page, context, baseURL, 'state');
    await open(page, path, kind === 'Waterstand' ? undefined : 'Timeline');
    await mapReady(page);
    const line = page.locator('.maplibregl-popup-content > p');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveText(`${kind}: ${state}, ${disclaimer}: ${RAW_BASIS}`);
    expect(await line.textContent()).toContain(RAW_BASIS);
    if (kind === 'Waterstand') {
      // A new t replaces the lines in place: the popup, and a keyboard focus on its close button, stay.
      const content = page.locator('.maplibregl-popup-content');
      await content.evaluate((el) => el.setAttribute('data-kept', '1'));
      const next = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith('/data/v1/recent/'));
      await slider(page).focus();
      await page.keyboard.press('ArrowLeft');
      await next;
      await expect(line).toHaveCount(1);
      await expect(content).toHaveAttribute('data-kept', '1');
    }
    const panel = panelOf(page);
    await expect(panel.locator('dt', { hasText: row })).toBeVisible();
    // the provider's label as text, then our own translation after " — " (P10a label_translation)
    await expect(panel.locator('dd', { hasText: RAW_BASIS })).toHaveText(
      new RegExp(`^${escapeRx(`${disclaimer}: ${RAW_BASIS}`)} — .+$`),
    );
    await expect(panel.locator('dd', { hasText: new RegExp(`^${state}$`) })).toBeVisible();
    await finish(page, s);
  });

// ---------------------------------------------------------------- play

test('play steps whole hours from the frames; Pause and a hidden tab stop it', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'dh');
  // Every URL the page writes (replaceState). P11b: play is for the Δh and Q modes (D-1) and takes one UTC hour a tick
  // (about twelve a second at the normal speed), so the throttled URL writes show whole hours, rising.
  await page.addInitScript(countUrlWrites);
  await open(page, '/?mode=delta&t=2026-10-25T06:00Z');
  const urls = () => urlWrites(page);
  const hours = async () => (await urls()).map((u) => new URLSearchParams(u).get('t') ?? '');
  const play = page.getByRole('button', { name: 'Afspelen', exact: true });
  const pause = page.getByRole('button', { name: 'Pauzeren', exact: true });

  // One button whose name says what it does next; no aria-pressed besides (CR-10).
  await expect(play).toBeEnabled();
  await expect(play).not.toHaveAttribute('aria-pressed');
  await play.click();
  await expect(pause).toBeVisible();
  await expect(pause).not.toHaveAttribute('aria-pressed');
  await expect(pause).toBeFocused();
  await expect.poll(async () => (await urls()).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const first = await hours();
  for (const t of first) expect(t).toMatch(/^2026-10-25T\d\d:00Z$/);
  expect([...first].sort()).toEqual(first);
  expect((await urls())[0]).toMatch(/play=normal/);

  await pause.click();
  await expect(play).toBeVisible();
  await page.waitForTimeout(600); // (the URL write is throttled: the last hour reaches it after the click)
  const stopped = await urls();
  const last = stopped.at(-1) ?? '';
  expect(last).toMatch(/^\?t=2026-10-25T\d\d:00Z&mode=delta&play=normal$/);
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /:00 CET$/);
  await page.waitForTimeout(2500);
  expect(await urls()).toEqual(stopped);

  // Play again, then hide the tab: it stops by itself.
  await play.click();
  await expect(pause).toBeVisible();
  await expect.poll(async () => (await urls()).length, { timeout: 10_000 }).toBeGreaterThan(stopped.length);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(play).toBeVisible();
  await page.waitForTimeout(600);
  const hidden = await urls();
  await page.waitForTimeout(2500);
  expect(await urls()).toEqual(hidden);
  expect(await tParam(page)).toBe(hidden.at(-1)?.match(/t=([^&]+)/)?.[1]);
  await finish(page, s);
});

test('under reduced motion Play is off and says why', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'dh');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/?mode=delta&t=2026-10-26T10:00Z');
  await expect(page.getByRole('button', { name: 'Afspelen', exact: true })).toBeDisabled();
  await expect(page.getByText('Afspelen staat uit, omdat je apparaat om minder beweging vraagt.')).toBeVisible();
  // The other controls still work: the step is one hour.
  await expect(page.getByRole('button', { name: '1 uur vooruit' })).toBeEnabled();
  await page.getByRole('button', { name: '1 uur vooruit' }).click();
  await expect.poll(() => tParam(page)).toBe('2026-10-26T11:00Z');
  await finish(page, s);
});

// ---------------------------------------------------------------- not found

// P10b: a path that is no page is a real 404 (Caddy serves the 404 shell with that status), in its language; pages.spec.ts
// holds the rest of the 404 page's checks.
test('an unknown app path is a 404 with the 404 page of its own, in its language', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const response = await page.goto('/en/does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await expect(page.getByRole('link', { name: 'Go to the map' })).toHaveAttribute('href', '/en/');
  // (P10e: the disclaimer line is in the slim footer, the nine page links are in the bar, a row from 80rem)
  await expect(
    page.getByRole('contentinfo').getByText('Not an official warning service', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(barNav(page, 'en').getByRole('link')).toHaveCount(9);

  const dutch = await page.goto('/niet-hier');
  expect(dutch?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pagina niet gevonden');
  await expect(page.getByRole('link', { name: 'Naar de kaart' })).toHaveAttribute('href', '/');
  await expect(barNav(page).getByRole('link')).toHaveCount(9);
  await finish(page, s);
});

test('when the Temporal polyfill cannot load, the page says so instead of staying blank (CR-12)', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // Every browser runs without Temporal here, and the polyfill chunk answers 404.
  await page.addInitScript(() => {
    delete (globalThis as { Temporal?: unknown }).Temporal;
  });
  await page.route('**/assets/global.esm-*.js', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toHaveText('De pagina kan niet worden geladen. Probeer het later opnieuw.');
  // The static page stays as it was, under the alert's text node.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rivierkijker');
  await expect(page.locator('#app [role="alert"]')).toHaveCount(1);
  await expect(slider(page)).toHaveCount(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- axe

const axeSpec = (title: string, run: (page: Page) => Promise<void>) =>
  test(title, async ({ page, context, baseURL }) => {
    const s = await start(page, context, baseURL, 'state');
    await run(page);
    await expectNoSeriousAxe(page);
    await finish(page, s);
  });

axeSpec('axe finds no serious or critical issue: map view with the station panel open', async (page) => {
  await open(page, '/?s=nl.e2e.dst');
  await mapReady(page);
  await expect(panelOf(page).getByRole('heading', { level: 2, name: 'E2E DST' })).toBeVisible();
  await expect(panelOf(page).locator('strong')).toHaveText('444');
  await expect(page.locator('.maplibregl-popup-content > span')).toHaveText('E2E DST');
});

// A tall viewport for the pages with the 300-row table: axe cannot decide the colour contrast of rows that the
// scroll area clips ("partially obscured"), and an undecided check proves nothing.
const TALL = { width: 1024, height: 20_000 };

axeSpec('axe finds no serious or critical issue: English table view', async (page) => {
  await page.setViewportSize(TALL);
  await open(page, '/en/', 'Timeline');
  await chooseView(page, 'table', 'en');
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.locator('table caption')).toContainText('Stations at');
});

axeSpec('axe finds no serious or critical issue: the page without WebGL2', async (page) => {
  await page.setViewportSize(TALL);
  await page.addInitScript(withoutWebGL2);
  await open(page, '/');
  await expect(page.getByRole('status').filter({ hasText: 'WebGL2' })).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
});

test('axe finds no serious or critical issue: the station panel next to the table', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize(TALL);
  await page.addInitScript(withoutWebGL2);
  await open(page, '/?s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2, name: 'E2E DST' })).toBeVisible();
  // As in the map view: the panel's value and chart are in before axe runs (expectNoSeriousAxe waits for both).
  await expect(panelOf(page).locator('strong')).toHaveText('444');
  // The table beside the panel wraps into rows taller than its scroll area, which axe cannot judge for contrast
  // (the page without a panel is checked whole above): the panel and the controls above the table are.
  await expectNoSeriousAxe(page, 'aside');
  await expectNoSeriousAxe(page, 'section:has(input[type="range"])');
  await finish(page, s);
});
