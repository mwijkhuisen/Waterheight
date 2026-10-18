import { planChunks, probeYears } from './plan.ts';
import type { DryRun, Provider } from './provider.ts';
import type { Unit } from './spec.ts';

// The dry-run projection (P14a): what a plan would fetch and store, from the registry alone (no DB, no network).
// The constants come from the real NL-1 fixtures (a test pins them within ±25 %); the DB figure is a heap row plus
// its primary-key entry, which the integration test measures with pg_total_relation_size. All of it is an upper
// bound or a rough guess: the owner sizes `--from` with it, nothing enforces it. P14b: a provider brings its own
// constants (`dryRun`, pinned against its own fixtures); NL-1's are the default.

/** JSON bytes of one `Meting` in a response (fixtures: 287). */
export const BYTES_PER_VALUE = 290;
/** zstd level 9 on a response's value lists (fixtures: 19; a long chunk compresses a little worse than a short one). */
export const ZSTD_RATIO = 15;
/** `obs` heap row plus primary-key entry. */
export const DB_BYTES_PER_ROW = 90;
/** The NL-1 constants, the default of a provider without `dryRun`. */
export const NL1_DRY_RUN: DryRun = {
  bytes_per_value: BYTES_PER_VALUE,
  zstd_ratio: ZSTD_RATIO,
  db_bytes_per_row: DB_BYTES_PER_ROW,
};

export type Projection = {
  series: string;
  chunks: number;
  /** Chunks plus the probe's upper bound (one per calendar year); one per unit for a `reuse` provider (one file). */
  requests: number;
  /** Duration / native step: an upper bound (older data is coarser). */
  values: number;
  bytes: number;
  db_bytes: number;
  archive_bytes: number;
};

/**
 * One job's projection. Without a provider (P14a's form) the NL-1 constants and a yearly probe. A unit's own `values`
 * counts its whole `range` (DE-8: the gauges of a decade file), so a job over part of it gets that share.
 */
export function project(
  unit: Unit,
  from: Date,
  to: Date,
  chunkMs: number,
  provider?: Pick<Provider, 'checkRequest' | 'reuse' | 'dryRun'>,
): Projection {
  const c = provider?.dryRun ?? NL1_DRY_RUN;
  const chunks = planChunks(from, to, chunkMs).length;
  const span = to.getTime() - from.getTime();
  const whole = unit.range === undefined ? span : unit.range.to.getTime() - unit.range.from.getTime();
  const k = unit.per_step ?? { values: 1, rows: 1 };
  const values =
    unit.values === undefined
      ? Math.ceil((span / unit.step_ms) * k.values)
      : Math.ceil((unit.values * span) / Math.max(1, whole));
  const rows = unit.values === undefined ? Math.ceil((span / unit.step_ms) * k.rows) : values;
  const probe = provider === undefined || provider.checkRequest !== undefined;
  const bytes = values * c.bytes_per_value;
  return {
    series: unit.series_key,
    chunks,
    requests: provider?.reuse === true ? 1 : chunks + (probe ? probeYears(from, to) : 0),
    values,
    bytes,
    db_bytes: rows * c.db_bytes_per_row,
    archive_bytes: Math.ceil(bytes / c.zstd_ratio),
  };
}

export type Totals = Omit<Projection, 'series'> & { series: number; hours_at_pace: number };

export function totals(rows: readonly Projection[], minIntervalMs: number): Totals {
  const sum = (k: 'chunks' | 'requests' | 'values' | 'bytes' | 'db_bytes' | 'archive_bytes') =>
    rows.reduce((a, r) => a + r[k], 0);
  const requests = sum('requests');
  return {
    series: rows.length,
    chunks: sum('chunks'),
    requests,
    values: sum('values'),
    bytes: sum('bytes'),
    db_bytes: sum('db_bytes'),
    archive_bytes: sum('archive_bytes'),
    hours_at_pace: Math.round(((requests * minIntervalMs) / 3_600_000) * 10) / 10,
  };
}
