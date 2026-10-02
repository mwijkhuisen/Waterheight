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
});
