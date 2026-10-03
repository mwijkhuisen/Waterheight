import type { ClassCoverage, Snapshot } from '@rws/contracts';
import {
  type AreaIn,
  attachArea,
  CLASS_WINDOW_MIN,
  type ClassIn,
  type Classified,
  classify,
  classSeries,
  type Datum,
  napHeight,
  PERMISSION_REQUIRED,
  type RefIn,
} from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { type ChannelAudience, OBS_AT, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { iso, snapshot } from './util.ts';

// The classified state of every series at t, for ONE audience family (A§7.4 item 11; PHASES P7b): the public
// outputs pass `'public'` and read pub_* only, the owner view (P9) passes `'owner'` and reads own_* only. The family
// is a constant at each call site, never request input, and every view name comes from audience.ts. The rows valid
// at t (A§8 Q3) go to the pure classifier of packages/core; an owner-only row never classifies a public value
// (the views drop it, and classify() ignores it in the public family too).

type SeriesRow = {
  id: number;
  station_id: string;
  source_id: string;
  quantity: 'H' | 'Q';
  value_kind: 'stage' | 'level' | null;
  datum: string | null;
  staleness_ms: number;
  audience: string;
};
type StationRow = {
  id: string;
  country: ClassCoverage['countries'][number]['country'];
  lon: number | null;
  lat: number | null;
  tier: number;
  flags: unknown;
};
type ObsRow = { series_id: number; ts: Date; value: number; qc: number };
type RefRow = {
  series_id: number;
  source_id: string;
  kind: string;
  value: number;
  unit: string;
  percentile_convention: 'exceedance' | 'non_exceedance' | null;
  p_from: string | null;
  p_to: string | null;
  season_from_md: number;
  season_to_md: number;
  priority: number;
  basis_label: string | null;
};
type ClassRow = { subject_id: string; source_id: string; provider_code: string | null };
type WarningRow = {
  id: string;
  source_id: string;
  area_key: string;
  name: string | null;
  level_raw: string | null;
  /** md5 of the stored geometry, for the sources whose areas attach by polygon; null otherwise. */
  geom_md5: string | null;
};

export type SeriesState = {
  series: number;
  station: string;
  source: string;
  obs: { ts: Date; value: number; qc: number } | null;
  classified: Classified;
  height: ReturnType<typeof napHeight>;
};

export type StateRead = { t: number; series: SeriesState[]; stations: StationRow[]; publicSeries: Set<number> };

// The stations an area attaches to, cached per family and station count (a registry sync changes the count) and,
// for a polygon, per md5 of the stored geometry (P7a refreshes a geometry in place), so a polygon is parsed once.
// ponytail: the map is cleared when it passes CACHE_MAX entries.
const CACHE_MAX = 5_000;
const attached = new Map<string, string[]>();

const flagOf = (flags: unknown, key: string) =>
  typeof flags === 'object' && flags !== null && (flags as Record<string, unknown>)[key] === true;

function parseGeometry(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Every active series of the family at t, classified. `current` marks the current 10-minute bucket: only there is a
 * class or area judged by its source's last successful fetch (CLASS_WINDOW_MIN); for an earlier t the stored rows
 * are the record. `sections` is the FR-5 station → section map (loaded once at boot).
 */
export async function readStates(
  db: Kysely<DB>,
  family: ChannelAudience,
  t: number,
  opts: { now: number; current: boolean; sections: ReadonlyMap<string, string> },
): Promise<StateRead> {
  const V = VIEWS[family];
  const at = new Date(t).toISOString();
  const rows = await snapshot(db, async (tx) => {
    const stations = (
      await sql<StationRow>`SELECT id, country, lon, lat, tier, flags FROM ${sql.table(V.station)} ORDER BY id`.execute(
        tx,
      )
    ).rows;
    const warnings = (
      await sql<WarningRow>`
        SELECT id::text AS id, source_id, area_key, name, level_raw,
               CASE WHEN source_id IN ('LU-5', 'DE-6', 'DE-10') OR area_key LIKE 'hydro\\_region:%'
                    THEN md5(geometry_geojson) END AS geom_md5
        FROM ${sql.table(V.warning)} WHERE valid @> ${at}::timestamptz ORDER BY id`.execute(tx)
    ).rows;
    // The stations each area attaches to; a polygon not seen before is read and parsed once.
    if (attached.size > CACHE_MAX) attached.clear();
    const keyOf = (w: WarningRow) =>
      `${family}:${stations.length}:${w.geom_md5 === null ? `${w.source_id}:${w.area_key}` : w.geom_md5}`;
    const missing = warnings.filter((w) => w.geom_md5 !== null && !attached.has(keyOf(w))).map((w) => w.id);
    const geometry = new Map(
      missing.length === 0
        ? []
        : (
            await sql<{ id: string; geometry_geojson: string | null }>`
              SELECT id::text AS id, geometry_geojson FROM ${sql.table(V.warning)}
              WHERE id = ANY(${missing}::bigint[])`.execute(tx)
          ).rows.map((g) => [g.id, g.geometry_geojson]),
    );
    const areas = warnings.map((w) => {
      const key = keyOf(w);
      let ids = attached.get(key);
      if (ids === undefined) {
        ids = attachArea(
          { source: w.source_id, key: w.area_key, geometry: parseGeometry(geometry.get(w.id) ?? null) },
          stations,
          opts.sections,
        );
        attached.set(key, ids);
      }
      return { w, ids };
    });
    return {
      stations,
      areas,
      series: (
        await sql<SeriesRow>`
          SELECT id, station_id, source_id, quantity, value_kind, datum,
                 (EXTRACT(EPOCH FROM staleness_limit) * 1000)::bigint::float8 AS staleness_ms, audience::text AS audience
          FROM ${sql.table(V.series)} WHERE active ORDER BY id`.execute(tx)
      ).rows,
      obs: (
        await sql<ObsRow>`SELECT series_id, ts, value, qc FROM ${sql.id(OBS_AT[family])}(${at}::timestamptz)`.execute(
          tx,
        )
      ).rows,
      refs: (
        await sql<RefRow>`
          SELECT series_id, source_id, kind, value, unit, percentile_convention,
                 to_char(lower(period), 'YYYY-MM-DD') AS p_from, to_char(upper(period) - 1, 'YYYY-MM-DD') AS p_to,
                 season_from_md, season_to_md, priority, basis_label
          FROM ${sql.table(V.reference)} WHERE valid @> ${at}::timestamptz`.execute(tx)
      ).rows,
      classes: (
        await sql<ClassRow>`
          SELECT DISTINCT ON (subject_id, source_id) subject_id, source_id, provider_code
          FROM ${sql.table(V.class)} WHERE subject_type = 'station' AND ts <= ${at}::timestamptz
          ORDER BY subject_id, source_id, ts DESC`.execute(tx)
      ).rows,
      health: opts.current
        ? (
            await sql<{ source_id: string; last_fetch_ok: Date | null }>`
              SELECT source_id, last_fetch_ok FROM ${sql.table(V.sourceHealth)}`.execute(tx)
          ).rows
        : [],
      zeros: (
        await sql<{ series_id: number; value_m: number; datum: Datum }>`
          SELECT series_id, value_m, datum FROM ${sql.table(V.gaugeZero)} WHERE valid @> ${at}::timestamptz`.execute(tx)
      ).rows,
    };
  });

  const lastOk = new Map(rows.health.map((h) => [h.source_id, h.last_fetch_ok?.getTime() ?? null]));
  const fresh = (source: string) => {
    if (!opts.current) return true;
    const ok = lastOk.get(source) ?? null;
    return ok !== null && opts.now - ok <= (CLASS_WINDOW_MIN[source] ?? 45) * 60_000;
  };

  const stationOf = new Map(rows.stations.map((s) => [s.id, s]));
  const seriesOf = new Map<string, SeriesRow[]>();
  for (const s of rows.series) seriesOf.set(s.station_id, [...(seriesOf.get(s.station_id) ?? []), s]);
  const obsOf = new Map(rows.obs.map((o) => [o.series_id, o]));
  const zeroOf = new Map(rows.zeros.map((z) => [z.series_id, z]));
  const refsOf = new Map<number, RefIn[]>();
  for (const r of rows.refs) {
    const list = refsOf.get(r.series_id) ?? [];
    list.push({
      source: r.source_id,
      kind: r.kind,
      value: r.value,
      unit: r.unit,
      convention: r.percentile_convention,
      period: r.p_from === null ? null : [r.p_from, r.p_to],
      seasonFrom: r.season_from_md,
      seasonTo: r.season_to_md,
      priority: r.priority,
      label: r.basis_label,
    });
    refsOf.set(r.series_id, list);
  }
  // A station's gauge class reaches one of its series (classSeries).
  const classesOf = new Map<number, ClassIn[]>();
  for (const c of rows.classes) {
    const target = classSeries(c.source_id, seriesOf.get(c.subject_id) ?? []);
    if (target === undefined || c.provider_code === null) continue;
    classesOf.set(target.id, [
      ...(classesOf.get(target.id) ?? []),
      { source: c.source_id, code: c.provider_code, fresh: fresh(c.source_id) },
    ]);
  }
  const areasOf = new Map<string, AreaIn[]>();
  for (const { w, ids } of rows.areas) {
    for (const id of ids) {
      areasOf.set(id, [
        ...(areasOf.get(id) ?? []),
        { source: w.source_id, key: w.area_key, name: w.name, levelRaw: w.level_raw, fresh: fresh(w.source_id) },
      ]);
    }
  }

  const series: SeriesState[] = rows.series.map((s) => {
    const st = stationOf.get(s.station_id);
    const o = obsOf.get(s.id);
    const z = zeroOf.get(s.id);
    const classified = classify(
      {
        quantity: s.quantity,
        valueKind: s.value_kind,
        value: o?.value ?? null,
        qc: o?.qc ?? 0,
        ageMs: o === undefined ? 0 : t - o.ts.getTime(),
        stalenessMs: s.staleness_ms,
        t,
        refs: refsOf.get(s.id) ?? [],
        classes: classesOf.get(s.id) ?? [],
        areas: areasOf.get(s.station_id) ?? [],
        tidal: flagOf(st?.flags, 'tidal'),
        impounded: flagOf(st?.flags, 'impounded'),
      },
      family,
    );
    const height =
      o === undefined
        ? null
        : napHeight({
            source: s.source_id,
            quantity: s.quantity,
            valueKind: s.value_kind,
            datum: s.datum as Datum | null,
            valueCm: o.value,
            zero: z === undefined ? null : { valueM: z.value_m, datum: z.datum },
          });
    return {
      series: s.id,
      station: s.station_id,
      source: s.source_id,
      obs: o === undefined ? null : { ts: o.ts, value: o.value, qc: o.qc },
      classified,
      height,
    };
  });
  const publicSeries = new Set(rows.series.filter((s) => s.audience === 'public').map((s) => s.id));
  return { t, series, stations: rows.stations, publicSeries };
}

/** The snapshot's values: the series with a value at t, with their state, basis and detail-view height. */
export function snapshotValues(read: StateRead): Snapshot['values'] {
  return read.series.flatMap((s) => {
    if (s.obs === null) return [];
    const c = s.classified;
    return [
      {
        series: s.series,
        ts: iso(s.obs.ts),
        value: s.obs.value,
        qc: s.obs.qc,
        ageSeconds: Math.floor((read.t - s.obs.ts.getTime()) / 1000),
        state: c.state,
        basis: c.basis,
        section: c.section,
        ...(c.area === null ? {} : { area: c.area }),
        ...(s.height !== null && 'nap' in s.height ? { nap: s.height.nap } : {}),
        ...(s.height !== null && 'zero' in s.height ? { zero: s.height.zero } : {}),
      },
    ];
  });
}

type Share = ClassCoverage['tier1'];
const share = (stations: number, classed: number): Share => ({
  stations,
  classed,
  ratio: stations === 0 ? null : classed / stations,
});

/**
 * The coverage report of one family (catalogue gap item 17; D10): per country, (a) the tier-1 stations with a state
 * other than no_ref, and (b) the first-release stations (tier 1 with a public primary series: the registry's
 * `first_release`, pinned by test/registry-first-release.test.ts) whose state comes from a source that needs no
 * permission. A station counts as classed when any of its series is. `mode` is D10's default map mode.
 */
export function classCoverage(read: StateRead): ClassCoverage {
  const byStation = new Map<string, SeriesState[]>();
  for (const s of read.series) byStation.set(s.station, [...(byStation.get(s.station) ?? []), s]);
  const count = new Map<string, { t1: number; t1c: number; fr: number; frc: number }>();
  const all = { t1: 0, t1c: 0, fr: 0, frc: 0 };
  for (const st of read.stations) {
    if (st.tier !== 1) continue;
    const list = byStation.get(st.id) ?? [];
    const classed = list.some((s) => s.classified.state !== 'no_ref');
    const firstRelease = list.some((s) => read.publicSeries.has(s.series));
    const open = list.some(
      (s) =>
        s.classified.state !== 'no_ref' &&
        s.classified.basis !== null &&
        !PERMISSION_REQUIRED.has(s.classified.basis.source),
    );
    const c = count.get(st.country) ?? { t1: 0, t1c: 0, fr: 0, frc: 0 };
    for (const k of [c, all]) {
      k.t1 += 1;
      k.t1c += classed ? 1 : 0;
      k.fr += firstRelease ? 1 : 0;
      k.frc += firstRelease && open ? 1 : 0;
    }
    count.set(st.country, c);
  }
  const tier1 = share(all.t1, all.t1c);
  return {
    t: iso(new Date(read.t)),
    mode: tier1.ratio !== null && tier1.ratio >= 0.6 ? 'state' : 'dh',
    tier1,
    first_release: share(all.fr, all.frc),
    countries: [...count]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([country, c]) => ({
        country: country as ClassCoverage['countries'][number]['country'],
        tier1: share(c.t1, c.t1c),
        first_release: share(c.fr, c.frc),
      })),
  };
}
