import type { SeriesTide, SnapshotTide, TideExtreme } from '@rws/contracts';

// The surge (P18a, D-1): measured − astronomical tide at the measured value's own instant, never interpolated, never
// stored. The rows are one series' `tide` rows (the caller groups them by series_id, so astro and measured share the
// series, hence the datum: D-5); the SQL picks which rows a snapshot or a span may use, this only subtracts.

/** How far before (and, for the astronomical tide, after) t a high or low water is shown (D-4). */
export const EXTREME_WINDOW_MS = 15 * 3_600_000;

/** One stored `tide` row of a series (ts in epoch ms, value in cm as stored). */
export type TideRow = {
  kind: 'astro' | 'extreme' | 'extreme_astro';
  hilo: 'high' | 'low' | null;
  ts: number;
  value: number;
};

const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (x: number) => Math.round(x * 10) / 10;
const byTs = <T extends { ts: number }>(a: T, b: T) => a.ts - b.ts;

/** The high and low waters of the rows, by ts: store `extreme` is `measured`, `extreme_astro` is `astro`. */
function extremes(rows: readonly TideRow[]): TideExtreme[] {
  return rows
    .filter((r) => r.kind !== 'astro' && r.hilo !== null)
    .sort(byTs)
    .map((r) => ({
      ts: iso(r.ts),
      value: r.value,
      hilo: r.hilo as 'high' | 'low',
      kind: r.kind === 'extreme' ? ('measured' as const) : ('astro' as const),
    }));
}

/** The astronomical value at exactly `ts`, else undefined. */
const astroAt = (rows: readonly TideRow[], ts: number) => rows.find((r) => r.kind === 'astro' && r.ts === ts)?.value;

/** A snapshot value's tide: astro at the measured ts exactly (else null), its surge, the high/low waters; undefined without rows. */
export function tideAt(measured: { ts: number; value: number }, rows: readonly TideRow[]): SnapshotTide | undefined {
  if (rows.length === 0) return undefined;
  const astro = astroAt(rows, measured.ts) ?? null;
  return {
    astro,
    surge: astro === null ? null : round1(measured.value - astro),
    derived: 'surge',
    extremes: extremes(rows),
  };
}

/** A raw series' tide: the astronomical curve, the surge at each measured point with an astro row at its ts, the high/low waters. */
export function seriesTide(
  points: readonly { ts: number; value: number }[],
  rows: readonly TideRow[],
): SeriesTide | undefined {
  if (rows.length === 0) return undefined;
  const astro = rows.filter((r) => r.kind === 'astro').sort(byTs);
  const at = new Map(astro.map((r) => [r.ts, r.value]));
  return {
    astro: astro.map((r) => ({ ts: iso(r.ts), value: r.value })),
    surge: points.flatMap((p) => {
      const a = at.get(p.ts);
      return a === undefined ? [] : [{ ts: iso(p.ts), value: round1(p.value - a) }];
    }),
    derived: 'surge',
    extremes: extremes(rows),
  };
}
