import { type ClassCoverage, dayOf, isSettled, type Snapshot, stateCode } from '@rws/contracts';
import {
  type AreaIn,
  attachArea,
  CLASS_WINDOW_MIN,
  type ClassIn,
  type Classified,
  classify,
  classSeries,
  type Datum,
  DOY_KINDS,
  monthDay,
  napHeight,
  OWNER_ONLY_SOURCES,
  PERMISSION_REQUIRED,
  type RefIn,
  type TideRow,
  tideAt,
  utcMonthDay,
} from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { type AttributionRow, attributionRows, type SourceDate, sourceDates } from '../attribution.ts';
import { type ChannelAudience, OBS_AT, TIDE_AT, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { coded, iso, snapshot } from './util.ts';

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
/** A TIDE_AT row (P18a). */
export type TideAtRow = Omit<TideRow, 'ts'> & { series_id: number; ts: Date };

/** TIDE_AT rows by series, ts in epoch ms (the snapshot at t and, from P18b, the future snapshot). */
export function tideBySeries(rows: readonly TideAtRow[]): Map<number, TideRow[]> {
  const tide = new Map<number, TideRow[]>();
  for (const { series_id, ts, ...r } of rows) {
    const list = tide.get(series_id) ?? [];
    list.push({ ...r, ts: ts.getTime() });
    tide.set(series_id, list);
  }
  return tide;
}
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
type ZeroRow = { series_id: number; value_m: number; datum: Datum };
/** A row with its validity range, filtered by t in the process (`valid @> t` cannot use an index through a view). */
type Ranged<T> = T & { v_from: Date | null; v_to: Date | null; from_inc: boolean; to_inc: boolean };
/**
 * The rows that change only with the registry or a reference: read once per family and TTL. `attached` holds the
 * stations each area attaches to, computed for these `stations` and kept only as long as they are: keyed by the md5
 * of a polygon's stored geometry (P7a refreshes a geometry in place), else by source and area key.
 */
export type Static = {
  stations: StationRow[];
  series: SeriesRow[];
  refs: Ranged<RefRow>[];
  zeros: Ranged<ZeroRow>[];
  attached: Map<string, string[]>;
  /** P9b: the family's visible sources (its source view): a body naming any other fails closed. */
  sources: Set<string>;
  /** P9b: the family's attribution rows and the dates their licences ask for now (the API's `attribution`). */
  attribution: AttributionRow[];
  dates: Map<string, SourceDate>;
  /** P9b (KG-114): the active series without lic_history_export, with their history window in ms (0 when none). */
  history: Map<number, number>;
};

const validAt = (r: Ranged<object>, t: number) =>
  (r.v_from === null || (r.from_inc ? t >= r.v_from.getTime() : t > r.v_from.getTime())) &&
  (r.v_to === null || (r.to_inc ? t <= r.v_to.getTime() : t < r.v_to.getTime()));

const RANGE = sql`lower(valid) AS v_from, upper(valid) AS v_to, lower_inc(valid) AS from_inc, upper_inc(valid) AS to_inc`;
const REF_COLUMNS = sql`series_id, source_id, kind, value, unit, percentile_convention,
               to_char(lower(period), 'YYYY-MM-DD') AS p_from, to_char(upper(period) - 1, 'YYYY-MM-DD') AS p_to,
               season_from_md, season_to_md, priority, basis_label`;
const isDoy = (kind: string) => (DOY_KINDS as readonly string[]).includes(kind);

/**
 * The family's day-of-year rows (P14f) of the given UTC day keys, with their validity ranges, grouped by day key.
 * One row per series and kind and day, 730 a series with a set, so a request reads the one day it needs, never all
 * of them; the literal kind list lets the partial index of the P14f migration apply through the view.
 */
async function readDoyRows(
  db: Kysely<DB>,
  family: ChannelAudience,
  mds: readonly number[],
): Promise<Map<number, Ranged<RefRow>[]>> {
  if (mds.length === 0) return new Map(); // no day key (no hour): no query (P14f review R1-4)
  const { rows } = await sql<Ranged<RefRow>>`
    SELECT ${REF_COLUMNS}, ${RANGE}
    FROM ${sql.table(VIEWS[family].reference)}
    WHERE kind IN ('P10_DOY', 'P90_DOY') AND season_from_md = ANY(${mds as number[]}::int[])`.execute(db);
  const out = new Map<number, Ranged<RefRow>[]>(mds.map((md) => [md, []]));
  for (const r of rows) out.get(r.season_from_md)?.push(r);
  return out;
}

function readStatic(db: Kysely<DB>, family: ChannelAudience): Promise<Static> {
  const V = VIEWS[family];
  return snapshot(db, async (tx) => ({
    stations: (
      await sql<StationRow>`SELECT id, country, lon, lat, tier, flags FROM ${sql.table(V.station)} ORDER BY id`.execute(
        tx,
      )
    ).rows,
    series: (
      await sql<SeriesRow>`
        SELECT id, station_id, source_id, quantity, value_kind, datum,
               (EXTRACT(EPOCH FROM staleness_limit) * 1000)::bigint::float8 AS staleness_ms, audience::text AS audience
        FROM ${sql.table(V.series)} WHERE active ORDER BY id`.execute(tx)
    ).rows,
    // P14f: our day-of-year rows (730 a series) are not static: readDoy reads the day a request needs (a literal
    // kind list, so the partial index applies).
    refs: (
      await sql<Ranged<RefRow>>`
        SELECT ${REF_COLUMNS}, ${RANGE}
        FROM ${sql.table(V.reference)} WHERE kind NOT IN ('P10_DOY', 'P90_DOY')`.execute(tx)
    ).rows,
    zeros: (
      await sql<Ranged<ZeroRow>>`SELECT series_id, value_m, datum, ${RANGE} FROM ${sql.table(V.gaugeZero)}`.execute(tx)
    ).rows,
    attached: new Map(),
    ...(await readLicences(tx, family)),
  }));
}

/** The P9b part of the static rows: sources, attribution, licence dates and the history windows. */
async function readLicences(
  tx: Kysely<DB>,
  family: ChannelAudience,
): Promise<Pick<Static, 'sources' | 'attribution' | 'dates' | 'history'>> {
  const V = VIEWS[family];
  const attribution = await attributionRows(tx, family);
  const sources = await sql<{ id: string }>`SELECT id FROM ${sql.table(V.source)}`.execute(tx);
  const history = await sql<{ id: number; window_ms: number | null }>`
    SELECT id, (EXTRACT(EPOCH FROM history_window) * 1000)::float8 AS window_ms
    FROM ${sql.table(V.series)} WHERE active AND NOT lic_history_export`.execute(tx);
  return {
    sources: new Set(sources.rows.map((r) => r.id)),
    attribution,
    dates: await sourceDates(tx, family, attribution),
    history: new Map(history.rows.map((r) => [r.id, Math.max(0, r.window_ms ?? 0)])),
  };
}

/**
 * The static rows of each family, shared by the routes of one app for `ttlMs` (60 s in production): a registry sync
 * or a changed reference reaches the states within a minute, and a cold /snapshot reads only what depends on t
 * (A§8 Q1, the classes and the warnings at t, the source health). The area attachments live in the entry and are
 * renewed with it. A failed read is not kept.
 */
export class StaticCache {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<ChannelAudience, { at: number; value: Promise<Static> }>();
  /** P14f: the day-of-year rows per (family, UTC day key), at most 365 keys a family, each for the same TTL. */
  readonly #doy = new Map<string, { at: number; value: Promise<Ranged<RefRow>[]> }>();
  constructor(ttlMs: number, now: () => number) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }
  get(db: Kysely<DB>, family: ChannelAudience): Promise<Static> {
    const now = this.#now();
    const hit = this.#entries.get(family);
    if (hit !== undefined && now - hit.at < this.#ttlMs) return hit.value;
    const value = readStatic(db, family);
    this.#entries.set(family, { at: now, value });
    value.catch(() => {
      if (this.#entries.get(family)?.value === value) this.#entries.delete(family);
    });
    return value;
  }
  /** The family's DOY rows of `mds` (one read for the keys not held); a failed read is not kept. */
  async doy(db: Kysely<DB>, family: ChannelAudience, mds: readonly number[]): Promise<Ranged<RefRow>[]> {
    const now = this.#now();
    const held: Promise<Ranged<RefRow>[]>[] = [];
    const missing: number[] = [];
    for (const md of mds) {
      const hit = this.#doy.get(`${family}|${md}`);
      if (hit !== undefined && now - hit.at < this.#ttlMs) held.push(hit.value);
      else missing.push(md);
    }
    if (missing.length > 0) {
      // Expired keys go when new ones come (P14f review R1-5): the map holds nothing past its TTL but what this
      // call refreshes.
      for (const [key, e] of this.#doy) if (now - e.at >= this.#ttlMs) this.#doy.delete(key);
      const read = readDoyRows(db, family, missing);
      for (const md of missing) {
        const key = `${family}|${md}`;
        const value = read.then((m) => m.get(md) ?? []);
        this.#doy.set(key, { at: now, value });
        value.catch(() => {
          if (this.#doy.get(key)?.value === value) this.#doy.delete(key);
        });
        held.push(value);
      }
    }
    return (await Promise.all(held)).flat();
  }
  /** The number of day entries held (the tests' view of the sweep). */
  get doyEntries(): number {
    return this.#doy.size;
  }
}

/** The family's DOY rows of the UTC day keys `mds`, from the app's cache when it has one (P14f). */
const readDoy = (db: Kysely<DB>, family: ChannelAudience, mds: readonly number[], cache?: StaticCache | undefined) =>
  cache !== undefined ? cache.doy(db, family, mds) : readDoyRows(db, family, mds).then((m) => [...m.values()].flat());

type WarningRow = {
  id: string;
  source_id: string;
  area_key: string;
  name: string | null;
  level_raw: string | null;
  /** md5 of the stored geometry, for the sources whose areas attach by polygon; null otherwise. */
  geom_md5: string | null;
};
const WARNING_COLUMNS = sql`id::text AS id, source_id, area_key, name, level_raw,
               CASE WHEN source_id IN ('LU-5', 'DE-6', 'DE-10') OR area_key LIKE 'hydro\\_region:%'
                    THEN md5(geometry_geojson) END AS geom_md5`;

export type SeriesState = {
  series: number;
  station: string;
  source: string;
  obs: { ts: Date; value: number; qc: number } | null;
  classified: Classified;
  height: ReturnType<typeof napHeight>;
};

export type StateRead = {
  t: number;
  series: SeriesState[];
  stations: StationRow[];
  publicSeries: Set<number>;
  /** P14f: the series with a day-of-year set (a P10_DOY and a P90_DOY row) valid at t, for the coverage counts. */
  doySeries: Set<number>;
  /** P18a: the tide rows usable at t (TIDE_AT), by series; absent for a forecast t. */
  tide?: Map<number, TideRow[]>;
};

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

const seriesByStation = (series: readonly SeriesRow[]) => {
  const out = new Map<string, SeriesRow[]>();
  for (const s of series) out.set(s.station_id, [...(out.get(s.station_id) ?? []), s]);
  return out;
};

const refIn = (r: RefRow): RefIn => ({
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

const areaIn = (w: WarningRow, fresh: boolean): AreaIn => ({
  source: w.source_id,
  key: w.area_key,
  name: w.name,
  levelRaw: w.level_raw,
  fresh,
});

/**
 * The stations each warning attaches to (the static entry's map, or a fresh one without the cache); a polygon not
 * seen before is read and parsed once.
 */
async function attachWarnings<W extends WarningRow>(
  tx: Kysely<DB>,
  family: ChannelAudience,
  warnings: readonly W[],
  fixed: Static,
  sections: ReadonlyMap<string, string>,
): Promise<{ w: W; ids: string[] }[]> {
  const { attached } = fixed;
  const keyOf = (w: WarningRow) => w.geom_md5 ?? `${w.source_id}:${w.area_key}`;
  // One row per geometry not seen before: rows sharing a polygon (one LU-5 zone in several alerts) fetch it once.
  const missing = [
    ...new Map(
      warnings.flatMap((w) => (w.geom_md5 !== null && !attached.has(w.geom_md5) ? [[w.geom_md5, w.id]] : [])),
    ).values(),
  ];
  const geometry = new Map(
    missing.length === 0
      ? []
      : (
          await sql<{ md5: string; geometry_geojson: string | null }>`
              SELECT md5(geometry_geojson) AS md5, geometry_geojson FROM ${sql.table(VIEWS[family].warning)}
              WHERE id = ANY(${missing}::bigint[])`.execute(tx)
        ).rows.map((g) => [g.md5, g.geometry_geojson]),
  );
  return warnings.map((w) => {
    const key = keyOf(w);
    const known = attached.get(key);
    if (known !== undefined) return { w, ids: known };
    // A polygon is attached only from the geometry this read fetched; without it nothing is kept (review SR-2).
    if (w.geom_md5 !== null && !geometry.has(w.geom_md5)) return { w, ids: [] };
    const ids = attachArea(
      { source: w.source_id, key: w.area_key, geometry: parseGeometry(geometry.get(w.geom_md5 ?? '') ?? null) },
      fixed.stations,
      sections,
    );
    attached.set(key, ids);
    return { w, ids };
  });
}

/**
 * Every active series of the family at t, classified. `current` marks the current 10-minute bucket: only there is a
 * class or area judged by its source's last successful fetch (CLASS_WINDOW_MIN); for an earlier t the stored rows
 * are the record. `sections` is the FR-5 station → section map (loaded once at boot). `forecast` (P8b, a future t)
 * classifies these values instead of observations, against the references valid at t only: a provider class or an
 * area warning describes the present, never a forecast, and nothing observed is read past now.
 */
export async function readStates(
  db: Kysely<DB>,
  family: ChannelAudience,
  t: number,
  opts: {
    now: number;
    current: boolean;
    sections: ReadonlyMap<string, string>;
    cache?: StaticCache | undefined;
    forecast?: ReadonlyMap<number, { ts: number; value: number }>;
    /** P18a: read the tide rows (the snapshot paths only; health and status discard them). */
    tide?: boolean;
  },
): Promise<StateRead> {
  const V = VIEWS[family];
  const at = new Date(t).toISOString();
  const fixed = await (opts.cache?.get(db, family) ?? readStatic(db, family));
  const { stations } = fixed;
  const forecast = opts.forecast;
  // P14f: the day-of-year rows of t's UTC day (also for a forecast t), outside the snapshot like the static rows and
  // beside it, not after it (review R1-4): one more connection at most, for one short indexed read. Both promises go
  // into Promise.all unawaited, so a failure of either is handled there (review round 2, X1: an `await` inside the
  // array left the DOY read's rejection unhandled while the snapshot ran, which ends the process).
  const [doyRows, rows] = await Promise.all([
    readDoy(db, family, [utcMonthDay(t)], opts.cache),
    forecast !== undefined
      ? {
          areas: [],
          obs: [...forecast].map(
            ([series_id, f]): ObsRow => ({ series_id, ts: new Date(f.ts), value: f.value, qc: 0 }),
          ),
          classes: [],
          health: [],
          tide: undefined,
        }
      : snapshot(db, async (tx) => {
          const warnings = (
            await sql<WarningRow>`
        SELECT ${WARNING_COLUMNS} FROM ${sql.table(V.warning)} WHERE valid @> ${at}::timestamptz ORDER BY id`.execute(
              tx,
            )
          ).rows;
          return {
            areas: await attachWarnings(tx, family, warnings, fixed, opts.sections),
            obs: (
              await sql<ObsRow>`SELECT series_id, ts, value, qc FROM ${sql.id(OBS_AT[family])}(${at}::timestamptz)`.execute(
                tx,
              )
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
            // P18a: the tide rows a value at t may use (tidal stations only); the subtraction is tideAt's.
            tide: opts.tide
              ? (
                  await sql<TideAtRow>`
          SELECT series_id, kind, hilo, ts, value FROM ${sql.id(TIDE_AT[family])}(${at}::timestamptz)`.execute(tx)
                ).rows
              : undefined,
          };
        }),
  ]);
  const doy = doyRows.filter((r) => validAt(r, t));
  const series = fixed.series;
  const refs = [...fixed.refs.filter((r) => validAt(r, t)), ...doy];
  const zeros = fixed.zeros.filter((z) => validAt(z, t));

  const lastOk = new Map(rows.health.map((h) => [h.source_id, h.last_fetch_ok?.getTime() ?? null]));
  const fresh = (source: string) => {
    if (!opts.current) return true;
    const ok = lastOk.get(source) ?? null;
    return ok !== null && opts.now - ok <= (CLASS_WINDOW_MIN[source] ?? 45) * 60_000;
  };

  const stationOf = new Map(stations.map((s) => [s.id, s]));
  const seriesOf = seriesByStation(series);
  const obsOf = new Map(rows.obs.map((o) => [o.series_id, o]));
  const zeroOf = new Map(zeros.map((z) => [z.series_id, z]));
  const refsOf = new Map<number, RefIn[]>();
  for (const r of refs) {
    const list = refsOf.get(r.series_id) ?? [];
    list.push(refIn(r));
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
      areasOf.set(id, [...(areasOf.get(id) ?? []), areaIn(w, fresh(w.source_id))]);
    }
  }

  const states: SeriesState[] = series.map((s) => {
    const st = stationOf.get(s.station_id);
    const o = obsOf.get(s.id);
    const z = zeroOf.get(s.id);
    const classified = classify(
      {
        quantity: s.quantity,
        valueKind: s.value_kind,
        value: o?.value ?? null,
        qc: o?.qc ?? 0,
        // A forecast value is the run's value for t (held within its step): never stale.
        ageMs: o === undefined || forecast !== undefined ? 0 : t - o.ts.getTime(),
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
  const publicSeries = new Set(series.filter((s) => s.audience === 'public').map((s) => s.id));
  const kinds = new Map<number, Set<string>>();
  for (const r of doy) kinds.set(r.series_id, (kinds.get(r.series_id) ?? new Set()).add(r.kind));
  const doySeries = new Set([...kinds].filter(([, k]) => k.size === DOY_KINDS.length).map(([id]) => id));
  if (rows.tide === undefined) return { t, series: states, stations, publicSeries, doySeries };
  return { t, series: states, stations, publicSeries, doySeries, tide: tideBySeries(rows.tide) };
}

/** The snapshot's values: the series with a value at t, with their state, basis and detail-view height. */
export function snapshotValues(read: StateRead): Snapshot['values'] {
  return read.series.flatMap((s) => {
    if (s.obs === null) return [];
    const c = s.classified;
    const rows = read.tide?.get(s.series);
    const tide = rows === undefined ? undefined : tideAt({ ts: s.obs.ts.getTime(), value: s.obs.value }, rows);
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
        ...(tide === undefined ? {} : { tide }),
      },
    ];
  });
}

// --- The state of each frames hour (#112) ------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/**
 * The codes of settled days, per process: a settled day is immutable per (family, day, day version), so its codes
 * are kept under exactly that key, newest use last. A day holds one Int8Array of 24 per series (-1: not computed).
 * ponytail: a bounded LRU of whole days (≈ 1,400 series × 24 bytes each); a longer playback window or many more
 * series would want a byte bound instead of a day count.
 */
export class HourMemo {
  readonly #days = new Map<string, Map<number, Int8Array>>();
  readonly #maxDays: number;
  constructor(maxDays = 32) {
    this.#maxDays = maxDays;
  }
  day(key: string): Map<number, Int8Array> {
    let hit = this.#days.get(key);
    if (hit !== undefined) this.#days.delete(key);
    else hit = new Map();
    this.#days.set(key, hit);
    for (const old of this.#days.keys()) {
      if (this.#days.size <= this.#maxDays) break;
      this.#days.delete(old);
    }
    return hit;
  }
}

type ClassAt = { ts: number; code: string | null };
type RangedWarning = Ranged<WarningRow>;

/**
 * The state code (`stateCode`) of every non-null cell of frames over [from, to), aligned with `frames.ids`: the value
 * of hour h classified as the snapshot at the last instant of that hour would classify it (#112 C1, ts* = h + 1 h −
 * 1 ms; the partial current hour at now): the references valid then, the latest class row per station and source at
 * or before then, the warnings valid then, never judged by fetch freshness (a past t), age 0 and qc 0 (they only set
 * flags). The values are the caller's (the display or the api views); the rows behind the states always come from
 * VIEWS[family], as readStates reads them. A series with no reference, class or area in the whole range is no_ref
 * without classify(). With `memo` and `versionOf`, the cells of settled days are taken from and kept in the memo;
 * `yieldEvery` lets the event loop run every that many series (the API).
 */
export async function readHourStates(
  db: Kysely<DB>,
  family: ChannelAudience,
  frames: { readonly ids: readonly number[]; readonly vlast: readonly (readonly (number | null)[])[] },
  from: number,
  to: number,
  opts: {
    now: number;
    sections: ReadonlyMap<string, string>;
    cache?: StaticCache | undefined;
    memo?: HourMemo | undefined;
    versionOf?: ((day: string) => number) | undefined;
    yieldEvery?: number | undefined;
  },
): Promise<(number | null)[][]> {
  const hours = Math.max(0, Math.round((to - from) / HOUR_MS));
  const codes: (number | null)[][] = frames.vlast.map((row) => row.map((v) => (v === null ? null : -1)));
  // The memo's day of each hour (settled days only), or undefined.
  const memoDays: (Map<number, Int8Array> | undefined)[] = [];
  const memoHour: number[] = [];
  for (let h = 0; h < hours; h++) {
    const start = from + h * HOUR_MS;
    const day = dayOf(start);
    memoDays.push(
      opts.memo !== undefined && opts.versionOf !== undefined && isSettled(day, opts.now)
        ? opts.memo.day(`${family}|${day}|${opts.versionOf(day)}`)
        : undefined,
    );
    memoHour.push(Math.floor((start - Date.parse(`${day}T00:00:00Z`)) / HOUR_MS));
  }
  let open = false;
  frames.ids.forEach((id, i) => {
    const row = codes[i] as (number | null)[];
    for (let h = 0; h < hours; h++) {
      if (row[h] === null) continue;
      const kept = memoDays[h]?.get(id)?.[memoHour[h] as number] ?? -1;
      if (kept >= 0) row[h] = kept;
      else open = true;
    }
  });
  if (!open) return codes;

  const fixed = await (opts.cache?.get(db, family) ?? readStatic(db, family));
  const V = VIEWS[family];
  const span = { from: new Date(from), to: new Date(to) };
  const rows = await snapshot(db, async (tx) => {
    const warnings = (
      await sql<RangedWarning>`
        SELECT ${WARNING_COLUMNS}, ${RANGE} FROM ${sql.table(V.warning)}
        WHERE valid && tstzrange(${span.from}::timestamptz, ${span.to}::timestamptz, '[)') ORDER BY id`.execute(tx)
    ).rows;
    // The latest class row per station and source at `from`, then every later one inside the span, oldest first.
    const before = await sql<ClassRow & { ts: Date }>`
      SELECT DISTINCT ON (subject_id, source_id) subject_id, source_id, provider_code, ts
      FROM ${sql.table(V.class)} WHERE subject_type = 'station' AND ts <= ${span.from}::timestamptz
      ORDER BY subject_id, source_id, ts DESC`.execute(tx);
    const inside = await sql<ClassRow & { ts: Date }>`
      SELECT subject_id, source_id, provider_code, ts
      FROM ${sql.table(V.class)}
      WHERE subject_type = 'station' AND ts > ${span.from}::timestamptz AND ts < ${span.to}::timestamptz
      ORDER BY ts`.execute(tx);
    return {
      areas: await attachWarnings(tx, family, warnings, fixed, opts.sections),
      classes: [...before.rows, ...inside.rows],
    };
  });

  const seriesById = new Map(fixed.series.map((s) => [s.id, s]));
  const seriesOf = seriesByStation(fixed.series);
  const stationOf = new Map(fixed.stations.map((s) => [s.id, s]));
  // The NL-4 season day of each hour's instant, computed once per hour, not per cell.
  const instantOf = (h: number) => Math.min(from + (h + 1) * HOUR_MS - 1, opts.now);
  const mdOf: number[] = [];
  // P14f: the UTC day key of each hour's instant, and the day-of-year rows of those keys (ranged, as the snapshot
  // reads them at that instant).
  const doyMdOf: number[] = [];
  for (let h = 0; h < hours; h++) {
    mdOf.push(monthDay(instantOf(h)));
    doyMdOf.push(utcMonthDay(instantOf(h)));
  }
  const refsOf = new Map<number, { r: Ranged<RefRow>; in: RefIn }[]>();
  for (const r of [...fixed.refs, ...(await readDoy(db, family, [...new Set(doyMdOf)], opts.cache))])
    refsOf.set(r.series_id, [...(refsOf.get(r.series_id) ?? []), { r, in: refIn(r) }]);
  // Per target series and source (in source order, as readStates' DISTINCT ON orders them): the class rows by time.
  const classesOf = new Map<number, Map<string, ClassAt[]>>();
  for (const c of rows.classes) {
    const target = classSeries(c.source_id, seriesOf.get(c.subject_id) ?? []);
    if (target === undefined) continue;
    const bySource = classesOf.get(target.id) ?? new Map<string, ClassAt[]>();
    bySource.set(c.source_id, [...(bySource.get(c.source_id) ?? []), { ts: c.ts.getTime(), code: c.provider_code }]);
    classesOf.set(target.id, bySource);
  }
  const areasOf = new Map<string, RangedWarning[]>();
  for (const { w, ids } of rows.areas) for (const id of ids) areasOf.set(id, [...(areasOf.get(id) ?? []), w]);

  for (let i = 0; i < frames.ids.length; i++) {
    if (opts.yieldEvery !== undefined && i > 0 && i % opts.yieldEvery === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const id = frames.ids[i] as number;
    const row = codes[i] as (number | null)[];
    const values = frames.vlast[i] as readonly (number | null)[];
    const s = seriesById.get(id);
    const refs = refsOf.get(id) ?? [];
    const classes = [...(classesOf.get(id) ?? [])].sort(([a], [b]) => (a < b ? -1 : 1));
    const areas = s === undefined ? [] : (areasOf.get(s.station_id) ?? []);
    const st = s === undefined ? undefined : stationOf.get(s.station_id);
    // classify() compares the value only with reference values (<, <=, >= and NL-4's [from, to)), so with the same
    // rows the state depends on the value only through its place among this series' reference values: the codes
    // are kept per (rows valid at the instant, NL-4 season day, that place), exactly as classify() would answer.
    const thresholds = [...new Set(refs.map((x) => x.r.value))].sort((a, b) => a - b);
    const nl4 = refs.some((x) => x.r.source_id === 'NL-4');
    const hasDoy = refs.some((x) => isDoy(x.r.kind));
    const known = new Map<string, number>();
    for (let h = 0; h < hours; h++) {
      if (row[h] !== -1) continue;
      let code = 0;
      // The fast path: nothing could classify this series in the whole range (or it is not in the family's series).
      if (s !== undefined && (refs.length > 0 || classes.length > 0 || areas.length > 0)) {
        const ts = instantOf(h);
        const value = values[h] as number;
        // A day-of-year row holds for its own UTC day key only (the snapshot passes classify() just that day's rows).
        const validRefs = refs.filter(
          (x) => validAt(x.r, ts) && (!isDoy(x.r.kind) || x.r.season_from_md === doyMdOf[h]),
        );
        const validClasses = classes.flatMap(([source, list]) => {
          let at: string | null = null;
          for (const k of list) if (k.ts <= ts) at = k.code;
          return at === null ? [] : [{ source, code: at, fresh: true }];
        });
        const validAreas = areas.filter((w) => validAt(w, ts));
        let below = 0;
        let equal = false;
        // With day-of-year rows the places are those of the rows valid on this day, not of all 365 keys.
        const places = hasDoy ? [...new Set(validRefs.map((x) => x.r.value))].sort((a, b) => a - b) : thresholds;
        for (const x of places) {
          if (x < value) below += 1;
          else {
            equal = x === value;
            break;
          }
        }
        const key = [
          validRefs.map((x) => refs.indexOf(x)).join(','),
          validClasses.map((c) => `${c.source}:${c.code}`).join(','),
          validAreas.map((w) => w.id).join(','),
          nl4 ? mdOf[h] : '',
          hasDoy ? doyMdOf[h] : '',
          `${below}${equal ? '=' : ''}`,
        ].join('|');
        const kept = known.get(key);
        if (kept !== undefined) code = kept;
        else {
          const c = classify(
            {
              quantity: s.quantity,
              valueKind: s.value_kind,
              value,
              qc: 0,
              ageMs: 0,
              stalenessMs: s.staleness_ms,
              t: ts,
              refs: validRefs.map((x) => x.in),
              classes: validClasses,
              areas: validAreas.map((w) => areaIn(w, true)),
              tidal: flagOf(st?.flags, 'tidal'),
              impounded: flagOf(st?.flags, 'impounded'),
            },
            family,
          );
          // The public boundary (as publicSnapshot's, review SR-5): a public state shaped by an owner-only source
          // fails the read closed; the public views and classify() already keep such rows out.
          if (family === 'public' && c.sources.some((x) => OWNER_ONLY_SOURCES.has(x))) throw coded('owner_basis');
          code = stateCode(c.state, c.section);
          known.set(key, code);
        }
      }
      row[h] = code;
      const day = memoDays[h];
      if (day !== undefined) {
        let kept = day.get(id);
        if (kept === undefined) {
          kept = new Int8Array(24).fill(-1);
          day.set(id, kept);
        }
        kept[memoHour[h] as number] = code;
      }
    }
  }
  return codes;
}

type Share = ClassCoverage['tier1'];
type Count = { stations: number; classed: number; bySection: number; byClimatology: number; climatology: number };
const share = (c: Count): Share => ({
  stations: c.stations,
  classed: c.classed,
  by_section: c.bySection,
  by_climatology: c.byClimatology,
  climatology: c.climatology,
  ratio: c.stations === 0 ? null : c.classed / c.stations,
});
const zero = (): Count => ({ stations: 0, classed: 0, bySection: 0, byClimatology: 0, climatology: 0 });
/** A basis has a day-of-year part when any kind of its ref (`a/b` after a collapse) is one of ours (P14f). */
const hasDoyPart = (s: SeriesState) =>
  s.classified.basis?.ref.split('/').some((k) => k.trim().endsWith('_DOY')) ?? false;
/** Adds one station whose states (other than no_ref) are `states`; `doy`: it has a day-of-year set valid at t. */
const add = (c: Count, states: readonly SeriesState[], doy: boolean) => {
  c.stations += 1;
  c.classed += states.length > 0 ? 1 : 0;
  c.bySection += states.length > 0 && states.every((s) => s.classified.section) ? 1 : 0;
  c.byClimatology += states.some(hasDoyPart) ? 1 : 0;
  c.climatology += doy ? 1 : 0;
};

/**
 * The coverage report of one family (catalogue gap item 17; D10): per country, (a) the tier-1 stations with a state
 * other than no_ref, and (b) the first-release stations (tier 1 with a public primary series: the registry's
 * `first_release`, pinned by test/registry-first-release.test.ts) whose state comes from a source that needs no
 * permission. A station counts as classed when any of its series is, and `by_section` when all of its states are
 * section states (review CR-4). `mode` is D10's default map mode, judged on the stations with a gauge state. In the
 * owner report an LU-4 or BE-3 basis counts as a source that needs no permission (personal-use terms, §0.8).
 */
export function classCoverage(read: StateRead): ClassCoverage {
  const byStation = new Map<string, SeriesState[]>();
  for (const s of read.series) byStation.set(s.station, [...(byStation.get(s.station) ?? []), s]);
  const count = new Map<string, { t1: Count; fr: Count }>();
  const all = { t1: zero(), fr: zero() };
  for (const st of read.stations) {
    if (st.tier !== 1) continue;
    const list = byStation.get(st.id) ?? [];
    const states = list.filter((s) => s.classified.state !== 'no_ref');
    const open = states.filter(
      (s) => s.classified.basis !== null && !PERMISSION_REQUIRED.has(s.classified.basis.source),
    );
    const firstRelease = list.some((s) => read.publicSeries.has(s.series));
    const doy = list.some((s) => read.doySeries.has(s.series));
    const c = count.get(st.country) ?? { t1: zero(), fr: zero() };
    for (const k of [c, all]) {
      add(k.t1, states, doy);
      if (firstRelease) add(k.fr, open, doy);
    }
    count.set(st.country, c);
  }
  const gauge = all.t1.stations === 0 ? 0 : (all.t1.classed - all.t1.bySection) / all.t1.stations;
  return {
    t: iso(new Date(read.t)),
    mode: gauge >= 0.6 ? 'state' : 'dh',
    tier1: share(all.t1),
    first_release: share(all.fr),
    countries: [...count]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([country, c]) => ({
        country: country as ClassCoverage['countries'][number]['country'],
        tier1: share(c.t1),
        first_release: share(c.fr),
      })),
  };
}
