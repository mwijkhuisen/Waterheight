import { DAY_MS, SETTLE_MS } from '@rws/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  DayVersions,
  IMMUTABLE,
  isImmutable,
  spannedDays,
  VERSIONS_REFRESH_MS,
  versionTag,
} from '../../src/api/versions.ts';

// `v` and immutability (P9b): which days an answer spans, and when it may be cached forever.

const at = (iso: string) => Date.parse(iso);
const noDb = {} as never;

describe('spannedDays', () => {
  it('a snapshot at t is [t, t + 1): one day', () => {
    const t = at('2026-10-01T12:30:00Z');
    expect(spannedDays(t, t + 1)).toEqual(['2026-10-01']);
  });

  it('the last millisecond of a day is that day only; one more spans the next', () => {
    const last = at('2026-10-01T23:59:59.999Z');
    expect(spannedDays(last, last + 1)).toEqual(['2026-10-01']);
    expect(spannedDays(last, last + 2)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('a span ending exactly at midnight excludes the next day', () => {
    expect(spannedDays(at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z'))).toEqual(['2026-10-01']);
    expect(spannedDays(at('2026-10-01T06:00:00Z'), at('2026-10-02T00:00:00Z'))).toEqual(['2026-10-01']);
  });

  it('a span ending one millisecond after midnight includes the next day', () => {
    expect(spannedDays(at('2026-10-01T06:00:00Z'), at('2026-10-02T00:00:00.001Z'))).toEqual([
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('crosses a month and a year', () => {
    expect(spannedDays(at('2026-09-30T12:00:00Z'), at('2026-10-01T12:00:00Z'))).toEqual(['2026-09-30', '2026-10-01']);
    expect(spannedDays(at('2026-12-31T23:00:00Z'), at('2027-01-01T01:00:00Z'))).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('lists every day of a long span in order', () => {
    expect(spannedDays(at('2026-09-29T00:00:00Z'), at('2026-10-02T00:00:00Z'))).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ]);
    expect(spannedDays(at('2026-02-27T10:00:00Z'), at('2026-03-02T10:00:00Z'))).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });
});

describe('versionTag', () => {
  it('joins day:version in order', () => {
    const map = new Map([
      ['2026-10-01', 3],
      ['2026-10-02', 1],
    ]);
    expect(versionTag(['2026-10-01', '2026-10-02'], (d) => map.get(d) ?? 1)).toBe('2026-10-01:3,2026-10-02:1');
    expect(versionTag(['2026-10-03'], (d) => map.get(d) ?? 1)).toBe('2026-10-03:1');
    expect(versionTag([], () => 1)).toBe('');
  });
});

describe('DayVersions', () => {
  it('versionOf defaults to 1, set replaces the map and marks it loaded', () => {
    const v = new DayVersions(noDb, 'public');
    expect(v.loaded).toBe(false);
    expect(v.versionOf('2026-10-01')).toBe(1);
    v.set(new Map([['2026-10-01', 4]]));
    expect(v.loaded).toBe(true);
    expect(v.versionOf('2026-10-01')).toBe(4);
    expect(v.versionOf('2026-10-02')).toBe(1);
    v.set(new Map([['2026-10-02', 2]]));
    expect(v.versionOf('2026-10-01')).toBe(1);
    expect(v.versionOf('2026-10-02')).toBe(2);
  });

  it('set copies its argument', () => {
    const v = new DayVersions(noDb, 'public');
    const map = new Map([['2026-10-01', 2]]);
    v.set(map);
    map.set('2026-10-01', 9);
    expect(v.versionOf('2026-10-01')).toBe(2);
  });

  it('a failed refresh logs a fixed code only, keeps the last value and stays unloaded when it never loaded', async () => {
    const error = vi.fn();
    const v = new DayVersions(noDb, 'owner', { error });
    expect(await v.refresh()).toBe(false);
    expect(v.loaded).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({ code: 'unknown' });
    v.set(new Map([['2026-10-01', 2]]));
    expect(await v.refresh()).toBe(false);
    expect(v.loaded).toBe(true);
    expect(v.versionOf('2026-10-01')).toBe(2);
  });

  it('start refreshes on a timer and stop cancels it; both are idempotent', async () => {
    vi.useFakeTimers();
    try {
      const v = new DayVersions(noDb, 'public', { error: () => {} });
      const refresh = vi.spyOn(v, 'refresh').mockResolvedValue(true);
      v.start();
      v.start();
      await vi.advanceTimersByTimeAsync(VERSIONS_REFRESH_MS - 1);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(VERSIONS_REFRESH_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
      v.stop();
      v.stop();
      await vi.advanceTimersByTimeAsync(5 * VERSIONS_REFRESH_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isImmutable', () => {
  const DAY = '2026-10-01';
  const SETTLED_AT = at(`${DAY}T00:00:00Z`) + DAY_MS + SETTLE_MS; // the day ended 48 h ago, exactly
  const loaded = (map: [string, number][] = []) => {
    const v = new DayVersions(noDb, 'public');
    v.set(new Map(map));
    return v;
  };
  const tagOf = (v: DayVersions, days: string[]) => versionTag(days, (d) => v.versionOf(d));

  it('the cache constant is public, a year and immutable', () => {
    expect(IMMUTABLE).toBe('public, max-age=31536000, immutable');
  });

  it('is true when v is the current version of every spanned settled day and the tags agree', () => {
    const v = loaded([[DAY, 3]]);
    expect(isImmutable(3, [DAY], v, tagOf(v, [DAY]), SETTLED_AT)).toBe(true);
    // A day without a row is version 1.
    const w = loaded();
    expect(isImmutable(1, [DAY], w, tagOf(w, [DAY]), SETTLED_AT + 5 * DAY_MS)).toBe(true);
  });

  it('is true across several days when they all agree', () => {
    const days = ['2026-10-01', '2026-10-02'];
    const v = loaded([
      ['2026-10-01', 2],
      ['2026-10-02', 2],
    ]);
    const now = at('2026-10-02T00:00:00Z') + DAY_MS + SETTLE_MS;
    expect(isImmutable(2, days, v, tagOf(v, days), now)).toBe(true);
  });

  it('is false without a v', () => {
    const v = loaded();
    expect(isImmutable(undefined, [DAY], v, tagOf(v, [DAY]), SETTLED_AT)).toBe(false);
  });

  it('is false while the versions are not loaded, or there is no DayVersions', () => {
    const v = new DayVersions(noDb, 'public');
    expect(isImmutable(1, [DAY], v, tagOf(v, [DAY]), SETTLED_AT)).toBe(false);
    expect(isImmutable(1, [DAY], undefined, `${DAY}:1`, SETTLED_AT)).toBe(false);
  });

  it('is false for no days', () => {
    const v = loaded();
    expect(isImmutable(1, [], v, '', SETTLED_AT)).toBe(false);
  });

  it('is false while a day is not settled: exactly settled passes, one millisecond less does not', () => {
    const v = loaded();
    const tag = tagOf(v, [DAY]);
    expect(isImmutable(1, [DAY], v, tag, SETTLED_AT)).toBe(true);
    expect(isImmutable(1, [DAY], v, tag, SETTLED_AT - 1)).toBe(false);
    // Today and tomorrow are never settled.
    expect(isImmutable(1, [DAY], v, tag, at(`${DAY}T12:00:00Z`))).toBe(false);
  });

  it('is false when one of several days is not settled', () => {
    const days = ['2026-10-01', '2026-10-02'];
    const v = loaded();
    expect(isImmutable(1, days, v, tagOf(v, days), SETTLED_AT + 1_000)).toBe(false);
    expect(isImmutable(1, days, v, tagOf(v, days), SETTLED_AT + DAY_MS)).toBe(true);
  });

  it('is false when v is not the current version of the day', () => {
    const v = loaded([[DAY, 3]]);
    expect(isImmutable(2, [DAY], v, tagOf(v, [DAY]), SETTLED_AT)).toBe(false);
    expect(isImmutable(4, [DAY], v, tagOf(v, [DAY]), SETTLED_AT)).toBe(false);
    expect(isImmutable(1, [DAY], v, tagOf(v, [DAY]), SETTLED_AT)).toBe(false);
  });

  it('is false when v matches only one of two days', () => {
    const days = ['2026-10-01', '2026-10-02'];
    const v = loaded([['2026-10-02', 2]]);
    const now = at('2026-10-02T00:00:00Z') + DAY_MS + SETTLE_MS;
    expect(isImmutable(1, days, v, tagOf(v, days), now)).toBe(false);
    expect(isImmutable(2, days, v, tagOf(v, days), now)).toBe(false);
  });

  it('is false when the answer was read at another tag than memory holds now (a bump between refresh and read)', () => {
    const v = loaded([[DAY, 2]]);
    // The answer's transaction saw version 3 already; memory still says 2.
    expect(isImmutable(2, [DAY], v, `${DAY}:3`, SETTLED_AT)).toBe(false);
    // The answer saw 2 but memory has moved on to 3 and the request carried 3.
    const bumped = loaded([[DAY, 3]]);
    expect(isImmutable(3, [DAY], bumped, `${DAY}:2`, SETTLED_AT)).toBe(false);
    expect(isImmutable(3, [DAY], bumped, '', SETTLED_AT)).toBe(false);
  });
});
