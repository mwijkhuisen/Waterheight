import { AxeBuilder } from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { CANARY_RENDERINGS } from '@rws/contracts';
import { expectClean, instrument } from './clean.ts';

// P8b acceptance (issue #23), on Chromium, Firefox and WebKit, against the e2e build under the production headers
// with the e2e api behind it (apps/server/test/e2e/api.ts, a fixed clock: NOW) and its synthetic forecast runs:
//   nl.e2e.xss  NL-1 run, issue time inferred (fetched NOW - 2 h), band, estimate after NOW + 12 h, reaches NOW + 30 h;
//   nl.e2e.dst  NL-1 run, issue time stated (NOW - 3 h), no band, reaches NOW + 20 h;
//   Lobith      NL-1 run on its H series only (NOW + 40 h): its Q series has no forecast;
//   nl.e2e.gap  no public run (only an owner-canary run, which no public output may show).
// - moving the slider past now switches to forecast styling (marker state and words);
// - the panel, the popup and the table carry agency, issue time (or "opgehaald"/"fetched"), estimate and band as text;
// - a station without a forecast is grey and says "Geen verwachting" / "No forecast";
// - the slider ends at the selected station's horizon (else now + 48 h) and works from the keyboard across now;
// - the owner canary never appears: not in the DOM, not in any /api/ answer the page receives or the API gives;
// - 0 CSP violations, same-origin requests only, axe finds no serious or critical issue.

const NOW = new Date('2026-10-26T12:00:00Z');
const HOUR = 3_600_000;
/** A `?t=` value, `hours` after NOW. */
const at = (hours: number) => `${new Date(NOW.getTime() + hours * HOUR).toISOString().slice(0, 16)}Z`;
/** The same instant as the slider's value and max. */
const ms = (hours: number) => String(NOW.getTime() + hours * HOUR);
const RAW_BASIS = 'Licht verhoogd (<img src=y onerror=alert(3)>)';
const RAW_NAME = '<img src=x onerror=alert(1)>';
const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';

interface Hook {
  map: { getFeatureState(f: { source: string; id: string }): Record<string, unknown> } | null;
  charts: Set<{ getOption(): { series?: { data?: unknown[] }[] } | undefined }>;
}
type W = Window & { __rws?: Hook };

// ---------------------------------------------------------------- helpers

async function start(page: Page, context: BrowserContext, baseURL: string | undefined) {
  const log = await instrument(page, context, baseURL);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  await page.clock.setFixedTime(NOW);
  // P10a: the default map mode is status.json's (the e2e publisher's says "dh": the change mode); these specs read the
  // state words, so they serve a file that says "state".
  await page.route('**/data/v1/status.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"classification":{"mode":"state"}}' }),
  );
  return { log, dialogs };
}
type Session = Awaited<ReturnType<typeof start>>;

/** No dialog, 0 CSP violations, same-origin requests only. */
async function finish(page: Page, s: Session) {
  expect(s.dialogs).toEqual([]);
  await expectClean(page, s.log);
}

const slider = (page: Page, name = 'Tijdlijn') => page.getByRole('slider', { name });
const panelOf = (page: Page) => page.locator('aside');
/** The station list; `exact`, because the panel's close button is also named "Station …". */
const stationList = (page: Page, name = 'Station') => page.getByRole('combobox', { name, exact: true });
const tParam = (page: Page) => new URL(page.url()).searchParams.get('t');

/** Opens a page and waits for the viewer (the slider exists once meta and stations have arrived). */
async function open(page: Page, path: string, name?: string) {
  await page.goto(path);
  await expect(slider(page, name)).toBeVisible();
}

const featureState = (page: Page, id: string) =>
  page.evaluate((id) => {
    try {
      return (window as unknown as W).__rws?.map?.getFeatureState({ source: 'stations', id }) ?? null;
    } catch {
      return null;
    }
  }, id);

/** The map has its stations and the snapshot of the page's t has arrived: the xss station is marked as it must be. */
const markerReady = (page: Page, forecast: boolean) =>
  expect.poll(() => featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true, forecast });

/** The values on screen are those of the page's t (nothing is marked busy) and every chart has drawn its points. */
async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.waitForFunction(() => {
    const charts = [...((window as unknown as W).__rws?.charts ?? [])];
    const panels = document.querySelectorAll('aside div[role="img"]').length;
    return charts.length === panels && charts.every((c) => (c.getOption()?.series?.[0]?.data?.length ?? 0) > 0);
  });
}

/** axe on the page (or one part of it): no undecided check, and no serious or critical finding. */
async function expectNoSeriousAxe(page: Page, scope?: string) {
  await settled(page);
  // The table pages at 100 rows (P10a): every row of a page is checked (KG-129 closed).
  const axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  const result = await (scope === undefined ? axe : axe.include(scope)).analyze();
  expect(result.passes.length, 'axe ran its rules').toBeGreaterThan(10);
  const nodes = (v: (typeof result.violations)[number]) =>
    v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`.trim());
  expect(result.incomplete.map((v) => `${v.id}: ${nodes(v).join(' | ')}`)).toEqual([]);
  expect(
    result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${nodes(v).join(' | ')}`),
  ).toEqual([]);
}

/** Every /api/ answer the page receives, with its body. */
function watchApi(page: Page) {
  const answers: { url: string; body: string }[] = [];
  const pending: Promise<void>[] = [];
  page.on('response', (r) => {
    if (!new URL(r.url()).pathname.startsWith('/api/')) return;
    pending.push(
      r.text().then(
        (body) => void answers.push({ url: r.url(), body }),
        () => {},
      ),
    );
  });
  return { all: () => Promise.all(pending).then(() => answers) };
}

/** The canary spellings found in a text. */
const leaks = (text: string) => CANARY_RENDERINGS.filter((c) => text.includes(c));

test.beforeEach(async ({ page, browserName }) => {
  // WebKit runs without Temporal here, so the forecast times are formatted by the polyfill (as in app.spec.ts).
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

// ---------------------------------------------------------------- forecast styling

test('moving the slider past now switches to forecast styling, and "Nu" comes back', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL);
  await open(page, '/');
  await markerReady(page, false);
  // Up to now: values, no badge; the "nu" marker is on the track; with no station selected the track reaches +48 h.
  await expect(page.getByText('Verwachting', { exact: true })).toHaveCount(0);
  await expect(page.getByText('nu', { exact: true })).toBeVisible();
  await expect(slider(page)).toHaveAttribute('max', ms(48));
  await expect(slider(page)).toHaveAttribute('aria-describedby', /.+ .+/);

  await slider(page).focus();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await expect.poll(() => tParam(page)).toBe(at(2));
  await markerReady(page, true);
  // A forecast is a ring (has, forecast); the gap station has none: grey.
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true, forecast: true, estimate: false });
  expect(await featureState(page, 'nl.e2e.dst')).toMatchObject({ has: true, forecast: true, estimate: false });
  expect(await featureState(page, 'nl.e2e.gap')).toMatchObject({ has: false, forecast: true });
  // The words: the badge, the slider's value text and the note say it is a forecast, in text.
  await expect(page.getByText('Verwachting', { exact: true })).toBeVisible();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /15:00 CET \(verwachting\)$/);
  await expect(page.getByText(/Rechts van ‘nu’ toont de tijdlijn officiële verwachtingen, tot/)).toBeVisible();

  // "Nu" returns to the observations: the stations are filled again and the badge is gone.
  await page.getByRole('button', { name: 'Nu', exact: true }).click();
  await expect.poll(() => tParam(page)).toBeNull(); // now is live mode (P10a): no t
  await markerReady(page, false);
  expect(await featureState(page, 'nl.e2e.gap')).toMatchObject({ has: false, forecast: false });
  await expect(page.getByText('Verwachting', { exact: true })).toHaveCount(0);
  await finish(page, s);
});

test('after the provider’s own segment a forecast is an estimate; after a station’s run it is none', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL);
  // NOW + 20 h: xss is past its provider segment (NOW + 12 h), dst is at its last point (NOW + 20 h).
  await open(page, `/?t=${at(20)}`);
  await markerReady(page, true);
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true, forecast: true, estimate: true });
  expect(await featureState(page, 'nl.e2e.dst')).toMatchObject({ has: true, forecast: true, estimate: false });
  // One hour on, the dst run has ended: grey. The run of xss reaches NOW + 30 h.
  await slider(page).focus();
  await page.keyboard.press('PageUp');
  await expect.poll(() => tParam(page)).toBe(at(21));
  await expect.poll(() => featureState(page, 'nl.e2e.dst')).toMatchObject({ has: false, forecast: true });
  expect(await featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true, forecast: true, estimate: true });
  await finish(page, s);
});

// ---------------------------------------------------------------- the words

test('the panel and the popup name the agency, the fetch time, the band and the state, as text', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL);
  await open(page, `/en/?t=${at(2)}&s=nl.e2e.xss`, 'Timeline');
  await markerReady(page, true);
  const level = panelOf(page).getByRole('region', { name: 'Water level' });
  await expect(level.locator('strong')).toHaveText('340');
  await expect(level.locator('p', { has: page.locator('strong') })).toHaveText('340 cm NAP');
  // NL-1 states no issue time: ours is the fetch time (NOW - 2 h = 10:00Z = 11:00 CET); the value holds for 15:00 CET.
  await expect(level.locator('dt', { hasText: 'Forecast from' })).toBeVisible();
  await expect(level.locator('dd', { hasText: /^RWS, fetched .*26 Oct 2026.*11:00 CET$/ })).toBeVisible();
  await expect(level.locator('dd', { hasText: /^10–90 %: 320–365 cm NAP$/ })).toBeVisible();
  await expect(level.locator('dd', { hasText: /^Mon\b.*15:00 CET$/ }).first()).toBeVisible();
  await expect(level.locator('dd', { hasText: /^elevated$/ })).toBeVisible();
  // The provider's class label is text: no element came out of it, nothing was requested for it.
  await expect(level.locator('dd', { hasText: RAW_BASIS })).toHaveText(
    `RWS Waterinfo legend, not an official warning: ${RAW_BASIS} — Slightly elevated (Waterinfo class)`,
  );
  await expect(page.locator('img[src="y"]')).toHaveCount(0);
  await expect.poll(() => featureState(page, 'nl.e2e.xss')).toMatchObject({ selected: true });
  const line = page.locator('.maplibregl-popup-content > p');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('Water level: 340 cm NAP, forecast, RWS, fetched');
  expect(await line.textContent()).toContain(RAW_BASIS);
  expect(s.log.requests.map((u) => new URL(u).pathname).filter((p) => p.endsWith('/y'))).toEqual([]);

  // A stated issue time reads "issued"; this run has no band, so no row for one.
  await stationList(page).selectOption('nl.e2e.dst');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E DST');
  const dst = panelOf(page).getByRole('region', { name: 'Water level' });
  await expect(dst.locator('strong')).toHaveText('420');
  await expect(dst.locator('dd', { hasText: /^RWS, issued .*26 Oct 2026.*10:00 CET$/ })).toBeVisible();
  await expect(dst.locator('dt', { hasText: 'Range' })).toHaveCount(0);
  await finish(page, s);
});

test('an estimate says so in words (NL), and the band keeps its percentiles', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL);
  await open(page, `/?t=${at(20)}&s=nl.e2e.xss`);
  const level = panelOf(page).getByRole('region', { name: 'Waterstand' });
  await expect(level.locator('strong')).toHaveText('430');
  await expect(level.getByText('schatting: na het deel dat de bron zelf voorspelt')).toBeVisible();
  await expect(level.locator('dd', { hasText: /^10–90 %: 410–455 cm NAP$/ })).toBeVisible();
  await expect(level.locator('dd', { hasText: /^RWS, opgehaald .*26 okt 2026.*11:00 CET$/ })).toBeVisible();
  // The horizon of the run: NOW + 30 h = 2026-10-27T18:00Z = 19:00 CET.
  await expect(level.locator('dd', { hasText: /^di 27 okt 2026.*19:00 CET$/ })).toBeVisible();
  await expect(page.locator('.maplibregl-popup-content > p')).toContainText(
    'Waterstand: 430 cm NAP, schatting, RWS, opgehaald',
  );
  await finish(page, s);
});

test('a series without a forecast says "Geen verwachting" next to one that has it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL);
  // Lobith: a run for the water level only (to NOW + 40 h), none for the discharge.
  await open(page, `/?t=${at(2)}&s=${LOBITH}`);
  await expect(slider(page)).toHaveAttribute('max', ms(40));
  const level = panelOf(page).getByRole('region', { name: 'Waterstand' });
  await expect(level.locator('strong')).toHaveText('103');
  await expect(level.locator('dd', { hasText: /^RWS, opgehaald / })).toBeVisible();
  const discharge = panelOf(page).getByRole('region', { name: 'Afvoer' });
  await expect(discharge.getByText('Geen verwachting', { exact: true })).toBeVisible();
  await expect(discharge.locator('dd', { hasText: /^RWS, / })).toHaveCount(0);
  const lines = page.locator('.maplibregl-popup-content > p');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText('Waterstand: 103 cm NAP, verwachting, RWS, opgehaald');
  await expect(lines.nth(1)).toHaveText('Afvoer: Geen verwachting');
  await finish(page, s);
});

test('the table lists the forecast as text and says "Geen verwachting" for a station without one', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL);
  await open(page, `/?t=${at(2)}`);
  await markerReady(page, true);
  // The map greys the gap station; the table says it in words.
  expect(await featureState(page, 'nl.e2e.gap')).toMatchObject({ has: false, forecast: true });
  await page.getByRole('button', { name: 'Tabel', exact: true }).click();
  const table = page.locator('table');
  await expect(table.locator('caption')).toContainText('Verwachtingen voor');
  await expect(table.getByRole('columnheader', { name: 'Verwachting', exact: true })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Gemeten' })).toHaveCount(0);
  const row = (name: string) => table.locator('tbody tr', { has: page.getByRole('button', { name, exact: true }) });
  // The table pages at 100 rows (P10a): the station chosen in the list brings its page into view (E2E DST, then the hostile
  // name, which sorts first). Choosing a station also limits the slider to its forecast: both have one at +2 h.
  await stationList(page).selectOption('nl.e2e.dst');
  await expect(table.locator('caption')).toContainText('Verwachtingen voor');
  await expect(row('E2E gap').locator('td').nth(4)).toHaveText('Geen verwachting');
  await expect(row('E2E gap').locator('td').nth(5)).toHaveText('–');
  await expect(row('E2E DST').locator('td').nth(4)).toHaveText('420 cm NAP');
  await expect(row('E2E DST').locator('td').nth(5)).toHaveText(/^RWS, uitgegeven .*10:00 CET$/);
  await stationList(page).selectOption('nl.e2e.xss');
  await expect(row(RAW_NAME).locator('td').nth(4)).toHaveText('340 cm NAP');
  await expect(row(RAW_NAME).locator('td').nth(5)).toHaveText(/^RWS, opgehaald .*11:00 CET; 10–90 %: 320–365 cm NAP$/);
  // Back at now the table shows the observations again.
  await page.getByRole('button', { name: 'Nu', exact: true }).click();
  await expect(table.getByRole('columnheader', { name: 'Gemeten' })).toBeVisible();
  await finish(page, s);
});

// ---------------------------------------------------------------- the end of the slider

test('the slider ends at the selected station’s horizon, else at now + 48 h; a later t is clamped to it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL);
  await open(page, '/');
  await expect(slider(page)).toHaveAttribute('max', ms(48));
  await stationList(page).selectOption('nl.e2e.xss');
  await expect(slider(page)).toHaveAttribute('max', ms(30));
  await stationList(page).selectOption('nl.e2e.dst');
  await expect(slider(page)).toHaveAttribute('max', ms(20));
  // No run at all (the owner-canary run on it is not public): the track ends at now, and a note says why.
  await stationList(page).selectOption('nl.e2e.gap');
  await expect(slider(page)).toHaveAttribute('max', ms(0));
  await expect(
    page.getByText('Voor dit station is geen verwachting beschikbaar: de tijdlijn eindigt bij ‘nu’.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '10 minuten vooruit' })).toHaveAttribute('aria-disabled', 'true');
  await stationList(page).selectOption('');
  await expect(slider(page)).toHaveAttribute('max', ms(48));
  await expect(page.getByText('Voor dit station is geen verwachting beschikbaar', { exact: false })).toHaveCount(0);

  // A t beyond the station's end is clamped to it (the URL keeps what was typed); more than 48 h ahead is no t.
  await open(page, `/?t=${at(40)}&s=nl.e2e.xss`);
  await expect(slider(page)).toHaveAttribute('max', ms(30));
  await expect(slider(page)).toHaveValue(ms(30));
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /19:00 CET \(verwachting\)$/);
  await open(page, `/?t=${at(48)}`);
  await expect(slider(page)).toHaveValue(ms(48));
  await open(page, `/?t=${at(49)}`);
  await expect(slider(page)).toHaveValue(ms(0));
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /13:00 CET$/);
  await finish(page, s);
});

test('the slider works from the keyboard across now and says when it is in the forecast part', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL);
  await open(page, `/?s=nl.e2e.xss`);
  await expect(slider(page)).toHaveAttribute('max', ms(30));
  await slider(page).focus();

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => tParam(page)).toBe(at(1 / 6));
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /13:10 CET \(verwachting\)$/);
  await expect(page.getByText('Verwachting', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => tParam(page)).toBeNull(); // back at now: live mode, no t
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /13:00 CET$/);
  await expect(page.getByText('Verwachting', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => tParam(page)).toBe(at(-1 / 6));
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /12:50 CET$/);

  // End is the end of this station's forecast; the arrow stops there; PageDown moves an hour back.
  await page.keyboard.press('End');
  await expect.poll(() => tParam(page)).toBe(at(30));
  await expect(slider(page)).toHaveValue(ms(30));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('PageUp');
  await expect(slider(page)).toHaveValue(ms(30));
  await page.keyboard.press('PageDown');
  await expect.poll(() => tParam(page)).toBe(at(29));
  await expect(slider(page)).toBeFocused();
  await finish(page, s);
});

// ---------------------------------------------------------------- the owner canary

test('the owner canary never appears: not in the page at any t, not in any /api/ answer', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const s = await start(page, context, baseURL);
  const api = watchApi(page);
  const stations = (await (await request.get('/api/v1/stations')).json()) as {
    stations: { id: string; series: { id: number }[] }[];
  };
  const gap = stations.stations.find((st) => st.id === 'nl.e2e.gap')?.series[0]?.id;
  expect(gap).toBeDefined();

  // The API itself: the owner run on the gap station's series is not a public forecast, at any t.
  const direct = await request.get(`/api/v1/series/${gap}/forecast`);
  expect(direct.status()).toBe(200);
  expect(((await direct.json()) as { run: unknown }).run).toBeNull();
  for (const hours of [1, 12, 30, 36, 48]) {
    const text = await (await request.get(`/api/v1/snapshot?t=${at(hours)}`)).text();
    expect(leaks(text), `snapshot at +${hours} h`).toEqual([]);
    expect(text).not.toContain(`"series":${gap},`);
  }

  // The page, at several t, in both views, then with the gap station selected: the canary is nowhere in it.
  for (const hours of [1, 30, 48]) {
    await open(page, `/?t=${at(hours)}`);
    await expect.poll(() => featureState(page, 'nl.e2e.gap')).toMatchObject({ has: false, forecast: true });
    expect(leaks(await page.content()), `the page at +${hours} h`).toEqual([]);
  }
  await page.getByRole('button', { name: 'Tabel', exact: true }).click();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  expect(leaks(await page.content())).toEqual([]);
  expect(leaks(await page.locator('body').innerText())).toEqual([]);
  const forecastOfGap = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/series/${gap}/forecast`);
  await stationList(page).selectOption('nl.e2e.gap');
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E gap');
  expect(((await (await forecastOfGap).json()) as { run: unknown }).run).toBeNull();
  await settled(page);
  expect(leaks(await page.content())).toEqual([]);

  // Everything the page was sent: the forecasts reached it (so this is a real check), the canary did not.
  const answers = await api.all();
  expect(answers.some((a) => a.body.includes('"forecasts":[{'))).toBe(true);
  expect(answers.filter((a) => leaks(a.body).length > 0).map((a) => a.url)).toEqual([]);
  expect(answers.some((a) => a.url.endsWith(`/api/v1/series/${gap}/forecast`))).toBe(true);
  await finish(page, s);
});

// ---------------------------------------------------------------- axe and clean

const axeSpec = (title: string, run: (page: Page) => Promise<void>) =>
  test(title, async ({ page, context, baseURL }) => {
    const s = await start(page, context, baseURL);
    await run(page);
    await expectNoSeriousAxe(page);
    await finish(page, s);
  });

axeSpec('axe finds no serious or critical issue: the forecast view with the panel open', async (page) => {
  await open(page, `/?t=${at(2)}&s=nl.e2e.xss`);
  await markerReady(page, true);
  await expect.poll(() => featureState(page, 'nl.e2e.xss')).toMatchObject({ selected: true });
  await expect(panelOf(page).locator('strong')).toHaveText('340');
  await expect(page.locator('.maplibregl-popup-content > p')).toHaveCount(1);
});

axeSpec('axe finds no serious or critical issue: the forecast table, in English', async (page) => {
  // A tall viewport: axe cannot decide the colour contrast of rows that the scroll area clips.
  await page.setViewportSize({ width: 1024, height: 20_000 });
  await open(page, `/en/?t=${at(2)}`, 'Timeline');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('table caption')).toContainText('Forecasts for');
  await expect(page.locator('table tbody tr').first()).toBeVisible();
});

axeSpec('axe finds no serious or critical issue: a station without a forecast, at now', async (page) => {
  await open(page, '/?s=nl.e2e.gap');
  await expect(page.getByText('Voor dit station is geen verwachting beschikbaar')).toBeVisible();
  await expect(slider(page)).toHaveAttribute('max', ms(0));
});
