import { z } from 'zod';
import { audienceWithin, type Source, SourceId } from './registry.ts';

// Station registry (registry/stations/*.yaml; A§6 "Station registry";
// catalogue gap item 17): one row per physical gauge and quantity.

export const DATUMS = ['NAP', 'TAW', 'NHN', 'NN', 'IGN69', 'NGF1884', 'LN02', 'NG95', 'DNG', 'LOCAL', 'MSL'] as const;

/** Where the licence gate stands for the station's canonical source. */
export const LICENCE_GATES = ['open', 'owner-only', 'permission-pending', 'withheld'] as const;

const identification = {
  /** Registry format, e.g. 'nl.rws.lobith.bovenrijn.tolkamer', 'ch.bafu.2289'. */
  id: z
    .string()
    .regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/)
    .max(80),
  /** Canonical source (catalogue ID) and the provider's own station code. */
  source: SourceId,
  provider_code: z.string().min(1),
  /** Exactly as the operating agency publishes them. */
  name: z.string().min(1),
  water_name: z.string().min(1).nullable(),
  country: z.enum(['NL', 'DE', 'BE', 'FR', 'LU', 'CH']),
  lon: z.number().min(-180).max(180).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  quantity: z.enum(['H', 'Q']),
  river: z.string().min(1).nullable(),
  km: z.strictObject({ system: z.string().min(1), value: z.number() }).nullable(),
  flags: z.strictObject({ tidal: z.boolean().nullable(), impounded: z.boolean().nullable() }),
  expected_threshold_source: SourceId.nullable(),
  expected_forecast_source: SourceId.nullable(),
  licence_gate: z.enum(LICENCE_GATES),
  first_release: z.boolean(),
};

const GaugeZero = z.strictObject({
  value_m: z.number(),
  datum: z.enum(DATUMS),
  /** null where the source does not publish the validity (P2 fills it from the provider). */
  valid_from: z.iso.date().nullable(),
  valid_to: z.iso.date().nullable(),
});

/** Public (or withheld) stations carry datum and gauge-zero metadata. */
export const PublicStation = z.strictObject({
  ...identification,
  audience: z.enum(['public', 'off']),
  datum: z.enum(DATUMS).nullable(),
  gauge_zero: z.array(GaugeZero),
});

/**
 * Owner-audience stations identify the gauge only (invariant 11): no datum,
 * gauge zero, value, threshold or forecast. The object is strict, so any such
 * key fails validation.
 */
export const OwnerStation = z.strictObject({
  ...identification,
  audience: z.literal('owner'),
});

export const Station = z.discriminatedUnion('audience', [PublicStation, OwnerStation]);
export type Station = z.infer<typeof Station>;

export const StationsFile = z.strictObject({ stations: z.array(Station).min(1) });

/**
 * Cross-file rules: a row's source exists and allows the row's audience, and a
 * row never names a threshold or forecast source narrower than itself (a public
 * row that pointed at an owner source would reveal that owner data exists
 * there; invariant 11). Returns every problem found.
 */
export function validateStations(
  stationsInput: unknown,
  sources: readonly Pick<Source, 'id' | 'audience'>[],
): { problems: string[]; stations: Station[] } {
  const parsed = StationsFile.safeParse(stationsInput);
  if (!parsed.success) return { problems: [z.prettifyError(parsed.error)], stations: [] };
  const byId = new Map(sources.map((s) => [s.id, s]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of parsed.data.stations) {
    const at = `station ${row.id} (${row.quantity})`;
    const key = `${row.id}/${row.quantity}`;
    if (seen.has(key)) problems.push(`${at}: duplicate`);
    seen.add(key);
    const source = byId.get(row.source);
    if (source === undefined) problems.push(`${at}: unknown source ${row.source}`);
    else if (!audienceWithin(row.audience, source.audience)) {
      problems.push(`${at}: audience ${row.audience} widens its source ${row.source} (${source.audience})`);
    }
    for (const field of ['expected_threshold_source', 'expected_forecast_source'] as const) {
      const ref = row[field];
      if (ref === null) continue;
      const target = byId.get(ref);
      if (target === undefined) problems.push(`${at}: ${field} ${ref} is not a registered source`);
      else if (!audienceWithin(row.audience, target.audience)) {
        problems.push(`${at}: a ${row.audience} row may not name the ${target.audience} source ${ref} as ${field}`);
      }
    }
  }
  return { problems, stations: parsed.data.stations };
}
