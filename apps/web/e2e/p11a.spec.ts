import { expect, type Locator, type Page, test } from '@playwright/test';
import { scanEta } from './eta-scan.ts';
import {
  expectInert,
  expectNoSeriousAxe,
  finish,
  mapReady,
  msg,
  msgRx,
  open,
  panelOf,
  start,
  type W,
  XSS,
} from './helpers.ts';

// P11a (issue #26): the flow direction on the river lines and the upstream chain in the station panel, on Chromium,
// Firefox and WebKit over the committed fixture river release (prepare-tiles.ts: the reaches file of the fixture graph
// plus the two e2e stations on the Rhine above Koeln, the tiles of the same graph).
//   C1  the chain's texts pass the ETA scan, every travel text with a number says indicatief / indicative;
//   C2  reduced motion: the flow clock never runs (window.__rwsFlowFrames stays 0), the toggle is off and disabled, the
//       arrows show instead of the dashes; a hidden tab freezes the clock; the toggle works from the keyboard;
//   C3  Lobith's chain starts Emmerich, Rees, Wesel, Duisburg-Ruhrort, Duesseldorf, Koeln;
//   gates: axe with the chain open, the keyboard reaches a row and a <summary>, the hostile station name is inert.
// (The no-WebGL2 browser: no-webgl2.spec.ts.)

const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';
/** The Rhine rows above Lobith, nearest first (the reaches fixture), and the name each is published under. */
const RHINE_ROWS: [id: string, name: RegExp][] = [
  ['de.wsv.2790020', /Emmerich/i],
  ['de.wsv.2790010', /Rees/i],
  ['de.wsv.2770040', /Wesel/i],
  ['de.wsv.2770010', /Ruhrort/i],
  ['de.wsv.2750010', /D(ü|ue?)sseldorf/i],
  ['de.wsv.2730010', /K(ö|oe?)ln/i],
];
const FLOW = 'rivers-flow';
const ARROWS = 'rivers-flow-arrows';

type Locale = 'nl' | 'en';
const url = (locale: Locale, id: string) => `${locale === 'nl' ? '/' : '/en/'}?s=${id}`;
const slide = (locale: Locale) => (locale === 'nl' ? undefined : 'Timeline');

/** The names the site publishes, by station id (the api answer the page itself reads). */
async function namesOf(page: Page): Promise<Map<string, string>> {
  const res = await page.request.get('/api/v1/stations');
  expect(res.status()).toBe(200);
  const { stations } = (await res.json()) as { stations: { id: string; name: string }[] };
  return new Map(stations.map((s) => [s.id, s.name]));
}

/** The chain section of the open panel. */
const chainOf = (page: Page, locale: Locale) =>
  panelOf(page)
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: msg(locale, 'chain_heading'), exact: true }) });
/** Its top-level rows: <li> of the first list. */
const topRows = (chain: Locator) => chain.locator(':scope > ul > li');
/** The select button of a station row (the group and gap rows have none). */
const rowName = (row: Locator) => row.locator(':scope > button > span').first();

/** Opens a station and waits for its chain. */
async function openChain(page: Page, locale: Locale, id: string) {
  await open(page, url(locale, id), slide(locale));
  await mapReady(page);
  const chain = chainOf(page, locale);
  await expect(chain).toBeVisible();
  await expect(topRows(chain).first()).toBeVisible();
  return chain;
}

/** The e2e build starts with the flow off (App.tsx); these specs ask for it before the page loads. */
const flowOn = (page: Page) =>
  page.addInitScript(() => {
    (window as unknown as { __rwsFlow?: boolean }).__rwsFlow = true;
  });

const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rwsFlowFrames?: number }).__rwsFlowFrames ?? 0);
const visibility = (page: Page, layer: string) =>
  page.evaluate((id) => {
    const map = (window as unknown as W).__rws?.map;
    return map?.getLayer(id) === undefined ? null : map.getLayoutProperty(id, 'visibility');
  }, layer);
/** The map has both flow layers (the chunk loaded, the river source is there). */
const flowReady = (page: Page) => expect.poll(() => visibility(page, FLOW)).not.toBeNull();
const toggleOf = (page: Page, locale: Locale = 'nl') =>
  page.getByRole('button', { name: msg(locale, 'flow_toggle'), exact: true });

/** Tab until the focused element is `match`; a bound, so that a missing tab stop fails instead of hanging. */
async function tabTo(page: Page, match: (arg: string) => boolean, arg: string, what: string) {
  let tabs = 0;
  while (!(await page.evaluate(match, arg)) && tabs < 80) {
    await page.keyboard.press('Tab');
    tabs++;
  }
  expect(await page.evaluate(match, arg), `${what} is reachable by Tab (after ${tabs} presses)`).toBe(true);
}

// ---------------------------------------------------------------- the chain: C1, C3, the hostile name

for (const locale of ['nl', 'en'] as const) {
  test(`Lobith's upstream chain: the Rhine rows in order, sourced travel times only, the scan finds no ETA (${locale.toUpperCase()})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL, 'state');
    const names = await namesOf(page);
    const chain = await openChain(page, locale, LOBITH);

    // C3: the first six station rows, by the names the site publishes (the stations.json of the e2e api).
    // The station rows start Emmerich, Rees, Wesel, Duisburg-Ruhrort, Duesseldorf, Koeln. The tributary groups (the
    // Lippe, the Ruhr, the Erft) sit between them, collapsed; there is no gap row on the Rhine above Lobith.
    const rows = topRows(chain);
    const stationRows = chain.locator('xpath=./ul/li[button]');
    for (const [i, [id, pattern]] of RHINE_ROWS.entries()) {
      expect(names.get(id), `${id} is published`).toMatch(pattern);
      await expect(rowName(stationRows.nth(i)), `row ${i + 1}`).toHaveText(names.get(id) ?? '');
    }
    await expect(rows.nth(2).locator('summary')).toContainText('Lippe');
    await expect(chain.locator('xpath=./ul/li[not(button) and not(details)]')).toHaveCount(0);
    await expect(chain.locator('details[open]')).toHaveCount(0);

    // Emmerich has an exact sourced pair to Lobith (1-9 h, GWIO 85.006): a range, and it says it is indicative.
    const range = msg(locale, 'travel_range', { lo: 1, hi: 9 });
    await expect(stationRows.nth(0)).toContainText(msg(locale, 'chain_travel', { text: range }));
    // Rees has none: "no sourced value", never a number computed from its neighbours (owner decision D-A).
    await expect(stationRows.nth(1)).toContainText(
      msg(locale, 'chain_travel', { text: msg(locale, 'travel_no_source') }),
    );
    await expect(stationRows.nth(1)).not.toContainText(/\d+\s*[–-]\s*\d+\s*(u|h)\b/);

    // C1: every text of the chain through the ETA scan; each travel line as a travel row.
    const travelLine = msgRx(locale, 'chain_travel');
    const spans = await chain.locator('span').allTextContents();
    const travel = spans.filter((t) => travelLine.test(t));
    expect(travel.length, 'a travel line on every station row').toBeGreaterThan(5);
    const all = await chain.locator('li, p, summary').allTextContents();
    const items = [
      ...all.map((text, i) => ({ where: `chain text ${i}`, text })),
      ...travel.map((text, i) => ({ where: `travel line ${i}`, text, travelRow: true })),
    ];
    expect(scanEta(items)).toEqual([]);
    // Every travel text with a digit says so.
    const numbered = travel.filter((t) => /\d/.test(t));
    expect(numbered.length).toBeGreaterThanOrEqual(1);
    for (const t of numbered) expect(t).toMatch(locale === 'nl' ? /indicatief/ : /indicative/);
    // The note under the chain.
    await expect(chain).toContainText(msg(locale, 'chain_note'));
    // The scan itself can fail: a made-up arrival time in a travel row is found (the negative control).
    expect(scanEta([{ where: 'control', text: `${travel[0]} 14:00`, travelRow: true }])).not.toEqual([]);

    await finish(page, s);
  });
}

test('the hostile station name in the chain is text: no image, no handler, no dialog', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const chain = await openChain(page, 'nl', LOBITH);
  const row = topRows(chain).filter({ has: page.locator('button', { hasText: XSS }) });
  await expect(row).toHaveCount(1);
  expect(await rowName(row).textContent()).toBe(XSS);
  // Nothing in the chain is an image, and no element of it carries a handler attribute.
  await expect(chain.locator('img, svg, [onerror], [onload]')).toHaveCount(0);
  await expectInert(page, s);
  // A click opens that station (a select, not a link), and its name is still text in the panel.
  await row.locator(':scope > button').click();
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText(XSS);
  await expectInert(page, s);
  await finish(page, s);
});

test('a row opens its station; the URL follows', async ({ page, context, baseURL }) => {
  const s = await start(page, context, baseURL, 'state');
  const names = await namesOf(page);
  const chain = await openChain(page, 'nl', LOBITH);
  await rowName(topRows(chain).first()).click();
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText(names.get('de.wsv.2790020') ?? '');
  await expect.poll(() => new URL(page.url()).searchParams.get('s')).toBe('de.wsv.2790020');
  // Emmerich's own chain starts at Rees, and Lobith is not in it.
  const next = chainOf(page, 'nl');
  await expect(rowName(topRows(next).first())).toHaveText(names.get('de.wsv.2790010') ?? '');
  await finish(page, s);
});

// ---------------------------------------------------------------- the gates: axe and the keyboard

test('axe finds no serious issue with the chain open and a tributary group expanded', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const chain = await openChain(page, 'nl', LOBITH);
  const group = chain.locator('details').first();
  await expect(group).toHaveCount(1);
  await group.locator(':scope > summary').click();
  await expect(group).toHaveAttribute('open', '');
  await expect(group.locator('li').first()).toBeVisible();
  await expectNoSeriousAxe(page);
  await finish(page, s);
});

test('the keyboard reaches a chain row and a <summary>, and Enter opens the group', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const chain = await openChain(page, 'nl', LOBITH);
  const names = await namesOf(page);
  // (this runs in the page, so it closes over nothing; the chain is the section labelled by an id ending in "-chain")
  const focusedIn = (tag: string) => {
    const el = document.activeElement;
    return el?.tagName === tag && !!el.closest('[aria-labelledby$="-chain"]');
  };
  // From the panel's heading forward: first a station button of the chain, then a <summary>.
  await panelOf(page).getByRole('heading', { level: 2 }).focus();
  await tabTo(page, focusedIn, 'BUTTON', 'a chain row button');
  expect(await page.evaluate(() => document.activeElement?.textContent ?? '')).toContain(
    names.get('de.wsv.2790020') ?? '',
  );
  await tabTo(page, focusedIn, 'SUMMARY', 'a chain <summary>');
  const group = chain.locator('details:has(summary:focus)');
  await expect(group).not.toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(group).toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(group).not.toHaveAttribute('open', '');
  await finish(page, s);
});

// ---------------------------------------------------------------- C2: the flow clock

test('the flow clock runs, freezes in a hidden tab and runs again once the tab is visible', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await flowOn(page);
  await open(page, '/');
  await mapReady(page);
  await flowReady(page);
  // Running: the dashes show, the arrows do not, and the clock counts.
  await expect.poll(() => frames(page)).toBeGreaterThan(2);
  expect(await visibility(page, FLOW)).toBe('visible');
  expect(await visibility(page, ARROWS)).toBe('none');
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'true');

  // A hidden tab: the page says so through visibilityState and the event.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => visibility(page, FLOW)).toBe('none');
  expect(await visibility(page, ARROWS)).toBe('visible');
  await page.waitForTimeout(300); // a frame that was already in flight
  const frozen = await frames(page);
  await page.waitForTimeout(2000);
  expect(await frames(page), 'no step in a hidden tab').toBe(frozen);

  // Visible again: it runs on.
  await page.evaluate(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => frames(page)).toBeGreaterThan(frozen);
  expect(await visibility(page, FLOW)).toBe('visible');
  expect(await visibility(page, ARROWS)).toBe('none');
  await finish(page, s);
});

test('the flow toggle works from the keyboard: Space stops the clock, Enter starts it', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  await flowOn(page);
  await open(page, '/');
  await mapReady(page);
  await flowReady(page);
  await expect.poll(() => frames(page)).toBeGreaterThan(2);
  const toggle = toggleOf(page);
  await expect(toggle).toBeEnabled();

  await page.locator('body').focus();
  await tabTo(
    page,
    (name) => document.activeElement?.textContent === name,
    msg('nl', 'flow_toggle'),
    'the flow toggle',
  );
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => visibility(page, FLOW)).toBe('none');
  expect(await visibility(page, ARROWS)).toBe('visible');
  await page.waitForTimeout(300);
  const stopped = await frames(page);
  await page.waitForTimeout(1000);
  expect(await frames(page), 'the toggle stops the clock').toBe(stopped);

  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => frames(page)).toBeGreaterThan(stopped);
  expect(await visibility(page, FLOW)).toBe('visible');
  expect(await visibility(page, ARROWS)).toBe('none');
  await finish(page, s);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the clock never runs: the counter stays 0, the toggle is off and disabled, the arrows show', async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL, 'state');
    await flowOn(page);
    await open(page, '/');
    await mapReady(page);
    await flowReady(page);
    // The static arrows instead of the moving dashes.
    await expect.poll(() => visibility(page, ARROWS)).toBe('visible');
    expect(await visibility(page, FLOW)).toBe('none');
    // The toggle says it is off and cannot be turned on; the note says why.
    const toggle = toggleOf(page);
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText(msg('nl', 'flow_reduced'), { exact: true })).toBeVisible();
    // Three seconds of the map being used: still not one step.
    await page.waitForTimeout(3000);
    expect(await frames(page)).toBe(0);
    expect(await visibility(page, ARROWS)).toBe('visible');
    await finish(page, s);
  });
});
