import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { buildProfile, compare, type Inputs, parseBaseline } from '../../../scripts/lib/capacity-egress.ts';
import { instrument } from './clean.ts';
import { searchBox, searchButton, slider } from './helpers.ts';

// P12a (issue #27, criterion 6): the egress profile. One cold-cache visit to the map (a fresh context: no HTTP cache,
// no service worker): open the map, zoom, pan, open 2 station panels, 5 timebar steps and 1 day of playback. Every
// finished request is measured with request.sizes() (headers and body as transferred, i.e. compressed bytes on the
// wire) and summed per class (scripts/lib/capacity-egress.ts). The profile goes to EGRESS_OUT (default
// test-results/egress-profile.json) and is compared with the committed docs/capacity-egress.json: more than 1.2 x the
// baseline in total or in a class fails. EGRESS_UPDATE=1 writes the baseline instead (the owner's inputs are kept).
// Compose mode only (E2E_COMPOSE=1 E2E_SPEC=egress, the loadtest job before k6); the compose tiles are a Lobith
// fixture, so the number is a regression guard, not the production figure.

test.skip(process.env.E2E_COMPOSE !== '1', 'needs the compose stack (E2E_COMPOSE=1)');
test.use({ baseURL: process.env.E2E_COMPOSE_URL ?? 'https://rivierstanden.example' });

const BASELINE = fileURLToPath(new URL('../../../docs/capacity-egress.json', import.meta.url));
const NOTE =
  'Compose stack: the tiles are a Lobith fixture and the data a synthetic seed, so this is a regression guard, not a production forecast of the bytes.';
/** The assumptions a first baseline starts with (the owner confirms them and fills in A3 in the JSON). */
const DEFAULT_INPUTS: Inputs = {
  uplink_mbit_s: null,
  quota_tb: null,
  flood_sessions_per_hour: 20_000,
  flood_hours_per_day: 12,
  flood_days_per_month: 3,
  normal_sessions_per_day: 3_000,
  burst_factor: 2,
};

/** The timebar's instant (the slider's value is epoch ms; the URL has no t in live mode). */
const clock = async (page: Page) => Number(await slider(page).inputValue());

test('one cold-cache map session stays within 1.2 x the committed egress baseline', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const log = await instrument(page, context, baseURL);
  const pending: Promise<{ url: string; size: number } | null>[] = [];
  context.on('requestfinished', (r) => {
    pending.push(
      r.sizes().then(
        (s) => ({
          url: r.url(),
          size: s.requestHeadersSize + s.requestBodySize + s.responseHeadersSize + s.responseBodySize,
        }),
        () => null,
      ),
    );
  });

  // Open the map.
  await page.goto('/');
  const canvas = page.locator('canvas.maplibregl-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Zoom and pan (the production build has no test hook: the mouse does it).
  const box = (await canvas.boundingBox()) ?? { x: 0, y: 0, width: 800, height: 600 };
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let n = 0; n < 3; n++) await page.mouse.wheel(0, -300);
  await page.waitForLoadState('networkidle');
  await page.mouse.down();
  await page.mouse.move(cx - 200, cy + 100, { steps: 12 });
  await page.mouse.up();
  await page.waitForLoadState('networkidle');

  // Two station panels (the first and the second search result).
  for (const nth of [0, 1]) {
    await searchButton(page).click();
    const search = searchBox(page);
    await search.fill('a');
    await page.getByRole('option').nth(nth).click();
    await expect(page.locator('aside')).toBeVisible();
    await page.waitForLoadState('networkidle');
  }

  // Five slider steps.
  await slider(page).focus();
  for (let n = 0; n < 5; n++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForLoadState('networkidle');
  }

  // One day of playback: Play until the timebar has advanced 24 h (or the end of the data stops it).
  await page.keyboard.press('PageDown');
  await page.waitForLoadState('networkidle');
  const start = await clock(page);
  await page.getByRole('button', { name: 'Afspelen', exact: true }).click();
  await expect
    .poll(
      async () => {
        const playing = await page.getByRole('button', { name: 'Pauzeren', exact: true }).isVisible();
        return !playing || (await clock(page)) - start >= 24 * 3_600_000;
      },
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(true);
  if (await page.getByRole('button', { name: 'Pauzeren', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Pauzeren', exact: true }).click();
  await page.waitForLoadState('networkidle');
  // Playback really ran (a Play that did nothing would understate the profile).
  expect((await clock(page)) - start).toBeGreaterThanOrEqual(3_600_000);

  // Invariant 7: every request of the session is same-origin (instrument() aborts and logs any other).
  expect(log.requests.filter((u) => !u.startsWith('data:') && new URL(u).origin !== log.origin)).toEqual([]);

  const sizes = (await Promise.all(pending)).filter(
    (s): s is { url: string; size: number } => s !== null && !s.url.startsWith('data:'),
  );
  const profile = buildProfile(sizes, NOTE, new Date().toISOString());
  const out = resolve(process.env.EGRESS_OUT ?? 'test-results/egress-profile.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`egress profile ${out}: ${JSON.stringify(profile.bytes)} total ${profile.total_bytes} B`);
  expect(profile.total_bytes).toBeGreaterThan(0);

  if (process.env.EGRESS_UPDATE === '1') {
    let inputs = DEFAULT_INPUTS;
    try {
      inputs = parseBaseline(readFileSync(BASELINE, 'utf8')).inputs;
    } catch {
      // no baseline yet
    }
    writeFileSync(BASELINE, `${JSON.stringify({ ...profile, inputs }, null, 2)}\n`);
    return;
  }
  const baseline = parseBaseline(readFileSync(BASELINE, 'utf8'));
  const verdict = compare(profile, baseline);
  console.log(verdict.lines.join('\n'));
  // A provisional baseline is a local estimate (a different tile fixture than compose's): report, never fail, until the
  // lead commits this run's profile (EGRESS_UPDATE=1, or `node scripts/lib/capacity-egress.ts --adopt <profile>`).
  if (baseline.provisional) return;
  expect(verdict.ok, verdict.lines.join('\n')).toBe(true);
});
