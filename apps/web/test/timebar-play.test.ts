import { describe, expect, it } from 'vitest';
import { playRange } from '../src/features/flow/playback/engine.ts';
import { canPlay, playDisabled, stepHour } from '../src/features/timebar/steps.ts';
import { formatLocal, HOUR_MS } from '../src/lib/time/time.ts';

// The timebar's step and play rules (P11b): the step buttons move one UTC hour, play is off in the State mode (D-1)
// and with reduced motion, and has no hour to take at the range ends. The hidden-tab stop (usePlayback) and the
// reduced-motion pause (Timebar) are React: the Playwright specs cover them; the clock is in playback-engine.test.ts.

const START = Date.parse('2026-08-24T00:00:00Z');
const NOW = Date.parse('2026-10-26T12:20:00Z');
const END = NOW + 48 * HOUR_MS;
const H = (iso: string) => Date.parse(iso);

describe('stepHour', () => {
  it('moves a whole hour from a t on the hour', () => {
    const t = H('2026-10-20T10:00:00Z');
    expect(stepHour(t, -1, START, END)).toBe(t - HOUR_MS);
    expect(stepHour(t, 1, START, END)).toBe(t + HOUR_MS);
  });

  it('goes back to the start of the hour and forward to the next one from an off-hour t', () => {
    const t = H('2026-10-20T10:40:00Z');
    expect(stepHour(t, -1, START, END)).toBe(H('2026-10-20T10:00:00Z'));
    expect(stepHour(t, 1, START, END)).toBe(H('2026-10-20T11:00:00Z'));
    expect(stepHour(H('2026-10-20T10:10:00Z'), -1, START, END)).toBe(H('2026-10-20T10:00:00Z'));
  });

  it('clamps to [start, end]: a button at a bound stays where it is', () => {
    expect(stepHour(START, -1, START, END)).toBe(START);
    expect(stepHour(START + 600_000, -1, START, END)).toBe(START);
    expect(stepHour(END, 1, START, END)).toBe(END);
    expect(stepHour(NOW, 1, START, NOW)).toBe(NOW);
  });

  it('walks the repeated hour of the DST night in order, both ways (2026-10-25)', () => {
    let t = H('2026-10-25T02:00:00Z'); // 03:00 CET
    const down: number[] = [];
    for (let i = 0; i < 4; i++) {
      t = stepHour(t, -1, START, END);
      down.push(t);
    }
    expect(down).toEqual([
      H('2026-10-25T01:00:00Z'),
      H('2026-10-25T00:00:00Z'),
      H('2026-10-24T23:00:00Z'),
      H('2026-10-24T22:00:00Z'),
    ]);
    expect(formatLocal(H('2026-10-25T01:00:00Z'), 'en')).toContain('02:00 CET');
    expect(formatLocal(H('2026-10-25T00:00:00Z'), 'en')).toContain('02:00 CEST');
    let up = H('2026-10-24T23:00:00Z');
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      up = stepHour(up, 1, START, END);
      seen.push(up);
    }
    expect(seen).toEqual([H('2026-10-25T00:00:00Z'), H('2026-10-25T01:00:00Z'), H('2026-10-25T02:00:00Z')]);
  });
});

describe('play is off only with reduced motion (#112: the State mode plays too)', () => {
  it('is enabled without reduced motion and disabled with it', () => {
    expect(playDisabled(false)).toBe(false);
    expect(playDisabled(true)).toBe(true);
  });
});

describe('canPlay', () => {
  const range = playRange(START, NOW);

  it('forward has an hour inside the range, and at live starts seven days back', () => {
    expect(canPlay(1, undefined, range)).toBe(true);
    expect(canPlay(1, range.start, range)).toBe(true);
    expect(canPlay(1, range.end - HOUR_MS, range)).toBe(true);
  });

  it('forward does nothing at the range end or after now (there is no play after now)', () => {
    expect(canPlay(1, range.end, range)).toBe(false);
    expect(canPlay(1, range.end + 30 * 60_000, range)).toBe(false);
    expect(canPlay(1, NOW + 5 * HOUR_MS, range)).toBe(false);
  });

  it('reverse stops at the range start', () => {
    expect(canPlay(-1, range.start, range)).toBe(false);
    expect(canPlay(-1, range.start + HOUR_MS, range)).toBe(true);
    expect(canPlay(-1, range.end, range)).toBe(true);
  });
});
