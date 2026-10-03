import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BuildError } from '../tools/geo/rivernet/build.ts';
import { buildNetwork, type LonLat } from '../tools/geo/rivernet/network.ts';
import { place } from '../tools/geo/rivernet/place.ts';
import { riverOf, snapStations } from '../tools/geo/rivernet/snap.ts';
import { chain, chainNode, edge, overrides, river, riversFile, station } from './rivernet-synth.ts';

// Synthetic graphs: the rules of network.ts, snap.ts, reaches.ts and place.ts on graphs small enough to
// compute by hand. The real fixture is in rivernet-placement.test.ts.

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof BuildError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

const alphaOnly = () => riversFile([river({ id: 'alpha' })]);
// Chain of 4 edges a1..a4 over nodes an0..an4.
const A = chain('a', 4, ['alpha']);
const alphaEntry = (at: LonLat) =>
  river({
    id: 'alpha',
    nl_entry: { id: 'entry-a', name_nl: 'A', name_en: 'A', at, max_m: 100, evidence: 'synthetic' },
  });

describe('buildNetwork', () => {
  it('draws an edge as the deepest river of its rivers[]', () => {
    const rivers = riversFile([river({ id: 'alpha' }), river({ id: 'beta', parent_river_id: 'alpha' })]);
    const net = buildNetwork([edge('e1', 'x0', 'x1', ['alpha', 'beta'], [chainNode(0), chainNode(1)])], rivers);
    expect(net.primary.get('e1')).toBe('beta');
    expect(net.riverEdges.get('alpha')).toEqual(['e1']);
  });

  it('measures km_graph as the longest path on a diamond', () => {
    // a -> b -> d is a detour (longer), a -> c -> d is straight.
    const a: LonLat = [5, 51];
    const b: LonLat = [5.01, 51.02];
    const c: LonLat = [5.01, 51];
    const d: LonLat = [5.02, 51];
    const edges = [
      edge('ab', 'a', 'b', ['alpha'], [a, b]),
      edge('bd', 'b', 'd', ['alpha'], [b, d]),
      edge('ac', 'a', 'c', ['alpha'], [a, c]),
      edge('cd', 'c', 'd', ['alpha'], [c, d]),
    ];
    const byId = new Map(edges.map((e) => [e.id, e.length_m]));
    const viaB = (byId.get('ab') as number) + (byId.get('bd') as number);
    const viaC = (byId.get('ac') as number) + (byId.get('cd') as number);
    expect(viaB).toBeGreaterThan(viaC + 100);
    const net = buildNetwork(edges, alphaOnly());
    expect(net.kmGraph.get('alpha')?.get('d')).toBeCloseTo(viaB, 6);
    expect(net.kmGraph.get('alpha')?.get('a')).toBe(0);
  });

  it('places the entry on the nearest node of its own river', () => {
    const net = buildNetwork(A, riversFile([alphaEntry([5.0402, 51.0003])]));
    expect(net.entries).toHaveLength(1);
    expect(net.entries[0]).toMatchObject({ id: 'entry-a', river: 'alpha', node: 'an2' });
  });

  it('fails closed on an entry with no node within max_m', () => {
    const rivers = riversFile([alphaEntry([5.0402, 51.01])]); // 1.1 km off every node
    expect(code(() => buildNetwork(A, rivers))).toBe('entry_unplaced');
  });

  const beta = (lon0: number, lat: number) => chain('b', 2, ['beta'], lat, lon0);
  const joined = (at: LonLat, maxM: number) =>
    riversFile([river({ id: 'alpha' }), river({ id: 'beta' })], {
      joins: [{ river: 'alpha', at, to_river: 'beta', max_m: maxM, reason: 'synthetic' }],
    });

  it('adds a join from the sink of one river to the nearest node of another', () => {
    const edges = [...chain('a', 2, ['alpha']), ...beta(5.045, 51.001)]; // bn0 about 400 m from an2
    const net = buildNetwork(edges, joined(chainNode(2), 600));
    expect(net.joins).toHaveLength(1);
    expect(net.joins[0]).toMatchObject({ id: 'j1', from: 'an2', to: 'bn0', river: 'alpha' });
    expect(net.out.get('an2')).toEqual(['j1']);
    expect(net.in.get('bn0')).toEqual(['j1']);
  });

  it('fails closed on a join whose sink is not where it says (join_unplaced)', () => {
    const edges = [...chain('a', 2, ['alpha']), ...beta(5.045, 51.001)];
    expect(code(() => buildNetwork(edges, joined([5.5, 51], 600)))).toBe('join_unplaced');
  });

  it('fails closed on a join whose target is too far (join_too_far)', () => {
    const edges = [...chain('a', 2, ['alpha']), ...beta(5.5, 51)];
    expect(code(() => buildNetwork(edges, joined(chainNode(2), 600)))).toBe('join_too_far');
  });
});

describe('riverOf', () => {
  const rivers = riversFile([
    river({ id: 'alpha', names: { 'DE-1': ['ALPHA'] }, aliases: ['Alfa'] }),
    river({ id: 'gamma', names: { 'DE-1': ['GAMMA'], 'CH-1': ['Alpha'] }, aliases: ['Alfa'] }),
  ]);
  const net = buildNetwork(
    A.map((e) => ({ ...e, rivers: ['alpha'] })),
    rivers,
  );
  const none = overrides();

  it('reads a water name verbatim per source', () => {
    expect(riverOf(net, none, station('de.t.1', null, { water_name: 'ALPHA' }))).toBe('alpha');
    expect(riverOf(net, none, station('ch.t.1', null, { source: 'CH-1', water_name: 'Alpha' }))).toBe('gamma');
    // another source, another case: nothing
    expect(riverOf(net, none, station('de.t.1', null, { water_name: 'Alpha' }))).toBeNull();
    expect(riverOf(net, none, station('fr.t.1', null, { source: 'FR-1', water_name: 'ALPHA' }))).toBeNull();
  });

  it('never resolves an alias, unique or ambiguous', () => {
    expect(riverOf(net, none, station('de.t.1', null, { water_name: 'Alfa' }))).toBeNull();
    expect(riverOf(net, none, station('de.t.2', null, { water_name: 'Gamma' }))).toBeNull();
  });

  it('uses the owner waters table for its own source only', () => {
    const o = overrides([], [{ source: 'BE-3', water_name: 'La Alpha', river: 'alpha', reason: 'r' }]);
    expect(riverOf(net, o, station('be.t.1', null, { source: 'BE-3', water_name: 'La Alpha' }))).toBe('alpha');
    expect(riverOf(net, o, station('de.t.1', null, { water_name: 'La Alpha' }))).toBeNull();
  });

  it('takes the DE-1 river hint, agreeing or alone, and refuses a disagreeing one', () => {
    expect(riverOf(net, none, station('de.t.1', null, { river_hint: 'gamma' }))).toBe('gamma');
    expect(riverOf(net, none, station('de.t.1', null, { water_name: 'ALPHA', river_hint: 'alpha' }))).toBe('alpha');
    expect(code(() => riverOf(net, none, station('de.t.1', null, { water_name: 'ALPHA', river_hint: 'gamma' })))).toBe(
      'river_hint_mismatch',
    );
  });

  it('refuses a water name that two rivers claim (ambiguous_water)', () => {
    const dup = riversFile([
      river({ id: 'alpha', names: { 'DE-1': ['X'] } }),
      river({ id: 'gamma', names: { 'DE-1': ['X'] } }),
    ]);
    const n = buildNetwork(A, dup);
    expect(code(() => riverOf(n, none, station('de.t.1', null, { water_name: 'X' })))).toBe('ambiguous_water');
    // the table and rivers.yaml naming different rivers is ambiguous too
    const o = overrides([], [{ source: 'DE-1', water_name: 'ALPHA', river: 'gamma', reason: 'r' }]);
    expect(code(() => riverOf(net, o, station('de.t.1', null, { water_name: 'ALPHA' })))).toBe('ambiguous_water');
  });
});

describe('snapStations', () => {
  const rivers = riversFile([
    river({ id: 'alpha', names: { 'DE-1': ['ALPHA'] } }),
    river({ id: 'beta', names: { 'DE-1': ['BETA'] } }),
  ]);
  const B = chain('b', 2, ['beta'], 51.5);
  const net = buildNetwork([...A, ...B], rivers);
  const on = (i: number, f: number, lat = 51): LonLat => [chainNode(i)[0] + 0.02 * f, lat];

  it('places by name on the nearest edge of the named river', () => {
    const [s] = snapStations(net, [station('de.t.1', on(1, 0.5), { water_name: 'ALPHA' })], overrides());
    expect(s).toMatchObject({ rule: 'name', river: 'alpha', override: false });
    expect(s?.placement?.edge).toBe('a2');
    expect(s?.placement?.offset_m).toBeCloseTo((net.edges.get('a2')?.length_m as number) / 2, 0);
    expect(s?.placement?.distance_m).toBe(0);
  });

  it('applies river, canal and unsnapped overrides', () => {
    const st = [station('de.t.1', on(0, 0.5)), station('de.t.2', on(0, 0.5)), station('de.t.3', on(0, 0.5))];
    const o = overrides([
      { station: 'de.t.1', river: 'alpha', reason: 'r' },
      { station: 'de.t.2', canal: 'Kanaal', reason: 'r' },
      { station: 'de.t.3', unsnapped: true, reason: 'r' },
    ]);
    const [s1, s2, s3] = snapStations(net, st, o);
    expect(s1).toMatchObject({ rule: 'override', river: 'alpha', override: true });
    expect(s2).toMatchObject({ rule: 'canal', river: null, placement: null, override: true });
    expect(s3).toMatchObject({ rule: 'unsnapped', river: null, placement: null, override: true });
  });

  it('raises max_m for an override', () => {
    const far = station('de.t.1', on(0, 0.5, 51.0075)); // about 830 m
    expect(code(() => snapStations(net, [far], overrides([{ station: 'de.t.1', river: 'alpha', reason: 'r' }])))).toBe(
      'override_unplaced',
    );
    const [s] = snapStations(net, [far], overrides([{ station: 'de.t.1', river: 'alpha', max_m: 1000, reason: 'r' }]));
    expect(s?.rule).toBe('override');
  });

  it('fails closed on an override for an unknown station and one that cannot be placed', () => {
    expect(code(() => snapStations(net, [], overrides([{ station: 'de.t.9', unsnapped: true, reason: 'r' }])))).toBe(
      'override_unknown_station',
    );
    expect(
      code(() =>
        snapStations(
          net,
          [station('de.t.1', on(0, 0.5, 52))],
          overrides([{ station: 'de.t.1', river: 'alpha', reason: 'r' }]),
        ),
      ),
    ).toBe('override_unplaced');
  });

  it('refuses a station 600 m from its river, and one that lies beside another river only', () => {
    const away = station('de.t.1', on(1, 0.5, 51.0054 + 0.0006), { water_name: 'ALPHA' }); // 660 m
    const nearBeta = station('de.t.2', on(0, 0.5, 51.5), { water_name: 'ALPHA' }); // on beta's line
    const [s1, s2] = snapStations(net, [away, nearBeta], overrides());
    expect(s1).toMatchObject({ rule: 'no_edge_within_500m', river: null, placement: null });
    expect(s2).toMatchObject({ rule: 'no_edge_within_500m', river: null, placement: null });
    expect(snapStations(net, [station('de.t.3', on(0, 0.5), { water_name: 'NOWHERE' })], overrides())[0]?.rule).toBe(
      'water_not_in_rivers',
    );
  });

  it('places a station without coordinates by its official km, interpolated between two anchors', () => {
    const km = (value: number) => ({ system: 'K', value });
    const st = [
      station('de.t.1', on(0, 0.25), { river_hint: 'alpha', km: km(10) }),
      station('de.t.2', on(3, 0.5), { river_hint: 'alpha', km: km(20) }),
      station('de.t.3', null, { river_hint: 'alpha', km: km(15) }),
      station('de.t.4', null, { river_hint: 'alpha', km: km(25) }), // above the upper anchor
      station('de.t.5', null, { river_hint: 'alpha' }), // no km
      station('de.t.6', null, { river_hint: 'alpha', km: { system: 'OTHER', value: 15 } }), // no anchor in that system
      // an owner gauge with km and coordinates is never an anchor: de.t.3 stays midway between the public two
      station('be.t.7', on(1, 0.9), { river_hint: 'alpha', km: km(12), audience: 'owner', public: false }),
    ];
    const s = snapStations(net, st, overrides());
    const cum = new Map<string, number>();
    let at = 0;
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      cum.set(id, at);
      at += net.edges.get(id)?.length_m as number;
    }
    const pos = (p: { edge: string; offset_m: number }) => (cum.get(p.edge) as number) + p.offset_m;
    const p1 = pos(s[0]?.placement as never);
    const p2 = pos(s[1]?.placement as never);
    expect(s[2]).toMatchObject({ rule: 'official_km', river: 'alpha' });
    expect(pos(s[2]?.placement as never)).toBeCloseTo((p1 + p2) / 2, 0); // 0.1 m rounding
    expect(Math.abs(pos(s[2]?.placement as never) - (p1 + p2) / 2)).toBeLessThan(1);
    for (const i of [3, 4, 5]) expect(s[i]).toMatchObject({ rule: 'no_coordinates', placement: null });
  });

  it('places a by_km override by its official km even though it has coordinates; unplaceable is an error', () => {
    const km = (value: number) => ({ system: 'K', value });
    const st = [
      station('de.t.1', on(0, 0.25), { river_hint: 'alpha', km: km(10) }),
      station('de.t.2', on(3, 0.5), { river_hint: 'alpha', km: km(20) }),
      station('de.t.3', on(3, 0.9), { river_hint: 'alpha', km: km(15) }), // off its true place, as a lock gauge
    ];
    const reviewed = overrides([{ station: 'de.t.3', by_km: true, reason: 'lock gauge' }]);
    const s = snapStations(net, st, reviewed);
    expect(s[2]).toMatchObject({ rule: 'official_km', river: 'alpha', override: true });
    const cum = new Map<string, number>();
    let at = 0;
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      cum.set(id, at);
      at += net.edges.get(id)?.length_m as number;
    }
    const pos = (p: { edge: string; offset_m: number }) => (cum.get(p.edge) as number) + p.offset_m;
    const mid = (pos(s[0]?.placement as never) + pos(s[1]?.placement as never)) / 2;
    expect(Math.abs(pos(s[2]?.placement as never) - mid)).toBeLessThan(1);
    const far = [...st.slice(0, 2), station('de.t.3', on(3, 0.9), { river_hint: 'alpha', km: km(99) })];
    expect(() => snapStations(net, far, reviewed)).toThrow(/override_unplaced/);
  });
});

describe('chainage through place()', () => {
  // Entry at an2 of alpha: an0, an1 are outside NL (upstream), an3, an4 inside.
  const rivers = riversFile([alphaEntry(chainNode(2))]);
  const at = (i: number, f: number): LonLat => [chainNode(i)[0] + 0.02 * f, 51];
  const run = (...pos: LonLat[]) =>
    place(
      A,
      rivers,
      pos.map((p, i) => station(`de.t.${i + 1}`, p, { river_hint: 'alpha' })),
      overrides(),
    ).stations;
  const len = (id: string) => A.find((e) => e.id === id)?.length_m as number;

  it('is the km to the entry above it, 0 at the node and negative below it', () => {
    const [up, atNode, below] = run(at(0, 0.5), chainNode(2), at(2, 0.5));
    expect(up?.nl_entry_node).toBe('entry-a');
    expect(up?.km_to_nl_entry).toBeCloseTo((len('a1') / 2 + len('a2')) / 1000, 1);
    expect(atNode?.km_to_nl_entry).toBe(0);
    expect(below?.km_to_nl_entry).toBeCloseTo(-len('a3') / 2000, 1);
    expect(below?.nl_entry_node).toBe('entry-a');
  });

  it('falls along the river, and km_graph rises', () => {
    const rows = run(at(0, 0.2), at(1, 0.5), at(3, 0.5));
    expect(rows.map((r) => r.km_to_nl_entry as number)).toEqual(
      [...rows.map((r) => r.km_to_nl_entry as number)].sort((a, b) => b - a),
    );
    expect(rows.map((r) => r.km_graph as number)).toEqual(
      [...rows.map((r) => r.km_graph as number)].sort((a, b) => a - b),
    );
    expect(rows[0]?.km_graph).toBeCloseTo((len('a1') * 0.2) / 1000, 1);
  });

  it('prefers the entry of its own river upstream over a nearer foreign one', () => {
    // beta joins alpha at an3; its entry (at an3, beta's node) is nearer to a station on a4 than alpha's an2.
    const bEdge = edge('b1', 'bn0', 'an3', ['beta'], [[5.05, 51.01], chainNode(3)]);
    const two = riversFile([
      alphaEntry(chainNode(2)),
      river({
        id: 'beta',
        nl_entry: { id: 'entry-b', name_nl: 'B', name_en: 'B', at: chainNode(3), max_m: 100, evidence: 'synthetic' },
      }),
    ]);
    const [s] = place(
      [...A, bEdge],
      two,
      [station('de.t.1', at(3, 0.5), { river_hint: 'alpha' })],
      overrides(),
    ).stations;
    expect(s?.nl_entry_node).toBe('entry-a');
    expect(s?.km_to_nl_entry).toBeCloseTo(-(len('a3') + len('a4') / 2) / 1000, 1);
  });
});

describe('reaches through place()', () => {
  const none = riversFile([river({ id: 'alpha' })]);
  const at = (i: number, f: number): LonLat => [chainNode(i)[0] + 0.02 * f, 51];
  const pub = (id: string, p: LonLat) => station(id, p, { river_hint: 'alpha' });
  const owner = (id: string, p: LonLat) => station(id, p, { river_hint: 'alpha', audience: 'owner', public: false });

  it('is one reach without stations', () => {
    const r = place(A, none, [], overrides()).reaches;
    expect(r.map((x) => x.id)).toEqual(['alpha.1']);
    expect(r[0]).toMatchObject({ up_station: null, down_station: null });
  });

  it('cuts at a public station, which closes one reach and opens the next', () => {
    const p = place(A, none, [pub('de.t.1', at(1, 0.5))], overrides());
    expect(p.reaches.map((x) => [x.id, x.up_station, x.down_station])).toEqual([
      ['alpha.1', null, 'de.t.1'],
      ['alpha.2', 'de.t.1', null],
    ]);
    expect(p.reaches[0]?.downstream).toEqual(['alpha.2']);
    expect(p.reaches[1]?.upstream).toEqual(['alpha.1']);
    expect(p.stations[0]?.reach).toBe('alpha.2');
  });

  it('gives a station at the end of an edge the reach starting there, and only at a sink the one ending there', () => {
    const p = place(A, none, [pub('de.t.1', chainNode(1)), pub('de.t.2', chainNode(4))], overrides());
    const [mid, sink] = p.stations;
    // both are placed at the very end of their edge (a node tie goes to the smaller edge id)
    expect(mid?.placement).toMatchObject({ edge: 'a1', offset_m: A[0]?.length_m });
    expect(sink?.placement).toMatchObject({ edge: 'a4', offset_m: A[3]?.length_m });
    expect(p.reaches.map((x) => [x.id, x.up_station, x.down_station])).toEqual([
      ['alpha.1', null, 'de.t.1'],
      ['alpha.2', 'de.t.1', 'de.t.2'],
    ]);
    expect(mid?.reach).toBe('alpha.2');
    expect(sink?.reach).toBe('alpha.2');
  });

  it('prefers the reach of its own river where several start at its node, whatever the ids', () => {
    // zeta forks at zn1 into zeta (z2) and alpha (a1): alpha.1 sorts before zeta.2, yet a zeta station keeps zeta.
    const Z = chain('z', 2, ['zeta']);
    const branch = edge('a1', 'zn1', 'an1', ['alpha'], [chainNode(1), [5.03, 51.02]]);
    const two = riversFile([river({ id: 'alpha' }), river({ id: 'zeta' })]);
    const p = place([...Z, branch], two, [station('de.t.1', chainNode(1), { river_hint: 'zeta' })], overrides());
    expect(p.stations[0]?.placement).toMatchObject({ edge: 'z1', offset_m: Z[0]?.length_m });
    expect(p.stations[0]?.reach).toBe('zeta.2');
    expect(p.reaches.find((r) => r.id === 'alpha.1')?.up_station).toBe('de.t.1');
  });

  it('numbers the reaches of a river in km order, whatever the station order', () => {
    const p = place(
      A,
      none,
      [pub('de.t.1', at(2, 0.5)), pub('de.t.2', at(0, 0.5)), pub('de.t.3', at(3, 0.5))],
      overrides(),
    );
    expect(p.reaches.map((x) => [x.id, x.up_station, x.down_station])).toEqual([
      ['alpha.1', null, 'de.t.2'],
      ['alpha.2', 'de.t.2', 'de.t.1'],
      ['alpha.3', 'de.t.1', 'de.t.3'],
      ['alpha.4', 'de.t.3', null],
    ]);
    const from = p.reaches.map((x) => x.km_graph_from);
    expect(from).toEqual([...from].sort((a, b) => a - b));
  });

  it('gives an owner station the containing reach and splits nothing', () => {
    const base = place(A, none, [pub('de.t.1', at(1, 0.5))], overrides());
    const withOwner = place(A, none, [pub('de.t.1', at(1, 0.5)), owner('be.t.2', at(2, 0.5))], overrides());
    expect(withOwner.reaches).toEqual(base.reaches);
    expect(withOwner.stations.find((s) => s.id === 'be.t.2')?.reach).toBe('alpha.2');
  });

  it('flags the reaches that start at a bifurcation', () => {
    const bEdge = edge('b1', 'an1', 'bn2', ['beta'], [chainNode(1), [5.03, 51.02]]);
    const two = riversFile([river({ id: 'alpha' }), river({ id: 'beta' })]);
    const r = place([...A.slice(0, 3), bEdge], two, [], overrides()).reaches;
    const flag = new Map(r.map((x) => [x.id, x.flags.bifurcation]));
    expect(flag.get('alpha.1')).toBe(false);
    expect(flag.get('alpha.2')).toBe(true);
    expect(flag.get('beta.1')).toBe(true);
  });

  it('chains the reaches across a join', () => {
    const rivers = riversFile([river({ id: 'alpha' }), river({ id: 'beta' })], {
      joins: [{ river: 'alpha', at: chainNode(2), to_river: 'beta', max_m: 600, reason: 'synthetic' }],
    });
    const r = place(
      [...chain('a', 2, ['alpha']), ...chain('b', 2, ['beta'], 51.001, 5.045)],
      rivers,
      [],
      overrides(),
    ).reaches;
    const by = new Map(r.map((x) => [x.id, x]));
    expect(by.get('alpha.1')?.downstream).toEqual(['beta.1']);
    expect(by.get('beta.1')?.upstream).toEqual(['alpha.1']);
  });

  it('property: reaches cover the edges, and km_graph never falls along a downstream link', () => {
    const lonStep = fc.double({ min: 0.005, max: 0.03, noNaN: true });
    const latStep = fc.double({ min: -0.004, max: 0.004, noNaN: true });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(lonStep, latStep), { minLength: 2, maxLength: 6 }),
        fc.array(fc.tuple(fc.nat(5), fc.double({ min: 0, max: 1, noNaN: true })), { maxLength: 4 }),
        (steps, picks) => {
          const pts: LonLat[] = [[5, 51]];
          for (const [dx, dy] of steps) {
            const [x, y] = pts.at(-1) as LonLat;
            pts.push([Math.round((x + dx) * 1e7) / 1e7, Math.round((y + dy) * 1e7) / 1e7]);
          }
          const edges = steps.map((_, i) =>
            edge(`e${i + 1}`, `n${i}`, `n${i + 1}`, ['alpha'], [pts[i] as LonLat, pts[i + 1] as LonLat]),
          );
          const stations = picks.map(([k, t], i) => {
            const j = k % edges.length;
            const [a, b] = [pts[j] as LonLat, pts[j + 1] as LonLat];
            return station(`de.t.${i}`, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], { river_hint: 'alpha' });
          });
          const { reaches } = place(edges, none, stations, overrides());
          const total = edges.reduce((s, e) => s + e.length_m, 0);
          expect(Math.abs(reaches.reduce((s, r) => s + r.length_m, 0) - total)).toBeLessThanOrEqual(
            0.01 * reaches.length,
          );
          const byId = new Map(reaches.map((r) => [r.id, r]));
          for (const r of reaches)
            for (const d of r.downstream)
              expect(r.km_graph_to).toBeLessThanOrEqual((byId.get(d) as typeof r).km_graph_from + 1e-6);
        },
      ),
      { numRuns: 100 },
    );
  });
});
