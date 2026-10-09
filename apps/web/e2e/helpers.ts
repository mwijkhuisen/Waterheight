import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { type BrowserContext, expect, type Page } from '@playwright/test';
import { expectClean, instrument, type Log } from './clean.ts';

// Helpers of the P10a specs (p10a, owner, no-webgl2, cvd): the "clean page" session, the e2e build's test hook
// (`window.__rws`), axe, and the message catalogue read from the same JSON the page is built from (so a wording
// change moves the page and the specs together).

export const NOW = new Date('2026-10-26T12:00:00Z');
/** The hostile text of the seeds (apps/server/test/e2e/public-seed.ts): it must stay text everywhere. */
export const XSS = '<img src=x onerror=alert(1)>';

/** The few MapLibre and ECharts calls the tests make inside the page. */
export interface HookMap {
  getFeatureState(f: { source: string; id: string }): Record<string, unknown>;
  getPaintProperty(layer: string, name: string): unknown;
  getLayoutProperty(layer: string, name: string): unknown;
  /** MapLibre draws every frame while true (fps.spec.ts measures with it on). */
  repaint: boolean;
  getFilter(layer: string): unknown;
  getLayer(id: string): { id: string; source?: string; sourceLayer?: string } | undefined;
  getStyle(): { layers: Record<string, unknown>[] };
  querySourceFeatures(source: string, o?: object): { properties: Record<string, unknown> }[];
  getSource(id: string): { getData(): Promise<unknown> } | undefined;
  jumpTo(o: { center: [number, number]; zoom: number }): void;
  once(event: string, fn: () => void): void;
  project(lngLat: [number, number]): { x: number; y: number };
  getZoom(): number;
  getPadding(): { top: number; right: number; bottom: number; left: number };
}
export interface HookChart {
  getOption():
    | {
        tooltip?: { renderMode?: string }[];
        series?: {
          id?: string;
          name?: string;
          data?: unknown[];
          markLine?: { data?: { name?: string; xAxis?: number; yAxis?: number }[] };
          markArea?: { data?: unknown[] };
        }[];
      }
    | undefined;
  dispatchAction(action: object): void;
  getZr(): { storage: { getDisplayList(update?: boolean): { style?: { text?: unknown } }[] } };
}
export type W = Window & { __rws?: { map: HookMap | null; charts: Set<HookChart> } };

type Messages = Record<string, string>;
const catalogue = (locale: 'nl' | 'en'): Messages =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'));
const loaded = { nl: catalogue('nl'), en: catalogue('en') };
/** A message of the page's own catalogue, with its `{name}` placeholders filled. */
export function msg(locale: 'nl' | 'en', key: string, args: Record<string, string | number> = {}): string {
  const text = loaded[locale][key];
  if (text === undefined) throw new Error(`no message ${key}`);
  return text.replaceAll(/\{(\w+)\}/g, (_, name: string) => String(args[name] ?? `{${name}}`));
}

export const escapeRx = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A message as a pattern: the placeholders `args` names are filled in, every other one matches any text. */
export function msgRx(locale: 'nl' | 'en', key: string, args: Record<string, string | number> = {}): RegExp {
  const text = loaded[locale][key];
  if (text === undefined) throw new Error(`no message ${key}`);
  const parts = text.split(/(\{\w+\})/).map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name === undefined ? escapeRx(part) : name in args ? escapeRx(String(args[name])) : '.+';
  });
  return new RegExp(`^${parts.join('')}$`);
}

export interface Session {
  log: Log;
  dialogs: string[];
}

/**
 * Request log and CSP listeners (instrument), the fixed clock, and a record of every dialog the page opens.
 * `status` is what /data/v1/status.json says about the default map mode. The e2e publisher writes a real status.json
 * (classification.mode "dh", i.e. the change mode, 15 forecast reaches), so a spec that wants the state mode serves a
 * file that says so here; the pages specs (pages.spec.ts) read the real one.
 */
export async function start(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  status?: 'state' | 'dh',
): Promise<Session> {
  const log = await instrument(page, context, baseURL);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  await page.clock.setFixedTime(NOW);
  if (status !== undefined)
    await page.route('**/data/v1/status.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ classification: { mode: status, owner: { mode: status } } }),
      }),
    );
  return { log, dialogs };
}

/** No dialog, 0 CSP violations, same-origin requests only. */
export async function finish(page: Page, s: Session) {
  expect(s.dialogs).toEqual([]);
  await expectClean(page, s.log);
}

export const slider = (page: Page, name = 'Tijdlijn') => page.getByRole('slider', { name });
/**
 * The timebar's own `time` (P10d: the bar is docked after the panel in the DOM, so the first `time` of the page is no
 * longer the bar's). The bar is the one section that holds the range input.
 */
export const timebarTime = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.locator('input[type="range"]') })
    .locator('time')
    .first();
/** The timebar section itself (axe scope, geometry). */
export const timebarOf = (page: Page) => page.locator('section').filter({ has: page.locator('input[type="range"]') });
export const panelOf = (page: Page) => page.locator('aside');

type Lang = 'nl' | 'en';

// P10e: the controls that moved. The station <select> is the magnifier in the bar and its combobox; the mode and the
// view are two disclosures over the top-left of the view; the timebar is collapsed until "Tijdopties" expands it; the
// footer's credits are the "Bronnen" disclosure over the bottom right; the page links are the bar's <nav>, below 80rem
// behind the menu button.

/** The magnifier in the bar. */
export const searchButton = (page: Page, locale: Lang = 'nl') =>
  page.getByRole('button', { name: msg(locale, 'search_open'), exact: true });
/** The search field (exists while the search is open). */
export const searchBox = (page: Page, locale: Lang = 'nl') =>
  page.getByRole('combobox', { name: msg(locale, 'search_open'), exact: true });
/**
 * Opens the search, types `query` and chooses a result: the option named `option` by a click, else the active (first)
 * one by Enter. The panel then holds the focus.
 */
export async function pickStation(page: Page, query: string, option?: string | RegExp, locale: Lang = 'nl') {
  await searchButton(page, locale).click();
  const box = searchBox(page, locale);
  await expect(box).toBeFocused();
  await box.fill(query);
  if (option === undefined) await box.press('Enter');
  else await page.getByRole('option', { name: option }).click();
}

/** The button that expands the timebar. */
export const timebarMore = (page: Page, locale: Lang = 'nl') =>
  timebarOf(page).getByRole('button', { name: msg(locale, 'timebar_more'), exact: true });
/** Expands the timebar (the date and time fields, reverse play, the repeated hour and the notes exist after this). */
export async function expandTimebar(page: Page, locale: Lang = 'nl') {
  const more = timebarMore(page, locale);
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
}

const summaryOf = (page: Page, key: 'mode_summary' | 'view_summary', locale: Lang) =>
  page.locator('summary', { hasText: msg(locale, key, { mode: '', view: '' }).trim() });
/** The summary of the mode disclosure ("Kaart: Toestand") and of the view disclosure ("Weergave: Kaart"). */
export const modeSummary = (page: Page, locale: Lang = 'nl') => summaryOf(page, 'mode_summary', locale);
export const viewSummary = (page: Page, locale: Lang = 'nl') => summaryOf(page, 'view_summary', locale);
async function openSummary(summary: ReturnType<typeof modeSummary>) {
  if ((await summary.locator('..').getAttribute('open')) === null) await summary.click();
}
export const openMode = (page: Page, locale: Lang = 'nl') => openSummary(modeSummary(page, locale));
export const openView = (page: Page, locale: Lang = 'nl') => openSummary(viewSummary(page, locale));
/** Opens the mode disclosure and chooses a mode by its radio. */
export async function chooseMode(page: Page, mode: 'state' | 'delta' | 'q', locale: Lang = 'nl') {
  await openMode(page, locale);
  await page.getByRole('radio', { name: msg(locale, `mode_${mode}`), exact: true }).check();
}
/** The radio of a mode, after opening the mode disclosure. */
export async function modeRadio(page: Page, mode: 'state' | 'delta' | 'q', locale: Lang = 'nl') {
  await openMode(page, locale);
  return page.getByRole('radio', { name: msg(locale, `mode_${mode}`), exact: true });
}
/** Opens the view disclosure and chooses the map or the table. */
export async function chooseView(page: Page, view: 'map' | 'table', locale: Lang = 'nl') {
  await openView(page, locale);
  await page.getByRole('button', { name: msg(locale, `view_${view}`), exact: true }).click();
}

/** The "Bronnen" button over the bottom right and the panel it opens (the credits the footer carried until P10d). */
export const attributionButton = (page: Page, locale: Lang = 'nl') =>
  page.getByRole('button', { name: msg(locale, 'sources_heading'), exact: true });
export const attributionPanel = (page: Page, locale: Lang = 'nl') =>
  page.getByRole('region', { name: msg(locale, 'attribution_panel_label') });
export async function openAttribution(page: Page, locale: Lang = 'nl') {
  const button = attributionButton(page, locale);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(attributionPanel(page, locale)).toBeVisible();
  return attributionPanel(page, locale);
}

/** The bar's page links. Below 80rem they are behind the menu button: `openMenu` first. */
export const barNav = (page: Page, locale: Lang = 'nl') =>
  page.getByRole('navigation', { name: msg(locale, 'footer_nav_label') });
export const menuButton = (page: Page, locale: Lang = 'nl') =>
  page.getByRole('button', { name: msg(locale, 'menu_button'), exact: true });
/** Opens the menu where there is one (a window narrower than 80rem); nothing to do from 80rem. */
export async function openMenu(page: Page, locale: Lang = 'nl') {
  const button = menuButton(page, locale);
  if (await button.isVisible()) {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    await expect(barNav(page, locale)).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
  }
}

/** Opens a page and waits for the viewer (the slider exists once meta and stations have arrived). */
export async function open(page: Page, path: string, name?: string) {
  const response = await page.goto(path);
  await expect(slider(page, name)).toBeVisible();
  return response;
}

/** Path and query of the current URL. */
export const where = (page: Page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};
export const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
export const ms = (iso: string) => String(Date.parse(iso));

export const featureState = (page: Page, id: string) =>
  page.evaluate((id) => {
    try {
      return (window as unknown as W).__rws?.map?.getFeatureState({ source: 'stations', id }) ?? null;
    } catch {
      return null;
    }
  }, id);

/** The map has its stations and the snapshot of the first `t` has arrived (nl.e2e.xss has a value from 2026-10-24). */
export async function mapReady(page: Page) {
  // The map mounts only near the viewport (useMapLibre); on the owner site the banner and the brand header (P10c)
  // put it below the fold of the 768 px window, so bring the end of <main>, where the map is, into view first.
  await page.locator('main').evaluate((main) => main.scrollIntoView({ block: 'end' }));
  await expect.poll(() => featureState(page, 'nl.e2e.xss')).toMatchObject({ has: true });
}

/** The values on screen are those of the page's t (nothing is marked busy) and every chart has drawn its points. */
export async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.waitForFunction(() => {
    const charts = [...((window as unknown as W).__rws?.charts ?? [])];
    const panels = document.querySelectorAll('aside div[role="img"]').length;
    return charts.length === panels && charts.every((c) => (c.getOption()?.series?.[0]?.data?.length ?? 0) > 0);
  });
}

/**
 * Nothing is marked busy and every chart of the panel exists; unlike `settled` it does not wait for points, so it serves a
 * station with a series that has no data (the BE-3 station's discharge).
 */
export async function idle(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.waitForFunction(() => {
    const charts = (window as unknown as W).__rws?.charts?.size ?? 0;
    return charts === document.querySelectorAll('aside div[role="img"]').length;
  });
}

/** Replaces canvas.getContext so 'webgl2' answers null (everything else is untouched). */
export const withoutWebGL2 = () => {
  const get = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, ...a: unknown[]) => unknown;
  (HTMLCanvasElement.prototype as { getContext: unknown }).getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    return type === 'webgl2' ? null : get.call(this, type, ...rest);
  };
};

/** axe on the page (or one part of it): no undecided check, and no serious or critical finding (issue #19). */
export async function expectNoSeriousAxe(page: Page, scope?: string, points = true) {
  // axe yields to the page between its rules: a DOM that changes during the run makes checks undecidable (CR-1).
  if (points) await settled(page);
  else await idle(page);
  // The table pages at 100 rows (P10a), so every row is checked: no row is left out any more (KG-129 closed).
  const axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  const result = await (scope === undefined ? axe : axe.include(scope)).analyze();
  expect(result.passes.length, 'axe ran its rules').toBeGreaterThan(10);
  /** Each node by its selector, its markup and axe's own reason, so a failure in CI can be diagnosed from the log. */
  const nodes = (v: (typeof result.violations)[number]) =>
    v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`.trim());
  // Every check it ran was decidable (an "incomplete" colour contrast would be a check that proved nothing).
  expect(result.incomplete.map((v) => `${v.id}: ${nodes(v).join(' | ')}`)).toEqual([]);
  expect(
    result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${nodes(v).join(' | ')}`),
  ).toEqual([]);
}

/** The tag names of the text nodes that contain `needle` (a text node is text, never an element). */
export const textHosts = (page: Page, needle: string) =>
  page.evaluate((needle) => {
    const hosts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if (n.nodeValue?.includes(needle)) hosts.push((n.parentElement?.tagName ?? '?').toLowerCase());
    return hosts.sort();
  }, needle);

/** The hostile fixture is inert: no image, no element with a handler, and nothing was fetched for `src=x`/`src=y`. */
export async function expectInert(page: Page, s: Session) {
  await expect(page.locator('img')).toHaveCount(0);
  await expect(page.locator('img[src="x"], img[src="y"]')).toHaveCount(0);
  await expect(page.locator('svg[onload], [onerror], [onload]')).toHaveCount(0);
  expect(s.log.requests.map((u) => new URL(u).pathname).filter((p) => p.endsWith('/x') || p.endsWith('/y'))).toEqual(
    [],
  );
  expect(s.dialogs).toEqual([]);
}

/** Every text ECharts has drawn on the chart's canvas (the tooltip, the labels), as plain strings. */
export const drawnText = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const chart of (window as unknown as W).__rws?.charts ?? [])
      for (const e of chart.getZr().storage.getDisplayList(true))
        if (typeof e.style?.text === 'string') out.push(e.style.text);
    return out;
  });
