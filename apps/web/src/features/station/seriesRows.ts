import type { ForecastView, Pt } from './chartModel.ts';

// The rows of the panel's "Tabel" view (P10d): the points the chart draws, as text. Pure.

export interface SeriesRow {
  ts: number;
  measured: number | null;
  forecast: number | null;
  /** The forecast band, when the run has one and both ends are known at ts. */
  band: [number, number] | null;
}

/**
 * The union of the measured and the forecast instants, newest first. The estimate part of a run holds the junction
 * instant too, so a forecast instant is listed once. An empty cell is null.
 */
export function seriesRows(points: readonly Pt[], view: ForecastView | undefined): SeriesRow[] {
  const rows = new Map<number, SeriesRow>();
  const at = (ts: number): SeriesRow => {
    let row = rows.get(ts);
    if (row === undefined) {
      row = { ts, measured: null, forecast: null, band: null };
      rows.set(ts, row);
    }
    return row;
  };
  for (const [ts, v] of points) at(ts).measured = v;
  if (view !== undefined) {
    const lower = new Map(view.lower);
    const spread = new Map(view.spread);
    for (const [ts, v] of [...view.provider, ...view.estimate]) {
      const row = at(ts);
      if (v !== null) row.forecast = v;
      const lo = lower.get(ts);
      const width = spread.get(ts);
      if (view.hasBand && lo != null && width != null) row.band = [lo, lo + width];
    }
  }
  return [...rows.values()].sort((a, b) => b.ts - a.ts);
}
