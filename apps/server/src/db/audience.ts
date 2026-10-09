// The ONLY file that names the pub_* and own_* views (A§5; enforced by
// scripts/check-boundaries.ts). It maps an audience to its view family and its
// database roles, so no code path can hard-code an owner view: every query
// takes its view names from here.
//
// `pub_*` keeps rows whose effective audience is public; `own_*` keeps public
// and owner rows; `off` rows are in neither. The `api` variants additionally
// require the `api` licence channel (catalogue §0.7). The views themselves are
// written by scripts/gen-views.ts into db/migrations from this table.

/** The audiences that have an output channel (an `off` source has none). */
export const CHANNEL_AUDIENCES = ['public', 'owner'] as const;
export type ChannelAudience = (typeof CHANNEL_AUDIENCES)[number];

export const VIEWS = {
  public: {
    station: 'pub_station',
    series: 'pub_series',
    obs: 'pub_obs',
    obsLatest: 'pub_obs_latest',
    obs1h: 'pub_obs_1h',
    obs1d: 'pub_obs_1d',
    reference: 'pub_reference',
    class: 'pub_class',
    forecastRun: 'pub_forecast_run',
    forecastValue: 'pub_forecast_value',
    warning: 'pub_warning',
    attribution: 'pub_attribution',
    sourceHealth: 'pub_source_health',
    twinCheck: 'pub_twin_check',
    ingestBatch: 'pub_ingest_batch',
    meta: 'pub_meta',
    gaugeZero: 'pub_gauge_zero',
    dirty: 'pub_dirty',
    dayVersion: 'pub_day_version',
    source: 'pub_source',
    api: {
      series: 'pub_api_series',
      obs: 'pub_api_obs',
      obs1h: 'pub_api_obs_1h',
      obs1d: 'pub_api_obs_1d',
      forecastRun: 'pub_api_forecast_run',
      forecastValue: 'pub_api_forecast_value',
    },
  },
  owner: {
    station: 'own_station',
    series: 'own_series',
    obs: 'own_obs',
    obsLatest: 'own_obs_latest',
    obs1h: 'own_obs_1h',
    obs1d: 'own_obs_1d',
    reference: 'own_reference',
    class: 'own_class',
    forecastRun: 'own_forecast_run',
    forecastValue: 'own_forecast_value',
    warning: 'own_warning',
    attribution: 'own_attribution',
    sourceHealth: 'own_source_health',
    twinCheck: 'own_twin_check',
    ingestBatch: 'own_ingest_batch',
    meta: 'own_meta',
    gaugeZero: 'own_gauge_zero',
    dirty: 'own_dirty',
    dayVersion: 'own_day_version',
    source: 'own_source',
    api: {
      series: 'own_api_series',
      obs: 'own_api_obs',
      obs1h: 'own_api_obs_1h',
      obs1d: 'own_api_obs_1d',
      forecastRun: 'own_api_forecast_run',
      forecastValue: 'own_api_forecast_value',
    },
  },
} as const satisfies Record<ChannelAudience, Family>;

type Family = Record<DisplayView, string> & { api: Record<ApiView, string> };
export type DisplayView =
  | 'station'
  | 'series'
  | 'obs'
  | 'obsLatest'
  | 'obs1h'
  | 'obs1d'
  | 'reference'
  | 'class'
  | 'forecastRun'
  | 'forecastValue'
  | 'warning'
  | 'attribution'
  | 'sourceHealth'
  | 'twinCheck'
  | 'ingestBatch'
  | 'meta'
  | 'gaugeZero'
  | 'dirty'
  | 'dayVersion'
  | 'source';
export type ApiView = 'series' | 'obs' | 'obs1h' | 'obs1d' | 'forecastRun' | 'forecastValue';

/**
 * Views that exist in one family only. Public health may show how many
 * owner-audience sources are healthy, as two counts and nothing else (A§6),
 * and the loader's own state (when it last computed, its backlog): numbers
 * about the loader, none about a source. The owner channel may read each owner
 * source's private_basis.
 */
export const PUBLIC_ONLY_VIEWS = { ownerHealth: 'pub_owner_health', loader: 'pub_loader' } as const;
export const OWNER_ONLY_VIEWS = { privateBasis: 'own_private_basis' } as const;

/**
 * "The value of every series at instant T" (A§8 Q1), one set-returning
 * function per family: `SELECT * FROM <name>($1)`. A LIMIT cannot be pushed
 * into a security_barrier view, so the same lookup through the obs view reads
 * and sorts each series' whole staleness window; the function takes one
 * backward step on the (series_id, ts) index per series. It applies the
 * family's audience, role and channel filter itself, like the views.
 */
export const OBS_AT = { public: 'pub_obs_at', owner: 'own_obs_at' } as const satisfies Record<ChannelAudience, string>;

/**
 * "The latest forecast run as of T" (A§8 Q2, P8a), one set-returning function per family:
 * `SELECT * FROM <name>($asof, $t)` gives, per (series, source), the latest run issued and fetched at or before
 * `asof`, only if it reaches `t` (never an older run that reaches further, never another source's), with its value
 * step-held at `t`; `t` before `asof` gives nothing. It applies the family's audience, role and display-channel
 * filters to the series and to the run's own source, like the forecast views.
 */
export const FORECAST_AT = { public: 'pub_forecast_at', owner: 'own_forecast_at' } as const satisfies Record<
  ChannelAudience,
  string
>;

/** Which effective audiences a family's rows may have. */
export const FAMILY_AUDIENCES = {
  public: ['public'],
  owner: ['public', 'owner'],
} as const satisfies Record<ChannelAudience, readonly ChannelAudience[]>;

/**
 * Which families write the owner variant of reaches-<ver>.json (P11a, D-C): the owner publisher splits the installed
 * river release at the owner stations; the public publisher never builds a reaches file (the public one comes from
 * rws-rivers-refresh). The only switch for it.
 */
export const REACHES_VARIANT = { public: false, owner: true } as const satisfies Record<ChannelAudience, boolean>;

/** The read-only login roles that may SELECT a family, and nothing else (A§12.2). */
export const FAMILY_ROLES = {
  public: ['rws_api', 'rws_publish'],
  owner: ['rws_owner_api'],
} as const satisfies Record<ChannelAudience, readonly string[]>;

/** The database role of a process: `api` and `publish` per audience (A§4). */
export const DB_ROLE = {
  public: { api: 'rws_api', publish: 'rws_publish' },
  owner: { api: 'rws_owner_api', publish: 'rws_owner_api' },
} as const satisfies Record<ChannelAudience, { api: string; publish: string }>;

/** Every view of a family, for grants and for the tests that sweep a whole family. */
export function familyViews(audience: ChannelAudience): string[] {
  const { api, ...display } = VIEWS[audience];
  const only = audience === 'public' ? PUBLIC_ONLY_VIEWS : OWNER_ONLY_VIEWS;
  return [...Object.values(display), ...Object.values(api), ...Object.values(only)];
}

// Row types of the views that code reads in P2a (health). A test compares
// them with the columns the database reports.

export type SourceHealthRow = {
  source_id: string;
  last_fetch_ok: Date | null;
  last_new_data: Date | null;
  newest_ts: Date | null;
  consecutive_failures: number;
  quarantine_count: number;
  lag_p95_s: number | null;
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  detail: unknown;
  updated_at: Date;
};
export const SOURCE_HEALTH_COLUMNS = [
  'source_id',
  'last_fetch_ok',
  'last_new_data',
  'newest_ts',
  'consecutive_failures',
  'quarantine_count',
  'lag_p95_s',
  'status',
  'detail',
  'updated_at',
] as const satisfies readonly (keyof SourceHealthRow)[];

/** The display window (D9): app_meta `data_epoch` and `display_start`; the same in both families. */
export type MetaRow = { data_epoch: Date | null; display_start: Date | null };

export type OwnerHealthRow = { healthy: number; total: number };
export const OWNER_HEALTH_COLUMNS = ['healthy', 'total'] as const satisfies readonly (keyof OwnerHealthRow)[];

export type LoaderRow = {
  computed_at: Date | null;
  backlog_files: number;
  backlog_bytes: string;
  backlog_age_s: number | null;
  bad_manifest_lines: number;
};
export const LOADER_COLUMNS = [
  'computed_at',
  'backlog_files',
  'backlog_bytes',
  'backlog_age_s',
  'bad_manifest_lines',
] as const satisfies readonly (keyof LoaderRow)[];

export type IngestBatchRow = {
  id: string;
  source_id: string;
  spec_id: string;
  fetched_at: Date;
  parse_status: 'ok' | 'quarantined' | 'skipped';
  n_rows: number;
  n_new: number;
  n_changed: number;
  error: string | null;
  loaded_at: Date;
};
export const INGEST_BATCH_COLUMNS = [
  'id',
  'source_id',
  'spec_id',
  'fetched_at',
  'parse_status',
  'n_rows',
  'n_new',
  'n_changed',
  'error',
  'loaded_at',
] as const satisfies readonly (keyof IngestBatchRow)[];

export type TwinCheckRow = {
  twin_id: string;
  window_end: Date;
  n_aligned: number;
  median_delta: number | null;
  max_delta: number | null;
  lag_min: number | null;
  ok: boolean;
};
export const TWIN_CHECK_COLUMNS = [
  'twin_id',
  'window_end',
  'n_aligned',
  'median_delta',
  'max_delta',
  'lag_min',
  'ok',
] as const satisfies readonly (keyof TwinCheckRow)[];
