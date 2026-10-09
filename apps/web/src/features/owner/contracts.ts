import { apiContracts, attributionEntry, checkFrames, Series } from '@rws/contracts';
import {
  OwnerLatestFile,
  OwnerSnapshotFile,
  OwnerSourceId,
  OwnerStaticForecastLatest,
  OwnerStaticMeta,
  OwnerStaticSources,
  OwnerStaticStations,
  OwnerStationRecent,
  OwnerWarningsFile,
} from '@rws/contracts/static-owner';
import { z } from 'zod';
import {
  ClassPair,
  type Contracts,
  ForecastPair,
  OwnerStatusMode,
  ReachTravel,
  type StatusPageData,
  statusFields,
} from '../../lib/data/contracts.ts';

// The owner site's schemas (P10a, plan C1): a lazy chunk, imported only when /runtime-config.json says "owner", so
// the owner family's source-id spelling never reaches the public initial bundle (apps/web/test/build.test.ts). The
// owner API answers are built here from `apiContracts` as packages/contracts/src/api-owner.ts builds them; that
// module itself is not imported, because it pulls the health documents (and their `owner_sources` key) along.

const API = apiContracts(OwnerSourceId);
const audience = { audience: z.literal('owner') };
const attribution = z.array(attributionEntry(OwnerSourceId)).max(500);

/** The owner canary (A§9.3) proves the owner channel end to end; no view of the page ever shows it. */
const CANARY = /^CANARY-/;

/**
 * The owner's status.json (P10b): the owner family's sources (the canary's row does not parse and is dropped), and
 * `{public, owner}` pairs for the coverage; it has no count of owner sources, because it lists them.
 */
const OwnerStatusPage = z
  .looseObject({
    ...statusFields,
    classification: ClassPair,
    forecastCoverage: ForecastPair,
  })
  .transform(
    (s): StatusPageData => ({
      generatedAt: s.generatedAt,
      sources: s.sources,
      twins: s.twins,
      ownerLine: null,
      classification: s.classification,
      forecastCoverage: s.forecastCoverage,
    }),
  );

export const OWNER_CONTRACTS: Contracts = {
  audience: 'owner',
  StaticMeta: OwnerStaticMeta,
  StaticStations: OwnerStaticStations,
  LatestFile: OwnerLatestFile,
  SnapshotFile: OwnerSnapshotFile,
  StaticForecastLatest: OwnerStaticForecastLatest,
  StationRecent: OwnerStationRecent,
  WarningsFile: OwnerWarningsFile,
  Sources: OwnerStaticSources,
  StatusMode: OwnerStatusMode,
  StatusPage: OwnerStatusPage,
  ReachTravel,
  MetaAnswer: API.MetaAnswer.extend(audience),
  StationsAnswer: API.StationsAnswer.extend(audience),
  SnapshotAnswer: API.SnapshotAnswer.extend(audience),
  SeriesAnswer: z.discriminatedUnion('res', [
    (Series.options[0] as (typeof Series.options)[0]).extend({ ...audience, attribution }),
    (Series.options[1] as (typeof Series.options)[1]).extend({ ...audience, attribution }),
  ]),
  SeriesForecastAnswer: API.SeriesForecastAnswer.extend(audience),
  // P11b: publish-owner writes no frames (the owner host reads /api/v1/frames only), so no static file parses.
  FramesFile: z.never(),
  FramesAnswer: API.Frames.extend(audience).superRefine(checkFrames),
  datedWarnings: false,
  hidden: (source) => CANARY.test(source),
};
