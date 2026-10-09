import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { msg, type W } from './helpers.ts';

// P11b (issue #26 B3): visual regression of the reach colouring on three held playback scenes, Chromium only (the
// `visual` project; playwright.config.ts). Each is a deep link `?t=…&play=normal&mode=…` served from a committed scene
// by page.route; Play is pressed with window.__rwsPlayHold set, so the engine holds on its first hour with that hour's
// frames on screen, and the flow animation stays off (window.__rwsFlow unset). The screenshot waits for the reach
// feature-states and an idle map. Baselines are written by CI's pinned image only (the first run is red by design).
//   lowwater  the recorded Aug-Sep 2026 low water (frames of 2026-09-28 and 29), Δh mode at 2026-09-29 12:00Z;
//   flood     a synthetic wave on the Rhine, Waal, IJssel and Meuse, discharge mode at 2026-10-11 12:00Z;
//   dst       a synthetic scene over the clock change of 2026-10-25, Δh mode at 00:00Z and at 01:00Z (two shots).

const DIR = fileURLToPath(new URL('./fixtures/visual/', import.meta.url));
const read = (scene: string, name: string) => readFileSync(`${DIR}${scene}/${name}`);
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

/**
 * Serves one scene: its meta.json and stations.json, its day files (an absent day is a 404, which the page answers
 * with the frames API, itself a 404 here, so that nothing of the stand-in's seed mixes in). The clock is fixed at the
 * scene's meta.now, so that its days are settled and inside the range.
 */
async function serve(page: Page, scene: string): Promise<void> {
  const meta = JSON.parse(read(scene, 'meta.json').toString('utf8')) as { now: string };
  await page.clock.setFixedTime(new Date(meta.now));
  await page.route('**/data/v1/meta.json', (r) =>
    r.fulfill({ status: 200, headers: JSON_HEADERS, body: read(scene, 'meta.json') }),
  );
  await page.route('**/data/v1/stations.json', (r) =>
    r.fulfill({ status: 200, headers: JSON_HEADERS, body: read(scene, 'stations.json') }),
  );
  await page.route('**/data/v1/frames/**', (r) => {
    const m = /\/frames\/(\d{4}-\d{2}-\d{2})\/v(\d+)\.json$/.exec(new URL(r.request().url()).pathname);
    const file =
      m === null
        ? undefined
        : [`frames-${m[1]}-v${m[2]}.json`, `frames-${m[1]}-v${m[2]}.synthetic.json`].find((f) =>
            existsSync(`${DIR}${scene}/${f}`),
          );
    return file === undefined
      ? r.fulfill({ status: 404, body: '' })
      : r.fulfill({ status: 200, headers: JSON_HEADERS, body: read(scene, file) });
  });
  await page.route('**/api/v1/frames*', (r) => r.fulfill({ status: 404, body: '' }));
  // The stand-in's own snapshot, changes and warnings belong to another set of stations: none of them is shown here.
  await page.route(/\/(data\/v1\/(snapshot|changes|warnings|latest)|api\/v1\/(snapshot|changes|warnings))/, (r) =>
    r.fulfill({ status: 404, body: '' }),
  );
  await page.addInitScript(() => {
    (window as unknown as { __rwsPlayHold?: boolean }).__rwsPlayHold = true;
  });
}

/** Opens the deep link, presses Play, waits until the held hour's reaches are coloured and the map has drawn them. */
async function hold(page: Page, query: string, view?: { center: [number, number]; zoom: number }): Promise<void> {
  await page.goto(`/?${query}`);
  await expect(page.getByRole('slider', { name: 'Tijdlijn' })).toBeVisible();
  await page.getByRole('button', { name: msg('nl', 'play'), exact: true }).click();
  await expect(page.getByRole('button', { name: msg('nl', 'pause'), exact: true })).toBeVisible();
  // Reach feature-states: at least one reach has its paint kind `k`, and the count has stopped growing.
  const coloured = () =>
    page.evaluate(() => {
      const map = (window as unknown as W).__rws?.map;
      if (!map?.getSource('rivers')) return 0;
      const get = (f: object) => (map.getFeatureState as unknown as (f: object) => { k?: string }).call(map, f);
      const ids = new Set(
        map.querySourceFeatures('rivers', { sourceLayer: 'rivers' }).map((f) => String(f.properties.reach_id)),
      );
      return [...ids].filter((id) => get({ source: 'rivers', sourceLayer: 'rivers', id }).k !== undefined).length;
    });
  await expect.poll(coloured).toBeGreaterThan(0);
  let last = -1;
  await expect
    .poll(
      async () => {
        const n = await coloured();
        const same = n === last;
        last = n;
        return same;
      },
      { intervals: [500] },
    )
    .toBe(true);
  // One more frame at the scene's view, then idle: the tiles and the paint are done.
  await page.evaluate(
    (view) =>
      new Promise<void>((resolve) => {
        const map = (
          window as unknown as {
            __rws: {
              map: {
                once(e: string, f: () => void): void;
                jumpTo(o: unknown): void;
                getCenter(): unknown;
                getZoom(): number;
              };
            };
          }
        ).__rws.map;
        map.once('idle', resolve);
        map.jumpTo(view ?? { center: map.getCenter(), zoom: map.getZoom() });
      }),
    view,
  );
}

// The timebar's wait note ("De uurwaarden worden geladen…") is an artefact of __rwsPlayHold, not of the scene: hidden, its
// space kept, before every screenshot.
const shot = async (page: Page, name: string) => {
  await page.getByText(msg('nl', 'play_waiting'), { exact: true }).evaluate((e) => {
    e.style.visibility = 'hidden';
  });
  await expect(page).toHaveScreenshot(`${name}.png`, {
    // The timebar's clock readout is the only text that moves with the system clock; it is fixed. The caret and any
    // focus ring are off (animations: 'disabled').
    caret: 'hide',
  });
};

test('scene a: the recorded low water of 2026-09-29, 12:00Z, change in 24 hours', async ({ page }) => {
  await serve(page, 'lowwater');
  await hold(page, 't=2026-09-29T12:00Z&play=normal&mode=delta', { center: [6.6, 49.9], zoom: 6.4 });
  await shot(page, 'lowwater-delta');
});

test('scene b: a synthetic flood wave, 2026-10-11 12:00Z, discharge', async ({ page }) => {
  await serve(page, 'flood');
  await hold(page, 't=2026-10-11T12:00Z&play=normal&mode=q');
  await shot(page, 'flood-q');
});

test('scene c: the DST night of 2026-10-25, 00:00Z and 01:00Z, change in 24 hours', async ({ page }) => {
  await serve(page, 'dst');
  await hold(page, 't=2026-10-25T00:00Z&play=normal&mode=delta');
  await shot(page, 'dst-0000z');
  // The repeated local hour is a different instant with different values: its own deep link, its own screenshot.
  await hold(page, 't=2026-10-25T01:00Z&play=normal&mode=delta');
  await shot(page, 'dst-0100z');
});
