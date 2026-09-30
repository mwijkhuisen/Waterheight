import { DATUMS } from '@rws/contracts';
import { z } from 'zod';
import { QC_MAX } from './qc.ts';

// Canonical rows: what `normalise(records, registry)` returns and the loader
// stores. H is cm, Q is m³/s, time is UTC; the series is named by its registry
// key, because a payload never registers a series.

const Instant = z.iso.datetime();

export const ObsRow = z.strictObject({
  /** The series: its `provider_key` inside the payload's source. */
  series: z.string().min(1).max(120),
  ts: Instant,
  value: z.number(),
  qc: z.number().int().min(0).max(QC_MAX),
});
export type ObsRow = z.infer<typeof ObsRow>;

export const GaugeZeroRow = z.strictObject({
  series: z.string().min(1).max(120),
  value_m: z.number(),
  datum: z.enum(DATUMS),
  /** Start of validity (an instant: the provider's date at local midnight); null when the provider gives none. */
  valid_from: Instant.nullable(),
});
export type GaugeZeroRow = z.infer<typeof GaugeZeroRow>;

/** How a series is declared in the registry: the only source of unit, factor and steps. */
export type SeriesDecl = {
  key: string;
  quantity: 'H' | 'Q';
  native_unit: string;
  to_canonical: number;
  value_kind: 'stage' | 'level' | null;
  native_step_ms: number;
  expected_step_ms: number;
};

export type Registry = ReadonlyMap<string, SeriesDecl>;

export type Normalised = {
  obs: ObsRow[];
  gaugeZeros: GaugeZeroRow[];
  /** Fixed code → number of values dropped for that reason (sentinel, future, unit_mismatch, …). */
  dropped: Record<string, number>;
  /** Series in the payload that the registry does not know (never registered from a payload). */
  unknown: number;
  /**
   * Set only by a payload that states the unit of every series it carries: the
   * keys whose unit differs from the registry's. The loader keeps the newest such
   * list per source and passes it to payloads that carry no unit (`unitMismatch`
   * of the context), so a unit switch never stores mis-scaled values.
   */
  unitMismatch?: string[];
};

export const emptyNormalised = (): Normalised => ({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
