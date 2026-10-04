import { expect, type Page, test } from '@playwright/test';
import { expectClean, instrument, type Log } from './clean.ts';

// P9a (issue #24): the page reads /data/v1/ first and the API only as a fallback, and says so when it shows less
// than the live answer. Run against the e2e build with the files the real publisher wrote from the seeded database
// (the stand-in api.ts runs one full cycle at the fixed clock 2026-10-26T12:00Z); CI runs it through the real Caddy.

const NOW = new Date('2026-10-26T12:00:00Z');
const slider = (page: Page) => page.getByRole('slider', { name: 'Tijdlijn' });
const banner = (page: Page) => page.getByRole('status').filter({ hasText: /server/ });
const paths = (log: Log) => log.requests.map((u) => new URL(u).pathname + new URL(u).search);
const apiSnapshots = (log: Log) => paths(log).filter((p) => p.startsWith('/api/v1/snapshot'));

async function start(page: Page, context: Parameters<typeof instrument>[1], baseURL: string | undefined) {
  const log = await instrument(page, context, baseURL);
  await page.clock.setFixedTime(NOW);
  return log;
}

test('now loads from latest.json with no snapshot request to the API', async ({ page, context, baseURL }) => {
  const log = await start(page, context, baseURL);
  await page.goto('/');
  await expect(slider(page)).toHaveValue(String(NOW.getTime()));
  await expect.poll(() => paths(log)).toEqual(expect.arrayContaining(['/runtime-config.json', '/data/v1/latest.json']));
  expect(apiSnapshots(log)).toEqual([]);
  await expect(banner(page)).toHaveCount(0);
  await expectClean(page, log);
});

test('a settled t reads the settled file of its day version', async ({ page, context, baseURL }) => {
  const log = await start(page, context, baseURL);
  // The seeded data starts on 2026-10-24, so no day is settled at the real clock of the e2e api. A meta whose
  // clock is three days later settles it, and the settled file is the recent one of the same bucket.
  const real = await page.request.get('/data/v1/meta.json');
  const meta = { ...(await real.json()), now: '2026-10-29T12:00:00.000Z', dayVersions: { '2026-10-24': 2 } };
  const body = await (await page.request.get('/data/v1/recent/2026-10-24/1200.json')).text();
  await page.route('**/data/v1/meta.json', (route) => route.fulfill({ json: meta }));
  await page.route('**/data/v1/settled/2026-10-24/v2/1200.json', (route) =>
    route.fulfill({ body, contentType: 'application/json' }),
  );
  await page.goto('/?t=2026-10-24T12:00Z');
  await expect(slider(page)).toHaveValue(String(Date.parse('2026-10-24T12:00:00Z')));
  await expect.poll(() => paths(log)).toContain('/data/v1/settled/2026-10-24/v2/1200.json');
  expect(apiSnapshots(log)).toEqual([]);
  expect(paths(log).filter((p) => p.startsWith('/data/v1/recent/'))).toEqual([]);
  await expectClean(page, log);
});

test('a missing snapshot file falls back to the API', async ({ page, context, baseURL }) => {
  const log = await start(page, context, baseURL);
  await page.route('**/data/v1/recent/2026-10-26/1150.json', (route) => route.fulfill({ status: 404, body: '' }));
  const api = page.waitForResponse((r) => r.url().includes('/api/v1/snapshot?t=2026-10-26T11:50Z'));
  await page.goto('/?t=2026-10-26T11:50Z');
  expect((await api).status()).toBe(200);
  await expect(slider(page)).toHaveValue(String(Date.parse('2026-10-26T11:50:00Z')));
  await expect(banner(page)).toHaveCount(0);
  await expectClean(page, log);
});

test('Caddy’s X-Degraded stand-in is shown under its own time with the banner', async ({ page, context, baseURL }) => {
  const log = await start(page, context, baseURL);
  // The stand-in is the newest bucket: here the 11:00Z file (12:00 CET), served for the 11:50Z that was asked.
  const standIn = await (await page.request.get('/data/v1/recent/2026-10-26/1100.json')).text();
  await page.route('**/data/v1/recent/2026-10-26/1150.json', (route) => route.fulfill({ status: 503, body: '' }));
  await page.route('**/api/v1/snapshot?*', (route) =>
    route.fulfill({ body: standIn, contentType: 'application/json', headers: { 'x-degraded': '1' } }),
  );
  await page.goto('/?t=2026-10-26T11:50Z');
  await expect(banner(page)).toContainText('12:00 CET');
  await expect(banner(page)).not.toContainText('12:50');
  // The slider and the URL keep the asked t; the values are not marked as loading.
  await expect(slider(page)).toHaveValue(String(Date.parse('2026-10-26T11:50:00Z')));
  expect(new URL(page.url()).searchParams.get('t')).toBe('2026-10-26T11:50Z');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expectClean(page, log);
});

test('a future t with a dead API shows the held forecast without a state, and the banner', async ({
  page,
  context,
  baseURL,
}) => {
  const log = await start(page, context, baseURL);
  await page.route('**/api/v1/snapshot?*', (route) => route.fulfill({ status: 503, body: '' }));
  await page.goto('/?t=2026-10-26T14:00Z&s=nl.e2e.xss');
  await expect(banner(page)).toBeVisible();
  await expect.poll(() => paths(log)).toContain('/data/v1/forecast/latest.json');
  const panel = page.locator('aside');
  await expect(panel).toContainText('340');
  // No state row: the fallback computes values, never classes.
  await expect(panel.locator('dt', { hasText: /Toestand van de verwachting/ })).toHaveCount(0);
  await expectClean(page, log);
});
