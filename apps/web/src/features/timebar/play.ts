import { STEP_MS } from '../../lib/time/time.ts';

// Stepping and playing the timebar (P10d): every move is one 10-minute UTC step, so the repeated hour of the DST
// night is walked in order in both directions. Reverse play stops at the first day, forward play at `end` (now, or the
// end of the station's forecast, at most now + 48 h).

export type Direction = -1 | 1;

/** The next instant of a running play, or null when the next step would leave [start, end]: stop. */
export function playNext(t: number, dir: Direction, start: number, end: number): number | null {
  const next = t + dir * STEP_MS;
  return next < start || next > end ? null : next;
}
