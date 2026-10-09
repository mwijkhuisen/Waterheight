import { expect, type Page, test } from '@playwright/test';
import {
  chooseMode,
  chooseView,
  drawnText,
  expandTimebar,
  expectInert,
  expectNoSeriousAxe,
  featureState,
  finish,
  mapReady,
  modeRadio,
  modeSummary,
  msg,
  msgRx,
  NOW,
  open,
  panelOf,
  param,
  pickStation,
  searchBox,
  searchButton,
  settled,
  slider,
  start,
  textHosts,
  timebarTime,
  viewSummary,
  type W,
  where,
  XSS,
} from './helpers.ts';

// P10a acceptance (issue #25), the PUBLIC site on Chromium, Firefox and WebKit, against the e2e build under the production
// headers with the e2e api behind it (a fixed clock: NOW) and the seeds of apps/server/test/e2e/public-seed.ts:
//   fr.sandre.D015850001   FR-1, gauge zero IGN69 (never a NAP height), in FR-5 section AP1 (a section state);
//   de.wsv.23300130        DE-1 (Rhine, Basel), LHP class HE:3 and the DE-6 areas e2e-4 (German name with the XSS string), e2e-2;
//   e2e-river              a DE-6 river alert (LineString); e2e-ended valid 2026-10-25 06:00-18:00Z, only in its dated file.
// Mode switching, the legend, forecasts labelled, time-aware warnings, deep links, the French station, the keyboard, axe,
// the inert XSS fixture, the display-only series, live mode, the DST night, the attribution and the river layers.
// (The default mode comes from status.json: the e2e publisher states "dh", i.e. the change mode.)

const DE = 'de.wsv.23300130';
const FR = 'fr.sandre.D015850001';
const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';
const HOUR = 3_600_000;
const at = (hours: number) => `${new Date(NOW.getTime() + hours * HOUR).toISOString().slice(0, 16)}Z`;
type Locale = 'nl' | 'en';

test.beforeEach(async ({ page, browserName }) => {
  // WebKit must run without Temporal to prove the polyfill path (as in app.spec.ts).
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

// ---------------------------------------------------------------- helpers

const radio = (page: Page, locale: Locale, mode: 'state' | 'delta' | 'q') =>
  page.getByRole('radio', { name: msg(locale, `mode_${mode}`), exact: true });
const legend = (page: Page, locale: Locale) =>
  page.locator('details').filter({ has: page.locator('summary', { hasText: msg(locale, 'legend_heading') }) });
const circleColour = (page: Page) =>
  page.evaluate(() =>
    JSON.stringify((window as unknown as W).__rws?.map?.getPaintProperty('stations', 'circle-color')),
  );

/** The highlight layer's filter, or null while the layer is not on the map yet. */
const highlightFilter = (page: Page) =>
  page.evaluate(() => {
    try {
      return (window as unknown as W).__rws?.map?.getFilter('rivers-highlight') ?? null;
    } catch {
      return null;
    }
  });

/** The reaches file as the stand-in serves it holds no river: this one names two (a catalogue one, a hostile one). */
async function withRivers(page: Page) {
  await page.route('**/data/v1/rivers/reaches-*.json', async (route) => {
    // Uncompressed: Caddy serves the precompressed .zst to Firefox, and route.fetch() does not decode zstd.
    const res = await route.fetch({ headers: { ...route.request().headers(), 'accept-encoding': 'identity' } });
    const body = (await res.json()) as { rivers: unknown[] };
    body.rivers = [
      { id: 'ems', name_nl: 'Eems', name_en: 'Ems', parent_river_id: null, km_direction: 'downstream' },
      { id: 'e2e-xss-river', name_nl: XSS, name_en: XSS, parent_river_id: null, km_direction: 'none' },
    ];
    await route.fulfill({ response: res, json: body });
  });
}

/** The `area` of every warning feature the map holds at the current t (jumps over Basel so its tiles are loaded). */
async function warningAreas(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const map = (window as unknown as W).__rws?.map;
    if (!map) throw new Error('no map');
    const idle = new Promise<void>((r) => map.once('idle', r));
    map.jumpTo({ center: [7.4, 47.6], zoom: 7 });
    await idle;
    return [...new Set(map.querySourceFeatures('warnings').map((f) => String(f.properties.area)))].sort();
  });
}

/** Tab until `match` holds for the focused element (a bound, so a missing tab stop fails instead of hanging). */
async function tabTo(page: Page, match: () => boolean, what: string, key = 'Tab') {
  let tabs = 0;
  while (!(await page.evaluate(match)) && tabs < 60) {
    await page.keyboard.press(key);
    tabs++;
  }
  expect(await page.evaluate(match), `${what} is reachable by Tab (after ${tabs} presses)`).toBe(true);
}

// ---------------------------------------------------------------- the map mode

test('the mode radios set ?mode=, the marker paint and the table column', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, '/');
  await mapReady(page);

  // status.json says "dh": the default is the change mode, and the URL stays clean until the user chooses.
  await expect(await modeRadio(page, 'delta')).toBeChecked();
  expect(param(page, 'mode')).toBeNull();
  await expect.poll(() => circleColour(page)).toContain('dhBin');
  expect(await circleColour(page)).not.toContain('qSize');
  // The record every table, popup and panel reads: all keys always present; Lobith has a discharge series (934 m³/s).
  expect(await featureState(page, LOBITH)).toMatchObject({ has: true, qSize: 3, owner: false });
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true, qSize: null, owner: false });
  expect(await featureState(page, FR)).toMatchObject({ level: 3, section: true });

  await chooseMode(page, 'state', 'nl');
  await expect.poll(() => param(page, 'mode')).toBe('state');
  await expect.poll(() => circleColour(page)).toContain('"level"');
  expect(await circleColour(page)).not.toContain('dhBin');
  await chooseMode(page, 'q', 'nl');
  await expect.poll(() => param(page, 'mode')).toBe('q');
  await expect.poll(() => circleColour(page)).toContain('qSize');
  expect(await circleColour(page)).not.toContain('dhBin');
  // The marker keeps its feature state across modes (only the paint changed).
  expect(await featureState(page, LOBITH)).toMatchObject({ has: true, qSize: 3 });

  // The table's mode column follows (the station in the URL brings its page into view).
  await page.goto(`/?s=${LOBITH}&mode=q`);
  await expect(slider(page)).toBeVisible();
  await chooseView(page, 'table');
  const table = page.locator('table');
  await expect(table.locator('thead th').nth(4)).toHaveText(msg('nl', 'col_q'));
  const lobith = table
    .locator('tbody tr')
    .filter({ has: page.getByRole('button', { name: 'Lobith, Bovenrijn, Tolkamer', exact: true }) });
  await expect(lobith).toHaveCount(2); // its stage and its discharge
  await expect(lobith.locator('td:nth-child(5)')).toHaveText(['–', /^93\d([.,]\d+)? m³\/s$/]);
  await chooseMode(page, 'delta', 'nl');
  await expect(table.locator('thead th').nth(4)).toHaveText(msg('nl', 'col_dh'));
  await expect(lobith.locator('td:nth-child(5)')).toHaveText([/\d/, /\d/]);
  await chooseMode(page, 'state', 'nl');
  await expect(table.locator('thead th').nth(4)).toHaveText(msg('nl', 'col_state'));
  await expect(lobith.locator('td:nth-child(5)')).toHaveText([msg('nl', 'state_low'), msg('nl', 'state_low')]);
  await finish(page, s);
});

// ---------------------------------------------------------------- the legend

for (const locale of ['nl', 'en'] as const)
  test(`the legend and its honesty note follow the mode, in ${locale.toUpperCase()}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL, 'state');
    await open(page, locale === 'nl' ? '/' : '/en/', locale === 'nl' ? undefined : 'Timeline');
    await mapReady(page);
    const box = legend(page, locale);
    // collapsed at the start (P10d, KG-251): opened to read it
    await expect(box).not.toHaveAttribute('open', '');
    await box.locator('summary').click();
    await expect(box).toHaveAttribute('open', '');
    const text = box.locator('li, p');
    // State mode: the six states, and the two notes that are always there (the honesty note and the NL-4 disclaimer).
    for (const state of ['low', 'normal', 'elevated', 'high', 'extreme', 'no_ref'])
      await expect(box.getByText(msg(locale, `state_${state}`), { exact: true })).toBeVisible();
    await expect(box.getByText(msg(locale, 'legend_honesty'), { exact: true })).toBeVisible();
    await expect(box.getByText(msg(locale, 'basis_nl4'), { exact: true })).toBeVisible();
    // The keys for the other cues; the warnings key shows while an area is on the map (NOW: three).
    for (const key of ['legend_stale', 'legend_tidal', 'legend_impounded', 'legend_section'])
      await expect(box.getByText(msg(locale, key), { exact: true })).toBeVisible();
    await expect(box.getByText(msg(locale, 'legend_warnings'), { exact: true })).toBeVisible();
    await expect(box.getByText(msg(locale, 'legend_lhp2'), { exact: true })).toBeVisible();
    await expect(box.getByText(msg(locale, 'legend_owner'), { exact: false })).toHaveCount(0);

    // Change mode: the seven bins in words; discharge mode: the four size classes and "no discharge".
    await chooseMode(page, 'delta', locale);
    for (const bin of ['fall_strong', 'fall', 'fall_slight', 'steady', 'rise_slight', 'rise', 'rise_strong'])
      await expect(box.getByText(msg(locale, `dh_${bin}`), { exact: true })).toBeVisible();
    await expect(box.getByText(msg(locale, 'state_low'), { exact: true })).toHaveCount(0);
    await chooseMode(page, 'q', locale);
    for (const item of [
      msg(locale, 'legend_q_lt', { v: 10 }),
      msg(locale, 'legend_q_range', { lo: 10, hi: 100 }),
      msg(locale, 'legend_q_range', { lo: 100, hi: 1000 }),
      msg(locale, 'legend_q_ge', { v: 1000 }),
      msg(locale, 'q_none'),
    ])
      await expect(box.getByText(item, { exact: true })).toBeVisible();
    expect(await text.count()).toBeGreaterThan(8);

    // Collapsible from the keyboard (a native <details>), and its state survives a mode change.
    await box.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(box).not.toHaveAttribute('open', '');
    await page.keyboard.press('Enter');
    await expect(box).toHaveAttribute('open', '');

    // A t without areas (the data begins on 2026-10-24: no warning yet) has no warnings key; after now the forecast key.
    await page.goto(`${locale === 'nl' ? '/' : '/en/'}?t=2026-10-24T12:00Z&mode=state`);
    await expect(slider(page, locale === 'nl' ? undefined : 'Timeline')).toBeVisible();
    await expect(legend(page, locale).getByText(msg(locale, 'legend_warnings'), { exact: true })).toHaveCount(0);
    await page.goto(`${locale === 'nl' ? '/' : '/en/'}?t=${at(2)}&mode=state`);
    // a new page: the legend is collapsed again
    await legend(page, locale).locator('summary').click();
    await expect(legend(page, locale).getByText(msg(locale, 'legend_forecast'), { exact: true })).toBeVisible();
    await finish(page, s);
  });

// ---------------------------------------------------------------- forecasts, labelled

test('a forecast after now is labelled with its agency, its issue or fetch time and its estimate, where one is published', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // nl.e2e.xss: NL-1, issue time inferred (so "fetched"), estimate after its provider segment; nl.e2e.dst: stated issue time.
  await open(page, `/?t=${at(20)}&s=nl.e2e.xss`);
  await settled(page);
  const runs = () =>
    page.evaluate(() => {
      const option = [...((window as unknown as W).__rws?.charts ?? [])][0]?.getOption();
      return (option?.series ?? []).flatMap((x) =>
        x.id === 'median' || x.id === 'estimate' ? [{ id: x.id, name: x.name ?? '', points: x.data?.length ?? 0 }] : [],
      );
    });
  await expect.poll(async () => (await runs()).map((r) => r.id)).toEqual(['median', 'estimate']);
  const [median, estimate] = await runs();
  expect(median?.name).toMatch(msgRx('nl', 'chart_run_fetched', { agency: 'RWS' }));
  expect(estimate?.name).toMatch(/ \(schatting\)$/);
  await expect(panelOf(page).getByText(msg('nl', 'forecast_estimate_note'), { exact: true })).toBeVisible();
  // (P10d: the run's name sits in the Reeksen legend, beside its estimate part, instead of a paragraph under the chart)
  const keys = panelOf(page).locator('li', { hasText: /^RWS · opgehaald / });
  await expect(keys).toHaveCount(2);
  await expect(keys.filter({ hasText: /\(schatting\)$/ })).toHaveCount(1);

  await pickStation(page, 'E2E DST', /E2E DST/);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await settled(page);
  await expect
    .poll(async () => (await runs())[0]?.name ?? '')
    .toMatch(msgRx('nl', 'chart_run_issued', { agency: 'RWS' }));
  expect((await runs()).map((r) => r.id)).toEqual(['median', 'estimate']);
  expect((await runs())[1]?.points).toBe(0); // a run with no estimate part states none
  // The words in the panel too: "uitgegeven", never "opgehaald", for a stated issue time.
  await expect(panelOf(page).locator('dd', { hasText: /^RWS, uitgegeven / })).toBeVisible();

  // A station with no published run: no forecast series in its chart at all, whatever t.
  await page.goto('/?s=nl.e2e.gap');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E gap');
  await settled(page).catch(() => undefined);
  expect((await runs()).filter((r) => r.points > 0)).toEqual([]);
  await expect(page.getByText(msg('nl', 'forecast_estimate_note'), { exact: true })).toHaveCount(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- warnings follow t

test('warning areas follow t: an area shows between its from and its to, an earlier day shows from its dated file', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // At now (latest.geojson): the polygon of class 4, the hatched class 2 (issued the day before) and the river alert; the FR
  // section has no geometry, so it is on no map layer.
  await open(page, '/?mode=state');
  await mapReady(page);
  await expect.poll(() => warningAreas(page)).toEqual(['e2e-2', 'e2e-4', 'e2e-river']);
  const layers = await page.evaluate(() =>
    ((window as unknown as W).__rws?.map?.getStyle().layers ?? []).map((l) => String(l.id)),
  );
  expect(layers).toEqual(expect.arrayContaining(['warnings-fill', 'warnings-hatched', 'warnings-line', 'stations']));
  // under the stations: the markers are drawn over the areas
  expect(layers.indexOf('warnings-fill')).toBeLessThan(layers.indexOf('stations'));

  // 2026-10-25 08:00Z (a day that has ended, so its dated file): the hatched area and the one that ends at 18:00Z.
  await page.goto('/?t=2026-10-25T08:00Z&mode=state');
  await expect(slider(page)).toBeVisible();
  await mapReady(page);
  await expect.poll(() => warningAreas(page)).toEqual(['e2e-2', 'e2e-ended']);
  // 19:00Z the same day: the ended one is gone, the hatched one (open-ended) stays.
  await page.goto('/?t=2026-10-25T19:00Z&mode=state');
  await expect(slider(page)).toBeVisible();
  await mapReady(page);
  await expect.poll(() => warningAreas(page)).toEqual(['e2e-2']);
  // Exactly at its end the area is over (a range is half open).
  await page.goto('/?t=2026-10-25T18:00Z&mode=state');
  await expect(slider(page)).toBeVisible();
  await mapReady(page);
  await expect.poll(() => warningAreas(page)).toEqual(['e2e-2']);
  // No area before the first one began; the page says nothing of incomplete data for a day it has a file for.
  await page.goto('/?t=2026-10-24T12:00Z&mode=state');
  await expect(slider(page)).toBeVisible();
  await mapReady(page);
  await expect.poll(() => warningAreas(page)).toEqual([]);
  await expect(page.getByText(msg('nl', 'warnings_incomplete'), { exact: true })).toHaveCount(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- deep link

test('a deep link ?t&s&mode&river reproduces the view and the language switch keeps all four', async ({
  page,
  context,
  baseURL,
}) => {
  await withRivers(page);
  const s = await start(page, context, baseURL);
  const path = '/?t=2026-10-25T00:30Z&s=nl.e2e.dst&mode=q&river=ems';
  await open(page, path);
  await expect(slider(page)).toHaveValue(String(Date.parse('2026-10-25T00:30:00Z')));
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /02:30 CEST$/);
  // (P10e: the station <select> is gone; the panel heading below and the selected marker say which station is chosen)
  await expect(await modeRadio(page, 'q')).toBeChecked();
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(page.getByText(msg('nl', 'river_chip', { name: 'Eems' }), { exact: true })).toBeVisible();
  await expect.poll(() => featureState(page, 'nl.e2e.dst')).toMatchObject({ has: true, selected: true });
  expect(where(page)).toBe(path);

  // The river layers (C7): the vector layer `rivers` of the tile file's source-layer `rivers`, and the highlight
  // layer, whose filter is the chosen id.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__rws?.map?.getStyle().layers.some((l) => l.id === 'rivers')),
    )
    .toBe(true);
  const river = await page.evaluate(() => {
    const map = (window as unknown as W).__rws?.map;
    const layer = (id: string) => map?.getStyle().layers.find((l) => l.id === id);
    return {
      line: layer('rivers'),
      highlight: layer('rivers-highlight'),
      filter: map?.getFilter('rivers-highlight'),
      order: map?.getStyle().layers.map((l) => String(l.id)),
    };
  });
  expect(river.line).toMatchObject({ type: 'line', 'source-layer': 'rivers' });
  expect(river.highlight).toMatchObject({ type: 'line', 'source-layer': 'rivers' });
  expect(river.filter).toEqual(['==', ['get', 'river_id'], 'ems']);
  // beneath the warnings and the stations
  expect(river.order?.indexOf('rivers')).toBeLessThan(river.order?.indexOf('warnings-fill') ?? -1);

  // Both languages carry the whole view.
  await expect(page.getByRole('link', { name: 'English' })).toHaveAttribute(
    'href',
    '/en/?t=2026-10-25T00:30Z&s=nl.e2e.dst&mode=q&river=ems',
  );
  await page.getByRole('link', { name: 'English' }).click();
  await expect(slider(page, 'Timeline')).toHaveAttribute('aria-valuetext', /02:30 CEST$/);
  await expect(await modeRadio(page, 'q', 'en')).toBeChecked();
  await expect(page.getByText(msg('en', 'river_chip', { name: 'Ems' }), { exact: true })).toBeVisible();
  expect(where(page)).toBe('/en/?t=2026-10-25T00:30Z&s=nl.e2e.dst&mode=q&river=ems');

  // The chip clears the river: the URL loses it and the highlight matches nothing.
  await page.getByRole('button', { name: msg('en', 'river_clear') }).click();
  await expect.poll(() => where(page)).toBe('/en/?t=2026-10-25T00:30Z&s=nl.e2e.dst&mode=q');
  await expect.poll(() => highlightFilter(page)).toEqual(['==', ['get', 'river_id'], '']);

  // A river the list does not name is kept while the list loads and dropped once it has answered: no chip, no highlight.
  await page.goto('/?river=nope-river');
  await expect(slider(page)).toBeVisible();
  await mapReady(page);
  await expect(page.getByText(msg('nl', 'river_chip', { name: 'nope-river' }), { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: msg('nl', 'river_clear') })).toHaveCount(0);
  await expect.poll(() => highlightFilter(page)).toEqual(['==', ['get', 'river_id'], '']);
  await finish(page, s);
});

// ---------------------------------------------------------------- the French station

for (const locale of ['nl', 'en'] as const)
  test(`the French station: the unverified gauge zero, no NAP height, the section badge (${locale.toUpperCase()})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL, 'state');
    await open(page, `${locale === 'nl' ? '/' : '/en/'}?s=${FR}`, locale === 'nl' ? undefined : 'Timeline');
    await mapReady(page);
    const panel = panelOf(page);
    const level = panel.getByRole('region', { name: msg(locale, 'quantity_H') });
    const zero = msg(locale, 'height_zero', { m: locale === 'nl' ? '123,45' : '123.45', datum: 'IGN69' });
    await expect(level.locator('dd', { hasText: zero })).toHaveText(zero);
    await expect(level.locator('dt', { hasText: msg(locale, 'panel_height') })).toBeVisible();
    // IGN69 and NGF1884 are never converted: no "≈ … m NAP" anywhere on the page.
    expect(await page.locator('body').innerText()).not.toMatch(/≈/);
    await expect(panel.getByText(/m NAP/)).toHaveCount(0);
    // The state comes from the section (the area class), not from the gauge: the badge says so, in words.
    await expect(level.locator('strong').first()).toBeVisible();
    await expect(level.getByText(msg(locale, 'section_badge'), { exact: true }).first()).toBeVisible();
    await expect(level.locator('dd', { hasText: msg(locale, 'section_marker') })).toBeVisible();
    // The French area's name is raw beside our translation ("<raw> — <ours>"), as text.
    const ours = msg(locale, 'lbl_fr_5_section_2');
    await expect(level.locator('dd', { hasText: 'Sambre amont' }).first()).toContainText(
      msg(locale, 'label_translation', { raw: 'Vigicrues Sambre amont', ours }),
    );
    // The popup says it as well, and the marker carries the feature state.
    await expect(page.locator('.maplibregl-popup-content > p').last()).toContainText(msg(locale, 'section_badge'));
    expect(await featureState(page, FR)).toMatchObject({ section: true, level: 3, has: true });
    await finish(page, s);
  });

test('the German area name and the class of a gauge stay raw beside our translation', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, `/?s=${DE}`);
  await mapReady(page);
  const level = panelOf(page).getByRole('region', { name: msg('nl', 'quantity_H') });
  // The gauge's own class (LHP HE:3) is the basis of its state, as the provider named it.
  await expect(level.locator('dd', { hasText: 'LHP HE:3' })).toBeVisible();
  // The area: state, then the German name (hostile text) raw, then " — " and our Dutch name for LHP class 4.
  const area = level.locator('dd', { hasText: 'Hochwasserwarnung' });
  await expect(area).toHaveCount(1);
  await expect(area).toContainText(
    msg('nl', 'label_translation', { raw: `LHP Hochwasserwarnung ${XSS}`, ours: msg('nl', 'lbl_de_6_alert_4') }),
  );
  // (the German name is in the panel's rows, and the popup says the basis of the discharge state, which is the area;
  // P10e: the station list is gone, so no option holds the hostile station name any more)
  const hosts = await textHosts(page, 'onerror=alert(1)');
  expect(hosts).toContain('dd');
  expect(hosts.filter((h) => h !== 'dd' && h !== 'p')).toEqual([]);
  await expectInert(page, s);
  await finish(page, s);
});

// ---------------------------------------------------------------- the keyboard

test('the mode radios, the station search and the focus return work from the keyboard alone', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  await open(page, '/');
  await mapReady(page);

  // P10e: Tab to the mode disclosure's summary, Enter opens it; Tab to the radio group (the checked one is the tab
  // stop), and the arrow keys move and choose without closing it.
  await tabTo(
    page,
    () =>
      document.activeElement?.tagName === 'SUMMARY' && (document.activeElement.textContent ?? '').startsWith('Kaart:'),
    'the mode summary',
  );
  await expect(modeSummary(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await tabTo(
    page,
    () => document.activeElement instanceof HTMLInputElement && document.activeElement.name === 'map-mode',
    'the mode radios',
  );
  await expect(radio(page, 'nl', 'delta')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(radio(page, 'nl', 'q')).toBeChecked();
  await expect.poll(() => param(page, 'mode')).toBe('q');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(radio(page, 'nl', 'state')).toBeChecked();
  await expect.poll(() => param(page, 'mode')).toBe('state');
  await expect.poll(() => circleColour(page)).toContain('"level"');

  // Escape closes the disclosure and returns the focus to its summary.
  await page.keyboard.press('Escape');
  await expect(radio(page, 'nl', 'state')).toBeHidden();
  await expect(modeSummary(page)).toBeFocused();

  // The station search: the magnifier is reachable by Tab (backwards from the mode summary: the bar comes first), Enter
  // opens it, the arrow keys move through the results and Enter chooses a station (the focus goes to the panel).
  await tabTo(
    page,
    () =>
      document.activeElement?.getAttribute('aria-expanded') === 'false' &&
      document.activeElement.tagName === 'BUTTON' &&
      document.activeElement.getAttribute('aria-label') === 'Zoek een station',
    'the magnifier',
    'Shift+Tab',
  );
  await expect(searchButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.type('E2E');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => param(page, 's')).not.toBeNull();
  await expect(panelOf(page)).toHaveCount(1);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  await panelOf(page)
    .getByRole('button', { name: msg('nl', 'panel_close') })
    .focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => param(page, 's')).toBeNull();
  await expect(searchButton(page)).toBeFocused(); // a marker has no focus of its own: the magnifier it is

  // The table: Enter on a station button opens the panel (focus on its heading); Tab, Enter on "close" gives the focus
  // back to the button that opened it. (The view disclosure: its summary by Enter, then the "Tabel" button.)
  await viewSummary(page).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Tabel', exact: true }).focus();
  await page.keyboard.press('Enter');
  const opener = page.locator('table tbody th button').nth(1);
  await opener.focus();
  const station = (await opener.textContent()) ?? '';
  await page.keyboard.press('Enter');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toBeFocused();
  expect(await panelOf(page).getByRole('heading', { level: 2 }).textContent()).toBe(station);
  await page.keyboard.press('Tab');
  await expect(panelOf(page).getByRole('button', { name: msg('nl', 'panel_close') })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panelOf(page)).toHaveCount(0);
  await expect(page.locator('table tbody th button').nth(1)).toBeFocused();
  expect(await page.locator('table tbody th button').nth(1).textContent()).toBe(station);
  await finish(page, s);
});

// ---------------------------------------------------------------- axe

const AXE_VIEWS: [title: string, run: (page: Page) => Promise<void>, tall?: true][] = [
  [
    'the map with the legend open (change mode)',
    async (page) => {
      await open(page, '/');
      await mapReady(page);
      await legend(page, 'nl').locator('summary').click();
      await expect(legend(page, 'nl')).toHaveAttribute('open', '');
    },
  ],
  [
    'the map with the legend open (discharge mode, English)',
    async (page) => {
      await open(page, '/en/?mode=q', 'Timeline');
      await mapReady(page);
      await legend(page, 'en').locator('summary').click();
      await expect(legend(page, 'en')).toHaveAttribute('open', '');
    },
  ],
  [
    'the table (state mode)',
    async (page) => {
      await open(page, '/?mode=state');
      await chooseView(page, 'table');
      await expect(page.locator('table tbody tr')).toHaveCount(100);
    },
    true,
  ],
  [
    'the station panel with the 24-hour change next to the map',
    async (page) => {
      // (At the default 1024 px: the deep link centres the station in the part the drawer leaves free, so the popup's
      // close button is beside the drawer, P10e review round 1.)
      await open(page, `/?s=${DE}&mode=delta`);
      await mapReady(page);
      await expect(panelOf(page).getByRole('heading', { level: 2, name: 'RHEINWEILER' })).toBeVisible();
      await expect(panelOf(page).locator('strong').first()).toBeVisible();
    },
  ],
  [
    'the French station panel (section, unverified zero)',
    async (page) => {
      await open(page, `/en/?s=${FR}&mode=state`, 'Timeline');
      await mapReady(page);
      await expect(panelOf(page).getByText('IGN69')).toBeVisible();
    },
  ],
];
for (const [title, run, tall] of AXE_VIEWS)
  test(`axe finds no serious or critical issue: ${title}`, async ({ page, context, baseURL }) => {
    const s = await start(page, context, baseURL, 'dh');
    // A tall viewport for the table: axe cannot decide the colour contrast of rows that the scroll area clips.
    if (tall) await page.setViewportSize({ width: 1024, height: 12_000 });
    await run(page);
    await expectNoSeriousAxe(page);
    await finish(page, s);
  });

// ---------------------------------------------------------------- the XSS fixture

test('the hostile strings are inert wherever they show: map, table, panel, legend, river chip, chart', async ({
  page,
  context,
  baseURL,
}) => {
  await withRivers(page);
  const s = await start(page, context, baseURL, 'state');
  // The station (name, water, basis label), the river chip and the German area name, over the map...
  await open(page, `/?s=nl.e2e.xss&river=e2e-xss-river&t=${at(0)}`);
  await mapReady(page);
  await expect(page.getByText(msg('nl', 'river_chip', { name: XSS }), { exact: true })).toBeVisible();
  expect(await textHosts(page, 'onerror=alert(1)')).toEqual(expect.arrayContaining(['h2', 'span']));
  // (P10e: the hostile name is an option's text in the search's result list, nowhere else on top of the above)
  await searchButton(page).click();
  await searchBox(page).fill('onerror');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
  // (the option is a div[role=option] holding one text node: no element inside it)
  expect(await textHosts(page, 'onerror=alert(1)')).toEqual(expect.arrayContaining(['div', 'h2', 'span']));
  expect(
    await page
      .getByRole('listbox')
      .getByRole('option')
      .evaluate((el) => el.childElementCount),
  ).toBe(0);
  await expectInert(page, s);
  await page.keyboard.press('Escape');
  await expect(searchBox(page)).toHaveCount(0);
  // ...in the table (a row button, a cell) and the legend open...
  await chooseView(page, 'table');
  await expect(page.locator('table tbody th button', { hasText: XSS })).toHaveCount(1);
  await legend(page, 'nl').locator('summary').click();
  await expect(legend(page, 'nl')).toHaveAttribute('open', '');
  await expectInert(page, s);
  // ...and the chart's own canvas text (the tooltip is plain text): drawn, never parsed.
  await chooseView(page, 'map');
  await settled(page);
  await page.evaluate(async () => {
    const chart = [...((window as unknown as W).__rws?.charts ?? [])][0];
    chart?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 5 });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
  expect((await drawnText(page)).filter((t) => t.includes('onerror'))).toEqual([XSS]);
  expect(
    new Set(
      await panelOf(page)
        .locator('div[role="img"]')
        .evaluate((el) => [...el.querySelectorAll('*')].map((e) => e.tagName.toLowerCase())),
    ),
  ).toEqual(new Set(['div', 'canvas'])); // not one element came out of the tooltip text
  await expectInert(page, s);
  await finish(page, s);
});

// ---------------------------------------------------------------- a display-only series

test('a display-only series older than 7 days asks the API for nothing and says so', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // The e2e registry has no series whose licence withholds the API channel, so the stations file is patched: the one
  // series of E2E DST is marked `api: false` (what the publisher writes for such a series).
  await page.route('**/data/v1/stations.json', async (route) => {
    // Uncompressed: Caddy serves the precompressed .zst to Firefox, and route.fetch() does not decode zstd.
    const res = await route.fetch({ headers: { ...route.request().headers(), 'accept-encoding': 'identity' } });
    const body = (await res.json()) as { stations: { id: string; series: { api?: boolean }[] }[] };
    for (const st of body.stations) if (st.id === 'nl.e2e.dst') for (const x of st.series) x.api = false;
    await route.fulfill({ response: res, json: body });
  });
  // (a series of the chart: the station's forecast, which sets the slider's end, is asked as before)
  const seriesRequests = () =>
    s.log.requests
      .map((u) => new URL(u).pathname)
      .filter((p) => p.startsWith('/api/v1/series/') && !p.endsWith('/forecast'));
  await open(page, '/?t=2026-10-10T12:00Z&s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect(panelOf(page).getByText(msg('nl', 'history_none'), { exact: true })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  expect(seriesRequests()).toEqual([]);
  // Within the 7 days the static recent.json has it: no note, and still no API request.
  await page.goto('/?t=2026-10-25T00:30Z&s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await settled(page);
  await expect(page.getByText(msg('nl', 'history_none'), { exact: true })).toHaveCount(0);
  expect(seriesRequests()).toEqual([]);

  // The control: the same station, the same old t, with the real file asks the API for its chart.
  await page.unroute('**/data/v1/stations.json');
  await page.goto('/?t=2026-10-10T12:00Z&s=nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  await expect.poll(seriesRequests).toHaveLength(1);
  await expect(page.getByText(msg('nl', 'history_none'), { exact: true })).toHaveCount(0);
  await finish(page, s);
});

// ---------------------------------------------------------------- live mode and the DST night

test('without t the page is live: the note shows, the URL has no t, and "Nu" and the slider move in and out of it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  const live = page.getByText(msg('nl', 'live_note'), { exact: true });
  await expandTimebar(page); // (P10e: the live note is in the expanded timebar)
  await expect(live).toBeVisible();
  expect(param(page, 't')).toBeNull();
  await expect(slider(page)).toHaveValue(String(NOW.getTime()));
  // The current files carry the page: meta.json and latest.json (never the API's meta or snapshot).
  const paths = () => s.log.requests.map((u) => new URL(u).pathname);
  await expect.poll(paths).toEqual(expect.arrayContaining(['/data/v1/meta.json', '/data/v1/latest.json']));
  expect(paths().filter((p) => /^\/api\/v1\/(meta|snapshot)$/.test(p))).toEqual([]);

  await slider(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => param(page, 't')).toBe('2026-10-26T11:50Z');
  await expect(live).toHaveCount(0);
  await page.getByRole('button', { name: 'Nu', exact: true }).click();
  await expect.poll(() => param(page, 't')).toBeNull();
  await expect(live).toBeVisible();
  // A deep link with a t is a fixed view: no live note either.
  await page.goto('/?t=2026-10-26T10:00Z');
  await expect(slider(page)).toBeVisible();
  await expandTimebar(page); // (the note would be there if the page were live)
  await expect(page.getByText(msg('nl', 'live_note'), { exact: true })).toHaveCount(0);
  await finish(page, s);
});

test('the two 02:30s of 2026-10-25 are different in the URL, the label and the values', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/?t=2026-10-25T00:30Z&s=nl.e2e.dst');
  const value = () => panelOf(page).getByRole('region', { name: 'Waterstand' }).locator('strong');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /^.*02:30 CEST$/);
  await expect(timebarTime(page)).toHaveAttribute('datetime', '2026-10-25T00:30:00.000Z');
  await expect(value()).toHaveText('111');
  const first = where(page);

  await page.goto('/?t=2026-10-25T01:30Z&s=nl.e2e.dst');
  await expect(slider(page)).toBeVisible();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /^.*02:30 CET$/);
  await expect(timebarTime(page)).toHaveAttribute('datetime', '2026-10-25T01:30:00.000Z');
  await expect(value()).toHaveText('222');
  expect(where(page)).not.toBe(first);
  // The label of each in the table caption as well (text, in the page's zone).
  await chooseView(page, 'table');
  await expect(page.locator('table caption')).toContainText('02:30 CET');
  await finish(page, s);
});

// ---------------------------------------------------------------- the attribution (C9)

test('the map attribution is our own constant: OpenStreetMap linked, Protomaps, nothing from the new layers', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await open(page, '/');
  await mapReady(page);
  // The river and warning layers are on the map; they add no attribution of their own.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__rws?.map?.getStyle().layers.some((l) => l.id === 'rivers')),
    )
    .toBe(true);
  const attribution = page.locator('.maplibregl-ctrl-attrib-inner');
  await expect(attribution).toHaveText('© OpenStreetMap contributors · Protomaps');
  expect(await attribution.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual([
    'https://www.openstreetmap.org/copyright',
  ]);
  await finish(page, s);
});

// ---------------------------------------------------------------- the public site is not the owner site

test('the public site: no owner banner, no owner badge, no owner station, runtime-config says public', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // (P10b: the file also names the operator and contact of the pages, and the CDN; their values are pages.spec.ts's)
  const config = (await (await request.get('/runtime-config.json')).json()) as Record<string, unknown>;
  expect(config.audience).toBe('public');
  expect(Object.keys(config).sort()).toEqual(['audience', 'cdn', 'contact', 'operator']);
  await open(page, '/');
  await mapReady(page);
  await expect(page.getByRole('region', { name: msg('nl', 'owner_banner_label') })).toHaveCount(0);
  await expect(page.getByText(msg('nl', 'owner_banner'), { exact: true })).toHaveCount(0);
  await expect(page.getByText(msg('nl', 'owner_badge'))).toHaveCount(0);
  await expect(page.getByText(msg('nl', 'legend_owner'))).toHaveCount(0);
  // (P10e: no station list to read ids from: the API's stations hold no owner id, and the search finds no such station)
  const api = (await (await request.get('/api/v1/stations')).json()) as { stations: { id: string }[] };
  expect(api.stations.filter((st) => /^(be\.spw\.|lu\.age-json\.)/.test(st.id))).toEqual([]);
  await searchButton(page).click();
  await searchBox(page).fill('be.spw');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(await featureState(page, 'be.spw.1046')).toEqual({}); // not on the map: MapLibre knows no such feature
  // the owner chunk is never requested on the public site
  expect(
    s.log.requests.map((u) => new URL(u).pathname).filter((p) => /\/assets\/(owner|labels\.gen)-/.test(p)),
  ).toEqual([]);
  await finish(page, s);
});

// ---------------------------------------------------------------- KG-233: the age of a series' newest value

test("latest.json's lapsed ages: stale past the limit, hidden after 25 hours (KG-233)", async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'dh');
  const real = (await (await page.request.get('/data/v1/stations.json')).json()) as {
    stations: { id: string; series: { id: number }[] }[];
  };
  const ids = real.stations.find((x) => x.id === LOBITH)?.series.map((x) => x.id) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  // Lobith's series have no value at t and a newest value this old (seconds).
  let age = 7200;
  await page.route('**/data/v1/latest.json', async (route) => {
    const file = (await (await route.fetch()).json()) as Record<string, unknown[]>;
    const keep = (file.series as number[]).map((id) => !ids.includes(id));
    for (const col of [
      'series',
      'ageSeconds',
      'value',
      'qc',
      'state',
      'basis',
      'section',
      'area',
      'nap',
      'zero',
      'dh24',
      'dh1',
    ])
      file[col] = (file[col] as unknown[]).filter((_, i) => keep[i]);
    file.lapsed = [...(file.lapsed as number[]), ...ids];
    file.lapsedAge = [...(file.lapsedAge as unknown[]), ...ids.map(() => age)];
    await route.fulfill({ json: file });
  });

  // Two hours: past the staleness limit, so the station is on the page with its stale note in the table.
  await open(page, `/?s=${LOBITH}`);
  await expect(slider(page)).toBeVisible();
  await chooseView(page, 'table');
  const rows = page
    .locator('table tbody tr')
    .filter({ has: page.getByRole('button', { name: 'Lobith, Bovenrijn, Tolkamer', exact: true }) });
  await expect(rows).toHaveCount(ids.length);
  await expect(rows.first().locator('td').last()).toContainText(msg('nl', 'lapsed_note'));
  await expect(panelOf(page)).toContainText(msg('nl', 'lapsed_note'));

  // 25 hours and a second: hidden from the search (and so from the map and the table); its link still opens the panel.
  age = 25 * 3600 + 1;
  await open(page, '/');
  await searchButton(page).click();
  await searchBox(page).fill('Lobith');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
  await open(page, `/?s=${LOBITH}`);
  await expect(panelOf(page)).toContainText(msg('nl', 'lapsed_hidden_note'));
  await finish(page, s);
});
