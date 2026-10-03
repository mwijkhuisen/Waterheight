import { describe, expect, it } from 'vitest';
import { type Datum, deltaH, type HeightIn, napHeight, TO_NAP } from '../src/index.ts';

// napHeight (D16; catalogue §4.1, §4.7(5)) and the trend's dead band (TREND_BAND).

const level = (source: string, datum: Datum | null, valueCm: number): HeightIn => ({
  source,
  quantity: 'H',
  valueKind: 'level',
  datum,
  valueCm,
  zero: null,
});
const stage = (source: string, zero: HeightIn['zero'], valueCm: number): HeightIn => ({
  source,
  quantity: 'H',
  valueKind: 'stage',
  datum: null,
  valueCm,
  zero,
});

describe('napHeight: heights that convert', () => {
  it('NL level in NAP: 615 cm is 6.15 m, exact', () => {
    expect(napHeight(level('NL-1', 'NAP', 615))).toEqual({ nap: { m: 6.15, pm: 0 } });
    expect(napHeight(level('NL-1', 'NAP', -233))).toEqual({ nap: { m: -2.33, pm: 0 } });
  });

  it('DE-1 stage with an NHN zero: zero + W, then NHN + 0.01 m, within 0.02 m', () => {
    expect(TO_NAP.NHN).toMatchObject({ converted: true, offsetM: 0.01, uncertaintyM: 0.02 });
    // Kaub-like: zero 67.669 m + 9 cm = 67.759 m NHN = 67.769 m NAP
    expect(napHeight(stage('DE-1', { valueM: 67.669, datum: 'NHN' }, 9))).toEqual({ nap: { m: 67.769, pm: 0.02 } });
  });

  it('an NN zero is wider: ± 0.08', () => {
    expect(napHeight(stage('DE-1', { valueM: 100, datum: 'NN' }, 50))).toEqual({ nap: { m: 100.51, pm: 0.08 } });
  });

  it('LU level in NG95: no offset, ± 0.01', () => {
    expect(napHeight(level('LU-1', 'NG95', 24_000))).toEqual({ nap: { m: 240, pm: 0.01 } });
  });

  it('CH level in LN02: −0.31 m, ± 0.05', () => {
    expect(napHeight(level('CH-1', 'LN02', 37_000))).toEqual({ nap: { m: 369.69, pm: 0.05 } });
  });

  it('BE level in TAW and DNG: −2.33 m, ± 0.02', () => {
    expect(napHeight(level('BE-3', 'TAW', 500))).toEqual({ nap: { m: 2.67, pm: 0.02 } });
    expect(napHeight(level('BE-3', 'DNG', 500))).toEqual({ nap: { m: 2.67, pm: 0.02 } });
  });

  it('a stage on a TAW zero converts too', () => {
    expect(napHeight(stage('NL-1', { valueM: 5, datum: 'TAW' }, 100))).toEqual({ nap: { m: 3.67, pm: 0.02 } });
  });
});

describe('napHeight: heights that never convert', () => {
  it('a French zero (IGN69, NGF1884) is returned as published, never converted', () => {
    expect(napHeight(stage('FR-1', { valueM: 200.5, datum: 'IGN69' }, 120))).toEqual({
      zero: { m: 200.5, datum: 'IGN69' },
    });
    expect(napHeight(stage('FR-1', { valueM: 3.2, datum: 'NGF1884' }, 120))).toEqual({
      zero: { m: 3.2, datum: 'NGF1884' },
    });
  });

  it('the unverified datums are never converted whatever the source', () => {
    expect(napHeight(stage('DE-1', { valueM: 10, datum: 'IGN69' }, 50))).toEqual({ zero: { m: 10, datum: 'IGN69' } });
  });

  it('a Belgian §0.6 partner from FR-1 with a zero in a convertible datum is still only {zero}', () => {
    expect(napHeight(stage('FR-1', { valueM: 5, datum: 'TAW' }, 100))).toEqual({ zero: { m: 5, datum: 'TAW' } });
    expect(napHeight(stage('FR-1', { valueM: 67.669, datum: 'NHN' }, 9))).toEqual({
      zero: { m: 67.669, datum: 'NHN' },
    });
    // the same zero from another source converts
    expect(napHeight(stage('DE-1', { valueM: 67.669, datum: 'NHN' }, 9))).not.toHaveProperty('zero');
  });

  it('discharge has no height', () => {
    expect(
      napHeight({ source: 'NL-1', quantity: 'Q', valueKind: null, datum: 'NAP', valueCm: 500, zero: null }),
    ).toBeNull();
    expect(
      napHeight({
        source: 'NL-1',
        quantity: 'Q',
        valueKind: null,
        datum: null,
        valueCm: 5,
        zero: { valueM: 1, datum: 'NAP' },
      }),
    ).toBeNull();
  });

  it('a stage without a zero has none', () => {
    expect(napHeight(stage('DE-1', null, 100))).toBeNull();
  });

  it('a level in a local or station-specific datum has none, nor has a level without a datum', () => {
    expect(napHeight(level('CH-1', 'LOCAL', 100))).toBeNull();
    expect(napHeight(level('CH-1', 'MSL', 100))).toBeNull();
    expect(napHeight(level('CH-1', null, 100))).toBeNull();
    expect(napHeight(level('FR-1', 'IGN69', 100))).toBeNull();
  });

  it('a stage on a local zero has none', () => {
    expect(napHeight(stage('DE-1', { valueM: 1, datum: 'LOCAL' }, 100))).toBeNull();
    expect(napHeight(stage('DE-1', { valueM: 1, datum: 'MSL' }, 100))).toBeNull();
  });
});

describe('deltaH dead band (TREND_BAND)', () => {
  it('H: ±2 cm is steady, beyond it rises or falls', () => {
    expect(deltaH(2, 0, 'H')).toEqual({ dh: 2, trend: 'steady' });
    expect(deltaH(2.01, 0, 'H')).toEqual({ dh: 2.01, trend: 'rising' });
    expect(deltaH(-2, 0, 'H')).toEqual({ dh: -2, trend: 'steady' });
    expect(deltaH(0, 2.01, 'H')).toEqual({ dh: -2.01, trend: 'falling' });
    expect(deltaH(5, 5, 'H')).toEqual({ dh: 0, trend: 'steady' });
  });

  it('Q: the band is max(1 m³/s, 2 % of the start value)', () => {
    // start 200: band 4
    expect(deltaH(204, 200, 'Q')).toEqual({ dh: 4, trend: 'steady' });
    expect(deltaH(204.01, 200, 'Q')?.trend).toBe('rising');
    expect(deltaH(195.99, 200, 'Q')?.trend).toBe('falling');
    expect(deltaH(196, 200, 'Q')?.trend).toBe('steady');
    // start 10: 2 % is 0.2, the band is 1
    expect(deltaH(11, 10, 'Q')).toEqual({ dh: 1, trend: 'steady' });
    expect(deltaH(11.01, 10, 'Q')?.trend).toBe('rising');
    expect(deltaH(8.99, 10, 'Q')?.trend).toBe('falling');
    // a negative start uses its magnitude
    expect(deltaH(-98, -100, 'Q')?.trend).toBe('steady');
    expect(deltaH(-97.9, -100, 'Q')?.trend).toBe('rising');
  });

  it('a missing value on either side gives null', () => {
    expect(deltaH(null, 1, 'H')).toBeNull();
    expect(deltaH(1, null, 'Q')).toBeNull();
    expect(deltaH(null, null, 'H')).toBeNull();
  });
});
