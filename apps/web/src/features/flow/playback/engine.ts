import { ceilHour, DAY_MS, floorHour } from '../../../lib/time/time.ts';

// The playback clock (P11b, issue #26): one UTC hour per tick, forward or in reverse, at `HPS[speed]` hours per
// second (7 days in about 18.7 s, 14 s or 10.5 s). It holds on an hour whose frames have not answered yet, never
// skips one, and stops at the range's ends. Hours are UTC, so the repeated hour of the DST night (2026-10-25 00:00Z
// CEST and 01:00Z CET, both "02:00") is played in order in both directions. One timer, from an injected host. Pure.

export const SPEEDS = ['slow', 'normal', 'fast'] as const;
export type Speed = (typeof SPEEDS)[number];
/** Hours per second. */
export const HPS: Readonly<Record<Speed, number>> = { slow: 9, normal: 12, fast: 16 };
export type Direction = 1 | -1;

/** The browser's timers in the page; a fake in the tests. */
export interface PlaybackHost {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface EngineOptions {
  host: PlaybackHost;
  /** Whole UTC hours; see playRange. */
  range: { start: number; end: number };
  /** The frames of hour `t` have answered (FrameStore.ready): until then the clock holds. */
  ready: (t: number) => boolean;
  /** Each hour played. */
  onTick: (t: number) => void;
  /** Play stopped by itself (a range end). */
  onStop: () => void;
}

export interface Engine {
  /** Plays from the whole hour `from` in `dir`; the first tick moves one hour. */
  play(from: number, dir: Direction, speed: Speed): void;
  setSpeed(speed: Speed): void;
  pause(): void;
  /** Clears the timer for good. */
  dispose(): void;
  readonly playing: boolean;
}

export function createEngine(_o: EngineOptions): Engine {
  // L0 stub (W5 builds it).
  return {
    play: () => undefined,
    setSpeed: () => undefined,
    pause: () => undefined,
    dispose: () => undefined,
    playing: false,
  };
}

/** The hours playback covers: the last 14 days within the display range, up to the last whole hour (never after now). */
export function playRange(displayStart: number, now: number): { start: number; end: number } {
  return { start: ceilHour(Math.max(displayStart, now - 14 * DAY_MS)), end: floorHour(now) };
}

/** Where play starts: at live (no `t`) 7 days back, else the whole hour of `t`, inside the range. */
export function playFrom(t: number | undefined, range: { start: number; end: number }): number {
  const at = t === undefined ? range.end - 7 * DAY_MS : floorHour(t);
  return Math.min(range.end, Math.max(range.start, at));
}
