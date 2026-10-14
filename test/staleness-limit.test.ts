import { describe, expect, it } from 'vitest';
import { Q7_LOOKBACK_MS } from '../apps/server/src/load/health.ts';
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

  // P14a fix: the Q7 gap scan reads obs only back to now − Q7_LOOKBACK_MS. Its 24 h form needs 24 h + one step, its
  // outage form one staleness limit + 24 h (or + one step), and no step may exceed a day.
  it('every step and staleness limit fits inside the Q7 lookback', () => {
    const rows = readRegistry().stations;
    const ms = (d: string) => Temporal.Duration.from(d).total('milliseconds');
    const step = Math.max(...rows.map((r) => ms(r.expected_step)));
    const stale = Math.max(...rows.map((r) => ms(r.staleness_limit)));
    expect(step).toBeLessThanOrEqual(86_400_000);
    expect(86_400_000 + step).toBeLessThanOrEqual(Q7_LOOKBACK_MS);
    expect(stale + Math.max(step, 86_400_000)).toBeLessThanOrEqual(Q7_LOOKBACK_MS);
  });
});
