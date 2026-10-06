import { type ApiStation, floorBucket, RiversManifest } from '@rws/contracts';
import { keepPreviousData, QueryClient, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { loadRuntimeConfig, type RuntimeConfig } from '../config/runtime.ts';
import { stationHorizon } from '../forecast.ts';
import { quantise, STEP_MS, toUrlT } from '../time/time.ts';
import type { Mode } from '../url/url.ts';
import {
  browserFetch,
  HttpError,
  loadMeta,
  loadReachTravel,
  loadRecent,
  loadRivers,
  loadSnapshot,
  loadSources,
  loadStations,
  loadStatusMode,
  loadStatusPage,
  loadWarnings,
  type WebMeta,
} from './chain.ts';
import { type Change, changesAt } from './change.ts';
import { type Contracts, PUBLIC_CONTRACTS } from './contracts.ts';
import { snapshotSource, versionKey } from './static.ts';

// The data of the page, read through relative paths only, so the same build serves the public site and the owner
// site (A§10 owner mode). Every answer is parsed with its site's contract (contracts.ts) before the UI sees it;
// anything else is an error state. Every key carries the audience, so the two sites' answers never mix.

export { HttpError };

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/** Live mode (no `t`, P10a T7): the current answers are asked again every minute while the tab is visible. */
const LIVE_MS = 60_000;
const live = (on: boolean) => (on ? { refetchInterval: LIVE_MS, refetchIntervalInBackground: false } : {});

/**
 * /runtime-config.json, once: one query for the audience and the site's operator, contact and CDN (P10b, plan C8). A
 * failure is retried (three times, with backoff) and never becomes "public" (lib/config/runtime.ts; review round 1).
 */
const runtimeConfigQuery = {
  queryKey: ['runtime-config'],
  queryFn: ({ signal }: { signal: AbortSignal }) => loadRuntimeConfig(undefined, signal),
  staleTime: Number.POSITIVE_INFINITY,
  retry: 3,
} as const;

/** Which site this is: the query, so the page can say when it never answered. */
export const useAudienceQuery = () => useQuery({ ...runtimeConfigQuery, select: (c: RuntimeConfig) => c.audience });

/** The operator, contact and CDN of this site (the colophon, the privacy page): the query, so a part can say when it failed. */
export const useSiteConfig = () => useQuery(runtimeConfigQuery);

/** Which site this is; undefined until it has answered (and after it failed for good). */
export const useAudience = () => useAudienceQuery().data;

/**
 * The site's schemas: the public record at once, the owner record from its lazy chunk (plan C1). Undefined until the
 * audience is known (and, on the owner site, the chunk has loaded); every query waits for it.
 */
export function useContracts(): Contracts | undefined {
  const aud = useAudience();
  return useQuery({
    queryKey: ['contracts', aud],
    queryFn: async (): Promise<Contracts> =>
      aud === 'owner' ? (await import('../../features/owner/contracts.ts')).OWNER_CONTRACTS : PUBLIC_CONTRACTS,
    enabled: aud !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    structuralSharing: false,
  }).data;
}

// Static first, the API as fallback (P9a, chain.ts): meta.json, stations.json, then the snapshot file of t.
export const useMeta = (isLive = false) => {
  const c = useContracts();
  return useQuery({
    queryKey: ['meta', c?.audience],
    queryFn: ({ signal }) => loadMeta(browserFetch, signal, c),
    enabled: c !== undefined,
    staleTime: 60_000,
    ...live(isLive),
  });
};

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
    queryFn: async ({ signal }) => {
      const res = await browserFetch(MANIFEST_PATH, signal);
      if (!res.ok) throw new HttpError(res.status);
      return RiversManifest.parse(await res.json());
    },
    retry: false,
    staleTime: 300_000,
  });

/**
 * The installed river release (P10a T4): its manifest (the tile file of the `rivers` layer) and its river list (ids
 * and names for `?river=`). An error means no river layer and no chip, never an error on the page.
 */
export const useRivers = () =>
  useQuery({
    queryKey: ['rivers'],
    queryFn: ({ signal }) => loadRivers(browserFetch, signal),
    retry: false,
    staleTime: 300_000,
  });

/**
 * `?river=` once the river list has answered (plan C17): kept while it loads, dropped when the list failed or does
 * not name it.
 */
export function useRiver(river: string | undefined) {
  const rivers = useRivers();
  if (river === undefined) return undefined;
  if (rivers.isPending) return { id: river, river: undefined };
  const found = rivers.data?.rivers.find((r) => r.id === river);
  return found === undefined ? undefined : { id: river, river: found };
}

export const useStations = () => {
  const c = useContracts();
  return useQuery({
    queryKey: ['stations', c?.audience],
    queryFn: ({ signal }) => loadStations(browserFetch, signal, c),
    enabled: c !== undefined,
    staleTime: 300_000,
  });
};

/** sources.json: the credit lines with their dynamic dates and, on the owner site, every source's audience. */
export const useSources = () => {
  const c = useContracts();
  return useQuery({
    queryKey: ['sources', c?.audience],
    queryFn: ({ signal }) => loadSources(browserFetch, signal, c),
    enabled: c !== undefined,
    staleTime: 300_000,
  });
};

/** status.json for the Status page and the Method page's forecast coverage (P10b): static only, no retry. */
export const useStatusPage = () => {
  const c = useContracts();
  return useQuery({
    queryKey: ['status-page', c?.audience],
    queryFn: ({ signal }) => loadStatusPage(browserFetch, signal, c),
    enabled: c !== undefined,
    staleTime: 60_000,
    retry: false,
  });
};

/** The travel times of the installed reaches file (P10b Method page): an error shows the page's own notice. */
export const useReachTravel = () => {
  const c = useContracts();
  return useQuery({
    queryKey: ['reach-travel', c?.audience],
    queryFn: ({ signal }) => loadReachTravel(browserFetch, signal, c),
    enabled: c !== undefined,
    staleTime: 300_000,
    retry: false,
  });
};

/** The source ids of owner audience (empty on the public site and until sources.json has answered). */
export function useOwnerSources(): ReadonlySet<string> {
  const sources = useSources().data;
  return useMemo(
    () => new Set((sources?.sources ?? []).filter((s) => s.audience === 'owner').map((s) => s.id)),
    [sources],
  );
}

/**
 * The map mode (D10, plan C11): the URL's, else the default of status.json (`dh` → delta) for this site's family;
 * `delta` when the file fails or names none. Undefined while status.json is on its way, so the page never flashes
 * one mode and then shows another.
 */
export function useMode(urlMode: Mode | undefined): Mode | undefined {
  const c = useContracts();
  const status = useQuery({
    queryKey: ['status-mode', c?.audience],
    queryFn: ({ signal }) => loadStatusMode(browserFetch, signal, c),
    enabled: c !== undefined && urlMode === undefined,
    staleTime: 300_000,
    retry: false,
  });
  if (urlMode !== undefined) return urlMode;
  if (status.isPending) return undefined;
  return status.data === 'state' ? 'state' : 'delta';
}

/**
 * The values at a quantised `t`. The key is that instant, so scrubbing back to
 * a bucket reuses its answer; a request that a newer `t` supersedes loses its
 * last observer and Query aborts it through `signal`. The previous values stay
 * on screen until the new ones arrive. In live mode the current bucket is asked again every minute.
 */
export const useSnapshot = (
  t: number | undefined,
  meta: Pick<WebMeta, 'now' | 'dayVersions'> | undefined,
  seriesHash: string | null | undefined,
  isLive = false,
) => {
  const c = useContracts();
  const key = t === undefined || meta === undefined ? 'wait' : versionKey(snapshotSource(t, meta), t);
  return useQuery({
    queryKey: ['snapshot', c?.audience, t, key],
    queryFn: ({ signal }) => loadSnapshot(browserFetch, t ?? 0, meta as WebMeta, seriesHash ?? null, signal, c),
    enabled: c !== undefined && t !== undefined && meta !== undefined && seriesHash !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    ...live(isLive),
  });
};

const DAY_MS = 86_400_000;

/**
 * The 24-hour change per series at `t` (P10a T1): latest.json's own `dh24` when the snapshot is the current one,
 * else value(t) − value(t − 24 h) from the snapshot at t − 24 h (its own query, through the same chain). Undefined
 * after now (not applicable) and while either answer is on its way.
 */
export function useChanges(
  t: number | undefined,
  meta: Pick<WebMeta, 'now' | 'dayVersions' | 'displayStart'> | undefined,
  seriesHash: string | null | undefined,
  stations: readonly ApiStation[] | undefined,
  current:
    | { t: string; values: { series: number; value: number }[]; dh24?: ReadonlyMap<number, number | null> | undefined }
    | undefined,
): ReadonlyMap<number, Change> | undefined {
  const future = t !== undefined && meta !== undefined && t > floorBucket(Date.parse(meta.now));
  const needBefore =
    !future &&
    current !== undefined &&
    current.dh24 === undefined &&
    t !== undefined &&
    t - DAY_MS >= Date.parse(meta?.displayStart ?? '');
  const before = useSnapshot(needBefore && t !== undefined ? t - DAY_MS : undefined, meta, seriesHash);
  const quantity = useMemo(
    () => new Map((stations ?? []).flatMap((st) => st.series.map((s) => [s.id, s.quantity] as const))),
    [stations],
  );
  return useMemo(() => {
    if (future || current === undefined || t === undefined || Date.parse(current.t) !== t) return undefined;
    if (current.dh24 !== undefined) return changesAt(quantity, current.values, undefined, current.dh24);
    if (!needBefore) return changesAt(quantity, current.values, []);
    if (before.data === undefined || Date.parse(before.data.t) !== t - DAY_MS) return undefined;
    return changesAt(quantity, current.values, before.data.values);
  }, [future, current, t, quantity, needBefore, before.data]);
}

/**
 * The warning areas valid at `t` (P10a T5; warnings.ts picks the file). Live, the latest file is asked again every
 * minute. A failure shows no areas (the map still works); `incomplete` says when earlier areas may be missing.
 */
export const useWarnings = (t: number | undefined, meta: Pick<WebMeta, 'now'> | undefined, isLive = false) => {
  const c = useContracts();
  const bucket = meta === undefined ? undefined : floorBucket(Date.parse(meta.now));
  return useQuery({
    queryKey: ['warnings', c?.audience, t, t !== undefined && bucket !== undefined && t >= bucket ? 'latest' : 'at'],
    queryFn: ({ signal }) => loadWarnings(browserFetch, t ?? 0, meta as WebMeta, signal, c),
    enabled: c !== undefined && t !== undefined && meta !== undefined && t <= (bucket ?? 0),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
    ...live(isLive),
  });
};

/** series/<station>/recent.json of the selected station (7 days, its runs and references); refreshed live. */
export const useRecent = (station: string | undefined, isLive = false) => {
  const c = useContracts();
  return useQuery({
    queryKey: ['recent', c?.audience, station],
    queryFn: ({ signal }) => loadRecent(browserFetch, station ?? '', signal, c),
    enabled: c !== undefined && station !== undefined,
    staleTime: 60_000,
    retry: false,
    ...live(isLive),
  });
};

async function getJson<T>(path: string, contract: { parse(data: unknown): T }, signal: AbortSignal): Promise<T> {
  const res = await browserFetch(path, signal);
  if (!res.ok) throw new HttpError(res.status);
  return contract.parse(await res.json());
}

/**
 * The run of one series that is current now (its horizon: the end of the slider, D8). The answer does not depend on
 * `t`, so it is fetched once per series and kept for as long as the API caches it. A series the API does not offer
 * (404: not in the api channel) has no forecast, like one without a run.
 */
const forecastQuery = (c: Contracts | undefined, id: number) => ({
  queryKey: ['forecast', c?.audience, id],
  enabled: c !== undefined,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    getJson(`/api/v1/series/${id}/forecast`, (c as Contracts).SeriesForecastAnswer, signal).then(
      (a) => (a.run !== null && (c as Contracts).hidden(a.run.source) ? { ...a, run: null } : a),
      (e: unknown) => {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      },
    ),
  staleTime: 300_000,
});

/**
 * The horizon of the selected station as an instant: the latest end among the runs of its series; `null` when none
 * has a run; `undefined` with no station, while the answers are on their way or when one failed (the page then keeps
 * the global end, and the snapshot says per station what it has).
 */
export const useStationHorizon = (station: ApiStation | undefined): number | null | undefined => {
  const c = useContracts();
  return useQueries({
    // A display-only series (stations.json `api: false`) is not in the api channel: it is never asked (a 404 would
    // say the same), review round 1.
    queries: (station?.series ?? [])
      .filter((s) => (s as { api?: boolean }).api !== false)
      .map((s) => forecastQuery(c, s.id)),
    combine: (results) =>
      results.length === 0 || results.some((r) => r.isPending || r.isError)
        ? undefined
        : stationHorizon(results.map((r) => r.data ?? null)),
  });
};

/** One series' run for a past or settled t (`?asof=`), when recent.json's run is not the one of that t. */
export const useForecastAsOf = (id: number | undefined, asof: number | undefined) => {
  const c = useContracts();
  return useQuery({
    queryKey: ['forecast-asof', c?.audience, id, asof],
    queryFn: ({ signal }) =>
      getJson(`/api/v1/series/${id}/forecast?asof=${toUrlT(asof ?? 0)}`, (c as Contracts).SeriesForecastAnswer, signal),
    enabled: c !== undefined && id !== undefined && asof !== undefined,
    staleTime: 300_000,
    retry: false,
  });
};

/**
 * One series over [from, to), raw. The id comes only from the stations answer, and the caller asks only for a
 * series whose `api` flag is on (a display-only series is never asked: historySource in change.ts).
 */
export const useSeries = (id: number, from: number, to: number, enabled = true) => {
  const c = useContracts();
  return useQuery({
    queryKey: ['series', c?.audience, id, from, to],
    queryFn: ({ signal }) =>
      getJson(
        `/api/v1/series/${id}?from=${toUrlT(from)}&to=${toUrlT(to)}&res=raw`,
        (c as Contracts).SeriesAnswer,
        signal,
      ),
    enabled: c !== undefined && enabled,
    staleTime: 60_000,
  });
};

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
