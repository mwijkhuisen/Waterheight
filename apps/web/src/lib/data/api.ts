import { type ApiStation, Meta, RiversManifest, Series, SeriesForecast, Snapshot, Stations } from '@rws/contracts';
import { keepPreviousData, QueryClient, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { stationHorizon } from '../forecast.ts';
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

// The river-network download is offered only while the manifest of the installed release parses (P6b); a 404, a
// network error or a manifest of another shape shows no link and no error.
export const MANIFEST_PATH = '/data/v1/rivers/manifest.json';

/** The download link of a manifest, or undefined for anything that is not a valid one. */
export function downloadHref(manifest: unknown): string | undefined {
  const parsed = RiversManifest.safeParse(manifest);
  return parsed.success ? `/downloads/${parsed.data.current.download.file}` : undefined;
}

export const useRiversManifest = () =>
  useQuery({
    queryKey: ['rivers-manifest'],
    queryFn: ({ signal }) => getJson(MANIFEST_PATH, RiversManifest, signal),
    retry: false,
    staleTime: 300_000,
  });

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

/**
 * The run of one series that is current now (its horizon: the end of the slider, D8). The answer does not depend on
 * `t`, so it is fetched once per series and kept for as long as the API caches it. A series the API does not offer
 * (404: not in the api channel) has no forecast, like one without a run.
 */
const forecastQuery = (id: number) => ({
  queryKey: ['forecast', id],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    getJson(`/api/v1/series/${id}/forecast`, SeriesForecast, signal).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }),
  staleTime: 300_000,
});

/**
 * The horizon of the selected station as an instant: the latest end among the runs of its series; `null` when none
 * has a run; `undefined` with no station, while the answers are on their way or when one failed (the page then keeps
 * the global end, and the snapshot says per station what it has).
 */
export const useStationHorizon = (station: ApiStation | undefined): number | null | undefined =>
  useQueries({
    queries: (station?.series ?? []).map((s) => forecastQuery(s.id)),
    combine: (results) =>
      results.length === 0 || results.some((r) => r.isPending || r.isError)
        ? undefined
        : stationHorizon(results.map((r) => r.data ?? null)),
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
 * The chart's span: 7 days up to the next 6-hour boundary after `t`, so stepping
 * or playing inside six hours asks nothing new. `to` never passes the API's
 * limit, the server's now + 10 minutes (`serverNow` is `meta.now`, never this
 * browser's clock, which may run ahead of it).
 */
export function chartSpan(t: number, displayStart: number, serverNow: number): { from: number; to: number } {
  const to = Math.min(Math.floor(t / SIX_HOURS) * SIX_HOURS + SIX_HOURS, quantise(serverNow + STEP_MS));
  return { from: Math.max(displayStart, to - 7 * 24 * 3_600_000), to };
}

/**
 * `value`, once it has stopped changing for `ms` (dragging the slider asks only
 * for where it stops). The first defined value is taken at once.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  if (settled === undefined && value !== undefined) setSettled(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}
