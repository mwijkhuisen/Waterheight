import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { msg, open, openAttribution, panelOf } from './helpers.ts';

// P12b (plan §3.2, E1): the screenshots of the Belegexemplar notice to BfG (catalogue §0.2, DE-2): the station panel
// with the DE-2 forecast, and the credits with the registry's credit verbatim, in NL and EN, to test-results/beleg/.
// A capture tool like screens.spec.ts, on demand only (it skips itself unless E2E_DE2_BELEG=1), because it needs a site
// on which DE-2 is public: production after the flip commit (plan §9), which is the owner's real E1 run:
//   E2E_DE2_BELEG=1 E2E_BASE_URL=https://<domain> pnpm -F web e2e --project=cvd de2-beleg
// E2E_DE2_STATION picks another DE-1 station with a WV run (default Kaub). It asserts only what the notice shows: the
// forecast's agency in the panel and the credit in the credits; the looking is the owner's.

const CREDIT = 'Wasserstandsvorhersage: Bundesanstalt für Gewässerkunde (BfG)';
/** Kaub (registry/stations/de-1.yaml), a DE-1 stage series that the BfG WV forecasts. */
const STATION = process.env.E2E_DE2_STATION ?? 'de.wsv.25700100';
const OUT = join('test-results', 'beleg');

test.skip(process.env.E2E_DE2_BELEG !== '1', 'on demand: E2E_DE2_BELEG=1 against a site on which DE-2 is public');

for (const locale of ['nl', 'en'] as const) {
  test(`the DE-2 forecast panel and the BfG credit (${locale})`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    const prefix = locale === 'en' ? '/en/' : '/';
    await open(page, `${prefix}?s=${encodeURIComponent(STATION)}`, msg(locale, 'slider_label'));
    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('BfG');
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await panel.screenshot({ path: join(OUT, `${locale}-panel.png`), animations: 'disabled' });
    const credits = await openAttribution(page, locale);
    await expect(credits).toContainText(CREDIT);
    await page.screenshot({ path: join(OUT, `${locale}-page.png`), fullPage: true, animations: 'disabled' });
  });
}
