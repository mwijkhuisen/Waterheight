import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  fromCanonical,
  isSentinel,
  isUnit,
  QC,
  rangeBit,
  SchemaDrift,
  TO_NAP,
  thin,
  toCanonical,
  toNap,
  UNITS,
  type Unit,
} from '../src/index.ts';

describe('units (catalogue §4.5)', () => {
  it('a product beyond the double range is drift, never ±Infinity (P5a: 1.8e306 m ×100)', () => {
    expect(() => toCanonical('m', 1.8e306)).toThrow(SchemaDrift);
    expect(() => toCanonical('m', -1.8e306)).toThrow(SchemaDrift);
    expect(() => toCanonical('m', 1.8e306)).toThrow('value_out_of_range');
    expect(toCanonical('m', 1e300)).toBe(1e302);
  });

  it('converts to cm and m³/s', () => {
    expect(toCanonical('cm', 53)).toBe(53);
    expect(toCanonical('cm', -22)).toBe(-22);
    expect(toCanonical('mm', 1203)).toBe(120.3);
    expect(toCanonical('m', 0.06)).toBe(6);
    expect(toCanonical('m+NN', 25.0)).toBe(2500);
    expect(toCanonical('m+NN', 56.43)).toBe(5643);
    expect(toCanonical('m+PNP', 1.27)).toBe(127);
    expect(toCanonical('m³/s', 586)).toBe(586);
    expect(toCanonical('m3/s', 608)).toBe(608);
    expect(toCanonical('l/s', 1234)).toBe(1.234);
  });

  it('knows which unit is a height and which a discharge, and which is absolute', () => {
    expect(UNITS['m+NN']).toEqual({ quantity: 'H', factor: 100, kind: 'level' });
    expect(UNITS['m+PNP'].kind).toBe('stage');
    expect(UNITS['l/s'].quantity).toBe('Q');
    expect(isUnit('cm')).toBe(true);
    expect(isUnit('m+NHN')).toBe(false);
    expect(isUnit('toString')).toBe(false);
  });

  it('is invertible for every unit (property)', () => {
    const unit = fc.constantFrom(...(Object.keys(UNITS) as Unit[]));
    // Provider values as published: at most 3 decimals, 7 significant digits.
    const value = fc.integer({ min: -999_999, max: 999_999 }).map((n) => n / 1000);
    fc.assert(
      fc.property(unit, value, (u, v) => {
        expect(fromCanonical(u, toCanonical(u, v))).toBeCloseTo(v, 6);
      }),
    );
  });
});

describe('datums (catalogue §4.1)', () => {
  it('returns "not converted" for IGN69 and NGF-1884, never a number (C40, D16)', () => {
    for (const datum of ['IGN69', 'NGF1884'] as const) {
      const result = toNap(datum, 134.21);
      expect(result.converted).toBe(false);
      expect(result).not.toHaveProperty('heightM');
      expect(JSON.stringify(TO_NAP[datum])).not.toMatch(/\d\.\d/);
    }
  });

  it('does not convert a local gauge zero or a station-specific datum', () => {
    expect(toNap('LOCAL', 1).converted).toBe(false);
    expect(toNap('MSL', 1).converted).toBe(false);
  });

  it('converts the datums with a verified relation, with their uncertainty', () => {
    expect(toNap('NAP', 6.28)).toMatchObject({ converted: true, heightM: 6.28, uncertaintyM: 0 });
    // Eijsden: 46.37 m TAW is 44.04 m NAP (the 233 cm twin).
    expect(toNap('TAW', 46.37)).toMatchObject({ converted: true, heightM: 44.04, uncertaintyM: 0.02 });
    expect(toNap('DNG', 101.428)).toMatchObject({ converted: true, heightM: 99.098 });
    expect(toNap('NHN', 7.998)).toMatchObject({ converted: true, heightM: 8.008, uncertaintyM: 0.02 });
    expect(toNap('NN', 25)).toMatchObject({ converted: true, uncertaintyM: 0.08 });
    expect(toNap('LN02', 240)).toMatchObject({ converted: true, heightM: 239.69 });
    expect(toNap('NG95', 138.5)).toMatchObject({ converted: true, heightM: 138.5 });
  });
});

describe('QC and sentinels', () => {
  it('flags implausible values and keeps legitimate negatives', () => {
    expect(rangeBit('stage', -22)).toBe(0);
    expect(rangeBit('stage', 1069)).toBe(0);
    expect(rangeBit('stage', 99998)).toBe(QC.RANGE);
    expect(rangeBit('level', 40_703.5)).toBe(0);
    expect(rangeBit('level', 9_999_999)).toBe(QC.RANGE);
    expect(rangeBit('Q', -1.2)).toBe(0);
    expect(rangeBit('Q', 1e6)).toBe(QC.RANGE);
  });

  it('has distinct single bits', () => {
    const bits = Object.values(QC);
    expect(new Set(bits).size).toBe(bits.length);
    for (const b of bits) expect(Number.isInteger(Math.log2(b))).toBe(true);
    expect(bits.reduce((a, b) => a | b, 0)).toBe(1023);
  });

  it('knows the numeric sentinels per source', () => {
    expect(isSentinel('DE-1', 99999)).toBe(true);
    expect(isSentinel('DE-1', 99999.0)).toBe(true);
    expect(isSentinel('DE-1', -7)).toBe(false);
    expect(isSentinel('NL-1', 99999)).toBe(false);
    expect(isSentinel('DE-9', -888)).toBe(true);
  });
});

describe('thin (1-minute series → 15 minutes)', () => {
  const MIN = 60_000;
  const STEP = 15 * MIN;
  const at = (minute: number) => ({ ts: Date.UTC(2026, 8, 29, 13, 0) + minute * MIN, v: minute });
  const minutes = (rows: { v: number }[]) => rows.map((r) => r.v);

  it('keeps the on-grid sample of every bucket', () => {
    const dense = Array.from({ length: 61 }, (_, i) => at(i));
    expect(minutes(thin(dense, STEP))).toEqual([0, 15, 30, 45, 60]);
  });

  it('a window that starts inside a bucket keeps only its on-grid samples', () => {
    const window = Array.from({ length: 40 }, (_, i) => at(i + 7));
    expect(minutes(thin(window, STEP))).toEqual([15, 30, 45]);
  });

  it('a missing grid minute is a gap, never filled with a neighbour', () => {
    const gap = [0, 1, 14, 16, 17, 30].map(at);
    expect(minutes(thin(gap, STEP))).toEqual([0, 30]);
  });

  it('leaves a native 15-minute series unchanged and copes with an empty one', () => {
    const native = [0, 15, 30, 45].map(at);
    expect(thin(native, STEP)).toEqual(native);
    expect(thin([], STEP)).toEqual([]);
  });

  const series = fc
    .uniqueArray(fc.integer({ min: 0, max: 600 }), { maxLength: 200 })
    .map((ms) => ms.sort((a, b) => a - b).map(at));

  it('is idempotent and only ever removes samples (property)', () => {
    fc.assert(
      fc.property(series, (rows) => {
        const once = thin(rows, STEP);
        expect(thin(once, STEP)).toEqual(once);
        for (const r of once) expect(rows).toContain(r);
        const buckets = once.map((r) => Math.floor(r.ts / STEP));
        expect(new Set(buckets).size).toBe(buckets.length);
      }),
    );
  });

  it('two overlapping windows, thinned in either order, store what thinning their union stores (property)', () => {
    // The stored rows of a series: a timestamp keeps the last value written for it.
    const store = (...windows: ReturnType<typeof at>[][]) => {
      const rows = new Map<number, number>();
      for (const w of windows) for (const s of thin(w, STEP)) rows.set(s.ts, s.v);
      return [...rows].sort(([a], [b]) => a - b);
    };
    fc.assert(
      fc.property(series, fc.nat(200), fc.nat(200), fc.nat(200), fc.nat(200), (rows, a, b, c, d) => {
        const first = rows.slice(Math.min(a, b), Math.max(a, b));
        const second = rows.slice(Math.min(c, d), Math.max(c, d));
        const union = [...new Map([...first, ...second].map((r) => [r.ts, r])).values()].sort((x, y) => x.ts - y.ts);
        expect(store(first, second)).toEqual(store(second, first));
        expect(store(first, second)).toEqual(store(union));
      }),
      { numRuns: 300 },
    );
  });
});

describe('SchemaDrift', () => {
  it('carries a fixed code and a sanitised schema path, never provider text', () => {
    const err = new SchemaDrift('invalid_type', '0.timeseries.1.unit<script>');
    expect(err.code).toBe('invalid_type');
    expect(err.path).toBe('0.timeseries.1.unit?script?');
    expect(new SchemaDrift('x', 'a'.repeat(500)).path).toHaveLength(120);
  });
});
