import { useMemo } from 'react';
import { type Direction, playRange, type Speed } from './engine.ts';

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
}

export function usePlayback(o: PlaybackOptions): Playback {
  // L0 stub (W5 builds it).
  const range = useMemo(() => playRange(o.displayStart, o.now), [o.displayStart, o.now]);
  return {
    playing: false,
    dir: 1,
    speed: o.speed ?? 'normal',
    range,
    window: undefined,
    play: () => undefined,
    pause: () => undefined,
    setSpeed: () => undefined,
  };
}
