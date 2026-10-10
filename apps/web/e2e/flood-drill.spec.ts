import { expect, type Locator, test } from '@playwright/test';
import { expectClean, instrument } from './clean.ts';
import { msg, panelOf } from './helpers.ts';

// P12a (issue #27): the flood scene of the drill on the compose stack (deploy/tests/flood/run.sh, E2E_COMPOSE=1
// E2E_SPEC=flood-drill, Chromium in the pinned Playwright image, the production build behind the real Caddy). The drill
// (scripts/flood-drill.ts) has replayed its fixtures; the numbers and levels are checked by flood-check.mjs from the
// files, this is what a visitor sees of them, as two scenes with a visual baseline:
//   kaub        the station panel of Kaub (LHP class 4 of the synthetic payload, Rheinland-Pfalz operates the gauge): the
//               state "extreem" and its basis, from the agency's class;
//   bellinzona  the panel of station 2020 (the drill registry's test-only station) at the peak of the storm-Ciaran run
//               of BAFU: the forecast value of the median, the band note.
// Everything that moves with the clock or the synthetic observations (the measured value and its time, the age, the
// chart) is outside the screenshot or masked; the words and the forecast value are the drill's. The baselines are
// apps/web/e2e/visual/__screenshots__/flood-drill-*.png, written by the first run of the drill job in the pinned image
// (run.sh passes --update-snapshots while there are none) and committed from its artifact; after that a difference
// above 0.2 % of the pixels (playwright.config.ts, compose mode) fails the job. Skipped unless E2E_COMPOSE=1 and the
// drill clock is known.

const DRILL_NOW = Date.parse(process.env.DRILL_NOW ?? '');

test.skip(
  process.env.E2E_COMPOSE !== '1' || Number.isNaN(DRILL_NOW),
  'needs the compose drill stack (E2E_COMPOSE=1, DRILL_NOW)',
);
test.use({ baseURL: process.env.E2E_COMPOSE_URL ?? 'https://rivierstanden.example' });

const nl = (key: string, args: Record<string, string | number> = {}) => msg('nl', key, args);
const KAUB = 'de.wsv.25700100';
const BELLINZONA = 'ch.bafu.2020';
/** The storm's peak is 8 h 26 min 43 s after the fetch (the drill clock); the page quantises t to 10 minutes, so take the next one. */
const PEAK = DRILL_NOW + ((8 * 60 + 26) * 60 + 43) * 1000;
const T_PEAK = new Date(Math.ceil(PEAK / 600_000) * 600_000).toISOString().slice(0, 16);

/** The `dd` that follows the `dt` of a fact (the panels' definition lists). */
const fact = (scope: Locator, term: string) =>
  scope.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]');

test('the panel of Kaub says extreme from the class 4 of the LHP', async ({ page, context, baseURL }) => {
  const log = await instrument(page, context, baseURL);
  await page.goto(`/?s=${KAUB}`);
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^kaub$/i);
  // The stage series is the one a gauge class reaches: its facts hold the state and the basis.
  const stage = panel.getByRole('region', { name: nl('quantity_H') });
  const facts = stage.locator('dl');
  await expect(fact(facts, nl('panel_state'))).toContainText(nl('state_extreme'));
  await expect(fact(facts, nl('panel_basis'))).toContainText('RP:4');
  await expect(facts).toHaveScreenshot('flood-drill-kaub.png', {
    caret: 'hide',
    mask: [fact(facts, nl('measured_at')), fact(facts, nl('age'))],
  });
  await expectClean(page, log);
});

test('the panel of station 2020 shows the storm run of BAFU at its peak', async ({ page, context, baseURL }) => {
  const log = await instrument(page, context, baseURL);
  await page.goto(`/?s=${BELLINZONA}&t=${T_PEAK}Z`);
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^bellinzona$/i);
  const series = panel.getByRole('region', { name: nl('quantity_Q') });
  // The median of the figure peaks at 476.4 m3/s; the page rounds it. The note is BAFU's own wording of the band.
  await expect(series.locator('p').first()).toContainText('476');
  await expect(series).toContainText(nl('forecast_bafu_note'));
  await expect(series.locator('p').first()).toHaveScreenshot('flood-drill-bellinzona.png', { caret: 'hide' });
  await expectClean(page, log);
});
