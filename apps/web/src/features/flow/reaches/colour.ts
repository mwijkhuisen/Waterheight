import type { ApiStation, Snapshot } from '@rws/contracts';
import { TREND_BAND } from '@rws/core/trend';
import type { Change } from '../../../lib/data/change.ts';
import type { ReachTravelData } from '../../../lib/data/contracts.ts';
import type { Mode } from '../../../lib/url/url.ts';
import { DH_COLOUR, dhBin, LADDER, levelOf, Q_COLOUR, type QSize, qSize, STATE_COLOUR } from '../../legend/palette.ts';
import { GAP_KM } from '../chain.ts';
import { segOf } from './bins.ts';
import { shiftAt, spanShift } from './shift.ts';
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

/** The values and the 24-hour changes of one hour. */
export interface HourValues {
  values: ReadonlyMap<number, Value>;
  changes: ReadonlyMap<number, Change> | undefined;
}

/**
 * The travel-time shift (#112 item 3, shift.ts): the sourced travel times, and the values `k` whole hours before t
 * (undefined: not loaded, so a shifted end has none and its bin is "no data").
 */
export interface Shift {
  travel: ReachTravelData | undefined;
  past: (k: number) => HourValues | undefined;
}

/** Line width multiplier per discharge size (1 at size 2, the middle class). */
export const Q_WIDTH: Readonly<Record<QSize, number>> = { 0: 0.6, 1: 0.8, 2: 1, 3: 1.4, 4: 1.9 };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The ends of a span in `mode`: per end group, the first station with a series of the mode's quantity and a value. On a
 * span a sourced travel time names exactly (`shift`, #112), the up end is read `shiftAt(T, pos)` hours before t.
 */
export function endValues(
  fs: FeatureSpan,
  mode: Mode,
  values: ReadonlyMap<number, Value>,
  changes: ReadonlyMap<number, Change> | undefined,
  stations: ReadonlyMap<string, ApiStation>,
  shift?: Shift,
): [EndValue | undefined, EndValue | undefined] {
  if (fs.span === null) return [undefined, undefined];
  const quantity = mode === 'q' ? 'Q' : 'H';
  const end = (group: readonly string[], at: HourValues | undefined): EndValue | undefined => {
    if (at === undefined) return undefined;
    for (const id of group)
      for (const s of stations.get(id)?.series ?? []) {
        if (s.quantity !== quantity) continue;
        const value = at.values.get(s.id);
        if (value === undefined) continue;
        const v = mode === 'delta' ? at.changes?.get(s.id)?.dh : mode === 'q' ? value.value : levelOf(value.state);
        if (v !== undefined) return { v, ageS: value.ageSeconds, limitS: s.stalenessLimitSeconds };
      }
    return undefined;
  };
  const now = { values, changes };
  const t = shift === undefined ? null : spanShift(fs.span, shift.travel);
  const k = t === null ? 0 : shiftAt(t, fs.span.pos);
  return [end(fs.span.up, k === 0 ? now : shift?.past(k)), end(fs.span.down, now)];
}

/** The paint of one reach from its span and its two ends (see the rules above). */
export function reachColour(
  fs: FeatureSpan,
  ends: readonly [EndValue | undefined, EndValue | undefined],
  mode: Mode,
): ReachPaint {
  const span = fs.span;
  if (fs.tidal === true) return { k: 'tidal' };
  if (span === null || span.tidal || span.lengthKm === null || span.pos === null || span.lengthKm > GAP_KM)
    return { k: 'nodata' };
  if (mode === 'delta' && fs.impounded === true) return { k: 'impounded' };
  const [a, b] = ends;
  if (a === undefined || b === undefined || a.ageS >= a.limitS || b.ageS >= b.limitS) return { k: 'nodata' };
  const x = lerp(a.v, b.v, span.pos);
  if (mode === 'delta') {
    const trend = x > TREND_BAND.cm ? 'rising' : x < -TREND_BAND.cm ? 'falling' : 'steady';
    return { k: 'v', colour: DH_COLOUR[dhBin({ dh: x, trend }, 'H')], width: 1 };
  }
  if (mode === 'q') return { k: 'v', colour: Q_COLOUR, width: Q_WIDTH[qSize(x)] };
  if (a.v === 0 || b.v === 0) return { k: 'nodata' };
  const i = Math.min(Math.max(Math.round(x), Math.min(a.v, b.v)), Math.max(a.v, b.v));
  return { k: 'v', colour: STATE_COLOUR[LADDER[i] as (typeof LADDER)[number]], width: 1 };
}

/** Every reach's paint at once (the input of reachLayer's writer). */
export function reachPaints(
  spans: ReadonlyMap<string, FeatureSpan>,
  mode: Mode,
  values: ReadonlyMap<number, Value>,
  changes: ReadonlyMap<number, Change> | undefined,
  stations: ReadonlyMap<string, ApiStation>,
  shift?: Shift,
): Map<string, ReachPaint> {
  const out = new Map<string, ReachPaint>();
  for (const [id, fs] of spans)
    out.set(id, reachColour(fs, endValues(fs, mode, values, changes, stations, shift), mode));
  return out;
}

/**
 * Every position bin's paint (#112): bin i of a reach takes the reach's own rules with its span at the bin's centre
 * (`FeatureSpan.bins`), keyed by its tile id `<reach_id>/<i>`. A long reach between two valued stations so shows the
 * gradient along it.
 */
export function binPaints(
  spans: ReadonlyMap<string, FeatureSpan>,
  mode: Mode,
  values: ReadonlyMap<number, Value>,
  changes: ReadonlyMap<number, Change> | undefined,
  stations: ReadonlyMap<string, ApiStation>,
  shift?: Shift,
): Map<string, ReachPaint> {
  const out = new Map<string, ReachPaint>();
  for (const [id, fs] of spans)
    for (const [i, span] of fs.bins.entries()) {
      const bin = { ...fs, span };
      out.set(segOf(id, i), reachColour(bin, endValues(bin, mode, values, changes, stations, shift), mode));
    }
  return out;
}
