import type { ApiStation, Snapshot } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { stationStates } from '../src/lib/stationStates.ts';
import type { Group } from '../src/lib/url/url.ts';

// P19a (T8): the coast fields of the station feature-state record: `coast` from the water-body group and `surge` from
// the value's tide (up to now) or the forecast's (after now); never in play (owner decision O-1).

type Value = Snapshot['values'][number];

const series = (id: number, quantity: 'H' | 'Q' = 'H') => ({
  id,
  source: 'NL-1',
  quantity,
  valueKind: quantity === 'H' ? ('level' as const) : null,
  unit: quantity === 'H' ? ('cm' as const) : ('m³/s' as const),
  datum: 'NAP',
  nativeUnit: quantity === 'H' ? ('cm' as const) : ('m3/s' as const),
  expectedStepSeconds: 600,
  stalenessLimitSeconds: 3600,
  dataSince: null,
});
const station = (id: string, s: ReturnType<typeof series>[]): ApiStation =>
  ({
    id,
    name: id,
    waterName: null,
    country: 'NL',
    lon: 5,
    lat: 52,
    tier: 1,
    flags: { tidal: true, impounded: null },
    series: s,
  }) as unknown as ApiStation;
const tide = (surge: number | null) => ({
  astro: surge === null ? null : 100,
  surge,
  derived: 'surge' as const,
  extremes: [],
});
const value = (id: number, over: Record<string, unknown> = {}): Value =>
  ({
    series: id,
    ts: '2026-10-26T12:00:00Z',
    value: 180,
    qc: 1,
    ageSeconds: 0,
    state: 'no_ref',
    basis: null,
    section: false,
    ...over,
  }) as Value;

const coast = station('nl.e2e.coast', [series(1)]);
const river = station('nl.e2e.river', [series(2)]);
const lake = station('nl.e2e.lake', [series(3)]);
const groups = new Map<string, Group>([
  [coast.id, 'coast'],
  [river.id, 'rivers'],
  [lake.id, 'lakes'],
]);
const base = { changes: undefined, ownerSources: new Set<string>() };
const stateOf = (over: Partial<Parameters<typeof stationStates>[0]>, id = coast.id) =>
  stationStates({
    stations: [coast, river, lake],
    values: new Map(),
    forecasts: undefined,
    groups,
    ...base,
    ...over,
  }).get(id);

describe('stationStates: coast and surge (P19a)', () => {
  it('a coast station with a tide takes its surge, at the value time', () => {
    const values = new Map([[1, value(1, { tide: tide(80) })]]);
    expect(stateOf({ values })).toMatchObject({ coast: true, surge: 80 });
  });

  it('keeps a negative surge and a zero one', () => {
    expect(stateOf({ values: new Map([[1, value(1, { tide: tide(-60) })]]) })).toMatchObject({ surge: -60 });
    expect(stateOf({ values: new Map([[1, value(1, { tide: tide(0) })]]) })).toMatchObject({ surge: 0 });
  });

  it('is null without a tide, with a tide without astro, and in play (played values carry no tide, O-1)', () => {
    const plain = new Map([[1, value(1)]]);
    expect(stateOf({ values: plain })).toMatchObject({ coast: true, has: true, surge: null });
    expect(stateOf({ values: new Map([[1, value(1, { tide: tide(null) })]]) })).toMatchObject({ surge: null });
    expect(stateOf({ values: new Map() })).toMatchObject({ coast: true, has: false, surge: null });
  });

  it('after now it takes the forecast tide, not the value tide', () => {
    const values = new Map([[1, value(1, { tide: tide(80) })]]);
    const forecasts = new Map([[1, { estimate: false, state: 'no_ref' as const, tide: tide(150) }]]);
    expect(stateOf({ values, forecasts })).toMatchObject({ coast: true, forecast: true, has: true, surge: 150 });
    const none = new Map([[1, { estimate: false, state: 'no_ref' as const }]]);
    expect(stateOf({ values, forecasts: none })).toMatchObject({ coast: true, surge: null });
  });

  it('a river or a lake station is not coast and has no surge, even when its value has a tide', () => {
    const values = new Map([
      [2, value(2, { tide: tide(40) })],
      [3, value(3, { tide: tide(40) })],
    ]);
    expect(stateOf({ values }, river.id)).toMatchObject({ coast: false, surge: null });
    expect(stateOf({ values }, lake.id)).toMatchObject({ coast: false, surge: null });
    const forecasts = new Map([[2, { estimate: false, state: 'high' as const, tide: tide(40) }]]);
    expect(stateOf({ values, forecasts }, river.id)).toMatchObject({ coast: false, surge: null });
  });

  it('without groups, or for a station outside them, every station is rivers', () => {
    const values = new Map([[1, value(1, { tide: tide(80) })]]);
    expect(stateOf({ values, groups: undefined })).toMatchObject({ coast: false, surge: null });
    expect(stateOf({ values, groups: new Map() })).toMatchObject({ coast: false, surge: null });
  });

  it('uses the primary H series, not a Q series of the station', () => {
    const both = station('nl.e2e.both', [series(5, 'Q'), series(6)]);
    const values = new Map([
      [5, value(5, { tide: tide(10) })],
      [6, value(6, { tide: tide(90) })],
    ]);
    const out = stationStates({
      stations: [both],
      values,
      forecasts: undefined,
      groups: new Map([[both.id, 'coast']]),
      ...base,
    });
    expect(out.get(both.id)).toMatchObject({ coast: true, surge: 90 });
  });
});
