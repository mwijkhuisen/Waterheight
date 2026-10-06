import { describe, expect, it } from 'vitest';
import { readRegistry } from '../apps/server/src/load/registry-sync.ts';

// P10a (plan C3): the at-t functions return a value only while ts > t − staleness_limit, so the page never sees an
// older one. A value older than 25 hours is hidden on the map (A§10) only because no series carries a value that
// long: if a limit above 25 h is ever registered, the web must hide on `ageSeconds > 90000` itself.

describe('registry staleness limits', () => {
  it('every series carries its last value at most 25 hours', () => {
    const rows = readRegistry().stations;
    expect(rows.length).toBeGreaterThan(1000);
    const over = rows.filter((r) => Temporal.Duration.from(r.staleness_limit).total('hours') > 25).map((r) => r.id);
    expect(over).toEqual([]);
  });
});
