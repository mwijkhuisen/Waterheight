import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { buildProfile, compare, type Inputs, parseBaseline } from '../../../scripts/lib/capacity-egress.ts';
import { instrument } from './clean.ts';
import { pickStation, searchBox, searchButton, slider } from './helpers.ts';

// P12a (issue #27, criterion 6): the egress profile. One cold-cache visit to the map (a fresh context: no HTTP cache,
// no service worker): open the map, zoom, pan, open 2 station panels, 5 timebar steps and playback to the live end, then (P20a)
// a search for a lake gauge and a zoom into the lake (the water-body tiles). The session has a single page load because
// every navigation would re-count the hashed assets that a real visitor's HTTP cache serves (request.sizes() cannot tell
// a cache hit from a transfer); the page shells are covered by k6 (deploy/tests/loadtest/k6.js), not by this profile. Every
// finished request is measured with request.sizes() (headers and body as transferred, i.e. compressed bytes on the
// wire) and summed per class (scripts/lib/capacity-egress.ts). The profile goes to EGRESS_OUT (default
// test-results/egress-profile.json) and is compared with the committed docs/capacity-egress.json: more than 1.2 x the
// baseline in total or in a class fails. EGRESS_UPDATE=1 writes the baseline instead (the owner's inputs are kept).
// Compose mode only (E2E_COMPOSE=1 E2E_SPEC=egress, the loadtest job before k6); the compose tiles are a Lobith
// fixture, so the number is a regression guard, not the production figure.
//
// #253: the same steps load the same tiles in every run. The production build has no test hook, so the DOM, the mouse
// and the network say when a step is over: after the map's first idle (createMap.ts's `rws:map-idle` mark), each step
// ends once no request has been in flight for QUIET_MS since its action (`waitForLoadState('networkidle')` resolves at
// once after the page's first idle, so it waited for nothing, and the profile was taken while the last zoom's tiles were
// still being asked for). The camera moves are fixed: the map's zoom button (one level about the centre) instead of
// the wheel, whose zoom depends on how its events fall into frames; a drag of one mouse move (one position, no
// inertia); and prefers-reduced-motion, so MapLibre jumps instead of easing and no frame between two views asks tiles
// of its own (Play is disabled under reduced motion, so motion is allowed for the playback). Three CI runs of this
// session in one hour (loadtest run 42185747582) loaded one identical set of 32 tile ranges and totals within 0.05 %.
// What still moves is the data class: it follows the UTC hour. Play runs about 1 h 50 min, from now - 1 h 50 min to the
// live end (the slider ends at now, because the loadtest seed has no forecast on the station), and every unsettled day
// is read from the one frames/recent.json, whose span of unsettled hours grows from 48 h just after 00:00Z to 72 h just
// before it.

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
/**
 * A step is over once no request has been in flight for this long, counted from the step's action at the earliest (a
 * click's tiles are asked a frame or two later; chained fetches follow each other far faster).
 */
const QUIET_MS = 1_500;

/** The timebar's instant (the slider's value is epoch ms; the URL has no t in live mode). */
const clock = async (page: Page) => Number(await slider(page).inputValue());

/** Counts the context's requests in flight; the returned wait ends once none has been for QUIET_MS since it began. */
function quietWait(context: BrowserContext) {
  let inflight = 0;
  let last = 0;
  const change = (by: number) => () => {
    inflight += by;
    last = Date.now();
  };
  context.on('request', change(1));
  context.on('requestfinished', change(-1));
  context.on('requestfailed', change(-1));
  return () => {
    last = Date.now();
    return expect
      .poll(() => inflight === 0 && Date.now() - last >= QUIET_MS, { timeout: 30_000, intervals: [100] })
      .toBe(true);
  };
}

test('one cold-cache map session stays within 1.2 x the committed egress baseline', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const log = await instrument(page, context, baseURL);
  const settle = quietWait(context);
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
  const zoomIn = page.getByRole('button', { name: 'Inzoomen', exact: true });

  // Open the map (its camera moves jump: prefers-reduced-motion) and wait for its first idle, the `rws:map-idle` mark
  // of createMap.ts, before the quiet network counts: a slow first frame must not end the step early.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const canvas = page.locator('canvas.maplibregl-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName('rws:map-idle').length > 0);
  await settle();

  // Zoom one level and pan (the production build has no test hook: the buttons and the mouse do it).
  await zoomIn.click();
  await settle();
  const box = (await canvas.boundingBox()) ?? { x: 0, y: 0, width: 800, height: 600 };
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 200, cy + 100);
  await page.mouse.up();
  await settle();

  // Two station panels (the first and the second search result).
  for (const nth of [0, 1]) {
    await searchButton(page).click();
    const search = searchBox(page);
    await search.fill('a');
    await page.getByRole('option').nth(nth).click();
    await expect(page.locator('aside')).toBeVisible();
    await settle();
  }

  // Five slider steps.
  await slider(page).focus();
  for (let n = 0; n < 5; n++) {
    await page.keyboard.press('ArrowLeft');
    await settle();
  }

  // Playback: Play from now - 1 h 50 min until it stops by itself at the live end (the last whole hour; the 24 h bound
  // is never reached). Play is disabled under reduced motion, so motion is allowed for it.
  await page.keyboard.press('PageDown');
  await settle();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle();
  // Playback really ran (a Play that did nothing would understate the profile).
  expect((await clock(page)) - start).toBeGreaterThanOrEqual(3_600_000);

  // P20a: a lake. Reached in-page, as a visitor would: the station search opens the IJsselmeer's Krabbersgat gauge and
  // its popup marks it on the map (the search does not move the map); one drag moves the popup's tip to the centre,
  // about which the zoom button zooms (water layers are on by default and the compose rivers tiles carry `waterbodies`
  // to zoom 12). The drag starts on plain map: on the popup, the drawer or a control it would pan nothing.
  await pickStation(page, 'Krabbersgat', /Krabbersgat, IJsselmeer/);
  await expect(page.locator('aside')).toBeVisible();
  await settle();
  const tip = await page.locator('.maplibregl-popup-tip').boundingBox();
  if (tip === null) throw new Error('no popup for the lake gauge');
  /**
   * The gauge's point on the map. MapLibre places the popup with `translate(<x>px,<y>px)` at the point plus its
   * anchor's offset (12 px, StationsMap.tsx; 8 px a side at a corner), so the offset is taken off again: the anchor
   * flips (top while the gauge is near the map's top edge, bottom at the centre), the point does not.
   */
  const gaugeAt = () =>
    page.locator('.maplibregl-popup').evaluate((el) => {
      const t = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\)$/.exec(el.style.transform);
      if (t === null) throw new Error('no position on the lake gauge popup');
      const a = /maplibregl-popup-anchor-(\S+)/.exec(el.className)?.[1] ?? 'center';
      const o = a.includes('-') ? 8 : 12;
      return {
        x: Number(t[1]) - (a.endsWith('left') ? o : a.endsWith('right') ? -o : 0),
        y: Number(t[2]) - (a.startsWith('top') ? o : a.startsWith('bottom') ? -o : 0),
      };
    });
  const before = await gaugeAt();
  let from: { x: number; y: number } | undefined;
  for (const p of [
    { x: cx, y: cy },
    { x: cx, y: cy + 150 },
    { x: cx, y: cy - 150 },
    { x: cx - 150, y: cy },
  ])
    if (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('canvas.maplibregl-canvas'), p)) {
      from = p;
      break;
    }
  if (from === undefined) throw new Error('no plain map near the centre to start the drag');
  const by = { x: cx - (tip.x + tip.width / 2), y: cy - (tip.y + tip.height / 2) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y);
  await page.mouse.up();
  await settle();
  // The drag really moved the map (one that panned nothing would leave the lake's tiles out of the profile).
  const after = await gaugeAt();
  expect(
    Math.hypot(after.x - before.x - by.x, after.y - before.y - by.y),
    `the drag moved the lake gauge from (${before.x}, ${before.y}) to (${after.x}, ${after.y}), not by (${by.x}, ${by.y})`,
  ).toBeLessThanOrEqual(2);
  await zoomIn.click();
  await settle();

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
