import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { OFFICIAL, STORM_SURGE_WARNING } from '../src/features/pages/official.ts';
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

describe('STORM_SURGE_WARNING', () => {
  it('links only reviewed OFFICIAL front pages, over https', () => {
    const reviewed = new Set(OFFICIAL.flatMap((o) => o.hrefs));
    for (const href of Object.values(STORM_SURGE_WARNING)) {
      const url = new URL(href);
      expect(url.protocol).toBe('https:');
      expect(url.pathname).toBe('/');
      expect(`${url.search}${url.hash}`).toBe('');
      expect(reviewed.has(href)).toBe(true);
    }
  });

  it('has exactly the sea and estuary water bodies of the registry (not closed_estuary)', () => {
    const file = parse(readFileSync(new URL('../../../registry/waterbodies.yaml', import.meta.url), 'utf8')) as {
      waterbodies: { id: string; kind: string }[];
    };
    const ids = file.waterbodies.filter((w) => w.kind === 'sea' || w.kind === 'estuary').map((w) => w.id);
    expect(Object.keys(STORM_SURGE_WARNING).sort()).toEqual(ids.sort());
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

describe('the privacy page', () => {
  it.each(['nl', 'en'] as const)('names the CDN first, right after the title (A§10), in %s', (locale) => {
    const src = readFileSync(new URL(`../src/features/pages/content/${locale}/Privacy.tsx`, import.meta.url), 'utf8');
    expect(src).toMatch(new RegExp(`<h1>Privacy</h1>\\s*<h2>CDN</h2>\\s*<Cdn locale="${locale}" />\\s*<h2>`));
    expect(src.match(/<Cdn /g)).toHaveLength(1);
  });
});
