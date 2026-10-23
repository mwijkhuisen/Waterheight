import { expect, type Locator, test } from '@playwright/test';
import { expectClean, instrument } from './clean.ts';
import { msg, panelOf, pickStation } from './helpers.ts';

// P20a (issue #68): the storm scene of the drill on the compose stack (deploy/tests/storm/run.sh, E2E_COMPOSE=1
// E2E_SPEC=storm-drill, Chromium in the pinned Playwright image, the production build behind the real Caddy). The drill
// (scripts/flood-drill.ts --phase storm) has replayed the synthetic Den Helder storm: 333 cm NAP at the drill clock,
// astro 83 plus surge 250, above the NL-4 band "Stormvloed (> 260cm)". The numbers are checked by storm-check.mjs from
// the files; this is what a visitor sees of them. The compose stack serves the PRODUCTION build, which has no
// `window.__rws` (lib/testHook.ts, egress.spec.ts), so this reads the DOM only:
//   the popup  the surge in words, signed and marked derived ("Opzet: +250 cm (afgeleid)"), the words of the state;
//   the panel  the state "hoog" and its basis, the Waterinfo class "Stormvloed (> 260cm)" (provider text, data only).
// One locator screenshot (the popup, not the map canvas: the canvas depends on the software GL and the basemap) is the
// visual baseline apps/web/e2e/visual/__screenshots__/storm-drill-denhelder.png, written by the first run of the drill
// job in the pinned image (a missing one is written and its test fails) and committed from its artifact. Skipped
// unless E2E_COMPOSE=1 and the drill clock is known.

const DRILL_NOW = Date.parse(process.env.DRILL_NOW ?? '');

test.skip(
  process.env.E2E_COMPOSE !== '1' || Number.isNaN(DRILL_NOW),
  'needs the compose drill stack (E2E_COMPOSE=1, DRILL_NOW)',
);
test.use({ baseURL: process.env.E2E_COMPOSE_URL ?? 'https://rivierstanden.example' });

const nl = (key: string, args: Record<string, string | number> = {}) => msg('nl', key, args);
/** The first 10-minute bucket at or after the drill clock: the first one the storm row shows in. */
const T_STORM = new Date(Math.ceil(DRILL_NOW / 600_000) * 600_000).toISOString().slice(0, 16);

/** The `dd` that follows the `dt` of a fact (the panels' definition lists). */
const fact = (scope: Locator, term: string) =>
  scope.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]');

test('Den Helder on the storm day: the popup says the surge, derived; the panel the Stormvloed basis', async ({
  page,
  context,
  baseURL,
}) => {
  const log = await instrument(page, context, baseURL);
  await page.goto(`/?t=${T_STORM}Z`);
  // The one station named Marsdiep ("Den Helder, veersteiger" is another gauge).
  await pickStation(page, 'Den Helder, Marsdiep');
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^den helder, marsdiep$/i);
  const popup = page.locator('.maplibregl-popup-content');
  await expect(popup).toHaveCount(1);
  await expect(popup).toContainText(nl('popup_surge', { cm: '+250' }));
  expect(nl('popup_surge', { cm: '+250' })).toBe('Opzet: +250 cm (afgeleid)');
  const facts = panel.getByRole('region', { name: nl('quantity_H') }).locator('dl');
  await expect(fact(facts, nl('panel_state'))).toContainText(nl('state_high'));
  await expect(fact(facts, nl('panel_basis'))).toContainText('Stormvloed (> 260cm)');
  // The state mode's popup holds words only (no clock-dependent value or age).
  await expect(popup).toHaveScreenshot('storm-drill-denhelder.png', { caret: 'hide' });
  await expectClean(page, log);
});
