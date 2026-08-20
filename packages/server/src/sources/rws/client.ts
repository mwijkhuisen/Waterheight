/**
 * HTTP client for the Rijkswaterstaat WaterWebservices.
 *
 * What is left here after the source split is what is actually specific to
 * this service: its request envelope, its API key header, and its status
 * semantics. Concurrency, retry and backoff live in ../http.js and are shared
 * with every other source.
 */

import { config } from '../../config.js';
import { SourceError, httpClientFor } from '../http.js';
import { RWS_SOURCE_ID, parseLocationKey } from '../registry.js';
import type {
  OphalenCatalogusResponse,
  OphalenWaarnemingenResponse,
  OphalenAantalWaarnemingenResponse,
} from './types.js';

const rws = config.sources.rws;
const http = httpClientFor(RWS_SOURCE_ID, rws.http);

/**
 * A Rijkswaterstaat failure.
 *
 * Kept as its own class rather than folded into `SourceError` so callers can
 * still branch on "this came from RWS" without inspecting a string; the
 * retry machinery only cares about the base class.
 */
export class RwsError extends SourceError {
  constructor(
    message: string,
    status: number | null,
    body?: unknown,
    retryable = false,
  ) {
    super(RWS_SOURCE_ID, message, status, body, retryable);
    this.name = 'RwsError';
  }
}

/** 204 means "no data matched", which is an empty result rather than a failure. */
export interface RwsResponse<T> {
  status: number;
  /** Null when the service returned 204. */
  data: T | null;
  latencyMs: number;
}

export interface PostOptions {
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

/**
 * POST a JSON body to an RWS endpoint.
 *
 * Status handling, all observed live:
 *   200 -> data
 *   204 -> no data matched; returned as `data: null`, not an error
 *   400 -> malformed body (not retryable)
 *   404 -> still carries a useful JSON body, which is parsed into the error
 *   405 -> a GET was sent where POST was required
 *   415 -> Content-Type was missing
 *   5xx -> retried with backoff
 */
export async function rwsPost<T>(
  path: string,
  body: unknown,
  options: PostOptions = {},
): Promise<RwsResponse<T>> {
  return http.request<RwsResponse<T>>(path, async (signal) => {
    const started = performance.now();

    const res = await fetch(rws.apiBase + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Not required today, but Rijkswaterstaat asks clients to send one
        // so future key-based rate limiting does not break them.
        'X-API-KEY': rws.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    const latencyMs = Math.round(performance.now() - started);

    if (res.status === 204) return { status: 204, data: null, latencyMs };

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }

    if (res.ok) return { status: res.status, data: parsed as T, latencyMs };

    // 5xx and 429 are worth another go; 4xx means we sent something wrong.
    const retryable = res.status >= 500 || res.status === 429;
    throw new RwsError(
      `RWS ${path} returned ${res.status}`,
      res.status,
      parsed,
      retryable,
    );
  }, options);
}

/**
 * Strip the source qualifier back off a location key.
 *
 * Locations are keyed `rws:lobith` internally, but Rijkswaterstaat has never
 * heard of that prefix -- sending it yields an empty result rather than an
 * error, which is the kind of failure that looks like "this station has no
 * data". Every call that names a location upstream goes through here.
 */
function upstreamCode(locationCode: string): string {
  const parsed = parseLocationKey(locationCode);
  return parsed?.sourceId === RWS_SOURCE_ID ? parsed.sourceCode : locationCode;
}

export interface PeriodeRequest {
  Begindatumtijd: string;
  Einddatumtijd: string;
}

/**
 * Build a period for a request window.
 *
 * The archive returns a constant +01:00 offset year-round rather than Dutch
 * local time, with no DST switching (verified across both 2025/2026
 * transitions). We send explicit UTC offsets and convert everything to UTC at
 * this boundary, so local time never reaches the database either way.
 */
export function toPeriode(from: Date, to: Date): PeriodeRequest {
  return {
    Begindatumtijd: from.toISOString().replace('Z', '+00:00'),
    Einddatumtijd: to.toISOString().replace('Z', '+00:00'),
  };
}

export interface FetchObservationsParams {
  locationCode: string;
  compartiment: string;
  grootheid: string;
  procesType?: string;
  from: Date;
  to: Date;
  signal?: AbortSignal;
}

export function fetchObservations(
  params: FetchObservationsParams,
): Promise<RwsResponse<OphalenWaarnemingenResponse>> {
  return rwsPost<OphalenWaarnemingenResponse>(
    '/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen',
    {
      Locatie: { Code: upstreamCode(params.locationCode) },
      AquoPlusWaarnemingMetadata: {
        AquoMetadata: {
          Compartiment: { Code: params.compartiment },
          Grootheid: { Code: params.grootheid },
          // Forecasts are archived too and would otherwise pollute history.
          ProcesType: params.procesType ?? 'meting',
        },
      },
      Periode: toPeriode(params.from, params.to),
    },
    { signal: params.signal },
  );
}

export function fetchLatest(
  locationCodes: string[],
  quantities: { compartiment: string; grootheid: string }[],
): Promise<RwsResponse<OphalenWaarnemingenResponse>> {
  return rwsPost<OphalenWaarnemingenResponse>(
    '/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen',
    {
      LocatieLijst: locationCodes.map((code) => ({ Code: upstreamCode(code) })),
      AquoPlusWaarnemingMetadataLijst: quantities.map((q) => ({
        AquoMetadata: {
          Compartiment: { Code: q.compartiment },
          Grootheid: { Code: q.grootheid },
        },
      })),
    },
  );
}

/**
 * Observation counts grouped by period.
 *
 * Phase 1 measured this at 5-200 s per location against ~1 s to fetch a real
 * month of data, so it is deliberately NOT used to pre-flight the backfill.
 * It stays available for planning and reporting.
 */
export function fetchCounts(
  locationCode: string,
  quantities: { compartiment: string; grootheid: string }[],
  from: Date,
  to: Date,
  groeperingsperiode: 'Jaar' | 'Maand' | 'Dag' = 'Maand',
): Promise<RwsResponse<OphalenAantalWaarnemingenResponse>> {
  return rwsPost<OphalenAantalWaarnemingenResponse>(
    '/ONLINEWAARNEMINGENSERVICES/OphalenAantalWaarnemingen',
    {
      AquoMetadataLijst: quantities.map((q) => ({
        Compartiment: { Code: q.compartiment },
        Grootheid: { Code: q.grootheid },
      })),
      Groeperingsperiode: groeperingsperiode,
      LocatieLijst: [{ Code: upstreamCode(locationCode) }],
      Periode: toPeriode(from, to),
    },
  );
}

/** The catalogue answered in ~1.2 s live, but is still cached rather than hit per request. */
export function fetchCatalogue(): Promise<RwsResponse<OphalenCatalogusResponse>> {
  return rwsPost<OphalenCatalogusResponse>('/METADATASERVICES/OphalenCatalogus', {
    CatalogusFilter: {
      Compartimenten: true,
      Grootheden: true,
      Parameters: true,
      Eenheden: true,
    },
  });
}

function wfsUrl(params: Record<string, string>): URL {
  const url = new URL(rws.wfsUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

/**
 * Authoritative feature count for a layer, via resultType=hits.
 *
 * One small XML response instead of downloading ~173 MB, so the ingester can
 * check afterwards that it actually received the whole layer.
 */
export async function fetchWfsFeatureCount(
  typename = 'locatiesmetlaatstewaarneming',
  signal?: AbortSignal,
): Promise<number> {
  const url = wfsUrl({
    SERVICE: 'WFS',
    VERSION: '1.1.0',
    REQUEST: 'GetFeature',
    TYPENAME: typename,
    resultType: 'hits',
  });

  const res = await fetch(url, { signal: signal ?? http.timeoutSignal() });
  if (!res.ok) {
    throw new RwsError(`WFS hits returned ${res.status}`, res.status, await res.text().catch(() => null));
  }

  const text = await res.text();
  const match = /numberOfFeatures="(\d+)"/.exec(text);
  if (!match) throw new RwsError('WFS hits response had no numberOfFeatures', null, text.slice(0, 300));
  return Number(match[1]);
}

/**
 * Streams one page of the WFS layer; the caller parses it line by line.
 *
 * Paging matters here. The full layer is ~173 MB and streaming it in one
 * request is unreliable in practice: observed runs delivered 68% and 92% of the
 * rows before the stream degraded into field-shifted garbage. A page is ~18 MB,
 * so a failure costs seconds and can simply be retried.
 *
 * `sortBy` is not optional -- without it the service refuses to page at all
 * ("Cannot do natural order without a primary key").
 */
export async function fetchWfsLatestPage(
  columns: readonly string[],
  options: { startIndex: number; count: number; signal?: AbortSignal },
): Promise<Response> {
  const url = wfsUrl({
    SERVICE: 'WFS',
    VERSION: '1.1.0',
    REQUEST: 'GetFeature',
    TYPENAME: 'locatiesmetlaatstewaarneming',
    outputFormat: 'csv',
    PROPERTYNAME: columns.join(','),
    sortBy: 'CODE',
    startIndex: String(options.startIndex),
    maxFeatures: String(options.count),
  });

  const res = await fetch(url, {
    signal: options.signal ?? http.timeoutSignal(),
  });
  if (!res.ok) {
    throw new RwsError(`WFS returned ${res.status}`, res.status, await res.text().catch(() => null));
  }
  return res;
}
