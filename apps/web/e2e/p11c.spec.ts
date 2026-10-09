import { expect, type Page, test } from '@playwright/test';
import { scanEta } from './eta-scan.ts';
import {
  hovAxisLabels as axisLabels,
  hovClose as closeButton,
  escapeRx,
  expectInert,
  expectNoSeriousAxe,
  finish,
  type HovW,
  hovDrawnText,
  reachKm as kmOf,
  mapReady,
  msg,
  msgRx,
  stationNames as namesOf,
  open,
  panelOf,
  param,
  hovPathSelect as pathSelect,
  pickStation,
  playHold,
  hovReady as ready,
  hovRegion as regionOf,
  hovSeries as seriesOf,
  settled,
  start,
  hovState as stateOf,
  hovTableToggle as tableToggle,
  textHosts,
  hovToggle as toggleOf,
  where,
  XSS,
  hovYLabels as yLabels,
} from './helpers.ts';

// P11c (issue #26): "Langs de rivier / Along the river", the space-time (Hovmöller) panel, on the PUBLIC site in Chromium,
// Firefox and WebKit against the e2e build under the production headers, the e2e api (fixed clock 2026-10-26T12:00Z) and
// the committed fixture river release (prepare-tiles.ts; the owner variant: owner-p11c.spec.ts).
//   KM   the km axis runs upstream to downstream as in the registry: the chart's columns, its axis labels and the table's
//        column headers are in the reaches file's km_to_nl_entry order, for every path (the P11c [CI] criterion);
//   GAP  the public Meuse has no station between Chooz and Eijsden: a gap band and a gap column say so;
//   CLICK a cell (chart or table) pauses, sets t to its hour and opens its station; the marker follows t and s without
//        rebuilding the cells; the URL restores the panel and its path, a bad `hov` is dropped;
//   DST  the repeated hour is two rows in the chart and in the table;
//   gates  the lazy chunk, the hostile name inert in the axis, the tooltip and the table, axe, the keyboard, the ETA scan,
//          0 CSP violations and same-origin requests (finish).
// The panel reads window.__rwsHov (the e2e build's hook; hovmoller/HovmollerPanel.tsx).

const nl = (key: string, args: Record<string, string | number> = {}) => msg('nl', key, args);
const T = '2026-10-25T12:00Z';
const XSS_ID = 'nl.e2e.xss';
const PATHS = ['rhine-waal', 'rhine-lek', 'rhine-ijssel', 'meuse'] as const;
type PathId = (typeof PATHS)[number];
const CHOOZ = 'fr.sandre.B720000001';
const EIJSDEN = 'nl.rws.eijsden.grens';
const KOELN = 'de.wsv.2730010';
const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';

const deep = (hov: PathId | null = 'rhine-waal', t = T, extra = '') =>
  `/?mode=delta&t=${t}${hov === null ? '' : `&hov=${hov}`}${extra}`;
const play = (page: Page) => page.getByRole('button', { name: nl('play'), exact: true });
const pause = (page: Page) => page.getByRole('button', { name: nl('pause'), exact: true });

/**
 * A whole-pixel point that lands on the cell of `id` at one row hour between `from` and `to` (ISO), and on no other row.
 * A row is under a pixel high (168 rows in about 150 px), the cells overlap by half a pixel and the one drawn later (the
 * row above, the later hour) wins the overlap; Firefox and WebKit put the pointer on whole pixels, so the point is
 * computed from the rows' own centres (the hook's pixels) as the topmost cell under it, and a row no whole pixel reaches
 * is skipped.
 */
const cellPoint = (page: Page, id: string, from: string, to: string) =>
  page.evaluate(
    ([id, from, to]) => {
      const h = (window as unknown as HovW).__rwsHov;
      const rows = h?.rows ?? [];
      const ys = rows.map((iso) => h?.pixelOf(id as string, iso)?.[1] ?? Number.NaN);
      const pitch = (ys[0] ?? 0) - (ys[1] ?? 0);
      // the cell rect is one row high plus half a pixel below its centre (hovmoller/chart.ts cellItem)
      const topmost = (p: number) => {
        for (let r = rows.length - 1; r >= 0; r--) {
          const y = ys[r] ?? Number.NaN;
          if (p >= y - pitch / 2 && p <= y + pitch / 2 + 0.5) return r;
        }
        return -1;
      };
      for (const [r, iso] of rows.entries()) {
        if (iso < (from as string) || iso > (to as string)) continue;
        const y = ys[r] ?? Number.NaN;
        const x = Math.round(h?.pixelOf(id as string, iso)?.[0] ?? Number.NaN);
        for (const p of [Math.round(y), Math.ceil(y), Math.floor(y)]) if (topmost(p) === r) return { iso, x, y: p };
      }
      return undefined;
    },
    [id, from, to],
  );
const DAY_FROM = '2026-10-25T09:00:00.000Z';
const DAY_TO = '2026-10-26T06:00:00.000Z';

/** Press Tab (or Shift+Tab) until the focused element satisfies `match`; a bound, so that a missing stop fails. */
async function tabTo(page: Page, match: (arg: string) => boolean, arg: string, what: string, back = false) {
  let tabs = 0;
  while (!(await page.evaluate(match, arg)) && tabs < 200) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    tabs++;
  }
  expect(await page.evaluate(match, arg), `${what} is reachable by the keyboard (after ${tabs} presses)`).toBe(true);
}

// ---------------------------------------------------------------- the lazy chunk, the toggle

test('the panel chunk is not requested until the toggle is pressed; the page stays clean with it open', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep(null));
  const chunks = () =>
    s.log.requests
      .map((u) => new URL(u).pathname)
      .filter((p) => /\/assets\/(HovmollerPanel-|installCanvasRenderer-)[^/]*\.js$/.test(p));
  const toggle = toggleOf(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(regionOf(page)).toHaveCount(0);
  await mapReady(page);
  expect(chunks(), 'neither the panel nor ECharts is loaded before the toggle').toEqual([]);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(param(page, 'hov')).toBe('rhine-waal');
  await ready(page, 'rhine-waal');
  expect(
    chunks().filter((p) => p.includes('HovmollerPanel-')),
    'the panel chunk, once',
  ).toHaveLength(1);
  expect(chunks().filter((p) => p.includes('installCanvasRenderer-')).length).toBeGreaterThanOrEqual(1);
  // The station panels' idle check still holds: the chart is not one of `__rws.charts`, the panel is not an `aside`.
  await settled(page);
  expect(
    await page.evaluate(() => (window as unknown as { __rws?: { charts: Set<unknown> } }).__rws?.charts.size),
  ).toBe(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // Every path and both views, then back: still the same origin, no CSP violation, no dialog.
  for (const path of PATHS) {
    await pathSelect(page).selectOption(path);
    await ready(page, path);
  }
  await tableToggle(page).click();
  await expect(regionOf(page).getByRole('table')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await toggle.click();
  await expect(regionOf(page)).toHaveCount(0);
  await expect.poll(() => param(page, 'hov')).toBeNull();
  await finish(page, s);
});

// ---------------------------------------------------------------- KM: the axis as in the registry

for (const path of PATHS) {
  test(`KM: ${path}: the columns run upstream to downstream in the registry's chainage order, in the chart and in the table`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL, 'dh');
    const [km, names] = [await kmOf(page), await namesOf(page)];
    await open(page, deep(path));
    await ready(page, path);
    const state = await stateOf(page);
    const columns = state?.columns ?? [];
    expect(columns.length, `${path} has columns`).toBeGreaterThan(5);
    // x = −km_to_nl_entry of the reaches file, strictly increasing (upstream left, downstream right).
    for (const c of columns) expect(c.x, `${c.id}'s x`).toBeCloseTo(-(km.get(c.id) ?? Number.NaN), 6);
    for (const [i, c] of columns.entries())
      if (i > 0) expect(c.x, `${c.id} after ${columns[i - 1]?.id}`).toBeGreaterThan(columns[i - 1]?.x ?? 0);
    // …which is the registry order: the same ids sorted by km_to_nl_entry, largest (most upstream) first.
    const ids = columns.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => (km.get(b) ?? 0) - (km.get(a) ?? 0)));
    // The path starts at its first station: Basel on the Rhine paths, Chooz on the Meuse; the Meuse ends at Lith.
    expect(ids[0]).toBe(path === 'meuse' ? CHOOZ : 'ch.bafu.2289');
    if (path === 'meuse') expect(ids.at(-1)).toMatch(/^nl\.rws\.lith\./);
    // The axis labels, left to right, are those stations' names in that order (nothing is drawn out of order).
    expect(
      await axisLabels(
        page,
        columns.map((c) => c.x),
      ),
    ).toEqual(ids.map((id) => names.get(id)));
    const ticks = await page.evaluate(
      () => (window as unknown as HovW).__rwsHov?.chart?.getOption().xAxis?.[0]?.axisLabel?.customValues ?? [],
    );
    expect(ticks).toEqual(columns.map((c) => c.x));

    // The table's column headers are the same stations in the same order (the gap column apart).
    await tableToggle(page).click();
    const table = regionOf(page).getByRole('table');
    await expect(table).toBeVisible();
    const heads = (await table.locator('thead th').allTextContents()).slice(1);
    const stationHeads = heads.filter((h) => h !== nl('hov_gap_wallonia') && !msgRx('nl', 'hov_gap_plain').test(h));
    expect(stationHeads).toEqual(ids.map((id) => names.get(id)));
    // Row order: newest first; a column of each row per station.
    await expect(table.locator('tbody tr').first().locator('th button')).toContainText('26 okt');
    await finish(page, s);
  });
}

// ---------------------------------------------------------------- GAP: the public Walloon Meuse

test('GAP: the public Meuse has a hatched gap band and a gap column between the French gauges and Eijsden', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  const names = await namesOf(page);
  await open(page, deep('meuse'));
  await ready(page, 'meuse');
  const columns = (await stateOf(page))?.columns ?? [];
  const eijsden = columns.findIndex((c) => c.id === EIJSDEN);
  expect(eijsden).toBeGreaterThan(0);
  const before = columns[eijsden - 1];
  // No SPW column on the public site: the only stations above Eijsden are the French ones.
  expect(columns.slice(0, eijsden).map((c) => c.id)).toEqual(['fr.sandre.B720000001', 'fr.sandre.B720000002']);
  // The band: one gap from the last French column to Eijsden, drawn with its message.
  const gaps = await seriesOf(page, 'gaps');
  expect(gaps, 'one gap band').toHaveLength(1);
  const [from, , to] = gaps?.[0] ?? [];
  expect(from).toBeGreaterThanOrEqual(before?.x ?? 0);
  expect(from).toBeLessThan((before?.x ?? 0) + 5);
  expect(to).toBeLessThanOrEqual(columns[eijsden]?.x ?? 0);
  expect(to).toBeGreaterThan((columns[eijsden]?.x ?? 0) - 5);
  await expect.poll(() => hovDrawnText(page)).toContain(nl('hov_gap_wallonia'));
  // The table: a gap column header with the same words, between the two stations, its cells empty.
  await tableToggle(page).click();
  const table = regionOf(page).getByRole('table');
  const heads = await table.locator('thead th').allTextContents();
  const gap = heads.indexOf(nl('hov_gap_wallonia'));
  expect(heads.filter((h) => h === nl('hov_gap_wallonia'))).toHaveLength(1);
  expect(heads[gap - 1]).toBe(names.get(before?.id ?? ''));
  expect(heads[gap + 1]).toBe(names.get(EIJSDEN));
  await expect(table.locator('thead th').nth(gap)).toHaveAttribute('scope', 'col');
  await expect(
    table
      .locator('tbody tr')
      .first()
      .locator('td')
      .nth(gap - 1),
  ).toBeEmpty();
  // The Rhine path has none of it.
  await tableToggle(page).click();
  await pathSelect(page).selectOption('rhine-waal');
  await ready(page, 'rhine-waal');
  expect(await seriesOf(page, 'gaps')).toHaveLength(0);
  expect(await hovDrawnText(page)).not.toContain(nl('hov_gap_wallonia'));
  await finish(page, s);
});

// ---------------------------------------------------------------- CLICK: chart and table set t and s

test('CLICK: a click on a cell of the chart pauses playback, moves t to that hour and opens that station', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await playHold(page);
  await open(page, deep('rhine-waal', '2026-10-25T06:00Z'));
  await ready(page, 'rhine-waal');
  await play(page).click();
  await expect(pause(page)).toBeVisible();
  const before = param(page, 't');
  const point = await cellPoint(page, KOELN, DAY_FROM, DAY_TO);
  expect(point, 'a cell of Koeln on the chart').toBeDefined();
  await page.mouse.click(point?.x ?? 0, point?.y ?? 0);
  // Paused, with that station open and its column outlined, and t on a row hour of the chart.
  await expect(play(page)).toBeVisible();
  await expect.poll(() => param(page, 't')).not.toBe(before);
  expect(param(page, 's')).toBe(KOELN);
  expect(param(page, 'hov')).toBe('rhine-waal');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText((await namesOf(page)).get(KOELN) ?? '?');
  const state = await stateOf(page);
  const rows = state?.rows ?? [];
  const got = rows.indexOf(`${param(page, 't')?.slice(0, 16)}:00.000Z`);
  expect(got, 't is a row hour of the chart').toBeGreaterThanOrEqual(0);
  // Chromium puts the pointer where the point says: exactly the hour of the cell. Firefox and WebKit round the pointer's
  // position inside the canvas to a whole pixel, and a row is under a pixel high: the hour is then the row or a neighbour.
  expect(Math.abs(got - rows.indexOf(point?.iso ?? ''))).toBeLessThanOrEqual(browserName === 'chromium' ? 0 : 1);
  const x = state?.columns.find((c) => c.id === KOELN)?.x;
  await expect
    .poll(() => seriesOf(page, 'marker'))
    .toEqual(
      expect.arrayContaining([
        [0, got],
        [1, x, expect.any(Number)],
      ]),
    );
  await finish(page, s);
});

test('CLICK: a column header and a row header of the table select the station and the hour', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  const names = await namesOf(page);
  await open(page, deep('rhine-waal', '2026-10-25T06:00Z'));
  await ready(page, 'rhine-waal');
  await tableToggle(page).click();
  const table = regionOf(page).getByRole('table');
  await expect(table.locator('caption')).toHaveText(nl('hov_caption', { path: nl('hov_path_rhine_waal') }));
  await expect(table.getByRole('columnheader').first()).toHaveText(nl('hov_col_time'));
  // A column button selects its station (its header says so by aria-pressed); the others are not pressed.
  const head = table.locator('thead th button').filter({ hasText: names.get(KOELN) ?? '?' });
  await expect(head).toHaveAttribute('aria-pressed', 'false');
  await head.click();
  expect(param(page, 's')).toBe(KOELN);
  await expect(head).toHaveAttribute('aria-pressed', 'true');
  await expect(table.locator('thead th button[aria-pressed="true"]')).toHaveCount(1);
  // A row button pauses and moves t to its hour; the row of t's hour is marked aria-current="time".
  await expect(table.locator('tbody th button[aria-current="time"]')).toHaveCount(1);
  const row = table.locator('tbody th button').filter({ hasText: /26 okt\.?,? 0?9:00 CET/ });
  await row.click();
  await expect.poll(() => param(page, 't')).toBe('2026-10-26T08:00Z');
  await expect(row).toHaveAttribute('aria-current', 'time');
  await expect(table.locator('tbody th button[aria-current="time"]')).toHaveCount(1);
  await expect(play(page)).toBeVisible();
  // A cell says its change in words, with the sign and the unit; a cell with nothing says so.
  const cells = await table.locator('tbody td').allTextContents();
  expect(cells.filter((c) => /^[+−]?\d+ (cm|m³\/s)$/.test(c)).length, 'some cells have a change').toBeGreaterThan(0);
  expect(cells.filter((c) => c === nl('hov_no_data')).length, 'some cells have none').toBeGreaterThan(0);
  expect(cells.filter((c) => c !== '' && !/^[+−]?\d+ (cm|m³\/s)$/.test(c) && c !== nl('hov_no_data'))).toEqual([]);
  await finish(page, s);
});

// ---------------------------------------------------------------- selection: map and panel agree

test('the selected station is outlined in its column, from the URL and from the search, and in the table', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  const names = await namesOf(page);
  await open(page, deep('rhine-waal', T, `&s=${KOELN}`));
  await ready(page, 'rhine-waal');
  const xOf = async (id: string) => (await stateOf(page))?.columns.find((c) => c.id === id)?.x;
  const markedColumn = async () => ((await seriesOf(page, 'marker')) ?? []).filter((d) => d[0] === 1).map((d) => d[1]);
  await expect.poll(markedColumn).toEqual([await xOf(KOELN)]);
  // Another station through the page's own search: the outline moves.
  const lobith = names.get(LOBITH) ?? '?';
  await pickStation(page, lobith, new RegExp(escapeRx(lobith)));
  await expect.poll(() => param(page, 's')).toBe(LOBITH);
  await expect.poll(markedColumn).toEqual([await xOf(LOBITH)]);
  // The table agrees (the chart is replaced by it).
  await tableToggle(page).click();
  const pressed = regionOf(page).locator('thead th button[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toHaveText(lobith);
  // A station of another path is no column of this one: nothing is outlined.
  await pathSelect(page).selectOption('meuse');
  await expect(regionOf(page).locator('thead th button[aria-pressed="true"]')).toHaveCount(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- the URL

test('URL: ?hov= restores the panel and its path, closing drops it, a bad value is ignored and never kept', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep('meuse'));
  await ready(page, 'meuse');
  await expect(pathSelect(page)).toHaveValue('meuse');
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'true');
  // The select writes the URL; a reload restores it (path, panel and the page's own t).
  await pathSelect(page).selectOption('rhine-lek');
  await expect.poll(() => param(page, 'hov')).toBe('rhine-lek');
  await ready(page, 'rhine-lek');
  await page.reload();
  await expect(regionOf(page)).toBeVisible();
  await expect(pathSelect(page)).toHaveValue('rhine-lek');
  await ready(page, 'rhine-lek');
  expect(param(page, 't')).toBe(T);
  // Closing removes the key and the panel; the toggle has the focus.
  await closeButton(page).click();
  await expect(regionOf(page)).toHaveCount(0);
  await expect.poll(() => param(page, 'hov')).toBeNull();
  await expect(toggleOf(page)).toBeFocused();
  expect(where(page)).not.toContain('hov');

  // An unknown path: no panel, the toggle is off, and opening it writes a valid key in its place.
  await page.goto(deep(null, T, '&hov=nonsense'));
  await expect(toggleOf(page)).toBeVisible();
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(regionOf(page)).toHaveCount(0);
  await toggleOf(page).click();
  await expect.poll(() => param(page, 'hov')).toBe('rhine-waal');
  await ready(page, 'rhine-waal');
  // The Meuse chip opens the Meuse path.
  await open(page, '/?mode=delta&river=meuse');
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  await toggleOf(page).click();
  await ready(page, 'meuse');
  expect(param(page, 'hov')).toBe('meuse');
  await finish(page, s);
});

// ---------------------------------------------------------------- DST

test('DST: the repeated hour of 2026-10-25 is two rows, 02:00 CEST and 02:00 CET, in the chart and in the table', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep('rhine-waal', '2026-10-25T00:30Z'));
  await ready(page, 'rhine-waal');
  const rows = (await stateOf(page))?.rows ?? [];
  const [cest, cet] = [rows.indexOf('2026-10-25T00:00:00.000Z'), rows.indexOf('2026-10-25T01:00:00.000Z')];
  expect(cest).toBeGreaterThan(0);
  expect(cet).toBe(cest + 1);
  const labels = await yLabels(page);
  expect(labels).toHaveLength(rows.length);
  expect(labels[cest]).toMatch(/^25 okt\.?,? 02:00 CEST$/);
  expect(labels[cet]).toMatch(/^25 okt\.?,? 02:00 CET$/);
  expect(
    labels.filter((l) => /^25 .*02:00 CES?T$/.test(l)),
    'exactly two 02:00 rows on the 25th',
  ).toHaveLength(2);
  // The marker is on the first of them (t is 00:30Z: the CEST row).
  expect(await seriesOf(page, 'marker')).toEqual([[0, cest]]);
  // The table has both as row headers; t's hour (CEST) is the current one.
  await tableToggle(page).click();
  const buttons = regionOf(page).locator('tbody th button');
  await expect(buttons.filter({ hasText: /^25 okt\.?,? 02:00 CEST$/ })).toHaveCount(1);
  await expect(buttons.filter({ hasText: /^25 okt\.?,? 02:00 CET$/ })).toHaveCount(1);
  await expect(regionOf(page).locator('tbody th button[aria-current="time"]')).toHaveText(/02:00 CEST$/);
  // Clicking the CET row moves t one hour on (01:00Z, not 00:00Z again).
  await buttons.filter({ hasText: /^25 okt\.?,? 02:00 CET$/ }).click();
  await expect.poll(() => param(page, 't')).toBe('2026-10-25T01:00Z');
  await expect(regionOf(page).locator('tbody th button[aria-current="time"]')).toHaveText(/02:00 CET$/);
  await finish(page, s);
});

// ---------------------------------------------------------------- the marker follows t, the cells stay

test('the t marker moves with the hour and with playback while the cells are not rebuilt', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep('rhine-waal'));
  await ready(page, 'rhine-waal');
  const rows = (await stateOf(page))?.rows ?? [];
  const row = (iso: string) => rows.indexOf(`${iso}:00.000Z`);
  expect(await seriesOf(page, 'marker')).toEqual([[0, row('2026-10-25T12:00')]]);
  // Count the chart's full rebuilds (`notMerge`: the cells' own option) and its small marker updates from here on.
  await page.evaluate(() => {
    const chart = (window as unknown as HovW).__rwsHov?.chart;
    if (!chart) throw new Error('no chart');
    const counts = { full: 0, mark: 0 };
    (window as unknown as { __hovSets: typeof counts }).__hovSets = counts;
    const set = chart.setOption.bind(chart);
    chart.setOption = (option: unknown, opts?: unknown) => {
      if ((opts as { notMerge?: boolean } | undefined)?.notMerge) counts.full++;
      else counts.mark++;
      return set(option, opts);
    };
  });
  const sets = () =>
    page.evaluate(() => (window as unknown as { __hovSets: { full: number; mark: number } }).__hovSets);
  await page.getByRole('button', { name: nl('step_forward'), exact: true }).click();
  await expect.poll(() => param(page, 't')).toBe('2026-10-25T13:00Z');
  await expect.poll(() => seriesOf(page, 'marker')).toEqual([[0, row('2026-10-25T13:00')]]);
  expect((await sets()).mark).toBeGreaterThanOrEqual(1);
  // Playing: the marker runs on, the cells are the same ones.
  await play(page).click();
  await expect
    .poll(async () => ((await seriesOf(page, 'marker')) ?? [])[0]?.[1] ?? 0, { timeout: 60_000 })
    .toBeGreaterThan(row('2026-10-25T13:00') + 1);
  await pause(page).click();
  expect((await sets()).full, 'the cells were never rebuilt by a step or a play').toBe(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- XSS

test('the hostile station name is only ever text: in the axis, the tooltip and the table', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep('rhine-waal'));
  await ready(page, 'rhine-waal');
  const columns = (await stateOf(page))?.columns ?? [];
  const x = columns.find((c) => c.id === XSS_ID)?.x;
  expect(x, 'the hostile station is a column of the Rhine path (prepare-tiles.ts gives it a km)').toBeDefined();
  // The axis: the formatter's text is the string itself, drawn on the canvas (truncated there).
  expect(await axisLabels(page, [x ?? 0])).toEqual([XSS]);
  expect((await hovDrawnText(page)).some((t) => t.startsWith('<img src=x'))).toBe(true);
  // The tooltip (richText, drawn on the canvas as well): hover the station's cell.
  const point = await cellPoint(page, XSS_ID, DAY_FROM, DAY_TO);
  await page.mouse.move(point?.x ?? 0, point?.y ?? 0, { steps: 4 });
  // (the tooltip's lines are drawn one by one; the axis label is cut short, so the whole name is the tooltip's)
  await expect.poll(async () => (await hovDrawnText(page)).includes(XSS)).toBe(true);
  const option = await page.evaluate(
    () => (window as unknown as HovW).__rwsHov?.chart?.getOption().tooltip?.[0]?.renderMode,
  );
  expect(option).toBe('richText');
  await expectInert(page, s);
  // The table: the name is a text node of a button, never an element.
  await tableToggle(page).click();
  const hosts = await textHosts(page, XSS);
  expect(hosts).toContain('button');
  expect(hosts.filter((h) => h === 'img' || h === 'svg' || h === 'script')).toEqual([]);
  await expect(regionOf(page).locator('thead th button').filter({ hasText: XSS })).toHaveText(XSS);
  await expect(regionOf(page).locator('img, svg[onload], [onerror], [onload]')).toHaveCount(0);
  await expectInert(page, s);
  await finish(page, s);
});

// ---------------------------------------------------------------- accessibility and the keyboard

test('axe finds no serious issue in the panel, as a chart and as a table', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep('rhine-waal'));
  await ready(page, 'rhine-waal');
  const scope = `section[aria-label="${nl('hov_region')}"]`;
  await expectNoSeriousAxe(page, scope);
  await tableToggle(page).click();
  await expect(regionOf(page).getByRole('table')).toBeVisible();
  await expectNoSeriousAxe(page, scope);
  await finish(page, s);
});

test('axe finds no serious issue on the whole page with the panel open, chart and table', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep('rhine-waal'));
  await ready(page, 'rhine-waal');
  await expectNoSeriousAxe(page);
  await tableToggle(page).click();
  await expect(regionOf(page).getByRole('table')).toBeVisible();
  await expectNoSeriousAxe(page);
  await finish(page, s);
});

test('the keyboard: toggle, path, table, a row, a column and close, in order, and the focus returns to the toggle', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, deep(null));
  const toggle = toggleOf(page);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await ready(page, 'rhine-waal');
  // The path select, then (the disabled State is no stop) the table toggle, then close.
  await pathSelect(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => param(page, 'hov')).toBe('rhine-lek');
  await ready(page, 'rhine-lek');
  await expect(pathSelect(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tableToggle(page)).toBeFocused();
  await expect(regionOf(page).getByRole('button', { name: nl('mode_state'), exact: true })).toBeDisabled();
  await page.keyboard.press('Space');
  await expect(tableToggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(regionOf(page).getByRole('table')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(closeButton(page)).toBeFocused();
  // On to the table: the column buttons first, then the row buttons.
  await tabTo(page, () => !!document.activeElement?.closest('tbody th'), '', 'a row button');
  const t0 = param(page, 't');
  await page.keyboard.press('Enter');
  await expect.poll(() => param(page, 't')).not.toBe(t0);
  await expect(play(page)).toBeVisible();
  await tabTo(page, () => !!document.activeElement?.closest('thead th'), '', 'a column button', true);
  await page.keyboard.press('Enter');
  await expect.poll(() => param(page, 's')).not.toBeNull();
  // The station drawer took the focus; Tab on reaches the panel's close button again, and Enter closes the panel.
  const label = nl('hov_close');
  await tabTo(page, (l) => document.activeElement?.getAttribute('aria-label') === l, label, 'the close button');
  await page.keyboard.press('Enter');
  await expect(regionOf(page)).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect.poll(() => param(page, 'hov')).toBeNull();
  await finish(page, s);
});

// ---------------------------------------------------------------- the ETA scan (P11a C1), over the panel too

for (const locale of ['nl', 'en'] as const) {
  test(`the ETA scan finds nothing in the panel's text or its table (${locale.toUpperCase()})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL, 'dh');
    await open(
      page,
      `${locale === 'nl' ? '/' : '/en/'}?mode=delta&t=${T}&hov=meuse`,
      locale === 'nl' ? undefined : 'Timeline',
    );
    await ready(page, 'meuse', locale);
    const region = regionOf(page, locale);
    /** Every text the panel carries: its text nodes' hosts, and the accessible names (aria-label, title). */
    const items = async (where: string) =>
      region.evaluate((el, where) => {
        const texts = [...el.querySelectorAll('*')].flatMap((e) => [
          ...[...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue ?? ''),
          e.getAttribute('aria-label') ?? '',
          e.getAttribute('title') ?? '',
        ]);
        return [...texts, el.getAttribute('aria-label') ?? '']
          .filter((t) => t.trim() !== '')
          .map((text, i) => ({ where: `${where} ${i}`, text }));
      }, where);
    const chartItems = await items('chart view');
    expect(chartItems.length).toBeGreaterThan(5);
    expect(scanEta(chartItems)).toEqual([]);
    await tableToggle(page, locale).click();
    await expect(region.getByRole('table')).toBeVisible();
    const tableItems = await items('table view');
    expect(tableItems.length).toBeGreaterThan(chartItems.length);
    expect(scanEta(tableItems)).toEqual([]);
    // Everything the chart draws (axis, gap) too.
    await tableToggle(page, locale).click();
    await ready(page, 'meuse', locale);
    const drawn = (await hovDrawnText(page)).map((text, i) => ({ where: `drawn ${i}`, text }));
    expect(drawn.length).toBeGreaterThan(5);
    expect(scanEta(drawn)).toEqual([]);
    // The scan can fail: an arrival time in any of them is found (the negative controls).
    expect(scanEta([{ where: 'control', text: `${tableItems[0]?.text} ETA 14:00` }])).not.toEqual([]);
    expect(scanEta([{ where: 'control', text: 'Aankomst Lixhe' }])).not.toEqual([]);
    await finish(page, s);
  });
}
