import { planChunks, probeYears } from './plan.ts';
import type { Series } from './spec.ts';

// The dry-run projection (P14a): what a plan would fetch and store, from the registry alone (no DB, no network).
// The constants come from the real NL-1 fixtures (a test pins them within ±25 %); the DB figure is a heap row plus
// its primary-key entry, which the integration test measures with pg_total_relation_size. All of it is an upper
// bound or a rough guess: the owner sizes `--from` with it, nothing enforces it.

/** JSON bytes of one `Meting` in a response (fixtures: 287). */
export const BYTES_PER_VALUE = 290;
/** zstd level 9 on a response's value lists (fixtures: 19; a long chunk compresses a little worse than a short one). */
export const ZSTD_RATIO = 15;
/** `obs` heap row plus primary-key entry. */
export const DB_BYTES_PER_ROW = 90;

export type Projection = {
  series: string;
  chunks: number;
  /** Chunks plus the probe's upper bound (one per calendar year). */
  requests: number;
  /** Duration / native step: an upper bound (older data is coarser). */
  values: number;
  bytes: number;
  db_bytes: number;
  archive_bytes: number;
};

export function project(series: Series, from: Date, to: Date, chunkMs: number): Projection {
  const chunks = planChunks(from, to, chunkMs).length;
  const values = Math.ceil((to.getTime() - from.getTime()) / series.step_ms);
  const bytes = values * BYTES_PER_VALUE;
  return {
    series: series.series_key,
    chunks,
    requests: chunks + probeYears(from, to),
    values,
    bytes,
    db_bytes: values * DB_BYTES_PER_ROW,
    archive_bytes: Math.ceil(bytes / ZSTD_RATIO),
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
