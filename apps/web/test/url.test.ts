import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { otherLanguageHref, readSearch, searchOf, type UrlState } from '../src/lib/url/url.ts';

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
