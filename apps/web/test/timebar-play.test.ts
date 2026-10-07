import { describe, expect, it } from 'vitest';
import { playNext, step } from '../src/features/timebar/play.ts';
import { formatLocal, quantise, STEP_MS } from '../src/lib/time/time.ts';

// Stepping and playing the timebar (P10d): one 10-minute UTC step each way, held at the bounds.

const START = Date.parse('2026-08-24T00:00:00Z');
const NOW = quantise(Date.parse('2026-10-26T12:00:00Z'));
const END = NOW + 48 * 3_600_000;

describe('step', () => {
  it('moves one step and is held at both bounds', () => {
    expect(step(NOW, 1, START, END)).toBe(NOW + STEP_MS);
    expect(step(NOW, -1, START, END)).toBe(NOW - STEP_MS);
    expect(step(START, -1, START, END)).toBe(START);
    expect(step(END, 1, START, END)).toBe(END);
  });
});

describe('playNext', () => {
  it('reverse stops at the first day', () => {
    expect(playNext(START + STEP_MS, -1, START, END)).toBe(START);
    expect(playNext(START, -1, START, END)).toBeNull();
  });

  it('forward stops at the end of the forecast, at most now + 48 h', () => {
    expect(playNext(END - STEP_MS, 1, START, END)).toBe(END);
    expect(playNext(END, 1, START, END)).toBeNull();
  });

  it('forward stops at now for a station without a forecast', () => {
    expect(playNext(NOW - STEP_MS, 1, START, NOW)).toBe(NOW);
    expect(playNext(NOW, 1, START, NOW)).toBeNull();
  });
});

describe('reverse play across the DST night (2026-10-25)', () => {
  const from = Date.parse('2026-10-25T02:20:00Z'); // 03:20 CET
  const to = Date.parse('2026-10-24T23:50:00Z'); // 01:50 CEST

  const walk = (locale: 'nl' | 'en') => {
    const seen = [from];
    for (let t = playNext(from, -1, START, END); t !== null; t = playNext(t, -1, START, END)) {
      seen.push(t);
      if (t === to) break;
    }
    return { seen, labels: seen.map((t) => formatLocal(t, locale)) };
  };

  it('every step is −10 minutes in UTC and the walk is monotonic', () => {
    const { seen } = walk('en');
    expect(seen.at(-1)).toBe(to);
    for (const [i, t] of seen.slice(1).entries()) expect((seen[i] as number) - t).toBe(STEP_MS);
  });

  it('the local clock runs 03:20 CET … 02:00 CET, then 02:50 CEST … 01:50 CEST, and 02:30 comes twice', () => {
    for (const locale of ['nl', 'en'] as const) {
      const { labels } = walk(locale);
      expect(labels[0]).toContain('03:20 CET');
      expect(labels.at(-1)).toContain('01:50 CEST');
      const at = (utc: string) => formatLocal(Date.parse(utc), locale);
      expect(at('2026-10-25T01:30:00Z')).toContain('02:30 CET');
      expect(at('2026-10-25T00:30:00Z')).toContain('02:30 CEST');
      expect(labels).toContain(at('2026-10-25T01:30:00Z'));
      expect(labels).toContain(at('2026-10-25T00:30:00Z'));
      expect(labels.filter((l) => l.includes('02:30'))).toHaveLength(2);
      // 02:00 CET (01:00Z) is followed, going back, by 02:50 CEST (00:50Z)
      const i = labels.indexOf(at('2026-10-25T01:00:00Z'));
      expect(labels[i]).toContain('02:00 CET');
      expect(labels[i + 1]).toContain('02:50 CEST');
    }
  });
});
