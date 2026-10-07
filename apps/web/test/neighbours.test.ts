import { describe, expect, it } from 'vitest';
import { neighbours } from '../src/features/station/neighbours.ts';
import { graphOf } from '../src/lib/data/chain.ts';
import type { ReachGraph } from '../src/lib/data/contracts.ts';

// The neighbour walk on a hand-built reaches file (P10d). Ids follow the real file's shape: a reach `<river>.<seq>`
// starts at a station (`reach_id`); `down_station_id` is the station at its end, `up_station_id` the one at its start.

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
  downstream: string[] = [],
): R => ({ id, river_id: river, up_station_id: up, down_station_id: down, upstream, downstream });

// rhine: A → B → C → D, with the Moselle joining at B (its last gauge M) and a bifurcation after D into the Waal (W)
// and the Lek (L, same river as the Rhine's branch `rhine.5`).
const graph: ReachGraph = {
  stations: [
    st('A', 'rhine', 'rhine.1'),
    st('B', 'rhine', 'rhine.2'),
    st('C', 'rhine', 'rhine.3'),
    st('D', 'rhine', 'rhine.4'),
    st('M', 'moselle', 'moselle.1'),
    st('W', 'waal', 'waal.2'),
    st('L', 'rhine', 'rhine.6'),
    st('U', 'rhine', null),
    st('V', 'rhine', 'rhine.9', null),
  ],
  reaches: [
    rc('rhine.1', 'rhine', 'A', 'B', [], ['rhine.2']),
    rc('rhine.2', 'rhine', 'B', 'C', ['rhine.1', 'moselle.1'], ['rhine.3']),
    rc('moselle.1', 'moselle', 'M', 'B', [], ['rhine.2']),
    rc('rhine.3', 'rhine', 'C', 'D', ['rhine.2'], ['rhine.4']),
    rc('rhine.4', 'rhine', 'D', null, ['rhine.3'], ['waal.1', 'rhine.5']),
    rc('waal.1', 'waal', null, 'W', ['rhine.4'], ['waal.2']),
    rc('waal.2', 'waal', 'W', null, ['waal.1'], []),
    rc('rhine.5', 'rhine', null, 'L', ['rhine.4'], ['rhine.6']),
    rc('rhine.6', 'rhine', 'L', null, ['rhine.5'], []),
  ],
};
const all = new Set(graph.stations.map((s) => s.id));

describe('neighbours', () => {
  it('finds the stations up and down the same river', () => {
    expect(neighbours('C', graph, all)).toEqual({
      up: { id: 'B', riverId: 'rhine', crossRiver: false },
      down: { id: 'D', riverId: 'rhine', crossRiver: false },
    });
  });

  it('has no neighbour at a river source, a river end, an unplaced station or one the file lacks', () => {
    expect(neighbours('A', graph, all).up).toBeUndefined();
    expect(neighbours('A', graph, all).down?.id).toBe('B');
    expect(neighbours('M', graph, all).up).toBeUndefined();
    expect(neighbours('L', graph, all).down).toBeUndefined();
    expect(neighbours('L', graph, all).up?.id).toBe('D');
    expect(neighbours('U', graph, all)).toEqual({});
    expect(neighbours('V', graph, all)).toEqual({});
    expect(neighbours('nl.nowhere', graph, all)).toEqual({});
  });

  it('crosses to another river upstream too: the first gauge of the Waal looks up onto the Rhine', () => {
    expect(neighbours('W', graph, all).up).toEqual({ id: 'D', riverId: 'rhine', crossRiver: true });
  });

  it('crosses to another river: the last gauge of the Moselle looks down onto the Rhine', () => {
    expect(neighbours('M', graph, all)).toEqual({ down: { id: 'B', riverId: 'rhine', crossRiver: true } });
  });

  it('prefers the same river at a confluence and at a bifurcation', () => {
    expect(neighbours('B', graph, all).up?.id).toBe('A');
    // rhine.4 forks into the waal first in file order, but the Rhine's own branch wins
    expect(neighbours('D', graph, all).down).toEqual({ id: 'L', riverId: 'rhine', crossRiver: false });
  });

  it('takes the first branch in file order when none is on the same river', () => {
    const g: ReachGraph = {
      stations: [st('X', 'x', 'x.1'), st('Y', 'y', 'y.2'), st('Z', 'z', 'z.2')],
      reaches: [rc('x.1', 'x', 'X', null, [], ['y.1', 'z.1']), rc('y.1', 'y', null, 'Y'), rc('z.1', 'z', null, 'Z')],
    };
    expect(neighbours('X', g, new Set(['X', 'Y', 'Z'])).down).toEqual({ id: 'Y', riverId: 'y', crossRiver: true });
  });

  it('falls back to the other branch when the preferred one holds no station', () => {
    const g: ReachGraph = {
      stations: [st('X', 'x', 'x.1'), st('Y', 'y', 'y.2')],
      reaches: [rc('x.1', 'x', 'X', null, [], ['x.2', 'y.1']), rc('x.2', 'x', null, null), rc('y.1', 'y', null, 'Y')],
    };
    expect(neighbours('X', g, new Set(['X', 'Y'])).down?.id).toBe('Y');
  });

  it('walks past an id the page does not know', () => {
    expect(neighbours('B', graph, new Set(['A', 'B', 'D'])).down?.id).toBe('D');
    expect(neighbours('B', graph, new Set(['B'])).up).toBeUndefined();
  });

  it('never makes a co-located station its own neighbour', () => {
    // C and C2 share the reach that starts at their position: only C is `up_station_id`
    const g: ReachGraph = {
      stations: [...graph.stations, st('C2', 'rhine', 'rhine.3')],
      reaches: graph.reaches,
    };
    const set = new Set([...all, 'C2']);
    expect(neighbours('C2', g, set).down?.id).toBe('D');
    expect(neighbours('C2', g, set).up?.id).toBe('B');
    expect(neighbours('C', g, set).down?.id).toBe('D');
  });

  it('starts the upstream search on its own reach for a station at a sink', () => {
    const g: ReachGraph = {
      stations: [st('P', 's', 's.1', 0), st('Q', 's', 's.1', 5)],
      reaches: [rc('s.1', 's', 'P', 'Q')],
    };
    const set = new Set(['P', 'Q']);
    expect(neighbours('Q', g, set)).toEqual({ up: { id: 'P', riverId: 's', crossRiver: false } });
  });

  // Review round 1: the station at the start of a reach that ends at a sink shares that reach with the sink station.
  it('never takes a co-located station on a reach that ends at a sink, at either end', () => {
    // O → (A0 = A1) → (T0 = T1, sink): A0 and T0 are the file's named ends
    const g: ReachGraph = {
      stations: [st('O', 's', 's.1', 0), st('A0', 's', 's.2', 3), st('A1', 's', 's.2', 3), st('T0', 's', 's.2', 9)],
      reaches: [rc('s.1', 's', 'O', 'A0', [], ['s.2']), rc('s.2', 's', 'A0', 'T0', ['s.1'], [])],
    };
    const g2: ReachGraph = { ...g, stations: [...g.stations, st('T1', 's', 's.2', 9)] };
    const set = new Set(['O', 'A0', 'A1', 'T0', 'T1']);
    expect(neighbours('A1', g2, set)).toEqual({
      up: { id: 'O', riverId: 's', crossRiver: false },
      down: { id: 'T0', riverId: 's', crossRiver: false },
    });
    expect(neighbours('A0', g2, set).up?.id).toBe('O');
    expect(neighbours('T1', g2, set)).toEqual({ up: { id: 'A0', riverId: 's', crossRiver: false } });
    expect(neighbours('T0', g2, set)).toEqual({ up: { id: 'A0', riverId: 's', crossRiver: false } });
  });

  it('ends on a cycle, and stops at the depth cap', () => {
    const loop: ReachGraph = {
      stations: [st('X', 'x', 'c.1')],
      reaches: [rc('c.1', 'x', 'X', null, ['c.2'], ['c.2']), rc('c.2', 'x', null, null, ['c.1'], ['c.1'])],
    };
    expect(neighbours('X', loop, new Set(['X']))).toEqual({});

    const n = 300;
    const reaches = Array.from({ length: n }, (_, i) =>
      rc(`l.${i + 1}`, 'l', i === 0 ? 'X' : null, i === n - 1 ? 'Y' : null, [], i === n - 1 ? [] : [`l.${i + 2}`]),
    );
    const far: ReachGraph = { stations: [st('X', 'l', 'l.1'), st('Y', 'l', 'l.300')], reaches };
    expect(neighbours('X', far, new Set(['X', 'Y'])).down).toBeUndefined();
    const near: ReachGraph = {
      stations: far.stations,
      reaches: reaches.slice(0, 100).map((r, i) => (i === 99 ? { ...r, down_station_id: 'Y' } : r)),
    };
    expect(neighbours('X', near, new Set(['X', 'Y'])).down?.id).toBe('Y');
  });
});

describe('graphOf', () => {
  const read = (file: Record<string, unknown>) => graphOf({ manifest: {} as never, file });

  it('drops a bad row, empties a bad section and never throws', () => {
    const got = read({
      stations: [st('A', 'rhine', 'rhine.1'), { id: 7 }, null, { ...st('B', 'rhine', null), extra: true }],
      reaches: 'nope',
    });
    expect(got.stations.map((s) => s.id)).toEqual(['A', 'B']);
    expect(got.reaches).toEqual([]);
    expect(read({})).toEqual({ stations: [], reaches: [] });
  });

  it('keeps a prototype-named id as plain data', () => {
    const got = read({
      stations: [st('__proto__', 'rhine', 'rhine.1')],
      reaches: [rc('rhine.1', 'rhine', null, null)],
    });
    expect(neighbours('__proto__', got, new Set(['__proto__']))).toEqual({});
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
});
