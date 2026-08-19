/**
 * Typed client for our own API.
 *
 * The types come from @rws/shared, so a change to the server contract is a
 * compile error here rather than a runtime surprise.
 */

import type {
  ApiError,
  HealthResponse,
  LatestValue,
  Location,
  LocationDetail,
  ObservationsResponse,
  QuantitiesResponse,
  Resolution,
} from '@rws/shared';

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });

  if (!res.ok) {
    // The API always uses one error envelope; fall back only if that fails.
    let code = 'http_error';
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiError;
      if (body?.error) { code = body.error.code; message = body.error.message; }
    } catch { /* keep the fallback */ }
    throw new ApiRequestError(res.status, code, message);
  }

  return (await res.json()) as T;
}

export interface LocationFilters {
  grootheid?: string | undefined;
  compartiment?: string | undefined;
  q?: string | undefined;
}

export function fetchLocations(
  filters: LocationFilters = {},
  signal?: AbortSignal,
): Promise<Location[]> {
  const params = new URLSearchParams();
  if (filters.grootheid) params.set('grootheid', filters.grootheid);
  if (filters.compartiment) params.set('compartiment', filters.compartiment);
  if (filters.q) params.set('q', filters.q);
  const query = params.toString();
  return get<Location[]>(`/api/locations${query ? `?${query}` : ''}`, signal);
}

export function fetchQuantities(signal?: AbortSignal): Promise<QuantitiesResponse> {
  return get<QuantitiesResponse>('/api/quantities', signal);
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return get<HealthResponse>('/api/health', signal);
}

export function fetchLocation(code: string, signal?: AbortSignal): Promise<LocationDetail> {
  return get<LocationDetail>(`/api/locations/${encodeURIComponent(code)}`, signal);
}

export function fetchLatest(code: string, signal?: AbortSignal): Promise<LatestValue[]> {
  return get<LatestValue[]>(`/api/locations/${encodeURIComponent(code)}/latest`, signal);
}

export interface ObservationQuery {
  code: string;
  grootheid: string;
  compartiment?: string | undefined;
  from: Date;
  to: Date;
  resolution?: Resolution | undefined;
}

export function fetchObservations(
  query: ObservationQuery,
  signal?: AbortSignal,
): Promise<ObservationsResponse> {
  const params = new URLSearchParams({
    grootheid: query.grootheid,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
  });
  if (query.compartiment) params.set('compartiment', query.compartiment);
  if (query.resolution) params.set('resolution', query.resolution);
  return get<ObservationsResponse>(
    `/api/locations/${encodeURIComponent(query.code)}/observations?${params}`,
    signal,
  );
}
