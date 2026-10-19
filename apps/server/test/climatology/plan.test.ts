import type { DoySet } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { planOf, type Stored, wantedOf } from '../../src/climatology/write.ts';

// P14f: the pure diff of the climatology command's writes: what a stored set and a new one leave to insert and close.

const set = (p10: number, label = 'DOY P10-P90, 2010-2019, 31 d/yr'): DoySet => ({
  period: [2010, 2019],
  years: 10,
  rows: [
    { md: 101, p10, p50: 150, p90: 300 },
    { md: 102, p10, p50: 150, p90: 300 },
  ],
  basisLabel: label,
});
const stored = (s: DoySet): Stored[] =>
  wantedOf(s).map((w) => ({
    kind: w.kind,
    md: w.md,
    value: Math.fround(w.value),
    lo: new Date('2026-10-25T00:00:00Z'),
    period: '[2010-01-01,2020-01-01)',
    label: s.basisLabel,
  }));

describe('planOf', () => {
  it('stores P10 and P90 per day key and nothing else', () => {
    expect(wantedOf(set(50)).map((w) => `${w.kind}:${w.md}`)).toEqual([
      'P10_DOY:101',
      'P90_DOY:101',
      'P10_DOY:102',
      'P90_DOY:102',
    ]);
    expect(wantedOf(null)).toEqual([]);
  });

  it('a first run inserts everything', () => {
    const plan = planOf(set(50), []);
    expect(plan.counts).toEqual({ new: 4, changed: 0, unchanged: 0, closed: 0 });
    expect(plan.insert).toHaveLength(4);
    expect(plan.close).toEqual([]);
  });

  it('an equal set writes nothing, comparing values as float4', () => {
    const plan = planOf(set(50.123456789), stored(set(50.123456789)));
    expect(plan.counts).toEqual({ new: 0, changed: 0, unchanged: 4, closed: 0 });
    expect(plan.insert).toEqual([]);
    expect(plan.close).toEqual([]);
  });

  it('a changed value, period or label closes the open row and inserts another', () => {
    const base = stored(set(50));
    expect(planOf(set(51), base).counts).toEqual({ new: 0, changed: 2, unchanged: 2, closed: 0 });
    const relabelled = planOf(set(50, 'DOY P10-P90, 2010-2019, 41 d/yr'), base);
    expect(relabelled.counts).toEqual({ new: 0, changed: 4, unchanged: 0, closed: 0 });
    expect(relabelled.close).toHaveLength(4);
    expect(relabelled.insert).toHaveLength(4);
  });

  it('a key the new set lacks is closed, and no set closes them all', () => {
    const base = stored(set(50));
    const fewer: DoySet = { ...set(50), rows: [{ md: 101, p10: 50, p50: 150, p90: 300 }] };
    expect(planOf(fewer, base).counts).toEqual({ new: 0, changed: 0, unchanged: 2, closed: 2 });
    const none = planOf(null, base);
    expect(none.counts).toEqual({ new: 0, changed: 0, unchanged: 0, closed: 4 });
    expect(none.insert).toEqual([]);
  });
});
