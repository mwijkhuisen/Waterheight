import { ceilHour, DAY_MS, floorHour, HOUR_MS } from '../../../lib/time/time.ts';

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
  /** The clock started or stopped holding for data (once per change, not per retry). */
  onWait?: (waiting: boolean) => void;
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

export function createEngine(o: EngineOptions): Engine {
  let timer: unknown;
  let running = false;
  let t = 0;
  let dir: Direction = 1;
  let speed: Speed = 'normal';
  let waiting = false;
  const wait = (w: boolean) => {
    if (w !== waiting) {
      waiting = w;
      o.onWait?.(w);
    }
  };
  const stop = () => {
    if (timer !== undefined) o.host.clearTimeout(timer);
    timer = undefined;
    running = false;
    wait(false);
  };
  const inRange = (h: number) => h >= o.range.start && h <= o.range.end;
  // The speed is read when the timer is set, so a change applies from the next tick.
  const schedule = () => {
    timer = o.host.setTimeout(tick, 1000 / HPS[speed]);
  };
  function tick() {
    timer = undefined;
    const next = t + dir * HOUR_MS;
    if (!inRange(next)) {
      stop();
      o.onStop();
      return;
    }
    // Never skip an hour: hold on this one and ask again at the next tick.
    if (!o.ready(next)) {
      wait(true);
      schedule();
      return;
    }
    wait(false);
    t = next;
    o.onTick(t);
    if (inRange(t + dir * HOUR_MS)) schedule();
    else {
      stop();
      o.onStop();
    }
  }
  return {
    play(from, d, s) {
      stop();
      t = from;
      dir = d;
      speed = s;
      running = true;
      schedule();
    },
    setSpeed(s) {
      speed = s;
    },
    pause: stop,
    dispose: stop,
    get playing() {
      return running;
    },
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
