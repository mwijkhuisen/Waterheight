import { useCallback, useSyncExternalStore } from 'react';
import { readSearch, searchOf, type UrlState } from './url.ts';

const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  window.addEventListener('popstate', notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener('popstate', notify);
  };
};
const current = () => location.search;

/**
 * The URL state, and a setter that changes part of it and replaces the history
 * entry (scrubbing never fills the history). A value that did not parse is
 * dropped on the next write.
 */
export function useUrlState(): [UrlState, (patch: Partial<UrlState>) => void] {
  const search = useSyncExternalStore(subscribe, current);
  const set = useCallback((patch: Partial<UrlState>) => {
    const target = `${location.pathname}${searchOf({ ...readSearch(location.search), ...patch })}`;
    if (target === `${location.pathname}${location.search}`) return;
    history.replaceState(null, '', target);
    for (const notify of listeners) notify();
  }, []);
  return [readSearch(search), set];
}
