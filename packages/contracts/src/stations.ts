import { z } from 'zod';
import { audienceWithin, type Source, SourceId } from './registry.ts';
import { DATUMS, DISCHARGE_UNITS, NATIVE_UNITS, TO_CANONICAL } from './units.ts';

// Station registry (registry/stations/*.yaml; A§6 "Station registry";
// catalogue gap item 17): one row per physical gauge and quantity.

/** Where the licence gate stands for the station's canonical source. */
export const LICENCE_GATES = ['open', 'owner-only', 'permission-pending', 'withheld'] as const;

const Duration = z.iso.duration();

const identification = {
  /** Registry format, e.g. 'nl.rws.lobith.bovenrijn.tolkamer', 'ch.bafu.2289'. */
  id: z
    .string()
    .regex(/^[a-z]{2}\.[a-z0-9-]+\.[A-Za-z0-9._-]+$/)
    .max(80),
  /** Canonical source (catalogue ID) and the provider's own station code. */
  source: SourceId,
  provider_code: z.string().min(1),
  /** The series key inside the source, unique per source (DE-1: "<station uuid>/<W|Q>"). */
  provider_key: z.string().min(1).max(120),
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
  /** 1: first-release key gauge; 2: the source's other gauges. */
  tier: z.union([z.literal(1), z.literal(2)]),
  /** primary: the canonical gauge; twin: the same gauge in another source; mirror: a gauge another agency operates. */
  role: z.enum(['primary', 'twin', 'mirror']),
  /** How the provider publishes the series (declarations, not measured values). */
  native_unit: z.enum(NATIVE_UNITS),
  /** Must equal TO_CANONICAL[native_unit] (validateStations). Zod's number is finite. */
  to_canonical: z.number().positive(),
  /** H: 'stage' (relative to a gauge zero) or 'level' (an absolute height); Q: null. */
  value_kind: z.enum(['stage', 'level']).nullable(),
  /** The provider's own step, the step we expect, and how old the newest value may be before the series is stale. */
  native_step: Duration,
  expected_step: Duration,
  staleness_limit: Duration,
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

export type PublicStation = z.infer<typeof PublicStation>;

export const Station = z.discriminatedUnion('audience', [PublicStation, OwnerStation]);
export type Station = z.infer<typeof Station>;

export const StationsFile = z.strictObject({ stations: z.array(Station).min(1) });

/**
 * Cross-file rules: a row's source exists and allows the row's audience, a row
 * never names a threshold or forecast source narrower than itself (a public
 * row that pointed at an owner source would reveal that owner data exists
 * there; invariant 11), and its unit declarations agree (a discharge row has
 * a discharge unit and no value_kind, a level row the reverse, and to_canonical
 * is the factor of its native_unit). A provider_key is unique inside its
 * source, and a first-release row is a tier-1 row. A station has one row per
 * quantity, plus at most one more with role `twin`: the same gauge published
 * a second time (the Eijsden-grens TAW series beside its NAP one). Returns
 * every problem found.
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
  const seenKeys = new Set<string>();
  for (const row of parsed.data.stations) {
    const at = `station ${row.id} (${row.quantity})`;
    const key = `${row.id}/${row.quantity}${row.role === 'twin' ? '/twin' : ''}`;
    if (seen.has(key)) problems.push(`${at}: duplicate`);
    seen.add(key);
    const providerKey = `${row.source}/${row.provider_key}`;
    if (seenKeys.has(providerKey)) problems.push(`${at}: duplicate provider_key ${row.provider_key} in ${row.source}`);
    seenKeys.add(providerKey);
    const discharge = DISCHARGE_UNITS.includes(row.native_unit);
    if (row.quantity === 'Q') {
      if (row.value_kind !== null) problems.push(`${at}: a discharge row has no value_kind (got ${row.value_kind})`);
      if (!discharge) problems.push(`${at}: native_unit ${row.native_unit} is not a discharge unit`);
    } else {
      if (row.value_kind === null) problems.push(`${at}: a water-level row needs value_kind stage or level`);
      if (discharge) problems.push(`${at}: native_unit ${row.native_unit} is a discharge unit`);
    }
    if (row.to_canonical !== TO_CANONICAL[row.native_unit]) {
      problems.push(
        `${at}: to_canonical ${row.to_canonical} is not ${TO_CANONICAL[row.native_unit]} for ${row.native_unit}`,
      );
    }
    if (row.first_release && row.tier !== 1) problems.push(`${at}: first_release needs tier 1 (got tier ${row.tier})`);
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

// Twin pairs (registry/twins.yaml; A§7.4 step 7): two series of the same water
// level or discharge, whose difference the loader checks.

const TwinSide = z.strictObject({ source: SourceId, provider_key: z.string().min(1).max(120) });

export const Twin = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(80),
  a: TwinSide,
  b: TwinSide,
  /** `offset`: on equal timestamps, a − b is `expected` within `tolerance`, in the canonical unit (H cm, Q m³/s). */
  relation: z.strictObject({
    kind: z.literal('offset'),
    expected: z.number(),
    tolerance: z.number().nonnegative(),
    unit: z.enum(['cm', 'm³/s']),
  }),
});
export type Twin = z.infer<typeof Twin>;

export const TwinsFile = z.strictObject({ twins: z.array(Twin).max(100) });

/**
 * A twin names two different registered series of one quantity, with the
 * relation in that quantity's canonical unit. Returns every problem found.
 */
export function validateTwins(
  twinsInput: unknown,
  stations: readonly Station[],
): { problems: string[]; twins: Twin[] } {
  const parsed = TwinsFile.safeParse(twinsInput);
  if (!parsed.success) return { problems: [z.prettifyError(parsed.error)], twins: [] };
  const rowOf = new Map(stations.map((r) => [`${r.source}/${r.provider_key}`, r]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const twin of parsed.data.twins) {
    const at = `twin ${twin.id}`;
    if (seen.has(twin.id)) problems.push(`${at}: duplicate`);
    seen.add(twin.id);
    const a = rowOf.get(`${twin.a.source}/${twin.a.provider_key}`);
    const b = rowOf.get(`${twin.b.source}/${twin.b.provider_key}`);
    if (a === undefined) problems.push(`${at}: a is not a registered series`);
    if (b === undefined) problems.push(`${at}: b is not a registered series`);
    if (a === undefined || b === undefined) continue;
    if (a === b) problems.push(`${at}: a and b are the same series`);
    if (a.quantity !== b.quantity) problems.push(`${at}: a is ${a.quantity} and b is ${b.quantity}`);
    if (twin.relation.unit !== (a.quantity === 'Q' ? 'm³/s' : 'cm')) {
      problems.push(`${at}: the unit of a ${a.quantity} pair is not ${twin.relation.unit}`);
    }
  }
  return { problems, twins: parsed.data.twins };
}
