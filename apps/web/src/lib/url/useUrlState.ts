import { useCallback, useSyncExternalStore } from 'react';
import { readSearch, searchOf, type UrlState } from './url.ts';

// The page's view state lives in memory and follows into the URL. The state
// changes at once; the URL is written at most once per WRITE_MS (75 writes in
// 30 s), the last value always last: WebKit throws after 100 replaceState calls
// in 30 s and Chromium ignores calls past its own limit, while a held arrow key
// on the slider makes 30 changes a second. Back and forward (popstate) win over
// a write still pending.

const WRITE_MS = 400;
const listeners = new Set<() => void>();
let search: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

const current = () => {
  search ??= location.search;
  return search;
};
const notify = () => {
  for (const listener of listeners) listener();
};
const popped = () => {
  clearTimeout(timer);
  timer = undefined;
  dirty = false;
  search = location.search;
  notify();
};
const subscribe = (listener: () => void) => {
  if (listeners.size === 0) window.addEventListener('popstate', popped);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('popstate', popped);
  };
};

/** Replaces the history entry with the state's URL; false when the browser refused (its rate limit). */
function write(): boolean {
  if (location.search === current()) return true;
  try {
    history.replaceState(null, '', `${location.pathname}${current()}`);
    return true;
  } catch {
    return false;
  }
}

/** The first change is written at once, later ones once per WRITE_MS; a refused write is tried again. */
function schedule() {
  if (timer !== undefined) {
    dirty = true;
    return;
  }
  dirty = !write();
  const tick = () => {
    timer = undefined;
    if (!dirty) return;
    dirty = !write();
    timer = setTimeout(tick, WRITE_MS);
  };
  timer = setTimeout(tick, WRITE_MS);
}

/**
 * The URL state, and a setter that changes part of it and replaces the history
 * entry (scrubbing never fills the history). A value that did not parse is
 * dropped on the next write.
 */
export function useUrlState(): [UrlState, (patch: Partial<UrlState>) => void] {
  const state = useSyncExternalStore(subscribe, current);
  const set = useCallback((patch: Partial<UrlState>) => {
    const next = searchOf({ ...readSearch(current()), ...patch });
    if (next === current()) return;
    search = next;
    notify();
    schedule();
  }, []);
  return [readSearch(state), set];
}
