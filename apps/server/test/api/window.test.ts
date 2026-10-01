import { describe, expect, it, vi } from 'vitest';
import { DisplayWindow, REFRESH_MS, RETRY_MS } from '../../src/api/window.ts';
import { fakeDb } from './fake-db.ts';

// The display window held in memory: what a load keeps, and when it is read again.

type Answer = () => { rows: unknown[] };
const row =
  (displayStart: string, dataEpoch = '2026-10-02T00:00:00Z'): Answer =>
  () => ({ rows: [{ display_start: new Date(displayStart), data_epoch: new Date(dataEpoch) }] });
const down: Answer = () => {
  throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
};

/** A window over a database that gives `answers` in turn (the last one again after that), counting the reads. */
function setup(answers: Answer[]) {
  let reads = 0;
  const lines: unknown[] = [];
  const db = fakeDb(async () => {
    const answer = answers[Math.min(reads, answers.length - 1)] as Answer;
    reads += 1;
    return answer();
  });
  const w = new DisplayWindow(db, { error: ((o: unknown) => lines.push(o)) as never });
  return { w, lines, reads: () => reads };
}

describe('DisplayWindow', () => {
  it('rounds displayStart up to the 10-minute grid; dataEpoch is kept as it is', async () => {
    for (const [stored, held] of [
      ['2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'],
      ['2026-08-24T00:00:00.001Z', '2026-08-24T00:10:00Z'],
      ['2026-08-24T00:09:59.999Z', '2026-08-24T00:10:00Z'],
      ['2026-08-24T00:10:00Z', '2026-08-24T00:10:00Z'],
    ] as const) {
      const { w } = setup([row(stored, '2026-10-02T00:00:01Z')]);
      expect(await w.refresh(), stored).toBe(true);
      expect(w.current, stored).toEqual({
        dataEpochMs: Date.parse('2026-10-02T00:00:01Z'),
        displayStartMs: Date.parse(held),
      });
    }
  });

  it('a failed refresh keeps the last value and logs a fixed code only', async () => {
    const { w, lines } = setup([row('2026-08-24T00:00:00Z'), down]);
    expect(await w.refresh()).toBe(true);
    const loaded = w.current;
    expect(await w.refresh()).toBe(false);
    expect(w.current).toEqual(loaded);
    expect(lines).toEqual([{ code: 'ECONNREFUSED' }]);
  });

  it('no row, or a row without both instants, is no_display_window and loads nothing', async () => {
    for (const answer of [
      () => ({ rows: [] }),
      () => ({ rows: [{ display_start: null, data_epoch: new Date('2026-10-02T00:00:00Z') }] }),
      () => ({ rows: [{ display_start: new Date('2026-08-24T00:00:00Z'), data_epoch: null }] }),
    ]) {
      const { w, lines } = setup([answer]);
      expect(await w.refresh()).toBe(false);
      expect(w.current).toBeUndefined();
      expect(lines).toEqual([{ code: 'no_display_window' }]);
    }
  });

  it('tries again every 10 s until the first load, then every 5 min; a failure keeps the value; stop ends it', async () => {
    vi.useFakeTimers();
    try {
      const { w, reads } = setup([down, down, row('2026-08-24T00:00:00Z'), down, row('2026-08-25T00:00:00Z')]);
      // The load before the server listens fails.
      expect(await w.refresh()).toBe(false);
      w.start();
      w.start(); // a second start adds no timer
      await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
      expect(reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect([reads(), w.current]).toEqual([2, undefined]);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(reads()).toBe(3);
      expect(w.current?.displayStartMs).toBe(Date.parse('2026-08-24T00:00:00Z'));
      // Loaded: every 5 minutes from now on, a failure included.
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      expect(reads()).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads()).toBe(4);
      expect(w.current?.displayStartMs).toBe(Date.parse('2026-08-24T00:00:00Z'));
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      expect(reads()).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads()).toBe(5);
      expect(w.current?.displayStartMs).toBe(Date.parse('2026-08-25T00:00:00Z'));
      w.stop();
      await vi.advanceTimersByTimeAsync(10 * REFRESH_MS);
      expect(reads()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
