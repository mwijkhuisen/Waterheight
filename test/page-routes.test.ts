import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_ROUTES, pathOf, routeOf } from '../apps/web/src/lib/routes.ts';
import { repoRoot } from './catalogue.ts';

// P10b: the pages of the site are listed in four places that must agree: apps/web/src/lib/routes.ts (the one list), the
// two Caddy allowlists (deploy/web/site.caddy and owner.caddy) and the e2e stand-in (apps/web/e2e/server.ts, which
// imports the list). scripts/verify-prod.ts reads the list too (test/verify-prod.test.ts).

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** The quoted paths of `@page_<locale> expression` `{path} in [...]`: each one a quoted string, nothing else. */
function caddyList(file: string, locale: 'nl' | 'en'): string[] {
  const src = read(file);
  const found = [
    ...src.matchAll(new RegExp(`^\\s*@page_${locale} expression \`\\{path\\} in \\[([^\\]\`]*)\\]\`$`, 'gm')),
  ];
  expect(found, `${file}: @page_${locale}`).toHaveLength(1);
  return (found[0]?.[1] ?? '').split(', ').map((item) => {
    const m = /^'([^']+)'$/.exec(item);
    expect(m, `${file}: ${item}`).not.toBeNull();
    return m?.[1] ?? '';
  });
}

describe('the page list', () => {
  it('has nine pages, each with a Dutch and an English path that start the way their language does', () => {
    expect(PAGE_ROUTES.map((r) => r.id)).toEqual([
      'home',
      'about',
      'sources',
      'method',
      'disclaimer',
      'colophon',
      'privacy',
      'status',
      'accessibility',
    ]);
    for (const r of PAGE_ROUTES) {
      expect(r.nl.startsWith('/') && !r.nl.startsWith('/en/'), r.id).toBe(true);
      expect(r.en.startsWith('/en/'), r.id).toBe(true);
    }
    const all = PAGE_ROUTES.flatMap((r) => [r.nl, r.en]);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each(['deploy/web/site.caddy', 'deploy/web/owner.caddy'])(
    '%s lists exactly these paths, in this order, in @page_nl and @page_en',
    (file) => {
      expect(caddyList(file, 'nl')).toEqual(PAGE_ROUTES.map((r) => r.nl));
      expect(caddyList(file, 'en')).toEqual(PAGE_ROUTES.map((r) => r.en));
    },
  );

  it('the e2e stand-in imports the list and holds no copy of a path', () => {
    const src = read('apps/web/e2e/server.ts');
    expect(src).toContain("import { PAGE_ROUTES } from '../src/lib/routes.ts';");
    expect(src).toMatch(/PAGE_ROUTES\.map\(\(r\) => r\.nl\)/);
    expect(src).toMatch(/PAGE_ROUTES\.map\(\(r\) => r\.en\)/);
    // `/` and `/en/` are too common to tell; every other path is quoted nowhere (as a string or a template).
    for (const r of PAGE_ROUTES.slice(1))
      for (const path of [r.nl, r.en])
        for (const q of ["'", '"', '`']) expect(src, path).not.toContain(`${q}${path}${q}`);
  });
});

describe('routeOf and pathOf', () => {
  it('round-trip every page in both languages', () => {
    for (const r of PAGE_ROUTES)
      for (const locale of ['nl', 'en'] as const) {
        expect(routeOf(pathOf(r.id, locale)), `${r.id} ${locale}`).toEqual({ id: r.id, locale });
        expect(routeOf(r[locale]), r[locale]).toEqual({ id: r.id, locale });
        expect(pathOf(r.id, locale)).toBe(r[locale]);
      }
  });

  it('matches the pathname exactly: case, slashes and the empty path are no page', () => {
    for (const path of [
      '/Over',
      '//over',
      '/over/',
      '/EN/about',
      '/en//about',
      '/en/about/',
      '/en',
      '',
      'over',
      '/OVER',
    ])
      expect(routeOf(path), JSON.stringify(path)).toBeNull();
  });

  it('decodes the percent escapes first, as Caddy matches them, and refuses a broken one', () => {
    expect(routeOf('/%6Fver')).toEqual({ id: 'about', locale: 'nl' });
    expect(routeOf('/en/%61bout')).toEqual({ id: 'about', locale: 'en' });
    expect(routeOf('/%ZZ')).toBeNull();
    expect(routeOf('/over%')).toBeNull();
    // An encoded slash is a slash: /%2Fover is //over.
    expect(routeOf('/%2Fover')).toBeNull();
  });

  it('knows the two shells by their file names, as the map and nothing else', () => {
    expect(routeOf('/index.html')).toEqual({ id: 'home', locale: 'nl' });
    expect(routeOf('/en/index.html')).toEqual({ id: 'home', locale: 'en' });
    expect(routeOf('/404.html')).toBeNull();
    expect(routeOf('/en/404.html')).toBeNull();
  });

  it('pathOf throws for an unknown page', () => {
    expect(() => pathOf('nope' as never, 'nl')).toThrow(/unknown page/);
  });
});
