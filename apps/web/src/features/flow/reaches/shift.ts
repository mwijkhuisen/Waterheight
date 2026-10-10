import type { ReachTravelData } from '../../../lib/data/contracts.ts';
import type { FeatureSpan, Span } from './spans.ts';

// The travel-time shift of the reach colouring (#112 item 3, owner decision D-4: exact pairs only). A span is shifted
// only where a sourced travel time names exactly its two ends (its `from` among the span's up stations, its `to`
// among its down stations); a derived figure never counts, and nothing is apportioned by chainage. T is the range's
// midpoint, or the labelled single value, in whole hours (days × 24). At position p on a shifted span the up end is
// read T·p hours earlier (rounded to the hour), the down end at t: indicative, labelled "tijdverschoven, indicatief",
// never an ETA. Pure.

type TravelTime = ReachTravelData['travel_times'][number];

/**
 * The longest shift used (#112 review): the frames reach this much further back, so a garbled travel time in the
 * leniently parsed reaches file can never widen them past four days; a longer one leaves its span unshifted.
 */
export const MAX_SHIFT_H = 96;

/** The shift of one sourced travel time in whole hours, or null for a derived figure or one over MAX_SHIFT_H. */
export function shiftHours(t: Pick<TravelTime, 'h' | 'd' | 'derived'>): number | null {
  if (t.derived === true) return null;
  const v = t.h ?? t.d;
  if (v === undefined) return null;
  const hours = Math.round((Array.isArray(v) ? (v[0] + v[1]) / 2 : v) * (t.h === undefined ? 24 : 1));
  return hours > MAX_SHIFT_H ? null : hours;
}

/** The shift of a span: the first sourced travel time that names exactly its two ends, or null (unshifted). */
export function spanShift(span: Pick<Span, 'up' | 'down'> | null, travel: ReachTravelData | undefined): number | null {
  if (span === null || travel === undefined) return null;
  for (const t of travel.travel_times) {
    if (!span.up.includes(t.from_station_id) || !span.down.includes(t.to_station_id)) continue;
    const h = shiftHours(t);
    if (h !== null && h > 0) return h;
  }
  return null;
}

/** The hours back a shifted span's up end is read at position `pos` (0 at the up end … 1 at the down end). */
export const shiftAt = (shift: number, pos: number | null): number => Math.round(shift * (pos ?? 0.5));

/** The largest shift of any span or bin of `spans`: the extra history the frames must hold (0: none shifted). */
export function maxShift(spans: ReadonlyMap<string, FeatureSpan>, travel: ReachTravelData | undefined): number {
  let max = 0;
  for (const fs of spans.values())
    for (const span of [fs.span, ...fs.bins]) max = Math.max(max, spanShift(span, travel) ?? 0);
  return max;
}
