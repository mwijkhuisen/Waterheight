/**
 * Types shared between the server and the browser client.
 *
 * These describe *our* API, not Rijkswaterstaat's. Raw RWS field names
 * (Grootheid, MetingenLijst, Waarde_Alfanumeriek, ...) must never appear here
 * or in anything we send to a client.
 */

/** Quality codes that waterinfo.rws.nl itself considers displayable. */
export const DISPLAY_QUALITY_CODES = ['00', '10', '20', '25', '30', '40'] as const;

/** Marks a gap in the series. Comes with a 99999 sentinel value. */
export const GAP_QUALITY_CODE = '99';

export type Resolution = 'raw' | 'hourly' | 'daily';

export interface Location {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** Distinct quantity codes this location reports, e.g. ["WATHTE", "Q"]. */
  quantities: string[];
  lastSeenAt: string | null;
  active: boolean;
}

/** One measurable series at a location, as exposed to clients. */
export interface MeasurementType {
  seriesId: number;
  quantity: string;
  quantityLabel: string | null;
  compartment: string;
  compartmentLabel: string | null;
  unit: string | null;
  procesType: string;
  /**
   * Extra Aquo dimensions that distinguish this series from a sibling with the
   * same quantity — sampling height, instrument, and so on. Present so a client
   * can tell two same-quantity series apart; safe to ignore otherwise.
   */
  discriminators: Record<string, string | null>;
  /** The period actually held in our local store, not what RWS may have. */
  coverage: Coverage;
}

export interface Coverage {
  from: string | null;
  to: string | null;
  points: number;
}

export interface LocationDetail extends Location {
  measurementTypes: MeasurementType[];
}

export interface LatestValue {
  code: string;
  seriesId: number;
  quantity: string;
  unit: string | null;
  /** Null when the reading is a gap or non-numeric; check `valueText`. */
  value: number | null;
  valueText: string | null;
  timestamp: string;
  qualityCode: string | null;
  procesType: string;
}

export interface RawPoint {
  t: string;
  v: number | null;
  /** Raw quality code, so consumers can apply their own display policy. */
  q: string | null;
}

export interface AggregatePoint {
  t: string;
  min: number | null;
  max: number | null;
  mean: number | null;
  count: number;
}

export interface ObservationsResponse {
  code: string;
  seriesId: number;
  quantity: string;
  unit: string | null;
  procesType: string;
  from: string;
  to: string;
  /** The resolution actually served, which may differ from the one requested. */
  resolution: Resolution;
  requestedResolution: Resolution | null;
  /** True when the point cap forced a coarser resolution or a cut-off. */
  downsampled: boolean;
  truncated: boolean;
  points: RawPoint[] | AggregatePoint[];
  /** Set when served from cache after an upstream failure. */
  stale?: boolean;
  fetchedAt?: string;
  /** True when this location+quantity has no local history yet. */
  backfillPending?: boolean;
}

export interface QuantityInfo {
  code: string;
  label: string | null;
  /** Compartment codes this quantity is measured in. */
  compartments: string[];
  /** Number of currently active locations reporting it. */
  activeLocations: number;
}

export interface CompartmentInfo {
  code: string;
  label: string | null;
  activeLocations: number;
}

export interface QuantitiesResponse {
  quantities: QuantityInfo[];
  compartments: CompartmentInfo[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  upstream: {
    api: { reachable: boolean; checkedAt: string; latencyMs: number | null };
    wfs: { reachable: boolean; checkedAt: string; latencyMs: number | null };
  };
  cache: {
    locationsRefreshedAt: string | null;
    catalogueRefreshedAt: string | null;
    ageSeconds: number | null;
  };
  locations: { total: number; active: number };
  backfill: BackfillProgress;
}

export interface BackfillProgress {
  total: number;
  done: number;
  empty: number;
  failed: number;
  running: number;
  pending: number;
  rowsWritten: number;
  /** Jobs finished per minute over the recent window, if running. */
  throughputPerMin: number | null;
  etaSeconds: number | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
