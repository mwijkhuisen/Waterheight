// O4 (#220): started at Viewer mount (App.tsx), so the map chunk, its style and the tiles manifest overlap the data
// reads. Tiny and free of MapLibre: the entry and the map chunk share it.
import type { Locale } from '../../paraglide/runtime.js';

export const styles = {
  nl: () => import('./styles/style-nl.json'),
  en: () => import('./styles/style-en.json'),
};

const request = (signal?: AbortSignal) => fetch('/tiles/manifest.json', { signal: signal ?? null, redirect: 'error' });

/** An early answer older than this is not used: a map hidden under a mobile sheet (`?s=`) can wait for minutes. */
const FRESH_MS = 60_000;
let early: Promise<Response> | undefined;
let startedAt = 0;
const fresh = () => early !== undefined && Date.now() - startedAt < FRESH_MS;

/** The preloaded answer once while fresh, else a new request: a remounted map still reads the current manifest. */
export function tilesManifest(signal: AbortSignal): Promise<Response> {
  const p = fresh() ? early : undefined;
  early = undefined;
  return p ?? request(signal);
}

export function preloadMap(lang: Locale): void {
  // The loader memoises both dynamic imports, so each is one request.
  import('./createMap.ts').catch(() => {});
  styles[lang]().catch(() => {});
  if (fresh()) return;
  const p = request();
  early = p;
  startedAt = Date.now();
  // A failed answer is never handed to a remount.
  p.catch(() => {
    if (early === p) early = undefined;
  });
}
