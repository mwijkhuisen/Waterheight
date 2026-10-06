import { describe, expect, it } from 'vitest';
import { OFFICIAL } from '../src/features/pages/official.ts';
import { contactHref } from '../src/features/pages/parts/contact.ts';
import { COUNTRIES } from '../src/features/pages/parts/country.ts';

// The static pages' logic (P10b): the official services the About and Disclaimer pages link, and the colophon's
// contact link.

describe('OFFICIAL', () => {
  it('has each of the six countries once, with at least one link', () => {
    expect(OFFICIAL.map((o) => o.country).sort()).toEqual([...COUNTRIES].sort());
    for (const o of OFFICIAL) expect(o.hrefs.length).toBeGreaterThanOrEqual(1);
  });

  it('links only the front page of an https host, and no host twice', () => {
    const hosts = OFFICIAL.flatMap((o) => o.hrefs).map((href) => {
      const url = new URL(href);
      expect(url.protocol).toBe('https:');
      expect(url.pathname).toBe('/');
      expect(`${url.search}${url.hash}${url.username}${url.password}${url.port}`).toBe('');
      expect(href).toBe(`https://${url.host}/`);
      return url.host;
    });
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});

describe('contactHref', () => {
  it('makes a mailto link of a plain address', () => {
    expect(contactHref('contact@example.org')).toBe('mailto:contact@example.org');
    expect(contactHref('first.last+rws@sub.example.nl')).toBe('mailto:first.last+rws@sub.example.nl');
  });

  it('refuses anything that could carry more than an address', () => {
    for (const bad of [
      '',
      undefined,
      'a@b.c?subject=x',
      'contact@example.org?subject=x',
      'contact@example.org&cc=x@y.zz',
      'a@b.c%0a',
      'contact@example.org%0d%0aBcc:x@y.zz',
      '"x"@b.c',
      '"x"@example.org',
      "o'brien@example.org",
      '<a@b.c>',
      '<contact@example.org>',
      'a b@c.d',
      'contact@example.org ',
      'contact@example.org\n',
      'contact@@example.org',
      'contact@example',
      'contact',
      `${'a'.repeat(65)}@example.org`,
      `contact@${'a'.repeat(250)}.org`,
    ])
      expect(contactHref(bad), String(bad)).toBeUndefined();
  });
});
