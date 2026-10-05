import { expect, test } from '@playwright/test';
import { expectClean, instrument } from './clean.ts';

// P9a, the compose end-to-end (ci.yml job deploy, deploy/tests/e2e/run.sh): with the API container stopped, Caddy
// answers /api/v1/snapshot with its stand-in (X-Degraded: 1, latest.json), and a future t shows the held forecast of
// forecast/latest.json: the map still draws and the page says it is degraded. Skipped unless E2E_COMPOSE=1; the
// stack's address is E2E_COMPOSE_URL (no web server is started in that mode: playwright.config.ts).

test.skip(process.env.E2E_COMPOSE !== '1', 'needs the compose stack (E2E_COMPOSE=1)');
test.use({ baseURL: process.env.E2E_COMPOSE_URL ?? 'https://rivierstanden.example' });

test('with the API down a future t still shows the map and the degraded banner', async ({ page, context, baseURL }) => {
  const log = await instrument(page, context, baseURL);
  const t = new Date(Math.floor((Date.now() + 3_600_000) / 600_000) * 600_000).toISOString().slice(0, 16);
  await page.goto(`/?t=${t}Z`);
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /server/ })).toBeVisible();
  await expectClean(page, log);
});
