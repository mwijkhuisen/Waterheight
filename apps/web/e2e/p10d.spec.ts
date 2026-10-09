import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  attributionButton,
  chooseView,
  expandTimebar,
  expectHovLayout,
  expectInert,
  expectNoSeriousAxe,
  finish,
  hovReady,
  hovRegion,
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
const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (b === null) throw new Error('no box');
  return b;
};
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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

  // An earlier t: the axis ends before now, so there is no now line and no key for it; the selected time has both
  // (review round 1).
  const earlier = '2026-10-25T00:30Z';
  await open(page, `/?t=${earlier}&s=${DST}`);
  await settled(page);
  await expect(series.getByRole('listitem').filter({ hasText: nl('chart_selected_time') })).toHaveCount(1);
  await expect(series.getByRole('listitem').filter({ hasText: new RegExp(`^${nl('now_marker')}$`) })).toHaveCount(0);
  const lines = (await chartOption(page)).lines;
  expect(lines.map((l) => l.name)).not.toContain(nl('now_marker'));
  expect(lines.map((l) => l.x)).toContain(Date.parse(earlier));
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

test('the legend starts collapsed; open, it sits in the bottom-right corner of the map, above the attribution button', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await mapReady(page);
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: nl('legend_heading') }) });
  const map = page.locator('.maplibregl-map');
  // collapsed at the start, also on a desktop (owner, KG-251); Enter on the summary opens it
  await expect(details).not.toHaveAttribute('open', '');
  const summary = details.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');

  await page.evaluate(() => window.scrollTo(0, 0));
  const m = await box(map);
  const d = await box(details);
  expect(d.x).toBeGreaterThan(m.x);
  expect(d.x + d.width).toBeLessThanOrEqual(m.x + m.width);
  expect(m.x + m.width - (d.x + d.width)).toBeLessThan(40);
  expect(d.y + d.height).toBeLessThan(m.y + m.height);
  expect(d.y).toBeGreaterThanOrEqual(m.y);
  // P10e: it stands above the "Bronnen" button and the timebar, never over them
  const sources = await box(attributionButton(page));
  const bar = await box(timebarOf(page));
  expect(d.y + d.height).toBeLessThanOrEqual(sources.y + 1);
  expect(d.y + d.height).toBeLessThanOrEqual(bar.y + 1);
  expect(overlaps(d, sources)).toBe(false);
  expect(overlaps(d, bar)).toBe(false);
  // the attribution button stays free and clickable
  const attribution = page.locator('.maplibregl-ctrl-attrib-button');
  await attribution.click({ timeout: 5_000 });

  await expectNoSeriousAxe(page, undefined, false);
  // Enter on the summary collapses it again
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  await finish(page, s);
});

test('in the table view the legend floats in the bottom-right corner above the timebar, and the table keeps room below its rows', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await mapReady(page);
  const details = page.locator('details').filter({ has: page.locator('summary', { hasText: nl('legend_heading') }) });
  // opened on the map, it stays open in the table view: the same element moves (review round 1)
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await chooseView(page, 'table');
  await expect(details).toBeVisible();
  await expect(details).toHaveAttribute('open', '');
  // P10e: it is no longer in the flow above the table; it floats over the view, as on the map (the table fills the
  // window under the bar), in the bottom-right corner and above the timebar.
  const table = page.locator('table').first();
  const d = await box(details);
  expect(overlaps(d, await box(table)), 'the legend floats over the table, not above it in the flow').toBe(true);
  const bar = await box(timebarOf(page));
  const vp = page.viewportSize();
  expect(vp).not.toBeNull();
  expect((vp?.width ?? 0) - (d.x + d.width)).toBeLessThan(40);
  expect(d.y + d.height).toBeLessThanOrEqual(bar.y + 1);
  expect(overlaps(d, bar)).toBe(false);
  expect(d.y).toBeGreaterThanOrEqual((await box(page.getByRole('banner'))).height - 1);
  // The room below the rows (padding and scroll padding of the table wrapper): scrolled to its end, the last row's
  // button stands clear of the timebar, the "Bronnen" button and the (collapsed) legend.
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  const wrap = table.locator('..');
  await wrap.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const corner = [await box(details), await box(attributionButton(page)), await box(timebarOf(page))];
  const last = page.locator('table tbody th button').last();
  await last.focus();
  const lastBox = await box(last);
  for (const c of corner) expect(overlaps(lastBox, c), 'the last row is under a control').toBe(false);
  await finish(page, s);
});

// ---------------------------------------------------------------- the timebar

test('the timebar floats over the bottom centre of the map, steps back to the first day and stops there', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-08-24T00:10Z');
  await expect(page.locator('.maplibregl-map')).toBeVisible();
  const bar = timebarOf(page);
  // P10e: no longer docked below the map but over it, at the bottom centre; the page does not scroll
  const map = await box(page.locator('.maplibregl-map'));
  const b = await box(bar);
  expect(b.y).toBeGreaterThan(map.y);
  expect(b.y + b.height).toBeLessThanOrEqual(map.y + map.height + 1);
  expect(b.x + b.width / 2).toBeCloseTo(map.x + map.width / 2, -1);
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).not.toBe('static');
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);

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

test('reverse play steps an hour back at a time and stops at the start of the playback range; forward play stops at now', async ({
  page,
  context,
  baseURL,
}) => {
  // P11b: playback covers the last 14 days (2026-10-12T12:00Z to now) in the Δh and Q modes; the future stays on the slider.
  const s = await start(page, context, baseURL, 'dh');
  await open(page, '/?mode=delta&t=2026-10-12T15:30Z');
  await expandTimebar(page); // (P10e: reverse play is in the expanded timebar)
  const rewind = page.getByRole('button', { name: nl('play_reverse'), exact: true });
  const pause = page.getByRole('button', { name: nl('pause'), exact: true });
  const play = page.getByRole('button', { name: nl('play'), exact: true });

  await rewind.click();
  // one button names "Pauzeren" at a time, and it is the one that was pressed (its DOM identity is kept)
  await expect(pause).toHaveCount(1);
  await expect(pause).toBeFocused();
  await expect(rewind).toHaveCount(0);
  // it stops by itself at the first hour of the range
  await expect(page.getByRole('button', { name: nl('play_reverse'), exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(pause).toHaveCount(0);
  await expect.poll(() => param(page, 't')).toBe('2026-10-12T12:00Z');
  // there is nothing before it to play
  await expect(page.getByRole('button', { name: nl('play_reverse'), exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  // forward: from three hours before now, play reaches the last whole hour (now) and stops, back at the live view
  await page.goto('/?mode=delta&t=2026-10-26T09:00Z');
  await expect(slider(page)).toBeVisible();
  await play.click();
  await expect(pause).toBeFocused();
  await expect.poll(() => param(page, 't'), { timeout: 15_000 }).toBeNull();
  await expect(play).toBeVisible();
  expect(param(page, 'play')).toBeNull();
  await finish(page, s);
});

test('under reduced motion both play buttons are off', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'dh');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '/?mode=delta&t=2026-10-26T11:00Z');
  await expandTimebar(page);
  await expect(page.getByRole('button', { name: nl('play'), exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: nl('play_reverse'), exact: true })).toBeDisabled();
  await finish(page, s);
});

// P10e (WCAG 2.4.11): the bar is over the view at the bottom centre; whatever it covers must not take a focus. The
// drawer stands beside it from 48rem and the sheet ends above it below; the table's wrapper keeps room under its rows.
const timebarH = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--timebar-h'));

test('the bar never hides the focused control: --timebar-h follows its height; the drawer, the sheet and the table keep clear', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // The tallest bar: the forecast and epoch notes and the DST choice (review round 1), in a short window.
  await page.setViewportSize({ width: 1024, height: 560 });
  await open(page, `/?t=2026-10-25T00:30Z&s=${DST}`);
  await settled(page);
  // --timebar-h is the bar's real height, collapsed and expanded
  const bar = timebarOf(page);
  await expect.poll(() => timebarH(page)).toBe(`${Math.ceil((await box(bar)).height)}px`);
  const collapsed = (await box(bar)).height;
  await expandTimebar(page);
  await expect(bar.getByRole('group', { name: nl('repeated_hour_legend') })).toBeVisible();
  await expect.poll(() => timebarH(page)).toBe(`${Math.ceil((await box(bar)).height)}px`);
  expect((await box(bar)).height).toBeGreaterThan(collapsed);
  // the drawer's last control, focused by the keyboard, is not under the bar (the bar keeps beside the drawer)
  const last = panelOf(page).locator('a, button, input, select').last();
  await last.focus();
  const control = await box(last);
  expect(overlaps(control, await box(bar)), 'the drawer control is under the bar').toBe(false);
  expect(overlaps(await box(panelOf(page)), await box(bar)), 'the bar is over the drawer').toBe(false);
  expect(where(page)).toContain(`s=${DST}`);

  // below 48rem the drawer is a sheet that ends above the bar: its last control is clear of the bar as well (600 px
  // high: P11b's State-mode play hint, D-1, is one more line in this tallest bar; KG-280)
  await page.setViewportSize({ width: 400, height: 600 });
  await expect.poll(async () => (await box(panelOf(page))).width).toBeCloseTo(400, 0);
  // (the bar grows at this width and --timebar-h follows a frame later: focus again until the layout has settled)
  await expect
    .poll(
      async () => {
        await last.blur(); // (focusing the focused element would not scroll it into view)
        await last.focus();
        const sheet = await box(panelOf(page));
        const under = await box(bar);
        return sheet.y + sheet.height <= under.y + 1 && !overlaps(await box(last), under);
      },
      { message: 'the sheet ends above the bar and its last control is not under it' },
    )
    .toBe(true);

  // the table: the last row's button, focused, is scrolled clear of the bar, at both widths
  for (const [width, height] of [
    [1024, 560],
    [400, 560],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(slider(page)).toBeVisible();
    await chooseView(page, 'table');
    for (const expanded of [false, true]) {
      if (expanded) await expandTimebar(page);
      const lastRow = page.locator('table tbody th button').last();
      // (focus again until the bar's measured height has reached the scroll padding; a focused element would not scroll)
      await expect
        .poll(
          async () => {
            await lastRow.blur();
            await lastRow.focus();
            return overlaps(await box(lastRow), await box(timebarOf(page)));
          },
          { message: `${width}x${height}, expanded=${expanded}: the last row is under the bar` },
        )
        .toBe(false);
    }
  }

  await page.setViewportSize({ width: 1024, height: 20_000 });
  await page.goto(`/?t=2026-10-25T00:30Z&s=${DST}`);
  await expect(slider(page)).toBeVisible();
  await expandTimebar(page);
  await expectNoSeriousAxe(page, 'section:has(input[type="range"])');
  await finish(page, s);
});

// P11c (issue #26, C13): the open "Langs de rivier" panel, in the narrow and the short windows of the checks above: the
// bar (collapsed and expanded) covers neither its chart nor its table, the corner stands above it, and the station
// sheet or drawer ends above it.
test('the open Langs de rivier panel is clear of the timebar, the corner and the drawer, narrow and short', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // (the expanded bar of a 400 px window is about 440 px high, over most of a 600 px one: KG-280; only 1024x560 checks it)
  for (const [width, height, bars] of [
    [400, 600, [false]],
    [1024, 560, [false, true]],
  ] as const) {
    await page.setViewportSize({ width, height });
    await open(page, '/?t=2026-10-25T00:30Z&hov=rhine-waal');
    await hovReady(page, 'rhine-waal');
    await expectHovLayout(page, `${width}x${height}`, bars);
    // With a station open (the drawer beside the bar, the sheet below 48rem; the expanded bar over a 560 px window next to
    // a drawer is about 320 px high and reaches the chart's axis labels: not asserted).
    await open(page, `/?t=2026-10-25T00:30Z&hov=rhine-waal&s=${DST}`);
    await hovReady(page, 'rhine-waal');
    await expectHovLayout(page, `${width}x${height} with a station`, [false]);
    const drawer = await box(panelOf(page));
    expect(drawer.y + drawer.height, `${width}x${height}: the drawer ends above the panel`).toBeLessThanOrEqual(
      (await box(hovRegion(page))).y + 1,
    );
    expect(overlaps(drawer, await box(timebarOf(page))), `${width}x${height}: the drawer is under the bar`).toBe(false);
  }
  await finish(page, s);
});
