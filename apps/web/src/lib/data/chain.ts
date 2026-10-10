import { type ApiStation, type Meta, ReachRiver, RiversManifest, toSnapshot } from '@rws/contracts';
import { holdForecasts } from '@rws/core/forecast-hold';
import { z } from 'zod';
import {
  type Contracts,
  PUBLIC_CONTRACTS,
  type ReachGraph,
  ReachGraphFile,
  type ReachTravelData,
  type StatusMode,
  type StatusPageData,
  type WebSources,
} from './contracts.ts';
import { type SnapshotSource, snapshotSource, type WebSnapshot } from './static.ts';
import { type WarningsAt, warningsAt, warningsSource } from './warnings.ts';

// The fetch chain (P9a): the static file first, the API on a 404, a 5xx, a network failure or a parse failure. The
// fetcher is injected so the chain is tested without a network; paths are relative (same origin, invariant 7).
// Every loader takes the site's schemas (contracts.ts; the public ones by default) and drops what `hidden` names.

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

const visibleMeta = (meta: WebMeta, c: Contracts): WebMeta => ({
  ...meta,
  sources: meta.sources.filter((s) => !c.hidden(s.id)),
  forecastHorizons: meta.forecastHorizons.filter((h) => !c.hidden(h.source)),
});

export const loadMeta = (f: Fetcher, signal?: AbortSignal, c: Contracts = PUBLIC_CONTRACTS): Promise<WebMeta> =>
  staticThenApi<WebMeta>(
    async () => visibleMeta((await getJson(f, `${STATIC}meta.json`, c.StaticMeta, signal)).data, c),
    async () =>
      visibleMeta(
        { ...(await getJson(f, '/api/v1/meta', c.MetaAnswer, signal)).data, dayVersions: {}, degraded: false },
        c,
      ),
    signal,
  );

export type WebStations = { stations: ApiStation[]; seriesHash: string | null };

/** A hidden source's series are dropped, and a station left without a series with it. */
const visibleStations = (stations: readonly ApiStation[], c: Contracts): ApiStation[] =>
  stations.flatMap((st) => {
    const series = st.series.filter((s) => !c.hidden(s.source));
    return series.length === 0 ? [] : [series.length === st.series.length ? st : { ...st, series }];
  });

export const loadStations = (f: Fetcher, signal?: AbortSignal, c: Contracts = PUBLIC_CONTRACTS): Promise<WebStations> =>
  staticThenApi<WebStations>(
    async () => {
      const { stations, seriesHash } = (await getJson(f, `${STATIC}stations.json`, c.StaticStations, signal)).data;
      return { stations: visibleStations(stations, c), seriesHash };
    },
    async () => ({
      stations: visibleStations((await getJson(f, '/api/v1/stations', c.StationsAnswer, signal)).data.stations, c),
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

/** latest.json's age of the newest value of each series with none at t (KG-233), by series; null: never one. */
const lastAgeOf = (file: { lapsed: readonly number[]; lapsedAge: readonly (number | null)[] }) =>
  new Map(file.lapsed.map((id, i) => [id, file.lapsedAge[i] ?? null]));

async function fromStatic(
  f: Fetcher,
  source: Exclude<SnapshotSource, { kind: 'api' }>,
  t: number,
  seriesHash: string | null,
  c: Contracts,
  signal?: AbortSignal,
): Promise<WebSnapshot> {
  const path = source.kind === 'latest' ? 'latest.json' : source.path;
  if (source.kind === 'latest') {
    const { data } = await getJson(f, `${STATIC}${path}`, c.LatestFile, signal);
    // latest.json is in stations.json's order of another publication: only the same series hash may be read with it.
    if (data.seriesHash !== seriesHash || Date.parse(data.t) !== t) throw new Error('latest_mismatch');
    // The 24-hour change the publisher computed (canonical units, null without both values), by series.
    const dh24 = new Map(data.series.map((id, i) => [id, data.dh24[i] ?? null]));
    return { ...fromFile(data), dh24, lastAge: lastAgeOf(data) };
  }
  const { data } = await getJson(f, `${STATIC}${path}`, c.SnapshotFile, signal);
  if (Date.parse(data.t) !== t) throw new Error('file_mismatch');
  return fromFile(data);
}

/** The API's snapshot; Caddy's `X-Degraded: 1` answer is latest.json, shown under its own t. */
async function fromApi(f: Fetcher, t: number, c: Contracts, signal?: AbortSignal): Promise<WebSnapshot> {
  const path = `/api/v1/snapshot?t=${new Date(t).toISOString().slice(0, 16)}Z`;
  const res = await f(path, signal);
  if (!res.ok) throw new HttpError(res.status);
  const body: unknown = await res.json();
  if (res.headers.get('x-degraded') !== '1') {
    const { t: at, values, forecasts } = c.SnapshotAnswer.parse(body);
    return { t: at, values, ...(forecasts === undefined ? {} : { forecasts }), standIn: false, degraded: false };
  }
  let file: Parameters<typeof toSnapshot>[0];
  let lastAge: WebSnapshot['lastAge'];
  try {
    const latest = c.LatestFile.parse(body);
    file = latest;
    lastAge = lastAgeOf(latest);
  } catch {
    file = c.SnapshotFile.parse(body);
  }
  return { ...toSnapshot(file), lastAge, standIn: true, degraded: true };
}

/** A future t without the API: the held values of forecast/latest.json, with no state (the API's classes need it). */
async function fromForecastFile(f: Fetcher, t: number, c: Contracts, signal?: AbortSignal): Promise<WebSnapshot> {
  const { data } = await getJson(f, `${STATIC}forecast/latest.json`, c.StaticForecastLatest, signal);
  return {
    t: new Date(t).toISOString(),
    values: [],
    forecasts: holdForecasts(data.runs, t).map((h) => ({ ...h, state: null, basis: null })),
    standIn: false,
    degraded: true,
  };
}

/** A hidden source's forecasts are dropped (its stations already are, so its values have nothing to show on). */
const visibleSnapshot = (s: WebSnapshot, c: Contracts): WebSnapshot =>
  s.forecasts === undefined ? s : { ...s, forecasts: s.forecasts.filter((x) => !c.hidden(x.source)) };

/** The snapshot at the quantised `t`; `meta` and `seriesHash` come from the same publication cycle's files. */
export async function loadSnapshot(
  f: Fetcher,
  t: number,
  meta: Pick<WebMeta, 'now' | 'dayVersions'>,
  seriesHash: string | null,
  signal?: AbortSignal,
  c: Contracts = PUBLIC_CONTRACTS,
): Promise<WebSnapshot> {
  const source = snapshotSource(t, meta);
  const api = async () => {
    const future = t > Date.parse(meta.now);
    if (!future) return fromApi(f, t, c, signal);
    // After now the API first (it holds the states); without it, or with Caddy's stand-in, the forecast file.
    try {
      const answer = await fromApi(f, t, c, signal);
      if (!answer.standIn) return answer;
    } catch (e) {
      if (aborted(signal)) throw e;
    }
    return fromForecastFile(f, t, c, signal);
  };
  const snapshot =
    source.kind === 'api'
      ? await api()
      : await staticThenApi(() => fromStatic(f, source, t, seriesHash, c, signal), api, signal);
  return visibleSnapshot(snapshot, c);
}

// --- P10a: sources, status, warnings, a station's recent file, the river list ------------------------------------

/** /data/v1/sources.json (static only; no API route): the credits and, on the owner site, each source's audience. */
export async function loadSources(
  f: Fetcher,
  signal?: AbortSignal,
  c: Contracts = PUBLIC_CONTRACTS,
): Promise<WebSources> {
  const { data } = await getJson(f, `${STATIC}sources.json`, c.Sources, signal);
  return {
    ...data,
    sources: data.sources.filter((s) => !c.hidden(s.id)),
    attribution: data.attribution.filter((a) => !c.hidden(a.source)),
  };
}

/** The default map mode of status.json (D10, plan C11); null when the file says none. A failure throws. */
export const loadStatusMode = async (
  f: Fetcher,
  signal?: AbortSignal,
  c: Contracts = PUBLIC_CONTRACTS,
): Promise<StatusMode> => (await getJson(f, `${STATIC}status.json`, c.StatusMode, signal)).data;

/** status.json for the Status page (P10b; static only): a source the site hides is dropped, a bad row never parses. */
export async function loadStatusPage(
  f: Fetcher,
  signal?: AbortSignal,
  c: Contracts = PUBLIC_CONTRACTS,
): Promise<StatusPageData> {
  const { data } = await getJson(f, `${STATIC}status.json`, c.StatusPage, signal);
  return { ...data, sources: data.sources.filter((s) => !c.hidden(s.id)) };
}

/**
 * The warning areas valid at `t` (warnings.ts chooses the file): latest.geojson at the current bucket, else the file of
 * t's UTC day (today.json or the dated file). That file missing (404), or today.json already of the next day, falls
 * back to latest.geojson filtered to `t`, marked incomplete.
 */
export async function loadWarnings(
  f: Fetcher,
  t: number,
  meta: Pick<WebMeta, 'now'>,
  signal?: AbortSignal,
  c: Contracts = PUBLIC_CONTRACTS,
): Promise<WarningsAt> {
  const choice = warningsSource(t, Date.parse(meta.now));
  const read = async (path: string) => (await getJson(f, `${STATIC}warnings/${path}`, c.WarningsFile, signal)).data;
  const visible = (w: WarningsAt): WarningsAt => ({
    ...w,
    features: w.features.filter((x) => !c.hidden(x.properties.source)),
  });
  if (choice.kind === 'dated') {
    try {
      const file = await read(choice.path);
      if (file.day === choice.day) return visible(warningsAt(file, t, false));
    } catch (e) {
      if (aborted(signal) || !(e instanceof HttpError && e.status === 404)) throw e;
    }
    return visible(warningsAt(await read('latest.geojson'), t, true));
  }
  return visible(warningsAt(await read('latest.geojson'), t, false));
}

/** series/<station>/recent.json: 7 days of raw values, the run and the references of each series of one station. */
export async function loadRecent(f: Fetcher, station: string, signal?: AbortSignal, c: Contracts = PUBLIC_CONTRACTS) {
  const { data } = await getJson(
    f,
    `${STATIC}series/${encodeURIComponent(station)}/recent.json`,
    c.StationRecent,
    signal,
  );
  return {
    ...data,
    series: data.series
      .filter((s) => !c.hidden(s.source))
      .map((s) => ({
        ...s,
        run: s.run !== null && c.hidden(s.run.source) ? null : s.run,
        references: s.references.filter((r) => !c.hidden(r.source)),
      })),
  };
}
export type WebRecent = Awaited<ReturnType<typeof loadRecent>>;

/** Only the river list of reaches-<ver>.json is read: ids and names for `?river=` and its chip (plan C17). */
const RiverList = z.looseObject({ rivers: z.array(ReachRiver).max(500) });
export type WebRiver = z.infer<typeof ReachRiver>;

export const RIVERS_MANIFEST_PATH = '/data/v1/rivers/manifest.json';

/**
 * The installed river release's manifest and its reaches file, fetched once for every reader (P10d). Each reader
 * parses its own section (riversOf, travelOf, graphOf), so a bad section never hides another.
 */
export async function loadReachesFile(f: Fetcher, signal?: AbortSignal) {
  const { data: manifest } = await getJson(f, RIVERS_MANIFEST_PATH, RiversManifest, signal);
  const { data: file } = await getJson(
    f,
    `/data/v1/rivers/${manifest.current.reaches.file}`,
    z.looseObject({}),
    signal,
  );
  return { manifest, file };
}
export type ReachesRead = Awaited<ReturnType<typeof loadReachesFile>>;

/** The river list: strict, an error means no river layer and no chip. */
export const riversOf = ({ manifest, file }: ReachesRead) => ({ manifest, rivers: RiverList.parse(file).rivers });

/** The travel times of the installed reaches file (P10b): only the valid pairs. */
export const travelOf = ({ file }: ReachesRead, c: Contracts = PUBLIC_CONTRACTS): ReachTravelData =>
  c.ReachTravel.parse(file);

/**
 * The stations and reaches of the graph (P10d neighbours): lenient, a bad row is dropped, a bad section is empty.
 * Parsed once per file, however many panels read it (the neighbour index is kept per graph).
 */
const graphs = new WeakMap<object, ReachGraph>();
export function graphOf({ file }: ReachesRead): ReachGraph {
  let graph = graphs.get(file);
  if (graph === undefined) {
    graph = ReachGraphFile.parse(file);
    graphs.set(file, graph);
  }
  return graph;
}

export const loadReachTravel = async (f: Fetcher, signal?: AbortSignal, c: Contracts = PUBLIC_CONTRACTS) =>
  travelOf(await loadReachesFile(f, signal), c);
