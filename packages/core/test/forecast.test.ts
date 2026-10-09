import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CanonRun,
  checkRun,
  checkRunCount,
  encodeRun,
  FORECAST_FLAGS,
  FORECAST_SOURCES,
  type ForecastRunIn,
  type ForecastSourceDecl,
  isCurrent,
  isTail,
  MAX_ISSUE_AGE_MS,
  MAX_LEAD_MS,
  MAX_RUN_POINTS,
  mergeDecision,
  orderBroken,
  SchemaDrift,
  type StoredRun,
} from '../src/index.ts';

const FETCH = Date.parse('2026-09-29T13:43:00Z');
const NL1 = FORECAST_SOURCES['NL-1'];
const STEP = 10 * 60_000;

const run = (points: ForecastRunIn['points'], over: Partial<ForecastRunIn> = {}): ForecastRunIn => ({
  series: 's',
  kind: 'deterministic',
  stepMs: STEP,
  issuedAt: null,
  providerSegmentEnd: null,
  points,
  ...over,
});
/** n points from `from` every 10 minutes, value = base + i. */
const steps = (from: string, n: number, base = 100) =>
  Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.parse(from) + i * STEP).toISOString(),
    value: base + i,
    flags: 0,
  }));
const canon = (r: ForecastRunIn, fetched = FETCH): CanonRun => {
  const c = checkRun(r, fetched, NL1).run;
  if (c === null) throw new Error('no run');
  return c;
};
const hex = (r: CanonRun) => Buffer.from(encodeRun(r)).toString('hex');
const stored = (r: CanonRun, id: string): StoredRun => ({ ...r, id, hash: hex(r) });
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SchemaDrift) return err.code;
    throw err;
  }
  return 'none';
};

describe('checkRun', () => {
  it('turns a run into UTC, float32, sorted points', () => {
    const c = canon(run([{ ts: '2026-09-29T15:50:00+01:00', value: 0.1, flags: 0 }, ...steps('2026-09-29T14:40Z', 1)]));
    expect(c.points.map((p) => p.ms)).toEqual([Date.parse('2026-09-29T14:40Z'), Date.parse('2026-09-29T14:50Z')]);
    expect(c.points[1]?.v[0]).toBe(Math.fround(0.1));
    expect(c.issuedAt).toBeNull();
  });

  it('refuses a provider issue time more than 30 days before the fetch (review SEC-1 of P8b)', () => {
    const at = (days: number) => new Date(FETCH - days * 24 * 3_600_000).toISOString();
    const points = steps('2026-09-29T14:00Z', 2);
    expect(codeOf(() => checkRun(run(points, { issuedAt: at(30) }), FETCH, FORECAST_SOURCES['FR-4']))).toBe('none');
    expect(codeOf(() => checkRun(run(points, { issuedAt: at(31) }), FETCH, FORECAST_SOURCES['FR-4']))).toBe(
      'stale_issue',
    );
    expect(codeOf(() => checkRun(run(points, { issuedAt: '1970-01-01T00:00:00Z' }), FETCH, NL1))).toBe('stale_issue');
  });

  it('refuses a provider issue time more than 15 minutes after the fetch', () => {
    const at = (min: number) => new Date(FETCH + min * 60_000).toISOString();
    expect(codeOf(() => checkRun(run(steps('2026-09-29T14:00Z', 2), { issuedAt: at(16) }), FETCH, NL1))).toBe(
      'future_issue',
    );
    expect(codeOf(() => checkRun(run(steps('2026-09-29T14:00Z', 2), { issuedAt: at(15) }), FETCH, NL1))).toBe('none');
  });

  it('refuses a non-finite or absurd value, bad flags, a duplicate instant and too many points', () => {
    const one = (p: Record<string, unknown>) => () =>
      checkRun(run([{ ts: '2026-09-29T14:00Z', flags: 0, ...p } as never]), FETCH, NL1);
    expect(codeOf(one({ value: Number.NaN }))).toBe('bad_value');
    expect(codeOf(one({ value: Number.POSITIVE_INFINITY }))).toBe('bad_value');
    expect(codeOf(one({ p90: 1e8 }))).toBe('bad_value');
    expect(codeOf(one({ value: 1, flags: 2 }))).toBe('bad_flags');
    expect(codeOf(one({ value: 1, flags: -1 }))).toBe('bad_flags');
    expect(codeOf(one({ ts: 'yesterday', value: 1 }))).toBe('bad_time');
    expect(
      codeOf(() => checkRun(run([...steps('2026-09-29T14:00Z', 1), ...steps('2026-09-29T14:00Z', 1)]), FETCH, NL1)),
    ).toBe('duplicate_ts');
    expect(codeOf(() => checkRun(run(steps('2026-09-29T14:00Z', MAX_RUN_POINTS + 1)), FETCH, NL1))).toBe(
      'forecast_points',
    );
    expect(codeOf(() => checkRun(run(steps('2026-09-29T14:00Z', 1), { stepMs: 0 }), FETCH, NL1))).toBe('bad_step');
    expect(codeOf(() => checkRunCount(Array.from({ length: 51 })))).toBe('forecast_runs');
    expect(codeOf(() => checkRunCount(Array.from({ length: 50 })))).toBe('none');
  });

  it('drops points past the horizon (from the issue time, else the fetch) and gaps; an empty run is none', () => {
    const limit = FETCH + 49 * 3_600_000;
    const out = checkRun(
      run([
        { ts: new Date(limit).toISOString(), value: 1, flags: 0 },
        { ts: new Date(limit + 60_000).toISOString(), value: 2, flags: 0 },
        { ts: '2026-09-29T14:00Z', value: null, flags: 0 },
      ]),
      FETCH,
      NL1,
    );
    expect(out.run?.points.length).toBe(1);
    expect(out.dropped).toEqual({ beyond_horizon: 1, gap: 1 });
    const issued = new Date(FETCH - 3 * 3_600_000).toISOString();
    expect(
      checkRun(run([{ ts: new Date(limit).toISOString(), value: 1, flags: 0 }], { issuedAt: issued }), FETCH, NL1)
        .dropped,
    ).toEqual({ beyond_horizon: 1, empty_run: 1 });
  });

  it('drops points more than two days before the issue time, else the fetch (review SEC-1)', () => {
    const floor = FETCH - MAX_LEAD_MS;
    const at = (ms: number, value = 1) => ({ ts: new Date(ms).toISOString(), value, flags: 0 });
    const out = checkRun(run([at(floor - 60_000), at(floor), at(Date.parse('2016-09-29T14:00Z'))]), FETCH, NL1);
    expect(out.run?.points.map((p) => p.ms)).toEqual([floor]);
    expect(out.dropped).toEqual({ before_window: 2 });
    // a provider issue time moves the floor with it
    const issued = FETCH - 3 * 3_600_000;
    expect(
      checkRun(run([at(issued - MAX_LEAD_MS - 1)], { issuedAt: new Date(issued).toISOString() }), FETCH, NL1).dropped,
    ).toEqual({ before_window: 1, empty_run: 1 });
  });

  it('DE-3 keeps leading past days up to its own 4-day allowance (issue #79); every other source keeps two days', () => {
    const DE3 = FORECAST_SOURCES['DE-3'];
    const day = 24 * 3_600_000;
    const at = (ms: number) => ({ ts: new Date(ms).toISOString(), value: 1, flags: 0 });
    const out = checkRun(
      run([at(FETCH - 3 * day), at(FETCH - 4 * day), at(FETCH - 4 * day - 1), at(FETCH)]),
      FETCH,
      DE3,
    );
    expect(out.run?.points.map((p) => p.ms)).toEqual([FETCH - 4 * day, FETCH - 3 * day, FETCH]);
    expect(out.dropped).toEqual({ before_window: 1 });
    // the same first row is still dropped for a source without an allowance
    expect(checkRun(run([at(FETCH - 3 * day), at(FETCH)]), FETCH, NL1).dropped).toEqual({ before_window: 1 });
  });

  it('every leadMs is a positive finite bound no wider than MAX_ISSUE_AGE_MS (review S1)', () => {
    for (const d of Object.values(FORECAST_SOURCES) as ForecastSourceDecl[]) {
      const { leadMs } = d;
      expect(leadMs === undefined || (Number.isFinite(leadMs) && leadMs > 0 && leadMs <= MAX_ISSUE_AGE_MS)).toBe(true);
    }
    expect(Object.values(FORECAST_SOURCES).filter((d) => 'leadMs' in d)).toHaveLength(1);
  });
});

describe('quantile order and censored points (P8b)', () => {
  const { ORDER, CENSORED } = FORECAST_FLAGS;
  const one = (p: Record<string, number | null>, flags = 0) =>
    checkRun(run([{ ts: '2026-09-29T14:00Z', flags, ...p }], { kind: 'quantiles' }), FETCH, NL1);
  const flagsOf = (p: Record<string, number | null>, flags = 0) => one(p, flags).run?.points[0]?.flags;

  it('sets ORDER when present quantiles decrease or p50 leaves [vmin, vmax]; values are kept as published', () => {
    expect(flagsOf({ p10: 1, p50: 2, p90: 3 })).toBe(0);
    expect(flagsOf({ p10: 1, p50: 1, p90: 1 })).toBe(0);
    expect(flagsOf({ p10: 2, p50: 1, p90: 3 })).toBe(ORDER);
    expect(flagsOf({ p05: 5, p95: 4 })).toBe(ORDER);
    expect(flagsOf({ p25: 1, p30: 3, p70: 2 })).toBe(ORDER);
    expect(flagsOf({ vmin: 1, p50: 2, vmax: 3 })).toBe(0);
    expect(flagsOf({ vmin: 3, p50: 2, vmax: 4 })).toBe(ORDER);
    expect(flagsOf({ vmin: 1, p50: 5, vmax: 4 })).toBe(ORDER);
    expect(flagsOf({ vmin: 5, vmax: 4 })).toBe(ORDER);
    expect(flagsOf({ value: 9, p25: 1, p75: 2 })).toBe(0);
    expect(flagsOf({ p10: 2, p50: 1 }, ORDER)).toBe(ORDER);
    expect(one({ p10: 2, p50: 1, p90: 3 }).run?.points[0]?.v.slice(2, 6)).toEqual([2, null, null, 1]);
  });

  it('keeps a point with no value when the provider censored it (DE-3 `---`); without CENSORED it is a gap', () => {
    expect(one({ p50: null }, CENSORED).run?.points[0]).toMatchObject({ flags: CENSORED });
    expect(one({ p50: null }).dropped).toEqual({ gap: 1, empty_run: 1 });
  });

  it('property: ORDER is set exactly when a present pair is inverted; the values are byte-identical', () => {
    const cols = ['p05', 'p10', 'p25', 'p30', 'p50', 'p70', 'p75', 'p90', 'p95', 'vmin', 'vmax'] as const;
    const cell = fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null });
    fc.assert(
      fc.property(fc.tuple(...cols.map(() => cell)), fc.boolean(), (cells, pre) => {
        const p = Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? null]));
        if (cells.every((x) => x === null)) return;
        const out = one(p, pre ? ORDER : 0).run?.points[0];
        const q = cells.slice(0, 9).filter((x) => x !== null) as number[];
        const [lo, mid, hi] = [p.vmin ?? null, p.p50 ?? null, p.vmax ?? null];
        const inverted =
          q.some((x, i) => q.slice(i + 1).some((y) => y < x)) ||
          (lo !== null && mid !== null && lo > mid) ||
          (mid !== null && hi !== null && mid > hi) ||
          (lo !== null && hi !== null && lo > hi);
        expect(((out?.flags ?? 0) & ORDER) !== 0).toBe(inverted || pre);
        expect(out?.v.slice(1)).toEqual(
          cols
            .map((c) => p[c] ?? null)
            .slice(0, 4)
            .concat([
              p.p50 ?? null,
              p.p70 ?? null,
              p.p75 ?? null,
              p.p90 ?? null,
              p.p95 ?? null,
              p.vmin ?? null,
              p.vmax ?? null,
            ]),
        );
        expect(orderBroken(out?.v ?? [])).toBe(inverted);
      }),
    );
  });
});

describe('encodeRun', () => {
  const base = steps('2026-10-25T00:00Z', 3);
  const canon = (r: ForecastRunIn): CanonRun => checkRun(r, Date.parse('2026-10-25T00:00Z'), NL1).run as CanonRun;
  it('is the same for the same instants in another offset, another point order, -0 and float32 neighbours', () => {
    const a = canon(run(base));
    const b = canon(
      run([
        { ts: '2026-10-25T02:20:00+02:00', value: 102, flags: 0 },
        { ts: '2026-10-25T01:00:00+01:00', value: 100, flags: 0 },
        { ts: '2026-10-25T00:10:00.000Z', value: Math.fround(101) + 1e-9, flags: 0 },
      ]),
    );
    expect(hex(a)).toBe(hex(b));
    const zero = (v: number) => hex(canon(run([{ ts: '2026-10-25T00:00Z', value: v, flags: 0 }])));
    expect(zero(-0)).toBe(zero(0));
  });

  it('changes with any column, the flags, the header and absence versus zero', () => {
    const a = hex(canon(run(base)));
    expect(hex(canon(run(base.map((p, i) => (i === 1 ? { ...p, p70: 3 } : p)))))).not.toBe(a);
    expect(hex(canon(run(base.map((p, i) => (i === 2 ? { ...p, flags: FORECAST_FLAGS.ESTIMATE } : p)))))).not.toBe(a);
    expect(hex(canon(run(base, { issuedAt: '2026-10-24T23:00Z' })))).not.toBe(a);
    expect(hex(canon(run(base, { providerSegmentEnd: '2026-10-25T00:10Z' })))).not.toBe(a);
    expect(hex(canon(run(base, { stepMs: 2 * STEP })))).not.toBe(a);
    expect(hex(canon(run(base, { kind: 'quantiles' })))).not.toBe(a);
    const v0 = hex(canon(run([{ ts: '2026-10-25T00:00Z', value: 1, p10: 0, flags: 0 }])));
    expect(hex(canon(run([{ ts: '2026-10-25T00:00Z', value: 1, p10: null, flags: 0 }])))).not.toBe(v0);
  });
});

describe('mergeDecision', () => {
  const capture = (from: string, n: number, base = 100) => canon(run(steps(from, n, base)));
  const c1 = capture('2026-09-29T14:40Z', 10);
  // the next hour's capture of the same run: six leading values fewer, the rest identical
  const c2 = canon(run(steps('2026-09-29T14:40Z', 10).slice(6)));

  it('a capture that is the tail of a stored run is that run, both ways round', () => {
    expect(isTail(c1, c2)).toBe(true);
    expect(isTail(c2, c1)).toBe(false);
    expect(mergeDecision([stored(c1, '1')], c2, hex(c2), true)).toEqual({ kind: 'same', id: '1' });
    const ext = mergeDecision([stored(c2, '2')], c1, hex(c1), true);
    expect(ext.kind).toBe('extend');
    if (ext.kind === 'extend') {
      expect(ext.id).toBe('2');
      expect(ext.add.map((p) => p.ms)).toEqual(c1.points.slice(0, 6).map((p) => p.ms));
    }
  });

  it('the same key is the same run; a source without head drops never merges a tail', () => {
    expect(mergeDecision([stored(c1, '1')], c1, hex(c1), false)).toEqual({ kind: 'same', id: '1' });
    expect(mergeDecision([stored(c1, '1')], c2, hex(c2), false)).toEqual({ kind: 'insert' });
    expect(mergeDecision([stored(c2, '2')], c1, hex(c1), false)).toEqual({ kind: 'insert' });
  });

  it('never merges runs that differ on their overlap, end differently or state another issue time', () => {
    const other = canon(
      run(
        steps('2026-09-29T14:40Z', 10)
          .map((p, i) => (i === 8 ? { ...p, value: 1 } : p))
          .slice(6),
      ),
    );
    expect(mergeDecision([stored(c1, '1')], other, hex(other), true)).toEqual({ kind: 'insert' });
    const longer = capture('2026-09-29T15:40Z', 5);
    expect(mergeDecision([stored(c1, '1')], longer, hex(longer), true)).toEqual({ kind: 'insert' });
    const issued = canon(run(steps('2026-09-29T14:40Z', 10).slice(6), { issuedAt: '2026-09-29T13:00Z' }));
    expect(mergeDecision([stored(c1, '1')], issued, hex(issued), true)).toEqual({ kind: 'insert' });
  });

  it('a tail of two stored runs changes nothing', () => {
    // two runs that end alike and differ only before the incoming capture's first valid time
    const a = canon(run(steps('2026-09-29T14:40Z', 10).map((p, i) => (i === 0 ? { ...p, value: 1 } : p))));
    expect(mergeDecision([stored(a, '1'), stored(c1, '3')], c2, hex(c2), true)).toEqual({ kind: 'ambiguous' });
  });
});

describe('isCurrent', () => {
  const r = { source: 'DE-2', lastValid: 100, issued: 0 };
  it('needs the run to reach t and its source not to say it was superseded', () => {
    expect(isCurrent(r, 100, 50)).toBe(true);
    expect(isCurrent(r, 101, 50)).toBe(false);
    expect(isCurrent(r, 50, 50, () => true)).toBe(false);
    expect(isCurrent(r, 50, 50, () => false)).toBe(true);
  });
});
