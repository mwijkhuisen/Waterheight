import { expect, test } from '@playwright/test';
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
