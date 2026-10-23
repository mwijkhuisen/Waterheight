import { readFileSync } from 'node:fs';
import type { ApiStation, SeriesMeta, Snapshot } from '@rws/contracts';
import { WATERBODY_KINDS } from '@rws/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LADDER } from '../src/features/legend/palette.ts';
import type { LakeGauge } from '../src/lib/lakes.ts';
import { stationStates } from '../src/lib/stationStates.ts';
import { groupsOf, isMsl, lakeGauges, lakeLevels, layerGroup, surgeAt, type WaterBody } from '../src/lib/water.ts';

type Value = Snapshot['values'][number];

const series = (id: number, over: Partial<SeriesMeta> = {}): SeriesMeta => ({
  id,
  source: 'NL-1',
  quantity: 'H',
  valueKind: 'level',
  unit: 'cm',
  datum: 'NAP',
  nativeUnit: 'cm',
  expectedStepSeconds: 600,
  stalenessLimitSeconds: 1800,
  dataSince: null,
  ...over,
});
const station = (id: string, ser: SeriesMeta[], tidal: boolean | null = null): ApiStation => ({
  id,
  name: id,
  waterName: 'X',
  country: 'NL',
  lon: 5,
  lat: 52,
  tier: 1,
  flags: { tidal, impounded: null },
  series: ser,
});
const tide = (surge: number | null) => ({
  astro: surge === null ? null : 100,
  surge,
  derived: 'surge' as const,
  extremes: [],
});
const val = (id: number, over: Partial<Value> = {}): Value => ({
  series: id,
  ts: '2026-10-25T01:30:00Z',
  value: 100,
  qc: 0,
  ageSeconds: 0,
  state: 'normal',
  basis: null,
  section: false,
  ...over,
});
const body = (id: string, kind: WaterBody['kind'], stations: string[], ref: string | null = null): WaterBody => ({
  id,
  kind,
  stations,
  reference_station_id: ref,
});
const gauge = (
  value: number | null,
  state: LakeGauge['state'] = 'normal',
  over: Partial<LakeGauge> = {},
): LakeGauge => ({
  quantity: 'H',
  datum: 'NAP',
  value,
  state,
  basis: null,
  tidal: false,
  suspect: false,
  ...over,
});

describe('groupsOf', () => {
  it('maps the four kinds to lakes/coast and leaves a station in no body out', () => {
    const g = groupsOf([
      body('l', 'lake', ['a']),
      body('h', 'closed_estuary', ['b']),
      body('e', 'estuary', ['c']),
      body('s', 'sea', ['d']),
    ]);
    expect([...g].sort()).toEqual([
      ['a', 'lakes'],
      ['b', 'lakes'],
      ['c', 'coast'],
      ['d', 'coast'],
    ]);
    expect(g.has('river')).toBe(false);
  });

  it('a station in two bodies takes the first by WATERBODY_KINDS order, whatever the input order', () => {
    const lake = body('l', 'lake', ['x']);
    const sea = body('s', 'sea', ['x']);
    expect(WATERBODY_KINDS.indexOf('lake')).toBeLessThan(WATERBODY_KINDS.indexOf('sea'));
    expect(groupsOf([lake, sea]).get('x')).toBe('lakes');
    expect(groupsOf([sea, lake]).get('x')).toBe('lakes');
    expect(groupsOf([body('e', 'estuary', ['x']), body('c', 'closed_estuary', ['x'])]).get('x')).toBe('lakes');
  });

  it('is empty for no bodies and does not reorder its input', () => {
    expect(groupsOf([]).size).toBe(0);
    const input = [body('s', 'sea', ['x']), body('l', 'lake', ['y'])];
    groupsOf(input);
    expect(input.map((b) => b.id)).toEqual(['s', 'l']);
  });
});

describe('layerGroup', () => {
  it('rivers, highlight, reach, flow and canals are rivers', () => {
    for (const id of [
      'rivers',
      'rivers-highlight',
      'rivers-reach',
      'rivers-reach-x',
      'rivers-flow',
      'rivers-flow-3',
      'water-canals',
    ])
      expect(layerGroup(id)).toBe('rivers');
  });
  it('the lake layers are lakes', () => {
    for (const id of ['water-lakes', 'water-lakes-tidal', 'water-lakes-line']) expect(layerGroup(id)).toBe('lakes');
  });
  it('basemap and station layers are not touched', () => {
    for (const id of [
      'water',
      'waterway',
      'landuse',
      'stations',
      'stations-tidal',
      'water-lake',
      'water-canal',
      'basemap:water',
      'planet:water_river',
    ])
      expect(layerGroup(id)).toBeUndefined();
  });
  it('no layer of the committed basemap styles is caught', () => {
    for (const lang of ['nl', 'en']) {
      const style = JSON.parse(
        readFileSync(new URL(`../src/features/map/styles/style-${lang}.json`, import.meta.url), 'utf8'),
      ) as { layers: { id: string }[] };
      expect(style.layers.length).toBeGreaterThan(10);
      for (const l of style.layers) expect(layerGroup(l.id), l.id).toBeUndefined();
    }
  });
});

describe('lakeLevels', () => {
  const lake = body('ijs', 'lake', ['ref', 'bad'], 'ref');

  it('only the reference decides: a worse gauge changes nothing', () => {
    const m = new Map([
      ['ref', gauge(100, 'elevated')],
      ['bad', gauge(900, 'extreme')],
    ]);
    const r = lakeLevels([lake], m).get('ijs');
    expect(r?.level).toBe(LADDER.indexOf('elevated'));
    expect(r?.view.state).toBe('elevated');
  });
  it('a null reference, a no_ref state or a reference without an H value is "geen klasse"', () => {
    const bad = new Map([
      ['ref', gauge(1, 'extreme')],
      ['bad', gauge(2, 'extreme')],
    ]);
    expect(lakeLevels([body('a', 'lake', ['ref', 'bad'], null)], bad).get('a')?.level).toBeNull();
    expect(lakeLevels([lake], new Map([['ref', gauge(1, 'no_ref')]])).get('ijs')?.level).toBeNull();
    expect(lakeLevels([lake], new Map([['ref', gauge(null, 'high')]])).get('ijs')?.level).toBeNull();
    expect(lakeLevels([lake], new Map([['ref', gauge(1, 'high', { quantity: 'Q' })]])).get('ijs')?.level).toBeNull();
    expect(lakeLevels([lake], new Map()).get('ijs')?.level).toBeNull();
  });
  it('skips sea and estuary, includes the closed estuary', () => {
    const m = new Map([['r', gauge(1, 'high', { tidal: true })]]);
    const out = lakeLevels(
      [
        body('s', 'sea', ['r'], 'r'),
        body('e', 'estuary', ['r'], 'r'),
        body('haringvliet', 'closed_estuary', ['r'], 'r'),
      ],
      m,
    );
    expect([...out.keys()]).toEqual(['haringvliet']);
    expect(out.get('haringvliet')?.level).toBe(LADDER.indexOf('high'));
  });
  it('view.tidal follows the reference, not the other gauges', () => {
    const m = new Map([
      ['ref', gauge(1, 'low')],
      ['bad', gauge(1, 'low', { tidal: true })],
    ]);
    expect(lakeLevels([lake], m).get('ijs')?.view.tidal).toBe(false);
    const t = new Map([['ref', gauge(1, 'low', { tidal: true })]]);
    expect(lakeLevels([lake], t).get('ijs')?.view.tidal).toBe(true);
  });
  it('has exactly the keys level and view, and no averaged field', () => {
    const m = new Map([
      ['ref', gauge(1, 'low')],
      ['bad', gauge(5, 'high')],
    ]);
    const r = lakeLevels([lake], m).get('ijs');
    expect(Object.keys(r ?? {}).sort()).toEqual(['level', 'view']);
    expect(Object.keys(r?.view ?? {}).sort()).toEqual(['basis', 'reference', 'spread', 'state', 'tidal']);
  });
});

describe('lakeGauges', () => {
  const h = station('h', [series(1, { datum: 'NAP' })], true);
  const q = station('q', [series(2, { quantity: 'Q', unit: 'm³/s', datum: null })]);
  const values = new Map([
    [1, val(1, { value: 55, state: 'high', qc: 0 })],
    [2, val(2, { value: 9 })],
  ]);

  it('past/now: the first H series of each station; a Q-only station is absent', () => {
    const g = lakeGauges([h, q], values, undefined);
    expect([...g.keys()]).toEqual(['h']);
    expect(g.get('h')).toEqual({
      quantity: 'H',
      datum: 'NAP',
      value: 55,
      state: 'high',
      basis: null,
      tidal: true,
      suspect: false,
    });
  });
  it('a suspect qc bit sets suspect', () => {
    expect(lakeGauges([h], new Map([[1, val(1, { qc: 0xffff })]]), undefined).get('h')?.suspect).toBe(true);
  });
  it('a station with no value is absent', () => {
    expect(lakeGauges([h], new Map(), undefined).size).toBe(0);
  });
  it('after now only forecasts count: null state becomes no_ref, a past-only value is absent', () => {
    const f = new Map([[1, { value: 70, state: null, basis: null }]]);
    expect(lakeGauges([h], values, f).get('h')).toMatchObject({
      value: 70,
      state: 'no_ref',
      suspect: false,
      datum: 'NAP',
    });
    expect(lakeGauges([h], values, new Map()).size).toBe(0);
  });
  it('carries the datum', () => {
    const g2 = station('g2', [series(1, { datum: 'MSL' })]);
    expect(lakeGauges([g2], values, undefined).get('g2')?.datum).toBe('MSL');
  });
});

describe('surgeAt', () => {
  // The Q series with a tide is listed first: the surge is still the first H series'.
  const st = station('c', [series(2, { quantity: 'Q', unit: 'm³/s', datum: null }), series(1)]);
  it('reads tide.surge of the first H series, past/now from values, after now from forecasts', () => {
    const values = new Map([
      [1, val(1, { tide: tide(80) })],
      [2, val(2, { tide: tide(999) })],
    ]);
    expect(surgeAt(st, values, undefined)).toBe(80);
    const f = new Map([
      [1, { tide: tide(150) }],
      [2, { tide: tide(888) }],
    ]);
    expect(surgeAt(st, values, f)).toBe(150);
  });
  it('is null without tide, with a null surge, for played-style values and without H', () => {
    expect(surgeAt(st, new Map([[1, val(1)]]), undefined)).toBeNull();
    expect(surgeAt(st, new Map([[1, val(1, { tide: tide(null) })]]), undefined)).toBeNull();
    expect(surgeAt(st, new Map([[1, val(1)]]), new Map([[1, {}]]))).toBeNull();
    expect(surgeAt(st, new Map(), new Map())).toBeNull();
    const qOnly = station('q', [series(2, { quantity: 'Q', datum: null })]);
    expect(surgeAt(qOnly, new Map([[2, val(2, { tide: tide(5) })]]), undefined)).toBeNull();
  });
  it('does not mix: after now a value-only tide is ignored', () => {
    expect(surgeAt(st, new Map([[1, val(1, { tide: tide(80) })]]), new Map())).toBeNull();
  });
});

describe('isMsl', () => {
  it('is true only for an MSL primary H series', () => {
    expect(isMsl(station('p', [series(1, { datum: 'MSL' })]))).toBe(true);
    expect(isMsl(station('n', [series(1, { datum: 'NAP' })]))).toBe(false);
    expect(isMsl(station('none', []))).toBe(false);
    expect(isMsl(station('q', [series(1, { quantity: 'Q', datum: 'MSL' })]))).toBe(false);
  });
});

describe('honest display at the state level', () => {
  const states = (st: ApiStation, values: Map<number, Value>) =>
    stationStates({
      stations: [st],
      values,
      forecasts: undefined,
      changes: undefined,
      ownerSources: new Set(),
      groups: new Map([[st.id, 'coast' as const]]),
    }).get(st.id);

  it('a coast station with a high NL-4 state but no surge has surge null; with one it carries it', () => {
    const st = station('c', [series(1)], true);
    const high = val(1, { state: 'extreme' });
    expect(states(st, new Map([[1, high]]))).toMatchObject({ coast: true, surge: null });
    expect(states(st, new Map([[1, { ...high, tide: tide(80) }]]))).toMatchObject({ coast: true, surge: 80 });
  });
  it('a NAP station outside the coast group is not coast and has no surge (an MSL one is: water-states.test.ts)', () => {
    const st = station('p', [series(1)]);
    const r = stationStates({
      stations: [st],
      values: new Map([[1, val(1, { tide: tide(5) })]]),
      forecasts: undefined,
      changes: undefined,
      ownerSources: new Set(),
    }).get('p');
    expect(r).toMatchObject({ coast: false, surge: null });
  });
});

describe('property: a lake is the colour of its reference gauge only', () => {
  const state = fc.constantFrom(...LADDER);
  const other = fc.record({
    value: fc.oneof(fc.constant(null), fc.double({ min: -1000, max: 1000, noNaN: true })),
    state,
    datum: fc.constantFrom<string | null>('NAP', 'MSL', null),
    suspect: fc.boolean(),
    quantity: fc.constantFrom<'H' | 'Q'>('H', 'Q'),
    tidal: fc.boolean(),
  });
  it('changing the non-reference gauges never changes level or view.state', () => {
    fc.assert(
      fc.property(state, fc.array(other, { maxLength: 8 }), fc.array(other, { maxLength: 8 }), (refState, a, b) => {
        const mk = (others: (typeof a)[number][]) => {
          const m = new Map<string, LakeGauge>([['ref', gauge(120, refState)]]);
          others.forEach((o, i) => {
            m.set(`o${i}`, { ...o, basis: null });
          });
          const ids = others.map((_, i) => `o${i}`);
          return lakeLevels([body('l', 'lake', ['ref', ...ids], 'ref')], m).get('l');
        };
        const x = mk(a);
        const y = mk(b);
        expect(x?.level).toBe(y?.level);
        expect(x?.view.state).toBe(y?.view.state);
        expect(x?.view.tidal).toBe(y?.view.tidal);
        expect(x?.level).toBe(refState === 'no_ref' ? null : LADDER.indexOf(refState));
      }),
    );
  });
});
