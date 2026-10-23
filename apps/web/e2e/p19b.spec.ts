import { expect, type Page, test } from '@playwright/test';
import { UNCOVERED_BOARDS } from '../src/features/pages/uncovered.gen.ts';
import {
  expectNoSeriousAxe,
  finish,
  type HookChart,
  msg,
  msgRx,
  open,
  panelOf,
  param,
  pickStation,
  settled,
  start,
  type W,
} from './helpers.ts';

// P19b (issue #67): the tide, lake and downstream sections of the station panel, the Method page's water boards and the
// About tagline, on Chromium, Firefox and WebKit over the e2e seed (apps/server/test/e2e/api.ts P19A and P19B blocks):
// the fixed clock NOW = 2026-10-26T12:00Z.
//   1  the tidal panel of nl.e2e.coast (search + Enter): the measured value, the astronomical tide, the derived surge, the
//      day's high and low waters (CET at NOW and NOW + 6 h, CEST on 24 October), the forecast surge (+150), the chart's
//      legend and series, the storm-surge link reached by Tab (no request to its host), axe on the panel;
//   2  the offshore MSL platform: its datum, no NAP, no tide section;
//   3  the lake panel: the reference gauge's state, the spread, the season's classes only, the wind note, the keyboard path
//      to the reference, the lake popup's button, a lake without a reference; axe on the panel;
//   4  the downstream chain of Lobith and Eijsden: the delta exits once, the IJssel branch to the IJsselmeer, text only;
//   5  the Method page: every water board without data and its gauges, the surge and lake sections; axe on the page;
//   6  the About tagline.

const COAST = 'nl.e2e.coast';
const PLATFORM = 'nl.e2e.platform';
const LAKE_GAUGE = 'nl.e2e.lake-gauge';
const LAKE_REF = 'nl.e2e.lake-ref';
const LAKE_NOREF = 'nl.e2e.lake-noref';
const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';
const EIJSDEN = 'nl.rws.eijsden.grens';
/** The past hour (24 October, CEST), now, and now + 6 h (the forecast; 26 October is CET, the clocks changed on the 25th). */
const PAST = '2026-10-24T12:00Z';
const NOW_T = '2026-10-26T12:00Z';
const AHEAD = '2026-10-26T18:00Z';
const WARNING_HOST = 'waterberichtgeving.rws.nl';
const WARNING_HREF = `https://${WARNING_HOST}/`;

type Locale = 'nl' | 'en';
const t =
  (locale: Locale) =>
  (key: string, args: Record<string, string | number> = {}) =>
    msg(locale, key, args);
const nl = t('nl');
const num = (n: number, locale: Locale = 'nl') =>
  new Intl.NumberFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { maximumFractionDigits: 2 }).format(n);

/** The tide section of the open panel. */
const tideOf = (page: Page) =>
  panelOf(page)
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: nl('tide_heading'), exact: true }) });
/** The `dd` after the `dt` that says `label`. */
const factOf = (section: ReturnType<typeof tideOf>, label: string) =>
  section.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
/** The cells of the high and low waters table, row by row. */
const extremeRows = (section: ReturnType<typeof tideOf>) =>
  section
    .getByRole('table')
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((r) => [...r.querySelectorAll('td')].map((c) => (c.textContent ?? '').replaceAll(/\s+/g, ' ').trim())),
    );

/** The coast's tide as the API says it at `at` (the snapshot's value up to now, its forecast after): the numbers the panel shows. */
async function coastTide(page: Page, at: string) {
  const stations = (await (await page.request.get('/api/v1/stations')).json()) as {
    stations: { id: string; series: { id: number }[] }[];
  };
  const series = stations.stations.find((s) => s.id === COAST)?.series[0]?.id;
  const snap = (await (await page.request.get(`/api/v1/snapshot?t=${at}`)).json()) as {
    values: { series: number; value: number; tide?: { astro: number | null; surge: number | null } }[];
    forecasts?: { series: number; value: number; tide?: { astro: number | null; surge: number | null } }[];
  };
  const item = [...snap.values, ...(snap.forecasts ?? [])].find((v) => v.series === series);
  if (item?.tide === undefined) throw new Error(`no tide of ${COAST} at ${at}`);
  return { value: item.value, ...item.tide };
}

/** Tab until the focused element satisfies `match`; a bound, so that a missing tab stop fails instead of hanging. */
async function tabTo(page: Page, match: (arg: string) => boolean, arg: string, what: string) {
  let tabs = 0;
  while (!(await page.evaluate(match, arg)) && tabs < 120) {
    await page.keyboard.press('Tab');
    tabs++;
  }
  expect(await page.evaluate(match, arg), `${what} is reachable by Tab (after ${tabs} presses)`).toBe(true);
}

/** The ids of the series of every chart of the page (the first is the observations). */
const chartSeriesIds = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const chart of (window as unknown as W).__rws?.charts ?? [])
      for (const s of (chart as HookChart).getOption()?.series ?? []) if (s.id !== undefined) out.push(s.id);
    return out;
  });

// ---------------------------------------------------------------- 1: the tidal panel

test('the tidal panel: measured, astronomical, derived surge, the day of high and low waters, the chart and the warning link', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  // By keyboard: the magnifier, the field, Enter on the first result; the panel's heading holds the focus.
  await pickStation(page, 'E2E coast');
  await expect.poll(() => param(page, 's')).toBe(COAST);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E coast');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  const tide = tideOf(page);
  await expect(tide).toBeVisible();
  await settled(page);

  // The measured value, the astronomical tide at its instant and the surge (80 cm), derived.
  const now = await coastTide(page, NOW_T);
  expect(now.surge).toBe(80);
  await expect(
    panelOf(page)
      .locator('p', { hasText: nl('panel_last_measurement') })
      .first()
      .locator('strong'),
  ).toHaveText(num(now.value));
  await expect(factOf(tide, nl('tide_astro'))).toHaveText(`${num(now.astro ?? Number.NaN)} cm NAP`);
  await expect(factOf(tide, nl('tide_surge'))).toHaveText('+80 cm');
  expect(nl('tide_surge')).toBe('Opzet (afgeleid)');
  await expect(tide).toContainText(msg('nl', 'tide_at_measurement', { time: '' }).trim());

  // The day's high and low waters: 26 October is CET. The measured and astronomical ones of the morning (from the raw
  // series), the next two astronomical ones (from the snapshot); the rows of 24 and 27 October are not in it.
  await expect(tide.getByRole('table').locator('caption')).toContainText(/26/);
  const morning = [
    ['04:05 CET', 'hoog', 'astronomisch', '205'],
    ['04:10 CET', 'hoog', 'gemeten', '212'],
    ['10:15 CET', 'laag', 'astronomisch', '-55'],
    ['10:25 CET', 'laag', 'gemeten', '-48'],
    ['16:30 CET', 'hoog', 'astronomisch', '210'],
    ['22:40 CET', 'laag', 'astronomisch', '-50'],
  ];
  expect([nl('tide_high'), nl('tide_low'), nl('tide_kind_astro'), nl('tide_kind_measured')]).toEqual([
    'hoog',
    'laag',
    'astronomisch',
    'gemeten',
  ]);
  await expect.poll(() => extremeRows(tide)).toEqual(morning);

  // The chart: the astronomical curve and the surge band are drawn, and the legend says so.
  await expect
    .poll(() => chartSeriesIds(page))
    .toEqual(expect.arrayContaining(['obs', 'astro', 'surge-up-base', 'surge-up']));
  expect((await chartSeriesIds(page))[0]).toBe('obs');
  await expect(panelOf(page).getByText(nl('tide_legend_astro'), { exact: true })).toBeVisible();
  await expect(panelOf(page).getByText(nl('tide_legend_surge_up'), { exact: true })).toBeVisible();

  // The official warning is a plain link, reached by Tab; nothing was requested from its host.
  const link = tide.locator(`a[href="${WARNING_HREF}"]`);
  await expect(link).toHaveText(nl('storm_surge_link'));
  await expect(link).toHaveAttribute('rel', /noopener/);
  await tabTo(
    page,
    (href) => (document.activeElement as HTMLAnchorElement | null)?.href === href,
    WARNING_HREF,
    'the link',
  );
  expect(s.log.requests.filter((u) => new URL(u).hostname === WARNING_HOST)).toEqual([]);

  await expectNoSeriousAxe(page, 'aside');
  await finish(page, s);
});

test('the tidal panel at now + 6 h shows the forecast surge (+150), and the day of 24 October its CEST labels', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${COAST}&t=${AHEAD}`);
  const tide = tideOf(page);
  await expect(tide).toBeVisible();
  const ahead = await coastTide(page, AHEAD);
  expect(ahead.surge).toBe(150);
  await expect(factOf(tide, nl('tide_surge_forecast'))).toHaveText('+150 cm');
  await expect(factOf(tide, nl('tide_astro'))).toHaveText(`${num(ahead.astro ?? Number.NaN)} cm NAP`);
  await expect(tide).toContainText(msg('nl', 'tide_at_forecast', { time: '' }).trim().replace(/,$/, ''));
  // The same CET day, from the raw series (the morning) and the forecast's astronomical ones: 03:50Z on the 27th is not in it.
  await expect
    .poll(() => extremeRows(tide))
    .toEqual([
      ['04:05 CET', 'hoog', 'astronomisch', '205'],
      ['04:10 CET', 'hoog', 'gemeten', '212'],
      ['10:15 CET', 'laag', 'astronomisch', '-55'],
      ['10:25 CET', 'laag', 'gemeten', '-48'],
      ['16:30 CET', 'hoog', 'astronomisch', '210'],
      ['22:40 CET', 'laag', 'astronomisch', '-50'],
    ]);

  // The past hour is a CEST day: the labels change, the 22:10Z astronomical high (00:10 on the 25th) is not in the table.
  await open(page, `/?s=${COAST}&t=${PAST}`);
  await expect(factOf(tideOf(page), nl('tide_surge'))).toHaveText('-60 cm');
  await expect
    .poll(() => extremeRows(tideOf(page)))
    .toEqual([
      ['05:20 CEST', 'laag', 'astronomisch', '-58'],
      ['05:30 CEST', 'laag', 'gemeten', '-45'],
      ['11:30 CEST', 'hoog', 'astronomisch', '190'],
      ['11:40 CEST', 'hoog', 'gemeten', '198'],
      ['17:45 CEST', 'laag', 'astronomisch', '-60'],
      ['17:55 CEST', 'laag', 'gemeten', '-52'],
    ]);
  await finish(page, s);
});

// ---------------------------------------------------------------- 2: the offshore platform

test('the offshore MSL platform shows its datum, no NAP conversion and no tide section', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await pickStation(page, 'E2E platform');
  await expect.poll(() => param(page, 's')).toBe(PLATFORM);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E platform');
  await settled(page);
  const value = panelOf(page)
    .locator('p', { hasText: nl('panel_last_measurement') })
    .first();
  await expect(value).toContainText('cm MSL');
  await expect(value).not.toContainText('NAP');
  await expect(panelOf(page).getByText(/cm NAP/)).toHaveCount(0);
  // No astronomical tide, so no surge: the tide section does not exist.
  await expect(panelOf(page).getByRole('heading', { level: 3, name: nl('tide_heading'), exact: true })).toHaveCount(0);
  await expect(panelOf(page).getByText(nl('tide_surge'))).toHaveCount(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- 3: the lake panel

type Pt = [number, number];
interface LakeMap {
  getCanvas(): HTMLCanvasElement;
  jumpTo(o: { center: Pt; zoom: number }): void;
  queryRenderedFeatures(g?: Pt | [Pt, Pt], o?: { layers?: string[] }): { id?: string | number }[];
}
const lakeMap = (page: Page) =>
  page.waitForFunction(() => (window as unknown as { __rws?: { map: LakeMap } }).__rws?.map);

/** A viewport point inside the lake `id` that the lake popup can be opened from (as p19a.spec.ts): null while tiles load. */
const lakePoint = (page: Page, id: string) =>
  page.evaluate((id) => {
    const map = (window as unknown as { __rws: { map: LakeMap } }).__rws.map;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const mid = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = 8; y < canvas.clientHeight - 8; y += 8)
      for (let x = 8; x < canvas.clientWidth - 8; x += 8) {
        if (!map.queryRenderedFeatures([x, y], { layers: ['water-lakes'] }).some((f) => String(f.id) === id)) continue;
        const box: [Pt, Pt] = [
          [x - 7, y - 7],
          [x + 7, y + 7],
        ];
        if (map.queryRenderedFeatures(box, { layers: ['stations', 'rivers'] }).length > 0) continue;
        if (document.elementFromPoint(rect.left + x, rect.top + y) !== canvas) continue;
        const d = (x - mid.x) ** 2 + (y - mid.y) ** 2;
        if (best === null || d < best.d) best = { x: rect.left + x, y: rect.top + y, d };
      }
    return best === null ? null : { x: best.x, y: best.y };
  }, id);

/** The lake section of the open panel, by its water body's name. */
const lakeOf = (page: Page, name: string) =>
  panelOf(page)
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) });

test('the lake panel: the reference gauge decides, the spread, only the season, the wind note; the keyboard reaches the reference', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await pickStation(page, 'E2E lake gauge');
  await expect.poll(() => param(page, 's')).toBe(LAKE_GAUGE);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E lake gauge');
  const lake = lakeOf(page, 'IJsselmeer');
  await expect(lake).toBeVisible();
  await settled(page);

  // The reference gauge is "verhoogd" (elevated), although this gauge itself is "hoog" (high): D27.
  const reference = lake.locator('p', { hasText: nl('lake_reference_label') });
  await expect(reference.getByRole('button', { name: 'E2E lake ref', exact: true })).toBeVisible();
  await expect(reference.locator('strong')).toHaveText(nl('state_elevated'));
  await expect(reference).not.toHaveText(/\bhoog\b/);
  // The spread is information, not a state.
  await expect(lake.getByText(msgRx('nl', 'lake_spread'))).toBeVisible();
  // Only the classes of the season in force (1 October to 31 March): the winter class, not the summer one.
  await expect(lake.getByRole('heading', { level: 4, name: nl('lake_classes_heading'), exact: true })).toBeVisible();
  const classes = lake.locator('ul').filter({ hasText: 'Waterinfo' }).locator('> li');
  await expect(classes).toHaveCount(1);
  await expect(classes.first()).toContainText('Licht verhoogd');
  await expect(classes.first()).toContainText(nl('lake_class_range', { from: '0', to: num(1000) }));
  await expect(classes.first()).toContainText(nl('lake_class_season', { from: '1 oktober', to: '31 maart' }));
  await expect(lake).not.toContainText('Hoogwater');
  await expect(lake).not.toContainText(nl('lake_class_season', { from: '1 april', to: '30 september' }));
  await expect(lake.getByText(nl('lake_wind_setup'), { exact: true })).toBeVisible();

  // The keyboard: Tab to the reference button, Enter opens its panel, the heading holds the focus.
  await tabTo(
    page,
    (name) => {
      const el = document.activeElement;
      return (
        el?.tagName === 'BUTTON' &&
        el.textContent === name &&
        el.closest('section')?.querySelector('h3')?.textContent === 'IJsselmeer'
      );
    },
    'E2E lake ref',
    'the reference button',
  );
  await page.keyboard.press('Enter');
  await expect.poll(() => param(page, 's')).toBe(LAKE_REF);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E lake ref');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  // On the reference's own panel it is "this station" (no button) and the class is the same.
  await expect(lakeOf(page, 'IJsselmeer')).toContainText(nl('lake_this_station'));

  await expectNoSeriousAxe(page, 'aside');
  await finish(page, s);
});

test("a lake without a reference says so; the lake popup's button opens a station panel of the lake", async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await page.locator('main').evaluate((main) => main.scrollIntoView({ block: 'end' }));
  await lakeMap(page);
  await page.evaluate(() =>
    (window as unknown as { __rws: { map: LakeMap } }).__rws.map.jumpTo({ center: [5.7, 52.4], zoom: 11 }),
  );
  let at: { x: number; y: number } | null = null;
  await expect
    .poll(async () => (at = await lakePoint(page, 'veluwemeer')), { message: 'a point inside veluwemeer' })
    .not.toBeNull();
  if (at === null) throw new Error('unreachable');
  const point: { x: number; y: number } = at;
  await page.mouse.click(point.x, point.y);
  const popup = page.locator('.maplibregl-popup-content');
  await expect(popup).toContainText(nl('lake_no_reference'));
  await popup.getByRole('button', { name: nl('lake_open'), exact: true }).click();
  // The Veluwemeer has no reference: the button opens its first station on the map.
  await expect.poll(() => param(page, 's')).toBe(LAKE_NOREF);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E lake noref');
  const lake = lakeOf(page, 'Veluwemeer');
  await expect(lake).toBeVisible();
  await expect(lake.getByText(nl('lake_no_reference'), { exact: true })).toBeVisible();
  expect(nl('lake_no_reference')).toBe('Geen referentiepunt voor dit meer');
  await finish(page, s);
});

// ---------------------------------------------------------------- 4: the downstream chain

/** The downstream section of the open panel. */
const downstreamOf = (page: Page) =>
  panelOf(page)
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: nl('downstream_heading'), exact: true }) });

/** Opens every collapsed branch (the child arms are `<details>`), nested ones too. */
async function openBranches(section: ReturnType<typeof downstreamOf>) {
  const closed = section.locator('details:not([open]) > summary');
  for (let i = 0; i < 12 && (await closed.count()) > 0; i++) await closed.first().click();
  await expect(closed).toHaveCount(0);
}

const exits = ['Nieuwe Waterweg → Noordzee', 'Haringvliet → Noordzee'];

test('Lobith: the delta exits once, the IJssel branch runs to the IJsselmeer and the Waddenzee, a row opens its station', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${LOBITH}`);
  const section = downstreamOf(page);
  await expect(section).toBeVisible();
  await openBranches(section);
  for (const line of exits) await expect(section.getByText(line)).toHaveCount(1);
  await expect(section.getByText(nl('downstream_delta'), { exact: true })).toHaveCount(1);
  for (const line of ['IJssel → Ketelmeer', 'Ketelmeer → IJsselmeer', 'IJsselmeer → Waddenzee'])
    await expect(section.getByText(line), line).toHaveCount(1);
  await expect(section.getByText(nl('downstream_note'), { exact: true })).toBeVisible();
  // Every label is text: no image anywhere in the section.
  await expect(section.locator('img')).toHaveCount(0);

  // A row is a button that opens its station; the panel's heading names it and holds the focus.
  const row = section.locator('li > button').first();
  const name = (await row.locator('span').first().textContent()) ?? '';
  expect(name).not.toBe('');
  await row.click();
  await expect.poll(() => param(page, 's')).not.toBe(LOBITH);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText(name);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  await finish(page, s);
});

test('Eijsden: both delta exits of the tidal zone, once each', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${EIJSDEN}`);
  const section = downstreamOf(page);
  await expect(section).toBeVisible();
  await openBranches(section);
  for (const line of exits) await expect(section.getByText(line)).toHaveCount(1);
  await expect(section.locator('img')).toHaveCount(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- 5: the Method page

for (const locale of ['nl', 'en'] as const) {
  test(`the Method page lists every water board without data and its gauges, and the surge and lake sections (${locale.toUpperCase()})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    // A tall window: the tables scroll at 65 vh, and axe cannot decide the contrast of rows the frame clips.
    await page.setViewportSize({ width: 1024, height: 20_000 });
    await page.goto(locale === 'nl' ? '/methode' : '/en/method');
    const m = t(locale);
    const heading = (name: string) => page.getByRole('heading', { level: 2, name, exact: true });
    await expect(heading(locale === 'nl' ? 'Opzet (afgeleid)' : 'Surge (derived)')).toBeVisible();
    await expect(heading(locale === 'nl' ? 'Meren' : 'Lakes')).toBeVisible();
    const table = page.getByRole('table', { name: m('uncovered_caption') });
    await expect(table).toBeVisible();
    expect(UNCOVERED_BOARDS.length).toBeGreaterThan(0);
    await expect(table.locator('tbody tr')).toHaveCount(UNCOVERED_BOARDS.length);
    for (const board of UNCOVERED_BOARDS) {
      const row = table
        .locator('tbody tr')
        .filter({ has: page.getByRole('rowheader', { name: board.board, exact: true }) });
      await expect(row, board.board).toHaveCount(1);
      for (const gauge of board.gauges) {
        const link = row.getByRole('link', { name: gauge.name, exact: true });
        await expect(link, gauge.id).toHaveAttribute(
          'href',
          new RegExp(`[?&]s=${encodeURIComponent(gauge.id).replaceAll('.', '\\.')}$`),
        );
      }
    }
    // No owner source is named (the page is public).
    await expectNoSeriousAxe(page, undefined, false);
    await finish(page, s);
  });
}

// ---------------------------------------------------------------- 6: the About tagline

for (const locale of ['nl', 'en'] as const) {
  test(`the About page opens with the tagline (${locale.toUpperCase()})`, async ({ page, context, baseURL }) => {
    const s = await start(page, context, baseURL);
    await page.goto(locale === 'nl' ? '/over' : '/en/about');
    const tagline = msg(locale, 'intro');
    expect(tagline).toBe(
      locale === 'nl'
        ? 'Waterstanden van Nederland en de rivieren die het binnenstromen'
        : 'Water levels of the Netherlands and the rivers that flow into it',
    );
    await expect(page.locator('main p').first()).toContainText(`${tagline}.`);
    await finish(page, s);
  });
}
