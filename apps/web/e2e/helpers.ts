import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { type BrowserContext, expect, type Locator, type Page } from '@playwright/test';
import { expectClean, instrument, type Log } from './clean.ts';

// Helpers of the P10a specs (p10a, owner, no-webgl2, cvd): the "clean page" session, the e2e build's test hook
// (`window.__rws`), axe, and the message catalogue read from the same JSON the page is built from (so a wording
// change moves the page and the specs together).

export const NOW = new Date('2026-10-26T12:00:00Z');
/** The hostile text of the seeds (apps/server/test/e2e/public-seed.ts): it must stay text everywhere. */
export const XSS = '<img src=x onerror=alert(1)>';

/** The few MapLibre and ECharts calls the tests make inside the page. */
export interface HookMap {
  getFeatureState(f: { source: string; sourceLayer?: string; id: string }): Record<string, unknown>;
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

/** The `area` of every warning feature the map holds at the current t (jumps over Basel so its tiles are loaded). */
export async function warningAreas(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const map = (window as unknown as W).__rws?.map;
    if (!map) throw new Error('no map');
    const idle = new Promise<void>((r) => map.once('idle', r));
    map.jumpTo({ center: [7.4, 47.6], zoom: 7 });
    await idle;
    return [...new Set(map.querySourceFeatures('warnings').map((f) => String(f.properties.area)))].sort();
  });
}

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

// P11b (issue #26): playback and the reach colouring.

/** The e2e build holds playback on its first hour, that hour's frames on screen (App.tsx `ready`): set before load. */
export const playHold = (page: Page) =>
  page.addInitScript(() => {
    (window as unknown as { __rwsPlayHold?: boolean }).__rwsPlayHold = true;
  });

/** The feature-state `{k, c, w}` of a public reach (the `rivers` source promotes `reach_id`), null while unset. */
export const reachState = (page: Page, id: string) =>
  page.evaluate((id) => {
    try {
      const s = (window as unknown as W).__rws?.map?.getFeatureState({ source: 'rivers', sourceLayer: 'rivers', id });
      return s?.k === undefined ? null : (s as { k: string; c: string; w: number });
    } catch {
      return null;
    }
  }, id);
/** The feature-state of one position bin of a reach (#112 PR B: `<reach>/<i>`, source-layer `reach_bins`, zoom >= 8 only). */
export const binState = (page: Page, id: string) =>
  page.evaluate((id) => {
    try {
      const s = (window as unknown as W).__rws?.map?.getFeatureState({
        source: 'rivers',
        sourceLayer: 'reach_bins',
        id,
      });
      return s?.k === undefined ? null : (s as { k: string; c: string; w: number });
    } catch {
      return null;
    }
  }, id);
/** The kind `k` of several reaches at once (`v`, `nodata`, `tidal`, `impounded`, or null while unset). */
export const reachKinds = async (page: Page, ids: readonly string[]) =>
  Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await reachState(page, id))?.k ?? null] as const)));
/** The reach layer has painted: every one of `ids` has a feature-state. */
export const reachesPainted = (page: Page, ids: readonly string[]) =>
  expect.poll(async () => Object.values(await reachKinds(page, ids)).every((k) => k !== null)).toBe(true);

/** The static frames files (`frames/<day>/v<n>.json`, `frames/recent.json`) of a request log. */
export const FRAMES_FILE = /^\/data\/v1\/frames\/(?:\d{4}-\d{2}-\d{2}\/v\d+|recent)\.json$/;
export const FRAMES_API = '/api/v1/frames';
/** What playback must not ask: a snapshot, a latest/recent/settled file, a warnings file. */
export const SNAPSHOT_PATH =
  /^\/api\/v1\/snapshot$|^\/data\/v1\/(?:latest\.json|latest\/|recent\/|settled\/|warnings\/)/;
/** The requests of a log from index `from` on, as URLs. */
export const urlsFrom = (s: Session, from = 0) => s.log.requests.slice(from).map((u) => new URL(u));

// P11c (issue #26): the "Langs de rivier" panel. Its hook (`window.__rwsHov`, e2e build only) is not in `__rws.charts`: the
// station panels' idle check counts those against `aside div[role="img"]`, and the panel is not inside an `aside`.

/** What the tests read from the Hovmöller chart's option (hovmoller/chart.ts): the series' own data tuples. */
export interface HovOption {
  yAxis?: { data?: string[] }[];
  xAxis?: { axisLabel?: { formatter?: (v: number) => string; customValues?: number[] } }[];
  series?: { id?: string; data?: number[][] }[];
  tooltip?: { renderMode?: string }[];
}
export interface HovHook {
  chart: {
    getOption(): HovOption;
    setOption(option: unknown, opts?: unknown): void;
    getZr(): { storage: { getDisplayList(update?: boolean): { style?: { text?: unknown } }[] } };
  } | null;
  path: string;
  columns: readonly { id: string; x: number }[];
  rows: readonly string[];
  cellAt(
    id: string,
    iso: string,
  ): { bin: number | null; change: number | null; quantity: 'H' | 'Q' | null } | undefined;
  levelAt(id: string, iso: string): number | null;
  pixelOf(id: string, iso: string): [number, number] | undefined;
}
export type HovW = Window & { __rwsHov?: HovHook };
/** The river release of the e2e site (prepare-tiles.ts E2E_RIVERS). */
const HOV_RIVERS = '20261003';

/** Every text the Hovmöller chart has drawn on its canvas (axis labels, gap text, the tooltip), as plain strings. */
export const hovDrawnText = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const chart = (window as unknown as HovW).__rwsHov?.chart;
    if (chart)
      for (const e of chart.getZr().storage.getDisplayList(true))
        if (typeof e.style?.text === 'string') out.push(e.style.text);
    return out;
  });

// the panel's controls, by the page's own messages
export const hovToggle = (page: Page, locale: 'nl' | 'en' = 'nl') =>
  page.getByRole('button', { name: msg(locale, 'hov_toggle'), exact: true });
export const hovRegion = (page: Page, locale: 'nl' | 'en' = 'nl') =>
  page.getByRole('region', { name: msg(locale, 'hov_region'), exact: true });
export const hovPathSelect = (page: Page) =>
  page.getByRole('combobox', { name: msg('nl', 'hov_path_label'), exact: true });
export const hovTableToggle = (page: Page, locale: 'nl' | 'en' = 'nl') =>
  hovRegion(page, locale).getByRole('button', { name: msg(locale, 'hov_table_toggle'), exact: true });
export const hovClose = (page: Page) =>
  hovRegion(page).getByRole('button', { name: msg('nl', 'hov_close'), exact: true });

/** The hook's view of the panel: its path, columns (id, x) and rows (ISO). Null while the hook is not there. */
export const hovState = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as HovW).__rwsHov;
    return h === undefined ? null : { path: h.path, columns: h.columns.map((c) => ({ ...c })), rows: [...h.rows] };
  });
/** The chart option's series data by id (cells `[x, row, half width, bin (9 none), tidal, column]`, marker, gaps). */
export const hovSeries = (page: Page, id: string) =>
  page.evaluate((id) => {
    const o = (window as unknown as HovW).__rwsHov?.chart?.getOption();
    return o?.series?.find((s) => s.id === id)?.data ?? null;
  }, id);
export const hovYLabels = (page: Page) =>
  page.evaluate(() => (window as unknown as HovW).__rwsHov?.chart?.getOption().yAxis?.[0]?.data ?? []);
/** The drawn axis labels are the formatter's output for each column x: the full names, never the truncated drawing. */
export const hovAxisLabels = (page: Page, xs: readonly number[]) =>
  page.evaluate((xs) => {
    const o: HovOption | undefined = (window as unknown as HovW).__rwsHov?.chart?.getOption();
    const f = o?.xAxis?.[0]?.axisLabel?.formatter;
    return f === undefined ? [] : xs.map((x) => f(x));
  }, xs);

/**
 * The panel is open on `path`, its hourly values are in (no loading status) and the chart has drawn every cell of every
 * column and row.
 */
export async function hovReady(page: Page, path?: string, locale: 'nl' | 'en' = 'nl') {
  await expect(hovRegion(page, locale)).toBeVisible();
  await expect(hovRegion(page, locale).getByRole('status')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate((path) => {
        const h = (window as unknown as HovW).__rwsHov;
        const cells = h?.chart?.getOption().series?.find((s) => s.id === 'cells')?.data;
        if (h === undefined || !cells || cells.length === 0 || (path !== undefined && h.path !== path)) return false;
        return cells.length === h.columns.length * h.rows.length && cells[0]?.[0] === h.columns[0]?.x;
      }, path),
    )
    .toBe(true);
}

/** The station names the site publishes, by id (the api answer the page itself reads). */
export async function stationNames(page: Page): Promise<Map<string, string>> {
  const res = await page.request.get('/api/v1/stations');
  expect(res.status()).toBe(200);
  const { stations } = (await res.json()) as { stations: { id: string; name: string }[] };
  return new Map(stations.map((s) => [s.id, s.name]));
}
/** `km_to_nl_entry` of every station of the reaches file the page reads (the registry's chainage; + upstream, 0 at the entry). */
export async function reachKm(page: Page): Promise<Map<string, number>> {
  const res = await page.request.get(`/data/v1/rivers/reaches-${HOV_RIVERS}.json`);
  expect(res.status()).toBe(200);
  const { stations } = (await res.json()) as { stations: { id: string; km_to_nl_entry: number | null }[] };
  return new Map(stations.flatMap((s) => (s.km_to_nl_entry === null ? [] : ([[s.id, s.km_to_nl_entry]] as const))));
}

/**
 * The layout of the open "Langs de rivier" panel (P11c C13), in the chart view and in the table view, with the timebar
 * collapsed and expanded: the bar never covers the chart or the table's scroll area, and the corner (the legend, the
 * "Bronnen" button, MapLibre's attribution) stands above the panel, not over it. (The panel's own padding is under the
 * bar by design, so the boxes compared are the chart's and the table area's.)
 */
export async function expectHovLayout(page: Page, where: string, bars: readonly boolean[] = [false, true]) {
  const box = async (l: Locator) => {
    const b = await l.boundingBox();
    if (b === null) throw new Error('no box');
    return b;
  };
  const meet = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const region = hovRegion(page);
  const corner = [
    page.locator('summary', { hasText: msg('nl', 'legend_heading') }),
    page.getByRole('button', { name: msg('nl', 'sources_heading'), exact: true }),
    page.locator('.maplibregl-ctrl-attrib-button'),
  ];
  for (const view of ['chart', 'table'] as const) {
    // The view switches with the bar collapsed: the expanded bar of a 560 px window lifts the panel's head under the
    // map's control row (KG-297), which would take the click.
    const more = timebarOf(page).getByRole('button', { name: msg('nl', 'timebar_more'), exact: true });
    if ((await more.getAttribute('aria-expanded')) === 'true') await more.click();
    if ((view === 'table') !== ((await hovTableToggle(page).getAttribute('aria-pressed')) === 'true'))
      await hovTableToggle(page).click();
    const area = view === 'chart' ? region.getByRole('img') : region.getByRole('table').locator('xpath=..');
    await expect(area).toBeVisible();
    for (const expanded of bars) {
      const more = timebarOf(page).getByRole('button', { name: msg('nl', 'timebar_more'), exact: true });
      if ((await more.getAttribute('aria-expanded')) !== (expanded ? 'true' : 'false')) await more.click();
      const label = `${where}, ${view}, expanded=${expanded}`;
      // (the bar's measured height reaches the panel's padding a frame later)
      await expect
        .poll(async () => (await box(area)).y + (await box(area)).height <= (await box(timebarOf(page))).y + 1, {
          message: `${label}: the bar covers the ${view}`,
        })
        .toBe(true);
      const top = (await box(region)).y;
      for (const [i, c] of corner.entries()) {
        // Below 48rem an open station's sheet hides the map view, and MapLibre's attribution with it (CI WebKit):
        // a control that is not on screen covers nothing. The legend and "Bronnen" are always checked.
        if (i === 2 && !(await c.isVisible())) continue;
        const b = await box(c);
        expect(b.y + b.height, `${label}: a corner control is over the panel`).toBeLessThanOrEqual(top + 1);
        expect(meet(b, await box(timebarOf(page))), `${label}: a corner control is under the bar`).toBe(false);
      }
    }
  }
}
