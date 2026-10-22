import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type LakeBody, type LakeGauge, lakeView } from '../src/lib/lakes.ts';

const g = (value: number | null, state: LakeGauge['state'] = 'normal', extra: Partial<LakeGauge> = {}): LakeGauge => ({
  quantity: 'H',
  datum: 'NAP',
  value,
  state,
  basis: null,
  ...extra,
});
const body = (reference: string | null, stations: string[]): LakeBody => ({
  reference_station_id: reference,
  stations,
});

describe('lakeView', () => {
  it('takes the reference gauge state even when another gauge is higher or worse', () => {
    const basis = { source: 'NL-1', kind: 'operational' } as unknown as LakeGauge['basis'];
    const m = new Map([
      ['a', g(10, 'low', { basis })],
      ['b', g(90, 'extreme')],
    ]);
    const v = lakeView(body('a', ['a', 'b']), m);
    expect(v.state).toBe('low');
    expect(v.basis).toBe(basis);
    expect(v.reference).toBe('a');
  });

  it('has a null state without a reference, without a value at T, or when missing from the map', () => {
    const m = new Map([
      ['a', g(null, 'high')],
      ['b', g(5, 'high')],
    ]);
    expect(lakeView(body(null, ['a', 'b']), m)).toMatchObject({ reference: null, state: null, basis: null });
    expect(lakeView(body('a', ['a', 'b']), m)).toMatchObject({ state: null, basis: null });
    expect(lakeView(body('zz', ['a', 'b']), m)).toMatchObject({ state: null, basis: null });
  });

  it('changing the other gauges changes the spread, never the state', () => {
    const one = lakeView(
      body('a', ['a', 'b']),
      new Map([
        ['a', g(0, 'normal')],
        ['b', g(10, 'extreme')],
      ]),
    );
    const two = lakeView(
      body('a', ['a', 'b']),
      new Map([
        ['a', g(0, 'normal')],
        ['b', g(50, 'low')],
      ]),
    );
    expect(one.state).toBe(two.state);
    expect(one.spread).toEqual({ cm: 10, n: 2 });
    expect(two.spread).toEqual({ cm: 50, n: 2 });
  });

  it('excludes non-NAP gauges from the spread and ignores Q entries (the reference too)', () => {
    const m = new Map([
      ['a', g(0)],
      ['b', g(10)],
      ['c', g(500, 'high', { datum: 'LAT' })],
      ['d', g(900, 'high', { quantity: 'Q' })],
    ]);
    expect(lakeView(body('a', ['a', 'b', 'c', 'd']), m).spread).toEqual({ cm: 10, n: 2 });
    expect(lakeView(body('d', ['a', 'b', 'c', 'd']), m)).toMatchObject({ reference: 'd', state: null, basis: null });
  });

  it('has a null spread with fewer than 2 NAP H values; n counts them; it is max - min', () => {
    expect(lakeView(body('a', ['a']), new Map([['a', g(3)]])).spread).toBeNull();
    expect(lakeView(body('a', []), new Map()).spread).toBeNull();
    const m = new Map([
      ['a', g(-4.5)],
      ['b', g(3.2)],
      ['c', g(1)],
      ['d', g(null)],
    ]);
    expect(lakeView(body('a', ['a', 'b', 'c', 'd']), m).spread).toEqual({ cm: 7.7, n: 3 });
  });

  it('has no averaged field', () => {
    const m = new Map([
      ['a', g(0)],
      ['b', g(10)],
      ['c', g(50)],
    ]);
    const v = lakeView(body('a', ['a', 'b', 'c']), m);
    expect(Object.keys(v).sort()).toEqual(['basis', 'reference', 'spread', 'state']);
    // mean is 20, no gauge is 20
    expect(Object.values(v.spread ?? {})).not.toContain(20);
    expect(JSON.stringify(v)).not.toContain('20');
  });

  it('property: the state is always the reference gauge state (or null)', () => {
    const state = fc.constantFrom('no_ref', 'low', 'normal', 'elevated', 'high', 'extreme') as fc.Arbitrary<
      LakeGauge['state']
    >;
    const gauge = fc.record({
      quantity: fc.constantFrom('H', 'Q') as fc.Arbitrary<'H' | 'Q'>,
      datum: fc.constantFrom('NAP', 'LAT', null),
      value: fc.option(fc.double({ min: -500, max: 500, noNaN: true }), { nil: null }),
      state,
      basis: fc.constant(null),
    });
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd', 'e'), gauge),
        fc.option(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'x'), { nil: null }),
        fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e')),
        (obj, ref, stations) => {
          const m = new Map(Object.entries(obj));
          const r = ref === null ? undefined : m.get(ref);
          const want = r !== undefined && r.quantity === 'H' && r.value !== null ? r.state : null;
          expect(lakeView(body(ref, stations), m).state).toBe(want);
        },
      ),
    );
  });
});
