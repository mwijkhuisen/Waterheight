import { type BrowserContext, expect, type Page } from '@playwright/test';

// The "clean page" evidence shared by the specs (invariant 7 and the CSP): every
// request that is not local is aborted and recorded, and a page passes only with
// 0 CSP violations (document events, console, blocked requests) and same-origin requests.

type W = Window & { __csp: string[] };

const CSP_CONSOLE = /Refused to|Content[- ]Security[- ]Policy/i;

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
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return log;
}

/** 0 CSP violations (document events, console, blocked requests) and every request same-origin. */
export async function expectClean(page: Page, log: Log) {
  expect(await page.evaluate(() => (window as unknown as W).__csp)).toEqual([]);
  expect(log.console.filter((l) => CSP_CONSOLE.test(l))).toEqual([]);
  expect(log.failed.filter((l) => /BLOCKED_BY_CSP|blocked/i.test(l))).toEqual([]);
  expect(log.requests.filter((u) => !u.startsWith('data:') && new URL(u).origin !== log.origin)).toEqual([]);
}
