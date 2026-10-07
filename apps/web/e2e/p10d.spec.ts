import { expect, type Page, test } from '@playwright/test';
import {
  expectInert,
  expectNoSeriousAxe,
  finish,
  mapReady,
  msg,
  open,
  panelOf,
  param,
  settled,
  slider,
  start,
  textHosts,
  timebarOf,
  type W,
  where,
} from './helpers.ts';

// P10d acceptance (issue #96, closes #88), the PUBLIC site on Chromium, Firefox and WebKit: the station panel, the map
// legend and the timebar after the waterinfo layout, against the e2e build under the production headers with the e2e api
// (a fixed clock: NOW, 2026-10-26T12:00Z) and the seeds of apps/server/test/e2e. The stations are E2E DST (a 444 cm
// level), E2E Gap and the hostile one (nl.e2e.xss, with an NL-4 class "Licht verhoogd" 100–1000 cm and its raw label).

const DST = 'nl.e2e.dst';
const GAP = 'nl.e2e.gap';
const HOSTILE = 'nl.e2e.xss';
const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';
const nl = (key: string, args: Record<string, string | number> = {}) => msg('nl', key, args);

test.beforeEach(async ({ page, browserName }) => {
  // WebKit must run without Temporal to prove the polyfill path (as in app.spec.ts).
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

/** The first chart's option, reduced to what the tests read. */
const chartOption = (page: Page) =>
  page.evaluate(() => {
    const option = [...((window as unknown as W).__rws?.charts ?? [])][0]?.getOption();
    const obs = option?.series?.[0];
    return {
      lines: (obs?.markLine?.data ?? []).map((d) => ({ name: d.name ?? '', x: d.xAxis ?? null, y: d.yAxis ?? null })),
      zones: obs?.markArea?.data?.length ?? 0,
    };
  });

const view = (page: Page) => panelOf(page).getByRole('group', { name: nl('panel_view_label') });
const period = (page: Page) => panelOf(page).getByRole('combobox', { name: nl('panel_range_label') });
const thresholds = (page: Page) => panelOf(page).getByRole('checkbox', { name: nl('thresholds_show') });

/** The reaches file as the stand-in serves it holds no stations: this one chains three e2e stations over two rivers. */
async function withReaches(page: Page) {
  const reach = (
    id: string,
    river: string,
    up: string | null,
    down: string | null,
    upstream: string[],
    downstream: string[],
  ) => ({
    id,
    river_id: river,
    seq: 1,
    up_station_id: up,
    down_station_id: down,
    length_km: 1,
    km_graph_from: 0,
    km_graph_to: 1,
    flags: { tidal: false, impounded: false, bifurcation: false },
    travel_time_h: null,
    travel_time_source: null,
    upstream,
    downstream,
  });
  const station = (id: string, river: string, reach_id: string, km: number) => ({
    id,
    river_id: river,
    reach_id,
    km_official: km,
    km_official_system: null,
    km_graph: km,
    km_to_nl_entry: null,
    nl_entry_node: null,
  });
  await page.route('**/data/v1/rivers/reaches-*.json', async (route) => {
    // Uncompressed: Caddy serves the precompressed .zst to Firefox, and route.fetch() does not decode zstd.
    const res = await route.fetch({ headers: { ...route.request().headers(), 'accept-encoding': 'identity' } });
    const body = (await res.json()) as Record<string, unknown>;
    // Rhine: DST → Gap, which forks into the Waal where the hostile station is.
    body.stations = [
      station(DST, 'rhine', 'rhine.2', 1),
      station(GAP, 'rhine', 'rhine.3', 2),
      station(HOSTILE, 'waal', 'waal.2', 3),
    ];
    body.reaches = [
      reach('rhine.1', 'rhine', null, DST, [], ['rhine.2']),
      reach('rhine.2', 'rhine', DST, GAP, ['rhine.1'], ['rhine.3']),
      reach('rhine.3', 'rhine', GAP, null, ['rhine.2'], ['waal.1']),
      reach('waal.1', 'waal', null, HOSTILE, ['rhine.3'], ['waal.2']),
      reach('waal.2', 'waal', HOSTILE, null, ['waal.1'], []),
    ];
    await route.fulfill({ response: res, json: body });
  });
}

// ---------------------------------------------------------------- the station panel

test('the panel: header, last measurement, controls and the Reeksen legend', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${DST}`);
  await settled(page);
  const panel = panelOf(page);

  // The header: the name as published, one h2, and the close button.
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(panel.getByRole('heading', { level: 2 })).toHaveCount(1);
  await expect(panel.getByRole('button', { name: nl('panel_close') })).toBeVisible();

  // The last measurement: the bare number is the only <strong> of the series.
  const level = panel.getByRole('region', { name: nl('quantity_H') });
  await expect(level.locator('strong')).toHaveText('444');
  await expect(level.locator('p', { hasText: nl('panel_last_measurement') })).toHaveText(
    new RegExp(`^${nl('panel_last_measurement')}: 444 cm NAP op .+ CET$`),
  );

  // The controls: Grafiek is on, 7 days, thresholds shown.
  await expect(view(page).getByRole('radio', { name: nl('panel_view_chart'), exact: true })).toBeChecked();
  await expect(view(page).getByRole('radio', { name: nl('panel_view_table'), exact: true })).not.toBeChecked();
  await expect(period(page)).toHaveValue('7');
  await expect(period(page).locator('option')).toHaveText([2, 7, 14].map((days) => nl('panel_range_days', { days })));
  await expect(thresholds(page)).toBeChecked();

  // The Reeksen legend names the lines; the chart has a solid "nu" line named by the same word.
  const series = level.getByRole('heading', { level: 4, name: nl('legend_series_heading') }).locator('..');
  await expect(series.getByRole('listitem').filter({ hasText: nl('chart_observed') })).toHaveCount(1);
  await expect(series.getByRole('listitem').filter({ hasText: new RegExp(`^${nl('now_marker')}$`) })).toHaveCount(1);
  expect((await chartOption(page)).lines.map((l) => l.name)).toContain(nl('now_marker'));
  await expect(panel.getByRole('img', { name: /7 dagen/ })).toBeVisible();

  // No threshold: the legend says so, in words.
  await expect(level.getByText(nl('thresholds_none'), { exact: true })).toBeVisible();
  await expectNoSeriousAxe(page, 'aside');
  await finish(page, s);
});

test('thresholds: zones and lines follow the checkbox, the legend lists them, the raw label stays text', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${HOSTILE}`);
  await settled(page);
  const panel = panelOf(page);

  // The seeded NL-4 class "Licht verhoogd" (100–1000 cm) is one zone with two lines; `ours` text, then the raw label.
  const box = panel.getByRole('heading', { level: 4, name: nl('legend_thresholds_heading') }).locator('..');
  const item = box.getByRole('listitem');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Licht verhoogd');
  await expect(item).toContainText(/100–1[.,]?000 cm NAP/);
  await expect(item).toContainText('onerror=alert(3)');
  // the NL-4 note: display classes, never a warning
  await expect(box.getByText(nl('basis_nl4'), { exact: true })).toBeVisible();

  await expect.poll(async () => (await chartOption(page)).zones).toBe(1);
  const on = await chartOption(page);
  expect(on.lines.filter((l) => l.y !== null)).toHaveLength(2);

  await thresholds(page).uncheck();
  await expect.poll(async () => (await chartOption(page)).zones).toBe(0);
  expect((await chartOption(page)).lines.filter((l) => l.y !== null)).toEqual([]);
  // the legend stays: it names what exists, the box only draws it
  await expect(item).toHaveCount(1);
  await thresholds(page).check();
  await expect.poll(async () => (await chartOption(page)).zones).toBe(1);

  // The raw label is only ever a text node (the hosts of the string: the panel's basis row, the popup line and the
  // legend row).
  await mapReady(page);
  await expect(page.locator('.maplibregl-popup-content > p')).toHaveCount(1);
  expect(await textHosts(page, 'onerror=alert(3)')).toEqual(['dd', 'p', 'span']);
  await expectInert(page, s);
  await finish(page, s);
});

test('Tabel: a paged table of the chart’s points, a pager by keyboard, and back to the chart', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // (the hostile station has a measurement every ten minutes: well over 100 rows)
  await open(page, `/?s=${HOSTILE}`);
  await settled(page);
  const panel = panelOf(page);

  await view(page)
    .getByRole('radio', { name: nl('panel_view_table'), exact: true })
    .check();
  const table = panel.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.locator('caption')).toHaveText(nl('series_table_caption', { quantity: nl('quantity_H') }));
  await expect(panel.getByRole('img')).toHaveCount(0);
  await expect(table.locator('tbody tr')).toHaveCount(100);
  await expect(table.locator('thead th')).toContainText([nl('series_table_time'), nl('series_table_measured')]);

  // the pager: the status is aria-live (never role=status while the map works), Latere is off on the first page
  const status = panel.locator('span[aria-live="polite"]');
  await expect(status).toHaveText(/^Rijen 1–100 van \d+$/);
  await expect(panel.getByRole('status')).toHaveCount(0);
  const later = panel.getByRole('button', { name: nl('series_table_later'), exact: true });
  const earlier = panel.getByRole('button', { name: nl('series_table_earlier'), exact: true });
  await expect(later).toBeDisabled();
  await earlier.focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(/^Rijen 101–\d+ van \d+$/);
  await expect(later).toBeEnabled();
  await later.focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText(/^Rijen 1–100 van \d+$/);

  // no scroll wrapper: a clipped table cannot be judged by axe
  expect(await table.evaluate((el) => el.parentElement?.scrollHeight === el.parentElement?.clientHeight)).toBe(true);
  await expectNoSeriousAxe(page, 'aside', false);

  await view(page)
    .getByRole('radio', { name: nl('panel_view_chart'), exact: true })
    .check();
  await expect(panel.getByRole('img', { name: /7 dagen/ })).toBeVisible();
  await settled(page);
  await expectNoSeriousAxe(page, 'aside');
  await finish(page, s);
});

test('the period select sets the chart’s span (2, 7 and 14 days)', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${DST}`);
  await settled(page);
  for (const days of [14, 2, 7]) {
    await period(page).selectOption(String(days));
    await expect(panelOf(page).getByRole('img', { name: new RegExp(`\\(${days} dagen\\)`) })).toBeVisible();
  }
  // panel state only: the URL has no new key
  expect([...new URL(page.url()).searchParams.keys()].sort()).toEqual(['s']);
  await finish(page, s);
});

test('Nabij gelegen metingen: the nearest station up and down the river, across a fork, and a click opens it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await withReaches(page);
  await open(page, `/?s=${GAP}`);
  await settled(page);
  const near = panelOf(page).getByRole('region', { name: nl('neighbours_heading') });
  const rows = near.getByRole('button');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(nl('neighbour_upstream'));
  await expect(rows.nth(0)).toContainText('E2E DST');
  // the downstream neighbour is on another river after the fork: its row names it
  await expect(rows.nth(1)).toContainText(
    nl('neighbour_river', { direction: nl('neighbour_downstream'), river: 'Waal' }),
  );
  // the value of the neighbour at t comes from the snapshot already loaded: its quantity and a number, or the words
  await expect(rows.nth(0)).toContainText(/Waterstand: \d/);

  await rows.nth(0).click();
  await expect.poll(() => param(page, 's')).toBe(DST);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  // the first station of the chain has no upstream neighbour: one row only
  await settled(page);
  const first = panelOf(page)
    .getByRole('region', { name: nl('neighbours_heading') })
    .getByRole('button');
  await expect(first).toHaveCount(1);
  await expect(first).toContainText(nl('neighbour_downstream'));

  // a station the reaches file does not place has no block at all
  await page.goto(`/?s=${LOBITH}`);
  await expect(slider(page)).toBeVisible();
  await settled(page);
  await expect(panelOf(page).getByRole('region', { name: nl('neighbours_heading') })).toHaveCount(0);

  // a hostile neighbour name is text, never markup
  await page.goto(`/?s=${GAP}`);
  await expect(slider(page)).toBeVisible();
  await settled(page);
  await expectInert(page, s);
  expect(await textHosts(page, 'onerror=alert(1)')).toContain('span');
  await finish(page, s);
});

// ---------------------------------------------------------------- the map legend

test('the legend sits in the bottom-right corner of the map, above the attribution button, and collapses', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await mapReady(page);
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: nl('legend_heading') }) });
  const map = page.locator('.maplibregl-map');
  await expect(details).toHaveAttribute('open', '');

  const box = async (l: ReturnType<Page['locator']>) => {
    const b = await l.boundingBox();
    if (b === null) throw new Error('no box');
    return b;
  };
  await page.evaluate(() => window.scrollTo(0, 0));
  const m = await box(map);
  const d = await box(details);
  expect(d.x).toBeGreaterThan(m.x);
  expect(d.x + d.width).toBeLessThanOrEqual(m.x + m.width);
  expect(m.x + m.width - (d.x + d.width)).toBeLessThan(40);
  expect(d.y + d.height).toBeLessThan(m.y + m.height);
  expect(d.y).toBeGreaterThanOrEqual(m.y);
  // the attribution button stays free and clickable
  const attribution = page.locator('.maplibregl-ctrl-attrib-button');
  await attribution.click({ timeout: 5_000 });

  // Enter on the summary collapses it
  const summary = details.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await expectNoSeriousAxe(page, undefined, false);
  await finish(page, s);
});

test('in the table view the legend is in the flow above the table', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await mapReady(page);
  await page.getByRole('button', { name: nl('view_table'), exact: true }).click();
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: nl('legend_heading') }) });
  await expect(details).toBeVisible();
  expect(await details.evaluate((el) => getComputedStyle(el).position)).toBe('static');
  const table = page.locator('table').first();
  const d = await details.boundingBox();
  const t = await table.boundingBox();
  expect((d?.y ?? 0) + (d?.height ?? 0)).toBeLessThanOrEqual(t?.y ?? 0);
  await finish(page, s);
});

// ---------------------------------------------------------------- the timebar

test('the timebar is docked below the map, steps back to the first day and stops there', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-08-24T00:10Z');
  await page.locator('main').evaluate((main) => main.scrollIntoView({ block: 'end' }));
  await expect(page.locator('.maplibregl-map')).toBeVisible();
  const bar = timebarOf(page);
  // at the end of the page the bar is where the DOM puts it: after the map
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const map = await page.locator('.maplibregl-map').boundingBox();
  const b = await bar.boundingBox();
  expect((b?.y ?? 0) + 1).toBeGreaterThanOrEqual((map?.y ?? 0) + (map?.height ?? 0));
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');

  const back = page.getByRole('button', { name: nl('step_back'), exact: true });
  await back.focus();
  await back.click();
  await expect.poll(() => param(page, 't')).toBe('2026-08-24T00:00Z');
  // at the first day the button is aria-disabled, does nothing and keeps the focus
  await expect(back).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(back).toBeFocused();
  expect(param(page, 't')).toBe('2026-08-24T00:00Z');
  await finish(page, s);
});

test('reverse play steps ten minutes back a second and stops at the first day; forward play stops at the end', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-08-24T00:20Z');
  const rewind = page.getByRole('button', { name: nl('play_reverse'), exact: true });
  const pause = page.getByRole('button', { name: nl('pause'), exact: true });
  const play = page.getByRole('button', { name: nl('play'), exact: true });

  await rewind.click();
  // one button names "Pauzeren" at a time, and it is the one that was pressed (its DOM identity is kept)
  await expect(pause).toHaveCount(1);
  await expect(pause).toBeFocused();
  await expect(rewind).toHaveCount(0);
  await expect.poll(() => param(page, 't'), { timeout: 10_000 }).toBe('2026-08-24T00:00Z');
  // it stops by itself at the first day
  await expect(page.getByRole('button', { name: nl('play_reverse'), exact: true })).toBeVisible();
  await expect(pause).toHaveCount(0);

  // forward: from 47.5 hours after now, play reaches the end of the forecast and stops
  await page.goto('/?t=2026-10-28T11:40Z');
  await expect(slider(page)).toBeVisible();
  await play.click();
  await expect(pause).toBeFocused();
  const end = await slider(page).getAttribute('max');
  await expect.poll(() => slider(page).inputValue(), { timeout: 15_000 }).toBe(end);
  await expect(play).toBeVisible();
  await finish(page, s);
});

test('under reduced motion both play buttons are off', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/?t=2026-10-26T11:00Z');
  await expect(page.getByRole('button', { name: nl('play'), exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: nl('play_reverse'), exact: true })).toBeDisabled();
  await finish(page, s);
});

test('the bar never hides the focused control and axe finds nothing on it', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await page.setViewportSize({ width: 1024, height: 400 });
  await open(page, `/?s=${DST}`);
  await settled(page);
  // a control far down the panel, focused by the keyboard, is scrolled clear of the sticky bar (WCAG 2.4.11)
  const last = panelOf(page).getByRole('checkbox', { name: nl('thresholds_show') });
  await last.focus();
  const bar = await timebarOf(page).boundingBox();
  const control = await last.boundingBox();
  expect((control?.y ?? 0) + (control?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1);
  expect(where(page)).toContain(`s=${DST}`);
  await page.setViewportSize({ width: 1024, height: 20_000 });
  await expectNoSeriousAxe(page, 'section:has(input[type="range"])');
  await finish(page, s);
});
