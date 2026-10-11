import { z } from 'zod';
import {
  ApiStation,
  Attribution,
  AttributionEntry,
  attributionEntry,
  checkFrames,
  DATE_KINDS,
  framesObject,
  framesObjectV1,
  HealthSourceId,
  MAX_POINTS,
  Meta,
  SeriesMeta,
  type Snapshot,
  STATES,
  StateBasis,
} from './api.ts';
import { ForecastLatest } from './forecast.ts';
import { DATUMS } from './units.ts';

// The static files of A§9.1 (P9a): what `publish` writes under /data/v1/ and the web reads first. Every file carries
// `schemaVersion` 1 (stations.json: 2, P9b adds `api` per series) and an `attribution` array that lists exactly the sources its body names. Every schema is built
// by one factory over the source-id schema, as `forecastLatest(source)` is: the public instances (this module) refuse
// a canary's source id; the owner instances (static-owner.ts, server only) allow it. This module imports only zod,
// api.ts, forecast.ts and units.ts: the web bundle takes it, and nothing of the registry, the health documents or
// the canaries may follow it there (apps/web/test/build.test.ts).

const iso = z.iso.datetime();
const count = z.number().int().nonnegative();
const SeriesId = z.number().int().min(1).max(2_147_483_647);
const Qc = z.number().int().min(0).max(1023);
const STATION_ID = /^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/;

/** A UTC day, `YYYY-MM-DD`. */
export const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export const DAY_MS = 86_400_000;
/** A UTC day is settled once its end is this long ago: its snapshots move from recent/ to settled/v{n}/. */
export const SETTLE_MS = 48 * 3_600_000;

/** The UTC day of an instant. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
/** D is settled when D + 1 day ≤ now − 48 h; the web evaluates it against `meta.now`, never its own clock. */
export const isSettled = (day: string, nowMs: number): boolean => dayStartMs(day) + DAY_MS <= nowMs - SETTLE_MS;

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16).replace(':', '');
/** `recent/YYYY-MM-DD/HHmm.json`: the UTC day and the start of the 10-minute bucket `t`. */
export const recentPath = (t: number): string => `recent/${dayOf(t)}/${hhmm(t)}.json`;
/** `settled/YYYY-MM-DD/v{n}/HHmm.json`. */
export const settledPath = (t: number, version: number): string => `settled/${dayOf(t)}/v${version}/${hhmm(t)}.json`;
/** `frames/YYYY-MM-DD/v{n}.json`: one settled day's hourly frames. */
export const framesPath = (day: string, version: number): string => `frames/${day}/v${version}.json`;

const AREA_STATES = STATES.slice(1) as ['low', 'normal', 'elevated', 'high', 'extreme'];
/** The first 16 hex digits of the sha256 of stations.json's series ids in order: latest.json must carry the same. */
export const SeriesHash = z.string().regex(/^[0-9a-f]{16}$/);

/** GeoJSON coordinates: nested arrays of numbers, nothing else. */
const Coordinates: z.ZodType<unknown> = z.lazy(() => z.array(z.union([z.number(), Coordinates])).max(100_000));

/** The shared schema factory: `source` is the source-id schema, `latest` the family's forecast/latest.json schema. */
export function staticContracts(source: z.ZodString, latest: typeof ForecastLatest) {
  const Basis = StateBasis.extend({ source });
  /** One attribution row of one source in the body, with the date its licence asks for (null when none). */
  const AttributionEntry = attributionEntry(source);
  const attribution = z.array(AttributionEntry).max(500);

  const column = <T extends z.ZodType>(t: T) => z.array(t).max(MAX_POINTS);
  const snapshotColumns = {
    schemaVersion: z.literal(1),
    /** The quantised instant (UTC, on the 10-minute grid). */
    t: iso,
    series: column(SeriesId),
    /** t − ts in whole seconds: the observation carried forward to t is at `t − ageSeconds`. */
    ageSeconds: column(count),
    value: column(z.number()),
    qc: column(Qc),
    state: column(z.enum(STATES)),
    /** An index into `bases`; null exactly when the state is no_ref. */
    basis: column(z.number().int().nonnegative().nullable()),
    bases: z.array(Basis).max(MAX_POINTS),
    section: column(z.boolean()),
    area: column(z.strictObject({ state: z.enum(AREA_STATES), basis: z.number().int().nonnegative() }).nullable()),
    nap: column(z.strictObject({ m: z.number(), pm: z.number().nonnegative() }).nullable()),
    zero: column(z.strictObject({ m: z.number(), datum: z.enum(DATUMS) }).nullable()),
    attribution,
  };
  type Columns = { [K in keyof typeof snapshotColumns]: z.infer<(typeof snapshotColumns)[K]> };
  const checkColumns = (f: Columns, ctx: z.RefinementCtx, extra: readonly (readonly unknown[])[] = []) => {
    const n = f.series.length;
    const cols = [f.ageSeconds, f.value, f.qc, f.state, f.basis, f.section, f.area, f.nap, f.zero, ...extra];
    if (cols.some((c) => c.length !== n))
      ctx.addIssue({ code: 'custom', message: 'every column has one entry per series' });
    if (new Set(f.series).size !== n) ctx.addIssue({ code: 'custom', message: 'a series is listed twice' });
    for (let i = 0; i < n; i++) {
      const b = f.basis[i];
      if ((b === null) !== (f.state[i] === 'no_ref'))
        ctx.addIssue({ code: 'custom', message: 'basis is null exactly when the state is no_ref' });
      const area = f.area[i]?.basis;
      if ((b != null && b >= f.bases.length) || (area !== undefined && area >= f.bases.length))
        ctx.addIssue({ code: 'custom', message: 'a basis index past bases' });
    }
  };

  /** recent/ and settled/ (A§9.1): ordered by series; no generation time, so a settled file is a function of (day, version). */
  const SnapshotFile = z.strictObject(snapshotColumns).superRefine((f, ctx) => {
    checkColumns(f, ctx);
    for (let i = 1; i < f.series.length; i++)
      if ((f.series[i] as number) <= (f.series[i - 1] as number)) {
        ctx.addIssue({ code: 'custom', message: 'series must increase' });
        break;
      }
  });
  const Delta = column(z.number().nullable());
  /**
   * latest.json: the current bucket, its series in stations.json's order (the series with a value at t), the hash of
   * that order, and per series Δh over 24 h and over 1 h (value(t) − value(t − 24 h), value(t) − value(t − 1 h); null
   * without both values). KG-233: `lapsed` lists, in the same order, the series with no value at t (past their
   * staleness limit, or none at all) and `lapsedAge` the age in seconds at t of each one's newest value (null: it
   * never had one), so the page can tell a stale series from one that never had a value. A series with a value
   * carries its age in `ageSeconds`.
   */
  const LatestFile = z
    .strictObject({
      ...snapshotColumns,
      generatedAt: iso,
      seriesHash: SeriesHash,
      dh24: Delta,
      dh1: Delta,
      lapsed: column(SeriesId),
      lapsedAge: column(count.nullable()),
    })
    .superRefine((f, ctx) => {
      checkColumns(f, ctx, [f.dh24, f.dh1]);
      const have = new Set(f.series);
      if (f.lapsedAge.length !== f.lapsed.length || new Set(f.lapsed).size !== f.lapsed.length)
        ctx.addIssue({ code: 'custom', message: 'lapsedAge has one entry per lapsed series, each listed once' });
      if (f.lapsed.some((s) => have.has(s)))
        ctx.addIssue({ code: 'custom', message: 'a series with a value is not lapsed' });
    });

  const Day = z.string().regex(DAY_RE);
  /** meta.json: the API's /meta plus the static fields. */
  const StaticMeta = Meta.extend({
    sources: z.array(z.strictObject({ id: source, attribution: z.array(Attribution).max(20) })).max(100),
    forecastHorizons: z.array(z.strictObject({ source, hours: z.number().int().min(1).max(48) })).max(20),
    schemaVersion: z.literal(1),
    generatedAt: iso,
    /**
     * The settled days' current versions, sparse: a settled day that is absent has version 1, and 0 means no complete
     * settled file (read the API). Names only complete versions. The owner family's map holds its versions alone.
     */
    dayVersions: z
      .record(Day, z.number().int().min(0).max(1_000_000))
      .refine((m) => Object.keys(m).length <= 5000, 'at most 5000 days'),
    /** The loader is stalled (backlog older than 15 minutes) or the publisher is behind on recent buckets. */
    degraded: z.boolean(),
    /** The newest loaded_at of the family's batches that the latest.json render saw (null before the first). */
    latestFrom: iso.nullable(),
    /**
     * P12a (A§9.2): the brownout flag was on when this file was written: the API serves shorter spans, no raw
     * resolution, and longer TTLs; the web shows its banner and clamps the history view. Absent means off.
     */
    brownout: z.boolean().optional(),
    attribution,
  });

  /** `api`: the series is also served by /series (the api channel, lic_api); P10 reads it to choose chart or fallback. */
  const StaticSeriesMeta = SeriesMeta.extend({ source, api: z.boolean() });
  const StaticStation = ApiStation.extend({ series: z.array(StaticSeriesMeta).min(1).max(20) });
  /** stations.json: the API's /stations; the series of all stations in order define `seriesHash`. */
  const StaticStations = z.strictObject({
    schemaVersion: z.literal(2),
    seriesHash: SeriesHash,
    stations: z.array(StaticStation).max(10_000),
    attribution,
  });

  /** Hourly playback frames (A§8 Q5: the hourly rollup's `vlast`), as /api/v1/frames carries them (api.ts); ≤ 5 days. */
  const FramesFile = framesObject(source, 24 * 5).superRefine(checkFrames);
  /**
   * What a reader of the static frames accepts (#112): version 2, or a version 1 file written before it (no `state`:
   * the web plays its values with the state unknown). Only the readers use it (the web, verify-prod, record-frames);
   * the publisher writes and validates version 2 only.
   */
  const FramesFileAny = z.discriminatedUnion('schemaVersion', [
    framesObjectV1(source, 24 * 5).superRefine(checkFrames),
    FramesFile,
  ]);

  const Run = latest.shape.runs.element;
  /** series/{station}/recent.json: 7 days of raw observations, the latest run and the references valid now. */
  const StationRecent = z.strictObject({
    schemaVersion: z.literal(1),
    station: z.string().regex(STATION_ID).max(80),
    from: iso,
    to: iso,
    series: z
      .array(
        z
          .strictObject({
            id: SeriesId,
            source,
            ts: z.array(iso).max(MAX_POINTS),
            value: z.array(z.number()).max(MAX_POINTS),
            qc: z.array(Qc).max(MAX_POINTS),
            /** The run forecast/latest.json shows for this series, else null. */
            run: Run.nullable(),
            references: z
              .array(
                z.strictObject({
                  source,
                  kind: z.string().min(1).max(40),
                  value: z.number(),
                  unit: z.string().min(1).max(20),
                  priority: z.number().int(),
                  /** "WSV MNW 2010–2020": untrusted text, data only. */
                  label: z.string().min(1).max(700).nullable(),
                  /**
                   * #99: the season the row holds in (NL-4), MMDD in Europe/Amsterdam, both ends inclusive, wrapping
                   * the year when from > to. Absent: the whole year.
                   */
                  season: z
                    .strictObject({
                      from: z.number().int().min(101).max(1231),
                      to: z.number().int().min(101).max(1231),
                    })
                    .optional(),
                }),
              )
              .max(100),
          })
          .superRefine((s, ctx) => {
            if (s.value.length !== s.ts.length || s.qc.length !== s.ts.length)
              ctx.addIssue({ code: 'custom', message: 'one value and qc per ts' });
          }),
      )
      .max(20),
    attribution,
  });

  const StaticForecastLatest = latest.extend({ attribution });

  /**
   * warnings/latest.geojson (the areas valid at generatedAt, `day` null), warnings/YYYY-MM-DD.json (every area valid
   * during that ended UTC day, written once) and warnings/today.json (the same for the current UTC day, as loaded so
   * far, `day` that day, rewritten every cycle): a GeoJSON FeatureCollection with the schema fields as foreign members.
   * Every text is the provider's, untrusted: data only (invariant 3).
   */
  const WarningsFile = z.strictObject({
    type: z.literal('FeatureCollection'),
    schemaVersion: z.literal(1),
    generatedAt: iso,
    day: Day.nullable(),
    features: z
      .array(
        z.strictObject({
          type: z.literal('Feature'),
          geometry: z
            .strictObject({
              type: z.enum(['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']),
              coordinates: Coordinates,
            })
            .nullable(),
          properties: z.strictObject({
            source,
            area: z.string().min(1).max(120),
            name: z.string().max(500).nullable(),
            level: z.number().int().min(1).max(5).nullable(),
            levelRaw: z.string().max(40).nullable(),
            label: z.string().max(500).nullable(),
            from: iso,
            to: iso.nullable(),
            issuedAt: iso.nullable(),
          }),
        }),
      )
      .max(5000),
    attribution,
  });

  return {
    WarningsFile,
    Basis,
    AttributionEntry,
    SnapshotFile,
    LatestFile,
    StaticMeta,
    StaticStations,
    FramesFile,
    FramesFileAny,
    StationRecent,
    StaticForecastLatest,
  };
}

const PUBLIC = staticContracts(HealthSourceId, ForecastLatest);
export const SnapshotFile = PUBLIC.SnapshotFile;
export type SnapshotFile = z.infer<typeof SnapshotFile>;
export const LatestFile = PUBLIC.LatestFile;
export type LatestFile = z.infer<typeof LatestFile>;
export const StaticMeta = PUBLIC.StaticMeta;
export type StaticMeta = z.infer<typeof StaticMeta>;
export const StaticStations = PUBLIC.StaticStations;
export type StaticStations = z.infer<typeof StaticStations>;
export const FramesFile = PUBLIC.FramesFile;
export type FramesFile = z.infer<typeof FramesFile>;
export const FramesFileAny = PUBLIC.FramesFileAny;
export type FramesFileAny = z.infer<typeof FramesFileAny>;
export const StationRecent = PUBLIC.StationRecent;
export type StationRecent = z.infer<typeof StationRecent>;
export const StaticForecastLatest = PUBLIC.StaticForecastLatest;
export type StaticForecastLatest = z.infer<typeof StaticForecastLatest>;
export const WarningsFile = PUBLIC.WarningsFile;
export type WarningsFile = z.infer<typeof WarningsFile>;

export const HttpsUrl = z
  .string()
  .max(500)
  .regex(/^https:\/\/[^\s]+$/);

/** One source of sources.json: the registry's names and attribution rows verbatim, and the date its licence asks for. */
export const sourceEntry = (source: z.ZodString) =>
  z.strictObject({
    id: source,
    name: z.string().min(1).max(200),
    provider: z.string().min(1).max(200),
    /** The licence kind of the registry and the provider's terms page. */
    licence: z.strictObject({ kind: z.string().min(1).max(40).nullable(), url: HttpsUrl.nullable() }),
    attribution: z
      .array(
        z.strictObject({
          lang: z.enum(['nl', 'en', 'de', 'fr']).nullable(),
          text: z.string().min(1).max(1000),
          url: HttpsUrl.nullable(),
          required: z.boolean(),
        }),
      )
      .max(20),
    dateKind: z.enum(DATE_KINDS).nullable(),
    date: iso.nullable(),
    dateText: z.string().max(60).nullable(),
  });

/** /data/v1/sources.json: the public sources (catalogue §1b texts, licence links, dynamic dates). */
export const StaticSources = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  sources: z.array(sourceEntry(HealthSourceId)).max(100),
  attribution: z.array(AttributionEntry).max(500),
});
export type StaticSources = z.infer<typeof StaticSources>;

/** The API's Snapshot from a snapshot file (latest, recent or settled): ordered by series, `ts = t − ageSeconds`. */
export function toSnapshot(file: Omit<SnapshotFile, 'schemaVersion'>): Snapshot {
  const t = Date.parse(file.t);
  const order = file.series.map((_, i) => i).sort((a, b) => (file.series[a] as number) - (file.series[b] as number));
  return {
    t: file.t,
    values: order.map((i) => {
      const basis = file.basis[i] ?? null;
      const area = file.area[i] ?? null;
      const nap = file.nap[i] ?? null;
      const zero = file.zero[i] ?? null;
      const age = file.ageSeconds[i] as number;
      return {
        series: file.series[i] as number,
        ts: new Date(t - age * 1000).toISOString(),
        value: file.value[i] as number,
        qc: file.qc[i] as number,
        ageSeconds: age,
        state: file.state[i] as (typeof STATES)[number],
        basis: basis === null ? null : (file.bases[basis] as z.infer<typeof StateBasis>),
        section: file.section[i] as boolean,
        ...(area === null
          ? {}
          : { area: { state: area.state, basis: file.bases[area.basis] as z.infer<typeof StateBasis> } }),
        ...(nap === null ? {} : { nap }),
        ...(zero === null ? {} : { zero }),
      };
    }),
  };
}
