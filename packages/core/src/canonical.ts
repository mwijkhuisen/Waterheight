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
  /**
   * Gap-fill rows (P5a: the FR-3 and CH-3 seeds), keyed by the provider key of
   * a series of the spec's fill target (`SpecLoader.fill`): stored only where
   * that source states no value, with the backfilled bit, never as a revision.
   */
  fill?: ObsRow[];
  /**
   * P5b: the rows of a payload too large to hold as one array (the DE-7 seed, about two million values), in
   * place of `obs` (which is then empty). Every check and drop has already happened when `normalise` returns:
   * the chunks only materialise rows it decided on, never throw, hold no (series, ts) twice across chunks
   * (each series lies in one chunk) and may be iterated more than once.
   */
  obsChunks?: () => Iterable<ObsRow[]>;
};

/** The observation rows of a Normalised, as one or more arrays (`obsChunks` when the payload set it). */
export const obsParts = (n: Normalised): Iterable<ObsRow[]> => n.obsChunks?.() ?? [n.obs];

export const emptyNormalised = (): Normalised => ({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
