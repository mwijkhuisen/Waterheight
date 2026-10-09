import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { expectClean, instrument } from './clean.ts';
import { msg } from './helpers.ts';

// P10a (C5), the compose end-to-end (ci.yml job deploy, deploy/tests/e2e/run.sh): the PRODUCTION build behind the
// real caddy-owner, one browser. runtime-config says owner, the owner banner is on the page, and the page is clean
// (0 CSP violations, same-origin requests only); P10b: so is /en/about, an information page. The production build has no `window.__rws` and no fixed clock, so
// nothing here reads the map. Skipped unless E2E_OWNER_SMOKE=1 (the password is E2E_OWNER_PW, by name only).

test.skip(process.env.E2E_OWNER_SMOKE !== '1', 'needs the compose stack and caddy-owner (E2E_OWNER_SMOKE=1)');
test.use({
  baseURL: process.env.E2E_OWNER_URL ?? 'https://owner.rivierstanden.example:8443',
  httpCredentials: { username: 'owner', password: process.env.E2E_OWNER_PW ?? '' },
  ignoreHTTPSErrors: true,
});

test('the owner site says owner, shows the owner banner and stays clean', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const log = await instrument(page, context, baseURL);
  const config = await request.get('/runtime-config.json');
  expect(config.status()).toBe(200);
  // (P10b: the file also names the operator, the contact and the CDN of the pages: the compose stack's own values)
  const body = (await config.json()) as Record<string, unknown>;
  expect(body.audience).toBe('owner');
  expect(Object.keys(body).sort()).toEqual(['audience', 'cdn', 'contact', 'operator']);
  expect(config.headers()['cache-control']).toBe('private, no-store');

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Eigenaarsweergave' })).toBeVisible();
  await expect(page.getByText('Persoonlijk gebruik — niet delen', { exact: true })).toBeVisible();
  // The page itself came up (the production build has no test hook: the slider is what says so).
  await expect(page.getByRole('slider', { name: 'Tijdlijn' })).toBeVisible();
  expect(await page.evaluate(() => '__rws' in window)).toBe(false);
  await expectClean(page, log);

  // P10b: an information page of the production build is served by caddy-owner too, with the owner banner on it.
  const about = await page.goto('/en/about');
  expect(about?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1, name: msg('en', 'page_about_title') })).toBeVisible();
  await expect(page.getByRole('region', { name: msg('en', 'owner_banner_label') })).toBeVisible();
  await expect(page.getByText(msg('en', 'owner_banner'), { exact: true })).toBeVisible();
  await expectClean(page, log);
});

// P11a (issue #26 C5): the upstream chain of Eijsden on the stack's two sites, from the river release the job installs
// (deploy/tests/e2e/run.sh: the committed fixture graph; the owner publisher splits it at the BE-3 gauges). The owner
// site's chain begins with the SPW gauges of the Walloon Meuse, each with the "owner only" badge; the public site's
// has no SPW row, and its first station row is Chooz (the Walloon Meuse between is a gap row and tributary groups).
const EIJSDEN = 'nl.rws.eijsden.grens';
const CHOOZ = 'fr.sandre.B720000002';
const SPW_ROWS = ['be.spw.5447', 'be.spw.5451'];

/** The names a site publishes, by station id (the api answer the page reads). */
async function namesOf(request: APIRequestContext): Promise<Map<string, string>> {
  const res = await request.get('/api/v1/stations');
  expect(res.status()).toBe(200);
  const { stations } = (await res.json()) as { stations: { id: string; name: string }[] };
  return new Map(stations.map((s) => [s.id, s.name]));
}
const chainOf = (page: Page) =>
  page
    .locator('aside section')
    .filter({ has: page.getByRole('heading', { level: 3, name: msg('nl', 'chain_heading') }) });
const rowName = (row: Locator) => row.locator(':scope > button > span').first();

test('the owner site: the chain of Eijsden starts with the SPW gauges, in order, each marked owner only', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const log = await instrument(page, context, baseURL);
  const names = await namesOf(request);
  for (const id of SPW_ROWS) expect(names.get(id), `${id} is in the owner stations.json`).toBeTruthy();
  await page.goto(`/?s=${EIJSDEN}`);
  const chain = chainOf(page);
  await expect(chain).toBeVisible();
  // The first two rows of the whole chain (no gap or group before them), nearest first: km 553.3, then 551.0.
  const rows = chain.locator(':scope > ul > li');
  for (const [i, id] of SPW_ROWS.entries()) {
    await expect(rowName(rows.nth(i)), `row ${i + 1} is ${id}`).toHaveText(names.get(id) ?? '');
    await expect(rows.nth(i).getByText(msg('nl', 'owner_badge'), { exact: true })).toBeVisible();
  }
  // Chooz is further up the same chain.
  await expect(chain.getByRole('button', { name: names.get(CHOOZ) ?? '?' }).first()).toBeVisible();
  await expectClean(page, log);
});

test.describe('the public site of the same stack', () => {
  test.skip(process.env.E2E_COMPOSE_URL === undefined, 'needs the public site (E2E_COMPOSE_URL, run.sh)');
  // (no owner credentials: the public Caddy has none)
  test.use({ baseURL: process.env.E2E_COMPOSE_URL ?? 'https://rivierstanden.example', httpCredentials: undefined });

  test('the chain of Eijsden has no SPW row: a gap and tributary groups, then Chooz', async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const log = await instrument(page, context, baseURL);
    const names = await namesOf(request);
    expect([...names.keys()].filter((id) => id.startsWith('be.spw.'))).toEqual([]);
    expect(names.get(CHOOZ), `${CHOOZ} is in the public stations.json`).toBeTruthy();
    await page.goto(`/?s=${EIJSDEN}`);
    const chain = chainOf(page);
    await expect(chain).toBeVisible();
    // The first station row is Chooz: before it there are only gap and group rows.
    const stations = chain.locator('xpath=./ul/li[button]');
    await expect(rowName(stations.first())).toHaveText(names.get(CHOOZ) ?? '');
    await expect(chain.getByText(msg('nl', 'owner_badge'), { exact: true })).toHaveCount(0);
    await expectClean(page, log);
  });
});
