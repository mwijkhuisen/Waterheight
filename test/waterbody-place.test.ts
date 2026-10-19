import { describe, expect, it } from 'vitest';
import { validateWaterbodies, type WaterbodiesFile } from '../packages/contracts/src/waterbodies.ts';
import { BuildError, type Edge } from '../tools/geo/rivernet/build.ts';
import type { LonLat } from '../tools/geo/rivernet/network.ts';
import { place } from '../tools/geo/rivernet/place.ts';
import type { StationInput } from '../tools/geo/rivernet/stations.ts';
import type { WaterbodyInput } from '../tools/geo/rivernet/waterbodies.ts';
import { chain, overrides, river, riversFile, station } from './rivernet-synth.ts';

// P17b on a synthetic graph: canal stations on their canal's edge (D-3) and the water-body membership by identity
// (override or exact name), decided by the geometry.

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof BuildError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};
const square = (w: number, s: number, e: number, n: number): LonLat[] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const kx = 111_320 * Math.cos((51 * Math.PI) / 180); // metres per degree of longitude at 51 N (snap.ts metric)
const none = <T extends Edge>(e: T, reason: 'tidal_zone' | 'canal'): T => ({
  ...e,
  direction: 'none',
  direction_reason: reason,
});

// alpha: a1..a4 along 51 N from 5.00 to 5.08; kanaal: k1, k2 along 51.02 N (canal edges); delta: d1, d2 along 51.1 N
// (tidal zone). The lake "meer" (5.10..5.14, an island 5.115..5.125) lies east of alpha.
const A = chain('a', 4, ['alpha']);
const K = chain('k', 2, ['kanaal'], 51.02).map((e) => none(e, 'canal'));
const D = chain('d', 2, ['delta'], 51.1).map((e) => none(e, 'tidal_zone'));
const rivers = riversFile([
  river({ id: 'alpha' }),
  river({ id: 'kanaal', kind: 'canal', names: { 'NL-1': ['Kanaal'] } }),
  river({ id: 'delta', kind: 'delta_channel', tidal_zone: true, names: { 'NL-1': ['Haringvliet'] } }),
]);
const body = (id: string, n: number, extra: object) => ({
  id,
  kind: 'lake',
  name_nl: id,
  name_en: id,
  wikidata: `Q${9000 + n}`,
  managed_level: true,
  outflows: [],
  reference_station: null,
  evidence: ['https://example.org/synthetic'],
  ...extra,
});
const parsed = validateWaterbodies(
  {
    version: 1,
    waterbodies: [
      body('meer', 1, { osm: { type: 'relation', id: 1 }, names: { 'NL-1': ['Meer'] } }),
      body('zee', 2, {
        kind: 'sea',
        osm: null,
        point: [5.3, 51.3],
        bbox: [5.2, 51.2, 5.4, 51.4],
        names: { 'NL-1': ['Zee'] },
        managed_level: false,
      }),
      body('haringvliet', 3, {
        kind: 'closed_estuary',
        osm: { type: 'way', id: 2 },
        names: { 'NL-1': ['Haringvliet'] },
      }),
    ],
  },
  null,
);
const file = parsed.waterbodies as WaterbodiesFile;
const input: WaterbodyInput = {
  file,
  areas: new Map([
    ['meer', { id: 'meer', polygons: [[square(5.1, 50.98, 5.14, 51.02), square(5.115, 50.995, 5.125, 51.005)]] }],
    ['haringvliet', { id: 'haringvliet', polygons: [[square(4.99, 51.09, 5.05, 51.11)]] }],
  ]),
};
const nl = (id: string, at: LonLat | null, o: Partial<StationInput> = {}) => station(id, at, { source: 'NL-1', ...o });
const run = (st: StationInput[], o = overrides(), wb: WaterbodyInput | null = input) =>
  place([...A, ...K, ...D], rivers, st, o, null, wb);
const one = (s: StationInput, o = overrides(), wb: WaterbodyInput | null = input) => run([s], o, wb).stations[0];

describe('water-body membership (P17b)', () => {
  it('takes the body by exact name and by override, inside the polygon', () => {
    expect(parsed.problems).toEqual([]);
    expect(one(nl('nl.t.1', [5.105, 51], { water_name: 'Meer' }))).toMatchObject({
      waterbody: 'meer',
      waterbody_rule: 'waterbody_contains',
      waterbody_distance_m: 0,
    });
    const o = overrides([{ station: 'nl.t.1', waterbody: 'meer', reason: 'r' }]);
    expect(one(nl('nl.t.1', [5.105, 51]), o)).toMatchObject({
      waterbody: 'meer',
      waterbody_rule: 'waterbody_contains',
    });
  });

  it('lets an override win over a name match', () => {
    const o = overrides([{ station: 'nl.t.1', waterbody: 'haringvliet', reason: 'r' }]);
    expect(one(nl('nl.t.1', [5.02, 51.1], { water_name: 'Meer' }), o)?.waterbody).toBe('haringvliet');
  });

  it('is shore within 500 m, too far beyond (distance kept), shore again with waterbody_max_m', () => {
    const east = (m: number): LonLat => [5.14 + m / kx, 51];
    expect(one(nl('nl.t.1', east(300), { water_name: 'Meer' }))).toMatchObject({
      waterbody: 'meer',
      waterbody_rule: 'waterbody_shore',
      waterbody_distance_m: 300,
    });
    expect(one(nl('nl.t.1', east(800), { water_name: 'Meer' }))).toMatchObject({
      waterbody: null,
      waterbody_rule: 'waterbody_too_far',
      waterbody_distance_m: 800,
    });
    const o = overrides([{ station: 'nl.t.1', waterbody: 'meer', waterbody_max_m: 1000, reason: 'r' }]);
    expect(one(nl('nl.t.1', east(800)), o)).toMatchObject({
      waterbody: 'meer',
      waterbody_rule: 'waterbody_shore',
      waterbody_distance_m: 800,
    });
  });

  it('counts the island as outside: the shore is the island ring', () => {
    expect(one(nl('nl.t.1', [5.12, 51], { water_name: 'Meer' }))).toMatchObject({
      waterbody: 'meer',
      waterbody_rule: 'waterbody_shore',
      waterbody_distance_m: Math.round(0.005 * kx * 10) / 10,
    });
  });

  it('never assigns a body by geometry alone, nor by another source’s spelling', () => {
    const empty = { waterbody: null, waterbody_rule: null, waterbody_distance_m: null };
    expect(one(nl('nl.t.1', [5.105, 51]))).toMatchObject(empty);
    expect(one(station('de.t.1', [5.105, 51], { water_name: 'Meer' }))).toMatchObject(empty);
    expect(one(nl('nl.t.1', [5.105, 51], { water_name: 'meer' }))).toMatchObject(empty);
  });

  it('names a point-only body inside its bbox and refuses one outside it', () => {
    expect(one(nl('nl.t.1', [5.25, 51.35], { water_name: 'Zee' }))).toMatchObject({
      waterbody: 'zee',
      waterbody_rule: 'waterbody_named',
      waterbody_distance_m: null,
    });
    expect(code(() => one(nl('nl.t.1', [5.5, 51.3], { water_name: 'Zee' })))).toBe('waterbody_outside_bbox');
  });

  it('without coordinates: an override is an error, a name match gives nothing', () => {
    const o = overrides([{ station: 'nl.t.1', waterbody: 'meer', reason: 'r' }]);
    expect(code(() => one(nl('nl.t.1', null), o))).toBe('waterbody_without_coordinates');
    expect(one(nl('nl.t.1', null, { water_name: 'Meer' }))).toMatchObject({ waterbody: null, waterbody_rule: null });
  });

  it('fails closed on a polygon body without its area', () => {
    const noArea = { file, areas: new Map() };
    expect(code(() => one(nl('nl.t.1', [5.105, 51], { water_name: 'Meer' }), overrides(), noArea))).toBe(
      'waterbody_area_missing',
    );
  });

  it('gives an owner station a body as a public one', () => {
    const owner = nl('nl.t.1', [5.105, 51], { water_name: 'Meer', audience: 'owner', public: false });
    expect(one(owner)).toMatchObject({ waterbody: 'meer', waterbody_rule: 'waterbody_contains', public: false });
  });

  it('gives nothing without water-body input, even to an override (the behaviour before P17b)', () => {
    const o = overrides([{ station: 'nl.t.1', waterbody: 'meer', reason: 'r' }]);
    expect(one(nl('nl.t.1', [5.105, 51], { water_name: 'Meer' }), o, null)).toMatchObject({
      waterbody: null,
      waterbody_rule: null,
      waterbody_distance_m: null,
    });
  });

  it('gives a station on a delta channel both its river placement and its body (the Haringvliet)', () => {
    const s = one(nl('nl.t.1', [5.03, 51.1], { water_name: 'Haringvliet' }));
    expect(s).toMatchObject({
      rule: 'name',
      river: 'delta',
      waterbody: 'haringvliet',
      waterbody_rule: 'waterbody_contains',
    });
    expect(s?.placement?.edge).toBe('d2');
    expect(s?.reach).not.toBeNull();
  });
});

describe('canal stations (P17b, D-3)', () => {
  const onCanal = (o: Partial<StationInput> = {}) => nl('nl.t.1', [5.01, 51.02], o);
  const canalRow = {
    rule: 'canal_edge',
    river: null,
    placement: null,
    reach: null,
    km_graph: null,
    km_to_nl_entry: null,
    canal: 'kanaal',
    canal_distance_m: 0,
  };

  it('snaps by name and by a river override that names the canal', () => {
    expect(one(onCanal({ water_name: 'Kanaal' }))).toMatchObject({ ...canalRow, override: false });
    const o = overrides([{ station: 'nl.t.1', river: 'kanaal', reason: 'r' }]);
    expect(one(onCanal(), o)).toMatchObject({ ...canalRow, override: true });
  });

  it('keeps the distance to the canal line, rounded to 0.1 m', () => {
    const s = one(nl('nl.t.1', [5.01, 51.02 + 100 / 110_574], { water_name: 'Kanaal' }));
    expect(s).toMatchObject({ rule: 'canal_edge', canal: 'kanaal', canal_distance_m: 100 });
  });

  it('is no_edge_within_500m by name and override_unplaced by override when the canal is too far', () => {
    const far = nl('nl.t.1', [5.01, 51.03], { water_name: 'Kanaal' }); // 1.1 km north of the canal
    expect(one(far)).toMatchObject({ rule: 'no_edge_within_500m', canal: null, river: null, placement: null });
    const o = overrides([{ station: 'nl.t.1', river: 'kanaal', reason: 'r' }]);
    expect(code(() => one({ ...far, water_name: null }, o))).toBe('override_unplaced');
    const wide = overrides([{ station: 'nl.t.1', river: 'kanaal', max_m: 1500, reason: 'r' }]);
    expect(one({ ...far, water_name: null }, wide)).toMatchObject({ rule: 'canal_edge', canal: 'kanaal' });
  });

  it('refuses a by_km override whose river is a canal', () => {
    const o = overrides([{ station: 'nl.t.1', by_km: true, reason: 'r' }]);
    expect(code(() => one(onCanal({ water_name: 'Kanaal' }), o))).toBe('by_km_on_canal');
  });

  it('leaves the reaches as without it, also on an edge the canal shares with a river', () => {
    // a2 is alpha's and kanaal's: a canal station there must not cut alpha (it would, as a Placement).
    const shared = [...A.map((e) => (e.id === 'a2' ? { ...e, rivers: ['alpha', 'kanaal'] } : e)), ...K, ...D];
    const pub = station('de.t.1', [5.05, 51], { river_hint: 'alpha' });
    const canal = nl('nl.t.2', [5.03, 51], { water_name: 'Kanaal' });
    const without = place(shared, rivers, [pub], overrides(), null, input);
    const withCanal = place(shared, rivers, [pub, canal], overrides(), null, input);
    expect(withCanal.reaches).toEqual(without.reaches);
    expect(withCanal.travel).toEqual(without.travel);
    expect(withCanal.stations.find((s) => s.id === 'nl.t.2')).toMatchObject({ ...canalRow, canal_distance_m: 0 });
  });
});

describe('determinism', () => {
  it('gives every station the same result whatever the station order', () => {
    const list = [
      nl('nl.t.1', [5.105, 51], { water_name: 'Meer' }),
      nl('nl.t.2', [5.14 + 300 / kx, 51], { water_name: 'Meer' }),
      nl('nl.t.3', [5.25, 51.35], { water_name: 'Zee' }),
      nl('nl.t.4', [5.01, 51.02], { water_name: 'Kanaal' }),
      nl('nl.t.5', [5.03, 51.1], { water_name: 'Haringvliet' }),
      station('de.t.6', [5.05, 51], { river_hint: 'alpha' }),
    ];
    const byId = (st: StationInput[]) => new Map(run(st).stations.map((s) => [s.id, s]));
    const forward = byId(list);
    expect(byId([...list].reverse())).toEqual(forward);
    expect(byId([list[3], list[0], list[5], list[2], list[4], list[1]] as StationInput[])).toEqual(forward);
  });
});
