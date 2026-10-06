import {
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
  MetaAnswer: Parser<z.infer<typeof MetaAnswer>>;
  StationsAnswer: Parser<z.infer<typeof StationsAnswer>>;
  SnapshotAnswer: Parser<z.infer<typeof SnapshotAnswer>>;
  SeriesAnswer: Parser<z.infer<typeof SeriesAnswer>>;
  SeriesForecastAnswer: Parser<z.infer<typeof SeriesForecastAnswer>>;
  /** The publisher writes a dated warnings file per ended UTC day for this family (the owner's has none). */
  datedWarnings: boolean;
  /** A source no view shows (the owner canary): its stations, series, runs, areas and credits are dropped on read. */
  hidden(source: string): boolean;
}

const Mode = z.looseObject({ mode: z.enum(['state', 'dh']) });
/** status.json is the publisher's operations file: only the one field the page needs is read, the rest is ignored. */
const PublicStatusMode = z
  .looseObject({ classification: Mode.nullable() })
  .transform((s): StatusMode => s.classification?.mode ?? null);

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
  MetaAnswer,
  StationsAnswer,
  SnapshotAnswer,
  SeriesAnswer,
  SeriesForecastAnswer,
  datedWarnings: true,
  hidden: () => false,
};

/** The owner record's status reader, built here so both narrow schemas sit side by side. */
export const OwnerStatusMode = z
  .looseObject({ classification: z.looseObject({ owner: Mode.nullable() }) })
  .transform((s): StatusMode => s.classification.owner?.mode ?? null);
