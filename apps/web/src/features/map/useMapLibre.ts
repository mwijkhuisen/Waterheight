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
 * A MapLibre map in `container` (A§10 features/map). MapLibre, its worker,
 * the pmtiles protocol and the style load as a lazy chunk on first use. On
 * unmount, or when the language changes, the map is removed and the protocol
 * released; a map whose set-up finishes after unmount is removed at once.
 * `options` are read once, at mount.
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
    import('./createMap.ts')
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
