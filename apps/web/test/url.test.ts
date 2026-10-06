import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PAGE_ROUTES, pathOf, routeOf } from '../src/lib/routes.ts';
import { MODES, otherLanguageHref, RIVER_ID, readSearch, searchOf, type UrlState } from '../src/lib/url/url.ts';

// The view lives in the URL (A§10): `?t=…&s=…`. Whatever does not parse is
// dropped, never thrown and never rendered. The React hook has no unit test
// (this project has no DOM); the Playwright tests cover it.

const T = Date.UTC(2026, 9, 25, 1, 30);
const ID = 'nl.rws.lobith.bovenrijn.tolkamer';

describe('readSearch', () => {
  it('reads a valid t and s', () => {
    expect(readSearch(`?t=2026-10-25T01:30Z&s=${ID}`)).toEqual({ t: T, s: ID });
    expect(readSearch(`t=2026-10-25T01%3A30Z&s=${ID}`)).toEqual({ t: T, s: ID });
    expect(readSearch('')).toEqual({ t: undefined, s: undefined });
  });

  it('drops an invalid t and keeps s, and the other way round', () => {
    expect(readSearch(`?t=2026-10-25T01:30&s=${ID}`)).toEqual({ t: undefined, s: ID });
    // A `+` decodes to a space, so an offset written with it is not a valid t.
    expect(readSearch('?t=2026-10-25T01:30+01:00')).toEqual({ t: undefined, s: undefined });
    expect(readSearch('?t=2026-10-25T01:30Z&s=')).toEqual({ t: T, s: undefined });
  });

  it.each([
    ['longer than 80 characters', `nl.rws.${'a'.repeat(74)}`],
    ['with a <', 'nl.rws.<script>'],
    ['with a quote', 'nl.rws.a"b'],
    ['with an uppercase country prefix', 'NL.rws.lobith'],
    ['with no source part', 'nl.lobith'],
    ['empty', ''],
  ])('drops an s %s', (_, s) => {
    expect(readSearch(`?s=${encodeURIComponent(s)}`).s).toBeUndefined();
  });

  it('keeps an s of exactly 80 characters', () => {
    const s = `nl.rws.${'a'.repeat(73)}`;
    expect(s).toHaveLength(80);
    expect(readSearch(`?s=${s}`).s).toBe(s);
  });

  it('takes the first of a repeated key and ignores unknown keys', () => {
    expect(readSearch('?s=nl.a.b&s=de.c.d')).toEqual({ t: undefined, s: 'nl.a.b' });
    expect(readSearch('?t=2026-10-25T01:30Z&t=2026-10-26T01:30Z').t).toBe(T);
    // The first one counts even when it is the invalid one.
    expect(readSearch('?s=NL.a.b&s=de.c.d').s).toBeUndefined();
    expect(readSearch(`?lang=en&x=1&t=2026-10-25T01:30Z&s=${ID}&utm=y`)).toEqual({ t: T, s: ID });
  });

  it('never throws, and returns only a grid instant and a well-formed id, for random text', () => {
    const pair = fc.tuple(fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }));
    const search = fc.oneof(
      fc.string({ unit: 'binary' }),
      pair.map(([t, s]) => `?t=${encodeURIComponent(t)}&s=${encodeURIComponent(s)}`),
      pair.map(([t, s]) => `?t=${t}&s=${s}`),
    );
    fc.assert(
      fc.property(search, (text) => {
        const { t, s } = readSearch(text);
        if (t !== undefined) expect(t % 600_000).toBe(0);
        if (s !== undefined) expect(s).toMatch(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/);
        if (s !== undefined) expect(s.length).toBeLessThanOrEqual(80);
      }),
      { numRuns: 200 },
    );
  });
});

describe('searchOf', () => {
  it('is empty for an empty state', () => {
    expect(searchOf({ t: undefined, s: undefined })).toBe('');
  });

  it('writes t with plain colons and s encoded', () => {
    expect(searchOf({ t: T, s: undefined })).toBe('?t=2026-10-25T01:30Z');
    expect(searchOf({ t: T, s: ID })).toBe(`?t=2026-10-25T01:30Z&s=${ID}`);
    expect(searchOf({ t: undefined, s: 'a b&c/d' })).toBe(`?s=${encodeURIComponent('a b&c/d')}`);
    expect(searchOf({ t: undefined, s: 'a b&c/d' })).toBe('?s=a%20b%26c%2Fd');
  });

  it('round-trips through readSearch for a valid state', () => {
    const id = fc
      .tuple(
        fc.stringMatching(/^[a-z]{2}$/),
        fc.stringMatching(/^[a-z0-9-]{1,12}$/),
        fc.stringMatching(/^[A-Za-z0-9._-]{1,40}$/),
      )
      .map(([c, source, name]) => `${c}.${source}.${name}`);
    const state = fc.record({
      t: fc.option(
        fc
          .integer({ min: Date.UTC(2026, 7, 24) / 600_000, max: Date.UTC(2040, 0, 1) / 600_000 })
          .map((n) => n * 600_000),
        { nil: undefined },
      ),
      s: fc.option(id, { nil: undefined }),
    });
    fc.assert(
      fc.property(state, (x: UrlState) => {
        expect(readSearch(searchOf(x))).toEqual(x);
      }),
    );
  });
});

describe('otherLanguageHref', () => {
  const state = { t: T, s: ID };

  it('goes to the other page with the same view', () => {
    expect(otherLanguageHref('nl', state)).toBe(`/en/?t=2026-10-25T01:30Z&s=${ID}`);
    expect(otherLanguageHref('en', state)).toBe(`/?t=2026-10-25T01:30Z&s=${ID}`);
  });

  it('is the bare page without a view', () => {
    const none = { t: undefined, s: undefined };
    expect(otherLanguageHref('nl', none)).toBe('/en/');
    expect(otherLanguageHref('en', none)).toBe('/');
  });
});

describe('otherLanguageHref for a page (P10b)', () => {
  const view: UrlState = { t: T, s: ID, mode: 'q', river: 'waal' };
  const query = `?t=2026-10-25T01:30Z&s=${ID}&mode=q&river=waal`;

  it('maps every page to its pair in the other language, both ways, keeping the whole query', () => {
    expect(PAGE_ROUTES).toHaveLength(9);
    for (const r of PAGE_ROUTES) {
      expect(otherLanguageHref('nl', view, r.id), r.id).toBe(`${r.en}${query}`);
      expect(otherLanguageHref('en', view, r.id), r.id).toBe(`${r.nl}${query}`);
      expect(otherLanguageHref('nl', { t: undefined, s: undefined }, r.id), r.id).toBe(r.en);
    }
    // The pair is its own inverse: read the link back as the page it leads to, and its language link leads home again.
    for (const r of PAGE_ROUTES) {
      const there = new URL(otherLanguageHref('nl', view, r.id), 'https://x.example');
      const back = otherLanguageHref('en', readSearch(there.search), routeOf(there.pathname)?.id);
      expect(back, r.id).toBe(`${r.nl}${query}`);
    }
  });

  it('is the map with no id (the 404 page), as the two-argument calls are', () => {
    expect(otherLanguageHref('nl', view, undefined)).toBe(`/en/${query}`);
    expect(otherLanguageHref('en', view, undefined)).toBe(`/${query}`);
    expect(otherLanguageHref('nl', view)).toBe(otherLanguageHref('nl', view, 'home'));
    expect(otherLanguageHref('en', view)).toBe(otherLanguageHref('en', view, 'home'));
  });

  it('is always a path of the other language, whatever the view', () => {
    const state = fc.record({
      t: fc.option(fc.constant(T), { nil: undefined }),
      s: fc.option(fc.constant(ID), { nil: undefined }),
      mode: fc.option(fc.constantFrom(...MODES), { nil: undefined }),
      river: fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{1,40}$/), { nil: undefined }),
    });
    fc.assert(
      fc.property(
        fc.constantFrom('nl', 'en'),
        fc.constantFrom(...PAGE_ROUTES.map((r) => r.id)),
        state,
        (locale, id, x) => {
          const href = otherLanguageHref(locale, x, id);
          const other = locale === 'nl' ? 'en' : 'nl';
          expect(href.startsWith(pathOf(id, other))).toBe(true);
          expect(href.slice(pathOf(id, other).length)).toBe(searchOf(x));
          expect(routeOf(new URL(href, 'https://x.example').pathname)).toEqual({ id, locale: other });
        },
      ),
    );
  });
});

describe('mode and river (P10a)', () => {
  it('reads a known mode and a river slug, and drops anything else', () => {
    expect(readSearch('?mode=delta&river=waal')).toMatchObject({ mode: 'delta', river: 'waal' });
    expect(readSearch('?mode=state').mode).toBe('state');
    expect(readSearch('?mode=q').mode).toBe('q');
    for (const bad of ['dh', 'Q', 'STATE', '', 'state ', '__proto__'])
      expect(readSearch(`?mode=${encodeURIComponent(bad)}`).mode).toBeUndefined();
    for (const bad of ['Waal', 'w', '1rhine', 'rhine_x', `a${'b'.repeat(41)}`, '<x>', ''])
      expect(readSearch(`?river=${encodeURIComponent(bad)}`).river).toBeUndefined();
  });

  it('keeps every key in the other language', () => {
    expect(otherLanguageHref('nl', { t: T, s: ID, mode: 'q', river: 'pannerdensch-kanaal' })).toBe(
      `/en/?t=2026-10-25T01:30Z&s=${ID}&mode=q&river=pannerdensch-kanaal`,
    );
  });

  it('round-trips, and never returns an invalid mode or river for random text', () => {
    const state = fc.record({
      t: fc.constant(undefined),
      s: fc.constant(undefined),
      mode: fc.option(fc.constantFrom(...MODES), { nil: undefined }),
      river: fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{1,40}$/), { nil: undefined }),
    });
    fc.assert(
      fc.property(state, (x: UrlState) => {
        expect(readSearch(searchOf(x))).toEqual(x);
      }),
    );
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }), (mode, river) => {
        const out = readSearch(`?mode=${encodeURIComponent(mode)}&river=${encodeURIComponent(river)}`);
        if (out.mode !== undefined) expect(MODES).toContain(out.mode);
        if (out.river !== undefined) expect(out.river).toMatch(RIVER_ID);
      }),
    );
  });
});
