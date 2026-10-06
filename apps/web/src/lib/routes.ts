// The pages of the site (P10b, A§10): one path per language, compared exactly (case, slashes and all), so a path
// that only looks like a page is the 404 page, never a soft 404. No imports: Node reads this file as it is (the Caddy
// allowlist test, the e2e stand-in, scripts/verify-prod.ts). deploy/web/site.caddy and owner.caddy list the same
// paths (test/page-routes.test.ts). Links between pages are plain anchors: a full page load, no router.

export const PAGE_ROUTES = [
  { id: 'home', nl: '/', en: '/en/' },
  { id: 'about', nl: '/over', en: '/en/about' },
  { id: 'sources', nl: '/bronnen', en: '/en/sources' },
  { id: 'method', nl: '/methode', en: '/en/method' },
  { id: 'disclaimer', nl: '/disclaimer', en: '/en/disclaimer' },
  { id: 'colophon', nl: '/colofon', en: '/en/colophon' },
  { id: 'privacy', nl: '/privacy', en: '/en/privacy' },
  { id: 'status', nl: '/status', en: '/en/status' },
  { id: 'accessibility', nl: '/toegankelijkheid', en: '/en/accessibility' },
] as const;

export type RouteId = (typeof PAGE_ROUTES)[number]['id'];
/** Every page but the map. */
export type PageId = Exclude<RouteId, 'home'>;
export type RouteLocale = 'nl' | 'en';
export type Route = { id: RouteId; locale: RouteLocale };

/** The file names of the two shells, which Caddy serves for `/` and `/en/` but never under their own name. */
const SHELLS: Readonly<Record<string, Route>> = {
  '/index.html': { id: 'home', locale: 'nl' },
  '/en/index.html': { id: 'home', locale: 'en' },
};

/** The page of a location's pathname (percent-decoded first, as Caddy matches it), or null for any other path. */
export function routeOf(pathname: string): Route | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // An own key only: `constructor` or `__proto__` is never a page (the T-WEB-3 rule; review round 1).
  if (Object.hasOwn(SHELLS, path)) return SHELLS[path] ?? null;
  for (const r of PAGE_ROUTES) {
    if (r.nl === path) return { id: r.id, locale: 'nl' };
    if (r.en === path) return { id: r.id, locale: 'en' };
  }
  return null;
}

/** The path of a page in a language. */
export function pathOf(id: RouteId, locale: RouteLocale): string {
  const r = PAGE_ROUTES.find((x) => x.id === id);
  if (r === undefined) throw new Error(`unknown page ${id}`);
  return r[locale];
}
