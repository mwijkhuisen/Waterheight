import { Meta, Series, Snapshot, Stations } from '@rws/contracts';
import { keepPreviousData, QueryClient, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { quantise, STEP_MS, toUrlT } from '../time/time.ts';

// The P4a API, read through relative paths only, so the same build can later
// serve the owner site (A§10 owner mode). Every answer is parsed with its
// contract before the UI sees it; anything else is an error state.

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`http_${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function getJson<T>(path: string, contract: { parse(data: unknown): T }, signal: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status);
  return contract.parse(await res.json());
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export const useMeta = () =>
  useQuery({ queryKey: ['meta'], queryFn: ({ signal }) => getJson('/api/v1/meta', Meta, signal), staleTime: 60_000 });

export const useStations = () =>
  useQuery({
    queryKey: ['stations'],
    queryFn: ({ signal }) => getJson('/api/v1/stations', Stations, signal),
    staleTime: 300_000,
  });

/**
 * The values at a quantised `t`. The key is that instant, so scrubbing back to
 * a bucket reuses its answer; a request that a newer `t` supersedes loses its
 * last observer and Query aborts it through `signal`. The previous values stay
 * on screen until the new ones arrive.
 */
export const useSnapshot = (t: number | undefined) =>
  useQuery({
    queryKey: ['snapshot', t],
    queryFn: ({ signal }) => getJson(`/api/v1/snapshot?t=${toUrlT(t ?? 0)}`, Snapshot, signal),
    enabled: t !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

/** One series over [from, to), raw. The id comes only from the /stations answer. */
export const useSeries = (id: number, from: number, to: number) =>
  useQuery({
    queryKey: ['series', id, from, to],
    queryFn: ({ signal }) =>
      getJson(`/api/v1/series/${id}?from=${toUrlT(from)}&to=${toUrlT(to)}&res=raw`, Series, signal),
    staleTime: 60_000,
  });

const SIX_HOURS = 36 * STEP_MS;

/**
 * The chart's span: 7 days up to the next 6-hour boundary after `t` (never past
 * `end` + one step, the API's limit for `to`), so stepping or playing inside
 * six hours asks nothing new.
 */
export function chartSpan(t: number, displayStart: number, end: number): { from: number; to: number } {
  const to = Math.min(Math.floor(t / SIX_HOURS) * SIX_HOURS + SIX_HOURS, quantise(end) + STEP_MS);
  return { from: Math.max(displayStart, to - 7 * 24 * 3_600_000), to };
}

/** `value`, once it has stopped changing for `ms` (dragging the slider asks only for where it stops). */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}
