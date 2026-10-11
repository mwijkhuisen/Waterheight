import { BUCKET_MS, floorBucket, SPAN_CAP_MS } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import {
  agePolicy,
  noQuery,
  queryOf,
  Refused,
  SKEW_MS,
  seriesForecastParams,
  seriesParams,
  slowed,
  snapshotParams,
  TO_AHEAD_MS,
} from '../../src/api/params.ts';

// Request validation of the public API: no database, no clock of its own.

const BASE = 'http://api.test/api/v1';
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
// A whole second, so "now + 5 min + 1 s" is an instant the format can state (the fraction is dropped).
const NOW = Date.parse('2026-11-20T12:34:56Z');
const START = Date.parse('2026-01-01T00:00:00Z');
const FAR = Date.parse('2040-01-01T00:00:00Z');

/** The code of the refusal a call throws, 'ok' when it does not, or the unexpected error. */
function outcome(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (err) {
    if (err instanceof Refused) return err.code;
    throw err;
  }
}

const snap = (query: string, now = NOW, start = START) => snapshotParams(`${BASE}/snapshot?${query}`, now, start);
const snapOutcome = (query: string, now = NOW, start = START) => outcome(() => snap(query, now, start));
const ser = (id: string, query: string, now = NOW, start = START) =>
  seriesParams(id, `${BASE}/series/${id}?${query}`, now, start);
const serOutcome = (id: string, query: string, now = NOW, start = START) => outcome(() => ser(id, query, now, start));
/** `from` and `to` as instants, `res` when given. */
const range = (from: number, to: number, res?: string) =>
  `from=${iso(from)}&to=${iso(to)}${res === undefined ? '' : `&res=${res}`}`;

describe('queryOf and noQuery', () => {
  it('returns the decoded pairs, and nothing for a URL without a query', () => {
    expect(queryOf(`${BASE}/meta`)).toEqual({});
    expect(queryOf(`${BASE}/meta?`)).toEqual({});
    expect(queryOf(`${BASE}/x?a=1&b=%2B2&c=`)).toEqual({ a: '1', b: '+2', c: '' });
  });

  it('refuses a repeated key, an empty value included', () => {
    for (const q of ['a=1&a=2', 'a=1&b=2&a=3', 'a=&a=', 'a&a'])
      expect(
        outcome(() => queryOf(`${BASE}/x?${q}`)),
        q,
      ).toBe('repeated_parameter');
  });

  it('refuses a value longer than 32 characters, after decoding', () => {
    expect(queryOf(`${BASE}/x?a=${'a'.repeat(32)}`)).toEqual({ a: 'a'.repeat(32) });
    expect(outcome(() => queryOf(`${BASE}/x?a=${'a'.repeat(33)}`))).toBe('bad_parameter');
    // 11 encoded characters per 1 decoded one: the decoded length counts.
    expect(queryOf(`${BASE}/x?a=${'%2B'.repeat(32)}`)).toEqual({ a: '+'.repeat(32) });
    expect(outcome(() => queryOf(`${BASE}/x?a=${'%2B'.repeat(33)}`))).toBe('bad_parameter');
  });

  it('checks a repeat before the length of the value it repeats', () => {
    const long = 'a'.repeat(33);
    expect(outcome(() => queryOf(`${BASE}/x?a=1&a=${long}`))).toBe('repeated_parameter');
    expect(outcome(() => queryOf(`${BASE}/x?a=${long}&a=1`))).toBe('bad_parameter');
  });

  it('noQuery accepts no query and refuses any key, a bare one included', () => {
    expect(noQuery(`${BASE}/meta`)).toBeUndefined();
    expect(noQuery(`${BASE}/meta?`)).toBeUndefined();
    expect(outcome(() => noQuery(`${BASE}/meta?x=1`))).toBe('unknown_parameter');
    expect(outcome(() => noQuery(`${BASE}/meta?x`))).toBe('unknown_parameter');
    expect(outcome(() => noQuery(`${BASE}/meta?x=1&x=2`))).toBe('repeated_parameter');
    expect(outcome(() => noQuery(`${BASE}/meta?x=${'a'.repeat(33)}`))).toBe('bad_parameter');
  });
});

describe('Refused', () => {
  it('carries a fixed code and a status, and its message is the code, never the input', () => {
    const a = new Refused('bad_parameter');
    expect([a.code, a.status, a.message, a instanceof Error]).toEqual(['bad_parameter', 400, 'bad_parameter', true]);
    const b = new Refused('not_found', 404);
    expect([b.code, b.status]).toEqual(['not_found', 404]);
    try {
      snap('t=%3Cscript%3Ealert(1)%3C/script%3E');
      expect.unreachable();
    } catch (err) {
      expect((err as Refused).message).toBe('bad_parameter');
    }
  });

  it('every refusal of the parameter checks is a 400', () => {
    const statuses = new Set<number>();
    for (const call of [
      () => snap('t=x'),
      () => snap('t=2026-11-20T10:00:00Z&x=1'),
      () => snap('t=2026-11-20T10:00:00Z&t=2026-11-20T10:00:00Z'),
      () => snap('t=2030-01-01T00:00:00Z'),
      () => ser('1', range(START, START + 15 * DAY, 'raw')),
    ])
      try {
        call();
      } catch (err) {
        statuses.add((err as Refused).status);
      }
    expect([...statuses]).toEqual([400]);
  });
});

describe('snapshotParams: the instant', () => {
  const at = (query: string) => snap(query, FAR, START);

  it('accepts Z, an encoded plus offset, a minus offset, optional seconds and a fraction of 1 to 9 digits', () => {
    const want = Date.parse('2026-11-20T10:00:00Z');
    for (const t of [
      '2026-11-20T10:00:00Z',
      '2026-11-20T10:00Z',
      '2026-11-20T12:00:00%2B02:00',
      '2026-11-20T12:00%2B02:00',
      '2026-11-20T05:00:00-05:00',
      '2026-11-20T10:00:00%2B00:00',
      '2026-11-20T10:00:00.1Z',
      '2026-11-20T10:00:00.12Z',
      '2026-11-20T10:00:00.123456789Z',
      '2026-11-20T10:00:00.123456%2B00:00',
    ])
      expect(at(`t=${t}`), t).toBe(want);
  });

  it('reads an offset with minutes, and an offset of at most 23:59', () => {
    expect(at('t=2026-11-20T10:35:00%2B05:30')).toBe(Date.parse('2026-11-20T05:00:00Z'));
    expect(at('t=2026-11-20T10:50:00%2B05:45')).toBe(Date.parse('2026-11-20T05:00:00Z'));
    expect(at('t=2026-11-20T23:59:00%2B23:59')).toBe(Date.parse('2026-11-20T00:00:00Z'));
    expect(at('t=2026-11-20T00:00:00-23:59')).toBe(Date.parse('2026-11-20T23:50:00Z'));
  });

  it('accepts the leap day of 2024 and refuses the same day of 2026', () => {
    const t = snapshotParams(`${BASE}/snapshot?t=2024-02-29T12:00:00Z`, Date.parse('2024-03-01T00:00:00Z'), 0);
    expect(t).toBe(Date.parse('2024-02-29T12:00:00Z'));
    expect(snapOutcome('t=2026-02-29T12:00:00Z', FAR)).toBe('bad_parameter');
    expect(snapOutcome('t=2026-02-28T12:00:00Z', FAR)).toBe('ok');
  });

  it('refuses a malformed instant as bad_parameter', () => {
    const bad = [
      '2026-11-20t10:00:00Z',
      '2026-11-20T10:00:00z',
      '2026-11-20 10:00:00Z',
      '2026-11-20T10:00:60Z',
      '2026-11-20T10:60:00Z',
      '2026-11-20T24:00:00Z',
      '2026-13-20T10:00:00Z',
      '2026-00-20T10:00:00Z',
      '2026-11-00T10:00:00Z',
      '2026-11-31T10:00:00Z',
      '2026-02-30T10:00:00Z',
      '2026-02-29T10:00:00Z',
      '0000-11-20T10:00:00Z',
      '9999-11-20T10:00:00Z',
      '1899-11-20T10:00:00Z',
      '2100-01-01T00:00:00Z',
      '2026-11-20T10:00:00-00:00',
      '2026-11-20T10:00:00%2B24:00',
      '2026-11-20T10:00:00-24:00',
      '2026-11-20T10:00:00%2B05:60',
      '2026-11-20T10:00:00',
      '2026-11-20T10:00',
      '2026-11-20',
      '2026-11-20T10:00:00+02:00',
      '2026-11-20T10:00:00%2B0200',
      '2026-11-20T10:00:00.Z',
      '2026-11-20T10:00:00.1234567890Z',
      '2026-11-20T10:00.5Z',
      '2026-11-20T1:00:00Z',
      '%202026-11-20T10:00:00Z',
      '2026-11-20T10:00:00Z%20',
      '1763632800',
      '',
    ];
    for (const t of bad) expect(snapOutcome(`t=${t}`, FAR), t).toBe('bad_parameter');
  });

  it('a raw plus offset decodes to a space and is refused', () => {
    expect(snapOutcome('t=2026-11-20T12:00:00+02:00', FAR)).toBe('bad_parameter');
    expect(snapOutcome('t=2026-11-20T12:00:00%2B02:00', FAR)).toBe('ok');
  });

  it('a value of 32 characters is parsed, one of 33 is refused before it is', () => {
    const t32 = '2026-11-20T10:00:00.123456+02:00';
    expect(t32).toHaveLength(32);
    expect(snapOutcome(`t=${encodeURIComponent(t32)}`, FAR)).toBe('ok');
    const t33 = '2026-11-20T10:00:00.1234567+02:00';
    expect(t33).toHaveLength(33);
    expect(snapOutcome(`t=${encodeURIComponent(t33)}`, FAR)).toBe('bad_parameter');
    // The length is checked first: the unknown key would otherwise win.
    expect(snapOutcome(`t=${'a'.repeat(33)}&x=1`, FAR)).toBe('bad_parameter');
  });

  it('an instant more than 9 fractional digits long is refused whatever else is right', () => {
    expect(snapOutcome('t=2026-11-20T10:00:00.1234567890Z', FAR)).toBe('bad_parameter');
  });
});

describe('snapshotParams: the parameters', () => {
  it('an unknown key is unknown_parameter, a missing t is bad_parameter', () => {
    expect(snapOutcome('t=2026-11-20T10:00:00Z&x=1')).toBe('unknown_parameter');
    expect(snapOutcome('x=1&t=2026-11-20T10:00:00Z')).toBe('unknown_parameter');
    expect(snapOutcome('')).toBe('bad_parameter');
    expect(snapOutcome('T=2026-11-20T10:00:00Z')).toBe('unknown_parameter');
    expect(snapOutcome('res=raw')).toBe('unknown_parameter');
  });

  it('a repeated key is repeated_parameter, and wins over an unknown one', () => {
    const t = 't=2026-11-20T10:00:00Z';
    expect(snapOutcome(`${t}&${t}`)).toBe('repeated_parameter');
    expect(snapOutcome(`${t}&x=1&x=2`)).toBe('repeated_parameter');
    expect(snapOutcome(`x=1&${t}&x=2`)).toBe('repeated_parameter');
    expect(snapOutcome('x=1&x=2')).toBe('repeated_parameter');
    expect(snapOutcome('t=a&t=b')).toBe('repeated_parameter');
  });

  it('a hostile key never reaches the prototype and is an unknown parameter', () => {
    expect(snapOutcome('t=2026-11-20T10:00:00Z&__proto__=x')).toBe('unknown_parameter');
    expect(snapOutcome('t=2026-11-20T10:00:00Z&constructor=x')).toBe('unknown_parameter');
    const q = queryOf(`${BASE}/x?__proto__=x`);
    expect(Object.getPrototypeOf(q)).toBe(Object.prototype);
    expect(Object.keys(q)).toEqual(['__proto__']);
  });
});

describe('snapshotParams: the 10-minute grid and the window', () => {
  it('floors to the 10-minute UTC bucket', () => {
    const floored = (t: string) => snap(`t=${t}`, FAR);
    expect(floored('2026-11-20T00:39:59.999Z')).toBe(Date.parse('2026-11-20T00:30:00Z'));
    expect(floored('2026-11-20T00:30:00Z')).toBe(Date.parse('2026-11-20T00:30:00Z'));
    expect(floored('2026-11-20T00:40:00Z')).toBe(Date.parse('2026-11-20T00:40:00Z'));
    expect(floored('2026-11-20T00:29:59Z')).toBe(Date.parse('2026-11-20T00:20:00Z'));
    expect(floored('2026-11-20T23:59:59Z')).toBe(Date.parse('2026-11-20T23:50:00Z'));
  });

  it('floors in UTC, whatever the offset says', () => {
    const want = Date.parse('2026-11-20T00:30:00Z');
    expect(snap('t=2026-11-20T01:39:59%2B01:00')).toBe(want);
    expect(snap('t=2026-11-19T19:39:59-05:00')).toBe(want);
    expect(snap('t=2026-11-20T06:09:59%2B05:30')).toBe(want);
  });

  it('the same instant in different spellings floors to the same bucket', () => {
    const spellings = [
      '2026-11-20T10:07:00Z',
      '2026-11-20T12:07:00%2B02:00',
      '2026-11-20T10:07Z',
      '2026-11-20T10:07:00.5Z',
    ];
    expect(new Set(spellings.map((t) => snap(`t=${t}`))).size).toBe(1);
  });

  it('a daylight-saving change is read through the offset it states', () => {
    // The wall clock 02:30 happens twice on 2026-10-25 (CEST, then CET) and not at all on 2026-03-29.
    expect(snap('t=2026-10-25T02:30:00%2B02:00')).toBe(Date.parse('2026-10-25T00:30:00Z'));
    expect(snap('t=2026-10-25T02:30:00%2B01:00')).toBe(Date.parse('2026-10-25T01:30:00Z'));
    expect(snap('t=2026-10-25T02:30:00%2B02:00')).not.toBe(snap('t=2026-10-25T02:30:00%2B01:00'));
    expect(snap('t=2026-03-29T02:30:00%2B01:00')).toBe(Date.parse('2026-03-29T01:30:00Z'));
    expect(snap('t=2026-03-29T03:30:00%2B02:00')).toBe(Date.parse('2026-03-29T01:30:00Z'));
  });

  it('accepts t up to now + 48 hours (P8b: forecasts) and refuses one second more, before any query', () => {
    const H48 = 48 * 3_600_000;
    expect(snap(`t=${iso(NOW + SKEW_MS + 1000)}`)).toBe(floorBucket(NOW + SKEW_MS + 1000));
    expect(snap(`t=${iso(NOW + H48)}`)).toBe(floorBucket(NOW + H48));
    expect(snapOutcome(`t=${iso(NOW + H48 + 1000)}`)).toBe('out_of_range');
    expect(snapOutcome('t=2030-01-01T00:00:00Z')).toBe('out_of_range');
  });

  it('the bound is on the instant the client sent, so it may name the bucket it starts', () => {
    const now = Date.parse('2026-11-20T12:36:00Z');
    expect(snap('t=2026-11-22T12:36:00Z', now)).toBe(Date.parse('2026-11-22T12:30:00Z'));
    expect(snapOutcome('t=2026-11-22T12:36:01Z', now)).toBe('out_of_range');
  });
});

describe('seriesForecastParams (P8b): asof with the rules of t, within [displayStart, now + skew]', () => {
  const fc = (id: string, query: string, now = NOW, start = START) =>
    seriesForecastParams(id, `${BASE}/series/${id}/forecast${query === '' ? '' : `?${query}`}`, now, start);
  const fcOutcome = (id: string, query: string, now = NOW, start = START) => outcome(() => fc(id, query, now, start));

  it('defaults asof to now floored, floors a given one, and refuses one past now + skew or before displayStart', () => {
    expect(fc('7', '')).toEqual({ id: 7, asof: floorBucket(NOW) });
    expect(fc('7', 'asof=2026-11-20T10:05:00Z')).toEqual({ id: 7, asof: Date.parse('2026-11-20T10:00:00Z') });
    expect(fc('7', `asof=${iso(NOW + SKEW_MS)}`).asof).toBe(floorBucket(NOW + SKEW_MS));
    expect(fcOutcome('7', `asof=${iso(NOW + SKEW_MS + 1000)}`)).toBe('out_of_range');
    expect(fcOutcome('7', 'asof=2026-08-23T23:59:59Z', NOW, Date.parse('2026-08-24T00:00:00Z'))).toBe('out_of_range');
  });

  it('is strict: an unknown or repeated key, a bad instant or id is a 400', () => {
    expect(fcOutcome('7', 't=2026-11-20T10:00:00Z')).toBe('unknown_parameter');
    expect(fcOutcome('7', 'asof=2026-11-20T10:00:00Z&asof=2026-11-20T10:00:00Z')).toBe('repeated_parameter');
    expect(fcOutcome('7', 'asof=yesterday')).toBe('bad_parameter');
    expect(fcOutcome('7', 'asof=2026-11-20T10:00:00')).toBe('bad_parameter');
    expect(fcOutcome('0', '')).toBe('bad_parameter');
    expect(fcOutcome('2147483648', '')).toBe('bad_parameter');
  });

  it('the floored t must not be before displayStart', () => {
    const start = Date.parse('2026-08-24T00:00:00Z');
    expect(snap('t=2026-08-24T00:00:00Z', NOW, start)).toBe(start);
    expect(snap('t=2026-08-24T00:09:59Z', NOW, start)).toBe(start);
    expect(snapOutcome('t=2026-08-23T23:59:59Z', NOW, start)).toBe('out_of_range');
    expect(snapOutcome(`t=${iso(start - BUCKET_MS)}`, NOW, start)).toBe('out_of_range');
    // A start inside a bucket: the floored value is compared, so that bucket itself is out.
    const mid = start + 5 * 60_000;
    expect(snapOutcome('t=2026-08-24T00:07:00Z', NOW, mid)).toBe('out_of_range');
    expect(snap('t=2026-08-24T00:10:00Z', NOW, mid)).toBe(start + BUCKET_MS);
  });

  it('a malformed instant is bad_parameter even when it would also be out of range', () => {
    expect(snapOutcome('t=2030-02-30T00:00:00Z')).toBe('bad_parameter');
    expect(snapOutcome('t=1899-01-01T00:00:00Z')).toBe('bad_parameter');
  });
});

describe('seriesParams: the id', () => {
  const q = range(START, START + DAY);

  it('accepts a positive int4 without leading zeros', () => {
    expect(ser('1', q).id).toBe(1);
    expect(ser('2147483647', q).id).toBe(2_147_483_647);
    expect(ser('1234567890', q).id).toBe(1_234_567_890);
  });

  it('refuses anything else as bad_parameter', () => {
    for (const id of [
      '0',
      '01',
      '-1',
      '+1',
      '1.5',
      '1e3',
      '0x10',
      'abc',
      '',
      ' 1',
      '1 ',
      '2147483648',
      '9999999999',
      '99999999999',
      '٣',
    ])
      expect(serOutcome(id, q), JSON.stringify(id)).toBe('bad_parameter');
  });
});

describe('seriesParams: the parameters', () => {
  const from = START + DAY;
  const to = START + 2 * DAY;

  it('returns the floored span and the default resolution', () => {
    expect(ser('7', range(from, to))).toEqual({ id: 7, from, to, res: 'raw' });
    expect(ser('7', 'from=2026-01-02T00:03:00Z&to=2026-01-03T00:09:59.999Z')).toEqual({ id: 7, from, to, res: 'raw' });
    expect(ser('7', 'from=2026-01-02T02:00:00%2B02:00&to=2026-01-02T19:00:00-05:00')).toEqual({
      id: 7,
      from,
      to,
      res: 'raw',
    });
  });

  it('an unknown key is unknown_parameter, a repeated one repeated_parameter (checked first)', () => {
    const ok = range(from, to);
    expect(serOutcome('7', `${ok}&x=1`)).toBe('unknown_parameter');
    expect(serOutcome('7', `${ok}&id=7`)).toBe('unknown_parameter');
    expect(serOutcome('7', `${ok}&from=${iso(from)}`)).toBe('repeated_parameter');
    expect(serOutcome('7', `${ok}&x=1&x=2`)).toBe('repeated_parameter');
    expect(serOutcome('7', `${ok}&res=raw&res=1h`)).toBe('repeated_parameter');
  });

  it('a missing or malformed from, to or res is bad_parameter', () => {
    expect(serOutcome('7', `to=${iso(to)}`)).toBe('bad_parameter');
    expect(serOutcome('7', `from=${iso(from)}`)).toBe('bad_parameter');
    expect(serOutcome('7', '')).toBe('bad_parameter');
    expect(serOutcome('7', `from=&to=${iso(to)}`)).toBe('bad_parameter');
    expect(serOutcome('7', `from=${iso(from)}&to=2026-01-02T00:00:00`)).toBe('bad_parameter');
    for (const res of ['bogus', '', 'RAW', '1H', '1w', '10m'])
      expect(serOutcome('7', range(from, to, res)), res).toBe('bad_parameter');
  });

  it('accepts an explicit res, a coarser one included', () => {
    for (const res of ['raw', '1h', '1d']) expect(ser('7', range(from, to, res)).res).toBe(res);
  });

  it('a bad id and a bad query: the query is judged first', () => {
    expect(serOutcome('0', 'x=1')).toBe('unknown_parameter');
    expect(serOutcome('0', range(from, to))).toBe('bad_parameter');
  });
});

describe('seriesParams: the window', () => {
  it('from must be before to once both are floored', () => {
    const f = START + DAY;
    expect(serOutcome('1', range(f, f))).toBe('bad_parameter');
    // Both in one bucket.
    expect(serOutcome('1', range(f + 60_000, f + 9 * 60_000))).toBe('bad_parameter');
    expect(serOutcome('1', range(f + 1000, f))).toBe('bad_parameter');
    expect(serOutcome('1', range(f + BUCKET_MS, f))).toBe('bad_parameter');
    expect(ser('1', range(f, f + BUCKET_MS))).toEqual({ id: 1, from: f, to: f + BUCKET_MS, res: 'raw' });
    // The next bucket by one second: the floor puts it one bucket on.
    expect(ser('1', range(f + 599_000, f + BUCKET_MS)).to - f).toBe(BUCKET_MS);
    expect(serOutcome('1', range(f + 599_000, f + 601_000))).toBe('ok');
  });

  it('to may be now + 10 minutes and not a second more', () => {
    expect(TO_AHEAD_MS).toBe(10 * 60_000);
    const from = NOW - DAY;
    expect(ser('1', range(from, NOW + TO_AHEAD_MS)).to).toBe(floorBucket(NOW + TO_AHEAD_MS));
    expect(serOutcome('1', range(from, NOW + TO_AHEAD_MS + 1000))).toBe('out_of_range');
    expect(serOutcome('1', range(from, NOW + DAY))).toBe('out_of_range');
  });

  it('from may not be before displayStart once floored', () => {
    const start = Date.parse('2026-08-24T00:00:00Z');
    const to = start + DAY;
    expect(ser('1', range(start, to), NOW, start).from).toBe(start);
    expect(ser('1', `from=2026-08-24T00:09:59Z&to=${iso(to)}`, NOW, start).from).toBe(start);
    expect(serOutcome('1', range(start - 1000, to), NOW, start)).toBe('out_of_range');
    expect(serOutcome('1', range(start - BUCKET_MS, to), NOW, start)).toBe('out_of_range');
    // A start inside a bucket: the floored from is compared.
    expect(serOutcome('1', `from=2026-08-24T00:07:00Z&to=${iso(to)}`, NOW, start + 5 * 60_000)).toBe('out_of_range');
  });

  it('out_of_range is judged before from < to and before the span', () => {
    const start = Date.parse('2026-08-24T00:00:00Z');
    expect(serOutcome('1', range(start - DAY, start - 2 * DAY), NOW, start)).toBe('out_of_range');
    expect(serOutcome('1', range(start, NOW + DAY), NOW, start)).toBe('out_of_range');
    expect(serOutcome('1', range(start - DAY, start + 400 * DAY, 'raw'), NOW, start)).toBe('out_of_range');
  });
});

describe('seriesParams: the span and the resolution', () => {
  // Spans from displayStart, with a clock far enough on that `to` is never ahead of it.
  const start = Date.parse('2026-08-24T00:00:00Z');
  const spanOf = (span: number, res?: string) => serOutcome('1', range(start, start + span, res), FAR, start);
  const resOf = (span: number, res?: string) => ser('1', range(start, start + span, res), FAR, start).res;

  it('the caps are 14, 366 and 3660 days', () => {
    expect(SPAN_CAP_MS).toEqual({ raw: 14 * DAY, '1h': 366 * DAY, '1d': 3660 * DAY });
  });

  it('a span exactly at the cap of its resolution is accepted, one bucket more is span_too_long', () => {
    for (const res of ['raw', '1h', '1d'] as const) {
      const cap = SPAN_CAP_MS[res];
      expect(spanOf(cap, res), `${res} at cap`).toBe('ok');
      expect(resOf(cap, res)).toBe(res);
      expect(spanOf(cap + BUCKET_MS, res), `${res} over cap`).toBe('span_too_long');
    }
  });

  it('without res the finest resolution whose cap holds the span', () => {
    expect(resOf(BUCKET_MS)).toBe('raw');
    expect(resOf(14 * DAY)).toBe('raw');
    expect(resOf(14 * DAY + BUCKET_MS)).toBe('1h');
    expect(resOf(15 * DAY)).toBe('1h');
    expect(resOf(366 * DAY)).toBe('1h');
    expect(resOf(366 * DAY + BUCKET_MS)).toBe('1d');
    expect(resOf(400 * DAY)).toBe('1d');
    expect(resOf(3660 * DAY)).toBe('1d');
    expect(spanOf(3660 * DAY + BUCKET_MS)).toBe('span_too_long');
    expect(spanOf(4000 * DAY)).toBe('span_too_long');
  });

  it('an explicit res does not widen its cap', () => {
    expect(spanOf(15 * DAY, 'raw')).toBe('span_too_long');
    expect(spanOf(15 * DAY, '1h')).toBe('ok');
    expect(spanOf(400 * DAY, 'raw')).toBe('span_too_long');
    expect(spanOf(400 * DAY, '1h')).toBe('span_too_long');
    expect(spanOf(400 * DAY, '1d')).toBe('ok');
    expect(spanOf(3661 * DAY, '1d')).toBe('span_too_long');
  });

  it('the span is measured after flooring', () => {
    // Almost 14 days and 10 minutes between the raw instants: the floor leaves exactly 14 days.
    const raw = `from=${iso(start + 1000)}&to=${iso(start + 14 * DAY + 599_000)}`;
    expect(ser('1', raw, FAR, start)).toMatchObject({ from: start, to: start + 14 * DAY, res: 'raw' });
    const next = `from=${iso(start + 1000)}&to=${iso(start + 14 * DAY + BUCKET_MS)}`;
    expect(ser('1', next, FAR, start).res).toBe('1h');
  });
});

describe('agePolicy', () => {
  const now = Date.parse('2026-11-20T12:34:56.789Z');
  const current = floorBucket(now);
  const CURRENT = { header: 'public, max-age=60, stale-while-revalidate=300', ttlMs: 60_000 };
  const RECENT = { header: 'public, max-age=600', ttlMs: 600_000 };
  const OLD = { header: 'public, max-age=86400', ttlMs: 86_400_000 };

  it('the current bucket, and anything later, is kept 60 s with stale-while-revalidate', () => {
    expect(agePolicy(current, now)).toEqual(CURRENT);
    expect(agePolicy(now, now)).toEqual(CURRENT);
    expect(agePolicy(now + BUCKET_MS, now)).toEqual(CURRENT);
    expect(agePolicy(now + 7 * DAY, now)).toEqual(CURRENT);
  });

  it('one bucket before the current one is kept 600 s', () => {
    expect(agePolicy(current - 1, now)).toEqual(RECENT);
    expect(agePolicy(current - BUCKET_MS, now)).toEqual(RECENT);
    expect(agePolicy(now - 3_600_000, now)).toEqual(RECENT);
  });

  it('exactly 48 hours old is a day, 1 ms younger is 600 s', () => {
    const h48 = 48 * 3_600_000;
    expect(agePolicy(now - h48, now)).toEqual(OLD);
    expect(agePolicy(now - h48 + 1, now)).toEqual(RECENT);
    expect(agePolicy(now - h48 - 1, now)).toEqual(OLD);
    expect(agePolicy(now - 400 * DAY, now)).toEqual(OLD);
  });

  it('the in-process time to live equals the max-age that is sent', () => {
    for (const instant of [now, current - BUCKET_MS, now - 3 * DAY]) {
      const { header, ttlMs } = agePolicy(instant, now);
      expect(header).toContain(`max-age=${ttlMs / 1000}`);
    }
  });

  it('no policy is immutable, and none is private or no-store', () => {
    for (const instant of [now + DAY, now, current, current - 1, now - 47 * 3_600_000, now - 48 * 3_600_000, 0]) {
      const { header } = agePolicy(instant, now);
      expect(header).not.toContain('immutable');
      expect(header).toMatch(/^public, max-age=/);
    }
  });
});

describe('seriesParams: the brownout (P12a)', () => {
  const start = Date.parse('2026-08-24T00:00:00Z');
  const brown = (span: number, res?: string) =>
    outcome(() => seriesParams('1', `${BASE}/series/1?${range(start, start + span, res)}`, FAR, start, true));
  const resOf = (span: number, res?: string) =>
    seriesParams('1', `${BASE}/series/1?${range(start, start + span, res)}`, FAR, start, true).res;

  it('refuses an explicit res=raw as brownout (503), before any span rule', () => {
    expect(brown(DAY, 'raw')).toBe('brownout');
    expect(brown(40 * DAY, 'raw')).toBe('brownout');
    try {
      seriesParams('1', `${BASE}/series/1?${range(start, start + DAY, 'raw')}`, FAR, start, true);
    } catch (err) {
      expect((err as Refused).status).toBe(503);
    }
  });

  it('never picks raw for a default resolution, and caps the span at 30 days', () => {
    expect(resOf(BUCKET_MS)).toBe('1h');
    expect(resOf(14 * DAY)).toBe('1h');
    expect(resOf(30 * DAY)).toBe('1h');
    expect(resOf(30 * DAY, '1d')).toBe('1d');
    expect(brown(30 * DAY + BUCKET_MS)).toBe('span_too_long');
    expect(brown(30 * DAY + BUCKET_MS, '1h')).toBe('span_too_long');
    expect(brown(366 * DAY, '1d')).toBe('span_too_long');
  });

  it('is the old behaviour without the flag', () => {
    expect(ser('1', range(start, start + DAY), FAR, start).res).toBe('raw');
    expect(serOutcome('1', range(start, start + 40 * DAY), FAR, start)).toBe('ok');
  });
});

describe('slowed', () => {
  it('lengthens every mutable max-age and never adds immutable', () => {
    expect(slowed({ header: 'public, max-age=60, stale-while-revalidate=300', ttlMs: 60_000 })).toEqual({
      header: 'public, max-age=300, stale-while-revalidate=300',
      ttlMs: 300_000,
    });
    expect(slowed({ header: 'public, max-age=600', ttlMs: 600_000 }).header).toBe('public, max-age=3000');
    expect(slowed({ header: 'public, max-age=300', ttlMs: 300_000 }).header).toBe('public, max-age=1500');
    expect(slowed({ header: 'public, max-age=86400', ttlMs: 86_400_000 }).header).toBe('public, max-age=86400');
    expect(slowed(agePolicy(NOW, NOW)).header).not.toContain('immutable');
  });
});
