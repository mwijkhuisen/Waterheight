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

/** P7a: the meaning of a reference value (A§6): an agency's threshold, a statistic, a past event, or a class bound. */
export const SEMANTICS = ['operational', 'statistical', 'historical', 'provider_class'] as const;

/**
 * P7a: one reference value of a series (a threshold, a statistic or a historical level), in the canonical unit of
 * the series' quantity (H cm, Q m³/s). Its source is the publishing spec's source; `target` names the source whose
 * registry `series` belongs to when it is another one (CH-2 → CH-1, LU-4 → LU-1 and LU-2, FR-5 → FR-1).
 */
export const ReferenceRow = z.strictObject({
  series: z.string().min(1).max(120),
  target: z.string().min(1).max(20).optional(),
  kind: z.string().regex(/^[A-Z0-9_]{1,40}$/),
  value: z.number().finite(),
  unit: z.enum(['cm', 'm³/s']),
  semantics: z.enum(SEMANTICS),
  convention: z.enum(['exceedance', 'non_exceedance']).nullable(),
  /** The statistical reference period as UTC days `[from, to]`, both inclusive; null for none. */
  period: z.tuple([z.iso.date(), z.iso.date().nullable()]).nullable(),
  season_from_md: z.number().int().min(101).max(1231),
  season_to_md: z.number().int().min(101).max(1231),
  priority: z.number().int(),
  /** Provider text (a label, an occurrence date) kept as published; data, never markup. */
  basis_label: z.string().max(500).nullable(),
  /** The provider's start of validity, when it states one (an instant); the loader opens ranges from it. */
  valid_from: Instant.nullable(),
});
export type ReferenceRow = z.infer<typeof ReferenceRow>;

/**
 * P7a: one provider class of a station at an instant (LHP station class, BAFU danger level, SPW NIVCRU), stored
 * on change. `station` is our station id; `code` the provider's class code (with provenance where a rule picked
 * among several, e.g. `RP:0`); `label` the provider's text as published; `level` the common scale (A§6 level_norm:
 * 1 low … 5 extreme, null no_ref) from packages/core crosswalk.ts.
 */
export const ClassRow = z.strictObject({
  station: z.string().min(1).max(120),
  ts: Instant,
  code: z.string().min(1).max(40),
  label: z.string().max(500).nullable(),
  level: z.number().int().min(1).max(5).nullable(),
});
export type ClassRow = z.infer<typeof ClassRow>;

/**
 * P7a: one warning or area class (an LHP alert, a Vigicrues section, a BAFU warning section, an LU-Alert zone).
 * `valid_from`/`valid_to` come from the provider where it states them (CH-5, CAP), else from the payload's time.
 */
export const WarningRow = z.strictObject({
  area_key: z.string().min(1).max(120),
  name: z.string().max(500).nullable(),
  /** GeoJSON geometry, serialised; bounded by the adapter's caps. */
  geometry: z
    .string()
    .max(4 * 1024 * 1024)
    .nullable(),
  level: z.number().int().min(1).max(5).nullable(),
  level_raw: z.string().max(40).nullable(),
  label_raw: z.string().max(500).nullable(),
  /** Message texts per language (CAP: headline and description of each `<info>` block). */
  texts: z.record(z.string().max(10), z.record(z.string().max(20), z.string().max(8000))).optional(),
  valid_from: Instant,
  valid_to: Instant.nullable(),
  issued_at: Instant.nullable(),
  /** The provider's message identifier (CAP `identifier`), for Update and Cancel. */
  ref: z.string().max(200).optional(),
});
export type WarningRow = z.infer<typeof WarningRow>;

/**
 * P7a: how a payload's warnings relate to what is stored. `snapshot`: the payload states every area of its source
 * at `at` (DE-6 alerts, FR-5 sections, CH-5 sections), so an area it no longer lists is closed. `message`: each
 * payload is one message (CAP): a later message for an area caps the earlier one, `cancels` close referenced ones.
 */
export type Warnings =
  | { mode: 'snapshot'; at: string; rows: WarningRow[] }
  | { mode: 'message'; sent: string; rows: WarningRow[]; cancels: string[] };

/** How a series is declared in the registry: the only source of unit, factor and steps. */
export type SeriesDecl = {
  /** P7a: its station's id (class rows are stored per station). */
  station?: string;
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
  /** P7a: reference values; `refScope` names the series whose references the payload states in full, so a
   * stored key of those series that the payload no longer states is closed. */
  references?: ReferenceRow[];
  refScope?: { target?: string; series: string }[];
  /** P7a: provider classes of stations, stored on change. */
  classes?: ClassRow[];
  /** P7a: warnings or area classes. */
  warnings?: Warnings;
};

/** The observation rows of a Normalised, as one or more arrays (`obsChunks` when the payload set it). */
export const obsParts = (n: Normalised): Iterable<ObsRow[]> => n.obsChunks?.() ?? [n.obs];

export const emptyNormalised = (): Normalised => ({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
