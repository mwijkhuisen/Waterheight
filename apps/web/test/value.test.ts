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
  it('names the gauge zero of a stage in the page’s language, as PNP only for a German source', () => {
    const stage = { nativeUnit: 'cm', valueKind: 'stage', datum: 'LOCAL', source: 'DE-1' } as const;
    expect(unitLabel(stage, 'nl')).toBe('cm boven peilnul (PNP)');
    expect(unitLabel(stage, 'en')).toBe('cm above gauge zero (PNP)');
    for (const source of ['FR-1', 'CH-4', 'BE-3', 'NL-1']) {
      expect(unitLabel({ ...stage, source }, 'nl')).toBe('cm boven peilnul');
      expect(unitLabel({ ...stage, source }, 'en')).toBe('cm above gauge zero');
    }
  });

  it('adds the datum of a level, but not twice for m+NN', () => {
    const level = { nativeUnit: 'cm', valueKind: 'level', datum: 'NAP', source: 'NL-1' } as const;
    expect(unitLabel(level, 'nl')).toBe('cm NAP');
    expect(unitLabel(level, 'en')).toBe('cm NAP');
    const nn = { nativeUnit: 'm+NN', valueKind: 'level', datum: 'NN', source: 'DE-1' } as const;
    expect(unitLabel(nn, 'nl')).toBe('m+NN');
    expect(unitLabel(nn, 'en')).toBe('m+NN');
  });

  it('is the bare unit for a discharge, which has no datum', () => {
    const q = { nativeUnit: 'm³/s', valueKind: null, datum: null, source: 'DE-1' } as const;
    expect(unitLabel(q, 'nl')).toBe('m³/s');
    expect(unitLabel(q, 'en')).toBe('m³/s');
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
