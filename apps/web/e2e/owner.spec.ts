import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, test } from '@playwright/test';
import { CANARY_RENDERINGS } from '@rws/contracts';
import { parse } from 'yaml';
import {
  chooseView,
  expectInert,
  expectNoSeriousAxe,
  featureState,
  finish,
  idle,
  mapReady,
  msg,
  NOW,
  open,
  panelOf,
  param,
  pickStation,
  settled,
  slider,
  start,
  type W,
  XSS,
} from './helpers.ts';

// P10a (T12, C19): the OWNER site on Chromium, Firefox and WebKit (the `owner-*` projects: baseURL = the owner Caddy of CI,
// or the stand-in's owner mode locally; basic auth). The owner tree is synthetic (apps/server/test/e2e/owner-seed.ts):
//   be.spw.1046         a BE-3 stage series with values (owner source);
//   lu.age.bigonville   an LU-3 forecast run with a 10-90 % band and an LU-4 orange threshold on its stage series;
//   LU-3's private_basis clause is the XSS string; the canary source (value 777777.777) is hidden from every view.
// The banner is persistent on every view, its details list every owner source of registry/sources.yaml but the canary,
// each with its clause as text and its link only when https; the "owner only" badge sits on the owner station, band and
// threshold; the canary is nowhere (the page, the charts' options); requests go to the owner origin only; 0 CSP
// violations; axe finds nothing on the owner map view. (The public projects assert the opposite: p10a.spec.ts.)

const OWNER_STATION = 'be.spw.1046';
const LU_STATION = 'lu.age.bigonville';
const HOUR = 3_600_000;
const at = (hours: number) => `${new Date(NOW.getTime() + hours * HOUR).toISOString().slice(0, 16)}Z`;

interface RegistrySource {
  id: string;
  audience: string;
  private_basis: { clause: string; url: string; retrieved: string } | null;
}
const registry = parse(
  readFileSync(fileURLToPath(new URL('../../../registry/sources.yaml', import.meta.url)), 'utf8'),
) as { sources: RegistrySource[] };
/** The owner-audience sources of the registry, the canary aside: what the banner must list. */
const OWNER_SOURCES = registry.sources.filter((s) => s.audience === 'owner' && !s.id.startsWith('CANARY-'));
/** The e2e seed replaces LU-3's clause with hostile text (owner-seed.ts): the banner must show it as text. */
const clauseOf = (s: RegistrySource) =>
  s.id === 'LU-3' ? `Personal use only ${XSS}` : (s.private_basis?.clause ?? '');

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

for (const locale of ['nl', 'en'] as const) {
  const home = locale === 'nl' ? '/' : '/en/';
  const slide = locale === 'nl' ? undefined : 'Timeline';

  test(`the owner banner is on the map and the table view and lists every owner source (${locale.toUpperCase()})`, async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const s = await start(page, context, baseURL, 'state');
    // (P10b: the file also names the operator and contact of the pages, and the CDN; their values are pages.spec.ts's)
    const config = (await (await request.get('/runtime-config.json')).json()) as Record<string, unknown>;
    expect(config.audience).toBe('owner');
    expect(Object.keys(config).sort()).toEqual(['audience', 'cdn', 'contact', 'operator']);
    await open(page, home, slide);
    await mapReady(page);
    const banner = page.getByRole('region', { name: msg(locale, 'owner_banner_label') });
    await expect(banner).toBeVisible();
    // P10e: a slim strip directly under the bar
    const bar = await page.getByRole('banner').boundingBox();
    const strip = await banner.boundingBox();
    expect(strip?.y ?? 0).toBeGreaterThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0) - 1);
    await expect(banner.getByText(msg(locale, 'owner_banner'), { exact: true })).toBeVisible();
    // Not dismissible: no button in it but the native disclosure.
    await expect(banner.getByRole('button')).toHaveCount(0);

    // The terms of every owner source (the canary is not one of them), each clause as text.
    await banner.locator('summary').click();
    const items = banner.locator('li');
    await expect(items).toHaveCount(OWNER_SOURCES.length);
    for (const source of OWNER_SOURCES) {
      const item = items.filter({ hasText: new RegExp(`^${source.id} `) });
      await expect(item, source.id).toHaveCount(1);
      await expect(item).toContainText(clauseOf(source));
      await expect(item).toContainText(msg(locale, 'owner_retrieved', { date: source.private_basis?.retrieved ?? '' }));
    }
    await expect(banner).not.toContainText('CANARY');
    // The clause that holds the XSS string is inert: text, no element, no dialog.
    await expect(banner.locator('li', { hasText: 'LU-3' })).toContainText(XSS);
    await expectInert(page, s);
    // Links: https only, and never opening with a handle on the opener.
    const links = await banner
      .locator('a')
      .evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href') ?? '', rel: a.getAttribute('rel') ?? '' })));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(new URL(l.href).protocol).toBe('https:');
      expect(l.rel).toContain('noopener');
      expect(l.rel).toContain('noreferrer');
    }

    // The banner stays on the table view and with a station open.
    await chooseView(page, 'table', locale);
    await expect(page.locator('table')).toHaveCount(1);
    await expect(banner).toBeVisible();
    await pickStation(page, 'BIERGES', /BIERGES/, locale);
    await expect(panelOf(page)).toHaveCount(1);
    await expect(banner).toBeVisible();
    await finish(page, s);
  });
}

test('the "owner only" badge is on the BE-3 station: the map, the table, the panel, the popup and the legend', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const badge = msg('nl', 'owner_badge');
  await open(page, `/?s=${OWNER_STATION}`);
  await mapReady(page);
  await expect.poll(() => featureState(page, OWNER_STATION)).toMatchObject({ has: true, owner: true, selected: true });
  // The panel: the series heading, and the value is shown (the seed's stage series).
  const panel = panelOf(page);
  // (a BE-3 station has a stage and a discharge series: each heading carries it)
  await expect(panel.getByRole('heading', { level: 3 }).filter({ hasText: badge }).first()).toBeVisible();
  expect(await panel.getByRole('heading', { level: 3 }).filter({ hasText: badge }).count()).toBe(2);
  await expect(panel.locator('p > strong').first()).not.toHaveText(badge);
  // The popup says it in words (a ring is never the only cue), and the legend has its key.
  await expect(page.locator('.maplibregl-popup-content > p').last()).toContainText(badge);
  // (the legend starts collapsed, P10d KG-251: opened to read its key)
  const mapLegend = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: msg('nl', 'legend_heading') }) });
  await mapLegend.locator('summary').click();
  await expect(mapLegend.getByText(msg('nl', 'legend_owner'))).toBeVisible();
  // The table row.
  await chooseView(page, 'table');
  const row = page.locator('table tbody tr', { has: page.locator('button[aria-pressed="true"]') });
  await expect(row).toHaveCount(2); // its stage and its discharge series
  await expect(row.first().locator('td').last()).toContainText(badge);
  // The badge is on the rows of owner sources and on no other (the page lists both kinds).
  const owners = new Set(OWNER_SOURCES.map((o) => o.id));
  const sourceOf = (rows: Locator) => rows.locator('td:nth-child(3)').allTextContents();
  const flagged = await sourceOf(page.locator('table tbody tr', { hasText: badge }));
  expect(flagged.length).toBeGreaterThanOrEqual(2);
  expect(flagged.filter((id) => !owners.has(id))).toEqual([]);
  expect(
    (await sourceOf(page.locator('table tbody tr', { hasNotText: badge }))).filter((id) => owners.has(id)),
  ).toEqual([]);
  await finish(page, s);
});

test('the LU-3 band and the LU-4 threshold of an LU-1 series carry the badge in the panel and the chart', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const badge = msg('nl', 'owner_badge');
  // After now: the LU-3 forecast with its band (owner source), on a public LU-1 station.
  await open(page, `/?t=${at(2)}&s=${LU_STATION}`);
  await settled(page);
  const level = panelOf(page).getByRole('region', { name: msg('nl', 'quantity_H') });
  await expect(level.locator('dt', { hasText: msg('nl', 'forecast_band_label') })).toBeVisible();
  await expect(level.locator('dd', { hasText: /10–90 %/ })).toBeVisible();
  await expect(level.getByText(badge).first()).toBeVisible();
  const chartNames = () =>
    page.evaluate(() => {
      const option = [...((window as unknown as W).__rws?.charts ?? [])][0]?.getOption();
      return {
        series: (option?.series ?? []).map((x) => x.name ?? ''),
        lines: (option?.series ?? []).flatMap((x) => x.markLine?.data?.map((d) => d.name ?? '') ?? []),
      };
    });
  // (the run's name is its agency, AGE, its issue time and the badge, in the legend and the tooltip alike)
  await expect.poll(async () => (await chartNames()).series.filter((n) => n.includes('AGE')).length).toBe(2);
  expect((await chartNames()).series.filter((n) => n.includes('AGE')).every((n) => n.includes(badge))).toBe(true);

  // The threshold (LU-4 orange, 450 cm) is a line of the chart, labelled with the badge.
  await page.goto(`/?s=${LU_STATION}`);
  await expect(slider(page)).toBeVisible();
  await settled(page);
  await expect.poll(async () => (await chartNames()).lines.filter((l) => l.includes(badge)).length).toBe(1);
  expect((await chartNames()).lines.filter((l) => l.includes('e2e orange'))).toHaveLength(1);
  await finish(page, s);
});

test('the canary is nowhere: not a station, not a value, not in the page or any chart option', async ({
  page,
  context,
  baseURL,
  request,
}) => {
  const s = await start(page, context, baseURL, 'state');
  const leaks = (text: string) => CANARY_RENDERINGS.filter((c) => text.includes(c));
  const answers: string[] = [];
  const pending: Promise<void>[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/'))
      pending.push(
        r.text().then(
          (t) => void answers.push(t),
          () => {},
        ),
      );
  });
  // The owner tree itself (the page reads these files) holds the canary's series? It must not list its station.
  const stations = await (await request.get('/data/v1/stations.json')).text();
  expect(stations).not.toContain('CANARY');
  for (const hours of [0, 2]) {
    await open(page, hours === 0 ? '/' : `/?t=${at(hours)}`);
    await mapReady(page);
    expect(leaks(await page.content()), `the page at +${hours} h`).toEqual([]);
  }
  // The station that carries the canary's forecast run (nl.e2e.gap) shows no forecast and not its value.
  await pickStation(page, 'E2E gap', /E2E gap/);
  await expect(panelOf(page).getByRole('heading', { level: 2 })).toHaveText('E2E gap');
  await idle(page);
  expect(leaks(await page.content())).toEqual([]);
  // Every chart's option, serialised, in both views of the owner stations.
  for (const [id, name] of [
    [OWNER_STATION, 'BIERGES'],
    [LU_STATION, 'Bigonville'],
  ] as const) {
    await pickStation(page, name, new RegExp(name));
    await expect.poll(() => param(page, 's')).toBe(id);
    await expect(page.locator('aside')).toHaveCount(1);
    await idle(page);
    const options = await page.evaluate(() =>
      JSON.stringify([...((window as unknown as W).__rws?.charts ?? [])].map((c) => c.getOption())),
    );
    expect(leaks(options), `chart options of ${id}`).toEqual([]);
  }
  await chooseView(page, 'table');
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  expect(leaks(await page.locator('body').innerText())).toEqual([]);
  expect(await page.locator('table tbody tr', { hasText: 'CANARY' }).count()).toBe(0);
  // The owner API does carry the canary (its output is the owner's); the page, which hides the source, shows none of it.
  await Promise.all(pending);
  expect(leaks(answers.join('\n')).length).toBeGreaterThan(0);
  await finish(page, s);
});

test('axe finds no serious or critical issue on the owner map view with its banner open', async ({
  page,
  context,
  baseURL,
}) => {
  const s = await start(page, context, baseURL, 'state');
  // P10e: the open terms scroll inside the strip (30 % of the window's height), and axe cannot decide the colour contrast
  // of list items that a scroll area clips; a tall window shows them all.
  await page.setViewportSize({ width: 1024, height: 2000 });
  await open(page, `/?s=${OWNER_STATION}`);
  await mapReady(page);
  await page
    .getByRole('region', { name: msg('nl', 'owner_banner_label') })
    .locator('summary')
    .click();
  await expect(
    page
      .getByRole('region', { name: msg('nl', 'owner_banner_label') })
      .locator('li')
      .first(),
  ).toBeVisible();
  await expectNoSeriousAxe(page, undefined, false);
  expect(param(page, 's')).toBe(OWNER_STATION);
  await finish(page, s);
});
