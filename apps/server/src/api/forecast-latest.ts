import { ForecastLatest, OwnerForecastLatest } from '@rws/contracts';
import { type CurrentRun, de2Superseded, FORECAST_FLAGS, isCurrent } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { type ChannelAudience, FORECAST_AT, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { lu3Seed } from '../load/wire/lu-3.ts';
import { assertVisible, ruhrortCm, visibleSources } from './forecast.ts';
import { snapshot, validated } from './util.ts';

// /data/v1/forecast/latest.json (A§9.1; P8a builds and tests the document, P9a writes the file): for ONE audience
// family, the latest run of every series and source that still forecasts `now`, with its values up to now + 48 h in
// columns. The family is a constant at each call site, never request input; the runs come from the family's Q2 function
// (`FORECAST_AT(now, now)`: one run per series and source, the latest known, never an older one that reaches further)
// and their points from the family's forecast value view; every name comes from audience.ts. The pure builder
// holds the rules: a superseded DE-2 run is dropped (C4: "no forecast", never the held run, the same `isCurrent` as
// coverage and P8b's snapshot), LU-3 values past the display limit are cut, and a `below_floor` point carries no number.

const HOUR = 3_600_000;
const HORIZON_MS = 48 * HOUR;

/** Our short agency names by forecast source: ours, never provider text. */
export const AGENCY: Readonly<Record<string, string>> = {
  'NL-1': 'RWS',
  'DE-2': 'BfG',
  'DE-3': 'BfG',
  'LU-3': 'AGE',
  'CH-4': 'BAFU',
  'FR-4': 'Vigicrues',
};

/** A run as the Q2 function returns it, times in UTC ms. */
export type RunRow = {
  /** The run's id (bigint, as text). */
  id: string;
  series: number;
  /** The series' station (the LU-3 display limit is per station). */
  station: string;
  source: string;
  issued: number | null;
  issuedInferred: boolean;
  fetched: number;
  firstValid: number;
  lastValid: number;
  kind: string;
  stepS: number | null;
  segmentEnd: number | null;
};
/** The band columns a point may carry (BAND_OF picks the pair a run's band spans). */
export const BAND_COLUMNS = ['p10', 'p90', 'p25', 'p75', 'p30', 'p70', 'vmin', 'vmax'] as const;
export type BandColumn = (typeof BAND_COLUMNS)[number];
export type PointRow = { run: string; ts: number; value: number | null; flags: number } & Record<
  BandColumn,
  number | null
>;
export type LatestRows = { runs: readonly RunRow[]; points: readonly PointRow[] };
export type LatestOpts = {
  now: number;
  /** Ruhrort's latest stage in cm, null when it has none in its window (a weekend or holiday is then not due). */
  ruhrortCm: number | null;
  /** The LU-3 display limit in hours by station id (the seed's `limit_h`); a station without one is not cut. */
  limitsH?: ReadonlyMap<string, number>;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Pure: the runs that still forecast `now`, cut and nulled as the rules say, ordered by series then source. */
export function buildForecastLatest(rows: LatestRows, opts: LatestOpts): ForecastLatest {
  const { now } = opts;
  const byRun = new Map<string, PointRow[]>();
  for (const p of rows.points) byRun.set(p.run, [...(byRun.get(p.run) ?? []), p]);
  const superseded = (run: CurrentRun, at: number) => run.source === 'DE-2' && de2Superseded(run, at, opts.ruhrortCm);
  const runs: ForecastLatest['runs'] = [];
  const order = [...rows.runs].sort(
    (a, b) => a.series - b.series || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
  );
  for (const r of order) {
    if (!isCurrent({ source: r.source, lastValid: r.lastValid, issued: r.issued ?? r.fetched }, now, now, superseded))
      continue;
    const limit = r.source === 'LU-3' ? opts.limitsH?.get(r.station) : undefined;
    const end = Math.min(
      now + HORIZON_MS,
      limit === undefined ? Number.POSITIVE_INFINITY : r.firstValid + limit * HOUR,
    );
    const points = (byRun.get(r.id) ?? []).filter((p) => p.ts <= end).sort((a, b) => a.ts - b.ts);
    if (points.length === 0) continue;
    const floor = (p: PointRow) => (p.flags & FORECAST_FLAGS.BELOW_FLOOR) !== 0;
    const column = (k: 'value' | BandColumn) => points.map((p) => (floor(p) ? null : p[k]));
    const some = (c: (number | null)[]) => c.some((x) => x !== null);
    const cols = Object.fromEntries(BAND_COLUMNS.map((k) => [k, column(k)])) as Record<BandColumn, (number | null)[]>;
    const kind = some(cols.p10) && some(cols.p90) ? 'p10p90' : some(cols.p25) && some(cols.p75) ? 'p25p75' : null;
    runs.push({
      series: r.series,
      source: r.source,
      agency: AGENCY[r.source] ?? r.source,
      issuedAt: iso(r.issued ?? r.fetched),
      issuedInferred: r.issued === null || r.issuedInferred,
      fetchedAt: iso(r.fetched),
      providerSegmentEnd: r.segmentEnd === null ? null : iso(r.segmentEnd),
      kind: r.kind as ForecastLatest['runs'][number]['kind'],
      stepSeconds: r.stepS,
      validTs: points.map((p) => iso(p.ts)),
      value: column('value'),
      band:
        kind === null
          ? null
          : {
              kind,
              ...(Object.fromEntries(BAND_COLUMNS.map((k) => [k, some(cols[k]) ? cols[k] : null])) as Record<
                BandColumn,
                (number | null)[] | null
              >),
            },
      flags: points.map((p) => p.flags),
    });
  }
  return { schemaVersion: 1, now: iso(now), runs };
}

let seedLimits: ReadonlyMap<string, number> | undefined;
/**
 * The LU-3 display limits by station id `lu.age.<slug>`, from the seed's `limit_h` (24 or 48 hours, the LU-4 pages'
 * `forecastsLimit`; the one reader is `lu3Seed` of the LU-3 wiring). A station without one (Gemünd Our, whose page is
 * not fetched) is not cut.
 */
export function lu3Limits(): ReadonlyMap<string, number> {
  seedLimits ??= new Map(
    [...lu3Seed()].flatMap(([slug, hours]): [string, number][] => (hours === null ? [] : [[`lu.age.${slug}`, hours]])),
  );
  return seedLimits;
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
  kind: string;
  step_s: number | null;
  provider_segment_end: Date | null;
};
type PointSql = { run: string; valid_ts: Date; value: number | null; flags: number } & Record<
  BandColumn,
  number | null
>;

/**
 * The document for one family at `now` (UTC ms), in one read-only repeatable-read snapshot and checked against the
 * contract before it is returned (a shape bug is `coded('contract')`, never a silent leak; the public schema refuses
 * only the canary's source, so a run of a source the family cannot see is `coded('owner_source')`, `visible` being
 * the family's sources from sources.yaml unless a test passes others).
 */
export async function readForecastLatest(
  db: Kysely<DB>,
  family: ChannelAudience,
  now: number,
  opts: { limitsH?: ReadonlyMap<string, number>; visible?: ReadonlySet<string> } = {},
): Promise<ForecastLatest> {
  const V = VIEWS[family];
  const visible = opts.visible ?? visibleSources(family);
  const at = new Date(now).toISOString();
  const rows = await snapshot(db, async (tx): Promise<LatestRows & { ruhrort: number | null }> => {
    const runs = (
      await sql<RunSql>`
        SELECT run_id::text AS id, series_id, source_id, issued_at, issued_inferred, fetched_at, first_valid, last_valid,
               kind, EXTRACT(EPOCH FROM step)::int AS step_s, provider_segment_end
        FROM ${sql.id(FORECAST_AT[family])}(${at}::timestamptz, ${at}::timestamptz)`.execute(tx)
    ).rows;
    // Fail closed (review SEC-2): the contract cannot tell an owner source from a public one.
    assertVisible(
      runs.map((r) => r.source_id),
      visible,
    );
    if (runs.length === 0) return { runs: [], points: [], ruhrort: null };
    const stations = new Map(
      (
        await sql<{ id: number; station_id: string }>`
          SELECT id, station_id FROM ${sql.table(V.series)} WHERE id = ANY(${runs.map((r) => r.series_id)}::int[])`.execute(
          tx,
        )
      ).rows.map((s) => [s.id, s.station_id]),
    );
    const from = new Date(Math.min(...runs.map((r) => r.first_valid.getTime())));
    const points = (
      await sql<PointSql>`
        SELECT run_id::text AS run, valid_ts, value, p10, p90, p25, p75, p30, p70, vmin, vmax, flags
        FROM ${sql.table(V.forecastValue)}
        WHERE run_id = ANY(${runs.map((r) => r.id)}::bigint[]) AND valid_ts >= ${from}::timestamptz
          AND valid_ts <= ${new Date(now + HORIZON_MS)}::timestamptz
        ORDER BY run_id, valid_ts`.execute(tx)
    ).rows;
    return {
      // A run whose series the family's series view does not show is left out (it cannot be placed).
      runs: runs.flatMap((r) => {
        const station = stations.get(r.series_id);
        return station === undefined
          ? []
          : [
              {
                id: r.id,
                series: r.series_id,
                station,
                source: r.source_id,
                issued: r.issued_at?.getTime() ?? null,
                issuedInferred: r.issued_inferred,
                fetched: r.fetched_at.getTime(),
                firstValid: r.first_valid.getTime(),
                lastValid: r.last_valid.getTime(),
                kind: r.kind,
                stepS: r.step_s,
                segmentEnd: r.provider_segment_end?.getTime() ?? null,
              },
            ];
      }),
      points: points.map(({ valid_ts, ...p }) => ({ ...p, ts: valid_ts.getTime() })),
      ruhrort: runs.some((r) => r.source_id === 'DE-2') ? await ruhrortCm(tx, family, at) : null,
    };
  });
  return validated(
    family === 'owner' ? OwnerForecastLatest : ForecastLatest,
    buildForecastLatest(rows, { now, ruhrortCm: rows.ruhrort, limitsH: opts.limitsH ?? lu3Limits() }),
  );
}
