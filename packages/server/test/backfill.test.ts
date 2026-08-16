/**
 * Backfill planning and tiering tests. Pure logic, no network, no database.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { monthsBetween, windowFor } from '../src/backfill/plan.js';
import { isDeferred, tierFor } from '../src/backfill/tiers.js';

const ORIGINAL_DEFERRED = process.env['BACKFILL_DEFERRED'];

afterEach(() => {
  if (ORIGINAL_DEFERRED === undefined) delete process.env['BACKFILL_DEFERRED'];
  else process.env['BACKFILL_DEFERRED'] = ORIGINAL_DEFERRED;
});

describe('monthsBetween', () => {
  it('enumerates whole months across a year', () => {
    const months = monthsBetween(new Date('2025-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    expect(months).toHaveLength(12);
    expect(months[0]!.toISOString()).toBe('2025-09-01T00:00:00.000Z');
    expect(months.at(-1)!.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('snaps a mid-month start back to the start of that month', () => {
    // Otherwise the first chunk would silently omit the days before `from`.
    const months = monthsBetween(new Date('2026-03-17T13:00:00Z'), new Date('2026-05-01T00:00:00Z'));
    expect(months.map((m) => m.toISOString().slice(0, 7))).toEqual(['2026-03', '2026-04']);
  });

  it('spans the March DST transition without dropping or duplicating a month', () => {
    // Local-time arithmetic would drift here; UTC components do not.
    const months = monthsBetween(new Date('2026-02-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
    expect(months.map((m) => m.toISOString())).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
  });

  it('spans the October DST transition the same way', () => {
    const months = monthsBetween(new Date('2025-09-01T00:00:00Z'), new Date('2025-12-01T00:00:00Z'));
    expect(months.map((m) => m.toISOString())).toEqual([
      '2025-09-01T00:00:00.000Z',
      '2025-10-01T00:00:00.000Z',
      '2025-11-01T00:00:00.000Z',
    ]);
  });

  it('crosses a year boundary', () => {
    const months = monthsBetween(new Date('2025-11-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
    expect(months.map((m) => m.toISOString().slice(0, 7))).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('returns nothing for an empty or inverted range', () => {
    expect(monthsBetween(new Date('2026-05-01Z'), new Date('2026-05-01Z'))).toEqual([]);
    expect(monthsBetween(new Date('2026-06-01Z'), new Date('2026-05-01Z'))).toEqual([]);
  });

  it('handles February in a leap year', () => {
    const months = monthsBetween(new Date('2028-01-01T00:00:00Z'), new Date('2028-04-01T00:00:00Z'));
    expect(months.map((m) => m.toISOString().slice(0, 7))).toEqual(['2028-01', '2028-02', '2028-03']);
  });
});

describe('windowFor', () => {
  it('covers exactly one calendar month', () => {
    const w = windowFor(new Date('2026-01-01T00:00:00Z'));
    expect(w.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('handles short months without spilling into the wrong one', () => {
    const w = windowFor(new Date('2026-02-01T00:00:00Z'));
    expect(w.to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('rolls over a year boundary', () => {
    const w = windowFor(new Date('2026-12-01T00:00:00Z'));
    expect(w.to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('does not mutate the month it was given', () => {
    const month = new Date('2026-06-01T00:00:00Z');
    windowFor(month);
    expect(month.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('tiles consecutive months without a gap', () => {
    const months = monthsBetween(new Date('2026-01-01Z'), new Date('2026-04-01Z'));
    const windows = months.map(windowFor);
    for (let i = 1; i < windows.length; i++) {
      // Each chunk starts exactly where the previous ended. Upstream treats
      // both endpoints as inclusive, so chunks overlap by one timestamp; the
      // idempotent upsert makes that harmless.
      expect(windows[i]!.from.toISOString()).toBe(windows[i - 1]!.to.toISOString());
    }
  });
});

describe('tiering', () => {
  it('defers the three high-volume quantities that a map panel rarely needs', () => {
    // Together ~31% of sampled volume; see spike/PHASE1-FINDINGS.md.
    for (const q of ['STROOMRTG', 'STROOMSHD', 'ECHO']) {
      expect(isDeferred(q), q).toBe(true);
    }
  });

  it('keeps water level and discharge eager, and first in line', () => {
    expect(tierFor('WATHTE')).toEqual({ tier: 'eager', priority: 10 });
    expect(tierFor('Q')).toEqual({ tier: 'eager', priority: 10 });
  });

  it('treats chemistry as eager, since the counts showed it is cheap', () => {
    expect(isDeferred('CONCTTE')).toBe(false);
    expect(isDeferred('O2')).toBe(false);
  });

  it('sorts eager work ahead of deferred work', () => {
    expect(tierFor('WATHTE').priority).toBeLessThan(tierFor('ECHO').priority);
    expect(tierFor('CONCTTE').priority).toBeLessThan(tierFor('ECHO').priority);
  });

  it('orders the charted quantities ahead of the rest of the eager tier', () => {
    expect(tierFor('WATHTE').priority).toBeLessThan(tierFor('CONCTTE').priority);
    expect(tierFor('T').priority).toBeLessThan(tierFor('CONCTTE').priority);
  });

  it('can be overridden from the environment without editing code', () => {
    process.env['BACKFILL_DEFERRED'] = 'WATHTE';
    expect(isDeferred('WATHTE')).toBe(true);
    expect(isDeferred('ECHO')).toBe(false);
  });

  it('treats an empty override as "defer nothing", i.e. a full eager backfill', () => {
    process.env['BACKFILL_DEFERRED'] = '';
    for (const q of ['STROOMRTG', 'STROOMSHD', 'ECHO']) {
      expect(isDeferred(q), q).toBe(false);
    }
  });
});
