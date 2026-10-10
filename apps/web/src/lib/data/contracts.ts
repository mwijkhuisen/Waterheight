import {
  FramesAnswer,
  FramesFileAny,
  LatestFile,
  MetaAnswer,
  SeriesAnswer,
  SeriesForecastAnswer,
  SnapshotAnswer,
  SnapshotFile,
  StaticForecastLatest,
  StaticMeta,
  StaticSources,
  StaticStations,
  StationRecent,
  StationsAnswer,
  WarningsFile,
} from '@rws/contracts';
import { z } from 'zod';

// The schemas the page reads its answers with, one record per site (P10a, plan C1). The public record (here, in the
// initial bundle) refuses a canary's source id; the owner record (features/owner/contracts.ts, a lazy chunk loaded
// only when /runtime-config.json says "owner") reads the owner family's files and the owner API, whose bodies name
// the owner canary's source and carry `audience: "owner"`. Every query takes its record from `useContracts`, so the
// public build never parses an owner body with an owner schema unless the site is the owner's.

type Parser<T> = { parse(data: unknown): T };

/** One sources.json entry; the owner's adds its audience and, for an owner source, the private basis (§0.8). */
export type WebSource = StaticSources['sources'][number] & {
  audience?: 'public' | 'owner';
  privateBasis?: { clause: string; url: string; retrieved: string } | null;
};
export type WebSources = Omit<StaticSources, 'sources'> & { sources: WebSource[] };

/** The default map mode (D10), as status.json states it for this site's own family; null when not known. */
export type StatusMode = 'state' | 'dh' | null;

export interface Contracts {
  audience: 'public' | 'owner';
  StaticMeta: Parser<StaticMeta>;
  StaticStations: Parser<StaticStations>;
  LatestFile: Parser<LatestFile>;
  SnapshotFile: Parser<SnapshotFile>;
  StaticForecastLatest: Parser<StaticForecastLatest>;
  StationRecent: Parser<StationRecent>;
  WarningsFile: Parser<WarningsFile>;
  Sources: Parser<WebSources>;
  StatusMode: Parser<StatusMode>;
  /** status.json for the Status page and the Method page's forecast coverage (P10b). */
  StatusPage: Parser<StatusPageData>;
  /** The travel times of the installed reaches file (P10b Method page). */
  ReachTravel: Parser<ReachTravelData>;
  MetaAnswer: Parser<z.infer<typeof MetaAnswer>>;
  StationsAnswer: Parser<z.infer<typeof StationsAnswer>>;
  SnapshotAnswer: Parser<z.infer<typeof SnapshotAnswer>>;
  SeriesAnswer: Parser<z.infer<typeof SeriesAnswer>>;
  SeriesForecastAnswer: Parser<z.infer<typeof SeriesForecastAnswer>>;
  /**
   * P11b: a settled day's or recent.json's hourly frames (the owner family has no static frames: never parses); a
   * version 1 file (before #112) is read with its states unknown.
   */
  FramesFile: Parser<FramesFileAny>;
  /** P11b: /api/v1/frames. */
  FramesAnswer: Parser<z.infer<typeof FramesAnswer>>;
  /** A source no view shows (the owner canary): its stations, series, runs, areas and credits are dropped on read. */
  hidden(source: string): boolean;
}

const Mode = z.looseObject({ mode: z.enum(['state', 'dh']) });
/** status.json is the publisher's operations file: only the one field the page needs is read, the rest is ignored. */
const PublicStatusMode = z
  .looseObject({ classification: Mode.nullable() })
  .transform((s): StatusMode => s.classification?.mode ?? null);

// --- P10b: the Status page and the Method page's forecast coverage and travel times -------------------------------
// Loose, web-side readers in the style of PublicStatusMode: only the fields the pages show, bounded arrays, and
// strings that are only ever rendered as text nodes. The server's own schemas (packages/contracts/src/status.ts,
// reaches.ts) are not imported (check-boundaries: the web never takes the status contracts).

const count = z.number().int().nonnegative();
const iso = z.iso.datetime();
const share = z.number().min(0).max(1).nullable();
const Country = z.enum(['NL', 'DE', 'BE', 'FR', 'LU', 'CH']);

/** A list whose bad entries are dropped one by one, so one bad row never blanks a page. At most `max` entries. */
const lenient = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(z.unknown())
    .max(max)
    .transform((list) =>
      list.flatMap((entry) => {
        const parsed = item.safeParse(entry);
        return parsed.success ? [parsed.data as z.output<T>] : [];
      }),
    );

/** The public spelling of a source id (no canary branch): the owner canary's row does not parse, so it is dropped. */
const StatusSourceId = z.string().regex(/^(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?$/);

const StatusRow = z.looseObject({
  id: StatusSourceId,
  // A status the page does not know is shown as unknown, never dropped: a missing row reads as "fine" (review round 1).
  status: z.enum(['ok', 'degraded', 'down', 'unknown']).catch('unknown'),
  lastFetchOk: iso.nullable(),
  newestTs: iso.nullable(),
  lagP95S: z.number().nonnegative().nullable(),
  coverage: share,
  forecast: z.looseObject({ runAgeS: count, late: z.iso.date().nullable() }).nullable(),
});
export type StatusRow = z.infer<typeof StatusRow>;

const Share = z.looseObject({ stations: count, classed: count });
export const ClassCoverage = z.looseObject({
  tier1: Share,
  first_release: Share,
  countries: z.array(z.looseObject({ country: Country, tier1: Share, first_release: Share })).max(6),
});
export type ClassCoverage = z.infer<typeof ClassCoverage>;

const Cover = { stations: count, covered: count };
export const ForecastCoverage = z.looseObject({
  total: z.looseObject(Cover),
  countries: z.array(z.looseObject({ country: Country, ...Cover })).max(6),
  reaches: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(60),
        names: z.looseObject({ nl: z.string().min(1).max(80), en: z.string().min(1).max(80) }),
        ...Cover,
        no_official_forecast: z.boolean(),
        after_permission: z.array(z.string().min(1).max(40)).max(8),
        none_publishes: z.array(z.string().min(1).max(40)).max(8),
      }),
    )
    .max(40),
});
export type ForecastCoverage = z.infer<typeof ForecastCoverage>;

/** The fields of status.json both families share (the owner record builds its own file schema from them). */
export const statusFields = {
  generatedAt: iso,
  sources: lenient(StatusRow, 200),
  twins: z.looseObject({ ok: count, failing: count }),
};
/** A coverage block that does not parse is null (the page says "n/a"), not a failed file. */
export const orNull = <T extends z.ZodType>(schema: T) => schema.nullable().catch(null);
const pairOf = <T extends z.ZodType>(schema: T) => z.looseObject({ public: orNull(schema), owner: orNull(schema) });
/** The owner file's `{public, owner}` pairs; a block that does not parse is a pair of nulls. */
export const ClassPair = pairOf(ClassCoverage).catch({ public: null, owner: null });
export const ForecastPair = pairOf(ForecastCoverage).catch({ public: null, owner: null });

/** One coverage block per family; `owner` is undefined on the public file (it has no owner half) and null when the
 *  owner file could not compute it. */
export interface StatusPageData {
  generatedAt: string;
  sources: StatusRow[];
  twins: { ok: number; failing: number };
  /** The public file's two counts of owner-audience sources; null on the owner file, which lists them instead. */
  ownerLine: { healthy: number; total: number } | null;
  classification: { public: ClassCoverage | null; owner: ClassCoverage | null | undefined };
  forecastCoverage: { public: ForecastCoverage | null; owner: ForecastCoverage | null | undefined };
}

const PublicStatusPage = z
  .looseObject({
    ...statusFields,
    classification: orNull(ClassCoverage),
    forecastCoverage: orNull(ForecastCoverage),
    ownerSources: orNull(z.looseObject({ healthy: count, total: count })),
  })
  .transform(
    (s): StatusPageData => ({
      generatedAt: s.generatedAt,
      sources: s.sources,
      twins: s.twins,
      ownerLine: s.ownerSources,
      classification: { public: s.classification, owner: undefined },
      forecastCoverage: { public: s.forecastCoverage, owner: undefined },
    }),
  );

/** The reaches file's sourced travel times (catalogue §3.7): ranges in hours, indicative, never an ETA. */
const StationRef = z
  .string()
  .max(80)
  .regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/);
const TravelValue = z.union([
  z.number().positive(),
  z.tuple([z.number().positive(), z.number().positive()]).refine(([lo, hi]) => lo < hi),
]);
const TravelTime = z
  .looseObject({
    from_station_id: StationRef,
    to_station_id: StationRef,
    // v2 (#110): exactly one of h and d (checked below); a single number needs its label.
    h: TravelValue.optional(),
    d: TravelValue.optional(),
    label: z.strictObject({ nl: z.string().min(1).max(80), en: z.string().min(1).max(80) }).optional(),
    derived: z.literal(true).optional(),
    basis: z.string().min(1).max(200),
    source: z.string().min(1).max(300),
    /** Never an href as it stands: the page passes it through httpsHref. */
    source_url: z.string().max(500),
  })
  .refine((t) => (t.h === undefined) !== (t.d === undefined) && (Array.isArray(t.h ?? t.d) || t.label !== undefined));
export const ReachTravel = z.looseObject({ travel_times: lenient(TravelTime, 1000) });
export type ReachTravelData = z.infer<typeof ReachTravel>;

// P10d: the neighbours of a station come from the stations and reaches of the same file. Local subsets with only the
// fields the walk uses (the server's strict schemas are not used as values: a new field upstream must not drop rows).
const GraphStationRef = z.string().max(80);
const GraphReachId = z.string().max(60);
const GraphStation = z.looseObject({
  id: GraphStationRef,
  river_id: z.string().max(60),
  reach_id: GraphReachId.nullable(),
  km_graph: z.number().nullable(),
  /** P11c (the Hovmöller x axis): + upstream of the NL entry node, 0 at it, − below it (A§6); a bad value is unknown. */
  km_to_nl_entry: z.number().nullable().optional().catch(undefined),
});
const GraphReach = z.looseObject({
  id: GraphReachId,
  river_id: z.string().max(60),
  up_station_id: GraphStationRef.nullable(),
  down_station_id: GraphStationRef.nullable(),
  upstream: z.array(GraphReachId).max(20),
  downstream: z.array(GraphReachId).max(20),
  // P11a (the upstream chain): a bad value is null, never a dropped row (the neighbours walk needs none of them).
  length_km: z.number().nonnegative().nullable().catch(null),
  km_graph_from: z.number().nullable().catch(null),
  km_graph_to: z.number().nullable().catch(null),
  flags: z.looseObject({ tidal: z.boolean(), impounded: z.boolean(), bifurcation: z.boolean() }).nullable().catch(null),
  /** The owner variant only: the public reach this part was cut from (D-C). */
  part_of: GraphReachId.optional().catch(undefined),
});
export const ReachGraphFile = z.looseObject({
  stations: lenient(GraphStation, 10_000).catch([]),
  reaches: lenient(GraphReach, 50_000).catch([]),
});
export type ReachGraph = z.infer<typeof ReachGraphFile>;

export const PUBLIC_CONTRACTS: Contracts = {
  audience: 'public',
  StaticMeta,
  StaticStations,
  LatestFile,
  SnapshotFile,
  StaticForecastLatest,
  StationRecent,
  WarningsFile,
  Sources: StaticSources,
  StatusMode: PublicStatusMode,
  StatusPage: PublicStatusPage,
  ReachTravel,
  MetaAnswer,
  StationsAnswer,
  SnapshotAnswer,
  SeriesAnswer,
  SeriesForecastAnswer,
  FramesFile: FramesFileAny,
  FramesAnswer,
  hidden: () => false,
};

/** The owner record's status reader, built here so both narrow schemas sit side by side. */
export const OwnerStatusMode = z
  .looseObject({ classification: z.looseObject({ owner: Mode.nullable() }) })
  .transform((s): StatusMode => s.classification.owner?.mode ?? null);
