import {
  type ApiStation,
  LatestFile,
  type Meta,
  MetaAnswer,
  SnapshotAnswer,
  SnapshotFile,
  StaticForecastLatest,
  StaticMeta,
  StaticStations,
  StationsAnswer,
  toSnapshot,
} from '@rws/contracts';
import { holdForecasts } from '@rws/core/forecast-hold';
import { type SnapshotSource, snapshotSource, type WebSnapshot } from './static.ts';

// The fetch chain (P9a): the static file first, the API on a 404, a 5xx, a network failure or a parse failure. The
// fetcher is injected so the chain is tested without a network; paths are relative (same origin, invariant 7).

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`http_${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export type Fetcher = (path: string, signal?: AbortSignal) => Promise<Response>;
export const browserFetch: Fetcher = (path, signal) =>
  fetch(path, { signal: signal ?? null, redirect: 'error', headers: { accept: 'application/json' } });

const STATIC = '/data/v1/';
const aborted = (signal?: AbortSignal) => signal?.aborted === true;

/** One parsed answer and whether Caddy marked it as its stand-in for a dead API. */
export async function getJson<T>(
  f: Fetcher,
  path: string,
  contract: { parse(data: unknown): T },
  signal?: AbortSignal,
): Promise<{ data: T; degraded: boolean }> {
  const res = await f(path, signal);
  if (!res.ok) throw new HttpError(res.status);
  return { data: contract.parse(await res.json()), degraded: res.headers.get('x-degraded') === '1' };
}

/** The static answer when it parses, else the API's; an aborted request is never retried. */
async function staticThenApi<T>(
  attempt: () => Promise<T>,
  fallback: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (aborted(signal)) throw e;
    return fallback();
  }
}

/** meta.json, or the API's meta with no settled versions and no degraded flag. */
export type WebMeta = Meta & { dayVersions: Record<string, number>; degraded: boolean };

export const loadMeta = (f: Fetcher, signal?: AbortSignal): Promise<WebMeta> =>
  staticThenApi<WebMeta>(
    async () => (await getJson(f, `${STATIC}meta.json`, StaticMeta, signal)).data,
    async () => ({ ...(await getJson(f, '/api/v1/meta', MetaAnswer, signal)).data, dayVersions: {}, degraded: false }),
    signal,
  );

export type WebStations = { stations: ApiStation[]; seriesHash: string | null };

export const loadStations = (f: Fetcher, signal?: AbortSignal): Promise<WebStations> =>
  staticThenApi<WebStations>(
    async () => {
      const { stations, seriesHash } = (await getJson(f, `${STATIC}stations.json`, StaticStations, signal)).data;
      return { stations, seriesHash };
    },
    async () => ({
      stations: (await getJson(f, '/api/v1/stations', StationsAnswer, signal)).data.stations,
      seriesHash: null,
    }),
    signal,
  );

/** A snapshot file (recent, settled or latest) as the page's snapshot. */
const fromFile = (file: Parameters<typeof toSnapshot>[0]): WebSnapshot => ({
  ...toSnapshot(file),
  standIn: false,
  degraded: false,
});

async function fromStatic(
  f: Fetcher,
  source: Exclude<SnapshotSource, { kind: 'api' }>,
  t: number,
  seriesHash: string | null,
  signal?: AbortSignal,
): Promise<WebSnapshot> {
  const path = source.kind === 'latest' ? 'latest.json' : source.path;
  if (source.kind === 'latest') {
    const { data } = await getJson(f, `${STATIC}${path}`, LatestFile, signal);
    // latest.json is in stations.json's order of another publication: only the same series hash may be read with it.
    if (data.seriesHash !== seriesHash || Date.parse(data.t) !== t) throw new Error('latest_mismatch');
    return fromFile(data);
  }
  const { data } = await getJson(f, `${STATIC}${path}`, SnapshotFile, signal);
  if (Date.parse(data.t) !== t) throw new Error('file_mismatch');
  return fromFile(data);
}

/** The API's snapshot; Caddy's `X-Degraded: 1` answer is latest.json, shown under its own t. */
async function fromApi(f: Fetcher, t: number, signal?: AbortSignal): Promise<WebSnapshot> {
  const path = `/api/v1/snapshot?t=${new Date(t).toISOString().slice(0, 16)}Z`;
  const res = await f(path, signal);
  if (!res.ok) throw new HttpError(res.status);
  const body: unknown = await res.json();
  if (res.headers.get('x-degraded') !== '1') return { ...SnapshotAnswer.parse(body), standIn: false, degraded: false };
  const latest = LatestFile.safeParse(body);
  const file = latest.success ? latest.data : SnapshotFile.parse(body);
  return { ...toSnapshot(file), standIn: true, degraded: true };
}

/** A future t without the API: the held values of forecast/latest.json, with no state (the API's classes need it). */
async function fromForecastFile(f: Fetcher, t: number, signal?: AbortSignal): Promise<WebSnapshot> {
  const { data } = await getJson(f, `${STATIC}forecast/latest.json`, StaticForecastLatest, signal);
  return {
    t: new Date(t).toISOString(),
    values: [],
    forecasts: holdForecasts(data.runs, t).map((h) => ({ ...h, state: null, basis: null })),
    standIn: false,
    degraded: true,
  };
}

/** The snapshot at the quantised `t`; `meta` and `seriesHash` come from the same publication cycle's files. */
export async function loadSnapshot(
  f: Fetcher,
  t: number,
  meta: Pick<WebMeta, 'now' | 'dayVersions'>,
  seriesHash: string | null,
  signal?: AbortSignal,
): Promise<WebSnapshot> {
  const source = snapshotSource(t, meta);
  const api = async () => {
    const future = t > Date.parse(meta.now);
    if (!future) return fromApi(f, t, signal);
    // After now the API first (it holds the states); without it, or with Caddy's stand-in, the forecast file.
    try {
      const answer = await fromApi(f, t, signal);
      if (!answer.standIn) return answer;
    } catch (e) {
      if (aborted(signal)) throw e;
    }
    return fromForecastFile(f, t, signal);
  };
  if (source.kind === 'api') return api();
  return staticThenApi(() => fromStatic(f, source, t, seriesHash, signal), api, signal);
}
