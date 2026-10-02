import { describe, expect, it } from 'vitest';
import { minIntervals } from '../../src/load/health.ts';
import { foldIntervals, type Intervals } from '../../src/load/store.ts';

// P5a: the shortest gap between two requests of one spec and variant over 24 h, from manifest fetch starts
// (BAFU: LINDAS at most once per 10 minutes). The state is loader-private; only the minimum per spec is public.

const at = (iso: string) => Date.parse(iso);
const empty: Intervals = { last: {}, hours: {} };
const start = (spec: string, variant: string, iso: string) => ({ spec, variant, at: at(iso) });

describe('foldIntervals and minIntervals', () => {
  it('measures each variant against its own previous start, never one variant against another', () => {
    const s = foldIntervals(empty, [
      start('ch-1-lindas', 'river', '2026-10-02T10:04:00.100Z'),
      start('ch-1-lindas', 'lake', '2026-10-02T10:04:02.300Z'),
      start('ch-1-lindas', 'river', '2026-10-02T10:14:00.050Z'),
      start('ch-1-lindas', 'lake', '2026-10-02T10:14:01.900Z'),
    ]);
    expect(minIntervals(s, new Date('2026-10-02T10:20:00Z'))).toEqual([{ spec: 'ch-1-lindas', seconds: 600 }]);
  });

  it('carries the last start across folds, and keeps the shortest gap of each hour', () => {
    let s = foldIntervals(empty, [start('ch-1-lindas', 'river', '2026-10-02T10:04:00Z')]);
    expect(minIntervals(s, new Date('2026-10-02T10:05:00Z'))).toEqual([]);
    s = foldIntervals(s, [start('ch-1-lindas', 'river', '2026-10-02T10:14:00Z')]);
    s = foldIntervals(s, [start('ch-1-lindas', 'river', '2026-10-02T10:20:00Z')]);
    expect(minIntervals(s, new Date('2026-10-02T10:30:00Z'))).toEqual([{ spec: 'ch-1-lindas', seconds: 360 }]);
  });

  it('ignores a start that is not after the last one of its variant (a re-read or a recovered line)', () => {
    const s = foldIntervals(empty, [
      start('fr-1-obs', 'default', '2026-10-02T10:01:00Z'),
      start('fr-1-obs', 'default', '2026-10-02T10:01:00Z'),
      start('fr-1-obs', 'default', '2026-10-02T09:46:00Z'),
      start('fr-1-obs', 'default', '2026-10-02T10:16:00Z'),
    ]);
    expect(minIntervals(s, new Date('2026-10-02T10:20:00Z'))).toEqual([{ spec: 'fr-1-obs', seconds: 900 }]);
  });

  it('reports only the last 24 hours and forgets hours older than 25', () => {
    let s = foldIntervals(empty, [
      start('ch-2-pq', 'default', '2026-10-01T08:06:00Z'),
      start('ch-2-pq', 'default', '2026-10-01T08:10:00Z'),
    ]);
    s = foldIntervals(s, [start('ch-2-pq', 'default', '2026-10-02T09:06:00Z')]);
    expect(Object.keys(s.hours['ch-2-pq'] ?? {})).toHaveLength(1);
    expect(minIntervals(s, new Date('2026-10-02T09:10:00Z'))).toEqual([{ spec: 'ch-2-pq', seconds: 89_760 }]);
    expect(minIntervals(s, new Date('2026-10-03T12:00:00Z'))).toEqual([]);
  });

  it('takes exactly the hour buckets from the one that holds now − 24 h onward, not one hour more (review CR-8)', () => {
    const s = foldIntervals(empty, [
      start('ch-1-lindas', 'river', '2026-10-01T08:50:00Z'),
      start('ch-1-lindas', 'river', '2026-10-01T08:55:00Z'),
      start('ch-1-lindas', 'river', '2026-10-01T09:05:00Z'),
    ]);
    // The 300 s gap is in the 08:00 bucket, the 600 s gap in the 09:00 bucket.
    expect(minIntervals(s, new Date('2026-10-02T08:59:59Z'))).toEqual([{ spec: 'ch-1-lindas', seconds: 300 }]);
    expect(minIntervals(s, new Date('2026-10-02T09:00:00Z'))).toEqual([{ spec: 'ch-1-lindas', seconds: 600 }]);
    expect(minIntervals(s, new Date('2026-10-02T09:59:59Z'))).toEqual([{ spec: 'ch-1-lindas', seconds: 600 }]);
    expect(minIntervals(s, new Date('2026-10-02T10:00:00Z'))).toEqual([]);
  });

  it('forgets the last start of a variant 25 hours before the newest start: a stopped variant leaves no state (review SR-4)', () => {
    let s = foldIntervals(empty, [
      start('ch-1-lindas', 'lake', '2026-10-01T08:00:00Z'),
      start('ch-1-lindas', 'river', '2026-10-01T08:00:01Z'),
      start('ch-1-lindas', 'gone', '2026-10-01T07:00:00Z'),
    ]);
    expect(Object.keys(s.last).sort()).toEqual(['ch-1-lindas|gone', 'ch-1-lindas|lake', 'ch-1-lindas|river']);
    s = foldIntervals(s, [start('ch-1-lindas', 'river', '2026-10-02T09:00:00Z')]);
    // Exactly 25 hours before the newest start is forgotten too; 25 hours less a second is kept (and measured).
    expect(s.last).toEqual({ 'ch-1-lindas|river': at('2026-10-02T09:00:00Z') });
    expect(minIntervals(s, new Date('2026-10-02T09:01:00Z'))).toEqual([{ spec: 'ch-1-lindas', seconds: 89_999 }]);
    // A forgotten variant that starts again is measured from its next start, never from the old one.
    s = foldIntervals(s, [start('ch-1-lindas', 'lake', '2026-10-02T09:00:02Z')]);
    expect(minIntervals(s, new Date('2026-10-02T09:01:00Z'))).toEqual([{ spec: 'ch-1-lindas', seconds: 89_999 }]);
    expect(Object.keys(s.last).sort()).toEqual(['ch-1-lindas|lake', 'ch-1-lindas|river']);
  });
});
