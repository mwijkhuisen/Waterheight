import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, test } from '@playwright/test';
import { parse } from 'yaml';
import { finish, msg, start } from './helpers.ts';

// P10b (plan C6), the PUBLIC site on Chromium, Firefox and WebKit: the Sources page holds, for every public source of
// registry/sources.yaml and every credit text and language variant it has, that text as the licence asks for it: where
// the licence asks for a date (needs_last_updated, needs_retrieval_date) the date takes the place of the registry's
// placeholder, or follows the text; where it asks for none the text stands as it is. Each credit is in its own language
// (lang), links to the credit's URL when it has one, and says "suggested, not required" when it is no duty. No placeholder
// is left on the page, and no source that is not public appears on it.
//
// The dates are those the e2e seed gives the sources (apps/server/test/e2e/public-seed.ts, read by the publisher from
// source_health): the French sources their newest value of 25 October 2026 (Amsterdam day), the Swiss ones their last
// fetch on 26 October 2026, DE-6 the provider's own "Stand: 26.10.2026 09:30" (Berlin time). The other languages' pages
// show the same dates in their own words.

interface RegistrySource {
  id: string;
  audience: string;
  attribution_text: string | null;
  attribution_lang: string | null;
  attribution_url: string | null;
  attribution_required: boolean | null;
  attribution_variants: { lang: string; text: string }[] | null;
  needs_last_updated: boolean;
  needs_retrieval_date: boolean;
}
const registry = parse(
  readFileSync(fileURLToPath(new URL('../../../registry/sources.yaml', import.meta.url)), 'utf8'),
) as { sources: RegistrySource[] };
const PUBLIC = registry.sources.filter((s) => s.audience === 'public');
/** Every source that is not public (owner and off): none may be named on a public page. */
const NOT_PUBLIC = registry.sources.filter((s) => s.audience !== 'public').map((s) => s.id);

/**
 * Public sources the e2e data does not publish (absent from the e2e /data/v1/sources.json), skipped by name with the
 * reason. None today: the e2e api syncs the whole registry, and every public source has a display licence. A public
 * source that turns up missing and is not listed here fails the spec.
 */
const NOT_PUBLISHED: Record<string, string> = {};

type Locale = 'nl' | 'en';
const LOCALES = ['nl', 'en'] as const;
const SOURCES = { nl: '/bronnen', en: '/en/sources' } as const;

/** The date a seeded source's credit shows, in a page's language. */
const DAY = {
  nl: { french: '25 oktober 2026', swiss: '26 oktober 2026' },
  en: { french: '25 October 2026', swiss: '26 October 2026' },
} as const;
const STAND = 'Stand: 26.10.2026 09:30';
function dateOf(id: string, locale: Locale): string {
  if (id === 'DE-6') return STAND;
  if (id.startsWith('FR-')) return DAY[locale].french;
  if (id.startsWith('CH-')) return DAY[locale].swiss;
  throw new Error(`the e2e seed gives ${id} no date: add it to public-seed.ts and to this spec`);
}

/** A credit as the page must show it: the placeholder replaced by the date, or the date after the text. */
function shown(text: string, date: string): string {
  if (text.includes('[date de mise à jour]')) return text.replace('[date de mise à jour]', date);
  if (text.includes('<datum>')) return text.replace('<datum>', date);
  if (text.includes('<date>')) return text.replace('<date>', date);
  if (text.includes('(Bezugsdatum)')) return text.replace('(Bezugsdatum)', `(Bezugsdatum: ${date})`);
  return `${text} (${date})`;
}

/** The credits of a source: the registry's text, then its language variants (which share the text's URL and duty). */
function creditsOf(s: RegistrySource) {
  const rows =
    s.attribution_text === null
      ? []
      : [
          {
            lang: s.attribution_lang,
            text: s.attribution_text,
            url: s.attribution_url,
            required: s.attribution_required,
          },
        ];
  for (const v of s.attribution_variants ?? [])
    rows.push({ lang: v.lang, text: v.text, url: s.attribution_url, required: s.attribution_required });
  return rows;
}
const dated = (s: RegistrySource) => s.needs_last_updated || s.needs_retrieval_date;

/** The list item of one source on the Sources page, found by its id (the "Bron-ID" definition). */
const itemOf = (main: Locator, id: string) =>
  main.locator('ul > li').filter({ has: main.page().locator('dd', { hasText: new RegExp(`^${id}$`) }) });

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === 'webkit')
    await page.addInitScript(() => {
      delete (globalThis as { Temporal?: unknown }).Temporal;
    });
});

for (const locale of LOCALES)
  test(`every public source's credits are on the Sources page with their dates, in order, language and link (${locale})`, async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    const s = await start(page, context, baseURL);
    // The published file holds a date for every source whose licence asks for one (the seed's job).
    const file = (await (await request.get('/data/v1/sources.json')).json()) as {
      sources: { id: string; dateKind: string | null; date: string | null; dateText: string | null }[];
    };
    const served = new Map(file.sources.map((x) => [x.id, x]));
    for (const x of file.sources)
      if (x.dateKind !== null) expect(x.date, `${x.id} has a date in sources.json`).not.toBeNull();
    expect(served.get('DE-6')?.dateText).toBe(STAND);

    await page.goto(SOURCES[locale]);
    await expect(page.locator('h1')).toHaveCount(1);
    const main = page.locator('main');
    await expect(main.locator('ul > li h3').first()).toBeVisible();
    expect(PUBLIC.length).toBeGreaterThanOrEqual(19);

    for (const source of PUBLIC) {
      if (!served.has(source.id)) {
        const reason = NOT_PUBLISHED[source.id];
        expect(reason, `${source.id} is public but the e2e sources.json lacks it`).toBeDefined();
        test.info().annotations.push({ type: 'skipped', description: `${source.id}: ${reason}` });
        continue;
      }
      const item = itemOf(main, source.id);
      await expect(item, source.id).toHaveCount(1);
      const credits = creditsOf(source);
      const date = dated(source) ? dateOf(source.id, locale) : undefined;
      const rows = item.locator('dd ul > li');
      await expect(rows, `${source.id}: its credits`).toHaveCount(credits.length);
      const texts = await rows.locator(':scope > span:first-child').allTextContents();
      expect(texts, `${source.id}: its credits, in order`).toEqual(
        credits.map((c) => (date === undefined ? c.text : shown(c.text, date))),
      );
      for (const [i, c] of credits.entries()) {
        const row = rows.nth(i);
        const text = row.locator(':scope > span:first-child');
        // The credit's own language is marked; a link goes to its URL and nowhere else.
        if (c.lang === null) await expect(text, `${source.id} #${i} lang`).not.toHaveAttribute('lang', /.*/);
        else await expect(text, `${source.id} #${i} lang`).toHaveAttribute('lang', c.lang);
        const hrefs = await text.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
        expect(hrefs, `${source.id} #${i} link`).toEqual(c.url === null ? [] : [c.url]);
        // A credit the licence only suggests is marked as such, and a duty is not.
        const optional = row.getByText(msg(locale, 'src_optional'));
        await expect(optional, `${source.id} #${i} duty`).toHaveCount(c.required === true ? 0 : 1);
      }
    }

    // No placeholder is left on the page, and the list says "date unknown" for nobody (the introduction names the
    // words, so only the list of sources is read for them).
    const text = await main.innerText();
    expect(text).not.toMatch(/\[date de mise à jour\]|<date>|<datum>|\(Bezugsdatum\)/);
    expect(await main.locator('ul:has(> li > h3)').innerText()).not.toContain(msg(locale, 'src_date_unknown'));
    // No source that is not public is named, and no canary.
    for (const id of NOT_PUBLIC) expect(text, id).not.toMatch(new RegExp(`\\b${id}\\b`));
    expect(await page.content()).not.toContain('CANARY');
    await finish(page, s);
  });

for (const locale of LOCALES)
  test(`the dated credits read as the licences ask: Etalab, LHP and BAFU, literally (${locale})`, async ({
    page,
    context,
    baseURL,
  }) => {
    const s = await start(page, context, baseURL);
    await page.goto(SOURCES[locale]);
    await expect(page.locator('h1')).toHaveCount(1);
    const main = page.locator('main');
    await expect(main.locator('ul > li h3').first()).toBeVisible();
    const fr = DAY[locale].french;
    const ch = DAY[locale].swiss;
    const credit = (id: string) => itemOf(main, id).locator('dd ul > li > span:first-child');

    // VIGICRUES asks for its name and the date of the last update, in the credit's own words (FR-3, FR-4, FR-5).
    for (const id of ['FR-3', 'FR-4', 'FR-5'])
      await expect(credit(id), id).toHaveText(
        `Source : © VIGICRUES – www.vigicrues.gouv.fr, ${fr}, Licence Ouverte Etalab 2.0`,
      );
    // Hub'Eau's text has no placeholder: the date follows it (FR-1).
    await expect(credit('FR-1')).toHaveText(
      `Données hydrométriques : Hub'Eau / SCV – réseau Vigicrues (PHyC), Licence Ouverte Etalab 2.0 – https://hubeau.eaufrance.fr/page/api-hydrometrie (${fr})`,
    );
    // LHP: the portal's own "Stand: TT.MM.JJJJ hh:mm" on both credits, and a link to the portal on both.
    const lhp = credit('DE-6');
    await expect(lhp).toHaveCount(2);
    for (const row of await lhp.all()) await expect(row).toHaveText(/\(Stand: \d\d\.\d\d\.\d{4} \d\d:\d\d\)$/);
    await expect(itemOf(main, 'DE-6').locator('dd ul a[href="https://www.hochwasserzentralen.de"]')).toHaveCount(2);
    // BAFU: the reference date keeps its word in German; the English and Dutch credits have their own placeholders.
    for (const id of ['CH-1', 'CH-2', 'CH-3', 'CH-4', 'CH-5']) {
      const rows = credit(id);
      await expect(rows, id).toHaveCount(3);
      await expect(rows.nth(0), id).toHaveText(
        `Daten Oberflächengewässer: Abteilung Hydrologie, Bundesamt für Umwelt BAFU (Bezugsdatum: ${ch})`,
      );
      await expect(rows.nth(1), id).toHaveText(
        `Swiss river data: Federal Office for the Environment FOEN, Hydrology Division (raw, unverified data; retrieved ${ch})`,
      );
      await expect(rows.nth(2), id).toHaveText(
        `Zwitserse riviergegevens: Bundesamt für Umwelt BAFU, afdeling Hydrologie (ruwe, ongecontroleerde gegevens; opgehaald ${ch})`,
      );
    }
    // A source whose licence asks for no date says nothing of one (RWS is CC0).
    await expect(credit('NL-1')).toHaveText(
      'Waterstanden en afvoeren: Rijkswaterstaat – WaterWebservices (CC0), https://rijkswaterstaatdata.nl/waterdata/',
    );
    await finish(page, s);
  });
