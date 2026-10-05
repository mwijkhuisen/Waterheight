import { describe, expect, it } from 'vitest';
import {
  classify,
  dirtyBuckets,
  historyExcluded,
  metaDayVersions,
  nextSettled,
  ownerDayVersions,
  prunePlan,
  RECENT_KEEP_MS,
  recentBuckets,
  settledDays,
  unsettledStart,
  type Version,
} from '../../src/publish/plan.ts';

// P9a: the publisher's pure planning. Settled: D + 1 d ≤ now − 48 h.

const NOW = Date.parse('2026-10-04T12:05:00Z');
const H = 3_600_000;
const at = (s: string) => Date.parse(s);

describe('day classes', () => {
  it('classifies a bucket as latest, recent, settled or future', () => {
    expect(classify(at('2026-10-04T12:00:00Z'), NOW)).toBe('latest');
    expect(classify(at('2026-10-04T12:10:00Z'), NOW)).toBe('future');
    expect(classify(at('2026-10-02T00:00:00Z'), NOW)).toBe('recent');
    expect(classify(at('2026-10-01T23:50:00Z'), NOW)).toBe('settled');
    // The boundary: 2026-10-02 settles at 2026-10-05T00:00Z.
    expect(classify(at('2026-10-02T12:00:00Z'), at('2026-10-05T00:00:00Z'))).toBe('settled');
    expect(classify(at('2026-10-02T12:00:00Z'), at('2026-10-04T23:59:59Z'))).toBe('recent');
  });

  it('recent files cover every bucket of the unsettled days up to now', () => {
    expect(new Date(unsettledStart(NOW)).toISOString()).toBe('2026-10-02T00:00:00.000Z');
    const b = recentBuckets(NOW);
    expect(b).toHaveLength(2 * 144 + 12 * 6 + 1);
    expect(new Date(b.at(-1) as number).toISOString()).toBe('2026-10-04T12:00:00.000Z');
  });

  it('lists the settled days of the display window', () => {
    const days = settledDays(at('2026-08-24T00:00:00Z'), NOW);
    expect(days[0]).toBe('2026-08-24');
    expect(days.at(-1)).toBe('2026-10-01');
    expect(days).toHaveLength(39);
  });
});

describe('dirtyBuckets', () => {
  const row = (kind: string, from: string, to: string) => ({
    id: '1',
    kind,
    from_ts: new Date(from),
    to_ts: new Date(to),
    stations: [],
  });
  it('floors the start, clips to the unsettled days and to now, and skips forecast rows', () => {
    const b = dirtyBuckets(
      [
        row('obs', '2026-10-04T11:45:00Z', '2026-10-04T13:00:00Z'),
        row('class', '2026-09-01T00:00:00Z', '2026-10-02T00:05:00Z'),
        row('forecast', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
      ],
      NOW,
    );
    expect([...b].sort().map((t) => new Date(t).toISOString().slice(0, 16))).toEqual([
      '2026-10-02T00:00',
      '2026-10-04T11:40',
      '2026-10-04T11:50',
      '2026-10-04T12:00',
    ]);
  });
});

describe('historyExcluded (§9 C5)', () => {
  it('keeps a history_export series everywhere, and the others only in latest.json inside their window', () => {
    const yes = { lic_history_export: true, history_window_s: null, staleness_s: 3600 };
    const no = { lic_history_export: false, history_window_s: 86_400, staleness_s: 3600 };
    expect(historyExcluded(yes, 'other')).toBe(false);
    expect(historyExcluded(no, 'other')).toBe(true);
    expect(historyExcluded(no, 'latest')).toBe(false);
    expect(historyExcluded({ ...no, history_window_s: 7200 }, 'latest')).toBe(true);
    expect(historyExcluded({ ...no, history_window_s: null }, 'latest')).toBe(true);
  });
});

describe('day versions', () => {
  const versions = new Map<string, Version>([
    ['2026-09-01', { v: 2, reason: 'revision' }],
    ['2026-09-02', { v: 3, reason: 'narrowed' }],
    ['2026-09-03', { v: 2, reason: 'registry' }],
  ]);
  const complete = new Map([
    ['2026-08-31', new Map([[1, NOW]])],
    ['2026-09-01', new Map([[1, NOW]])],
    ['2026-09-02', new Map([[2, NOW]])],
    ['2026-09-03', new Map([[2, NOW]])],
  ]);
  const settled = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'];

  it('names only complete versions: the current one, an older one while it renders unless narrowed, else 0', () => {
    expect(metaDayVersions(versions, complete, settled)).toEqual({
      '2026-08-30': 0,
      '2026-09-02': 0,
      '2026-09-03': 2,
    });
    expect(ownerDayVersions(versions)).toEqual({ '2026-09-01': 2, '2026-09-02': 3, '2026-09-03': 2 });
  });

  it('renders the newest pending settled day first', () => {
    expect(nextSettled(versions, complete, settled)).toBe('2026-09-02');
    expect(nextSettled(new Map(), complete, ['2026-08-31'])).toBeUndefined();
  });
});

describe('prunePlan', () => {
  const base = {
    nowMs: NOW,
    family: 'public' as const,
    recentDays: ['2026-09-30', '2026-10-01', '2026-10-02'],
    settled: new Map<string, number[]>(),
    frames: new Map<string, number[]>(),
    stationDirs: ['nl.a.x', 'nl.b.y'],
    stations: new Set(['nl.a.x']),
  };
  it("drops a settled day's recent files 6 h after its version completed, and stations no longer listed", () => {
    const complete = new Map([
      ['2026-09-30', new Map([[1, NOW - RECENT_KEEP_MS]])],
      ['2026-10-01', new Map([[1, NOW - RECENT_KEEP_MS + 1]])],
    ]);
    expect(prunePlan({ ...base, versions: new Map(), complete }).paths).toEqual(['recent/2026-09-30', 'series/nl.b.y']);
    // The owner family has no settled files: a settled day's recent files go at once.
    expect(prunePlan({ ...base, family: 'owner', versions: new Map(), complete: new Map() }).paths).toEqual([
      'recent/2026-09-30',
      'recent/2026-10-01',
      'series/nl.b.y',
    ]);
  });

  it('drops a superseded version 1 h after its successor completed, or at once after a narrowing', () => {
    const settled = new Map([
      ['2026-09-01', [1, 2]],
      ['2026-09-02', [1, 2]],
      ['2026-09-03', [1, 2]],
    ]);
    const frames = new Map([['2026-09-02', [1]]]);
    const versions = new Map<string, Version>([
      ['2026-09-01', { v: 2, reason: 'revision' }],
      ['2026-09-02', { v: 2, reason: 'narrowed' }],
      ['2026-09-03', { v: 2, reason: 'registry' }],
    ]);
    const complete = new Map([
      ['2026-09-01', new Map([[2, NOW - H]])],
      ['2026-09-03', new Map([[2, NOW - H + 1]])],
    ]);
    const plan = prunePlan({ ...base, recentDays: [], stations: undefined, settled, frames, versions, complete });
    expect(plan.paths).toEqual(['settled/2026-09-01/v1', 'settled/2026-09-02/v1', 'frames/2026-09-02/v1.json']);
    expect(plan.markers).toEqual([
      ['2026-09-01', 1],
      ['2026-09-02', 1],
    ]);
  });
});
