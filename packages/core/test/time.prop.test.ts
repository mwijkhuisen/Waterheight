import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { durationMs, parseInstant, type TimeConvention, TimeError, toIso } from '../src/index.ts';

const ZONES = ['Europe/Amsterdam', 'Europe/Berlin', 'Europe/Luxembourg', 'Europe/Zurich'] as const;
const MINUTE = 60_000;

// Whole minutes between 2020 and 2035 (the span with settled EU DST rules).
const instant = fc
  .integer({ min: Date.UTC(2020, 0, 1) / MINUTE, max: Date.UTC(2035, 0, 1) / MINUTE })
  .map((m) => m * MINUTE);
const zone = fc.constantFrom(...ZONES);

/** EU rule, the same in all four zones: the last Sunday of March (month 2) and October (9), at 01:00 UTC. */
const lastSunday = (year: number, month: number) => {
  const d = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, d.getUTCDate() - d.getUTCDay(), 1);
};
/** Half of the runs within two hours of a transition, so the repeated and the missing hour come up often. */
const nearTransition = fc
  .tuple(fc.integer({ min: 2020, max: 2034 }), fc.constantFrom(2, 9), fc.integer({ min: -120, max: 120 }))
  .map(([year, month, minutes]) => lastSunday(year, month) + minutes * MINUTE);
const dstInstant = fc.oneof(instant, nearTransition);

const wallClock = (ms: number, z: string) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(z);
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const naiveIso = (z: Temporal.ZonedDateTime) =>
  `${pad(z.year, 4)}-${pad(z.month)}-${pad(z.day)}T${pad(z.hour)}:${pad(z.minute)}:${pad(z.second)}`;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TimeError) return err.code;
    throw err;
  }
  return 'ok';
};

describe('time parsers round-trip', () => {
  it('iso-offset: an instant printed with any zone offset parses back to itself', () => {
    fc.assert(
      fc.property(instant, zone, (ms, z) => {
        const text = wallClock(ms, z).toString({ timeZoneName: 'never' });
        expect(parseInstant({ kind: 'iso-offset' }, text)).toBe(ms);
      }),
    );
  });

  it('fixed-offset: a +01:00 rendering parses back; every other offset is refused', () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: -12, max: 14 }), (ms, hours) => {
        const offset = `${hours < 0 ? '-' : '+'}${pad(Math.abs(hours))}:00`;
        const text = `${naiveIso(wallClock(ms + hours * 3_600_000, 'UTC'))}${offset}`;
        const result = codeOf(() => expect(parseInstant({ kind: 'fixed-offset', offset: '+01:00' }, text)).toBe(ms));
        expect(result).toBe(hours === 1 ? 'ok' : 'offset_mismatch');
      }),
    );
  });

  it('epoch-ms, dotnet-date and toIso round-trip', () => {
    fc.assert(
      fc.property(instant, (ms) => {
        expect(parseInstant({ kind: 'epoch-ms' }, ms)).toBe(ms);
        expect(parseInstant({ kind: 'dotnet-date' }, `/Date(${ms})/`)).toBe(ms);
        expect(parseInstant({ kind: 'iso-offset' }, toIso(ms))).toBe(ms);
      }),
    );
  });

  it('start-of-interval at +01:00 is one hour ahead of UTC all year', () => {
    fc.assert(
      fc.property(instant, (ms) => {
        const text = naiveIso(wallClock(ms + 3_600_000, 'UTC')).replace('T', ' ');
        expect(parseInstant({ kind: 'start-of-interval', offset: '+01:00' }, text)).toBe(ms);
      }),
    );
  });
});

describe('DST is handled explicitly in Amsterdam, Berlin, Luxembourg and Zurich', () => {
  const conventions = (z: string, dst: Parameters<typeof dstConvention>[1]) => dstConvention(z, dst);
  function dstConvention(z: string, dst: Extract<TimeConvention, { kind: 'naive-local' }>['dst']): TimeConvention[] {
    return [
      { kind: 'naive-local', zone: z, dst },
      { kind: 'local-labelled-z', zone: z, dst },
    ];
  }
  const render = (c: TimeConvention, text: string) => (c.kind === 'local-labelled-z' ? `${text}Z` : text);

  it('every real instant is recovered from its wall-clock time once the overlap rule names the occurrence', () => {
    let repeated = 0;
    fc.assert(
      fc.property(dstInstant, zone, (ms, z) => {
        const local = wallClock(ms, z);
        // The same wall-clock time one hour later/earlier tells which occurrence this is.
        const twin = [ms - 3_600_000, ms + 3_600_000].find(
          (other) => naiveIso(wallClock(other, z)) === naiveIso(local),
        );
        const overlap = twin === undefined ? 'reject' : twin > ms ? 'earlier' : 'later';
        for (const c of conventions(z, { gap: 'reject', overlap })) {
          expect(parseInstant(c, render(c, naiveIso(local)))).toBe(ms);
        }
        if (twin !== undefined) {
          repeated += 1;
          for (const c of conventions(z, { gap: 'reject', overlap: 'reject' })) {
            expect(codeOf(() => parseInstant(c, render(c, naiveIso(local))))).toBe('dst_overlap');
          }
          // A trusted "not after" instant picks the same occurrence.
          for (const c of conventions(z, { gap: 'reject', overlap: { notAfter: ms + 5 * MINUTE } })) {
            expect(parseInstant(c, render(c, naiveIso(local)))).toBe(ms);
          }
        }
      }),
      { numRuns: 300 },
    );
    // About one run in eight lands in a repeated hour (a plain uniform instant: one in 700).
    expect(repeated).toBeGreaterThan(10);
  });

  it.each(ZONES)('%s: the repeated hour of every autumn and the missing hour of every spring', (z) => {
    for (let year = 2024; year <= 2032; year++) {
      const back = lastSunday(year, 9);
      const forward = lastSunday(year, 2);
      for (const minute of [0, 15, 59]) {
        const text = `${year}-10-${pad(new Date(back).getUTCDate())}T02:${pad(minute)}:00`;
        const at = (overlap: 'earlier' | 'later' | 'reject') =>
          parseInstant({ kind: 'naive-local', zone: z, dst: { gap: 'reject', overlap } }, text);
        expect(at('earlier')).toBe(back - 3_600_000 + minute * MINUTE);
        expect(at('later')).toBe(back + minute * MINUTE);
        expect(codeOf(() => at('reject'))).toBe('dst_overlap');

        const missing = `${year}-03-${pad(new Date(forward).getUTCDate())}T02:${pad(minute)}:00`;
        const gap = (rule: 'reject' | 'shift-forward') =>
          parseInstant({ kind: 'naive-local', zone: z, dst: { gap: rule, overlap: 'reject' } }, missing);
        expect(codeOf(() => gap('reject'))).toBe('dst_gap');
        expect(gap('shift-forward')).toBe(forward + minute * MINUTE);
      }
    }
  });
});

describe('durations', () => {
  it('reads the registry durations', () => {
    expect(durationMs('PT1M')).toBe(60_000);
    expect(durationMs('PT15M')).toBe(900_000);
    expect(durationMs('PT45M')).toBe(2_700_000);
    expect(durationMs('PT6H')).toBe(21_600_000);
    expect(durationMs('P31D')).toBe(31 * 86_400_000);
    expect(durationMs('P1DT12H')).toBe(36 * 3_600_000);
    expect(durationMs('PT90S')).toBe(90_000);
  });

  it.each(['', 'P', 'PT', 'P1M', 'P1Y', 'PT0M', 'PT1.5H', '15M', 'P1DT'])('refuses %j', (bad) => {
    expect(() => durationMs(bad)).toThrow(TimeError);
  });
});
