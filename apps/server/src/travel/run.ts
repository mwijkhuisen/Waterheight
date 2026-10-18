import type { RivernetFile } from '@rws/contracts';
import { estimateLag, type LagParams, SUSPECT_BITS } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { comparePairs } from './format.ts';

// The empirical travel times (P14f, plan section 3.6): read the hourly means of the two ends of every eligible reach
// through the PUBLIC views (the caller is the rws_publish login, which has no other grant), one series-year per
// query (the role has a 2 s statement timeout and 256 MB of temp files), and hand them to the pure estimator of
// packages/core. Nothing is written to the database.

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
export type Counts = { reaches: number; eligible: number; no_series: number; no_common: number; queries: number };

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

/**
 * Hourly means of one series over the UTC years [from, to] on one hour index (NaN where the hour has no sample),
 * one query per year. A value with any suspect bit is left out; the view applies the history rule itself.
 */
async function hourly(db: Kysely<DB>, series: number, from: number, to: number, counts: Counts): Promise<Float64Array> {
  const start = Date.UTC(from, 0, 1);
  const out = new Float64Array((Date.UTC(to + 1, 0, 1) - start) / HOUR_MS).fill(Number.NaN);
  for (let year = from; year <= to; year++) {
    const lo = new Date(Date.UTC(year, 0, 1)).toISOString();
    const hi = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
    counts.queries++;
    const { rows } = await sql<{ h: string; v: number }>`
      SELECT floor(extract(epoch FROM date_trunc('hour', ts AT TIME ZONE 'UTC')))::bigint AS h, avg(value)::float8 AS v
      FROM ${sql.table(VIEWS.public.obs)}
      WHERE series_id = ${series} AND ts >= ${lo}::timestamptz AND ts < ${hi}::timestamptz
        AND (qc::int & ${SUSPECT_BITS}::int) = 0
      GROUP BY 1 ORDER BY 1`.execute(db);
    for (const r of rows) out[(Number(r.h) * 1000 - start) / HOUR_MS] = r.v;
  }
  return out;
}

const yearAt = (start: number, hour: number) => new Date(start + hour * HOUR_MS).getUTCFullYear();

/**
 * The empirical pairs of `reaches` (already eligible), sorted as the file is. Q-Q where both ends have a public Q
 * series, else H-H, else the reach is skipped; the upstream flow that classes the windows is its Q where it has one.
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
  const cache = new Map<number, Float64Array>();
  const load = async (id: number) => {
    const known = cache.get(id);
    if (known !== undefined) return known;
    const a = await hourly(db, id, years.from, years.to, counts);
    cache.set(id, a);
    return a;
  };
  const start = Date.UTC(years.from, 0, 1);
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
    const lag = estimateLag({
      up: await load(up[quantity] as number),
      down: await load(down[quantity] as number),
      flow: await load((up.Q ?? up.H) as number),
      lengthKm: r.length_km,
      params,
    });
    if (lag === null) continue;
    pairs.set(key, {
      from_station: r.up_station,
      to_station: r.down_station,
      h: lag.h,
      classes: lag.classes,
      quantity,
      years: [yearAt(start, lag.span[0]), yearAt(start, lag.span[1] - 1)],
      windows: lag.windows,
    });
  }
  return [...pairs.values()].sort(comparePairs);
}
