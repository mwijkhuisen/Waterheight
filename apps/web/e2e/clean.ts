import { type BrowserContext, expect, type Page } from '@playwright/test';

// The "clean page" evidence shared by the specs (invariant 7 and the CSP): every
// request that is not local is aborted and recorded, and a page passes only with
// 0 CSP violations (document events, console, blocked requests) and same-origin requests.

type W = Window & { __csp: string[] };

const CSP_CONSOLE = /Refused to|Content[- ]Security[- ]Policy/i;
// #193: WebKit 27 (Playwright 1.64) reports its own styling of every <select> as a style-src-attr violation, even of
// a static <select> on a blank page (WebKit 26 did not), and logs this generic line for it. A <select> that is gone
// again when WebKit reports it is reported on the document (CSP: a disconnected element's report goes to the
// document). In WebKit only, those events and that exact line are excused. The line names no element (and the console
// log spans navigations, the events one document), so it cannot be paired with its event; the events still fail on
// any connected element but a <select>, Chromium and Firefox stay strict, and the CSP is unchanged.
const WEBKIT_SELECT = new Set(['style-src-attr inline SELECT', 'style-src-attr inline #document']);
const WEBKIT_SELECT_LINE =
  "error: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";

export interface Log {
  origin: string;
  requests: string[];
  console: string[];
  failed: string[];
  workers: string[];
}

/** Installed before navigation: request log, abort of anything not local, CSP listeners. */
export async function instrument(page: Page, context: BrowserContext, baseURL: string | undefined): Promise<Log> {
  const origin = new URL(baseURL ?? '').origin;
  const log: Log = { origin, requests: [], console: [], failed: [], workers: [] };
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  context.on('request', (r) => log.requests.push(r.url()));
  page.on('console', (m) => log.console.push(`${m.type()}: ${m.text()}`));
  page.on('requestfailed', (r) => log.failed.push(`${r.failure()?.errorText ?? ''} ${r.url()}`));
  page.on('worker', (w) => log.workers.push(w.url()));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${(e.target as Node | null)?.nodeName ?? ''}`),
    );
  });
  return log;
}

/** 0 CSP violations (document events, console, blocked requests) and every request same-origin. */
export async function expectClean(page: Page, log: Log) {
  const webkit = page.context().browser()?.browserType().name() === 'webkit';
  const csp = await page.evaluate(() => (window as unknown as W).__csp);
  expect(csp.filter((v) => !(webkit && WEBKIT_SELECT.has(v)))).toEqual([]);
  expect(log.console.filter((l) => CSP_CONSOLE.test(l) && !(webkit && l === WEBKIT_SELECT_LINE))).toEqual([]);
  expect(log.failed.filter((l) => /BLOCKED_BY_CSP|blocked/i.test(l))).toEqual([]);
  expect(log.requests.filter((u) => !u.startsWith('data:') && new URL(u).origin !== log.origin)).toEqual([]);
}
