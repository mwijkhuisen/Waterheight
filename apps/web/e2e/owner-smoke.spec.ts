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
// has no SPW row and no owner badge (its French Meuse gauges may be hidden for their age in the compose archive).
const EIJSDEN = 'nl.rws.eijsden.grens';
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
  // (Not Chooz: the compose archive's French Meuse gauges are older than 25 hours, so they are hidden, #107, and the
  // chain leaves them out as the map and the table do.)
  await expectClean(page, log);
});

// P11b (issue #26 OV): hourly playback on the owner site. run.sh gives two SPW gauges synthetic hourly values (321) for
// the last 31 hours; the owner site has no static frames, so a played range is read from the owner api only, one request
// per range, and never from /data/v1/frames/. Playback from 6 hours ago runs to the end of its range (the production
// build has no hold: the engine plays at its own pace and stops at the current hour); the station panel then shows the
// SPW value with the owner badge.
test('the owner site: hourly playback reads the owner frames api only, its answer carries the SPW value, the panel the owner badge', async ({
  page,
  context,
  baseURL,
}) => {
  const log = await instrument(page, context, baseURL);
  const hour = 3_600_000;
  const t = new Date(Math.floor(Date.now() / hour) * hour - 6 * hour).toISOString().slice(0, 16);
  await page.goto(`/?t=${t}Z&s=be.spw.5447&mode=delta&play=normal`);
  await expect(page.getByRole('slider', { name: 'Tijdlijn' })).toBeVisible();
  const play = page.getByRole('button', { name: msg('nl', 'play'), exact: true });
  // Paused on the map, the page reads the frames of t's days for the travel-time shift (#112, App.tsx shiftWindow), and
  // Play drops that read (its fetch is aborted). It finishes first, so the frames answer awaited below is the
  // playback's own (#119: an aborted one has no body) and no shift read is asked twice.
  await page.waitForLoadState('networkidle');
  // The owner frames answer itself: the played hours of the seeded SPW gauges (run.sh writes 321 for be.spw.5447 and
  // be.spw.5451). After the play the page is paused and reads its snapshot, whose own freshness rules decide what the
  // panel shows, so the played value is checked in the answer the playback used.
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/frames' && r.ok(), {
    timeout: 60_000,
  });
  await play.click();
  const body = (await (await answer).json()) as {
    audience?: string;
    vlast?: (number | null)[][];
    state?: (number | null)[][];
  };
  expect(body.audience, 'an owner answer').toBe('owner');
  expect((body.vlast ?? []).flat(), 'the seeded SPW value is played').toContain(321);
  // #112: the owner answer carries each hour's state code, exactly where a value is (the owner family's own rows).
  const vlast = body.vlast ?? [];
  const state = body.state ?? [];
  expect(state.length, 'one state row per series').toBe(vlast.length);
  for (const [i, row] of vlast.entries())
    for (const [h, v] of row.entries())
      expect(state[i]?.[h] === null, `a code exactly where a value is (${i}, ${h})`).toBe(v === null);
  // The engine plays to the end of the page's range and stops by itself: t has moved and the Play button is back. The
  // end is the last whole hour of meta.now (the publisher's clock, which may trail this one past an hour boundary), so
  // t is within an hour of this clock's hour, or gone when that hour is the page's now (live). The URL follows t at
  // most once per 400 ms (useUrlState's WRITE_MS) and the engine plays an hour per 83 ms, so the played end reaches
  // the URL a moment after the Play button is back: poll it (#119: a single read saw t two or three hours short).
  await expect.poll(() => new URL(page.url()).searchParams.get('t'), { timeout: 60_000 }).not.toBe(`${t}Z`);
  await expect(play).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () => {
        const played = new URL(page.url()).searchParams.get('t');
        return played === null ? Number.POSITIVE_INFINITY : Date.parse(played);
      },
      { timeout: 5_000, message: 'the played t (live counts as the end)' },
    )
    .toBeGreaterThanOrEqual(Math.floor(Date.now() / hour) * hour - hour);
  const frames = log.requests.filter((u) => /\/(api\/v1|data\/v1)\/frames/.test(new URL(u).pathname));
  const api = frames.filter((u) => new URL(u).pathname === '/api/v1/frames');
  expect(api.length, 'the owner frames api was asked').toBeGreaterThanOrEqual(1);
  expect(new Set(api).size, 'one request per range').toBe(api.length);
  expect(
    frames.filter((u) => new URL(u).pathname.startsWith('/data/v1/frames')),
    'no static frames file',
  ).toEqual([]);
  const panel = page.locator('aside');
  await expect(panel.getByText(msg('nl', 'owner_badge'), { exact: true }).first()).toBeVisible();
  await expectClean(page, log);
});

// P11c (issue #26 OV, the Hovmöller part of the owner-view criterion): "Langs de rivier" on the Meuse, as its table (the
// production build has no test hook; the table is the panel's own accessible twin). The owner site holds the SPW gauges
// between Chooz and Eijsden as columns, each with the "owner only" badge; the two seeded gauges (run.sh: be.spw.5447, an
// H series, and be.spw.5451, discharge only: the map's Δ rule gives it the trend of its Q) have a change in the newest
// hours, and the 24 h change needs a value 24 h earlier, so only the newest six rows can have one (31 seeded hours).
// Only that a cell says something other than "no data" is asserted, never a value.
test('the owner site: the Meuse panel has the SPW columns badged, each with a change in the newest hours', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const log = await instrument(page, context, baseURL);
  const names = await namesOf(request);
  await page.goto('/?hov=meuse&mode=delta');
  const region = page.getByRole('region', { name: msg('nl', 'hov_region'), exact: true });
  await expect(region).toBeVisible();
  await region.getByRole('button', { name: msg('nl', 'hov_table_toggle'), exact: true }).click();
  const table = region.getByRole('table');
  await expect(table).toBeVisible({ timeout: 60_000 });
  for (const id of SPW_ROWS) {
    const name = names.get(id) ?? '?';
    const head = table.locator('thead th').filter({ has: page.getByRole('button', { name, exact: true }) });
    await expect(head, `${id} is a column`).toHaveCount(1);
    await expect(head).toContainText(msg('nl', 'owner_badge'));
    // The column's place in the header row is its place among a row's cells (the time header is the first).
    const at = await head.evaluate((th) => [...(th.parentElement?.children ?? [])].indexOf(th));
    const newest = async () => {
      const cells = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) =>
          table
            .locator('tbody tr')
            .nth(i)
            .locator('td')
            .nth(at - 1)
            .textContent(),
        ),
      );
      return cells.filter((c) => c !== null && c !== msg('nl', 'hov_no_data'));
    };
    // (the hourly values arrive after the table: poll until the newest rows have them)
    await expect
      .poll(async () => (await newest()).length, { timeout: 60_000, message: `${id}'s newest cells` })
      .toBeGreaterThan(0);
  }
  await expectClean(page, log);
});

test.describe('the public site of the same stack', () => {
  test.skip(process.env.E2E_COMPOSE_URL === undefined, 'needs the public site (E2E_COMPOSE_URL, run.sh)');
  // (no owner credentials: the public Caddy has none)
  test.use({ baseURL: process.env.E2E_COMPOSE_URL ?? 'https://rivierstanden.example', httpCredentials: undefined });

  test('the chain of Eijsden has no SPW row and no owner badge', async ({ page, context, baseURL, request }) => {
    const log = await instrument(page, context, baseURL);
    const names = await namesOf(request);
    expect([...names.keys()].filter((id) => id.startsWith('be.spw.'))).toEqual([]);
    await page.goto(`/?s=${EIJSDEN}`);
    await expect(page.locator('aside').getByRole('heading', { level: 2 })).toHaveText(names.get(EIJSDEN) ?? '?');
    // The archive's French Meuse gauges are hidden for their age (#107), so the public chain may be empty here; whatever
    // the panel shows holds no owner row. The public reaches file itself is checked byte for byte by run.sh.
    await expect(page.getByText(msg('nl', 'owner_badge'), { exact: true })).toHaveCount(0);
    await expectClean(page, log);
  });

  // P11c (issue #26): the public Meuse panel has the Walloon gap where the owner site has the SPW columns, and the
  // panel's requests are the page's usual ones (frames, stations, reaches): no SPW id and no canary value in any
  // JSON answer the page read with the panel open (run.sh's sweeps cover every public output; this is the browser's view).
  test('the Meuse panel has the Walloon gap column and no SPW id or canary value in what it read', async ({
    page,
    context,
    baseURL,
  }) => {
    const log = await instrument(page, context, baseURL);
    const bodies: Promise<string>[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).origin === log.origin && (r.headers()['content-type'] ?? '').includes('json'))
        bodies.push(r.text().catch(() => ''));
    });
    await page.goto('/?hov=meuse&mode=delta');
    const region = page.getByRole('region', { name: msg('nl', 'hov_region'), exact: true });
    await expect(region).toBeVisible();
    await region.getByRole('button', { name: msg('nl', 'hov_table_toggle'), exact: true }).click();
    const table = region.getByRole('table');
    await expect(table).toBeVisible({ timeout: 60_000 });
    await expect(table.locator('thead th').filter({ hasText: msg('nl', 'hov_gap_wallonia') })).toHaveCount(1);
    await expect(region.getByRole('status')).toHaveCount(0, { timeout: 60_000 });
    await expect(region.getByText(msg('nl', 'owner_badge'), { exact: true })).toHaveCount(0);
    const read = await Promise.all(bodies);
    expect(read.length, 'the page read JSON answers').toBeGreaterThan(3);
    for (const body of read) {
      expect(body).not.toContain('be.spw.');
      expect(body).not.toContain('777777.777');
    }
    await expectClean(page, log);
  });
});
