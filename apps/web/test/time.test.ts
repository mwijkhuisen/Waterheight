import { floorBucket } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  amsterdam,
  formatAge,
  formatLocal,
  localInstants,
  parseUrlT,
  quantise,
  toUrlT,
  zoneLabel,
} from '../src/lib/time/time.ts';

// The time helpers (P4b): every instant is UTC milliseconds, Amsterdam wall
// time is for display only (A§10). Node 26 has Temporal natively.

const utc = (year: number, month: number, day = 1, hour = 0, minute = 0) => Date.UTC(year, month, day, hour, minute);
const TEN_MIN = 600_000;

describe('quantise', () => {
  it('floors to the 10-minute UTC grid: a boundary stays, one millisecond before drops a step', () => {
    const grid = utc(2026, 9, 25, 1, 30);
    expect(quantise(grid)).toBe(grid);
    expect(quantise(grid + 1)).toBe(grid);
    expect(quantise(grid + TEN_MIN - 1)).toBe(grid);
    expect(quantise(grid - 1)).toBe(grid - TEN_MIN);
  });

  it('is the same function as the API’s floorBucket', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e13, max: 1e13 }), (ms) => {
        expect(quantise(ms)).toBe(floorBucket(ms));
        expect(Number.isInteger(quantise(ms) / TEN_MIN)).toBe(true);
      }),
    );
  });
});

describe('toUrlT / parseUrlT', () => {
  it('writes UTC to the minute with Z and reads it back', () => {
    const ms = utc(2026, 10, 20, 14, 0);
    expect(toUrlT(ms)).toBe('2026-11-20T14:00Z');
    expect(parseUrlT('2026-11-20T14:00Z')).toBe(ms);
    fc.assert(
      fc.property(fc.integer({ min: utc(2020, 0, 1) / TEN_MIN, max: utc(2040, 0, 1) / TEN_MIN }), (n) => {
        expect(parseUrlT(toUrlT(n * TEN_MIN))).toBe(n * TEN_MIN);
      }),
    );
  });

  it('floors a minute off the grid to the grid', () => {
    expect(parseUrlT('2026-11-20T14:05Z')).toBe(utc(2026, 10, 20, 14, 0));
    expect(parseUrlT('2026-11-20T14:59Z')).toBe(utc(2026, 10, 20, 14, 50));
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['no zone', '2026-11-20T14:00'],
    ['seconds', '2026-11-20T14:00:00Z'],
    ['an offset', '2026-11-20T14:00+01:00'],
    ['lowercase z', '2026-11-20T14:00z'],
    ['a day that does not exist', '2026-02-30T00:00Z'],
    ['hour 24', '2026-10-25T24:00Z'],
    ['hour 25', '2026-10-25T25:00Z'],
    ['minute 60', '2026-10-25T10:60Z'],
    ['month 13', '2026-13-01T00:00Z'],
    ['33 characters', '2026-11-20T14:00Z'.padEnd(33, 'x')],
    ['a tag', '<script>'],
    ['a leading space', ' 2026-11-20T14:00Z'],
    ['a trailing newline', '2026-11-20T14:00Z\n'],
  ])('refuses %s', (_, text) => {
    expect(parseUrlT(text)).toBeUndefined();
  });
});

describe('zoneLabel', () => {
  it('names CET and CEST from the offset, anything else by its offset', () => {
    expect(zoneLabel('+01:00')).toBe('CET');
    expect(zoneLabel('+02:00')).toBe('CEST');
    expect(zoneLabel('+00:00')).toBe('UTC+00:00');
    expect(zoneLabel('-05:00')).toBe('UTC-05:00');
  });
});

describe('amsterdam', () => {
  it.each([
    ['summer time ends: 00:30Z is still CEST', utc(2026, 9, 25, 0, 30), '2026-10-25', '02:30', '+02:00', 'CEST'],
    ['01:30Z is the repeated hour, now CET', utc(2026, 9, 25, 1, 30), '2026-10-25', '02:30', '+01:00', 'CET'],
    ['a summer instant', utc(2026, 6, 1, 10, 0), '2026-07-01', '12:00', '+02:00', 'CEST'],
    ['a winter instant', utc(2026, 0, 15, 10, 0), '2026-01-15', '11:00', '+01:00', 'CET'],
    ['a UTC evening that is the next Amsterdam day', utc(2026, 11, 31, 23, 10), '2027-01-01', '00:10', '+01:00', 'CET'],
  ])('%s', (_, ms, date, time, offset, label) => {
    expect(amsterdam(ms)).toEqual({ date, time, offset, label });
  });
});

describe('localInstants', () => {
  it('gives both instants of the hour that occurs twice when summer time ends', () => {
    expect(localInstants('2026-10-25', '02:30')).toEqual([utc(2026, 9, 25, 0, 30), utc(2026, 9, 25, 1, 30)]);
    expect(localInstants('2026-10-25', '02:00')).toEqual([utc(2026, 9, 25, 0, 0), utc(2026, 9, 25, 1, 0)]);
  });

  it('gives one instant outside that hour', () => {
    expect(localInstants('2026-10-25', '03:30')).toEqual([utc(2026, 9, 25, 2, 30)]);
    expect(localInstants('2026-10-25', '01:50')).toEqual([utc(2026, 9, 24, 23, 50)]);
    expect(localInstants('2026-07-01', '12:00')).toEqual([utc(2026, 6, 1, 10, 0)]);
    expect(localInstants('2026-01-15', '12:00')).toEqual([utc(2026, 0, 15, 11, 0)]);
  });

  it('gives none for the hour skipped when summer time starts', () => {
    expect(localInstants('2027-03-28', '02:30')).toEqual([]);
    expect(localInstants('2027-03-28', '02:00')).toEqual([]);
    expect(localInstants('2027-03-28', '03:00')).toEqual([utc(2027, 2, 28, 1, 0)]);
  });

  it('gives none for text that is not a date and time', () => {
    expect(localInstants('nope', '12:00')).toEqual([]);
    expect(localInstants('2026-13-45', '12:00')).toEqual([]);
    expect(localInstants('2026-07-01', 'noon')).toEqual([]);
    expect(localInstants('', '')).toEqual([]);
  });
});

describe('formatLocal', () => {
  const first = utc(2026, 9, 25, 0, 30);
  const second = utc(2026, 9, 25, 1, 30);

  it.each(['nl', 'en'] as const)('tells the two 02:30 of the repeated hour apart in %s', (locale) => {
    const a = formatLocal(first, locale);
    const b = formatLocal(second, locale);
    expect(a).not.toBe(b);
    expect(a).toContain('02:30');
    expect(b).toContain('02:30');
    expect(a.endsWith(' CEST')).toBe(true);
    expect(b.endsWith(' CET')).toBe(true);
  });

  it('writes the day in the page’s language', () => {
    expect(formatLocal(first, 'nl')).toMatch(/okt/);
    expect(formatLocal(first, 'en')).toMatch(/Oct/);
  });
});

describe('formatAge', () => {
  it.each([
    ['nl', 0, /^0\s*min/],
    ['en', 0, /^0\s*min/],
    ['nl', 12 * 60, /^12\s*min/],
    ['en', 12 * 60, /^12\s*min/],
    ['nl', 59 * 60, /^59\s*min/],
    ['en', 119 * 60, /^119\s*min/],
    ['nl', 150 * 60, /^2,5\s*uur/],
    ['en', 150 * 60, /^2\.5\s*hours/],
    ['en', 120 * 60, /^2\s*hours/],
  ] as const)('%s, %i s', (locale, seconds, expected) => {
    expect(formatAge(seconds, locale)).toMatch(expected);
  });
});
