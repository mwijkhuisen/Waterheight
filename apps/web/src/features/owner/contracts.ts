import { apiContracts, attributionEntry, Series } from '@rws/contracts';
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
import { type Contracts, OwnerStatusMode } from '../../lib/data/contracts.ts';

// The owner site's schemas (P10a, plan C1): a lazy chunk, imported only when /runtime-config.json says "owner", so
// the owner family's source-id spelling never reaches the public initial bundle (apps/web/test/build.test.ts). The
// owner API answers are built here from `apiContracts` as packages/contracts/src/api-owner.ts builds them; that
// module itself is not imported, because it pulls the health documents (and their `owner_sources` key) along.

const API = apiContracts(OwnerSourceId);
const audience = { audience: z.literal('owner') };
const attribution = z.array(attributionEntry(OwnerSourceId)).max(500);

/** The owner canary (A§9.3) proves the owner channel end to end; no view of the page ever shows it. */
const CANARY = /^CANARY-/;

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
  MetaAnswer: API.MetaAnswer.extend(audience),
  StationsAnswer: API.StationsAnswer.extend(audience),
  SnapshotAnswer: API.SnapshotAnswer.extend(audience),
  SeriesAnswer: z.discriminatedUnion('res', [
    (Series.options[0] as (typeof Series.options)[0]).extend({ ...audience, attribution }),
    (Series.options[1] as (typeof Series.options)[1]).extend({ ...audience, attribution }),
  ]),
  SeriesForecastAnswer: API.SeriesForecastAnswer.extend(audience),
  datedWarnings: false,
  hidden: (source) => CANARY.test(source),
};
