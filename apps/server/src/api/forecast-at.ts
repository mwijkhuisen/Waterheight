import {
  FORECAST_AHEAD_MS,
  FORECAST_BAND_KINDS,
  floorBucket,
  pickRun,
  type SeriesForecast,
  type Snapshot,
  type SnapshotForecast,
} from '@rws/contracts';
import { type CurrentRun, de2Superseded, FORECAST_FLAGS, FORECAST_SOURCES, isCurrent } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { type ChannelAudience, FORECAST_AT, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { assertVisible, ruhrortCm, visibleSources } from './forecast.ts';
import { AGENCY, BAND_COLUMNS, type BandColumn, lu3Limits } from './forecast-latest.ts';
import { readStates, type StaticCache } from './states.ts';
import { iso, snapshot } from './util.ts';

// Official forecasts on the API (P8b, A§8 Q2, A§9.2): the future snapshot (`t` after now), /series/{id}/forecast
// and the per-source horizons of /meta, for ONE audience family. The family is a constant at each call site, never
// request input (the public api process passes 'public'; the owner API of P9 'owner'), and every view and function
// name comes from audience.ts. The rules: the latest run issued (or first fetched) at or before now, one source per
// series by FORECAST_PRECEDENCE (never blended), its value held at the greatest valid time ≤ t (never interpolated),
// shown up to the run's end capped at now + 48 h (D8); a superseded DE-2 run and LU-3 values past their display
// limit show "no forecast"; a below-floor value carries no number; observations are never carried past now.

const HOUR = 3_600_000;

type Run = {
  id: string;
  series: number;
  source: string;
  issued: number | null;
  issuedInferred: boolean;
  fetched: number;
  firstValid: number;
  lastValid: number;
  kind: 'deterministic' | 'quantiles' | 'ensemble_summary';
  stepS: number | null;
  segmentEnd: number | null;
};
type Point = { ts: number; value: number | null; flags: number } & Record<BandColumn, number | null>;
/** A Q2 row: the run and its point held at t. */
export type HeldRow = Run & { point: Point };

export type ForecastRules = {
  now: number;
  /** Ruhrort's latest stage in cm, null when it has none in its window (a DE-2 weekend run is then not due). */
  ruhrortCm: number | null;
  /** The LU-3 display limit in hours by station id; a station without one is not cut. */
  limitsH: ReadonlyMap<string, number>;
  /** The station of each series (the LU-3 limit is per station). */
  stationOf: (series: number) => string | undefined;
};

/** The provider horizons of the family's visible forecast sources, capped at 48 hours (D8). */
export function forecastHorizons(family: ChannelAudience): { source: string; hours: number }[] {
  return [...visibleSources(family)]
    .filter((s) => Object.hasOwn(FORECAST_SOURCES, s))
    .sort()
    .map((source) => ({
      source,
      hours: Math.min(48, FORECAST_SOURCES[source as keyof typeof FORECAST_SOURCES].horizonMs / HOUR),
    }));
}

/** The last instant a run may be shown at `from` (now, or asof): its end, the 48-hour cap, the LU-3 limit. */
export function horizonEnd(run: Run, from: number, rules: Pick<ForecastRules, 'limitsH' | 'stationOf'>): number {
  const station = rules.stationOf(run.series);
  const limit = run.source === 'LU-3' && station !== undefined ? rules.limitsH.get(station) : undefined;
  return Math.min(
    from + FORECAST_AHEAD_MS,
    run.lastValid,
    limit === undefined ? Infinity : run.firstValid + limit * HOUR,
  );
}

/** Whether a run still forecasts `t` at `from` (isCurrent with the DE-2 schedule, and within its horizon end). */
function currentAt(run: Run, t: number, from: number, rules: ForecastRules): boolean {
  const superseded = (r: CurrentRun, at: number) => r.source === 'DE-2' && de2Superseded(r, at, rules.ruhrortCm);
  return (
    isCurrent(
      { source: run.source, lastValid: run.lastValid, issued: run.issued ?? run.fetched },
      t,
      from,
      superseded,
    ) && t <= horizonEnd(run, from, rules)
  );
}

const below = (p: { flags: number }) => (p.flags & FORECAST_FLAGS.BELOW_FLOOR) !== 0;

/** The band a point shows: p10–p90 where both are stated, else p25–p75 (BAFU), else none. */
function bandOf(p: Point): SnapshotForecast['band'] {
  if (below(p)) return null;
  for (const kind of FORECAST_BAND_KINDS) {
    const [lo, hi] = kind === 'p10p90' ? [p.p10, p.p90] : [p.p25, p.p75];
    if (lo !== null && hi !== null) return { kind, lo, hi };
  }
  return null;
}

/** Pure: the one held row per series that shows at `t`, ordered by series. */
export function pickHeld(rows: readonly HeldRow[], t: number, rules: ForecastRules): HeldRow[] {
  const bySeries = new Map<number, HeldRow[]>();
  for (const r of rows) bySeries.set(r.series, [...(bySeries.get(r.series) ?? []), r]);
  return [...bySeries]
    .sort(([a], [b]) => a - b)
    .flatMap(([, list]) => {
      const run = pickRun(list, (r) => currentAt(r, t, rules.now, rules));
      return run === undefined ? [] : [run];
    });
}

/**
 * Pure: a picked row as the snapshot shows it at `t` (default: the held point's own time; the state comes from the
 * classifier). An estimate is a point flagged ESTIMATE, or a `t` past the provider's segment (review F4 of P8b: the
 * point held at `t` may be the segment's last).
 */
export function heldForecast(
  r: HeldRow,
  rules: ForecastRules,
  state: Pick<SnapshotForecast, 'state' | 'basis'>,
  t: number = r.point.ts,
): SnapshotForecast {
  const p = r.point;
  return {
    series: r.series,
    source: r.source,
    agency: AGENCY[r.source] ?? r.source,
    ts: iso(new Date(p.ts)),
    value: below(p) ? null : p.value,
    flags: p.flags,
    estimate: (p.flags & FORECAST_FLAGS.ESTIMATE) !== 0 || (r.segmentEnd !== null && Math.max(p.ts, t) > r.segmentEnd),
    issuedAt: iso(new Date(r.issued ?? r.fetched)),
    issuedInferred: r.issued === null || r.issuedInferred,
    providerSegmentEnd: r.segmentEnd === null ? null : iso(new Date(r.segmentEnd)),
    band: bandOf(p),
    horizonEnd: iso(new Date(horizonEnd(r, rules.now, rules))),
    ...state,
  };
}

type RunSql = {
  id: string;
  series_id: number;
  source_id: string;
  issued_at: Date | null;
  issued_inferred: boolean;
  fetched_at: Date;
  first_valid: Date;
  last_valid: Date;
  kind: Run['kind'];
  step_s: number | null;
  provider_segment_end: Date | null;
};
type HeldSql = RunSql & { valid_ts: Date; value: number | null; flags: number } & Record<BandColumn, number | null>;

const runOf = (r: RunSql): Run => ({
  id: r.id,
  series: r.series_id,
  source: r.source_id,
  issued: r.issued_at?.getTime() ?? null,
  issuedInferred: r.issued_inferred,
  fetched: r.fetched_at.getTime(),
  firstValid: r.first_valid.getTime(),
  lastValid: r.last_valid.getTime(),
  kind: r.kind,
  stepS: r.step_s,
  segmentEnd: r.provider_segment_end?.getTime() ?? null,
});

const RUN_COLUMNS = sql`run_id::text AS id, series_id, source_id, issued_at, issued_inferred, fetched_at, first_valid,
  last_valid, kind, EXTRACT(EPOCH FROM step)::int AS step_s, provider_segment_end`;

/**
 * The snapshot at a future `t` (t > now, at most now + 48 h; the route has checked it): no observation, and per
 * series the forecast that shows at `t`, its value classified against the references valid at t. Q2 runs at
 * asof = now floored to the 10-minute grid. A run of a source the family cannot see fails closed (`owner_source`).
 */
export async function readFutureSnapshot(
  db: Kysely<DB>,
  family: ChannelAudience,
  t: number,
  opts: {
    now: number;
    sections: ReadonlyMap<string, string>;
    cache?: StaticCache;
    visible?: ReadonlySet<string>;
    limitsH?: ReadonlyMap<string, number>;
  },
): Promise<Snapshot> {
  const asof = new Date(floorBucket(opts.now)).toISOString();
  const at = new Date(t).toISOString();
  const { rows, ruhrort, stations } = await snapshot(db, async (tx) => {
    const rows = (
      await sql<HeldSql>`
        SELECT ${RUN_COLUMNS}, valid_ts, value, p10, p90, p25, p75, p30, p70, vmin, vmax, flags
        FROM ${sql.id(FORECAST_AT[family])}(${asof}::timestamptz, ${at}::timestamptz)`.execute(tx)
    ).rows;
    assertVisible(
      rows.map((r) => r.source_id),
      opts.visible ?? visibleSources(family),
    );
    const lu3 = rows.filter((r) => r.source_id === 'LU-3').map((r) => r.series_id);
    return {
      rows,
      ruhrort: rows.some((r) => r.source_id === 'DE-2') ? await ruhrortCm(tx, family, asof) : null,
      stations:
        lu3.length === 0
          ? []
          : (
              await sql<{ id: number; station_id: string }>`
                SELECT id, station_id FROM ${sql.table(VIEWS[family].series)} WHERE id = ANY(${lu3}::int[])`.execute(tx)
            ).rows,
    };
  });
  const stationOf = new Map(stations.map((s) => [s.id, s.station_id]));
  const rules: ForecastRules = {
    now: opts.now,
    ruhrortCm: ruhrort,
    limitsH: opts.limitsH ?? lu3Limits(),
    stationOf: (id) => stationOf.get(id),
  };
  const held = pickHeld(
    rows.map((r) => ({
      ...runOf(r),
      point: Object.assign(
        { ts: r.valid_ts.getTime(), value: r.value, flags: r.flags },
        ...BAND_COLUMNS.map((c) => ({ [c]: r[c] })),
      ) as Point,
    })),
    t,
    rules,
  );
  const values = new Map(
    held.flatMap((r) => {
      const v = below(r.point) ? null : r.point.value;
      return v === null ? [] : [[r.series, { ts: r.point.ts, value: v }] as const];
    }),
  );
  const read = await readStates(db, family, t, {
    now: opts.now,
    current: false,
    sections: opts.sections,
    cache: opts.cache,
    forecast: values,
  });
  const stateOf = new Map(read.series.map((s) => [s.series, s.classified]));
  return {
    t: at,
    values: [],
    forecasts: held.flatMap((r) => {
      const c = stateOf.get(r.series);
      // A series the family's series view does not show cannot be placed (as in forecast/latest.json).
      if (c === undefined) return [];
      return [
        heldForecast(
          r,
          rules,
          values.has(r.series) ? { state: c.state, basis: c.basis } : { state: 'no_ref', basis: null },
          t,
        ),
      ];
    }),
  };
}

type PointSql = { valid_ts: Date; value: number | null; flags: number } & Record<
  'p10' | 'p90' | 'p25' | 'p75',
  number | null
>;

/**
 * /series/{id}/forecast at `asof` over the family's api channel (lic_api): the run current at asof — per source the
 * latest issued (or first fetched) at or before asof and fetched by then (the Q2 knowledge guard), kept only while
 * it still reaches asof, then one source by precedence — with its points up to its horizon end. Undefined when the
 * series is not in the api channel (unknown, inactive or lic_api off); `run: null` when it has no current run.
 */
export async function readSeriesForecast(
  db: Kysely<DB>,
  family: ChannelAudience,
  id: number,
  asof: number,
  opts: { visible?: ReadonlySet<string>; limitsH?: ReadonlyMap<string, number> } = {},
): Promise<SeriesForecast | undefined> {
  const V = VIEWS[family].api;
  const at = new Date(asof);
  return snapshot(db, async (tx) => {
    const known = (
      await sql<{
        station_id: string;
      }>`SELECT station_id FROM ${sql.table(V.series)} WHERE id = ${id} AND active`.execute(tx)
    ).rows[0];
    if (known === undefined) return undefined;
    const runs = (
      await sql<RunSql>`
        SELECT DISTINCT ON (source_id) id::text AS id, series_id, source_id, issued_at, issued_inferred, fetched_at,
               first_valid, last_valid, kind, EXTRACT(EPOCH FROM step)::int AS step_s, provider_segment_end
        FROM ${sql.table(V.forecastRun)}
        WHERE series_id = ${id} AND COALESCE(issued_at, fetched_at) <= ${at}::timestamptz AND fetched_at <= ${at}::timestamptz
        ORDER BY source_id, COALESCE(issued_at, fetched_at) DESC, fetched_at DESC, id DESC`.execute(tx)
    ).rows.map(runOf);
    assertVisible(
      runs.map((r) => r.source),
      opts.visible ?? visibleSources(family),
    );
    const rules: ForecastRules = {
      now: asof,
      ruhrortCm: runs.some((r) => r.source === 'DE-2') ? await ruhrortCm(tx, family, at.toISOString()) : null,
      limitsH: opts.limitsH ?? lu3Limits(),
      stationOf: () => known.station_id,
    };
    // Current at asof: it reaches asof (a run may start later: FR-4 values can begin a day after DtProdSimul).
    const run = pickRun(runs, (r) => currentAt(r, asof, asof, rules));
    if (run === undefined) return { series: id, asof: at.toISOString(), run: null };
    const end = horizonEnd(run, asof, rules);
    const points = (
      await sql<PointSql>`
        SELECT valid_ts, value, p10, p90, p25, p75, flags FROM ${sql.table(V.forecastValue)}
        WHERE run_id = ${run.id}::bigint AND valid_ts >= ${new Date(run.firstValid)}::timestamptz
          AND valid_ts <= ${new Date(end)}::timestamptz
        ORDER BY valid_ts`.execute(tx)
    ).rows;
    if (points.length === 0) return { series: id, asof: at.toISOString(), run: null };
    const has = (a: 'p10' | 'p25', b: 'p90' | 'p75') => points.some((p) => p[a] !== null && p[b] !== null);
    const bandKind = has('p10', 'p90') ? 'p10p90' : has('p25', 'p75') ? 'p25p75' : null;
    return {
      series: id,
      asof: at.toISOString(),
      run: {
        source: run.source,
        agency: AGENCY[run.source] ?? run.source,
        issuedAt: iso(new Date(run.issued ?? run.fetched)),
        issuedInferred: run.issued === null || run.issuedInferred,
        fetchedAt: iso(new Date(run.fetched)),
        providerSegmentEnd: run.segmentEnd === null ? null : iso(new Date(run.segmentEnd)),
        kind: run.kind,
        stepSeconds: run.stepS,
        bandKind,
        horizonEnd: iso(new Date(end)),
        points: points.map((p) => {
          const none = below(p);
          const [lo, hi] =
            bandKind === 'p10p90' ? [p.p10, p.p90] : bandKind === 'p25p75' ? [p.p25, p.p75] : [null, null];
          return {
            ts: iso(p.valid_ts),
            value: none ? null : p.value,
            lo: none ? null : lo,
            hi: none ? null : hi,
            flags: p.flags,
          };
        }),
      },
    };
  });
}
