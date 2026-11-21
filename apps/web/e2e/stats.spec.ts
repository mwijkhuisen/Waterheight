import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { fillShell, productionCsp } from './headers.ts';
import { finish, start } from './helpers.ts';

// #270 part B (ADR-0024): the statistics script on the PUBLIC site, Chromium, Firefox and WebKit.
// 1. On the site under test (the stand-in locally, the real Caddy in CI) the map and an information page load the
//    vendored script from this origin, it runs, and it sends nothing: `data-domains` names waterradar.io only, so the
//    clean request log (every request same-origin, no CSP violation) holds. The owner site's check is in owner.spec.ts.
// 2. On a routed https://waterradar.io/ (no network: the page, the script and the stats host are Playwright routes), the
//    real tag under the production CSP sends exactly one page view to https://stats.waterradar.io/api/send, with the
//    page address but not its query or fragment (data-exclude-search, data-exclude-hash), none for a `?t=`
//    replaceState (what lib/url/useUrlState.ts does on every timebar step), none under Do Not Track, and the page's
//    storage and cookies stay empty.

const SCRIPT = '/assets/stats-654f12c7.js';
const shellSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
/** The tag as the public site serves it (Caddy's templates module renders its type). */
const TAG = fillShell(/^\s*(<script [^\n]*\sdata-host-url="[^"]+"[^\n]*<\/script>)$/m.exec(shellSource)?.[1] ?? '', '');
const WEBSITE = /data-website-id="([^"]+)"/.exec(TAG)?.[1];
const tracker = readFileSync(new URL(`../public${SCRIPT}`, import.meta.url));

for (const path of ['/', '/en/privacy']) {
  test(`${path}: the statistics script loads from this site, runs, and sends nothing on a host that is not waterradar.io`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === SCRIPT);
    await page.goto(path);
    expect((await loaded).status()).toBe(200);
    await expect.poll(() => page.evaluate(() => typeof (window as { umami?: unknown }).umami)).toBe('object');
    await page.waitForLoadState('load');
    expect(s.log.requests.filter((u) => u.includes('/api/send'))).toEqual([]);
    await finish(page, s);
  });
}

/** Serves https://waterradar.io/ (a page with the tag, under the production CSP), the script, and the stats host. */
async function production(page: Page, sends: { url: string; body: unknown; headers: Record<string, string> }[]) {
  const requests: string[] = [];
  page.context().on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === 'https://waterradar.io' && url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': productionCsp().replace(/; report-to csp$/, '') },
        body: `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Water Radar</title></head><body><main><h1>Water Radar</h1></main>${TAG}</body></html>`,
      });
    if (url.origin === 'https://waterradar.io' && url.pathname === SCRIPT)
      return route.fulfill({ contentType: 'text/javascript', body: tracker });
    if (url.origin === 'https://stats.waterradar.io' && url.pathname === '/api/send') {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      sends.push({ url: req.url(), body: req.postDataJSON(), headers: req.headers() });
      return route.fulfill({ contentType: 'application/json', headers: cors, body: '{"cache":"e2e"}' });
    }
    return route.abort();
  });
  return requests;
}

test('on waterradar.io it sends one page view without the query or fragment, none for a replaceState, and stores nothing', async ({
  page,
}) => {
  const sends: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const requests = await production(page, sends);
  await page.goto('https://waterradar.io/?t=2026-11-15T10:00Z&s=nl.rws.lobith#kaart');
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]?.url).toBe('https://stats.waterradar.io/api/send');
  expect(sends[0]?.headers['content-type']).toBe('application/json');
  expect(sends[0]?.headers.cookie).toBeUndefined();
  expect(sends[0]?.body).toMatchObject({
    type: 'event',
    payload: { website: WEBSITE, hostname: 'waterradar.io', url: 'https://waterradar.io/', title: 'Water Radar' },
  });
  // The timebar's replaceState of the view: the same page without its query, so no second page view (the tracker
  // waits 300 ms before one).
  await page.evaluate(() => history.replaceState(null, '', '/?t=2026-11-15T11:00Z&s=nl.rws.lobith'));
  await page.waitForTimeout(1_000);
  expect(sends).toHaveLength(1);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
  // Only the page, the script and the stats host were asked (a CORS preflight, where the browser sends one, is the
  // stats host's too; a browser may also ask for this origin's /favicon.ico, which the stub page does not name).
  expect(
    requests.filter(
      (r) =>
        !/^(GET https:\/\/waterradar\.io\/(\?|assets\/stats-|favicon\.ico$)|(POST|OPTIONS) https:\/\/stats\.waterradar\.io\/api\/send$)/.test(
          r,
        ),
    ),
  ).toEqual([]);
});

test('on waterradar.io it sends nothing when the browser says Do Not Track', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '1' }));
  const sends: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  await production(page, sends);
  await page.goto('https://waterradar.io/');
  await expect.poll(() => page.evaluate(() => typeof (window as { umami?: unknown }).umami)).toBe('object');
  await page.waitForTimeout(1_000);
  expect(sends).toEqual([]);
});
