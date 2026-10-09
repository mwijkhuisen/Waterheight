import type { State } from '@rws/contracts';
import {
  DH_COLOUR,
  type DhBin,
  LADDER,
  Q_COLOUR,
  Q_EDGES,
  Q_RADIUS,
  type QSize,
  STATE_COLOUR,
  STATE_RADIUS,
} from './palette.ts';

// The legend's item lists (P10a T2), pure: the component maps each key to its message.

/** The six states: the ladder order low to high, `no_ref` last. */
export const stateItems = (): { state: State; colour: string; radius: number }[] =>
  [...LADDER.slice(1), LADDER[0] as State].map((state) => ({
    state,
    colour: STATE_COLOUR[state],
    radius: STATE_RADIUS[state],
  }));

/** The seven change bins, falling to rising; the glyph repeats the direction in text. */
export const DH_BINS: readonly DhBin[] = [-3, -2, -1, 0, 1, 2, 3];
export const dhGlyph = (bin: number | 'rising' | 'falling' | 'steady'): '▲' | '▼' | '' => {
  if (bin === 'rising') return '▲';
  if (bin === 'falling') return '▼';
  if (typeof bin === 'number') return bin > 0 ? '▲' : bin < 0 ? '▼' : '';
  return '';
};
export const dhItems = (): { bin: DhBin; colour: string; glyph: '▲' | '▼' | '' }[] =>
  DH_BINS.map((bin) => ({ bin, colour: DH_COLOUR[bin], glyph: dhGlyph(bin) }));

export type QItem = {
  size: QSize;
  radius: number;
  colour: string;
  kind: 'lt' | 'range' | 'ge';
  lo: number;
  hi: number;
};
/** The discharge size classes 1 to 4 with their edges (0 is "no discharge", its own key). */
export const qItems = (): QItem[] =>
  ([1, 2, 3, 4] as const).map((size) => ({
    size,
    radius: Q_RADIUS[size],
    colour: Q_COLOUR,
    kind: size === 1 ? 'lt' : size === 4 ? 'ge' : 'range',
    lo: Q_EDGES[size - 2] ?? 0,
    hi: Q_EDGES[size - 1] ?? 0,
  }));

/** The LHP alert classes the legend shows (class 2 is hatched); "3" does not exist. */
export const LHP_ALERT_CODES = ['1', '2', '4', '5', '6'] as const;

/** P11b: the keys of the reach lines (shown with `LegendProps.reaches`); the component maps each to its message. */
export const reachItems = (): readonly ('nodata' | 'tidal' | 'impounded')[] => ['nodata', 'tidal', 'impounded'];
