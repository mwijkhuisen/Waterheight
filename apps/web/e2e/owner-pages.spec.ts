import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { CANARY_RENDERINGS } from '@rws/contracts';
import { parse } from 'yaml';
import { PAGE_ROUTES, type RouteId } from '../src/lib/routes.ts';
import { expectInert, expectNoSeriousAxe, finish, msg, msgRx, slider, start, XSS } from './helpers.ts';

// P10b acceptance (issue #25), the OWNER site on Chromium, Firefox and WebKit (the `owner-*` projects: the owner Caddy of
// CI, or the stand-in's owner mode locally; basic auth): the nine pages in both languages and the 404 page carry the
// owner banner and are clean against the owner host; the Sources page lists the six personal-use sources with their
// badge, their clause, their terms link and the day the terms were read (the clause of LU-3 is hostile text in the e2e
// seed and stays text), and no canary; the Status page lists their health, next to the public sources', and (the owner
// file has no counts) says nothing of "N owner sources". The owner banner itself is owner.spec.ts's.

type Locale = 'nl' | 'en';
const LOCALES = ['nl', 'en'] as const;
const PATHS = PAGE_ROUTES.flatMap((r) => LOCALES.map((locale) => ({ id: r.id, locale, path: r[locale] })));
const NOT_FOUND = [
  { locale: 'nl', path: '/niet-hier-p10b' },
  { locale: 'en', path: '/en/not-here-p10b' },
] as const;
const route = (id: RouteId, locale: Locale) => PAGE_ROUTES.find((r) => r.id === id)?.[locale] ?? '';

const registry = parse(
  readFileSync(fileURLToPath(new URL('../../../registry/sources.yaml', import.meta.url)), 'utf8'),
) as { sources: { id: string; audience: string }[] };
/** The owner-audience sources of the registry, the canary aside: the Sources page must list each the e2e data holds. */
const OWNER_IDS = registry.sources
  .filter((s) => s.audience === 'owner' && !s.id.startsWith('CANARY-'))
  .map((s) => s.id);

interface OwnerSources {
  sources: {
    id: string;
    audience: 'public' | 'owner';
    privateBasis: { clause: string; url: string; retrieved: string } | null;
    attribution: { lang: string | null; text: string }[];
  }[];
}
/** The date placeholders of the registry's credit texts (lib/attribution.ts): the text before one is fixed. */
const PLACEHOLDER = /\[date de mise à jour\]|\(Bezugsdatum\)|<date>|<datum>/;
interface OwnerStatus {
  sources: { id: string; status: 'ok' | 'degraded' | 'down' | 'unknown' }[];
}

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

const banner = (page: Page, locale: Locale) => page.getByRole('region', { name: msg(locale, 'owner_banner_label') });

async function ready(page: Page, id: RouteId | null, locale: Locale) {
  if (id === 'home') {
    await expect(slider(page, locale === 'nl' ? 'Tijdlijn' : 'Timeline')).toBeVisible();
    return;
  }
  // (the static shell of /over is the map's, with its own h1, until the app mounts: wait for the page's own heading)
  await expect(page.locator('h1')).toHaveText(
    id === null
      ? msg(locale, 'not_found_heading')
      : msg(locale, id === 'disclaimer' ? 'disclaimer' : `page_${id}_title`),
  );
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('main [role="status"], main [role="alert"]')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
}

/** The list item of one source on the Sources page, found by its id (the "Bron-ID" definition). */
const itemOf = (main: Locator, id: string) =>
  main.locator('ul > li').filter({ has: main.page().locator('dd', { hasText: new RegExp(`^${id}$`) }) });

// ---------------------------------------------------------------- every path

for (const { id, locale, path } of PATHS)
  test(`${path}: the owner banner, one h1, axe and a clean request log against the owner host`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    // A tall viewport for the pages with tables: their frames scroll at 65 vh, and axe cannot decide the colour
    // contrast of rows that the frame clips ("partially obscured").
    if (id !== 'home') await page.setViewportSize({ width: 1024, height: 20_000 });
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await ready(page, id, locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(banner(page, locale)).toBeVisible();
    await expect(banner(page, locale).getByText(msg(locale, 'owner_banner'), { exact: true })).toBeVisible();
    // The owner site is the site's own origin: every request went to it (finish checks), and the banner is not a dialog.
    await expectNoSeriousAxe(page, undefined, id === 'home');
    await finish(page, s);
  });

for (const { locale, path } of NOT_FOUND)
  test(`${path}: a 404 page with the owner banner`, async ({ page, context, baseURL }) => {
    const s = await start(page, context, baseURL);
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await ready(page, null, locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveText(msg(locale, 'not_found_heading'));
    await expect(banner(page, locale)).toBeVisible();
    await expectNoSeriousAxe(page, undefined, false);
    await finish(page, s);
  });

// ---------------------------------------------------------------- the Sources page

for (const locale of LOCALES)
  test(`the Sources page lists the personal-use sources with badge, clause, terms link and date, and no canary (${locale})`, async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const s = await start(page, context, baseURL);
    const file = (await (await request.get('/data/v1/sources.json')).json()) as OwnerSources;
    const served = new Map(file.sources.map((x) => [x.id, x]));
    await page.goto(route('sources', locale));
    await ready(page, 'sources', locale);
    const main = page.locator('main');
    const badge = msg(locale, 'owner_badge');
    const day = new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });

    let listed = 0;
    let credits = 0;
    for (const id of OWNER_IDS) {
      const source = served.get(id);
      if (source === undefined) {
        // The e2e owner tree does not publish this one: skipped by name, never silently (none today).
        test.info().annotations.push({ type: 'skipped', description: `${id}: not in the e2e owner sources.json` });
        continue;
      }
      listed++;
      const item = itemOf(main, id);
      await expect(item, id).toHaveCount(1);
      expect(source.audience, id).toBe('owner');
      expect(source.privateBasis, `${id} has a private basis`).not.toBeNull();
      const basis = source.privateBasis;
      if (basis === null) continue;
      // The badge in the heading, then the basis: the clause as text, the terms link, the day the terms were read.
      await expect(item.locator('h3').getByText(badge, { exact: true }), `${id} badge`).toHaveCount(1);
      const text = item.locator('p', { hasText: msg(locale, 'src_basis_heading') });
      await expect(text, `${id} basis`).toHaveCount(1);
      await expect(text, `${id} clause`).toContainText(basis.clause);
      await expect(text, `${id} retrieved`).toContainText(
        msg(locale, 'owner_retrieved', { date: day.format(Date.parse(basis.retrieved)) }),
      );
      const link = text.locator('a');
      await expect(link, `${id} link`).toHaveCount(1);
      await expect(link).toHaveAttribute('href', basis.url);
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expect(link).toHaveText(msg(locale, 'owner_terms_link'));
      // Their credit rows (SPW, AGE, BfG; review round 1), every row in every language, as the owner file has them
      // (LU-3 has none: "As LU-2").
      credits += source.attribution.length;
      for (const a of source.attribution) {
        const fixed = (a.text.split(PLACEHOLDER)[0] ?? '').trim();
        if (fixed !== '') await expect(item, `${id} credit ${a.lang}`).toContainText(fixed);
      }
    }
    expect(listed, 'the e2e owner sources.json holds the personal-use sources').toBeGreaterThanOrEqual(4);
    expect(credits, 'the personal-use sources have credit rows').toBeGreaterThan(0);
    // The badge is on the personal-use sources and on no other.
    await expect(main.locator('h3').getByText(badge, { exact: true })).toHaveCount(listed);
    // LU-3's clause is hostile text in the e2e seed (owner-seed.ts): text, no element.
    if (served.has('LU-3')) {
      await expect(itemOf(main, 'LU-3')).toContainText(XSS);
      await expectInert(page, s);
    }
    // A public source is listed as on the public site, with no basis.
    await expect(itemOf(main, 'NL-1').locator('p', { hasText: msg(locale, 'src_basis_heading') })).toHaveCount(0);
    // The canary source is hidden from every view.
    expect(await main.innerText()).not.toContain('CANARY');
    const html = await page.content();
    for (const c of CANARY_RENDERINGS) expect(html).not.toContain(c);
    await finish(page, s);
  });

// ---------------------------------------------------------------- the Status page

for (const locale of LOCALES)
  test(`the Status page lists the health of the personal-use sources with their badge, and has no count line (${locale})`, async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const s = await start(page, context, baseURL);
    const sources = (await (await request.get('/data/v1/sources.json')).json()) as OwnerSources;
    const owners = new Set(sources.sources.filter((x) => x.audience === 'owner').map((x) => x.id));
    const status = (await (await request.get('/data/v1/status.json')).json()) as OwnerStatus;
    await page.goto(route('status', locale));
    await ready(page, 'status', locale);
    const main = page.locator('main');
    const rows = main.locator('table').first().locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    // Every source the file lists (the canary aside) is a row, with its state in words; the badge is on the owner ones.
    const listed = status.sources.filter((x) => !x.id.startsWith('CANARY-'));
    await expect(rows).toHaveCount(listed.length);
    for (const x of listed) {
      const row = rows.filter({ has: page.locator('th', { hasText: new RegExp(`^${x.id}( |$)`) }) });
      await expect(row, x.id).toHaveCount(1);
      await expect(row.locator('td').first(), x.id).toHaveText(msg(locale, `stat_status_${x.status}`));
      await expect(row.locator('th').getByText(msg(locale, 'owner_badge'), { exact: true }), x.id).toHaveCount(
        owners.has(x.id) ? 1 : 0,
      );
    }
    // The seed gives each of the six a row (owner-seed.ts): none is missing from the page.
    const ids = new Set(listed.map((x) => x.id));
    for (const id of OWNER_IDS) expect(ids.has(id), `${id} has a health row`).toBe(true);
    // The owner file lists the sources instead of counting them, and shows both families' coverage side by side.
    await expect(main.locator('p', { hasText: msgRx(locale, 'stat_owner_line') })).toHaveCount(0);
    await expect(main.locator('th', { hasText: msg(locale, 'stat_family_public') }).first()).toBeVisible();
    await expect(main.locator('th', { hasText: msg(locale, 'stat_family_owner') }).first()).toBeVisible();
    expect(await main.innerText()).not.toContain('CANARY');
    await finish(page, s);
  });
