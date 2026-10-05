import { z } from 'zod';
import { AttributionEntry, DATE_KINDS, HealthSourceId } from './api.ts';
import { OwnerForecastLatest } from './forecast.ts';
import { staticContracts } from './static.ts';

// Server only (P9a): the owner family's static files (A§9.3) and both families' sources.json. The web never imports
// this module (`@rws/contracts/static-owner`, not re-exported from the index), so neither the canary's id spelling
// nor a private basis can reach the public bundle (apps/web/test/build.test.ts). Owner field names are camelCase.

/** The owner files also name the owner canary's source (A§9.3): the one spelling they add. */
export const OwnerSourceId = z.string().regex(/^(?:(?:NL|DE|BE|FR|LU|CH)-[1-9][0-9]?|CANARY-[A-Z]+)$/);

const OWNER = staticContracts(OwnerSourceId, OwnerForecastLatest);
export const OwnerAttributionEntry = OWNER.AttributionEntry;
export const OwnerSnapshotFile = OWNER.SnapshotFile;
export const OwnerLatestFile = OWNER.LatestFile;
export const OwnerStaticMeta = OWNER.StaticMeta;
export const OwnerStaticStations = OWNER.StaticStations;
export const OwnerStationRecent = OWNER.StationRecent;
export const OwnerStaticForecastLatest = OWNER.StaticForecastLatest;
export const OwnerWarningsFile = OWNER.WarningsFile;

const iso = z.iso.datetime();
const HttpsUrl = z
  .string()
  .max(500)
  .regex(/^https:\/\/[^\s]+$/);

/** One source of sources.json: the registry's names and attribution rows verbatim, and the date its licence asks for. */
const sourceEntry = (source: z.ZodString) =>
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

/** The owner's sources.json: every source of the owner family, its audience and an owner source's private basis. */
export const OwnerStaticSources = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: iso,
  sources: z
    .array(
      sourceEntry(OwnerSourceId).extend({
        audience: z.enum(['public', 'owner']),
        /** catalogue §0.8: the clause verbatim, the terms page and the retrieval date; null for a public source. */
        privateBasis: z
          .strictObject({ clause: z.string().min(1).max(4000), url: HttpsUrl, retrieved: z.iso.date() })
          .nullable(),
      }),
    )
    .max(100)
    .superRefine((list, ctx) => {
      for (const s of list)
        if ((s.audience === 'owner') !== (s.privateBasis !== null))
          ctx.addIssue({ code: 'custom', message: `${s.id}: an owner source has a private basis, a public one none` });
    }),
  attribution: z.array(OwnerAttributionEntry).max(500),
});
export type OwnerStaticSources = z.infer<typeof OwnerStaticSources>;
