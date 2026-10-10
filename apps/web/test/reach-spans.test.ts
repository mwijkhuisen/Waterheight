import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { binCount } from '../src/features/flow/reaches/bins.ts';
import { spansOf } from '../src/features/flow/reaches/spans.ts';
import { type ReachGraph, ReachGraphFile } from '../src/lib/data/contracts.ts';

// The spans of the reach colouring (P11b, issue #26) on the committed river release and on small hand-made graphs.

const graph = ReachGraphFile.parse(
  JSON.parse(readFileSync(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url), 'utf8')),
);
const known = new Set(graph.stations.map((s) => s.id));
const spans = spansOf(graph, known);
const at = (id: string) => spans.get(id)?.span;

describe('spansOf on the fixture release', () => {
  it('has an entry for every reach, and none for the canal gauges (not in the graph)', () => {
    expect(spans.size).toBe(graph.reaches.length);
    for (const id of ['nl.rws.smeermaas.zuidwillemsvaart', 'nl.rws.kanne']) {
      expect(known.has(id)).toBe(false);
      for (const fs of spans.values()) {
        expect(fs.span?.up ?? []).not.toContain(id);
        expect(fs.span?.down ?? []).not.toContain(id);
      }
    }
  });

  it('keeps every pos in 0..1, and a tidal reach tidal', () => {
    for (const fs of spans.values()) {
      if (fs.span?.pos === null || fs.span === null) continue;
      expect(fs.span.pos).toBeGreaterThanOrEqual(0);
      expect(fs.span.pos).toBeLessThanOrEqual(1);
    }
    for (const [id, fs] of spans) if (fs.tidal === true) expect(fs.span === null || fs.span.tidal, id).toBe(true);
  });

  it('measures the Chooz to Eijsden gap as meuse.24 to 27, 139 km, and the next stretch apart', () => {
    for (const id of ['meuse.24', 'meuse.25', 'meuse.26', 'meuse.27']) {
      expect(at(id)?.up).toEqual(['fr.sandre.B720000002']);
      expect(at(id)?.down).toEqual(['nl.rws.eijsden.grens']);
      expect(at(id)?.lengthKm).toBeCloseTo(139.222, 3);
    }
    expect(at('meuse.23')?.lengthKm).toBeCloseTo(2.323, 3);
    expect(at('meuse.28')?.lengthKm).toBeCloseTo(0.174, 3);
  });

  it('groups co-located stations in file order at a span end', () => {
    expect(at('meuse.23')?.up).toEqual(['fr.sandre.B720000001', 'fr.sandre.B720000004']);
  });

  it('walks every arm of a bifurcation, a reach on two paths taking the first in walk order', () => {
    // nederrijn.3 leaves into 4 and 5; both arms end at Driel beneden.
    for (const id of ['nederrijn.3', 'nederrijn.4', 'nederrijn.5']) {
      expect(at(id)?.up).toEqual(['nl.rws.driel.boven']);
      expect(at(id)?.down).toEqual(['nl.rws.driel.beneden']);
    }
    expect(at('nederrijn.3')?.lengthKm).toBeCloseTo(0.658, 3); // 3 + 4, the first arm
    expect(at('nederrijn.4')?.lengthKm).toBeCloseTo(0.658, 3);
    expect(at('nederrijn.5')?.lengthKm).toBeCloseTo(0.667, 3); // 3 + 5 is only walked second
    // scheldt.8 into 9 and 10; moselle.15 into 17 and 18.
    for (const id of ['scheldt.8', 'scheldt.9', 'scheldt.10']) expect(at(id)?.down).toEqual(['nl.rws.antwerpen']);
    expect(at('scheldt.8')?.lengthKm).toBeCloseTo(165.581, 3);
    expect(at('scheldt.8')?.tidal).toBe(true); // a span with a tidal reach
    expect(spans.get('scheldt.8')?.tidal).toBe(false); // the reach itself is not
    expect(at('moselle.15')?.lengthKm).toBeCloseTo(30.17, 3);
    expect(at('moselle.18')?.lengthKm).toBeCloseTo(30.131, 3);
    expect(at('moselle.17')?.down).toEqual(at('moselle.18')?.down);
  });

  it('puts the midpoint of a reach on its span by the lengths before it', () => {
    const len = (id: string) => graph.reaches.find((r) => r.id === id)?.length_km ?? Number.NaN;
    const total = len('meuse.24') + len('meuse.25') + len('meuse.26') + len('meuse.27');
    expect(at('meuse.24')?.pos).toBeCloseTo(len('meuse.24') / 2 / total, 9);
    expect(at('meuse.25')?.pos).toBeCloseTo((len('meuse.24') + len('meuse.25') / 2) / total, 9);
    expect(at('meuse.26')?.pos).toBeCloseTo((len('meuse.24') + len('meuse.25') + len('meuse.26') / 2) / total, 9);
    expect(at('meuse.27')?.pos).toBeCloseTo(
      (len('meuse.24') + len('meuse.25') + len('meuse.26') + len('meuse.27') / 2) / total,
      9,
    );
  });

  it('leaves a tributary open: its last stretch before the confluence has no span', () => {
    const rivers = new Map(graph.reaches.map((r) => [r.id, r.river_id]));
    const tails = graph.reaches.filter(
      (r) =>
        r.downstream.length > 0 &&
        r.downstream.every((d) => rivers.get(d) !== r.river_id) &&
        !(r.down_station_id !== null && known.has(r.down_station_id)),
    );
    expect(tails.length).toBeGreaterThan(5);
    for (const r of tails) expect(spans.get(r.id)?.span, r.id).toBeNull();
  });
});

// A graph by hand: r1 (station A) - r2 - r3 (station B) on one river, c1 and c2 in a cycle from station C.
const st = (id: string, reach: string | null, km: number | null) => ({
  id,
  river_id: 'x',
  reach_id: reach,
  km_graph: km,
});
const re = (
  id: string,
  up: string | null,
  down: string | null,
  ups: string[],
  downs: string[],
  len: number | null,
) => ({
  id,
  river_id: 'x',
  up_station_id: up,
  down_station_id: down,
  upstream: ups,
  downstream: downs,
  length_km: len,
  km_graph_from: 0,
  km_graph_to: len,
  flags: { tidal: false, impounded: false, bifurcation: false },
});
const tiny = (reaches: ReturnType<typeof re>[], stations: ReturnType<typeof st>[]): ReachGraph =>
  ReachGraphFile.parse({ stations, reaches });

describe('spansOf on small graphs', () => {
  const base = () => [
    re('x.1', 'A', null, [], ['x.2'], 10),
    re('x.2', null, null, ['x.1'], ['x.3'], 30),
    re('x.3', 'B', null, ['x.2'], [], 10),
  ];
  const stations = [st('A', 'x.1', 0), st('B', 'x.3', 0)];

  it('closes a span at the next known station and ignores an unknown one', () => {
    const g = tiny(base(), stations);
    expect(spansOf(g, new Set(['A', 'B'])).get('x.2')?.span).toMatchObject({
      up: ['A'],
      down: ['B'],
      lengthKm: 40,
      pos: 0.625,
    });
    expect(spansOf(g, new Set(['A', 'B'])).get('x.3')?.span).toBeNull();
    expect(spansOf(g, new Set(['A'])).get('x.1')?.span).toBeNull(); // B unknown: the path ends open
  });

  it('never interpolates over a null length or null flags', () => {
    const noLen = base();
    noLen[1] = { ...(noLen[1] as ReturnType<typeof re>), length_km: null };
    expect(spansOf(tiny(noLen, stations), new Set(['A', 'B'])).get('x.1')?.span).toMatchObject({
      lengthKm: null,
      pos: null,
    });
    const noFlags = tiny(base(), stations);
    const r2 = noFlags.reaches.find((r) => r.id === 'x.2');
    if (r2 === undefined) throw new Error('x.2');
    r2.flags = null;
    expect(spansOf(noFlags, new Set(['A', 'B'])).get('x.2')).toMatchObject({
      tidal: null,
      span: { lengthKm: null, pos: null, tidal: true },
    });
  });

  it('ends at a river change and survives a cycle', () => {
    const other = { ...re('y.1', null, null, ['x.2'], [], 5), river_id: 'y' };
    const r = base();
    r[1] = { ...(r[1] as ReturnType<typeof re>), downstream: ['y.1'] };
    expect(spansOf(tiny([...r, other], stations), new Set(['A', 'B'])).get('x.1')?.span).toBeNull();
    const cyc = [re('c.1', 'C', null, ['c.2'], ['c.2'], 1), re('c.2', null, null, ['c.1'], ['c.1'], 1)];
    const g = tiny(
      cyc.map((c) => ({ ...c, river_id: 'x' })),
      [st('C', 'c.1', 0)],
    );
    // The loop ends where it began: a closed span C to C, not a hang.
    expect(spansOf(g, new Set(['C'])).get('c.2')?.span).toMatchObject({ up: ['C'], down: ['C'], lengthKm: 2 });
  });

  it('maps a reach cut into parts to the part that holds its midpoint (D-2)', () => {
    // P = x.7 is cut at B: parts x.7-1 (A to B, 10 km) and x.7-2 (B to D, 30 km); its midpoint, 20 km, lies in part 2.
    const parts = [
      { ...re('x.7-1', 'A', 'B', [], ['x.7-2'], 10), part_of: 'x.7' },
      { ...re('x.7-2', 'B', 'D', ['x.7-1'], ['x.8'], 30), part_of: 'x.7' },
      re('x.8', 'D', null, ['x.7-2'], [], 5),
    ];
    const g = tiny(parts, [st('A', 'x.7-1', 0), st('B', 'x.7-2', 0), st('D', 'x.8', 0)]);
    const m = spansOf(g, new Set(['A', 'B', 'D']));
    expect(m.has('x.7-1')).toBe(false);
    expect(m.get('x.7')?.span).toMatchObject({ up: ['B'], down: ['D'], lengthKm: 30 });
    expect(m.get('x.7')?.span?.pos).toBeCloseTo(10 / 30, 10); // 20 - 10 into part 2
    expect(m.get('x.8')?.span).toBeNull();
  });
});

describe('the bins of a reach (#112)', () => {
  it("number binCount(length_km) on the fixture release, the span being the bins' common run", () => {
    for (const r of graph.reaches) {
      const fs = spans.get(r.id);
      expect(fs?.bins.length, r.id).toBe(binCount(r.length_km));
    }
    expect(spans.get('rhine.56')?.bins).toHaveLength(8);
  });

  it('puts bin i at (i + 0.5) / n of the reach, so pos increases along them', () => {
    const fs = spans.get('rhine.56');
    expect(fs?.bins.map((b) => b?.pos)).toEqual(Array.from({ length: 8 }, (_, i) => expect.closeTo((i + 0.5) / 8, 9)));
    // a 1-bin reach is its midpoint; every bin of a multi-bin reach lies on the reach's own span
    for (const [id, f] of spans) {
      if (f.span === null) continue;
      const ps = f.bins.map((b) => b?.pos ?? Number.NaN);
      if (ps.some(Number.isNaN)) continue;
      expect(ps, id).toEqual([...ps].sort((a, b) => a - b));
      for (const b of f.bins) expect(b?.up, id).toEqual(f.span.up);
    }
  });

  it('maps the centres onto the span by the lengths before the reach (small graph)', () => {
    const g = tiny(
      [
        re('x.1', 'A', null, [], ['x.2'], 10),
        re('x.2', null, null, ['x.1'], ['x.3'], 30),
        re('x.3', 'B', null, ['x.2'], [], 10),
      ],
      [st('A', 'x.1', 0), st('B', 'x.3', 0)],
    );
    const bins = spansOf(g, new Set(['A', 'B'])).get('x.2')?.bins ?? [];
    expect(bins).toHaveLength(8); // 30 km / 500 m = 60, clamped to 8
    bins.forEach((b, i) => {
      expect(b?.pos).toBeCloseTo((10 + (i + 0.5) * 3.75) / 40, 10);
    });
  });

  it('gives a reach of unknown length one bin with pos null', () => {
    const g = tiny(
      [re('x.1', 'A', null, [], ['x.2'], null), re('x.2', 'B', null, ['x.1'], [], 5)],
      [st('A', 'x.1', 0), st('B', 'x.2', 0)],
    );
    const fs = spansOf(g, new Set(['A', 'B'])).get('x.1');
    expect(fs?.bins).toHaveLength(1);
    expect(fs?.bins[0]?.pos).toBeNull();
  });

  it('puts a short reach in one bin at its midpoint', () => {
    const g = tiny(
      [
        re('x.1', 'A', null, [], ['x.2'], 0.4),
        re('x.2', null, null, ['x.1'], ['x.3'], 0.4),
        re('x.3', 'B', null, ['x.2'], [], 0.4),
      ],
      [st('A', 'x.1', 0), st('B', 'x.3', 0)],
    );
    const fs = spansOf(g, new Set(['A', 'B'])).get('x.2');
    expect(fs?.bins).toHaveLength(1);
    expect(fs?.bins[0]).toEqual(fs?.span);
  });

  it("on a cut reach takes each bin's span from the part that holds its centre", () => {
    // x.7 = x.7-1 (A to B, 10 km) + x.7-2 (B to D, 30 km): 40 km, 8 bins of 5 km; centres 2.5, 7.5 | 12.5 ... 37.5
    const parts = [
      { ...re('x.7-1', 'A', 'B', [], ['x.7-2'], 10), part_of: 'x.7' },
      { ...re('x.7-2', 'B', 'D', ['x.7-1'], ['x.8'], 30), part_of: 'x.7' },
      re('x.8', 'D', null, ['x.7-2'], [], 5),
    ];
    const g = tiny(parts, [st('A', 'x.7-1', 0), st('B', 'x.7-2', 0), st('D', 'x.8', 0)]);
    const bins = spansOf(g, new Set(['A', 'B', 'D'])).get('x.7')?.bins ?? [];
    expect(bins).toHaveLength(8);
    expect(bins.map((b) => b?.up)).toEqual([['A'], ['A'], ['B'], ['B'], ['B'], ['B'], ['B'], ['B']]);
    expect(bins[0]?.pos).toBeCloseTo(2.5 / 10, 10);
    expect(bins[2]?.pos).toBeCloseTo(2.5 / 30, 10);
    expect(bins[7]?.pos).toBeCloseTo(27.5 / 30, 10);
  });
});
