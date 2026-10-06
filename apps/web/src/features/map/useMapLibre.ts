import type { Map as MapLibreMap, MapOptions } from 'maplibre-gl';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { Locale } from '../../paraglide/runtime.js';

export type MapState =
  | { status: 'loading' }
  | { status: 'ready'; map: MapLibreMap }
  | { status: 'error'; code: string };

const codeOf = (err: unknown): string =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : 'map_failed';

/**
 * Resolves once `el` is (nearly) in the viewport (P10a, Lighthouse): MapLibre's set-up is the page's longest
 * main-thread work, and on a phone the map sits below the time bar, the controls and the legend, so it starts only
 * when it scrolls into view. Without IntersectionObserver it resolves at once.
 */
function whenVisible(el: Element, signal: AbortSignal): Promise<void> {
  if (typeof IntersectionObserver === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        seen.disconnect();
        resolve();
      },
      { rootMargin: '0px 0px 200px 0px' },
    );
    seen.observe(el);
    signal.addEventListener('abort', () => seen.disconnect(), { once: true });
  });
}

/**
 * A MapLibre map in `container` (A§10 features/map). MapLibre, its worker,
 * the pmtiles protocol and the style load as a lazy chunk once the container
 * comes into view. On unmount, or when the language changes, the map is removed
 * and the protocol released; a map whose set-up finishes after unmount is
 * removed at once. `options` are read once, at mount.
 */
export function useMapLibre(
  container: RefObject<HTMLElement | null>,
  lang: Locale,
  options?: Partial<MapOptions>,
): MapState {
  const [state, setState] = useState<MapState>({ status: 'loading' });
  const initial = useRef(options);
  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    const abort = new AbortController();
    let dispose: (() => void) | undefined;
    setState({ status: 'loading' });
    whenVisible(el, abort.signal)
      .then(() => {
        abort.signal.throwIfAborted();
        return import('./createMap.ts');
      })
      .then(({ createMap }) => createMap(el, { lang, signal: abort.signal, options: initial.current }))
      .then((created) => {
        if (abort.signal.aborted) return created.dispose();
        dispose = created.dispose;
        setState({ status: 'ready', map: created.map });
      })
      .catch((err: unknown) => {
        if (!abort.signal.aborted) setState({ status: 'error', code: codeOf(err) });
      });
    return () => {
      abort.abort();
      dispose?.();
    };
  }, [container, lang]);
  return state;
}
