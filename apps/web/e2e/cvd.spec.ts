import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { finish, mapReady, modeRadio, modeSummary, open, type Session, start, type W } from './helpers.ts';

// P10a (C5, plan T13 CVD): Chromium only. The map and its open legend under the three colour-vision deficiencies
// Chromium can emulate (CDP Emulation.setEmulatedVisionDeficiency), in each map mode, as screenshots in
// test-results/cvd/<deficiency>-<mode>.png (CI uploads the folder; the PR links the artifact). The assertions are only
// that the emulation took (the page still draws, the legend is open and names the mode); a person looks at the images.

const DEFICIENCIES = ['protanopia', 'deuteranopia', 'tritanopia'] as const;
const MODES = ['state', 'delta', 'q'] as const;
const DIR = 'test-results/cvd';

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

for (const deficiency of DEFICIENCIES)
  for (const mode of MODES)
    test(`${deficiency}: ${mode}`, async ({ page, context, baseURL }) => {
      const s: Session = await start(page, context, baseURL, 'state');
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setEmulatedVisionDeficiency', { type: deficiency });
      // Tall enough for the controls, the open legend and the map together in one picture.
      await page.setViewportSize({ width: 1024, height: 1500 });
      // Over the Lobith fixture, where the three test stations and Lobith itself are drawn.
      await open(page, `/?mode=${mode}&s=nl.e2e.dst`);
      await mapReady(page);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await page.evaluate(async () => {
        const map = (window as unknown as W).__rws?.map;
        if (!map) throw new Error('no map');
        const idle = new Promise<void>((r) => map.once('idle', r));
        map.jumpTo({ center: [6.1, 51.85], zoom: 11 });
        await idle;
      });
      // the legend starts collapsed (P10d, KG-251): opened for the picture
      await page.locator('summary', { hasText: 'Legenda' }).click();
      await expect(
        page.locator('details[open]').filter({ has: page.locator('summary', { hasText: 'Legenda' }) }),
      ).toBeVisible();
      // (P10e: the radios are in the mode disclosure: opened to read the choice, closed again for the picture)
      await expect(await modeRadio(page, mode)).toBeChecked();
      await page.keyboard.press('Escape');
      await expect(modeSummary(page)).toHaveText(
        `Kaart: ${mode === 'q' ? 'Afvoer' : mode === 'delta' ? 'Verandering in 24 uur' : 'Toestand'}`,
      );
      await page.screenshot({ path: `${DIR}/${deficiency}-${mode}.png` });
      await finish(page, s);
    });
