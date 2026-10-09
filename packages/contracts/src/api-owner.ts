import { z } from 'zod';
import { ApiError, apiContracts, attributionEntry, checkFrames, Series } from './api.ts';
import { HealthUnavailable, healthSources, ownerHealth } from './health.ts';
import { buildOpenApi } from './openapi.ts';
import { OwnerSourceId } from './static-owner.ts';

// Server only (P9b, A§9.3): the answers of the owner API `api-owner`. Each is the public answer over the owner
// source-id schema (the canary's spelling allowed) with `audience: "owner"`, so an owner body can never pass for a
// public one. The web never imports this module (`@rws/contracts/api-owner`, not re-exported from the index).

const OWNER = apiContracts(OwnerSourceId);
const audience = { audience: z.literal('owner') };
const attribution = z.array(attributionEntry(OwnerSourceId)).max(500);

export const OwnerMetaAnswer = OWNER.MetaAnswer.extend(audience);
export const OwnerStationsAnswer = OWNER.StationsAnswer.extend(audience);
export const OwnerSnapshotAnswer = OWNER.SnapshotAnswer.extend(audience);
export const OwnerSeriesForecastAnswer = OWNER.SeriesForecastAnswer.extend(audience);
export const OwnerFramesAnswer = OWNER.Frames.extend(audience).superRefine(checkFrames);
export const OwnerSeriesAnswer = z.discriminatedUnion('res', [
  (Series.options[0] as (typeof Series.options)[0]).extend({ ...audience, attribution }),
  (Series.options[1] as (typeof Series.options)[1]).extend({ ...audience, attribution }),
]);
export const OwnerHealthAnswer = ownerHealth(OwnerSourceId);
export type OwnerHealthAnswer = z.infer<typeof OwnerHealthAnswer>;
export const OwnerHealthSourcesAnswer = healthSources(OwnerSourceId).extend({ ...audience, attribution });
export type OwnerHealthSourcesAnswer = z.infer<typeof OwnerHealthSourcesAnswer>;
// Error bodies are the public ApiError in both APIs (owner decision, 2026-10-05): a fixed code and `attribution: []`.

/** The owner API's OpenAPI document (C15): the public paths over the owner schemas. */
export const ownerOpenApiDocument = (): Record<string, unknown> =>
  buildOpenApi(
    {
      ApiError,
      Meta: OwnerMetaAnswer,
      Stations: OwnerStationsAnswer,
      Snapshot: OwnerSnapshotAnswer,
      Series: OwnerSeriesAnswer,
      SeriesForecast: OwnerSeriesForecastAnswer,
      Frames: OwnerFramesAnswer,
      Health: OwnerHealthAnswer,
      HealthSources: OwnerHealthSourcesAnswer,
      HealthUnavailable,
    },
    'Waterheight owner API',
    ' The owner API (owner view only) serves the paths of the public API with `audience: "owner"` in every body and `Cache-Control: private, no-store`.',
  );
