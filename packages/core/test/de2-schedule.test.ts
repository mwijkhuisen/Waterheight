import { describe, expect, it } from 'vitest';
import {
  berlinDate,
  DE2_HOLIDAYS,
  DE2_HOLIDAYS_UNTIL,
  de2Deadline,
  de2Due,
  de2Late,
  de2Superseded,
  isCurrent,
} from '../src/index.ts';

const at = (iso: string) => Date.parse(iso);
const run = (issued: string, lastValid = '2026-12-31T00:00:00Z') => ({
  source: 'DE-2',
  issued: at(issued),
  lastValid: at(lastValid),
});

describe('the DE-2 schedule', () => {
  it('a deadline is 12:00 Europe/Berlin, in summer and winter time', () => {
    expect(de2Deadline('2026-10-02')).toBe(at('2026-10-02T10:00:00Z'));
    expect(de2Deadline('2026-10-26')).toBe(at('2026-10-26T11:00:00Z'));
    expect(berlinDate(at('2026-10-02T22:30:00Z'))).toBe('2026-10-03');
  });

  it('working days are due; weekends and holidays only while Ruhrort is below 4 m', () => {
    expect(de2Due('2026-10-02', 500)).toBe(true); // Friday
    expect(de2Due('2026-10-04', 400)).toBe(false); // Sunday, Ruhrort at 4 m
    expect(de2Due('2026-10-04', 399)).toBe(true);
    expect(de2Due('2026-10-04', null)).toBe(false);
    expect(de2Due('2026-05-14', 500)).toBe(false); // Ascension, a Thursday
    expect(de2Due('2026-06-04', 500)).toBe(false); // Corpus Christi (RLP)
    expect(de2Due('2026-11-02', 500)).toBe(true);
  });

  it('a weekend with Ruhrort at or above 4 m is silent; a working day without a new run fires', () => {
    // Friday's run, read on Sunday afternoon and on Monday morning: nothing was due
    expect(de2Late(at('2026-10-11T14:00:00Z'), at('2026-10-09T05:00:00Z'), 450)).toBeNull();
    expect(de2Late(at('2026-10-12T09:59:00Z'), at('2026-10-09T05:00:00Z'), 450)).toBeNull();
    // Monday noon has passed: Monday's run is missing
    expect(de2Late(at('2026-10-12T10:00:00Z'), at('2026-10-09T05:00:00Z'), 450)).toBe('2026-10-12');
    // the same weekend at low water: Saturday was due
    expect(de2Late(at('2026-10-10T10:00:00Z'), at('2026-10-09T05:00:00Z'), 300)).toBe('2026-10-10');
    // today's run arrived: nothing is late
    expect(de2Late(at('2026-10-12T10:00:00Z'), at('2026-10-12T05:00:00Z'), 450)).toBeNull();
  });

  it('a run past a missed deadline is not current: "no forecast", never the held run', () => {
    const friday = run('2026-10-09T05:00:00Z');
    const superseded = (r: typeof friday, now: number) => de2Superseded(r, now, 450);
    const sunday = at('2026-10-11T14:00:00Z');
    expect(isCurrent(friday, sunday, sunday, superseded)).toBe(true);
    const monday = at('2026-10-12T10:00:00Z');
    expect(isCurrent(friday, monday, monday, superseded)).toBe(false);
    // a run older than the look-back is superseded whatever the calendar says
    expect(de2Superseded(run('2026-09-01T05:00:00Z'), at('2026-12-27T12:00:00Z'), 450, [])).toBe(true);
  });

  it('the holiday list is sorted, distinct and ends inside its stated range', () => {
    expect([...DE2_HOLIDAYS].sort()).toEqual(DE2_HOLIDAYS);
    expect(new Set(DE2_HOLIDAYS).size).toBe(DE2_HOLIDAYS.length);
    expect((DE2_HOLIDAYS.at(-1) as string) <= DE2_HOLIDAYS_UNTIL).toBe(true);
  });
});
