import type { ApiStation, Snapshot } from '@rws/contracts';
import type { Change } from '../../../lib/data/change.ts';
import type { Mode } from '../../../lib/url/url.ts';
import type { FeatureSpan } from './spans.ts';

// The colour of one reach (P11b, issue #26): the map mode's value interpolated along its span between the two end
// stations, at the reach's midpoint. Tidal reaches are hatched and never interpolated, a span with a tidal reach is
// not interpolated either; an impounded reach in the Δh mode is neutral ("gestuwd"), never a stage change; a gap
// (a span longer than GAP_KM), an open span, a missing or stale end is "no data". Never one-ended. Pure.

type Value = Snapshot['values'][number];

/** The feature-state of one reach: `k` picks the layer, `c` the colour, `w` the width multiplier. */
export type ReachPaint =
  | { k: 'v'; colour: string; width: number }
  | { k: 'nodata' }
  | { k: 'tidal' }
  | { k: 'impounded' };

/** One end of a span in one mode: the mode's number (Δh in cm, the ladder level, Q in m³/s) and its age. */
export interface EndValue {
  v: number;
  ageS: number;
  /** The series' stalenessLimitSeconds: an older end is no end. */
  limitS: number;
}

/** The ends of a span in `mode`: per end group, the first station with a series of the mode's quantity and a value. */
export function endValues(
  _fs: FeatureSpan,
  _mode: Mode,
  _values: ReadonlyMap<number, Value>,
  _changes: ReadonlyMap<number, Change> | undefined,
  _stations: ReadonlyMap<string, ApiStation>,
): [EndValue | undefined, EndValue | undefined] {
  // L0 stub (W2 builds it).
  return [undefined, undefined];
}

/** The paint of one reach from its span and its two ends (see the rules above). */
export function reachColour(
  _fs: FeatureSpan,
  _ends: readonly [EndValue | undefined, EndValue | undefined],
  _mode: Mode,
): ReachPaint {
  // L0 stub (W2 builds it).
  return { k: 'nodata' };
}

/** Every reach's paint at once (the input of reachLayer's writer). */
export function reachPaints(
  spans: ReadonlyMap<string, FeatureSpan>,
  mode: Mode,
  values: ReadonlyMap<number, Value>,
  changes: ReadonlyMap<number, Change> | undefined,
  stations: ReadonlyMap<string, ApiStation>,
): Map<string, ReachPaint> {
  const out = new Map<string, ReachPaint>();
  for (const [id, fs] of spans) out.set(id, reachColour(fs, endValues(fs, mode, values, changes, stations), mode));
  return out;
}
