import { describe, expect, it } from 'vitest';
import type { RiversFile } from '../packages/contracts/src/rivers.ts';
import { BuildError, buildGraph, canonicalJson, type Provenance } from '../tools/geo/rivernet/build.ts';
import type { WayFeature } from '../tools/geo/rivernet/geojsonseq.ts';
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
    expect(graph.edges[0]).toEqual({ from: 'n1', id: 'w10.0', length_m: 262.8, rivers: ['main'], to: 'n3', way: 10 });
    expect(Object.keys(graph)).toEqual([...Object.keys(graph)].sort());
    expect(graph).toMatchObject({ licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors' });
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}\n');
  });
});
