import type { ForecastRun } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { holdForecasts } from '../src/forecast-hold.ts';

const H = 3_600_000;
const T0 = Date.parse('2026-10-26T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function run(over: Partial<ForecastRun> & Pick<ForecastRun, 'series' | 'source'>, hours: number[]): ForecastRun {
  return {
    agency: over.source === 'NL-1' ? 'RWS' : 'BAFU',
    issuedAt: iso(T0 - H),
    issuedInferred: false,
    fetchedAt: iso(T0 - H),
    providerSegmentEnd: null,
    kind: 'deterministic',
    stepSeconds: 3600,
    validTs: hours.map((h) => iso(T0 + h * H)),
    value: hours.map((h) => 100 + h),
    band: null,
    flags: hours.map(() => 0),
    ...over,
  };
}

describe('holdForecasts (P9a, the web fallback of a future snapshot)', () => {
  it('holds the value at the greatest valid time ≤ t, never interpolated, nothing past the last point', () => {
    const runs = [run({ series: 1, source: 'NL-1' }, [0, 1, 2, 3])];
    expect(holdForecasts(runs, T0 + 1.5 * H)[0]).toMatchObject({
      ts: iso(T0 + H),
      value: 101,
      horizonEnd: iso(T0 + 3 * H),
    });
    expect(holdForecasts(runs, T0 + 3 * H)[0]?.value).toBe(103);
    expect(holdForecasts(runs, T0 + 3 * H + 1)).toEqual([]);
    expect(holdForecasts(runs, T0 - 1)).toEqual([]);
  });

  it('takes one source per series by FORECAST_PRECEDENCE and never blends', () => {
    const runs = [run({ series: 7, source: 'CH-4' }, [0, 1, 2]), run({ series: 7, source: 'NL-1' }, [0, 1])];
    expect(holdForecasts(runs, T0 + H).map((h) => h.source)).toEqual(['NL-1']);
    // NL-1 does not reach t: the next source shows.
    expect(holdForecasts(runs, T0 + 2 * H).map((h) => h.source)).toEqual(['CH-4']);
  });

  it('a below-floor point has no number, a band only where its pair is stated, an estimate past the segment', () => {
    const r = run(
      {
        series: 3,
        source: 'NL-1',
        providerSegmentEnd: iso(T0 + H),
        flags: [0, 1024, 0],
        value: [1, null, 3],
        band: {
          kind: 'p10p90',
          p10: [0, null, 2],
          p90: [2, null, null],
          p25: null,
          p75: null,
          p30: null,
          p70: null,
          vmin: null,
          vmax: null,
        },
      },
      [0, 1, 2],
    );
    expect(holdForecasts([r], T0)[0]).toMatchObject({
      value: 1,
      band: { kind: 'p10p90', lo: 0, hi: 2 },
      estimate: false,
    });
    expect(holdForecasts([r], T0 + H)[0]).toMatchObject({ value: null, band: null, flags: 1024 });
    expect(holdForecasts([r], T0 + 2 * H)[0]).toMatchObject({ value: 3, band: null, estimate: true });
  });

  it('orders by series', () => {
    const runs = [run({ series: 9, source: 'NL-1' }, [0]), run({ series: 2, source: 'NL-1' }, [0])];
    expect(holdForecasts(runs, T0).map((h) => h.series)).toEqual([2, 9]);
  });
});
