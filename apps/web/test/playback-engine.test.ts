import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createEngine,
  type Direction,
  type EngineOptions,
  HPS,
  type PlaybackHost,
  playFrom,
  playRange,
  SPEEDS,
  type Speed,
} from '../src/features/flow/playback/engine.ts';
import { HOUR_MS } from '../src/lib/time/time.ts';

// The playback clock (P11b): a fake host, advanced by hand.

class FakeHost implements PlaybackHost {
  now = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timers.delete(id as number);
  }
  get pending() {
    return this.timers.size;
  }
  /** Advances the clock, firing due timers in order. */
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

const DAY = 24 * HOUR_MS;
const NOW = Date.parse('2026-10-26T12:20:00Z');
const RANGE = playRange(Date.parse('2026-08-24T00:00:00Z'), NOW);

function setup(over: Partial<EngineOptions> = {}) {
  const host = new FakeHost();
  const ticks: number[] = [];
  const log = { stops: 0, waits: [] as boolean[] };
  const engine = createEngine({
    host,
    range: RANGE,
    ready: () => true,
    onTick: (t) => ticks.push(t),
    onStop: () => log.stops++,
    onWait: (w) => log.waits.push(w),
    ...over,
  });
  return { host, ticks, log, engine };
}

describe('the engine', () => {
  it.each(SPEEDS)('plays seven days in 10 to 20 seconds at %s', (speed) => {
    const { host, ticks, log, engine } = setup();
    engine.play(RANGE.end - 7 * DAY, 1, speed);
    expect(engine.playing).toBe(true);
    // the last hour is delivered at 168 ticks; measure when, not just whether
    host.advance(9_999);
    expect(ticks.length).toBeLessThan(168);
    host.advance(10_001);
    expect(ticks).toHaveLength(168);
    expect(ticks.at(-1)).toBe(RANGE.end);
    expect(168 / HPS[speed]).toBeGreaterThanOrEqual(10);
    expect(168 / HPS[speed]).toBeLessThanOrEqual(20);
    expect(log.stops).toBe(1);
    expect(engine.playing).toBe(false);
    expect(host.pending).toBe(0);
  });

  it('ticks every 1000 / HPS ms, one hour each, and does not tick early', () => {
    const { host, ticks, engine } = setup();
    engine.play(RANGE.start, 1, 'normal');
    host.advance(1000 / HPS.normal - 1);
    expect(ticks).toEqual([]);
    host.advance(1);
    expect(ticks).toEqual([RANGE.start + HOUR_MS]);
  });

  it('holds while the next hour has no data, never skips, and moves on once ready', () => {
    const have = new Set<number>();
    const from = RANGE.start + 10 * HOUR_MS;
    const gap = from + 3 * HOUR_MS;
    const { host, ticks, log, engine } = setup({ ready: (h) => h !== gap || have.has(h) });
    engine.play(from, 1, 'fast');
    host.advance(1000);
    expect(ticks).toEqual([from + HOUR_MS, from + 2 * HOUR_MS]);
    expect(engine.playing).toBe(true);
    expect(log.waits).toEqual([true]); // once, not per retry
    have.add(gap);
    host.advance(200);
    expect(ticks.slice(0, 4)).toEqual([from + HOUR_MS, from + 2 * HOUR_MS, gap, from + 4 * HOUR_MS]);
    expect(log.waits).toEqual([true, false]);
  });

  it('applies a speed change from the next tick', () => {
    const { host, ticks, engine } = setup();
    engine.play(RANGE.start, 1, 'slow');
    host.advance(1000 / HPS.slow);
    expect(ticks).toHaveLength(1);
    engine.setSpeed('fast');
    host.advance(1000 / HPS.slow); // the timer set at the old speed fires on its time
    expect(ticks).toHaveLength(2);
    host.advance(1000 / HPS.fast);
    expect(ticks).toHaveLength(3);
  });

  it('pause and dispose clear the timer; nothing ticks afterwards', () => {
    const { host, ticks, engine } = setup();
    engine.play(RANGE.start, 1, 'normal');
    host.advance(200);
    engine.pause();
    expect(engine.playing).toBe(false);
    expect(host.pending).toBe(0);
    const n = ticks.length;
    host.advance(10_000);
    expect(ticks).toHaveLength(n);
    engine.play(RANGE.start, -1, 'normal');
    engine.dispose();
    expect(host.pending).toBe(0);
    host.advance(10_000);
    expect(ticks).toHaveLength(n);
  });

  it('a disposal while holding clears the retry timer too', () => {
    const { host, engine, log } = setup({ ready: () => false });
    engine.play(RANGE.start, 1, 'normal');
    host.advance(500);
    expect(engine.playing).toBe(true);
    engine.dispose();
    expect(host.pending).toBe(0);
    expect(log.waits).toEqual([true, false]);
  });

  it('stops at the range end, forward, on delivering the last hour', () => {
    const { host, ticks, log, engine } = setup();
    engine.play(RANGE.end - 2 * HOUR_MS, 1, 'fast');
    host.advance(1000);
    expect(ticks).toEqual([RANGE.end - HOUR_MS, RANGE.end]);
    expect(log.stops).toBe(1);
    expect(engine.playing).toBe(false);
  });

  it('stops at the range start, in reverse', () => {
    const { host, ticks, log, engine } = setup();
    engine.play(RANGE.start + 2 * HOUR_MS, -1, 'fast');
    host.advance(1000);
    expect(ticks).toEqual([RANGE.start + HOUR_MS, RANGE.start]);
    expect(log.stops).toBe(1);
  });

  it('stops at once when it starts at an end and has no hour to take', () => {
    const { host, ticks, log, engine } = setup();
    engine.play(RANGE.end, 1, 'fast');
    host.advance(1000);
    expect(ticks).toEqual([]);
    expect(log.stops).toBe(1);
  });

  for (const dir of [1, -1] as const)
    it(`plays both hours of the DST night (00:00Z and 01:00Z), once each, in order (${dir === 1 ? 'forward' : 'reverse'})`, () => {
      const a = Date.parse('2026-10-24T22:00:00Z');
      const b = Date.parse('2026-10-25T03:00:00Z');
      const { host, ticks, engine } = setup();
      engine.play(dir === 1 ? a : b, dir, 'fast');
      host.advance(2000);
      const want = [1, 2, 3, 4, 5].map((i) => (dir === 1 ? a + i * HOUR_MS : b - i * HOUR_MS));
      expect(ticks.slice(0, 5)).toEqual(want);
      expect(ticks).toContain(Date.parse('2026-10-25T00:00:00Z'));
      expect(ticks).toContain(Date.parse('2026-10-25T01:00:00Z'));
    });

  it('property: every tick is one whole hour from the last, inside the range, with no skip or repeat', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        fc.constantFrom<Direction>(1, -1),
        fc.constantFrom<Speed>(...SPEEDS),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (offset, dir, speed, gaps) => {
          let n = 0;
          const from = RANGE.start + offset * HOUR_MS;
          const { host, ticks, engine } = setup({ ready: () => gaps[n++ % gaps.length] === true || n % 3 === 0 });
          engine.play(from, dir, speed);
          host.advance(60_000);
          let prev = from;
          for (const t of ticks) {
            expect(t - prev).toBe(dir * HOUR_MS);
            expect(t % HOUR_MS).toBe(0);
            expect(t >= RANGE.start && t <= RANGE.end).toBe(true);
            prev = t;
          }
        },
      ),
    );
  });
});

describe('playRange and playFrom', () => {
  it('the range is whole hours, at most 14 days, never after now', () => {
    expect(RANGE.end).toBe(Date.parse('2026-10-26T12:00:00Z'));
    expect(RANGE.start).toBe(Date.parse('2026-10-12T13:00:00Z'));
  });

  it('starts at live seven days back, else at the hour of t, inside the range', () => {
    expect(playFrom(undefined, RANGE)).toBe(RANGE.end - 7 * DAY);
    expect(playFrom(Date.parse('2026-10-20T10:40:00Z'), RANGE)).toBe(Date.parse('2026-10-20T10:00:00Z'));
    expect(playFrom(NOW + 5 * HOUR_MS, RANGE)).toBe(RANGE.end);
    expect(playFrom(0, RANGE)).toBe(RANGE.start);
  });
});
