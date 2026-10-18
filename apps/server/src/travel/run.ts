import type { RivernetFile } from '@rws/contracts';
import { estimateLag, type LagParams, SUSPECT_BITS } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import { comparePairs } from './format.ts';

// The empirical travel times (P14f, plan section 3.6): read the hourly means of the two ends of every eligible reach
// through the PUBLIC views (the caller is the rws_publish login, which has no other grant), one series-year per
// query (the role has a 2 s statement timeout and 256 MB of temp files), and hand them to the pure estimator of
// packages/core. Nothing is written to the database. Memory is bounded by one reach (review R1-1): a reach's series
// are read, trimmed to the hours both ends cover, estimated and dropped before the next reach is read; nothing is
// kept across reaches (a full-history array of every station was about 1 GB, over the service's 512 MB).

const HOUR_MS = 3_600_000;
export const DEFAULT_FROM_YEAR = 1990; // registry/backfill.yaml: the NL-1 backfill floor

export type Reach = RivernetFile['reaches'][number];
export type Pair = {
  from_station: string;
  to_station: string;
  h: [number, number];
  classes: { low?: [number, number]; mid?: [number, number]; high?: [number, number] };
  quantity: 'Q' | 'H';
  years: [number, number];
  windows: number;
};
export type Counts = {
  reaches: number;
  eligible: number;
  no_series: number;
  no_common: number;
  /** Reaches whose ends share fewer than `window_h × min_windows` hours with a value: not estimated. */
  short: number;
  queries: number;
  /** Series-years whose query hit the statement timeout (57014): read as empty, the run goes on. */
  timeouts: number;
};

/** A reach with both ends public, neither tidal nor impounded: the only reaches whose lag is read (plan 3.6). */
export const eligibleReaches = (reaches: readonly Reach[]): (Reach & { up_station: string; down_station: string })[] =>
  reaches.filter(
    (r): r is Reach & { up_station: string; down_station: string } =>
      r.up_station !== null && r.down_station !== null && !r.flags.tidal && !r.flags.impounded,
  );

type Seen = { Q?: number; H?: number };

/** The public series of each station (the series view holds primary, audience-public, display-licensed rows only). */
async function seriesOf(db: Kysely<DB>, stations: readonly string[]): Promise<Map<string, Seen>> {
  const out = new Map<string, Seen>();
  if (stations.length === 0) return out;
  const { rows } = await sql<{ id: number; station_id: string; quantity: 'H' | 'Q' }>`
    SELECT id, station_id, quantity FROM ${sql.table(VIEWS.public.series)}
    WHERE station_id = ANY(${stations as string[]}::text[]) AND active
    ORDER BY id`.execute(db);
  for (const r of rows) {
    const seen = out.get(r.station_id) ?? {};
    seen[r.quantity] ??= r.id; // the lowest id when a station has two
    out.set(r.station_id, seen);
  }
  return out;
}

/** One series' hourly means per UTC year, each on that year's own hours (NaN where the hour has no sample). */
export type Years = ReadonlyMap<number, Float64Array>;

/**
 * Hourly means of one series over the UTC years [from, to], one query per year; a year without a sample is absent.
 * A value with any suspect bit is left out; the view applies the history rule itself. A year whose query hits the
 * statement timeout (57014) is absent and counted (review S1: one slow year must not end the whole run); any other
 * error ends it.
 */
async function hourlyYears(db: Kysely<DB>, series: number, from: number, to: number, counts: Counts): Promise<Years> {
  const out = new Map<number, Float64Array>();
  for (let year = from; year <= to; year++) {
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    counts.queries++;
    let rows: { h: string; v: number }[];
    try {
      rows = (
        await sql<{ h: string; v: number }>`
          SELECT floor(extract(epoch FROM date_trunc('hour', ts AT TIME ZONE 'UTC')))::bigint AS h,
                 avg(value)::float8 AS v
          FROM ${sql.table(VIEWS.public.obs)}
          WHERE series_id = ${series} AND ts >= ${new Date(start).toISOString()}::timestamptz
            AND ts < ${new Date(end).toISOString()}::timestamptz AND (qc::int & ${SUSPECT_BITS}::int) = 0
          GROUP BY 1 ORDER BY 1`.execute(db)
      ).rows;
    } catch (err) {
      if (errorCode(err) !== '57014') throw err;
      counts.timeouts++;
      continue;
    }
    if (rows.length === 0) continue;
    const a = new Float64Array((end - start) / HOUR_MS).fill(Number.NaN);
    for (const r of rows) a[(Number(r.h) * 1000 - start) / HOUR_MS] = r.v;
    out.set(year, a);
  }
  return out;
}

/** The hours [first, last + 1) at which a series has a value, as hours since `origin`; null when it has none. */
export function coveredSpan(years: Years, origin: number): [number, number] | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const [year, a] of years) {
    const base = (Date.UTC(year, 0, 1) - origin) / HOUR_MS;
    let i = 0;
    while (i < a.length && Number.isNaN(a[i] as number)) i++;
    if (i === a.length) continue;
    let j = a.length - 1;
    while (Number.isNaN(a[j] as number)) j--;
    first = Math.min(first, base + i);
    last = Math.max(last, base + j + 1);
  }
  return first < last ? [first, last] : null;
}

/** The hours [span[0], span[1]) since `origin` of a series as one array, NaN where it has no value. */
export function sliceYears(years: Years, origin: number, span: readonly [number, number]): Float64Array {
  const out = new Float64Array(span[1] - span[0]).fill(Number.NaN);
  for (const [year, a] of years) {
    const base = (Date.UTC(year, 0, 1) - origin) / HOUR_MS - span[0];
    const from = Math.max(0, -base);
    const to = Math.min(a.length, out.length - base);
    if (from < to) out.set(a.subarray(from, to), base + from);
  }
  return out;
}

/**
 * The span both ends cover, and how many of its hours have a value at both: the reach is estimated only over that
 * span, and only when the shared hours reach `minHours` (pure; the unit tests hold it).
 */
export function commonSpan(
  up: Years,
  down: Years,
  origin: number,
  minHours: number,
): { span: [number, number]; up: Float64Array; down: Float64Array } | null {
  const a = coveredSpan(up, origin);
  const b = coveredSpan(down, origin);
  if (a === null || b === null) return null;
  const span: [number, number] = [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
  if (span[1] - span[0] < minHours) return null;
  const u = sliceYears(up, origin, span);
  const d = sliceYears(down, origin, span);
  let shared = 0;
  for (let i = 0; i < u.length; i++) if (!Number.isNaN(u[i] as number) && !Number.isNaN(d[i] as number)) shared++;
  return shared < minHours ? null : { span, up: u, down: d };
}

const yearAt = (start: number, hour: number) => new Date(start + hour * HOUR_MS).getUTCFullYear();

/**
 * The empirical pairs of `reaches` (already eligible), sorted as the file is. Q-Q where both ends have a public Q
 * series, else H-H, else the reach is skipped; the upstream flow that classes the windows is its Q where it has one.
 * Each reach reads its own series (once each, the flow included) and keeps nothing for the next.
 */
export async function travelPairs(
  db: Kysely<DB>,
  reaches: readonly (Reach & { up_station: string; down_station: string })[],
  params: LagParams,
  years: { from: number; to: number },
  counts: Counts,
): Promise<Pair[]> {
  const stations = [...new Set(reaches.flatMap((r) => [r.up_station, r.down_station]))].sort();
  const seen = await seriesOf(db, stations);
  const origin = Date.UTC(years.from, 0, 1);
  const minHours = params.window_h * params.min_windows;
  const pairs = new Map<string, Pair>();
  for (const r of reaches) {
    const key = `${r.up_station} ${r.down_station}`;
    if (pairs.has(key)) continue;
    const up = seen.get(r.up_station);
    const down = seen.get(r.down_station);
    if (up === undefined || down === undefined) {
      counts.no_series++;
      continue;
    }
    const quantity =
      up.Q !== undefined && down.Q !== undefined ? 'Q' : up.H !== undefined && down.H !== undefined ? 'H' : null;
    if (quantity === null) {
      counts.no_common++;
      continue;
    }
    const upId = up[quantity] as number;
    const flowId = (up.Q ?? up.H) as number;
    const upYears = await hourlyYears(db, upId, years.from, years.to, counts);
    // An upstream end with no value at all needs no downstream read.
    const common =
      upYears.size === 0
        ? null
        : commonSpan(
            upYears,
            await hourlyYears(db, down[quantity] as number, years.from, years.to, counts),
            origin,
            minHours,
          );
    if (common === null) {
      counts.short++;
      continue;
    }
    // The flow (the upstream Q of an H-H reach) is read only over the years of the common span.
    const flow =
      flowId === upId
        ? common.up
        : sliceYears(
            await hourlyYears(db, flowId, yearAt(origin, common.span[0]), yearAt(origin, common.span[1] - 1), counts),
            origin,
            common.span,
          );
    const lag = estimateLag({ up: common.up, down: common.down, flow, lengthKm: r.length_km, params });
    if (lag === null) continue;
    const at = origin + common.span[0] * HOUR_MS;
    pairs.set(key, {
      from_station: r.up_station,
      to_station: r.down_station,
      h: lag.h,
      classes: lag.classes,
      quantity,
      years: [yearAt(at, lag.span[0]), yearAt(at, lag.span[1] - 1)],
      windows: lag.windows,
    });
  }
  return [...pairs.values()].sort(comparePairs);
}
