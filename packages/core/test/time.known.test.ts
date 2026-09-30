import { describe, expect, it } from 'vitest';
import { type DstRule, isFuture, parseInstant, type TimeConvention, TimeError, toIso } from '../src/index.ts';

// Known instants (issue #17: at least 30). Every expected value was worked out
// by hand from the convention's definition, not copied from the parser.

const REJECT: DstRule = { gap: 'reject', overlap: 'reject' };
const amsterdamZ = (dst: DstRule): TimeConvention => ({ kind: 'local-labelled-z', zone: 'Europe/Amsterdam', dst });
const local = (zone: string, dst: DstRule): TimeConvention => ({ kind: 'naive-local', zone, dst });
const ISO: TimeConvention = { kind: 'iso-offset' };
const RWS: TimeConvention = { kind: 'fixed-offset', offset: '+01:00' };

const CASES: readonly [string, TimeConvention, string | number, string][] = [
  // RWS REST: fixed +01:00 all year (catalogue §4.4).
  ['RWS summer', RWS, '2026-09-23T20:50:00.000+01:00', '2026-09-23T19:50:00.000Z'],
  ['RWS winter', RWS, '2026-12-01T00:10:00.000+01:00', '2026-11-30T23:10:00.000Z'],
  ['RWS in the repeated hour', RWS, '2026-10-25T02:30:00.000+01:00', '2026-10-25T01:30:00.000Z'],
  // RWS WFS: Amsterdam wall-clock time labelled Z.
  ['WFS summer', amsterdamZ(REJECT), '2026-09-23T21:30:00.000Z', '2026-09-23T19:30:00.000Z'],
  ['WFS winter', amsterdamZ(REJECT), '2026-12-23T21:30:00.000Z', '2026-12-23T20:30:00.000Z'],
  ['WFS day before fall-back', amsterdamZ(REJECT), '2026-10-24T23:59:00.000Z', '2026-10-24T21:59:00.000Z'],
  ['WFS last unambiguous summer minute', amsterdamZ(REJECT), '2026-10-25T01:59:00.000Z', '2026-10-24T23:59:00.000Z'],
  ['WFS first unambiguous winter hour', amsterdamZ(REJECT), '2026-10-25T03:00:00.000Z', '2026-10-25T02:00:00.000Z'],
  // The repeated local hour on 2026-10-25: 02:00–02:59 is 00:00Z–00:59Z (CEST) and 01:00Z–01:59Z (CET).
  [
    'repeated hour, first',
    amsterdamZ({ gap: 'reject', overlap: 'earlier' }),
    '2026-10-25T02:30:00.000Z',
    '2026-10-25T00:30:00.000Z',
  ],
  [
    'repeated hour, second',
    amsterdamZ({ gap: 'reject', overlap: 'later' }),
    '2026-10-25T02:30:00.000Z',
    '2026-10-25T01:30:00.000Z',
  ],
  [
    'repeated hour start, second',
    amsterdamZ({ gap: 'reject', overlap: 'later' }),
    '2026-10-25T02:00:00.000Z',
    '2026-10-25T01:00:00.000Z',
  ],
  [
    'repeated hour end, second',
    amsterdamZ({ gap: 'reject', overlap: 'later' }),
    '2026-10-25T02:59:00.000Z',
    '2026-10-25T01:59:00.000Z',
  ],
  [
    'repeated hour, collection time inside the first pass',
    amsterdamZ({ gap: 'reject', overlap: { notAfter: Date.UTC(2026, 9, 25, 0, 40) } }),
    '2026-10-25T02:30:00.000Z',
    '2026-10-25T00:30:00.000Z',
  ],
  [
    'repeated hour, collection time inside the second pass',
    amsterdamZ({ gap: 'reject', overlap: { notAfter: Date.UTC(2026, 9, 25, 1, 40) } }),
    '2026-10-25T02:30:00.000Z',
    '2026-10-25T01:30:00.000Z',
  ],
  // PEGELONLINE JSON: true local offset.
  ['PEGELONLINE +02:00', ISO, '2026-09-23T21:45:00+02:00', '2026-09-23T19:45:00.000Z'],
  ['PEGELONLINE +01:00', ISO, '2026-11-15T21:45:00+01:00', '2026-11-15T20:45:00.000Z'],
  ['PEGELONLINE first pass of the repeated hour', ISO, '2026-10-25T02:15:00+02:00', '2026-10-25T00:15:00.000Z'],
  ['PEGELONLINE second pass of the repeated hour', ISO, '2026-10-25T02:15:00+01:00', '2026-10-25T01:15:00.000Z'],
  ["ISO with Z (Hub'Eau)", ISO, '2026-09-23T19:40:00Z', '2026-09-23T19:40:00.000Z'],
  ['ISO without seconds', ISO, '2026-09-23T21:45+02:00', '2026-09-23T19:45:00.000Z'],
  ['hydrodaten +02:00 with fractions', ISO, '2026-09-23T21:40:00.000+02:00', '2026-09-23T19:40:00.000Z'],
  // LINDAS and NRW: fixed +01:00.
  ['LINDAS fixed +01:00', RWS, '2026-07-01T12:00:00+01:00', '2026-07-01T11:00:00.000Z'],
  // Offset-less local times.
  ['LU-1 CSV summer', local('Europe/Luxembourg', REJECT), '23.09.2026 21:45', '2026-09-23T19:45:00.000Z'],
  ['LU-1 CSV winter', local('Europe/Luxembourg', REJECT), '15.01.2027 08:15', '2027-01-15T07:15:00.000Z'],
  ['LHP feature summer', local('Europe/Berlin', REJECT), '2026-09-23 21:45:00', '2026-09-23T19:45:00.000Z'],
  ['Berlin winter, ISO T', local('Europe/Berlin', REJECT), '2026-12-24T18:00:00', '2026-12-24T17:00:00.000Z'],
  ['Zurich summer', local('Europe/Zurich', REJECT), '2026-06-21T12:00', '2026-06-21T10:00:00.000Z'],
  [
    'Zurich repeated hour, second',
    local('Europe/Zurich', { gap: 'reject', overlap: 'later' }),
    '2026-10-25 02:45',
    '2026-10-25T01:45:00.000Z',
  ],
  // Spring forward 2027-03-28: 02:00–02:59 does not exist.
  [
    'gap shifted forward',
    local('Europe/Berlin', { gap: 'shift-forward', overlap: 'reject' }),
    '2027-03-28 02:30',
    '2027-03-28T01:30:00.000Z',
  ],
  ['hour after the gap', local('Europe/Berlin', REJECT), '2027-03-28 03:00', '2027-03-28T01:00:00.000Z'],
  ['minute before the gap', local('Europe/Berlin', REJECT), '2027-03-28 01:59', '2027-03-28T00:59:00.000Z'],
  // Epoch and .NET dates.
  ['epoch ms', { kind: 'epoch-ms' }, 1790199000000, '2026-09-23T21:30:00.000Z'],
  ['epoch ms as text', { kind: 'epoch-ms' }, '1790199000000', '2026-09-23T21:30:00.000Z'],
  ['NLWKN DatumUTC', { kind: 'dotnet-date' }, '/Date(1790199000000)/', '2026-09-23T21:30:00.000Z'],
  [
    '.NET date with a (meaningless) suffix',
    { kind: 'dotnet-date' },
    '/Date(1790199000000+0000)/',
    '2026-09-23T21:30:00.000Z',
  ],
  // BfG 14-day CSV: "GMT+1", start of the interval, all year.
  [
    'BfG start of interval, summer',
    { kind: 'start-of-interval', offset: '+01:00' },
    '23.09.2026 00:00',
    '2026-09-22T23:00:00.000Z',
  ],
  [
    'BfG start of interval, winter',
    { kind: 'start-of-interval', offset: '+01:00' },
    '01.01.2027 00:00',
    '2026-12-31T23:00:00.000Z',
  ],
];

describe('known instants', () => {
  it('has at least 30 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CASES)('%s', (_name, convention, raw, expected) => {
    expect(toIso(parseInstant(convention, raw))).toBe(expected);
  });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TimeError) return err.code;
    throw err;
  }
  return 'no error';
};

describe('refusals', () => {
  it('never parses an ISO time without an offset as UTC', () => {
    expect(code(() => parseInstant(ISO, '2026-09-23T21:45:00'))).toBe('bad_format');
    expect(code(() => parseInstant(ISO, '2026-09-23 21:45:00+02:00'))).toBe('bad_format');
    expect(code(() => parseInstant(ISO, 1790199000000))).toBe('bad_format');
  });

  it('refuses an offset other than the declared fixed one', () => {
    expect(code(() => parseInstant(RWS, '2026-09-23T20:50:00.000+02:00'))).toBe('offset_mismatch');
    expect(code(() => parseInstant(RWS, '2026-09-23T20:50:00.000Z'))).toBe('offset_mismatch');
  });

  it('refuses the repeated hour and the missing hour unless the adapter declared a rule', () => {
    expect(code(() => parseInstant(amsterdamZ(REJECT), '2026-10-25T02:30:00.000Z'))).toBe('dst_overlap');
    expect(code(() => parseInstant(local('Europe/Berlin', REJECT), '2027-03-28 02:30'))).toBe('dst_gap');
    // A collection time before both occurrences cannot disambiguate.
    const early = amsterdamZ({ gap: 'reject', overlap: { notAfter: Date.UTC(2026, 9, 25, 0, 10) } });
    expect(code(() => parseInstant(early, '2026-10-25T02:30:00.000Z'))).toBe('dst_overlap');
  });

  it('refuses impossible dates, a local-labelled-Z value without Z and out-of-range instants', () => {
    expect(code(() => parseInstant(local('Europe/Berlin', REJECT), '2026-02-30 10:00'))).toBe('bad_format');
    expect(code(() => parseInstant(local('Europe/Berlin', REJECT), '31.04.2026 10:00'))).toBe('bad_format');
    expect(code(() => parseInstant(amsterdamZ(REJECT), '2026-09-23T21:30:00.000'))).toBe('bad_format');
    expect(code(() => parseInstant({ kind: 'epoch-ms' }, 1e15))).toBe('out_of_range');
    expect(code(() => parseInstant({ kind: 'epoch-ms' }, '12.5'))).toBe('out_of_range');
    expect(code(() => parseInstant({ kind: 'dotnet-date' }, 'Date(1)'))).toBe('bad_format');
    expect(code(() => parseInstant(ISO, '0001-01-01T00:00:00Z'))).toBe('out_of_range');
  });

  it('rejects a timestamp more than 15 minutes ahead of the fetch (invariant 4)', () => {
    const fetched = Date.UTC(2026, 8, 23, 19, 50);
    expect(isFuture(fetched + 15 * 60_000, fetched)).toBe(false);
    expect(isFuture(fetched + 15 * 60_000 + 1, fetched)).toBe(true);
    expect(isFuture(fetched - 1, fetched)).toBe(false);
  });
});
