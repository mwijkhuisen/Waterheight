import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ceilHour, HOUR_MS } from '../../../lib/time/time.ts';
import { createEngine, type Direction, type Engine, playFrom, playRange, type Speed } from './engine.ts';

// The page's playback (P11b, issue #26): the engine in React. App owns it (the data source switches to the frames
// while it plays); the Timebar shows its controls. A hidden tab stops it (as P10d's play did).

export interface Playback {
  playing: boolean;
  dir: Direction;
  speed: Speed;
  /** Whole UTC hours playback covers (engine.ts playRange). */
  range: { start: number; end: number };
  /**
   * The hours the frames must cover while playing, fixed when play starts (24 h before the first hour, for its Δh);
   * undefined while not playing.
   */
  window: { from: number; to: number } | undefined;
  /** Playing but holding for data for longer than WAIT_MS: the Timebar says so (polite, once, not per retry). */
  waiting: boolean;
  play(dir: Direction): void;
  pause(): void;
  setSpeed(speed: Speed): void;
}

export interface PlaybackOptions {
  /** The page's t; undefined at live (play then starts 7 days back). */
  t: number | undefined;
  displayStart: number;
  /** The page's now. */
  now: number;
  /** The URL's `play` (a deep link restores the speed, paused). */
  speed: Speed | undefined;
  /** FrameStore.ready (through a ref: the store follows the window). */
  ready: (t: number) => boolean;
  /** Each hour played: the page's t. */
  onT: (t: number) => void;
  /** Play started or the speed changed: the URL's `play`. */
  onSpeed: (speed: Speed) => void;
  /** Hours of extra history the frames must reach before the lead (#112: the largest travel-time shift); default 0. */
  extraLeadHours?: number;
}

/** A hold shorter than this is not worth a word: frames normally arrive within a tick or two. */
const WAIT_MS = 1500;
/** Hours before the first played hour the frames must reach: the bucket t − 1 h and the Δh hour t − 24 h. */
const LEAD_MS = 25 * HOUR_MS;

const host = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function usePlayback(o: PlaybackOptions): Playback {
  const range = useMemo(() => playRange(o.displayStart, o.now), [o.displayStart, o.now]);
  const [run, setRun] = useState<{ dir: Direction; window: { from: number; to: number } } | undefined>();
  const [speed, setSpeedState] = useState<Speed>(o.speed ?? 'normal');
  const [waiting, setWaiting] = useState(false);
  const engine = useRef<Engine | undefined>(undefined);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Everything the stable callbacks read lives in a ref.
  const cur = useRef({ o, range, speed });
  cur.current = { o, range, speed };

  const clearHold = useCallback(() => {
    if (hold.current !== undefined) clearTimeout(hold.current);
    hold.current = undefined;
    setWaiting(false);
  }, []);
  const pause = useCallback(() => {
    engine.current?.dispose();
    engine.current = undefined;
    clearHold();
    setRun(undefined);
  }, [clearHold]);
  const play = useCallback(
    (dir: Direction) => {
      const { o, range, speed } = cur.current;
      const from = playFrom(o.t, range);
      if (dir === 1 ? from >= range.end : from <= range.start) return;
      engine.current?.dispose();
      clearHold();
      const floor = ceilHour(o.displayStart);
      const lead = LEAD_MS + (o.extraLeadHours ?? 0) * HOUR_MS;
      const window =
        dir === 1
          ? { from: Math.max(floor, from - lead), to: range.end }
          : { from: Math.max(floor, range.start - lead), to: from };
      const e = createEngine({
        host,
        range,
        ready: (h) => cur.current.o.ready(h),
        onTick: (h) => cur.current.o.onT(h),
        onStop: () => {
          engine.current = undefined;
          clearHold();
          setRun(undefined);
        },
        onWait: (w) => {
          if (!w) clearHold();
          else if (hold.current === undefined) hold.current = setTimeout(() => setWaiting(true), WAIT_MS);
        },
      });
      engine.current = e;
      setRun({ dir, window });
      o.onSpeed(speed);
      if (from !== o.t) o.onT(from);
      e.play(from, dir, speed);
    },
    [clearHold],
  );
  const setSpeed = useCallback((s: Speed) => {
    setSpeedState(s);
    engine.current?.setSpeed(s);
    cur.current.o.onSpeed(s);
  }, []);

  // A deep link's speed comes with the URL, not through setSpeed.
  useEffect(() => {
    if (o.speed !== undefined) setSpeedState(o.speed);
  }, [o.speed]);

  const playing = run !== undefined;
  useEffect(() => {
    if (!playing) return;
    const hidden = () => {
      if (document.hidden) pause();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [playing, pause]);
  // Unmount: clear the timers (pause only touches state that is gone, which React ignores).
  useEffect(() => pause, [pause]);

  return { playing, dir: run?.dir ?? 1, speed, range, window: run?.window, waiting, play, pause, setSpeed };
}
