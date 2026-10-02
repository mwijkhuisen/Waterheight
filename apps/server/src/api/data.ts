import { MAX_POINTS, type Meta, type Series, type Snapshot, type Stations } from '@rws/contracts';
import { type Kysely, sql } from 'kysely';
import { OBS_AT, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { FILLED_BY } from '../load/adapters.ts';
import type { SeriesParams } from './params.ts';
import { iso, snapshot } from './util.ts';
import type { Window } from './window.ts';

// The reads of the public data routes (A§8 Q1, Q4; A§9.2). This process serves
// the public family only: every name comes from VIEWS.public / OBS_AT.public
// (audience.ts), nothing in a request selects a view, and every value is a bound
// parameter. /meta, /stations and /snapshot read the display channel; /series
// reads the api channel (lic_api; values older than the history window need
// lic_history_export, applied inside the views).

const V = VIEWS.public;

type AttributionRow = {
  source_id: string;
  lang: 'nl' | 'en' | 'de' | 'fr' | null;
  text: string | null;
  url: string | null;
  required: boolean | null;
  needs_date: boolean | null;
};

const FILL_TARGETS = [...FILLED_BY].flatMap(([target, fills]) => fills.map(() => target));
const FILL_SOURCES = [...FILLED_BY].flatMap(([, fills]) => fills);

/**
 * The public sources that have an active display series, each with its attribution rows verbatim, and the sources
 * whose rows fill a listed source's series (FILLED_BY: FR-3 for FR-1, CH-3 for CH-1; review SR-1) as their own
 * entries, read through the same family's attribution view: a fill source the view does not show is not listed.
 */
export async function readMeta(db: Kysely<DB>, window: Window, build: string, now: Date): Promise<Meta> {
  const { rows } = await sql<AttributionRow>`
    WITH listed AS (SELECT DISTINCT source_id FROM ${sql.table(V.series)} WHERE active),
    fill AS (
      SELECT f.source_id
      FROM unnest(${FILL_TARGETS}::text[], ${FILL_SOURCES}::text[]) AS f(target, source_id)
      JOIN listed l ON l.source_id = f.target
      EXCEPT SELECT source_id FROM listed
    )
    SELECT s.source_id, a.lang, a.text, a.url, a.required, a.needs_date
    FROM (SELECT source_id, false AS filled FROM listed UNION ALL SELECT source_id, true FROM fill) s
    LEFT JOIN ${sql.table(V.attribution)} a ON a.source_id = s.source_id
    WHERE NOT s.filled OR a.source_id IS NOT NULL
    ORDER BY s.source_id, a.ord`.execute(db);
  const sources = new Map<string, Meta['sources'][number]['attribution']>();
  for (const r of rows) {
    const list = sources.get(r.source_id) ?? [];
    sources.set(r.source_id, list);
    if (r.text !== null)
      list.push({
        lang: r.lang,
        text: r.text,
        url: r.url,
        required: r.required === true,
        needsDate: r.needs_date === true,
      });
  }
  return {
    now: iso(now),
    dataEpoch: new Date(window.dataEpochMs).toISOString(),
    displayStart: new Date(window.displayStartMs).toISOString(),
    build,
    sources: [...sources].map(([id, attribution]) => ({ id, attribution })),
  };
}

type StationRow = {
  id: string;
  name: string;
  water_name: string | null;
  country: Stations['stations'][number]['country'];
  lon: number | null;
  lat: number | null;
  tier: number;
  flags: unknown;
};
type SeriesRow = {
  id: number;
  station_id: string;
  source_id: string;
  quantity: 'H' | 'Q';
  value_kind: 'stage' | 'level' | null;
  native_unit: string;
  datum: string | null;
  expected_step_s: number;
  staleness_s: number;
};

const flag = (flags: unknown, key: string): boolean | null => {
  const v = (flags as Record<string, unknown> | null)?.[key];
  return typeof v === 'boolean' ? v : null;
};

/**
 * Stations with their active series. `dataSince` is the first UTC day with data
 * in the display channel (the daily rollup; the history window applies), not
 * the registration time.
 */
// ponytail: dataSince is a GROUP BY over the whole daily rollup, cached 300 s; an uncached /stations took 580 ms at
// 3,000 series × 365 days. Store the first-data day per series once the registry passes 1,000 active series or an
// uncached /stations passes 500 ms.
export async function readStations(db: Kysely<DB>): Promise<Stations> {
  const { stations, series, since } = await snapshot(db, async (tx) => ({
    stations: (
      await sql<StationRow>`
        SELECT id, name, water_name, country, lon, lat, tier, flags FROM ${sql.table(V.station)} ORDER BY id`.execute(
        tx,
      )
    ).rows,
    series: (
      await sql<SeriesRow>`
        SELECT id, station_id, source_id, quantity, value_kind, native_unit, datum,
               EXTRACT(EPOCH FROM expected_step)::int AS expected_step_s,
               EXTRACT(EPOCH FROM staleness_limit)::int AS staleness_s
        FROM ${sql.table(V.series)} WHERE active ORDER BY station_id, id`.execute(tx)
    ).rows,
    since: (
      await sql<{ series_id: number; since: Date }>`
        SELECT series_id, min(bucket) AS since FROM ${sql.table(V.obs1d)} GROUP BY series_id`.execute(tx)
    ).rows,
  }));
  const sinceOf = new Map(since.map((r) => [r.series_id, r.since]));
  const byStation = new Map<string, SeriesRow[]>();
  for (const s of series) byStation.set(s.station_id, [...(byStation.get(s.station_id) ?? []), s]);
  return {
    stations: stations.flatMap((st) => {
      const list = byStation.get(st.id);
      if (list === undefined) return [];
      return [
        {
          id: st.id,
          name: st.name,
          waterName: st.water_name,
          country: st.country,
          lon: st.lon,
          lat: st.lat,
          tier: st.tier as 1 | 2,
          flags: { tidal: flag(st.flags, 'tidal'), impounded: flag(st.flags, 'impounded') },
          series: list.map((s) => {
            const first = sinceOf.get(s.id);
            return {
              id: s.id,
              source: s.source_id,
              quantity: s.quantity,
              valueKind: s.value_kind,
              unit: s.quantity === 'H' ? ('cm' as const) : ('m³/s' as const),
              datum: s.datum as Stations['stations'][number]['series'][number]['datum'],
              nativeUnit: s.native_unit as Stations['stations'][number]['series'][number]['nativeUnit'],
              expectedStepSeconds: s.expected_step_s,
              stalenessLimitSeconds: s.staleness_s,
              dataSince: first === undefined ? null : iso(first),
            };
          }),
        },
      ];
    }),
  };
}

/** A§8 Q1 at the quantised `t`: the last observation of every series with ts ≤ t and ts > t − its staleness limit. */
export async function readSnapshot(db: Kysely<DB>, t: number): Promise<Snapshot> {
  const at = new Date(t);
  const { rows } = await sql<{ series_id: number; ts: Date; value: number; qc: number }>`
    SELECT series_id, ts, value, qc FROM ${sql.id(OBS_AT.public)}(${at}::timestamptz) ORDER BY series_id`.execute(db);
  return {
    t: iso(at),
    values: rows.map((r) => ({
      series: r.series_id,
      ts: iso(r.ts),
      value: r.value,
      qc: r.qc,
      ageSeconds: Math.floor((t - r.ts.getTime()) / 1000),
    })),
  };
}

type RawRow = { ts: Date; value: number; qc: number };
type BucketRow = { bucket: Date; vmin: number; vmax: number; vavg: number; vlast: number; n: number; qc_or: number };

/**
 * A§8 Q4 over [from, to) in the api channel; undefined when the series is not in it (unknown, or lic_api off)
 * or is inactive, as /stations and /snapshot show only active series.
 */
export async function readSeries(db: Kysely<DB>, p: SeriesParams): Promise<Series | undefined> {
  const from = new Date(p.from);
  const to = new Date(p.to);
  const span = { id: p.id, from: iso(from), to: iso(to) };
  return snapshot(db, async (tx) => {
    const known = await sql`SELECT 1 FROM ${sql.table(V.api.series)} WHERE id = ${p.id} AND active`.execute(tx);
    if (known.rows.length === 0) return undefined;
    if (p.res === 'raw') {
      const { rows } = await sql<RawRow>`
        SELECT ts, value, qc FROM ${sql.table(V.api.obs)}
        WHERE series_id = ${p.id} AND ts >= ${from}::timestamptz AND ts < ${to}::timestamptz
        ORDER BY ts LIMIT ${MAX_POINTS + 1}`.execute(tx);
      return {
        ...span,
        res: 'raw' as const,
        truncated: rows.length > MAX_POINTS,
        points: rows.slice(0, MAX_POINTS).map((r) => ({ ts: iso(r.ts), value: r.value, qc: r.qc })),
      };
    }
    const { rows } = await sql<BucketRow>`
      SELECT bucket, vmin, vmax, vavg, vlast, n, qc_or FROM ${sql.table(p.res === '1h' ? V.api.obs1h : V.api.obs1d)}
      WHERE series_id = ${p.id} AND bucket >= ${from}::timestamptz AND bucket < ${to}::timestamptz
      ORDER BY bucket LIMIT ${MAX_POINTS + 1}`.execute(tx);
    return {
      ...span,
      res: p.res,
      truncated: rows.length > MAX_POINTS,
      points: rows.slice(0, MAX_POINTS).map((r) => ({
        bucket: iso(r.bucket),
        vmin: r.vmin,
        vmax: r.vmax,
        vavg: r.vavg,
        vlast: r.vlast,
        n: r.n,
        qcOr: r.qc_or,
      })),
    };
  });
}
