import { expect, type Page, test } from '@playwright/test';
import { PAGE_ROUTES, type RouteId } from '../src/lib/routes.ts';
import {
  expectInert,
  expectNoSeriousAxe,
  finish,
  msg,
  msgRx,
  type Session,
  slider,
  start,
  textHosts,
  where,
  XSS,
} from './helpers.ts';

// P10b acceptance (issue #25), the PUBLIC site on Chromium, Firefox and WebKit, against the e2e build under the production
// headers (the stand-in locally, the real Caddy in CI): the nine pages in both languages (the map and eight information
// pages, 18 paths) and the 404 page. Each has status 200, its <html lang>, one h1, the same footer navigation and beta
// banner, no axe finding and a clean request log. Then what is specific to a page: the language link, the keyboard, the
// official links of the disclaimer, the operator and contact of the colophon and privacy pages (what
// /runtime-config.json says in the e2e runs: apps/web/e2e/server.ts, and ci.yml's Caddy containers), the 404 of a path
// that is no page, no owner source on the public Sources and Status pages, and hostile provider text as inert text.
// The data of the Sources page is attribution.spec.ts's.

type Locale = 'nl' | 'en';
const LOCALES = ['nl', 'en'] as const;
const other = (locale: Locale): Locale => (locale === 'nl' ? 'en' : 'nl');
/** Every page of PAGE_ROUTES in both languages: 18 paths. */
const PATHS = PAGE_ROUTES.flatMap((r) => LOCALES.map((locale) => ({ id: r.id, locale, path: r[locale] })));
const PAGES = PATHS.filter((p) => p.id !== 'home');
/**
 * A tall viewport for the pages with tables (Status, Method): their frames scroll at 65 vh, and axe cannot decide the
 * colour contrast of rows that the frame clips ("partially obscured"); an undecided check proves nothing.
 */
const TALL = { width: 1024, height: 20_000 };
/** A path that is no page, per language (the 404 shells of Caddy). */
const NOT_FOUND = [
  { locale: 'nl', path: '/niet-hier-p10b' },
  { locale: 'en', path: '/en/not-here-p10b' },
] as const;
/** The view the language link must keep (the same one the map's own language test uses). */
const VIEW = '?t=2026-10-25T01:30Z&s=nl.e2e.dst&mode=q';
const OPERATOR = 'E2E Operator';
const CONTACT = 'ci@rivierstanden.example';
/** The ids of the personal-use sources and the owner canary: none may appear on a public page. */
const OWNER_ID = /\b(?:BE-3|LU-2|LU-3|LU-4|DE-2|DE-3)\b|CANARY/;

test.beforeEach(async ({ page, browserName }) => {
  // WebKit must run without Temporal to prove the polyfill path (as in app.spec.ts).
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

const titleOf = (id: RouteId, locale: Locale) => msg(locale, `page_${id}_title`);
/** The page's h1: its title, but the disclaimer's is the notice itself (the footer's line: "Geen officiële waarschuwingsdienst"). */
const h1Of = (id: RouteId, locale: Locale) => (id === 'disclaimer' ? msg(locale, 'disclaimer') : titleOf(id, locale));
const main = (page: Page) => page.locator('main');

/** The view is in: the map has its slider; a page has its h1 and no data part is still loading (or has failed). */
async function ready(page: Page, id: RouteId | null, locale: Locale) {
  if (id === 'home') {
    await expect(slider(page, locale === 'nl' ? 'Tijdlijn' : 'Timeline')).toBeVisible();
    return;
  }
  // (the static shell of /over is the map's, with its own h1, until the app mounts: wait for the page's own heading)
  await expect(page.locator('h1')).toHaveText(id === null ? msg(locale, 'not_found_heading') : h1Of(id, locale));
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('main [role="status"], main [role="alert"]')).toHaveCount(0);
  // What settles after the heading, so that nothing moves under axe or a Tab: the credits' download link of the river
  // network (once the rivers manifest is in; the public site offers it), the operator and the contact address (once
  // /runtime-config.json is in), and the station names of the travel times (until stations.json is in they are ids).
  await expect(page.locator('footer a[href^="/downloads/"]')).toHaveCount(1);
  if (id === 'colophon' || id === 'privacy' || id === 'accessibility')
    await expect(
      main(page)
        .locator('p', { hasText: `${msg(locale, 'colophon_operator')}:` })
        .first(),
    ).toBeVisible();
  if (id === 'method') await page.waitForLoadState('networkidle');
}

/** What every view has: the nine page links of the footer in its language, and the banner's link to the disclaimer. */
async function expectChrome(page: Page, locale: Locale) {
  const nav = page.getByRole('navigation', { name: msg(locale, 'footer_nav_label') });
  await expect(nav).toHaveCount(1);
  const links = nav.getByRole('link');
  await expect(links).toHaveCount(PAGE_ROUTES.length);
  expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(
    PAGE_ROUTES.map((r) => r[locale]),
  );
  expect(await links.allTextContents()).toEqual(PAGE_ROUTES.map((r) => titleOf(r.id, locale)));
  const banner = page.getByRole('link', { name: msg(locale, 'beta_banner_link'), exact: true });
  await expect(banner).toHaveCount(1);
  await expect(banner).toHaveAttribute('href', PAGE_ROUTES.find((r) => r.id === 'disclaimer')?.[locale] ?? '');
}

// ---------------------------------------------------------------- every path

for (const { id, locale, path } of PATHS)
  test(`${path}: 200, <html lang="${locale}">, one h1, the footer navigation, the banner, axe and a clean request log`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    if (id !== 'home') await page.setViewportSize(TALL);
    // (a page keeps the view in its language link: the map has its own test of that)
    const query = id === 'home' ? '' : VIEW;
    const response = await page.goto(path + query);
    expect(response?.status()).toBe(200);
    await ready(page, id, locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page).toHaveTitle(
      id === 'home' ? msg(locale, 'site_title') : `${titleOf(id, locale)} · ${msg(locale, 'heading')}`,
    );
    if (id !== 'home') await expect(page.locator('h1')).toHaveText(h1Of(id, locale));
    await expectChrome(page, locale);
    // The language link: the same page in the other language, with the view of the URL.
    const link = page.locator('header a[hreflang]');
    await expect(link).toHaveAttribute('href', (PAGE_ROUTES.find((r) => r.id === id)?.[other(locale)] ?? '') + query);
    await expect(link).toHaveAttribute('hreflang', other(locale));
    await expect(link).toHaveText(msg(locale, 'other_language'));
    await expectNoSeriousAxe(page, undefined, id === 'home');
    await finish(page, s);
  });

for (const { locale, path } of NOT_FOUND)
  test(`${path}: a 404 with the 404 page of its language, a link home, the footer, and never its own path`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    const response = await page.goto(path + VIEW);
    expect(response?.status()).toBe(404);
    await ready(page, null, locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveText(msg(locale, 'not_found_heading'));
    await expect(page).toHaveTitle(`${msg(locale, 'not_found_heading')} · ${msg(locale, 'heading')}`);
    const home = page.getByRole('link', { name: msg(locale, 'not_found_link'), exact: true });
    await expect(home).toHaveAttribute('href', locale === 'nl' ? '/' : '/en/');
    await expectChrome(page, locale);
    // The language link of the 404 page is the other language's map, with the view.
    await expect(page.locator('header a[hreflang]')).toHaveAttribute('href', (locale === 'nl' ? '/en/' : '/') + VIEW);
    // The path is never shown (the page is the same for any path): not in the text, not anywhere in the markup.
    const word = path.split('/').pop() ?? '';
    expect(word).toMatch(/p10b$/);
    expect(await page.locator('body').innerText()).not.toContain(word);
    expect(await page.content()).not.toContain(word);
    await expectNoSeriousAxe(page, undefined, false);
    await finish(page, s);
  });

// ---------------------------------------------------------------- the language link

for (const r of PAGE_ROUTES)
  test(`the language link of ${r.nl} and ${r.en} maps each to the other and keeps t, s and mode`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    // Dutch to English and back: each click is a full page load that lands on the pair's path with the same view.
    await page.goto(r.nl + VIEW);
    let at: Locale = 'nl';
    await ready(page, r.id, at);
    for (let click = 0; click < 2; click++) {
      const to = other(at);
      await page.locator('header a[hreflang]').click();
      await expect.poll(() => where(page)).toBe(r[to] + VIEW);
      await expect(page.locator('html')).toHaveAttribute('lang', to);
      await ready(page, r.id, to);
      if (r.id !== 'home') await expect(page.locator('h1')).toHaveText(h1Of(r.id, to));
      at = to;
    }
    await finish(page, s);
  });

// ---------------------------------------------------------------- the keyboard

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex="0"]';

/** Tab until the focus is inside `inside` (a bound, so a missing tab stop fails instead of hanging). */
async function tabTo(page: Page, inside: string) {
  for (let tabs = 0; tabs < 600; tabs++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel) => document.activeElement?.closest(sel) != null, inside)) return;
  }
  throw new Error(`Tab never reached ${inside}`);
}

// (the map's keyboard is p10a.spec.ts's)
for (const { id, locale, path } of [...PAGES, ...NOT_FOUND.map((n) => ({ id: null, locale: n.locale, path: n.path }))])
  test(`${path}: Tab reaches the first link or control in <main> and the footer links, and Enter follows one`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    await page.goto(path);
    await ready(page, id, locale);
    // The first tab stop of <main> is its first link or control (nothing in it is skipped, nothing is a trap).
    await tabTo(page, 'main');
    expect(
      await page.evaluate(
        (sel) => document.activeElement === document.querySelector('main')?.querySelector(sel),
        FOCUSABLE,
      ),
    ).toBe(true);
    // Then the footer's page links: the first stop is the map's.
    await tabTo(page, 'footer nav');
    const hrefOfFocus = () => page.evaluate(() => document.activeElement?.getAttribute('href') ?? '');
    expect(await hrefOfFocus()).toBe(PAGE_ROUTES[0]?.[locale]);
    // Enter on a link of another page goes there (a full page load: the path is the link's).
    let target = await hrefOfFocus();
    for (let i = 0; i < PAGE_ROUTES.length && (target === path || target === (locale === 'nl' ? '/' : '/en/')); i++) {
      await page.keyboard.press('Tab');
      target = await hrefOfFocus();
    }
    expect(PAGE_ROUTES.map((r) => r[locale])).toContain(target);
    expect(target).not.toBe(path);
    await page.keyboard.press('Enter');
    await expect.poll(() => new URL(page.url()).pathname).toBe(target);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveCount(1);
    await finish(page, s);
  });

// ---------------------------------------------------------------- page by page

for (const locale of LOCALES) {
  const route = (id: RouteId) => PAGE_ROUTES.find((r) => r.id === id)?.[locale] ?? '';

  test(`the disclaimer (${locale}): a link to an official service of each of the six countries, https, noopener, no image`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    await page.goto(route('disclaimer'));
    await ready(page, 'disclaimer', locale);
    for (const country of ['nl', 'de', 'be', 'fr', 'lu', 'ch']) {
      const item = main(page)
        .locator('li')
        .filter({ has: page.locator('strong', { hasText: msg(locale, `country_${country}`) }) });
      await expect(item, country).toHaveCount(1);
      expect(await item.locator('a[href^="https://"]').count(), `${country} has an https link`).toBeGreaterThanOrEqual(
        1,
      );
    }
    // Every external link of the page: https and never a handle on the opener. No image anywhere.
    const links = await main(page)
      .locator('a[href]')
      .evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href') ?? '', rel: a.getAttribute('rel') ?? '' })));
    const external = links.filter((l) => /^[a-z][a-z0-9+.-]*:/i.test(l.href));
    expect(external.length).toBeGreaterThanOrEqual(6);
    for (const l of external) {
      expect(new URL(l.href).protocol, l.href).toBe('https:');
      expect(l.rel.split(/\s+/), l.href).toContain('noopener');
    }
    await expect(page.locator('img')).toHaveCount(0);
    await finish(page, s);
  });

  test(`the colophon (${locale}) names the operator and a mailto link, the only link that is not https`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    await page.goto(route('colophon'));
    await ready(page, 'colophon', locale);
    await expect(main(page).locator('p', { hasText: `${msg(locale, 'colophon_operator')}: ${OPERATOR}` })).toHaveCount(
      1,
    );
    const mail = main(page).locator('a[href^="mailto:"]');
    await expect(mail).toHaveCount(1);
    await expect(mail).toHaveAttribute('href', `mailto:${CONTACT}`);
    await expect(mail).toHaveText(CONTACT);
    await expect(main(page)).not.toContainText(msg(locale, 'colophon_not_configured'));
    const hrefs = await main(page)
      .locator('a[href]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
    expect(hrefs.filter((h) => /^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('https://'))).toEqual([
      `mailto:${CONTACT}`,
    ]);
    await expect(main(page)).toContainText('PolyForm Strict License 1.0.0');
    await expect(page.locator('img')).toHaveCount(0);
    await finish(page, s);
  });

  test(`the privacy page (${locale}) states the log masks (/24, /48), the 14 days, the operator and "no CDN"`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    await page.goto(route('privacy'));
    await ready(page, 'privacy', locale);
    await expect(main(page)).toContainText('/24');
    await expect(main(page)).toContainText('/48');
    await expect(main(page)).toContainText(/\b14\b/);
    // The sentence itself, from the page's own message (the numbers come from policy.ts, held to the Caddy files).
    await expect(
      main(page).locator('p', { hasText: msgRx(locale, 'privacy_log_mask', { ipv4: 24, ipv6: 48, days: 14 }) }),
    ).toHaveCount(1);
    await expect(main(page)).toContainText(`${msg(locale, 'colophon_operator')}: ${OPERATOR}`);
    await expect(main(page).locator(`a[href="mailto:${CONTACT}"]`)).toHaveCount(1);
    // /runtime-config.json says cdn "" in the e2e runs: the page says there is none.
    await expect(main(page)).toContainText(msg(locale, 'privacy_cdn_none'));
    await finish(page, s);
  });

  test(`the public Sources and Status pages (${locale}) show no owner source; Status says how many there are`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    await page.goto(route('sources'));
    await ready(page, 'sources', locale);
    // (the list has come in: a public source is on it)
    await expect(main(page).locator('dd', { hasText: /^NL-1$/ })).toHaveCount(1);
    expect(await main(page).innerText()).not.toMatch(OWNER_ID);
    expect(await page.content()).not.toMatch(OWNER_ID);
    await expect(page.getByText(msg(locale, 'owner_badge'))).toHaveCount(0);

    await page.goto(route('status'));
    await ready(page, 'status', locale);
    // The public file counts the personal-use sources, and the page says how many are healthy, without naming one.
    await expect(main(page).locator('p', { hasText: msgRx(locale, 'stat_owner_line') })).toHaveCount(1);
    // The sources it lists are the public ones, each with its state.
    const rows = main(page).locator('table').first().locator('tbody th[scope="row"]');
    await expect(rows.first()).toBeVisible();
    const ids = await rows.allTextContents();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids).toEqual(expect.arrayContaining(['DE-6', 'FR-3', 'CH-1']));
    expect(await main(page).innerText()).not.toMatch(OWNER_ID);
    expect(await page.content()).not.toMatch(OWNER_ID);
    await expect(page.getByText(msg(locale, 'owner_badge'))).toHaveCount(0);
    // A seeded source says "ok", and its newest value is a moment, not "n/a".
    const fr3 = main(page).locator('tbody tr', { has: page.locator('th', { hasText: /^FR-3$/ }) });
    await expect(fr3.locator('td').first()).toHaveText(msg(locale, 'stat_status_ok'));
    await expect(fr3.locator('td').nth(2)).not.toHaveText(msg(locale, 'stat_na'));
    await finish(page, s);
  });
}

// ---------------------------------------------------------------- hostile text

/** Serves a changed copy of a published file (uncompressed: Caddy serves the precompressed .zst to Firefox, and route.fetch() does not decode zstd). */
async function patchJson(page: Page, glob: string, edit: (body: Record<string, unknown>) => void) {
  await page.route(glob, async (route) => {
    const res = await route.fetch({ headers: { ...route.request().headers(), 'accept-encoding': 'identity' } });
    const body = (await res.json()) as Record<string, unknown>;
    edit(body);
    await route.fulfill({ response: res, json: body });
  });
}

type SourceEntry = {
  id: string;
  name: string;
  provider: string;
  licence: { kind: string | null };
  attribution: { text: string }[];
  dateText: string | null;
};
type Reach = { names: { nl: string; en: string }; after_permission: string[]; none_publishes: string[] };

async function withHostileFiles(page: Page) {
  // A source's name, provider, licence kind, credit and date text, and (status.json) a reach's name and its agencies.
  await patchJson(page, '**/data/v1/sources.json', (body) => {
    const by = (id: string) => (body.sources as SourceEntry[]).find((x) => x.id === id);
    const nl1 = by('NL-1');
    const ch1 = by('CH-1');
    const de6 = by('DE-6');
    if (!nl1 || !ch1 || !de6) throw new Error('the e2e sources.json lacks NL-1, CH-1 or DE-6');
    nl1.name = XSS;
    nl1.provider = XSS;
    nl1.attribution[0] = { ...nl1.attribution[0], text: XSS };
    ch1.licence.kind = XSS;
    de6.dateText = XSS;
  });
  await patchJson(page, '**/data/v1/status.json', (body) => {
    const reach = (body.forecastCoverage as { reaches: Reach[] }).reaches[0];
    if (!reach) throw new Error('the e2e status.json has no reach');
    reach.names = { nl: XSS, en: XSS };
    reach.after_permission = [XSS];
    reach.none_publishes = [XSS];
  });
}

for (const locale of LOCALES)
  test(`hostile provider text is shown as text on the Sources and Method pages (${locale})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s: Session = await start(page, context, baseURL);
    await withHostileFiles(page);
    await page.goto(PAGE_ROUTES.find((r) => r.id === 'sources')?.[locale] ?? '');
    await ready(page, 'sources', locale);
    // name, provider, credit (NL-1), licence kind (CH-1) and the DE-6 date text in its two credits: text nodes, no element.
    expect((await textHosts(page, XSS)).length).toBeGreaterThanOrEqual(6);
    await expectInert(page, s);
    await expectNoSeriousAxe(page, undefined, false);

    await page.goto(PAGE_ROUTES.find((r) => r.id === 'method')?.[locale] ?? '');
    await ready(page, 'method', locale);
    expect((await textHosts(page, XSS)).length).toBeGreaterThanOrEqual(2);
    await expectInert(page, s);
    await finish(page, s);
  });
