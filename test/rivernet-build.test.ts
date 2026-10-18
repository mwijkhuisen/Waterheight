import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RiversFile } from '../packages/contracts/src/rivers.ts';
import {
  BuildError,
  buildGraph,
  canonicalJson,
  MAX_WAYS_BYTES,
  type Provenance,
  parseProvenance,
  readWays,
} from '../tools/geo/rivernet/build.ts';
import type { WayFeature } from '../tools/geo/rivernet/geojsonseq.ts';
import { buildNetwork } from '../tools/geo/rivernet/network.ts';
import type { Relation } from '../tools/geo/rivernet/opl.ts';

// The P6a graph builder on small synthetic networks: which ways are kept, where
// ways are split, bifurcations, the cycle check and byte-stable output.

const provenance: Provenance = {
  schema_version: 1,
  osmium: '1.19.1',
  replication_timestamp: '2026-10-01T20:21:02Z',
  regions: [
    {
      id: 'netherlands',
      url: 'https://download.geofabrik.de/x',
      bytes: 1,
      md5: 'a'.repeat(32),
      sha256: 'b'.repeat(64),
      replication_timestamp: '2026-10-01T20:21:02Z',
    },
  ],
};

type River = RiversFile['rivers'][number];
const river = (id: string, rel: number | null, extra: Partial<River> = {}): River => ({
  id,
  name_nl: id,
  name_en: id,
  names: {},
  aliases: [],
  osm_relation_id: rel,
  osm_way_name: rel === null ? id : null,
  wikidata: `Q${rel ?? 9}${id.length}`,
  parent_river_id: null,
  km_direction: 'none',
  evidence: 'test',
  ...extra,
});
const rivers = (...rs: River[]): RiversFile => ({ version: 1, rivers: rs, excluded: [] });

/** A way along node ids, with coordinates derived from the ids so shared nodes share coordinates. */
const way = (id: number, nodes: number[], tags: Record<string, string> = { waterway: 'river' }): WayFeature => ({
  id,
  nodes,
  coords: nodes.map((n) => [5 + n / 1000, 51 + (n % 7) / 1000] as [number, number]),
  tags,
});
const ways = (...ws: WayFeature[]) => new Map(ws.map((w) => [w.id, w]));
const rel = (id: number, wikidata: string, members: [number, string][]): Relation => ({
  id,
  tags: { type: 'waterway', waterway: 'river', wikidata },
  members: members.map(([ref, role]) => ({ type: 'w' as const, ref, role })),
});
const edgesOf = (r: ReturnType<typeof buildGraph>) => r.edges.map((e) => `${e.id}:${e.from}>${e.to}:${e.rivers}`);

describe('buildGraph', () => {
  it('splits a way where a tributary joins mid-way and keeps the drawn direction', () => {
    const a = river('main', 1);
    const b = river('trib', 2);
    const r = buildGraph(
      ways(way(10, [1, 2, 3, 4, 5]), way(20, [8, 9, 3])),
      [rel(1, a.wikidata, [[10, 'main_stream']]), rel(2, b.wikidata, [[20, 'main_stream']])],
      rivers(a, b),
      provenance,
    );
    expect(edgesOf(r)).toEqual(['w10.0:n1>n3:main', 'w10.1:n3>n5:main', 'w20.0:n8>n3:trib']);
    expect((r.report as { graph: unknown }).graph).toMatchObject({
      nodes: 4,
      edges: 3,
      sources: 2,
      sinks: 1,
      components: 1,
    });
  });

  it('allows a node with two downstream edges and lists it as a bifurcation', () => {
    const up = river('bovenrijn', 1);
    const w = river('waal', 2);
    const p = river('pannerdensch-kanaal', 3);
    const r = buildGraph(
      ways(way(1, [1, 2]), way(2, [2, 3]), way(3, [2, 4])),
      [
        rel(1, up.wikidata, [[1, 'main_stream']]),
        rel(2, w.wikidata, [[2, 'main_stream']]),
        rel(3, p.wikidata, [[3, '']]),
      ],
      rivers(up, w, p),
      provenance,
    );
    const graph = (r.report as { graph: { bifurcations: unknown[] } }).graph;
    expect(graph.bifurcations).toEqual([
      { node: 'n2', coord: [5.002, 51.002], out: ['w2.0', 'w3.0'], rivers: ['pannerdensch-kanaal', 'waal'] },
    ]);
  });

  it('fails on a cycle and names the ways on it (one reversed parallel channel)', () => {
    const a = river('main', 1);
    const build = () =>
      buildGraph(
        ways(way(1, [1, 2]), way(2, [2, 3]), way(3, [3, 2]), way(4, [3, 4])),
        [
          rel(1, a.wikidata, [
            [1, 'main_stream'],
            [2, 'main_stream'],
            [3, 'main_stream'],
            [4, 'main_stream'],
          ]),
        ],
        rivers(a),
        provenance,
      );
    expect(build).toThrow(BuildError);
    try {
      build();
    } catch (err) {
      expect((err as BuildError).code).toBe('cycle');
      expect([...(err as BuildError).ids].sort()).toEqual(['w2', 'w3']);
    }
  });

  it('fails on a loop inside one way: a node visited twice is a graph node, so the loop is a cycle', () => {
    const a = river('main', 1);
    expect(() =>
      buildGraph(ways(way(1, [1, 2, 3, 2, 4])), [rel(1, a.wikidata, [[1, 'main_stream']])], rivers(a), provenance),
    ).toThrow(/^cycle: w1$/);
  });

  it('keeps main_stream and connected empty-role ways, drops the other roles and counts every drop', () => {
    const a = river('main', 1, { drop_ways: [{ id: 7, reason: 'test' }] });
    const r = buildGraph(
      ways(
        way(1, [1, 2]),
        way(2, [2, 3]), // empty role, touches the main stream
        way(3, [3, 4]), // empty role, touches way 2 only
        way(4, [50, 51]), // empty role, disconnected
        way(5, [2, 60]), // side_stream
        way(6, [61, 1]), // tributary
        way(7, [4, 5]), // main_stream but in drop_ways
        way(8, [5, 6], { natural: 'water' }), // no waterway tag
      ),
      [
        {
          ...rel(1, a.wikidata, [
            [1, 'main_stream'],
            [2, ''],
            [3, ''],
            [4, ''],
            [5, 'side_stream'],
            [6, 'tributary'],
            [7, 'main_stream'],
            [8, 'main_stream'],
            [9, 'main_stream'], // not in the input
            [10, 'riverbank'], // not in the input either: counted missing before the role is looked at
          ]),
          members: [
            ...rel(1, a.wikidata, [
              [1, 'main_stream'],
              [2, ''],
              [3, ''],
              [4, ''],
              [5, 'side_stream'],
              [6, 'tributary'],
              [7, 'main_stream'],
              [8, 'main_stream'],
              [9, 'main_stream'],
            ]).members,
            { type: 'n', ref: 1, role: 'spring' },
            { type: 'r', ref: 77, role: '' },
          ],
        },
      ],
      rivers(a),
      provenance,
    );
    expect(r.edges.map((e) => e.way)).toEqual([1, 2, 3]);
    expect((r.report as { rivers: unknown[] }).rivers[0]).toMatchObject({
      id: 'main',
      ways_kept: 3,
      members: {
        main_stream: 1,
        empty_role_kept: 2,
        empty_role_disconnected: 1,
        side_stream: 1,
        tributary: 1,
        drop_ways: 1,
        not_waterway: 1,
        missing: 1,
        nodes: 1,
        child_relations: 1,
      },
    });
  });

  it('keeps every empty-role way of a relation without roles, and maps unknown roles to other_role', () => {
    const a = river('main', 1);
    const r = buildGraph(
      ways(way(1, [1, 2]), way(2, [8, 9]), way(3, [2, 3])),
      [
        rel(1, a.wikidata, [
          [1, ''],
          [2, ''],
          [3, '<b>x</b>'],
        ]),
      ],
      rivers(a),
      provenance,
    );
    expect(r.edges.map((e) => e.way)).toEqual([1, 2]);
    expect(JSON.stringify(r.report)).not.toContain('<b>');
    expect((r.report as { rivers: { members: unknown }[] }).rivers[0]?.members).toMatchObject({ other_role: 1 });
  });

  it('selects ways of a river without a relation by its Wikidata id and name, never by name alone', () => {
    const k = river('keersop', null, { wikidata: 'Q2', osm_way_name: 'Keersop' });
    const r = buildGraph(
      ways(
        way(1, [1, 2], { waterway: 'river', wikidata: 'Q2', name: 'Keersop' }),
        way(2, [2, 3], { waterway: 'stream', wikidata: 'Q2', name: 'Keersop' }),
        way(3, [3, 4], { waterway: 'river', name: 'Keersop' }),
        way(4, [4, 5], { waterway: 'river', wikidata: 'Q2', name: 'Other' }),
      ),
      [],
      rivers(k),
      provenance,
    );
    expect(r.edges.map((e) => e.way)).toEqual([1, 2]);
  });

  it('reports per-river components and the rivers whose edges never touch their parent', () => {
    const a = river('main', 1);
    const b = river('trib', 2, { parent_river_id: 'main' });
    const c = river('far', 3, { parent_river_id: 'main' });
    const r = buildGraph(
      ways(way(1, [1, 2, 3]), way(2, [9, 2]), way(3, [20, 21]), way(4, [30, 31])),
      [
        rel(1, a.wikidata, [[1, 'main_stream']]),
        rel(2, b.wikidata, [[2, 'main_stream']]),
        rel(3, c.wikidata, [
          [3, ''],
          [4, ''],
        ]),
      ],
      rivers(a, b, c),
      provenance,
    );
    const rep = r.report as {
      graph: { detached: string[]; components: number };
      rivers: { id: string; components: number }[];
    };
    expect(rep.graph.detached).toEqual(['far']);
    expect(rep.graph.components).toBe(3);
    expect(rep.rivers.map((x) => [x.id, x.components])).toEqual([
      ['far', 2],
      ['main', 1],
      ['trib', 1],
    ]);
  });

  it('accepts a relation without a wikidata tag and reports it, but refuses one tagged with another item', () => {
    const a = river('main', 1);
    const r = buildGraph(
      ways(way(1, [1, 2])),
      [{ id: 1, tags: { type: 'waterway' }, members: [{ type: 'w', ref: 1, role: '' }] }],
      rivers(a),
      provenance,
    );
    expect((r.report as { rivers: { relation_tags: unknown }[] }).rivers[0]?.relation_tags).toEqual({
      type: 'waterway',
    });
  });

  it('fails on a missing relation, a Wikidata mismatch and a river without edges', () => {
    const a = river('main', 1);
    const w = ways(way(1, [1, 2]));
    expect(() => buildGraph(w, [], rivers(a), provenance)).toThrow(/^relation_missing: r1$/);
    expect(() => buildGraph(w, [rel(1, 'Q999', [[1, 'main_stream']])], rivers(a), provenance)).toThrow(
      /^wikidata_mismatch: r1$/,
    );
    expect(() => buildGraph(w, [rel(1, a.wikidata, [[1, 'side_stream']])], rivers(a), provenance)).toThrow(
      /^river_without_edges: main$/,
    );
  });

  it('refuses a curated relation that is not type=waterway, even with the right wikidata tag', () => {
    const a = river('main', 1);
    const b = river('trib', 2);
    const area = { ...rel(1, a.wikidata, [[1, 'main_stream']]), tags: { type: 'multipolygon', wikidata: a.wikidata } };
    const untyped = { ...rel(2, b.wikidata, [[2, '']]), tags: { wikidata: b.wikidata } };
    expect(() => buildGraph(ways(way(1, [1, 2]), way(2, [3, 2])), [untyped, area], rivers(a, b), provenance)).toThrow(
      /^relation_not_waterway: r1, r2$/,
    );
  });

  it('writes the same bytes whatever the input order, with 7-decimal coordinates and lengths in metres', () => {
    const a = river('main', 1);
    const b = river('trib', 2);
    const ws = [way(10, [1, 2, 3, 4, 5]), way(20, [8, 9, 3]), way(30, [5, 6])];
    const rels = [
      rel(1, a.wikidata, [
        [10, 'main_stream'],
        [30, ''],
      ]),
      rel(2, b.wikidata, [[20, 'main_stream']]),
    ];
    const run = (w: WayFeature[], r: Relation[], rv: River[]) => {
      const out = buildGraph(ways(...w), r, rivers(...rv), provenance);
      return [canonicalJson(out.graph), canonicalJson(out.reaches), canonicalJson(out.report, 2)].join('');
    };
    const first = run(ws, rels, [a, b]);
    expect(run([...ws].reverse(), [...rels].reverse(), [b, a])).toBe(first);
    const graph = JSON.parse(canonicalJson(buildGraph(ways(...ws), rels, rivers(a, b), provenance).graph));
    expect(graph.nodes[0]).toEqual({ coord: [5.001, 51.001], id: 'n1' });
    expect(graph.edges[0]).toEqual({
      direction: 'downstream',
      from: 'n1',
      id: 'w10.0',
      length_m: 262.8,
      rivers: ['main'],
      to: 'n3',
      way: 10,
    });
    expect(Object.keys(graph)).toEqual([...Object.keys(graph)].sort());
    expect(graph).toMatchObject({ licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors' });
  });

  it('puts the ODbL head on the build report, which keeps the relation tags as review seeds', () => {
    const a = river('main', 1);
    const r = buildGraph(ways(way(1, [1, 2])), [rel(1, a.wikidata, [[1, '']])], rivers(a), provenance);
    expect(r.report).toMatchObject({
      attribution: '© OpenStreetMap contributors',
      attribution_url: 'https://www.openstreetmap.org/copyright',
      licence: 'ODbL-1.0',
      rivers: [{ relation_tags: { type: 'waterway', waterway: 'river', wikidata: a.wikidata } }],
    });
  });
});

// The join split (#110): a join onto another river makes that river's nearest vertex a graph node first.
describe('buildGraph: the split at a join onto another river', () => {
  const SINK: [number, number] = [5.0031, 51.0031]; // 14 m from vertex n3 of the main way
  const main = river('main', 1);
  const trib = river('trib', 2);
  const mainWay = way(10, [1, 2, 3, 4, 5]);
  const tribWay = (id = 20): WayFeature => ({
    id,
    nodes: [100, 101],
    coords: [[5.0035, 51.0045], SINK],
    tags: { waterway: 'river' },
  });
  const withJoin = (maxM: number, toRiver = 'main', joiner = 'trib') => ({
    ...rivers(main, trib),
    joins: [{ river: joiner, at: SINK, to_river: toRiver, max_m: maxM, reason: 'synthetic' }],
  });
  const relations = (shared = false) => [
    rel(1, main.wikidata, [[10, 'main_stream']]),
    rel(
      2,
      trib.wikidata,
      shared
        ? [
            [10, 'main_stream'],
            [20, 'main_stream'],
          ]
        : [[20, 'main_stream']],
    ),
  ];
  const run = (rf: RiversFile, shared = false) =>
    buildGraph(ways(mainWay, tribWay()), relations(shared), rf, provenance);
  const plain = edgesOf(run(rivers(main, trib)));

  it('is the baseline: with no join the main way stays one edge', () => {
    expect(plain).toEqual(['w10.0:n1>n5:main', 'w20.0:n100>n101:trib']);
  });

  it('splits the target way at the nearest interior vertex; the join lands on that node with its short length', () => {
    const rf = withJoin(100);
    const r = run(rf);
    expect(edgesOf(r)).toEqual(['w10.0:n1>n3:main', 'w10.1:n3>n5:main', 'w20.0:n100>n101:trib']);
    const net = buildNetwork(r.edges, rf);
    expect(net.joins).toHaveLength(1);
    expect(net.joins[0]).toMatchObject({ id: 'j1', from: 'n101', to: 'n3', river: 'trib' });
    expect(net.joins[0]?.length_m).toBeLessThan(30);
    expect(net.out.get('n3')).toEqual(['w10.1']);
    expect([...(net.in.get('n3') ?? [])].sort()).toEqual(['j1', 'w10.0']);
  });

  it('splits nothing for a same-river join', () => {
    const rf = withJoin(100, 'trib');
    expect(edgesOf(run(rf))).toEqual(plain);
  });

  it('splits nothing when the nearest vertex is farther than max_m, and the network refuses it (join_too_far)', () => {
    const rf = withJoin(5);
    const r = run(rf);
    expect(edgesOf(r)).toEqual(plain);
    expect(() => buildNetwork(r.edges, rf)).toThrow(/join_too_far/);
  });

  it('never counts a vertex of a way the joining river shares', () => {
    const rf = withJoin(100);
    expect(edgesOf(run(rf, true))).toEqual(['w10.0:n1>n5:main,trib', 'w20.0:n100>n101:trib']);
  });

  it('splits nothing when the nearest vertex is already a way end; the join lands there', () => {
    const end: [number, number] = [5.0051, 51.0051]; // 14 m from n5, the main way's last vertex
    const t: WayFeature = { id: 20, nodes: [100, 101], coords: [[5.0055, 51.0065], end], tags: { waterway: 'river' } };
    const rf = {
      ...rivers(main, trib),
      joins: [{ river: 'trib', at: end, to_river: 'main', max_m: 100, reason: 's' }],
    };
    const r = buildGraph(ways(mainWay, t), relations(), rf, provenance);
    expect(edgesOf(r)).toEqual(plain);
    expect(buildNetwork(r.edges, rf).joins[0]).toMatchObject({ from: 'n101', to: 'n5' });
  });

  it('makes one node of a vertex that two joins land on', () => {
    const trib2 = river('trib2', 3);
    const near: [number, number] = [5.0029, 51.0029]; // 14 m from n3, on the other side
    const t2: WayFeature = {
      id: 30,
      nodes: [200, 201],
      coords: [[5.0015, 51.0035], near],
      tags: { waterway: 'river' },
    };
    const rf = {
      ...rivers(main, trib, trib2),
      joins: [
        { river: 'trib', at: SINK, to_river: 'main', max_m: 100, reason: 's' },
        { river: 'trib2', at: near, to_river: 'main', max_m: 100, reason: 's' },
      ],
    };
    const rels = [...relations(), rel(3, trib2.wikidata, [[30, 'main_stream']])];
    const r = buildGraph(ways(mainWay, tribWay(), t2), rels, rf, provenance);
    expect(edgesOf(r)).toEqual([
      'w10.0:n1>n3:main',
      'w10.1:n3>n5:main',
      'w20.0:n100>n101:trib',
      'w30.0:n200>n201:trib2',
    ]);
    expect(buildNetwork(r.edges, rf).joins.map((j) => j.to)).toEqual(['n3', 'n3']);
  });
});

// P17a: the declared tidal zone and canals (direction `none`), member-of selection and mouths.
describe('buildGraph: tidal zone, canals, member-of and mouths (P17a)', () => {
  const up = river('up', 1);
  const zone = (id: string, rel: number) => river(id, rel, { kind: 'delta_channel', tidal_zone: true });
  const canal = river('kanaal', 3, { kind: 'canal' });
  const delta = zone('delta', 2);
  const main = (...refs: number[]) => refs.map((r): [number, string] => [r, 'main_stream']);
  const dirOf = (r: ReturnType<typeof buildGraph>) =>
    r.edges.map((e) => `${e.id}:${e.direction}${e.direction_reason ? `/${e.direction_reason}` : ''}`);
  const cycleIds = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof BuildError && e.code === 'cycle' ? [...e.ids].sort() : `other:${String(e)}`;
    }
    return 'no error';
  };
  // up: 1 -> 2; the zone loop 2 -> 3 -> 4 -> 2 (ways 2, 3, 4) of `delta`.
  const zoneLoop = [way(1, [1, 2]), way(2, [2, 3]), way(3, [3, 4]), way(4, [4, 2])];
  const zoneRels = [rel(1, up.wikidata, main(1)), rel(2, delta.wikidata, main(2, 3, 4))];

  it('gives tidal-zone edges and canal-only edges direction none, in that order, and every other edge downstream', () => {
    const r = buildGraph(
      ways(way(1, [1, 2]), way(2, [2, 3]), way(3, [3, 4]), way(4, [4, 5]), way(5, [5, 6])),
      [
        rel(1, up.wikidata, main(1, 2)),
        rel(2, delta.wikidata, main(2, 3)),
        rel(3, canal.wikidata, main(3, 4, 5)),
        rel(4, 'Q40', main(5)),
      ],
      rivers(up, delta, canal, river('other', 4, { wikidata: 'Q40' })),
      provenance,
    );
    expect(dirOf(r)).toEqual([
      'w1.0:downstream', // up only
      'w2.0:none/tidal_zone', // shared by a zone channel and a river: the zone wins
      'w3.0:none/tidal_zone', // a zone channel and a canal: the zone comes first
      'w4.0:none/canal', // canals only
      'w5.0:downstream', // a canal and a river
    ]);
  });

  it('builds a loop made only of zone edges, and one mixing zone and directed edges', () => {
    expect(dirOf(buildGraph(ways(...zoneLoop), zoneRels, rivers(up, delta), provenance))).toEqual([
      'w1.0:downstream',
      'w2.0:none/tidal_zone',
      'w3.0:none/tidal_zone',
      'w4.0:none/tidal_zone',
    ]);
    // up runs 1 -> 2 -> 3, the zone channel back 3 -> 2.
    const mixed = buildGraph(
      ways(way(1, [1, 2]), way(2, [2, 3]), way(3, [3, 2])),
      [rel(1, up.wikidata, main(1, 2)), rel(2, delta.wikidata, main(3))],
      rivers(up, delta),
      provenance,
    );
    expect(dirOf(mixed)).toEqual(['w1.0:downstream', 'w2.0:downstream', 'w3.0:none/tidal_zone']);
  });

  it('fails a directed loop outside the zone with exactly its own ways, beside a zone loop that builds', () => {
    const other = river('other', 3);
    const build = () =>
      buildGraph(
        ways(...zoneLoop, way(10, [20, 21]), way(11, [21, 22]), way(12, [22, 21])),
        [...zoneRels, rel(3, other.wikidata, main(10, 11, 12))],
        rivers(up, delta, other),
        provenance,
      );
    expect(cycleIds(build)).toEqual(['w11', 'w12']);
    // The same loop as zone edges builds.
    const zoned = zone('other', 3);
    expect(() =>
      buildGraph(
        ways(...zoneLoop, way(10, [20, 21]), way(11, [21, 22]), way(12, [22, 21])),
        [...zoneRels, rel(3, zoned.wikidata, main(10, 11, 12))],
        rivers(up, delta, zoned),
        provenance,
      ),
    ).not.toThrow();
  });

  it('counts only downstream out-edges as a bifurcation', () => {
    const w = river('waal', 3);
    const bif = (r: ReturnType<typeof buildGraph>) => (r.report as { graph: { bifurcations: unknown[] } }).graph;
    // Node 2: up on to 3 and the zone channel to 4 is no bifurcation; adding waal 2 -> 5 makes one of two edges.
    const base = [way(1, [1, 2]), way(2, [2, 3]), way(3, [2, 4])];
    const rels = [rel(1, up.wikidata, main(1, 2)), rel(2, delta.wikidata, main(3))];
    expect(bif(buildGraph(ways(...base), rels, rivers(up, delta), provenance)).bifurcations).toEqual([]);
    const r = buildGraph(
      ways(...base, way(4, [2, 5])),
      [...rels, rel(3, w.wikidata, main(4))],
      rivers(up, delta, w),
      provenance,
    );
    expect(bif(r).bifurcations).toEqual([
      { node: 'n2', coord: [5.002, 51.002], out: ['w2.0', 'w4.0'], rivers: ['up', 'waal'] },
    ]);
  });

  it('places a mouth on the nearest node of its own river, and fails past max_m (mouth_unplaced)', () => {
    // n4 of delta is at [5.004, 51.004]; n2 (shared with up) at [5.002, 51.002].
    const mouth = (max_m: number) => ({
      ...rivers(up, delta),
      mouths: [
        {
          id: 'delta-noordzee',
          river: 'delta',
          at: [5.0041, 51.004] as [number, number],
          max_m,
          waterbody: 'noordzee',
          evidence: 's',
        },
        {
          id: 'a-up',
          river: 'up',
          at: [5.0011, 51.001] as [number, number],
          max_m: 100,
          waterbody: 'ketelmeer',
          evidence: 's',
        },
      ],
    });
    const r = buildGraph(ways(...zoneLoop), zoneRels, mouth(100), provenance);
    expect((r.graph as { mouths: unknown }).mouths).toEqual([
      { id: 'a-up', river: 'up', node: 'n1', waterbody: 'ketelmeer' },
      { id: 'delta-noordzee', river: 'delta', node: 'n4', waterbody: 'noordzee' },
    ]);
    expect(() => buildGraph(ways(...zoneLoop), zoneRels, mouth(5), provenance)).toThrow(
      /^mouth_unplaced: delta-noordzee$/,
    );
  });

  it('selects a member-of row by name from the parent relation, any role, minus drop_ways, with no relation check', () => {
    const rhine = river('rhine', 1, { wikidata: 'Q584' });
    const noord = river('noord', null, {
      osm_way_name: null,
      osm_member_of: { river: 'rhine', name: 'Noord' },
      wikidata: 'Q1899552', // not the Rhine relation's tag: no wikidata_mismatch
      drop_ways: [{ id: 4, reason: 'test' }],
    });
    const named = { waterway: 'river', name: 'Noord' };
    const ws = ways(
      way(1, [1, 2]), // the Rhine's main stream
      way(2, [2, 3], named), // side_stream
      way(3, [3, 4], { waterway: 'canal', name: 'Noord' }), // empty role, any waterway
      way(4, [4, 5], named), // tributary, but in drop_ways
      way(5, [2, 6], { waterway: 'river', name: 'Oude Maas' }), // another name
      way(6, [3, 7], { natural: 'water', name: 'Noord' }), // no waterway tag
      way(7, [8, 9], named), // the name, but no member
    );
    const base = rel(1, 'Q584', [
      [1, 'main_stream'],
      [2, 'side_stream'],
      [3, ''],
      [4, 'tributary'],
      [5, 'side_stream'],
      [6, 'side_stream'],
    ]);
    const rhineRel = { ...base, members: [...base.members, { type: 'n' as const, ref: 3, role: '' }] };
    const r = buildGraph(ws, [rhineRel], rivers(rhine, noord), provenance);
    expect(edgesOf(r)).toEqual(['w1.0:n1>n2:rhine', 'w2.0:n2>n3:noord', 'w3.0:n3>n4:noord']);
    expect((r.report as { rivers: unknown[] }).rivers).toContainEqual(
      expect.objectContaining({
        id: 'noord',
        relation: null,
        relation_tags: null,
        members: { drop_ways: 1, selected: 2 },
      }),
    );
    // A member-of row has no relation of its own: a missing parent relation is the parent's relation_missing only.
    expect(() => buildGraph(ws, [], rivers(rhine, noord), provenance)).toThrow(/^relation_missing: r1$/);
  });

  it('writes schema_version 2 on the graph and the reaches, and the same bytes whatever the input order', () => {
    const rf = (rs: River[]) => ({
      ...rivers(...rs),
      mouths: [
        {
          id: 'm',
          river: 'delta',
          at: [5.003, 51.003] as [number, number],
          max_m: 100,
          waterbody: 'noordzee',
          evidence: 's',
        },
      ],
    });
    const run = (w: WayFeature[], r: Relation[], rv: River[]) => {
      const out = buildGraph(ways(...w), r, rf(rv), provenance);
      return [canonicalJson(out.graph), canonicalJson(out.reaches), canonicalJson(out.report, 2)].join('');
    };
    const first = run(zoneLoop, zoneRels, [up, delta]);
    expect(run([...zoneLoop].reverse(), [...zoneRels].reverse(), [delta, up])).toBe(first);
    const r = buildGraph(ways(...zoneLoop), zoneRels, rf([up, delta]), provenance);
    expect(r.graph).toMatchObject({ schema_version: 2, mouths: [{ id: 'm', node: 'n3' }] });
    expect(r.reaches).toMatchObject({ schema_version: 2 });
    const props = (r.reaches as { features: { properties: unknown }[] }).features.map((f) => f.properties);
    expect(props[1]).toMatchObject({ id: 'w2.0', direction: 'none', direction_reason: 'tidal_zone' });
  });
});

describe('readWays', () => {
  it('refuses input over 256 MiB before it reads a line (input_too_large)', async () => {
    expect(MAX_WAYS_BYTES).toBe(256 * 1024 * 1024);
    // One untouched zero-filled chunk: the cap is checked before a byte of it is split.
    async function* big() {
      yield new Uint8Array(MAX_WAYS_BYTES + 1);
    }
    await expect(readWays(big())).rejects.toMatchObject({ code: 'input_too_large' });
  });
});

describe('parseProvenance', () => {
  const real = readFileSync(new URL('../tools/geo/fixtures/rivernet.provenance.json', import.meta.url), 'utf8');
  const edit = (f: (p: Record<string, unknown> & { regions: Record<string, unknown>[] }) => void) => {
    const p = JSON.parse(real);
    f(p);
    return JSON.stringify(p);
  };
  const refused = (text: string) => {
    try {
      parseProvenance(text);
    } catch (e) {
      return e instanceof BuildError && e.code === 'provenance_invalid' && e.ids.length === 0;
    }
    return false;
  };

  it('reads the committed fixture provenance', () => {
    expect(parseProvenance(real)).toMatchObject({ schema_version: 1, osmium: '1.19.1' });
    expect(parseProvenance(real).regions).toHaveLength(16);
  });

  it('refuses anything else with provenance_invalid and no detail', () => {
    for (const bad of [
      'not json',
      '[]',
      edit((p) => (p.schema_version = 2)),
      edit((p) => (p.replication_timestamp = '2026-10-01T20:22:06+02:00')),
      edit((p) => (p.replication_timestamp = '2026-10-01')),
      edit((p) => (p.extra = 1)),
      edit((p) => (p.regions = [])),
      edit((p) => ((p.regions[0] as Record<string, unknown>).url = 'http://download.geofabrik.de/x.osm.pbf')),
      edit((p) => ((p.regions[0] as Record<string, unknown>).md5 = 'A'.repeat(32))),
      edit((p) => ((p.regions[0] as Record<string, unknown>).sha256 = 'a'.repeat(63))),
      edit((p) => ((p.regions[0] as Record<string, unknown>).bytes = -1)),
      edit((p) => ((p.regions[0] as Record<string, unknown>).name = '<b>x</b>')),
      edit((p) => delete (p.regions[0] as Record<string, unknown>).replication_timestamp),
    ]) {
      expect(refused(bad), bad.slice(0, 60)).toBe(true);
    }
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}\n');
  });
});
