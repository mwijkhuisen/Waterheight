import { floorBucket } from '@rws/contracts';
import fc from 'fast-check';
import { Temporal as Polyfill } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { intlLocale, perLocale } from '../src/lib/intl.ts';
import {
  amsterdam,
  formatAge,
  formatDay,
  formatLocal,
  formatShort,
  formatTick,
  localInstants,
  parseUrlT,
  quantise,
  toUrlT,
  wallInstant,
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

describe('wallInstant (the date and time fields)', () => {
  it('names the skipped hour as missing: the time field shows its alert (2027-03-28 is outside the range today)', () => {
    expect(wallInstant('2027-03-28', '02:30', utc(2027, 2, 27, 12, 0))).toBe('missing');
    expect(wallInstant('2027-03-28', '03:00', utc(2027, 2, 27, 12, 0))).toBe(utc(2027, 2, 28, 1, 0));
  });

  it('leaves an incomplete entry alone', () => {
    const near = utc(2026, 9, 26, 12, 0);
    for (const [date, time] of [
      ['', '12:00'],
      ['2026-10-26', ''],
      ['', ''],
      ['nope', '12:00'],
      ['2026-13-45', '12:00'],
    ])
      expect(wallInstant(date ?? '', time ?? '', near), `${date} ${time}`).toBeUndefined();
  });

  it('in the repeated hour keeps the offset of the current t (CR-9)', () => {
    const cest = (minute: number) => utc(2026, 9, 25, 0, minute);
    const cet = (minute: number) => utc(2026, 9, 25, 1, minute);
    // From 02:30 CET, 02:40 is 02:40 CET; from 02:30 CEST, 02:40 CEST.
    expect(wallInstant('2026-10-25', '02:40', cet(30))).toBe(cet(40));
    expect(wallInstant('2026-10-25', '02:40', cest(30))).toBe(cest(40));
    // From a time outside that hour, its offset decides: the afternoon is CET, the day before CEST.
    expect(wallInstant('2026-10-25', '02:30', utc(2026, 9, 25, 13, 0))).toBe(cet(30));
    expect(wallInstant('2026-10-25', '02:30', utc(2026, 9, 24, 12, 0))).toBe(cest(30));
    // The current t itself (to its 10-minute bucket) is kept when its own wall time is typed again.
    expect(wallInstant('2026-10-25', '02:30', cet(30))).toBe(cet(30));
    expect(wallInstant('2026-10-25', '02:30', cet(35))).toBe(cet(30));
    expect(wallInstant('2026-10-25', '02:30', cest(30))).toBe(cest(30));
  });

  it('is the one instant anywhere else', () => {
    expect(wallInstant('2026-10-26', '12:00', utc(2026, 7, 24))).toBe(utc(2026, 9, 26, 11, 0));
    expect(wallInstant('2026-10-24', '12:00', utc(2026, 9, 26))).toBe(utc(2026, 9, 24, 10, 0));
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

// O3 (#219): the formatters use cached Intl objects. Their output must be that of the code before O3, which called
// Temporal's toLocaleString with these options (f4215e5), on the native Temporal and on the polyfill.
describe('cached formatters equal the pre-O3 output', { timeout: 60_000 }, () => {
  const ZONE = 'Europe/Amsterdam';
  const OLD = {
    local: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
    short: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
    tick: { day: 'numeric', month: 'short' },
  } as const;
  const tags = { nl: 'nl-NL', en: 'en-GB' } as const;
  const instants: number[] = [];
  for (const day of [Date.UTC(2026, 2, 29), Date.UTC(2026, 9, 25)])
    for (let ms = day; ms <= day + 4 * 3_600_000; ms += TEN_MIN) instants.push(ms);
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 2); ms += 7 * 3_600_000) instants.push(ms);
  for (let ms = Date.UTC(2026, 11, 31, 21); ms <= Date.UTC(2026, 11, 31, 23, 30); ms += TEN_MIN) instants.push(ms);

  const impls = { native: globalThis.Temporal, polyfill: Polyfill as unknown as typeof Temporal };
  const g = globalThis as unknown as { Temporal: typeof Temporal };
  for (const [name, T] of Object.entries(impls)) {
    it(`formatLocal, formatShort and formatTick on the ${name} Temporal`, () => {
      const keep = g.Temporal;
      g.Temporal = T;
      try {
        for (const locale of ['nl', 'en'] as const)
          for (const ms of instants) {
            const z = T.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(ZONE);
            expect(formatLocal(ms, locale)).toBe(`${z.toLocaleString(tags[locale], OLD.local)} ${zoneLabel(z.offset)}`);
            expect(formatShort(ms, locale)).toBe(z.toLocaleString(tags[locale], OLD.short));
            expect(formatTick(ms, locale)).toBe(z.toLocaleString(tags[locale], OLD.tick));
          }
      } finally {
        g.Temporal = keep;
      }
    });
  }

  it('formatDay (UTC and Amsterdam) equals a fresh Intl.DateTimeFormat', () => {
    for (const locale of ['nl', 'en'] as const)
      for (const timeZone of ['UTC', ZONE] as const)
        for (const ms of instants.filter((_, i) => i % 7 === 0)) {
          const fresh = new Intl.DateTimeFormat(tags[locale], {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone,
          }).format(ms);
          expect(formatDay(ms, locale, timeZone)).toBe(fresh);
        }
    // the default is UTC: 23:30 UTC on the 24th is still the 24th, in Amsterdam already the 25th
    const late = Date.UTC(2026, 9, 24, 23, 30);
    expect(formatDay(late, 'en')).toBe(formatDay(late, 'en', 'UTC'));
    expect(formatDay(late, 'en')).not.toBe(formatDay(late, 'en', ZONE));
  });

  it('formatAge (minutes below 2 h, hours from it) equals fresh Intl.NumberFormat objects', () => {
    for (const locale of ['nl', 'en'] as const)
      for (const seconds of [0, 59, 60, 90, 3_599, 7_199, 7_200, 7_260, 9_000, 86_400, 200_000]) {
        const minutes = Math.round(seconds / 60);
        const fresh =
          minutes < 120
            ? new Intl.NumberFormat(tags[locale], { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(
                minutes,
              )
            : new Intl.NumberFormat(tags[locale], {
                style: 'unit',
                unit: 'hour',
                unitDisplay: 'long',
                maximumFractionDigits: 1,
              }).format(minutes / 60);
        expect(formatAge(seconds, locale)).toBe(fresh);
      }
  });
});

describe('perLocale', () => {
  it('makes one object per page language, once, and a different one for each', () => {
    let made = 0;
    const get = perLocale((locale) => ({ locale, n: ++made }));
    const nl = get('nl');
    const en = get('en');
    expect(nl).not.toBe(en);
    expect([nl.locale, en.locale]).toEqual(['nl', 'en']);
    expect(get('nl')).toBe(nl);
    expect(get('en')).toBe(en);
    expect(made).toBe(2);
  });
  it('keeps a falsy value instead of making it again', () => {
    let made = 0;
    const get = perLocale(() => {
      made += 1;
      return 0;
    });
    get('nl');
    get('nl');
    expect(made).toBe(1);
  });
  it('names Dutch nl-NL and English en-GB', () => {
    expect([intlLocale('nl'), intlLocale('en')]).toEqual(['nl-NL', 'en-GB']);
  });
});
