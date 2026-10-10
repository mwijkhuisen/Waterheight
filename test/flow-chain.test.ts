import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ChainNode, chain, GAP_KM } from '../apps/web/src/features/flow/chain.ts';
import { type ReachGraph, ReachGraphFile } from '../apps/web/src/lib/data/contracts.ts';
import { ReachRiver } from '../packages/contracts/src/reaches.ts';
import { repoRoot } from './catalogue.ts';

// The upstream chain on the committed fixture river release (P11a, issue #26 C3): the web's lenient graph reader on
// test/fixtures/reaches-fixture.json (production placement of tools/geo/fixtures), and a few hand-built graphs for
// the rules (co-location, sink, gap pieces, owner parts, cycles).

const file: { rivers: unknown[] } = JSON.parse(readFileSync(`${repoRoot}test/fixtures/reaches-fixture.json`, 'utf8'));
const graph = ReachGraphFile.parse(file);
const rivers = file.rivers.map((r) => ReachRiver.parse(r));
const everyone = new Set(graph.stations.map((s) => s.id));

const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';
const PANNERDEN = 'nl.rws.millingenaanderijn.pannerdensekop';
const NIJMEGEN = 'nl.rws.nijmegen.waal';
const EIJSDEN = 'nl.rws.eijsden.grens';

/** Every station id of the nodes, in order, groups flattened in place. */
const idsOf = (nodes: readonly ChainNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === 'station' ? [...n.ids] : n.kind === 'group' ? idsOf(n.children) : []));
/** The ids of the top level (the main stem) only. */
const stemIds = (nodes: readonly ChainNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === 'station' ? [...n.ids] : []));
const rowsOf = (nodes: readonly ChainNode[]): number =>
  nodes.reduce((a, n) => a + (n.kind === 'station' ? 1 : n.kind === 'group' ? rowsOf(n.children) : 0), 0);
const groupsOf = (nodes: readonly ChainNode[]) => nodes.flatMap((n) => (n.kind === 'group' ? [n] : []));
const allGroups = (nodes: readonly ChainNode[]): ChainNode[] =>
  groupsOf(nodes).flatMap((g) => [g, ...allGroups(g.children)]);
const subsequence = (all: readonly string[], want: readonly string[]) => {
  let at = -1;
  for (const w of want) {
    at = all.indexOf(w, at + 1);
    if (at < 0) return false;
  }
  return true;
};

describe('the fixture chains', () => {
  it('has the Rhine chain of Lobith: Emmerich, Rees, Wesel, Ruhrort, Düsseldorf, Köln, without a gap', () => {
    const nodes = chain(graph, rivers, LOBITH, everyone);
    expect(
      subsequence(stemIds(nodes), [
        'de.wsv.2790020',
        'de.wsv.2790010',
        'de.wsv.2770040',
        'de.wsv.2770010',
        'de.wsv.2750010',
        'de.wsv.2730010',
      ]),
    ).toBe(true);
    expect(stemIds(nodes).slice(0, 2)).toEqual(['de.wsv.2790020', 'de.wsv.2790010']);
    expect(nodes.some((n) => n.kind === 'gap')).toBe(false);
    // the tributaries are collapsed at their confluences, not walked on the main stem
    const tribs = groupsOf(nodes).map((g) => g.kind === 'group' && g.riverId);
    expect(tribs).toEqual(
      expect.arrayContaining(['lippe', 'ruhr', 'sieg', 'moselle', 'lahn', 'main', 'neckar', 'aare']),
    );
    expect(stemIds(nodes)).not.toContain(LOBITH);
  });

  it('climbs back through the split: Nijmegen, Pannerdensche Kop, Lobith, Emmerich', () => {
    const ids = stemIds(chain(graph, rivers, NIJMEGEN, everyone));
    expect(ids.slice(0, 4)).toEqual(['nl.rws.millingenaanderijn', PANNERDEN, LOBITH, 'de.wsv.2790020']);
    // the Rhine above the split is the same chain as Lobith's
    const lobith = stemIds(chain(graph, rivers, LOBITH, everyone));
    expect(ids.slice(3)).toEqual(lobith);
  });

  it('has the Meuse chain of the public Eijsden: a gap with the Sambre, then Chooz up to Saint-Mihiel', () => {
    const nodes = chain(graph, rivers, EIJSDEN, everyone);
    const firstRow = nodes.findIndex((n) => n.kind === 'station');
    const row = nodes[firstRow];
    expect(row?.kind === 'station' && row.ids).toEqual(['fr.sandre.B720000002']);
    // F1: Lixhe lies downstream of Eijsden in the graph; between the border and Chooz there is no station row
    expect(nodes.slice(0, firstRow).every((n) => n.kind !== 'station')).toBe(true);
    expect(nodes[0]).toMatchObject({ kind: 'gap', riverId: 'meuse' });
    const sambre = nodes[1];
    expect(sambre).toMatchObject({ kind: 'group', riverId: 'sambre' });
    expect(
      sambre?.kind === 'group' &&
        allGroups(sambre.children)
          .map((g) => g.kind === 'group' && g.riverId)
          .sort(),
    ).toEqual(['hante', 'helpe-majeure', 'helpe-mineure', 'thure']);
    expect(sambre?.kind === 'group' && idsOf(sambre.children)).toEqual(
      expect.arrayContaining(['fr.sandre.D016221001', 'fr.sandre.D022000101', 'fr.sandre.D022000201']),
    );
    // gap, group, gap ... the pieces add up to the stretch to Chooz
    const gaps = nodes.slice(0, firstRow).flatMap((n) => (n.kind === 'gap' ? [n.km] : []));
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.reduce((a, b) => a + b, 0)).toBeGreaterThan(GAP_KM);
    expect(nodes[firstRow - 1]?.kind).toBe('gap');

    const stem = stemIds(nodes);
    expect(stem.slice(0, 3)).toEqual(['fr.sandre.B720000002', 'fr.sandre.B720000001', 'fr.sandre.B720000004']);
    expect(stem.at(-1)).toBe('fr.sandre.B110000001');
    const tribs = groupsOf(nodes.slice(firstRow)).map((g) => g.kind === 'group' && g.riverId);
    expect(tribs).toEqual(expect.arrayContaining(['semois', 'chiers']));
    // two stations at one chainage are one row
    const chooz = nodes[firstRow + 1];
    expect(chooz?.kind === 'station' && chooz.ids).toEqual(['fr.sandre.B720000001', 'fr.sandre.B720000004']);
    expect(nodes.filter((n) => n.kind === 'station' && n.ids.includes('fr.sandre.B720000004'))).toHaveLength(1);

    const all = idsOf(nodes);
    expect(all).not.toContain('nl.rws.lixhebiefaval');
    expect(all.filter((i) => /smeermaas|kanne|twin|canary|lixhe/i.test(i))).toEqual([]);
  });

  it('leaves out the stations the page does not know, and a group that then has none', () => {
    const known = new Set(everyone);
    for (const id of ['de.wsv.2790010', 'de.wsv.2790020']) known.delete(id);
    for (const g of allGroups(chain(graph, rivers, LOBITH, everyone)))
      if (g.kind === 'group' && g.riverId === 'lippe') for (const i of idsOf(g.children)) known.delete(i);
    const nodes = chain(graph, rivers, LOBITH, known);
    expect(stemIds(nodes)[0]).toBe('de.wsv.2770040');
    expect(groupsOf(nodes).some((g) => g.riverId === 'lippe')).toBe(false);
    expect(idsOf(nodes).every((i) => known.has(i))).toBe(true);
  });

  it('marks an arm of the river it joins as a branch, a tributary not (the Neckar groups of Lobith)', () => {
    const top = groupsOf(chain(graph, rivers, LOBITH, everyone));
    const neckar = top.find((g) => g.kind === 'group' && g.riverId === 'neckar');
    if (neckar?.kind !== 'group') throw new Error('no Neckar group in the Lobith chain');
    expect(neckar.sameRiver).toBeUndefined(); // it joins the Rhine
    const arms = allGroups(neckar.children).filter((g) => g.kind === 'group' && g.riverId === 'neckar');
    expect(arms.length).toBeGreaterThan(0);
    expect(arms.every((g) => g.kind === 'group' && g.sameRiver === true)).toBe(true);
  });

  it('is empty for a station the file does not place', () => {
    expect(chain(graph, rivers, 'nl.nowhere.x', everyone)).toEqual([]);
    expect(chain(graph, rivers, 'fr.sandre.B110000001', everyone)).toEqual([]);
  });
});

// A station of the fixture that the file places is a chain target.
const placed = graph.stations.filter((s) => s.reach_id !== null && s.km_graph !== null).map((s) => s.id);

/** Every node of the chain, with its depth. */
function walk(nodes: readonly ChainNode[], f: (n: ChainNode, top: boolean) => void, top = true) {
  for (const n of nodes) {
    f(n, top);
    if (n.kind === 'group') walk(n.children, f, false);
  }
}

describe('the chain of every placed station', () => {
  const check = (target: string, known: ReadonlySet<string>) => {
    const nodes = chain(graph, rivers, target, known);
    const seen = new Set<string>();
    let last = 0;
    walk(nodes, (n, top) => {
      if (n.kind === 'station') {
        for (const id of n.ids) {
          expect(seen.has(id), `${id} twice in the chain of ${target}`).toBe(false);
          seen.add(id);
          expect(known.has(id)).toBe(true);
          expect(id).not.toBe(target);
        }
        if (top) {
          expect(n.distKm).toBeGreaterThanOrEqual(last);
          last = n.distKm;
        }
      } else if (n.kind === 'group') {
        // a group is a real tributary: rows inside, and its count is the rows of its subtree
        expect(n.count).toBeGreaterThan(0);
        expect(n.count).toBe(rowsOf(n.children));
        expect(n.children.every((c) => c.kind !== 'gap')).toBe(true);
      } else {
        expect(top).toBe(true);
        expect(n.km).toBeGreaterThan(0);
      }
    });
    // a gap is followed by something upstream: a group or a row
    nodes.forEach((n, i) => {
      if (n.kind === 'gap') expect(nodes[i + 1]).toBeDefined();
    });
  };

  it('repeats no station, keeps the main stem ordered and the groups whole (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...placed), (target) => check(target, everyone)),
      { numRuns: 150 },
    );
  });

  it('holds for any set of known stations (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...placed), fc.integer({ min: 2, max: 5 }), (target, k) => {
        const known = new Set(graph.stations.filter((_, i) => i % k !== 0).map((s) => s.id));
        check(target, known);
      }),
      { numRuns: 100 },
    );
  });
});

type S = ReachGraph['stations'][number];
type R = ReachGraph['reaches'][number];
const st = (id: string, river: string, reach: string | null, km: number | null = 1): S => ({
  id,
  river_id: river,
  reach_id: reach,
  km_graph: km,
});
const rc = (
  id: string,
  river: string,
  up: string | null,
  down: string | null,
  upstream: string[] = [],
  len = 10,
  extra: Partial<R> = {},
): R => ({
  id,
  river_id: river,
  up_station_id: up,
  down_station_id: down,
  upstream,
  downstream: [],
  length_km: len,
  km_graph_from: null,
  km_graph_to: null,
  flags: null,
  ...extra,
});
const river = (id: string, parent: string | null) => ({
  id,
  name_nl: id,
  name_en: id,
  parent_river_id: parent,
  km_direction: 'downstream' as const,
});

describe('the walk rules on small graphs', () => {
  // r: A -- B -- C(target) with the tributary t joining above B (T1, T2) and a branch w that splits off r at B.
  const g: ReachGraph = {
    stations: [
      st('A', 'r', 'r.1', 0),
      st('B', 'r', 'r.2', 10),
      st('C', 'r', 'r.3', 20),
      st('B2', 'r', 'r.2', 10),
      st('T1', 't', 't.1', 0),
      st('T2', 't', 't.2', 5),
    ],
    reaches: [
      rc('r.1', 'r', 'A', 'B', [], 10),
      rc('r.2', 'r', 'B', 'C', ['r.1', 't.2'], 10),
      rc('r.3', 'r', 'C', null, ['r.2'], 10),
      rc('t.1', 't', 'T1', 'T2', [], 5),
      rc('t.2', 't', 'T2', null, ['t.1'], 5),
    ],
  };
  const rv = [river('r', null), river('t', 'r')];

  it('gives the main stem its co-located stations in one row and the tributary a group, in walk order', () => {
    const nodes = chain(g, rv, 'C', new Set(['A', 'B', 'B2', 'C', 'T1', 'T2']));
    expect(nodes).toEqual([
      { kind: 'station', ids: ['B', 'B2'], riverId: 'r', distKm: 10 },
      {
        kind: 'group',
        riverId: 't',
        count: 2,
        children: [
          { kind: 'station', ids: ['T2'], riverId: 't', distKm: 15 },
          { kind: 'station', ids: ['T1'], riverId: 't', distKm: 20 },
        ],
      },
      { kind: 'station', ids: ['A'], riverId: 'r', distKm: 20 },
    ]);
  });

  it('keeps the co-located stations the page knows and skips the row when none is known', () => {
    expect(chain(g, rv, 'C', new Set(['B2', 'A']))[0]).toMatchObject({ ids: ['B2'] });
    expect(chain(g, rv, 'C', new Set(['A']))).toEqual([{ kind: 'station', ids: ['A'], riverId: 'r', distKm: 20 }]);
  });

  it('never makes a co-located station of the target a row', () => {
    const same: ReachGraph = { ...g, stations: [...g.stations, st('C2', 'r', 'r.3', 20)] };
    expect(idsOf(chain(same, rv, 'C2', new Set(['A', 'B', 'C', 'C2'])))).toEqual(['B', 'A']);
    expect(idsOf(chain(same, rv, 'C', new Set(['A', 'B', 'C', 'C2'])))).toEqual(['B', 'A']);
  });

  it('starts at the reach that ends at a station at a sink', () => {
    const sink: ReachGraph = {
      stations: [st('P', 's', 's.1', 0), st('Q', 's', 's.1', 5)],
      reaches: [rc('s.1', 's', 'P', 'Q', [], 5)],
    };
    expect(chain(sink, [river('s', null)], 'Q', new Set(['P', 'Q']))).toEqual([
      { kind: 'station', ids: ['P'], riverId: 's', distKm: 5 },
    ]);
  });

  it('splits a stretch above GAP_KM at a tributary: gap, group, gap, row', () => {
    const far: ReachGraph = {
      stations: [st('X', 'r', 'r.2', 0), st('Y', 'r', 'r.3', 0), st('TT', 't', 't.1', 0)],
      reaches: [
        rc('r.3', 'r', 'Y', null, ['r.2'], 5),
        rc('r.2', 'r', null, null, ['r.1', 't.1'], GAP_KM / 2),
        rc('r.1', 'r', 'X', null, [], GAP_KM),
        rc('t.1', 't', 'TT', null, [], 1),
      ],
    };
    const nodes = chain(far, rv, 'Y', new Set(['X', 'Y', 'TT']));
    expect(nodes.map((n) => n.kind)).toEqual(['gap', 'group', 'gap', 'station']);
    expect(nodes[0]).toMatchObject({ riverId: 'r', km: GAP_KM / 2 });
    expect(nodes[2]).toMatchObject({ riverId: 'r', km: GAP_KM });
    // exactly GAP_KM is not a gap
    const near: ReachGraph = { ...far, reaches: far.reaches.map((r) => (r.id === 'r.1' ? { ...r, length_km: 1 } : r)) };
    expect(chain(near, rv, 'Y', new Set(['X', 'Y'])).map((n) => n.kind)).toEqual(['station']);
  });

  it('takes the river this one flows into when no upstream reach is on the same river', () => {
    // the waal starts at a split of the rhine: its upstream reach is a rhine reach, with the other arm beside it
    const split: ReachGraph = {
      stations: [st('W', 'waal', 'waal.1', 0), st('R', 'rhine', 'rhine.1', 0), st('K', 'kanaal', 'kanaal.1', 0)],
      reaches: [
        rc('waal.1', 'waal', 'W', null, ['kanaal.1', 'rhine.1'], 5),
        rc('rhine.1', 'rhine', 'R', null, [], 5),
        rc('kanaal.1', 'kanaal', 'K', null, [], 5),
      ],
    };
    const rvs = [river('rhine', null), river('waal', 'rhine'), river('kanaal', 'waal')];
    const nodes = chain(split, rvs, 'W', new Set(['W', 'R', 'K']));
    expect(stemIds(nodes)).toEqual(['R']);
    expect(groupsOf(nodes).map((n) => n.kind === 'group' && n.riverId)).toEqual(['kanaal']);
  });

  it('walks the parts of an owner variant like the reaches they were cut from', () => {
    // r.2 cut at the owner station O into r.2-1 (O upstream end) and r.2-2: ids and part_of as the owner file has them
    const owner: ReachGraph = {
      stations: [st('A', 'r', 'r.1', 0), st('B', 'r', 'r.2-1', 10), st('O', 'r', 'r.2-2', 15), st('C', 'r', 'r.3', 20)],
      reaches: [
        rc('r.1', 'r', 'A', 'B', [], 10),
        rc('r.2-1', 'r', 'B', 'O', ['r.1'], 5, { part_of: 'r.2' }),
        rc('r.2-2', 'r', 'O', 'C', ['r.2-1'], 5, { part_of: 'r.2' }),
        rc('r.3', 'r', 'C', null, ['r.2-2'], 10),
      ],
    };
    expect(chain(owner, rv, 'C', new Set(['A', 'B', 'O', 'C']))).toEqual([
      { kind: 'station', ids: ['O'], riverId: 'r', distKm: 5 },
      { kind: 'station', ids: ['B'], riverId: 'r', distKm: 10 },
      { kind: 'station', ids: ['A'], riverId: 'r', distKm: 20 },
    ]);
  });

  it('ends on a cycle', () => {
    const loop: ReachGraph = {
      stations: [st('X', 'x', 'c.1'), st('Y', 'x', 'c.2')],
      reaches: [rc('c.1', 'x', 'X', null, ['c.2']), rc('c.2', 'x', 'Y', null, ['c.1'])],
    };
    const nodes = chain(loop, [river('x', null)], 'X', new Set(['X', 'Y']));
    expect(idsOf(nodes)).toEqual(['Y']);
  });
});
