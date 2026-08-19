/**
 * Minimal history-based router.
 *
 * npm's information architecture is URL-first: every location has an
 * addressable page, and search state lives in the query string so a filtered
 * result set can be linked and shared. That needs real paths, not a hash, and
 * both dev (Vite) and production (the Fastify SPA fallback) already serve
 * index.html for unknown non-/api paths.
 *
 * Hand-rolled rather than react-router: the whole requirement is four routes,
 * a Link that respects modifier clicks, and a subscription to popstate.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';

export interface RouteLocation {
  /** Pathname with no trailing slash, e.g. "/location/VLISSGN". "/" stays "/". */
  path: string;
  search: string;
}

/** pushState/replaceState do not emit an event; this stands in for one. */
const NAVIGATION_EVENT = 'rws:navigation';

function currentLocation(): RouteLocation {
  const { pathname, search } = window.location;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return { path: path || '/', search };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  const same = url.pathname === window.location.pathname
    && url.search === window.location.search;
  if (same) return;

  if (options.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);

  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

const LocationContext = createContext<RouteLocation>({ path: '/', search: '' });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<RouteLocation>(currentLocation);

  useEffect(() => {
    const sync = () => setLocation(currentLocation());
    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, []);

  return (
    <LocationContext.Provider value={location}>{children}</LocationContext.Provider>
  );
}

export function useRoute(): RouteLocation {
  return useContext(LocationContext);
}

/** Query parameters of the current URL, re-parsed only when the URL changes. */
export function useQueryParams(): URLSearchParams {
  const { search } = useRoute();
  return useMemo(() => new URLSearchParams(search), [search]);
}

/**
 * Rewrites the query string of the current path.
 *
 * Refinements replace rather than push, so a run of typing in the search box
 * does not bury the previous page under a dozen history entries. Steps a reader
 * expects to walk back through -- paging, above all -- pass 'push'.
 */
export function useSetQueryParams(): (next: URLSearchParams, mode?: 'push' | 'replace') => void {
  const { path } = useRoute();
  return useCallback(
    (next: URLSearchParams, mode: 'push' | 'replace' = 'replace') => {
      const query = next.toString();
      navigate(query ? `${path}?${query}` : path, { replace: mode === 'replace' });
    },
    [path],
  );
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

/**
 * Client-side anchor. Still a real <a href>, so middle-click, ctrl-click and
 * "copy link address" all behave — only the plain left click is intercepted.
 */
export function Link({ to, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

/** Path for a location's page. Codes may contain characters needing escaping. */
export function locationPath(code: string): string {
  return `/location/${encodeURIComponent(code)}`;
}

export function searchPath(params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `/search?${encoded}` : '/search';
}
