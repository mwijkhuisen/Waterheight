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
  getFilter(layer: string): unknown;
  getLayer(id: string): { id: string; source?: string; sourceLayer?: string } | undefined;
  getStyle(): { layers: Record<string, unknown>[] };
  querySourceFeatures(source: string, o?: object): { properties: Record<string, unknown> }[];
  jumpTo(o: { center: [number, number]; zoom: number }): void;
  once(event: string, fn: () => void): void;
  project(lngLat: [number, number]): { x: number; y: number };
  getZoom(): number;
}
export interface HookChart {
  getOption():
    | {
        tooltip?: { renderMode?: string }[];
        series?: { id?: string; name?: string; data?: unknown[]; markLine?: { data?: { name?: string }[] } }[];
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
 * `status` is what /data/v1/status.json says about the default map mode: the e2e publisher writes none (a 404 means
 * the default is the change mode), so a spec that wants the state mode serves it here.
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
/** The station list; `exact`, because the panel's close button is also named "Station …". */
export const stationList = (page: Page, name = 'Station') => page.getByRole('combobox', { name, exact: true });
export const panelOf = (page: Page) => page.locator('aside');

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
