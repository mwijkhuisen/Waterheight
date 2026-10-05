import { readFileSync, writeFileSync } from 'node:fs';
import {
  type ChannelAudience,
  FAMILY_AUDIENCES,
  FAMILY_ROLES,
  FORECAST_AT,
  familyViews,
  INGEST_BATCH_COLUMNS,
  OBS_AT,
  OWNER_ONLY_VIEWS,
  PUBLIC_ONLY_VIEWS,
  SOURCE_HEALTH_COLUMNS,
  TWIN_CHECK_COLUMNS,
  VIEWS,
} from '../apps/server/src/db/audience.ts';

// Writes the view migration (A§6 "Audiences, views and roles"). The four
// families (display and api, public and owner) come from ONE template: the
// audience set and the api switch are its only parameters, so a filter cannot
// be present in one family and missing in another. The output is committed
// plain SQL (reviewed like any migration); CI regenerates it and diffs.
//
//   node scripts/gen-views.ts            # rewrite the migrations
//   node scripts/gen-views.ts --check    # exit 1 if a committed file differs
//
// Production has applied the first views migration, so its text never changes.
// A view added later goes into a generated migration of its own (LATER); a
// changed body goes into a migration that replaces the view (P8a: the forecast
// value views gained p30 and p70, FORECAST_MIGRATION), while the first
// migration keeps the frozen body it was applied with.

export const VIEWS_MIGRATION = new URL('../db/migrations/20261003000006_views.sql', import.meta.url);

type Params = { audience: ChannelAudience; api: boolean };

const audienceIn = (col: string, audience: ChannelAudience) =>
  `${col} IN (${FAMILY_AUDIENCES[audience].map((a) => `'${a}'`).join(', ')})`;

/** A series is visible in a family: effective audience, role primary, and the family's licence channels. */
const seriesVisible = (e: string, p: Params) =>
  `${audienceIn(`${e}.audience`, p.audience)} AND ${e}.role = 'primary' AND ${e}.lic_display${p.api ? ` AND ${e}.lic_api` : ''}`;

/** A dependent row's own source is visible in a family (reference, class, forecast run, warning, attribution). */
const sourceVisible = (s: string, p: Params) =>
  `${audienceIn(`${s}.audience`, p.audience)} AND ${s}.lic_display${p.api ? ` AND ${s}.lic_api` : ''}`;

/**
 * Rows older than the source's own public window need the history_export
 * channel (A§6, A§9.2). The cutoff moves with each statement: `now()` is the
 * transaction start, which a reader holding a transaction open would keep.
 */
const historyAllowed = (e: string, ts: string) =>
  `(${e}.lic_history_export OR ${ts} >= statement_timestamp() - ${e}.history_window)`;

const obsLike = (table: string, ts: string, columns: string) => (p: Params) =>
  `
SELECT ${columns}
FROM ${table} o
JOIN series_eff e ON e.series_id = o.series_id
WHERE ${seriesVisible('e', p)}
  AND ${historyAllowed('e', `o.${ts}`)}`;

const forecastRunFrom = (p: Params) => `
FROM forecast_run r
JOIN series_eff e ON e.series_id = r.series_id
JOIN source fs ON fs.id = r.source_id
WHERE ${seriesVisible('e', p)}
  AND ${sourceVisible('fs', p)}`;

/** Views added after VIEWS_MIGRATION, by logical name, and the migration each is generated into. */
export const LATER = {
  meta: new URL('../db/migrations/20261014000002_views_meta.sql', import.meta.url),
  gaugeZero: new URL('../db/migrations/20261024000001_views_gauge_zero.sql', import.meta.url),
} as const;

const ROLLUP_COLUMNS = 'o.series_id, o.bucket, o.vmin, o.vmax, o.vavg, o.vlast, o.n, o.qc_or';

/** The body of each view, for one family. The keys are the logical names of audience.ts. */
const BODY = {
  // P9a: the effective api and history_export channels and the history window appended (the publisher's window rule,
  // P9b's per-series api flag).
  series: (p: Params) => `
SELECT s.id, s.station_id, s.source_id, s.quantity, s.value_kind, s.native_unit, s.to_canonical, s.datum,
       s.expected_step, s.staleness_limit, s.active, e.audience, e.lic_api, e.lic_history_export, e.history_window
FROM series s
JOIN series_eff e ON e.series_id = s.id
WHERE ${seriesVisible('e', p)}`,

  // A station appears only if it has a visible series.
  station: (p: Params) => `
SELECT st.id, st.name, st.water_name, st.country, st.lon, st.lat, st.river_id, st.reach_id, st.km_official,
       st.km_system, st.km_to_nl_entry, st.nl_entry_node, st.flags, st.tier
FROM station st
WHERE EXISTS (SELECT 1 FROM series_eff e WHERE e.station_id = st.id AND ${seriesVisible('e', p)})`,

  obs: obsLike('obs', 'ts', 'o.series_id, o.ts, o.value, o.qc'),
  obsLatest: obsLike('obs_latest', 'ts', 'o.series_id, o.ts, o.value, o.qc'),
  obs1h: obsLike('obs_1h', 'bucket', ROLLUP_COLUMNS),
  obs1d: obsLike('obs_1d', 'bucket', ROLLUP_COLUMNS),

  // A reference needs a visible series AND a visible publisher: an owner-audience
  // threshold never classifies a public marker (invariant 11).
  reference: (p: Params) => `
SELECT r.series_id, r.source_id, r.kind, r.value, r.unit, r.semantics, r.percentile_convention, r.period,
       r.season_from_md, r.season_to_md, r.priority, r.basis_label, r.valid
FROM reference_value r
JOIN series_eff e ON e.series_id = r.series_id
JOIN source rs ON rs.id = r.source_id
WHERE ${seriesVisible('e', p)}
  AND ${sourceVisible('rs', p)}`,

  // A station class needs a visible station; an area class only a visible source.
  class: (p: Params) => `
SELECT c.subject_type, c.subject_id, c.ts, c.source_id, c.provider_code, c.provider_label, c.level_norm
FROM class_obs c
JOIN source cs ON cs.id = c.source_id
WHERE ${sourceVisible('cs', p)}
  AND (c.subject_type = 'area'
       OR EXISTS (SELECT 1 FROM series_eff e WHERE e.station_id = c.subject_id AND ${seriesVisible('e', p)}))`,

  forecastRun: (p: Params) => `
SELECT r.id, r.series_id, r.source_id, r.issued_at, r.issued_inferred, r.first_valid, r.last_valid, r.fetched_at,
       r.kind, r.step, r.provider_segment_end${forecastRunFrom(p)}`,

  // P8a: p30 and p70 appended (CREATE OR REPLACE VIEW only adds columns at the end). P9b: the history rule on the
  // valid time, as on every observation view (HISTORY_MIGRATION; the P8a body is frozen as forecastValueV2).
  forecastValue: (p: Params) => `
SELECT v.run_id, v.valid_ts, v.value, v.p05, v.p10, v.p25, v.p50, v.p75, v.p90, v.p95, v.vmin, v.vmax, v.flags,
       v.p30, v.p70
FROM forecast_value v
WHERE EXISTS (SELECT 1${forecastRunFrom(p).replaceAll('\n', '\n  ')}
    AND r.id = v.run_id
    AND ${historyAllowed('e', 'v.valid_ts')})`,

  warning: (p: Params) => `
SELECT w.id, w.source_id, w.area_key, w.name, w.geometry_geojson, w.level_norm, w.level_raw, w.label_raw, w.valid,
       w.issued_at
FROM warning_area w
JOIN source ws ON ws.id = w.source_id
WHERE ${sourceVisible('ws', p)}`,

  attribution: (p: Params) => `
SELECT a.source_id, a.ord, a.lang, a.text, a.url, a.needs_date, a.date_kind, a.logo_allowed, a.required
FROM attribution a
JOIN source s ON s.id = a.source_id
WHERE ${sourceVisible('s', p)}`,

  sourceHealth: (p: Params) => `
SELECT h.source_id, h.last_fetch_ok, h.last_new_data, h.newest_ts, h.consecutive_failures, h.quarantine_count,
       EXTRACT(EPOCH FROM h.lag_p95)::double precision AS lag_p95_s, h.status, h.detail, h.updated_at
FROM source_health h
JOIN source s ON s.id = h.source_id
WHERE ${audienceIn('s.audience', p.audience)}`,

  // A twin is visible only if BOTH of its series are in the family's audience
  // (a twin is never role primary on both sides, so there is no role filter).
  twinCheck: (p: Params) => `
SELECT t.twin_id, t.window_end, t.n_aligned, t.median_delta, t.max_delta, t.lag_min, t.ok
FROM twin_check t
JOIN twin w ON w.id = t.twin_id
JOIN series_eff a ON a.series_id = w.series_a
JOIN series_eff b ON b.series_id = w.series_b
WHERE ${audienceIn('a.audience', p.audience)} AND a.lic_display
  AND ${audienceIn('b.audience', p.audience)} AND b.lic_display`,

  // The display window (D9) from app_meta: two instants, no audience data, the
  // same in both families. The values are stored with an explicit offset, so the
  // cast does not depend on the session's time zone.
  meta: (_: Params) => `
SELECT (SELECT (m.value #>> '{}')::timestamptz FROM app_meta m WHERE m.key = 'data_epoch') AS data_epoch,
       (SELECT (m.value #>> '{}')::timestamptz FROM app_meta m WHERE m.key = 'display_start') AS display_start`,

  // P7b: the gauge zeros of the family's visible series, for the detail view's "≈ m NAP" (D16). No batch id.
  gaugeZero: (p: Params) => `
SELECT z.series_id, z.value_m, z.datum, z.valid
FROM gauge_zero z
JOIN series_eff e ON e.series_id = z.series_id
WHERE ${seriesVisible('e', p)}`,

  // P9a: the publishers' dirty log of the family (the loader writes one row per kind per transaction; A§9.1).
  dirty: (p: Params) => `
SELECT d.id, d.kind, d.from_ts, d.to_ts, d.stations, d.created_at
FROM publish_dirty d
WHERE d.family = '${p.audience}'`,

  // P9a: the family's settled-day versions (app_meta, written by the loader and migrate): one row per bumped day.
  dayVersion: (p: Params) => `
SELECT j.key::date AS day, (j.value ->> 'v')::int AS version, j.value ->> 'reason' AS reason,
       (j.value ->> 'at')::timestamptz AS at
FROM app_meta m
CROSS JOIN LATERAL jsonb_each(m.value) j
WHERE m.key = 'day_versions:${p.audience}'`,

  // P9a: the family's sources for sources.json: names, licence kind and the provider's terms page.
  source: (p: Params) => `
SELECT s.id, s.name, pr.name AS provider, s.licence_kind, pr.terms_url, s.audience
FROM source s
JOIN provider pr ON pr.id = s.provider_id
WHERE ${sourceVisible('s', p)}`,

  // No archive key and no hash: a batch is named by its id.
  ingestBatch: (p: Params) => `
SELECT b.id, b.source_id, b.spec_id, b.fetched_at, b.parse_status, b.n_rows, b.n_new, b.n_changed, b.error,
       b.loaded_at
FROM ingest_batch b
JOIN source s ON s.id = b.source_id
WHERE ${audienceIn('s.audience', p.audience)}`,
} satisfies Record<keyof Omit<(typeof VIEWS)['public'], 'api'>, (p: Params) => string>;

/** The forecast value views as the first views migration created them: frozen, because that migration never changes. */
const forecastValueV1 = (p: Params) => `
SELECT v.run_id, v.valid_ts, v.value, v.p05, v.p10, v.p25, v.p50, v.p75, v.p90, v.p95, v.vmin, v.vmax, v.flags
FROM forecast_value v
WHERE EXISTS (SELECT 1${forecastRunFrom(p).replaceAll('\n', '\n  ')}
    AND r.id = v.run_id)`;

/** The forecast value views as P8a's FORECAST_MIGRATION created them (p30, p70 appended): frozen, like V1. */
const forecastValueV2 = (p: Params) => `
SELECT v.run_id, v.valid_ts, v.value, v.p05, v.p10, v.p25, v.p50, v.p75, v.p90, v.p95, v.vmin, v.vmax, v.flags,
       v.p30, v.p70
FROM forecast_value v
WHERE EXISTS (SELECT 1${forecastRunFrom(p).replaceAll('\n', '\n  ')}
    AND r.id = v.run_id)`;

/** The series views as the first views migration created them: frozen, like forecastValueV1. */
const seriesV1 = (p: Params) => `
SELECT s.id, s.station_id, s.source_id, s.quantity, s.value_kind, s.native_unit, s.to_canonical, s.datum,
       s.expected_step, s.staleness_limit, s.active, e.audience
FROM series s
JOIN series_eff e ON e.series_id = s.id
WHERE ${seriesVisible('e', p)}`;

/** The body a view had in the first views migration. */
const firstBody = (logical: keyof typeof BODY) =>
  logical === 'forecastValue' ? forecastValueV1 : logical === 'series' ? seriesV1 : BODY[logical];

const SERIES_EFF = `
-- The effective audience and licence channels of every series: its source's
-- values, narrowed by the series (public > owner > off; a channel stays on only
-- if both allow it). Internal: granted to no login role.
CREATE VIEW series_eff AS
SELECT s.id AS series_id, s.station_id, s.source_id, s.role,
       LEAST(src.audience, COALESCE(s.audience, src.audience)) AS audience,
       src.lic_display        AND COALESCE((s.lic_override ->> 'display')::boolean, true)        AS lic_display,
       src.lic_api            AND COALESCE((s.lic_override ->> 'api')::boolean, true)            AS lic_api,
       src.lic_bulk_export    AND COALESCE((s.lic_override ->> 'bulk_export')::boolean, true)    AS lic_bulk_export,
       src.lic_history_export AND COALESCE((s.lic_override ->> 'history_export')::boolean, true) AS lic_history_export,
       src.history_window
FROM series s
JOIN source src ON src.id = s.source_id;`;

const view = (name: string, body: string) => `CREATE VIEW ${name} WITH (security_barrier = true) AS${body};`;

/**
 * A§8 Q1 as a function (see OBS_AT in audience.ts). SECURITY DEFINER, because
 * the readers have no grant on the tables: a plain SQL body without dynamic
 * SQL, a fixed search_path with pg_temp last, the time zone fixed to UTC (the
 * caller's session setting never reaches it), every relation schema-qualified,
 * and EXECUTE for the family's roles only.
 */
const obsAt = (name: string, p: Params) => `CREATE FUNCTION ${name}(p_t timestamptz)
RETURNS TABLE (series_id int, ts timestamptz, value real, qc int2)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
ROWS 3000
AS $$
  SELECT e.series_id, o.ts, o.value, o.qc
  FROM public.series_eff e
  JOIN public.series s ON s.id = e.series_id
  CROSS JOIN LATERAL (
    SELECT o.ts, o.value, o.qc
    FROM public.obs o
    WHERE o.series_id = e.series_id AND o.ts <= p_t AND o.ts > p_t - s.staleness_limit
      AND ${historyAllowed('e', 'o.ts')}
    ORDER BY o.ts DESC
    LIMIT 1) o
  WHERE s.active AND ${seriesVisible('e', p)}
$$;
REVOKE ALL ON FUNCTION ${name}(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${name}(timestamptz) TO ${FAMILY_ROLES[p.audience].join(', ')};`;

// The columns code reads must be the columns the views select (audience.ts row types).
function assertColumns(body: string, columns: readonly string[], what: string): void {
  const select = body.slice(0, body.indexOf('\nFROM'));
  for (const c of columns) {
    if (!new RegExp(`[. ]${c}(,|\\s|$)`).test(select)) throw new Error(`gen-views: ${what} lacks column ${c}`);
  }
}

/** P9a: the view pairs of PUBLISH_MIGRATION. */
const PUBLISH_LATER = ['dirty', 'dayVersion', 'source'] as const;

const laterNames: readonly string[] = [...(Object.keys(LATER) as (keyof typeof LATER)[]), ...PUBLISH_LATER].flatMap(
  (l) => [VIEWS.public[l], VIEWS.owner[l]],
);

export function viewsMigration(): string {
  const up: string[] = [SERIES_EFF.trim()];
  const names: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    const family = VIEWS[audience];
    const { api, ...display } = family;
    for (const [logical, name] of Object.entries(display) as [keyof typeof BODY, string][]) {
      if (logical in LATER || (PUBLISH_LATER as readonly string[]).includes(logical)) continue;
      up.push(view(name, firstBody(logical)({ audience, api: false })));
      names.push(name);
    }
    for (const [logical, name] of Object.entries(api) as [keyof typeof api, string][]) {
      up.push(view(name, firstBody(logical)({ audience, api: true })));
      names.push(name);
    }
  }
  // Two counts over the owner-audience sources that are captured: no id, host or value (A§6).
  up.push(
    view(
      PUBLIC_ONLY_VIEWS.ownerHealth,
      `
SELECT (count(*) FILTER (WHERE h.status = 'ok'))::int AS healthy, count(*)::int AS total
FROM source s
LEFT JOIN source_health h ON h.source_id = s.id
WHERE s.audience = 'owner' AND s.capture_enabled AND NOT s.canary`,
    ),
  );
  up.push(
    view(
      OWNER_ONLY_VIEWS.privateBasis,
      `
SELECT s.id AS source_id, s.private_basis
FROM source s
WHERE s.audience = 'owner'`,
    ),
  );
  // The loader's own state (written by the health pass into app_meta): no source, no value. backlog_age_s
  // is the age of the oldest manifest line the loader has not consumed (null when there is none).
  up.push(
    view(
      PUBLIC_ONLY_VIEWS.loader,
      `
SELECT (m.value ->> 'computed_at')::timestamptz AS computed_at,
       (m.value ->> 'backlog_files')::int AS backlog_files,
       (m.value ->> 'backlog_bytes')::bigint AS backlog_bytes,
       (m.value ->> 'backlog_age_s')::double precision AS backlog_age_s,
       (m.value ->> 'bad_manifest_lines')::int AS bad_manifest_lines
FROM app_meta m
WHERE m.key = 'loader'`,
    ),
  );
  names.push(PUBLIC_ONLY_VIEWS.ownerHealth, OWNER_ONLY_VIEWS.privateBasis, PUBLIC_ONLY_VIEWS.loader);

  const functions: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    up.push(obsAt(OBS_AT[audience], { audience, api: false }));
    functions.push(OBS_AT[audience]);
  }

  assertColumns(BODY.sourceHealth({ audience: 'public', api: false }), SOURCE_HEALTH_COLUMNS, 'source health');
  assertColumns(BODY.ingestBatch({ audience: 'public', api: false }), INGEST_BATCH_COLUMNS, 'ingest batch');
  assertColumns(BODY.twinCheck({ audience: 'public', api: false }), TWIN_CHECK_COLUMNS, 'twin check');

  const grants: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    const listed = familyViews(audience).filter((n) => !laterNames.includes(n));
    for (const n of listed) if (!names.includes(n)) throw new Error(`gen-views: ${n} is not generated`);
    grants.push(`GRANT SELECT ON ${listed.join(',\n  ')}\n  TO ${FAMILY_ROLES[audience].join(', ')};`);
  }
  if (new Set(names).size !== names.length) throw new Error('gen-views: duplicate view name');

  const down = [
    ...functions.reverse().map((n) => `DROP FUNCTION ${n}(timestamptz);`),
    ...[...names].reverse().map((n) => `DROP VIEW ${n};`),
  ];
  return `-- GENERATED by scripts/gen-views.ts from apps/server/src/db/audience.ts. Do not edit:
-- change the generator and run it again (CI fails on a difference).
--
-- security_barrier views, and the two "at T" functions at the end, are the only
-- things a login role may read (A§6). The
-- audience filter is applied at EVERY join: a series by its effective audience,
-- a reference, class, forecast run, warning or attribution also by its own
-- source, a station only with a visible series. pub_* keeps public rows, own_*
-- public and owner rows, neither ever an "off" row; both keep role primary only.

-- migrate:up
${up.join('\n\n')}

${grants.join('\n')}

-- migrate:down
${down.join('\n')}
DROP VIEW series_eff;
`;
}

/** A view of LATER in both families, with its grants; dropped on the way down. */
export function laterMigration(logical: keyof typeof LATER): string {
  const up: string[] = [];
  const grants: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    const name = VIEWS[audience][logical];
    up.push(view(name, BODY[logical]({ audience, api: false })));
    grants.push(`GRANT SELECT ON ${name} TO ${FAMILY_ROLES[audience].join(', ')};`);
  }
  return `-- GENERATED by scripts/gen-views.ts from apps/server/src/db/audience.ts. Do not edit:
-- change the generator and run it again (CI fails on a difference).
--
-- A view pair added after the first views migration (which never changes once
-- applied), with the same rules: security_barrier, granted to its family only.

-- migrate:up
${up.join('\n\n')}

${grants.join('\n')}

-- migrate:down
DROP VIEW ${VIEWS.owner[logical]};
DROP VIEW ${VIEWS.public[logical]};
`;
}

export const FORECAST_MIGRATION = new URL('../db/migrations/20261106000002_views_forecast.sql', import.meta.url);

const FORECAST_COLUMNS =
  'v.value, v.p05, v.p10, v.p25, v.p30, v.p50, v.p70, v.p75, v.p90, v.p95, v.vmin, v.vmax, v.flags';

/**
 * A§8 Q2 as a function (see FORECAST_AT in audience.ts), built like `obsAt`: per (series, source) the latest run
 * known as of `p_asof` (issued, and fetched, at or before it; ties by fetched_at, then id), and only THEN required to
 * reach `p_t`; the value is step-held at the run's greatest valid time at or before `p_t`. It never falls back to an
 * older run that reaches further and never mixes sources. The pairs come from a loose index scan (a recursive
 * walk over forecast_run_asof), each run from one backward step on it, each value from one backward step on the
 * value partition that holds it. The family's audience, role and display-channel filters apply to the series AND
 * to the run's own source, as in the views.
 */
const forecastAt = (
  name: string,
  p: Params,
  v: 'v2' | 'history' = 'v2',
) => `CREATE${v === 'v2' ? '' : ' OR REPLACE'} FUNCTION ${name}(p_asof timestamptz, p_t timestamptz)
RETURNS TABLE (run_id bigint, series_id int, source_id text, issued_at timestamptz, issued_inferred boolean,
               fetched_at timestamptz, first_valid timestamptz, last_valid timestamptz, kind text, step interval,
               provider_segment_end timestamptz, valid_ts timestamptz, value real, p05 real, p10 real, p25 real,
               p30 real, p50 real, p70 real, p75 real, p90 real, p95 real, vmin real, vmax real, flags int2)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
ROWS 300
AS $$
  WITH RECURSIVE pairs AS (
    (SELECT r.series_id, r.source_id FROM public.forecast_run r ORDER BY r.series_id, r.source_id LIMIT 1)
    UNION ALL
    SELECT n.series_id, n.source_id
    FROM pairs p
    CROSS JOIN LATERAL (
      SELECT r.series_id, r.source_id
      FROM public.forecast_run r
      WHERE (r.series_id, r.source_id) > (p.series_id, p.source_id)
      ORDER BY r.series_id, r.source_id
      LIMIT 1) n
  )
  SELECT r.id, r.series_id, r.source_id, r.issued_at, r.issued_inferred, r.fetched_at, r.first_valid, r.last_valid,
         r.kind, r.step, r.provider_segment_end, v.valid_ts, ${FORECAST_COLUMNS}
  FROM pairs p
  JOIN public.series_eff e ON e.series_id = p.series_id
  JOIN public.source fs ON fs.id = p.source_id
  CROSS JOIN LATERAL (
    SELECT r.id, r.series_id, r.source_id, r.issued_at, r.issued_inferred, r.fetched_at, r.first_valid,
           r.last_valid, r.kind, r.step, r.provider_segment_end
    FROM public.forecast_run r
    WHERE r.series_id = p.series_id AND r.source_id = p.source_id
      AND COALESCE(r.issued_at, r.fetched_at) <= p_asof AND r.fetched_at <= p_asof
    ORDER BY COALESCE(r.issued_at, r.fetched_at) DESC, r.fetched_at DESC, r.id DESC
    LIMIT 1) r
  CROSS JOIN LATERAL (
    SELECT v.valid_ts, ${FORECAST_COLUMNS}
    FROM public.forecast_value v
    WHERE v.run_id = r.id AND v.valid_ts >= r.first_valid AND v.valid_ts <= p_t
    ORDER BY v.valid_ts DESC
    LIMIT 1) v
  WHERE p_t >= p_asof AND r.first_valid <= p_t AND r.last_valid >= p_t
    AND ${seriesVisible('e', p)}
    AND ${sourceVisible('fs', p)}${v === 'v2' ? '' : `\n    AND ${historyAllowed('e', 'v.valid_ts')}`}
$$;
REVOKE ALL ON FUNCTION ${name}(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ${name}(timestamptz, timestamptz) TO ${FAMILY_ROLES[p.audience].join(', ')};`;

/** P8a: the forecast value views with p30 and p70, and the two Q2 functions; down restores the frozen bodies. */
export function forecastMigration(): string {
  const up: string[] = [];
  const down: string[] = [];
  const restore: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    for (const api of [false, true]) {
      const name = api ? VIEWS[audience].api.forecastValue : VIEWS[audience].forecastValue;
      up.push(`CREATE OR REPLACE VIEW ${name} WITH (security_barrier = true) AS${forecastValueV2({ audience, api })};`);
      down.push(`DROP VIEW ${name};`);
      restore.push(view(name, forecastValueV1({ audience, api })));
      restore.push(`GRANT SELECT ON ${name} TO ${FAMILY_ROLES[audience].join(', ')};`);
    }
  }
  for (const audience of ['public', 'owner'] as const)
    up.push(forecastAt(FORECAST_AT[audience], { audience, api: false }));
  return `-- GENERATED by scripts/gen-views.ts from apps/server/src/db/audience.ts. Do not edit:
-- change the generator and run it again (CI fails on a difference).
--
-- P8a: the forecast value views gain p30 and p70 (appended; the views keep their
-- grants), and A§8 Q2 becomes one "latest run as of T" function per family,
-- SECURITY DEFINER like the observation functions, EXECUTE for the family only.

-- migrate:up
${up.join('\n\n')}

-- migrate:down
DROP FUNCTION ${FORECAST_AT.owner}(timestamptz, timestamptz);
DROP FUNCTION ${FORECAST_AT.public}(timestamptz, timestamptz);
${down.join('\n')}

${restore.join('\n\n')}
`;
}

export const HISTORY_MIGRATION = new URL('../db/migrations/20261108000001_views_history.sql', import.meta.url);

/**
 * P9b: the history rule (A§6, A§9.2, catalogue §0.7 `history_export`) on the forecast values too: the four forecast
 * value views and the two Q2 functions are replaced with the same columns and signatures, a value older than its
 * series' history window needing lic_history_export, as every observation view and the Q1 functions already do.
 * Down replaces them with the frozen P8a bodies. The grants stay.
 */
export function historyMigration(): string {
  const up: string[] = [];
  const down: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    for (const api of [false, true]) {
      const name = api ? VIEWS[audience].api.forecastValue : VIEWS[audience].forecastValue;
      up.push(
        `CREATE OR REPLACE VIEW ${name} WITH (security_barrier = true) AS${BODY.forecastValue({ audience, api })};`,
      );
      down.push(
        `CREATE OR REPLACE VIEW ${name} WITH (security_barrier = true) AS${forecastValueV2({ audience, api })};`,
      );
    }
  }
  for (const audience of ['public', 'owner'] as const) {
    up.push(forecastAt(FORECAST_AT[audience], { audience, api: false }, 'history'));
    down.push(
      forecastAt(FORECAST_AT[audience], { audience, api: false }, 'v2').replace(
        'CREATE FUNCTION',
        'CREATE OR REPLACE FUNCTION',
      ),
    );
  }
  return `-- GENERATED by scripts/gen-views.ts from apps/server/src/db/audience.ts. Do not edit:
-- change the generator and run it again (CI fails on a difference).
--
-- P9b: the history rule on the forecast values: the forecast value views and the two Q2 functions are replaced
-- (same columns, same signatures, grants kept) so that a value older than its series' history window needs the
-- history_export channel, as the observation views and functions already require.

-- migrate:up
${up.join('\n\n')}

-- migrate:down
${down.join('\n\n')}
`;
}

export const PUBLISH_MIGRATION = new URL('../db/migrations/20261107000002_views_publish.sql', import.meta.url);

/**
 * P9a: the four series views gain the effective `lic_api`, `lic_history_export` and `history_window` (appended; they
 * keep their grants), and three view pairs are added: the dirty log, the day versions and the sources. Down drops the
 * new views and restores the frozen series bodies with their grants.
 */
export function publishMigration(): string {
  const up: string[] = [];
  const grants: string[] = [];
  const down: string[] = [];
  const restore: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    for (const api of [false, true]) {
      const name = api ? VIEWS[audience].api.series : VIEWS[audience].series;
      up.push(`CREATE OR REPLACE VIEW ${name} WITH (security_barrier = true) AS${BODY.series({ audience, api })};`);
      down.push(`DROP VIEW ${name};`);
      restore.push(view(name, seriesV1({ audience, api })));
      restore.push(`GRANT SELECT ON ${name} TO ${FAMILY_ROLES[audience].join(', ')};`);
    }
  }
  const added: string[] = [];
  for (const audience of ['public', 'owner'] as const) {
    for (const logical of PUBLISH_LATER) {
      const name = VIEWS[audience][logical];
      up.push(view(name, BODY[logical]({ audience, api: false })));
      grants.push(`GRANT SELECT ON ${name} TO ${FAMILY_ROLES[audience].join(', ')};`);
      added.push(name);
    }
  }
  return `-- GENERATED by scripts/gen-views.ts from apps/server/src/db/audience.ts. Do not edit:
-- change the generator and run it again (CI fails on a difference).
--
-- P9a: the series views gain the effective api and history_export channels and the history window (appended; the
-- views keep their grants), and the publishers' three view pairs: the dirty log, the day versions and the sources,
-- security_barrier and granted to their family only.

-- migrate:up
${up.join('\n\n')}

${grants.join('\n')}

-- migrate:down
${[...added]
  .reverse()
  .map((n) => `DROP VIEW ${n};`)
  .join('\n')}
${down.join('\n')}

${restore.join('\n\n')}
`;
}

if (import.meta.main) {
  const files: [URL, string][] = [
    [VIEWS_MIGRATION, viewsMigration()],
    [FORECAST_MIGRATION, forecastMigration()],
    [PUBLISH_MIGRATION, publishMigration()],
    [HISTORY_MIGRATION, historyMigration()],
    ...(Object.entries(LATER) as [keyof typeof LATER, URL][]).map(([l, url]): [URL, string] => [
      url,
      laterMigration(l),
    ]),
  ];
  for (const [url, sql] of files) {
    if (!process.argv.includes('--check')) writeFileSync(url, sql);
    else if (readFileSync(url, 'utf8') !== sql) {
      console.error(`gen-views: ${url.pathname.split('/').pop()} is stale; run node scripts/gen-views.ts`);
      process.exitCode = 1;
    }
  }
}
