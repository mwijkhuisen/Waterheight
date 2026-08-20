/**
 * HTTP client for the Rijkswaterstaat WaterWebservices.
 *
 * Responsibilities beyond plain fetch: a politeness cap on outbound
 * concurrency, retry with exponential backoff and jitter, and mapping the
 * service's status codes onto something callers can branch on without
 * memorising them.
 */

import { config } from '../config.js';
import type {
  OphalenCatalogusResponse,
  OphalenWaarnemingenResponse,
  OphalenAantalWaarnemingenResponse,
} from './types.js';

export class RwsError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: unknown,
    readonly retryable = false,
  ) {
    super(message);
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

/** Bounded-concurrency gate so we stay a polite API consumer. */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const gate = new Semaphore(config.rws.maxConcurrency);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, so retries do not synchronise. */
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.random() * base;
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
  const maxRetries = options.maxRetries ?? config.rws.maxRetries;
  const timeoutMs = options.timeoutMs ?? config.rws.timeoutMs;
  let lastError: RwsError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt - 1));

    try {
      return await gate.run(async () => {
        const started = performance.now();
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeout])
          : timeout;

        const res = await fetch(config.rws.apiBase + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Not required today, but Rijkswaterstaat asks clients to send one
            // so future key-based rate limiting does not break them.
            'X-API-KEY': config.rws.apiKey,
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
      });
    } catch (err) {
      if (err instanceof RwsError) {
        lastError = err;
        if (!err.retryable) throw err;
      } else {
        // Network failures and timeouts are retryable.
        lastError = new RwsError(
          `RWS ${path} request failed: ${(err as Error).message}`,
          null,
          undefined,
          true,
        );
      }
    }
  }

  throw lastError ?? new RwsError(`RWS ${path} failed`, null);
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
      Locatie: { Code: params.locationCode },
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

/**
 * Which series OphalenLaatsteWaarnemingen should answer for.
 *
 * Everything past `grootheid` is optional and exists to narrow the answer.
 * A (compartiment, grootheid) pair alone matches every series a location ever
 * had for that quantity, live or long dead, and each one comes back with its
 * full ~5 KiB AquoMetadata block: 18 locations asked for `CONCTTE` returned
 * 4,622 series and 7.6 MB in 9.2 s, of which 44 series carried a reading from
 * the last six hours. Adding the parameter, instrument and determination
 * method the series is already known to use returned the same 44 live series
 * in 137 KiB and 0.44 s -- 56x less to download for exactly the same data.
 * Measured live on 2026-08-20; see the poll notes in the README.
 */
export interface LatestFilter {
  compartiment: string;
  grootheid: string;
  /** Defaults to 'meting' so archived forecasts stay out. */
  procesType?: string | undefined;
  parameter?: string | null | undefined;
  meetapparaat?: string | null | undefined;
  waardebepalingMethode?: string | null | undefined;
}

function latestMetadata(filter: LatestFilter): Record<string, unknown> {
  return {
    Compartiment: { Code: filter.compartiment },
    Grootheid: { Code: filter.grootheid },
    ProcesType: filter.procesType ?? 'meting',
    ...(filter.parameter ? { Parameter: { Code: filter.parameter } } : {}),
    ...(filter.meetapparaat ? { MeetApparaat: { Code: filter.meetapparaat } } : {}),
    ...(filter.waardebepalingMethode
      ? { WaardeBepalingsMethode: { Code: filter.waardebepalingMethode } }
      : {}),
  };
}

export function fetchLatest(
  locationCodes: string[],
  filters: LatestFilter[],
  options: PostOptions = {},
): Promise<RwsResponse<OphalenWaarnemingenResponse>> {
  return rwsPost<OphalenWaarnemingenResponse>(
    '/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen',
    {
      LocatieLijst: locationCodes.map((Code) => ({ Code })),
      AquoPlusWaarnemingMetadataLijst: filters.map((filter) => ({
        AquoMetadata: latestMetadata(filter),
      })),
    },
    options,
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
      LocatieLijst: [{ Code: locationCode }],
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
  const url = new URL(config.rws.wfsUrl);
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

  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(config.rws.timeoutMs) });
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
    signal: options.signal ?? AbortSignal.timeout(config.rws.timeoutMs),
  });
  if (!res.ok) {
    throw new RwsError(`WFS returned ${res.status}`, res.status, await res.text().catch(() => null));
  }
  return res;
}
