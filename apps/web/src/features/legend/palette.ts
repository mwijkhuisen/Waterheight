import type { State } from '@rws/contracts';

// The map's colours (A§10, P10a T2), pure so the legend, the map, the table and the tests share one table. Every
// palette is colour-blind safe (ColorBrewer BrBG and PuOr, no red–green pair) and never the only cue: the table,
// popup and panel say the same in words, and size and icons repeat it on the map.

/** The common ladder (ADR-0009), low to high: the index is the marker's `level` feature-state. */
export const LADDER: readonly State[] = ['no_ref', 'low', 'normal', 'elevated', 'high', 'extreme'];
export const levelOf = (state: State): number => LADDER.indexOf(state);

/** State palette (BrBG): brown for low, near-white with a dark ring for normal, teal deepening to extreme. */
export const STATE_COLOUR: Readonly<Record<State, string>> = {
  no_ref: '#bdbdbd',
  low: '#a6611a',
  normal: '#f5f5f5',
  elevated: '#80cdc1',
  high: '#018571',
  extreme: '#003c30',
};
/** The marker grows with the level: low and normal small, extreme largest; no_ref is a hollow grey ring. */
export const STATE_RADIUS: Readonly<Record<State, number>> = {
  no_ref: 5,
  low: 5,
  normal: 5,
  elevated: 6.5,
  high: 8,
  extreme: 9.5,
};

/**
 * The 24-hour change in 7 bins, falling to rising: < −50, −50…−10, −10…−2, steady (core's dead band), 2…10,
 * 10…50, > 50 cm. A bin is −3…3; `null` is no change known (hollow).
 */
export type DhBin = -3 | -2 | -1 | 0 | 1 | 2 | 3;
export const DH_EDGES_CM = [10, 50] as const;
/** PuOr, 7 classes: orange falls, purple rises, near-white is steady. */
export const DH_COLOUR: Readonly<Record<DhBin, string>> = {
  [-3]: '#b35806',
  [-2]: '#f1a340',
  [-1]: '#fee0b6',
  0: '#f7f7f7',
  1: '#d8daeb',
  2: '#998ec3',
  3: '#542788',
};

/**
 * The bin of a change. `trend` is core's (deltaH, with its dead band), so steady wins inside the band whatever the
 * size; a discharge (m³/s) has no cm edges and takes ±1 by its trend.
 */
export function dhBin(change: { dh: number; trend: 'rising' | 'falling' | 'steady' }, quantity: 'H' | 'Q'): DhBin {
  if (change.trend === 'steady') return 0;
  const sign = change.trend === 'rising' ? 1 : -1;
  if (quantity === 'Q') return sign as DhBin;
  const size = Math.abs(change.dh);
  return (sign * (size > DH_EDGES_CM[1] ? 3 : size > DH_EDGES_CM[0] ? 2 : 1)) as DhBin;
}

/** Discharge as size (log10 classes of m³/s): 1 below 10, 2 below 100, 3 below 1000, 4 from 1000; 0 for ≤ 0. */
export type QSize = 0 | 1 | 2 | 3 | 4;
export const Q_EDGES = [10, 100, 1000] as const;
export function qSize(q: number): QSize {
  if (!(q > 0)) return 0;
  return (1 + Q_EDGES.filter((e) => q >= e).length) as QSize;
}
export const Q_RADIUS: Readonly<Record<QSize, number>> = { 0: 4, 1: 4.5, 2: 6, 3: 8, 4: 10 };
/** One hue for discharge (BrBG teal), so size carries the amount. */
export const Q_COLOUR = '#35978f';

/**
 * The LHP class colours (DE-6, catalogue §5.4 item 7), keyed by the LHP class code; `#7b7b7b` is "no data". The
 * generated label table (registry/labels/DE-6.yaml `color`) is the source; this copy is pinned to it by a test.
 */
export const LHP_NO_DATA = '#7b7b7b';

/** KG-233: a station with no value at t whose newest value is past its staleness limit is a small grey dot. */
export const LAPSED_COLOUR = '#969696';
export const LAPSED_RADIUS = 3.5;

/** P11b reach lines: "no data" (dashed), "impounded" (solid, neutral) and the tidal hatch's two stripe colours. */
export const REACH_NODATA_COLOUR = '#8c8c8c';
export const REACH_IMPOUNDED_COLOUR = '#9aa5ad';
export const REACH_HATCH_COLOURS = ['rgb(60 80 100)', 'rgb(226 234 240)'] as const;

/** P11b: the casing under a coloured reach, as the dark ring of a normal marker: steady and normal are near-white. */
export const REACH_CASING_COLOUR = '#5f5f5f';
