import { floorHour } from '../../lib/time/time.ts';
import { playFrom } from '../flow/playback/engine.ts';

// Stepping and the play rules of the timebar (P11b): the step buttons move one UTC hour (so the repeated hour of the
// DST night is walked in order in both directions); play runs the frames engine, only in the Δh and Q modes (D-1),
// only inside the playback range, and not with reduced motion. Pure.

export type Direction = -1 | 1;

/** The hour a step button reaches, within [start, end]: off the hour, back goes to the hour's start and forward to the next. */
export function stepHour(t: number, dir: Direction, start: number, end: number): number {
  const hour = floorHour(t);
  const next = dir === -1 ? (hour === t ? t - 3_600_000 : hour) : hour + 3_600_000;
  return Math.min(end, Math.max(start, next));
}

/** Play is `disabled` in the State mode (D-1; a hint says so) and with reduced motion (a note says so). */
export const playDisabled = (mode: 'state' | 'delta' | 'q', reduced: boolean): boolean => reduced || mode === 'state';

/** Play has an hour to take in `dir` from the page's t (undefined at live: seven days back). */
export function canPlay(dir: Direction, t: number | undefined, range: { start: number; end: number }): boolean {
  const from = playFrom(t, range);
  return dir === 1 ? from < range.end : from > range.start;
}
