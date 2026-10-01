import { describe, expect, it } from 'vitest';
import { formatValue, nativeValue, unitLabel } from '../src/features/station/value.ts';

// The page shows each value in the unit its provider publishes (catalogue §4.2,
// §4.7), back from the API's canonical cm and m³/s. The labels are compiled
// Paraglide messages (`pnpm test` compiles them first).

describe('nativeValue', () => {
  it.each([
    ['cm', 612, 612],
    ['m+NN', 5123, 51.23],
    ['m+PNP', 250, 2.5],
    ['m', 300, 3],
    ['mm', 61, 610],
    ['m³/s', 1234, 1234],
    ['l/s', 1.5, 1500],
  ] as const)('%s: canonical %d is %d', (nativeUnit, canonical, native) => {
    expect(nativeValue(canonical, { nativeUnit })).toBeCloseTo(native, 9);
  });
});

describe('unitLabel', () => {
  it('names the gauge zero of a stage in the page’s language', () => {
    const stage = { nativeUnit: 'cm', valueKind: 'stage', datum: 'LOCAL' } as const;
    expect(unitLabel(stage, 'nl')).toBe('cm boven peilnul (PNP)');
    expect(unitLabel(stage, 'en')).toBe('cm above gauge zero (PNP)');
  });

  it('adds the datum of a level, but not twice for m+NN', () => {
    expect(unitLabel({ nativeUnit: 'cm', valueKind: 'level', datum: 'NAP' }, 'nl')).toBe('cm NAP');
    expect(unitLabel({ nativeUnit: 'cm', valueKind: 'level', datum: 'NAP' }, 'en')).toBe('cm NAP');
    expect(unitLabel({ nativeUnit: 'm+NN', valueKind: 'level', datum: 'NN' }, 'nl')).toBe('m+NN');
    expect(unitLabel({ nativeUnit: 'm+NN', valueKind: 'level', datum: 'NN' }, 'en')).toBe('m+NN');
  });

  it('is the bare unit for a discharge, which has no datum', () => {
    expect(unitLabel({ nativeUnit: 'm³/s', valueKind: null, datum: null }, 'nl')).toBe('m³/s');
    expect(unitLabel({ nativeUnit: 'm³/s', valueKind: null, datum: null }, 'en')).toBe('m³/s');
  });
});

describe('formatValue', () => {
  it('uses the page’s decimal separator', () => {
    expect(formatValue(5123, { nativeUnit: 'm+NN' }, 'nl')).toBe('51,23');
    expect(formatValue(5123, { nativeUnit: 'm+NN' }, 'en')).toBe('51.23');
  });

  it('shows a native value, with at most two decimals', () => {
    expect(formatValue(612, { nativeUnit: 'cm' }, 'nl')).toBe('612');
    expect(formatValue(1 / 3, { nativeUnit: 'cm' }, 'nl')).toBe('0,33');
    expect(formatValue(2 / 3, { nativeUnit: 'cm' }, 'en')).toBe('0.67');
    expect(formatValue(1.5, { nativeUnit: 'l/s' }, 'en')).toBe('1,500');
  });
});
