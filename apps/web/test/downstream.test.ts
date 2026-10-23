import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Branch, type Downstream, downstream, type End } from '../src/features/flow/downstream.ts';
import { mouthsOf, type ReachesRead, waterbodiesOf } from '../src/lib/data/chain.ts';
import { type ReachGraph, ReachGraphFile } from '../src/lib/data/contracts.ts';

// The downstream chain on the real river release (test/fixtures/reaches-fixture.json), parsed the way the web parses
// it (lenient subsets, never the strict ReachesFile), and on a small hand-built graph (P19b T3, issue #67).

const read = (file: object) => ({ manifest: {}, file }) as unknown as ReachesRead;
const raw: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url), 'utf8'),
);
const graph = ReachGraphFile.parse(raw);
const mouths = mouthsOf(read(raw));
const bodies = waterbodiesOf(read(raw));
const known = new Set(graph.stations.map((s) => s.id));
const tidal = new Set(graph.reaches.filter((r) => r.flags?.tidal === true).map((r) => r.id));
// A row is the down station of the reach walked, so that is the reach to check (a station's own reach_id starts at it).
const endingAt = new Map(graph.reaches.map((r) => [r.down_station_id, r.id]));

const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';
const EIJSDEN = 'nl.rws.eijsden.grens';
const EXITS = ['haringvliet-noordzee', 'nieuwe-waterweg-noordzee'];

const all = (b: Branch): Branch[] => [b, ...b.children.flatMap(all)];
const walk = (d: Downstream) => d.branches.flatMap(all);
const walkOf = (id: string, caps = {}) => downstream(graph, mouths, bodies, id, known, caps);
const ends = (d: Downstream): End[] => walk(d).map((b) => b.end);

describe('downstream (real fixture)', () => {
  it('Lobith: the delta exits once, and the IJssel branch to the Waddenzee', () => {
    const d = walkOf(LOBITH);
    const ids = d.exits.map((e) => e.mouth.id);
    for (const x of EXITS) expect(ids.filter((i) => i === x)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ends(d).some((e) => e.kind === 'delta')).toBe(true);
    const mouth = ends(d).find((e) => e.kind === 'mouth');
    expect(mouth).toMatchObject({ kind: 'mouth', mouth: { id: 'ijssel-ketelmeer' } });
    const steps = mouth?.kind === 'mouth' ? mouth.outflows.map((o) => `${o.from}>${o.to}`) : [];
    expect(steps).toEqual(['ketelmeer>ijsselmeer', 'ijsselmeer>waddenzee']);
  });
  it('Eijsden: both delta exits', () => {
    const ids = walkOf(EIJSDEN).exits.map((e) => e.mouth.id);
    for (const x of EXITS) expect(ids).toContain(x);
  });
  it('never follows a tidal reach: no row sits on one', () => {
    for (const id of [LOBITH, EIJSDEN, 'nl.rws.kampen.ijssel'])
      for (const b of walk(walkOf(id)))
        for (const r of b.rows) for (const s of r.ids) expect(tidal.has(endingAt.get(s) ?? ''), s).toBe(false);
  });
  it('a tidal start is a delta at once, with no rows', () => {
    const d = walkOf('de.wsv.3770030');
    expect(walk(d).flatMap((b) => b.rows)).toEqual([]);
    expect(d.branches[0]?.end).toEqual({ kind: 'delta' });
    expect(d.exits.length).toBeGreaterThan(0);
  });
  it('a schema 1 file (no waterbodies, no mouths) ends the network', () => {
    const { waterbodies: _w, mouths: _m, ...v1 } = raw;
    const d = downstream(ReachGraphFile.parse(v1), mouthsOf(read(v1)), waterbodiesOf(read(v1)), LOBITH, known);
    expect(d.exits).toEqual([]);
    expect(ends(d).every((e) => e.kind === 'end' || e.kind === 'joins')).toBe(true);
    expect(ends(d).some((e) => e.kind === 'end')).toBe(true);
  });
  it('holds its caps', () => {
    const rows = (d: Downstream) => walk(d).reduce((n, b) => n + b.rows.length, 0);
    expect(rows(walkOf(LOBITH, { reaches: 3 }))).toBeLessThanOrEqual(3);
    expect(walkOf(LOBITH, { depth: 0 }).branches[0]?.children).toEqual([]);
  });
  it('a station the file does not place has no walk', () => {
    expect(walkOf('nope').branches).toEqual([]);
  });
});

describe('downstream (hand-built)', () => {
  const rc = (id: string, down: string, downstream: string[]): ReachGraph['reaches'][number] => ({
    id,
    river_id: 'x',
    up_station_id: null,
    down_station_id: down,
    upstream: [],
    downstream,
    length_km: 1,
    km_graph_from: null,
    km_graph_to: null,
    flags: { tidal: false, impounded: false, bifurcation: false },
  });
  it('terminates on a cycle', () => {
    const g: ReachGraph = {
      stations: ['a', 'b', 'c'].map((id, i) => ({ id, river_id: 'x', reach_id: `x.${i}`, km_graph: 1 })),
      reaches: [rc('x.0', 'a', ['x.1']), rc('x.1', 'b', ['x.2']), rc('x.2', 'c', ['x.0'])],
    };
    const d = downstream(g, [], [], 'a', new Set(['a', 'b', 'c']));
    expect(walk(d)[0]?.rows.length).toBeLessThanOrEqual(3);
    expect(d.branches[0]?.end).toEqual({ kind: 'joins' });
  });
});
