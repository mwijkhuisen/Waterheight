import { describe, expect, it } from 'vitest';
import { classify, conventionHolds, type Family, type RefIn, type SeriesIn } from '../src/index.ts';

// Percentile conventions (catalogue C31, D18 addendum). SPW publishes non-exceedance percentiles (P90 > the mean),
// HIC exceedance percentiles (P10 > P90). The low tail is P05 for the first and P95 for the second. A set stored
// under the wrong convention must not classify, either way round.

const T = Date.UTC(2026, 5, 15, 12);
type Conv = 'exceedance' | 'non_exceedance';

const ref = (source: string, kind: string, value: number, convention: Conv | null): RefIn => ({
  source,
  kind,
  value,
  unit: 'cm',
  convention,
  period: null,
  seasonFrom: 101,
  seasonTo: 1231,
  priority: 0,
  label: null,
});
const series = (value: number, refs: RefIn[]): SeriesIn => ({
  quantity: 'H',
  valueKind: 'stage',
  value,
  qc: 0,
  ageMs: 0,
  stalenessMs: 3_600_000,
  t: T,
  refs,
  classes: [],
  areas: [],
  tidal: false,
  impounded: false,
});

// SPW-style: non-exceedance, rising with the percentile; MEDIAN and MOYEN (the mean) sit between P50 and P90.
const spw = (c: Conv | null = 'non_exceedance'): RefIn[] => [
  ref('BE-3', 'P05', 10, c),
  ref('BE-3', 'P10', 20, c),
  ref('BE-3', 'P25', 30, c),
  ref('BE-3', 'P50', 40, c),
  ref('BE-3', 'P75', 55, c),
  ref('BE-3', 'P90', 80, c),
  ref('BE-3', 'P95', 95, c),
  ref('BE-3', 'MEDIAN', 41, c),
  ref('BE-3', 'MOYEN', 50, c),
];
// HIC-style: exceedance, falling with the percentile (the value exceeded 10 % of the time is the high one).
const hic = (c: Conv | null = 'exceedance'): RefIn[] => [
  ref('BE-1', 'P10', 300, c),
  ref('BE-1', 'P50', 100, c),
  ref('BE-1', 'P90', 40, c),
  ref('BE-1', 'P95', 20, c),
];

const state = (value: number, refs: RefIn[], family: Family) => classify(series(value, refs), family).state;

describe('SPW non-exceedance percentiles (BE-3, owner family)', () => {
  it('the set orders as its convention says, with P90 above the mean', () => {
    const r = spw();
    const v = (k: string) => (r.find((x) => x.kind === k) as RefIn).value;
    expect(v('P90')).toBeGreaterThan(v('MOYEN'));
    expect(conventionHolds(r)).toBe(true);
  });

  it('≤ P05 is low, above is normal, the high percentiles never raise it', () => {
    expect(state(-1, spw(), 'owner')).toBe('low');
    expect(state(10, spw(), 'owner')).toBe('low');
    expect(state(10.01, spw(), 'owner')).toBe('normal');
    expect(state(95, spw(), 'owner')).toBe('normal');
    expect(state(500, spw(), 'owner')).toBe('normal');
    expect(classify(series(10, spw()), 'owner').basis).toMatchObject({
      source: 'BE-3',
      kind: 'statistical',
      ref: 'P05',
    });
  });

  it('the same rows in the public family decide nothing', () => {
    for (const v of [-1, 10, 11, 500]) expect(state(v, spw(), 'public')).toBe('no_ref');
  });

  it('swapping the stored convention to exceedance: no longer low (the P05 row is not the SPW reference)', () => {
    expect(state(10, spw('exceedance'), 'owner')).not.toBe('low');
    expect(state(10, spw('exceedance'), 'owner')).toBe('no_ref');
    expect(state(10, spw(null), 'owner')).toBe('no_ref');
  });

  it('a set whose values contradict its convention is not used: no_ref, even at a value under P05', () => {
    // values that FALL with the percentile, stored as non-exceedance
    const wrong = [
      ref('BE-3', 'P05', 100, 'non_exceedance'),
      ref('BE-3', 'P50', 50, 'non_exceedance'),
      ref('BE-3', 'P95', 10, 'non_exceedance'),
    ];
    expect(conventionHolds(wrong)).toBe(false);
    expect(state(100, wrong, 'owner')).toBe('no_ref');
    expect(state(5, wrong, 'owner')).toBe('no_ref');
  });
});

describe('HIC exceedance percentiles (BE-1, gated rows, synthetic)', () => {
  it('the set orders as its convention says, P10 above P90', () => {
    expect(conventionHolds(hic())).toBe(true);
  });

  it('≤ P95 is low, above is normal', () => {
    expect(state(20, hic(), 'public')).toBe('low');
    expect(state(0, hic(), 'public')).toBe('low');
    expect(state(20.01, hic(), 'public')).toBe('normal');
    expect(state(300, hic(), 'public')).toBe('normal');
    expect(classify(series(20, hic()), 'public').basis).toMatchObject({ source: 'BE-1', ref: 'P95', label: 'HIC P95' });
  });

  it('swapping the stored convention to non-exceedance: no longer low', () => {
    expect(state(20, hic('non_exceedance'), 'public')).not.toBe('low');
    expect(state(20, hic('non_exceedance'), 'public')).toBe('no_ref');
  });

  it('an SPW-ordered set stored as exceedance contradicts its convention and is not used', () => {
    const wrong = [
      ref('BE-1', 'P10', 20, 'exceedance'),
      ref('BE-1', 'P50', 100, 'exceedance'),
      ref('BE-1', 'P95', 300, 'exceedance'),
    ];
    expect(conventionHolds(wrong)).toBe(false);
    for (const v of [0, 20, 300]) expect(state(v, wrong, 'public')).toBe('no_ref');
  });
});

describe('conventionHolds', () => {
  it('judges each convention on its own rows and ignores kinds that are not percentiles', () => {
    expect(conventionHolds([])).toBe(true);
    expect(
      conventionHolds([ref('BE-3', 'MEDIAN', 5, 'non_exceedance'), ref('BE-3', 'MOYEN', 1, 'non_exceedance')]),
    ).toBe(true);
    expect(conventionHolds([ref('BE-3', 'P05', 5, null), ref('BE-3', 'P95', 1, null)])).toBe(true);
    // equal values hold in both conventions
    expect(conventionHolds([ref('BE-3', 'P05', 5, 'non_exceedance'), ref('BE-3', 'P95', 5, 'non_exceedance')])).toBe(
      true,
    );
    expect(conventionHolds([ref('BE-1', 'P10', 5, 'exceedance'), ref('BE-1', 'P95', 5, 'exceedance')])).toBe(true);
    // unordered input is ordered by percentile first
    expect(conventionHolds([ref('BE-3', 'P95', 9, 'non_exceedance'), ref('BE-3', 'P05', 1, 'non_exceedance')])).toBe(
      true,
    );
    expect(conventionHolds([ref('BE-3', 'P95', 1, 'non_exceedance'), ref('BE-3', 'P05', 9, 'non_exceedance')])).toBe(
      false,
    );
  });
});
