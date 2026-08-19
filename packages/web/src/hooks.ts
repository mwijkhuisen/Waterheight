/**
 * Data-loading hooks shared by the pages.
 *
 * Every page in an npm-style site is independently addressable, so each one
 * loads what it needs rather than inheriting state from a parent shell. These
 * hooks keep that from turning into a re-fetch on every render, and keep the
 * abort-on-unmount handling in one place instead of in five components.
 */

import { useEffect, useRef, useState } from 'react';
import type { CompartmentInfo, Location, QuantityInfo } from '@rws/shared';
import { ApiRequestError, fetchLocations, fetchQuantities, type LocationFilters } from './api.js';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/** Debounces a fast-changing value, e.g. the search box. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The quantity/compartment catalogue, fetched once per page load.
 *
 * It backs the header, the facets and the browse grid, and it changes on the
 * order of days -- refetching it per route would be three identical requests
 * for one navigation.
 */
let cataloguePromise: Promise<{ quantities: QuantityInfo[]; compartments: CompartmentInfo[] }> | null = null;

export function useCatalogue(): AsyncState<{ quantities: QuantityInfo[]; compartments: CompartmentInfo[] }> {
  const [state, setState] = useState<AsyncState<{ quantities: QuantityInfo[]; compartments: CompartmentInfo[] }>>({
    data: null, loading: true, error: null,
  });

  useEffect(() => {
    let active = true;
    cataloguePromise ??= fetchQuantities().then((res) => ({
      quantities: res.quantities,
      compartments: res.compartments,
    }));

    cataloguePromise
      .then((data) => { if (active) setState({ data, loading: false, error: null }); })
      .catch((err: unknown) => {
        // Let a later mount retry: a failed catalogue should not be permanent.
        cataloguePromise = null;
        if (active) {
          setState({ data: null, loading: false, error: messageFor(err, 'Could not load measurement types.') });
        }
      });

    return () => { active = false; };
  }, []);

  return state;
}

/**
 * Location search. The filter object is destructured into the dependency list
 * so callers can pass a fresh literal without re-fetching on every render.
 */
export function useLocations(filters: LocationFilters): AsyncState<Location[]> {
  const { grootheid, compartiment, q } = filters;
  const [state, setState] = useState<AsyncState<Location[]>>({
    data: null, loading: true, error: null,
  });
  // Held so a refetch keeps showing the previous result set instead of
  // collapsing the page to a skeleton on every keystroke.
  const previous = useRef<Location[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ data: previous.current, loading: true, error: null });

    fetchLocations({ grootheid, compartiment, q }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        previous.current = data;
        setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          data: null,
          loading: false,
          error: messageFor(err, 'Could not reach the API. Is the server running?'),
        });
      });

    return () => controller.abort();
  }, [grootheid, compartiment, q]);

  return state;
}

/** Sets document.title for the duration of a page, npm-style: "name - rws". */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
