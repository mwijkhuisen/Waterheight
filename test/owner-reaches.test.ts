import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REACHES_VARIANT } from '../apps/server/src/db/audience.ts';
import { readRegistry, readRiverRegistry } from '../apps/server/src/load/registry-sync.ts';
import { CO_LOCATED_KM, splitReaches } from '../apps/server/src/publish/render/reaches-owner.ts';
import { type ChainNode, chain } from '../apps/web/src/features/flow/chain.ts';
import { ReachGraphFile } from '../apps/web/src/lib/data/contracts.ts';
import { CANARY_RENDERINGS } from '../packages/contracts/src/canaries.ts';
import { checkReaches, ReachesFile } from '../packages/contracts/src/reaches.ts';
import { checkOwnerReaches, OwnerReachesFile } from '../packages/contracts/src/reaches-owner.ts';
import type { RivernetFile } from '../packages/contracts/src/rivernet.ts';
import { repoRoot } from './catalogue.ts';

// P11a (D-C, criterion C5): the owner variant of the river release, pure. splitReaches on the committed fixture release
// (test/fixtures/reaches-fixture.json, production placement of tools/geo/fixtures) with the owner stations of the
// registry (identification only: ids, never a value) and registry/rivernet.yaml, which is generated from the same
// fixture: the calibration is the identity here, and a synthetic release exercises the drift.

const release = ReachesFile.parse(JSON.parse(readFileSync(`${repoRoot}test/fixtures/reaches-fixture.json`, 'utf8')));
const { stations: rows } = readRegistry();
const rivernet = readRiverRegistry().rivernet as RivernetFile;
/** What the owner stations.json holds: the public and the owner primaries (the own_* views keep only role primary). */
const shown = rows.filter((r) => r.role === 'primary' && (r.audience === 'public' || r.audience === 'owner'));
const ownerSet = new Set(shown.map((r) => r.id));
const be3 = new Set(rows.filter((r) => r.source === 'BE-3' && r.role === 'primary').map((r) => r.id));
const placedOf = new Map(rivernet.stations.map((s) => [s.id, s]));

const split = splitReaches(release, ownerSet, rivernet);
const stationOf = (id: string) => split.file.stations.find((s) => s.id === id);
const reachOf = (id: string) => split.file.reaches.find((r) => r.id === id);

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('splitReaches on the fixture release', () => {
  it('leaves the public release untouched (never mutates it; it still parses as the public file)', () => {
    const before = JSON.stringify(release);
    const frozen = deepFreeze(structuredClone(release));
    const again = splitReaches(frozen, ownerSet, rivernet);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(JSON.stringify(again.file)).toBe(JSON.stringify(split.file));
    expect(ReachesFile.safeParse(JSON.parse(before)).success).toBe(true);
    expect(checkReaches(release)).toEqual([]);
  });

  it('is a valid owner file, which the strict public schema refuses (parts exist only in the owner variant)', () => {
    expect(OwnerReachesFile.safeParse(split.file).success).toBe(true);
    expect(checkOwnerReaches(split.file)).toEqual([]);
    expect(ReachesFile.safeParse(split.file).success).toBe(false);
  });

  it('places the BE-3 gauges: 87 points (72, plus 15 on the Vesdre and the Amblève, #110 PR 2), one skipped as ambiguous (the Lys, whose headwaters restart at km 0)', () => {
    const be3Split = splitReaches(release, be3, rivernet);
    const added = be3Split.file.stations.length - release.stations.length;
    expect(added).toBe(87);
    expect(be3Split.skipped).toEqual([{ id: 'be.spw.3884', code: 'owner_reach_ambiguous' }]);
    // Only the owner stations the file did not have are added; the public ones are all still there.
    const have = new Set(be3Split.file.stations.map((s) => s.id));
    for (const s of release.stations) expect(have.has(s.id), s.id).toBe(true);
    // The owner view's whole set adds the same points: public stations are in the release already.
    expect(split.file.stations.length).toBe(be3Split.file.stations.length);
  });

  it('puts the SPW Meuse gauges in km order on the Meuse parts, the twin out and Chooz co-located (no split)', () => {
    const spw = [...be3]
      .filter((id) => placedOf.get(id)?.river === 'meuse' && stationOf(id) !== undefined)
      .sort((a, b) => (placedOf.get(a)?.km_graph as number) - (placedOf.get(b)?.km_graph as number));
    expect(spw.length).toBeGreaterThan(5);
    expect(spw).toContain('be.spw.5447');
    // The twin of Lixhe is no owner station (a twin has no primary series); the third SPW gauge, Chooz, is co-located.
    expect(stationOf('be.spw.5436')).toBeUndefined();
    let last: [number, number] = [0, 0];
    for (const id of spw) {
      const s = stationOf(id);
      if (s === undefined || s.reach_id === null) throw new Error(id);
      expect(s.river_id).toBe('meuse');
      if (id === 'be.spw.8702') continue;
      const part = reachOf(s.reach_id);
      expect(part?.part_of, id).toMatch(/^meuse\.[1-9][0-9]*$/);
      // The part starts at the station: it is the reach "starting at its position", and the part before it ends there.
      expect(part?.km_graph_from, id).toBe(s.km_graph);
      expect(part?.up_station_id, id).not.toBeNull();
      const key: [number, number] = [part?.seq as number, Number(/-(\d+)$/.exec(s.reach_id)?.[1])];
      expect(key[0] > last[0] || (key[0] === last[0] && key[1] >= last[1]), `${id} after ${last}`).toBe(true);
      last = key;
    }
    const chooz = stationOf('fr.sandre.B720000002');
    const co = stationOf('be.spw.8702');
    expect(co).toMatchObject({ reach_id: chooz?.reach_id, km_graph: chooz?.km_graph, river_id: 'meuse' });
    expect(reachOf(chooz?.reach_id as string)?.part_of).toBeUndefined();
    expect(Math.abs((placedOf.get('be.spw.8702')?.km_graph as number) - (chooz?.km_graph as number))).toBeLessThan(
      CO_LOCATED_KM,
    );
  });

  it('conserves length and the chain: a reach and its parts, every reference resolving', () => {
    const byWhole = new Map<string, typeof split.file.reaches>();
    for (const r of split.file.reaches)
      if (r.part_of !== undefined) byWhole.set(r.part_of, [...(byWhole.get(r.part_of) ?? []), r]);
    expect(byWhole.size).toBeGreaterThan(15);
    for (const [whole, parts] of byWhole) {
      const orig = release.reaches.find((r) => r.id === whole);
      expect(orig, whole).toBeDefined();
      expect(parts.reduce((a, p) => a + p.length_km, 0)).toBeCloseTo(orig?.length_km as number, 2);
      expect(Math.abs(parts.reduce((a, p) => a + p.length_km, 0) - (orig?.length_km as number))).toBeLessThanOrEqual(
        0.002,
      );
      expect(parts[0]?.km_graph_from).toBe(orig?.km_graph_from);
      expect(parts.at(-1)?.km_graph_to).toBe(orig?.km_graph_to);
      expect(parts[0]?.up_station_id).toBe(orig?.up_station_id);
      expect(parts.at(-1)?.down_station_id).toBe(orig?.down_station_id);
      expect(parts[0]?.upstream.length).toBe(orig?.upstream.length);
      expect(parts.every((p) => p.travel_time_h === null && p.travel_time_source === null)).toBe(true);
      expect(parts.slice(1).every((p) => !p.flags.bifurcation)).toBe(true);
      expect(
        parts.every((p) => p.flags.tidal === orig?.flags.tidal && p.flags.impounded === orig?.flags.impounded),
      ).toBe(true);
    }
    // Reaches that were not split are the public ones, their neighbours only renamed to the first or last part.
    const keep = release.reaches.filter((r) => !byWhole.has(r.id));
    for (const r of keep) {
      const out = reachOf(r.id);
      expect(out).toMatchObject({ ...r, upstream: expect.any(Array), downstream: expect.any(Array) });
      expect(out?.upstream.length).toBe(r.upstream.length);
    }
  });

  it('keeps the travel times, the rivers and the entry nodes of the release, and the public stations (reach renamed only)', () => {
    expect(split.file.travel_times).toEqual(release.travel_times);
    expect(split.file.rivers).toEqual(release.rivers);
    expect(split.file.nl_entry_nodes).toEqual(release.nl_entry_nodes);
    for (const s of release.stations) {
      const out = stationOf(s.id);
      expect({ ...out, reach_id: s.reach_id }).toEqual(s);
      // On a split reach the station keeps the end it sits on.
      if (out?.reach_id !== s.reach_id) expect(reachOf(out?.reach_id as string)?.part_of).toBe(s.reach_id);
    }
  });

  it('holds no canary and no value: the ids and kilometres of stations only', () => {
    const text = JSON.stringify(split.file);
    for (const c of CANARY_RENDERINGS) expect(text.includes(c), c).toBe(false);
    expect(text).not.toMatch(/CANARY/i);
    // The canary has no station row, hence no placement (it cannot be split in).
    expect(rows.some((r) => r.source === 'CANARY-OWNER')).toBe(false);
  });

  it('is deterministic, and with no owner station it is the release itself', () => {
    expect(JSON.stringify(splitReaches(release, ownerSet, rivernet))).toBe(JSON.stringify(split));
    const none = splitReaches(release, new Set(), rivernet);
    expect(none.skipped).toEqual([]);
    expect(none.file.reaches).toEqual(release.reaches);
    expect(none.file.stations).toEqual(release.stations);
  });
});

describe('the Eijsden chain of the owner variant (F1, F2)', () => {
  const graph = ReachGraphFile.parse(split.file);
  const known = new Set(split.file.stations.map((s) => s.id));
  const nodes = chain(graph, release.rivers, 'nl.rws.eijsden.grens', known);
  const ids = (ns: readonly ChainNode[]): string[] =>
    ns.flatMap((n) => (n.kind === 'station' ? [...n.ids] : n.kind === 'group' ? ids(n.children) : []));
  const groups = (ns: readonly ChainNode[]): ChainNode[] =>
    ns.flatMap((n) => (n.kind === 'group' ? [n, ...groups(n.children)] : []));

  it('lists be.spw.5447, be.spw.5451, … be.spw.8702 on the Meuse stem in graph order (km descending)', () => {
    const stem = nodes.flatMap((n) => (n.kind === 'station' ? [...n.ids] : []));
    const spw = stem.filter((id) => id.startsWith('be.spw.'));
    const meuse = [...be3]
      .filter((id) => placedOf.get(id)?.river === 'meuse' && stationOf(id) !== undefined)
      .sort((a, b) => (placedOf.get(b)?.km_graph as number) - (placedOf.get(a)?.km_graph as number));
    expect(spw).toEqual(meuse);
    expect(spw[0]).toBe('be.spw.5447');
    expect(spw[1]).toBe('be.spw.5451');
    expect(spw.at(-1)).toBe('be.spw.8702');
    // Chooz (the public gauge SPW 8702 stands at) is the same row.
    expect(stem).toContain('fr.sandre.B720000002');
  });

  it('has the Sambre, the Vesdre and the Amblève as groups with SPW rows (KG-163 closed)', () => {
    const rivers = groups(nodes).map((g) => (g.kind === 'group' ? g.riverId : ''));
    expect(rivers).toContain('sambre');
    expect(rivers).toContain('vesdre');
    expect(rivers).toContain('ambleve');
    const inGroup = (river: string) =>
      groups(nodes).flatMap((g) => (g.kind === 'group' && g.riverId === river ? ids(g.children) : []));
    const spwIn = (river: string) => inGroup(river).filter((id) => id.startsWith('be.spw.'));
    expect(spwIn('sambre').length).toBeGreaterThan(3);
    const placed = (river: string) =>
      split.file.stations.filter((s) => s.id.startsWith('be.spw.') && s.river_id === river).map((s) => s.id);
    expect(placed('vesdre').length).toBe(7);
    expect(placed('ambleve').length).toBe(8);
    expect([...spwIn('vesdre')].sort()).toEqual([...placed('vesdre')].sort());
    expect([...spwIn('ambleve')].sort()).toEqual([...placed('ambleve')].sort());
    // Graph order within each group: km descending.
    for (const r of ['vesdre', 'ambleve']) {
      const kms = spwIn(r).map((id) => placedOf.get(id)?.km_graph as number);
      expect(kms).toEqual([...kms].sort((a, b) => b - a));
    }
    // The groups follow the graph order: the Ourthe group first, then the Vesdre, then the Amblève.
    const order = groups(nodes).map((g) => (g.kind === 'group' ? g.riverId : ''));
    expect(order.indexOf('ourthe')).toBeLessThan(order.indexOf('vesdre'));
    expect(order.indexOf('vesdre')).toBeLessThan(order.indexOf('ambleve'));
    // Chooz and SPW 8702 are one row.
    expect(
      nodes.some(
        (n) => n.kind === 'station' && n.ids.includes('fr.sandre.B720000002') && n.ids.includes('be.spw.8702'),
      ),
    ).toBe(true);
  });

  it('places the Ourthe gauges on parts of ourthe.1, ourthe.2 and ourthe.3, which joins the Meuse (#110): an Ourthe group in graph order after Liège', () => {
    const ourthe = split.file.stations.filter((s) => s.id.startsWith('be.spw.') && s.river_id === 'ourthe');
    expect(ourthe.length).toBe(15);
    const parents = new Set(['ourthe.1', 'ourthe.2', 'ourthe.3']);
    expect(ourthe.every((s) => parents.has(reachOf(s.reach_id as string)?.part_of as string))).toBe(true);
    // The Ourthe is cut at the Amblève and the Vesdre; its last reach joins the Meuse.
    expect(release.reaches.find((r) => r.id === 'ourthe.3')?.downstream).toEqual(['meuse.27']);
    const group = groups(nodes).find((g) => g.kind === 'group' && g.riverId === 'ourthe');
    expect(group).toBeDefined();
    // The Vesdre and the Amblève are groups nested in the Ourthe's: its own rows are its direct stations.
    const own = group?.kind === 'group' ? group.children.filter((c) => c.kind === 'station') : [];
    const sub = group?.kind === 'group' ? group.children.flatMap((c) => (c.kind === 'group' ? [c.riverId] : [])) : [];
    expect(sub).toEqual(expect.arrayContaining(['vesdre', 'ambleve']));
    const inGroup = ids(own).filter((id) => id.startsWith('be.spw.'));
    const placedOurthe = ourthe.map((s) => s.id);
    expect([...inGroup].sort()).toEqual([...placedOurthe].sort());
    const km = (id: string) => placedOf.get(id)?.km_graph as number;
    expect(inGroup.map(km)).toEqual([...inGroup.map(km)].sort((a, b) => b - a));
    expect(groups(nodes).some((g) => g.kind === 'group' && g.riverId === 'sambre')).toBe(true);
    for (const id of placedOurthe) expect(placedOf.get(id)?.nl_entry_node, id).toBe('eijsden');
  });

  it('is the public chain without any be.spw. row on the public release', () => {
    const pub = chain(
      ReachGraphFile.parse(release),
      release.rivers,
      'nl.rws.eijsden.grens',
      new Set(release.stations.map((s) => s.id)),
    );
    expect(ids(pub).some((id) => id.startsWith('be.spw.'))).toBe(false);
    expect(ids(pub)).toContain('fr.sandre.B720000002');
  });
});

describe('properties', () => {
  const candidates = [...ownerSet].filter(
    (id) => placedOf.get(id)?.km_graph != null && !release.stations.some((s) => s.id === id),
  );

  it('any subset of the owner stations gives a valid owner file that conserves every reach', () => {
    fc.assert(
      fc.property(fc.subarray(candidates, { minLength: 0 }), (subset) => {
        const r = splitReaches(release, new Set(subset), rivernet);
        expect(OwnerReachesFile.safeParse(r.file).success).toBe(true);
        expect(checkOwnerReaches(r.file)).toEqual([]);
        const placed = new Set(r.file.stations.map((s) => s.id));
        for (const s of r.skipped) {
          expect(placed.has(s.id)).toBe(false);
          expect(['owner_reach_ambiguous', 'owner_reach_unplaced']).toContain(s.code);
        }
        // Every owner station is in the file or skipped, never both and never lost.
        for (const id of subset) expect(placed.has(id) !== r.skipped.some((s) => s.id === id), id).toBe(true);
        const sum = new Map<string, number>();
        for (const x of r.file.reaches) {
          const whole = x.part_of ?? x.id;
          sum.set(whole, (sum.get(whole) ?? 0) + x.length_km);
        }
        for (const x of release.reaches)
          expect(Math.abs((sum.get(x.id) as number) - x.length_km), x.id).toBeLessThanOrEqual(0.002);
        // A split never lowers the number of stations or reaches.
        expect(r.file.stations.length).toBe(release.stations.length + subset.length - r.skipped.length);
        expect(r.file.reaches.length).toBeGreaterThanOrEqual(release.reaches.length);
        // Order of the input is irrelevant.
        expect(JSON.stringify(splitReaches(release, new Set([...subset].reverse()), rivernet))).toBe(JSON.stringify(r));
      }),
      { numRuns: 40 },
    );
  });
});

// A synthetic release for the rules the fixture does not show: drift, ε, ambiguity, one reach cut several times.
// river "aa": aa.1 (km 0-50) -> aa.2 (50-100, stations s1 at 50) -> aa.3 (100-150, s2 at 100); aa.4 and aa.5 are two
// branches of "bb" that both cover km 20-30.
describe('synthetic release', () => {
  const flags = { tidal: false, impounded: false, bifurcation: false };
  const reach = (
    id: string,
    river: string,
    seq: number,
    from: number,
    to: number,
    up: string | null,
    down: string | null,
    upstream: string[],
    downstream: string[],
  ) => ({
    id,
    river_id: river,
    seq,
    up_station_id: up,
    down_station_id: down,
    length_km: to - from,
    km_graph_from: from,
    km_graph_to: to,
    flags,
    travel_time_h: null,
    travel_time_source: null,
    upstream,
    downstream,
  });
  const st = (id: string, river: string, reach_id: string, km: number) => ({
    id,
    river_id: river,
    reach_id,
    km_official: null,
    km_official_system: null,
    km_graph: km,
    km_to_nl_entry: 200 - km,
    nl_entry_node: null,
  });
  const base = ReachesFile.parse({
    ...release,
    rivers: [
      { id: 'aa', name_nl: 'Aa', name_en: 'Aa', parent_river_id: null, km_direction: 'downstream' },
      { id: 'bb', name_nl: 'Bb', name_en: 'Bb', parent_river_id: null, km_direction: 'downstream' },
    ],
    nl_entry_nodes: [],
    travel_times: [],
    reaches: [
      reach('aa.1', 'aa', 1, 0, 50, null, 'de.wsv.1', [], ['aa.2']),
      reach('aa.2', 'aa', 2, 50, 100, 'de.wsv.1', 'de.wsv.2', ['aa.1'], ['aa.3']),
      reach('aa.3', 'aa', 3, 100, 150, 'de.wsv.2', null, ['aa.2'], []),
      reach('bb.1', 'bb', 1, 0, 40, null, null, [], []),
      reach('bb.2', 'bb', 2, 20, 30, null, null, [], []),
    ],
    stations: [st('de.wsv.1', 'aa', 'aa.2', 50), st('de.wsv.2', 'aa', 'aa.3', 100)],
  });
  const net = (...extra: [string, string, number][]): Pick<RivernetFile, 'stations'> => ({
    stations: [
      ...[['de.wsv.1', 'aa', 40], ['de.wsv.2', 'aa', 80], ...extra].map(([id, river, km]) => ({
        id: id as string,
        rule: 'name' as const,
        river: river as string,
        reach: null,
        km_official: null,
        km_official_system: null,
        km_graph: km as number,
        km_to_nl_entry: 50,
        nl_entry_node: null,
      })),
    ],
  });

  it('calibrates the fixture km to the release km piecewise-linearly between the public stations present in both', () => {
    // anchors (raw -> release): 40 -> 50, 80 -> 100. A point at raw 60 is halfway: 75. Beyond them the offset holds.
    const r = splitReaches(
      base,
      new Set(['be.spw.1', 'be.spw.2', 'be.spw.3']),
      net(['be.spw.1', 'aa', 60], ['be.spw.2', 'aa', 20], ['be.spw.3', 'aa', 90]),
    );
    const km = (id: string) => r.file.stations.find((s) => s.id === id)?.km_graph;
    expect(km('be.spw.1')).toBe(75);
    expect(km('be.spw.2')).toBe(30); // 20 + (50 - 40)
    expect(km('be.spw.3')).toBe(110); // 90 + (100 - 80)
    expect(r.skipped).toEqual([]);
    expect(r.file.stations.find((s) => s.id === 'be.spw.1')?.reach_id).toBe('aa.2-2');
    expect(checkOwnerReaches(r.file)).toEqual([]);
  });

  it('keeps the raw km on a river without an anchor', () => {
    const r = splitReaches(base, new Set(['be.spw.1']), net(['be.spw.1', 'bb', 35]));
    expect(r.skipped).toEqual([]);
    expect(r.file.stations.find((s) => s.id === 'be.spw.1')?.km_graph).toBe(35);
    expect(r.file.reaches.filter((x) => x.part_of === 'bb.1').map((x) => x.id)).toEqual(['bb.1-1', 'bb.1-2']);
  });

  it('cuts one reach at several owner stations, in order, with upstream and downstream rewired through the parts', () => {
    // raw 50/60/70 are 62.5, 75, 87.5 in the release; all on aa.2 (50-100).
    const r = splitReaches(
      base,
      new Set(['be.spw.c', 'be.spw.a', 'be.spw.b']),
      net(['be.spw.c', 'aa', 70], ['be.spw.a', 'aa', 50], ['be.spw.b', 'aa', 60]),
    );
    const parts = r.file.reaches.filter((x) => x.part_of === 'aa.2');
    expect(parts.map((p) => p.id)).toEqual(['aa.2-1', 'aa.2-2', 'aa.2-3', 'aa.2-4']);
    expect(parts.map((p) => [p.km_graph_from, p.km_graph_to])).toEqual([
      [50, 62.5],
      [62.5, 75],
      [75, 87.5],
      [87.5, 100],
    ]);
    expect(parts.map((p) => p.length_km)).toEqual([12.5, 12.5, 12.5, 12.5]);
    expect(parts.map((p) => [p.up_station_id, p.down_station_id])).toEqual([
      ['de.wsv.1', 'be.spw.a'],
      ['be.spw.a', 'be.spw.b'],
      ['be.spw.b', 'be.spw.c'],
      ['be.spw.c', 'de.wsv.2'],
    ]);
    expect(r.file.reaches.find((x) => x.id === 'aa.1')?.downstream).toEqual(['aa.2-1']);
    expect(r.file.reaches.find((x) => x.id === 'aa.3')?.upstream).toEqual(['aa.2-4']);
    expect(parts[0]?.upstream).toEqual(['aa.1']);
    expect(parts[3]?.downstream).toEqual(['aa.3']);
    expect(r.file.stations.find((s) => s.id === 'de.wsv.2')?.reach_id).toBe('aa.3');
    expect(r.file.stations.find((s) => s.id === 'de.wsv.1')?.reach_id).toBe('aa.2-1');
    expect(checkOwnerReaches(r.file)).toEqual([]);
    expect(OwnerReachesFile.safeParse(r.file).success).toBe(true);
  });

  it('co-locates a point within ε of a public station: added to its reach, no split; farther than ε splits', () => {
    fc.assert(
      fc.property(fc.integer({ min: -4, max: 4 }), (d) => {
        // raw 40 is the public station at release km 50; d is in hundredths of a km (the file's precision).
        const r = splitReaches(base, new Set(['be.spw.1']), net(['be.spw.1', 'aa', 40 + d / 100]));
        const s = r.file.stations.find((x) => x.id === 'be.spw.1');
        // The public station's exact reach and km (the chain's co-location is equality of both), no split.
        expect(s).toMatchObject({ reach_id: 'aa.2', km_graph: 50 });
        expect(r.file.reaches.some((x) => x.part_of !== undefined)).toBe(false);
      }),
    );
    const far = splitReaches(base, new Set(['be.spw.1']), net(['be.spw.1', 'aa', 40.06]));
    expect(far.file.reaches.filter((x) => x.part_of === 'aa.2').length).toBe(2);
    // Two owner stations within ε of each other share one position (one cut, one km).
    const pair = splitReaches(
      base,
      new Set(['be.spw.1', 'be.spw.2']),
      net(['be.spw.1', 'aa', 60], ['be.spw.2', 'aa', 60.02]),
    );
    expect(pair.file.reaches.filter((x) => x.part_of === 'aa.2').length).toBe(2);
    const km = pair.file.stations.filter((s) => s.id.startsWith('be.spw.')).map((s) => [s.reach_id, s.km_graph]);
    expect(km[0]).toEqual(km[1]);
  });

  it('skips a point that two reaches of its river could hold (owner_reach_ambiguous) and one that none holds (owner_reach_unplaced)', () => {
    const r = splitReaches(
      base,
      new Set(['be.spw.1', 'be.spw.2', 'be.spw.3']),
      net(['be.spw.1', 'bb', 25], ['be.spw.2', 'aa', 400], ['be.spw.3', 'bb', 39]),
    );
    expect(r.skipped).toEqual([
      { id: 'be.spw.1', code: 'owner_reach_ambiguous' },
      { id: 'be.spw.2', code: 'owner_reach_unplaced' },
    ]);
    expect(r.file.stations.some((s) => s.id === 'be.spw.1' || s.id === 'be.spw.2')).toBe(false);
    expect(r.file.stations.find((s) => s.id === 'be.spw.3')?.reach_id).toBe('bb.1-2');
    expect(checkOwnerReaches(r.file)).toEqual([]);
  });

  it('takes no point that is not an owner station, not placed, or already a public station', () => {
    const extra: [string, string, number][] = [
      ['be.spw.1', 'aa', 60],
      ['be.spw.2', 'aa', 61],
    ];
    const n = net(...extra);
    n.stations.push({ ...n.stations[0], id: 'be.spw.4', river: null, km_graph: null, rule: 'canal' } as never);
    const r = splitReaches(base, new Set(['be.spw.1', 'be.spw.4', 'de.wsv.1', 'fr.sandre.unknown']), n);
    expect(r.file.stations.map((s) => s.id).sort()).toEqual(['be.spw.1', 'de.wsv.1', 'de.wsv.2']);
    expect(r.skipped).toEqual([]);
  });
});

describe('the audience switch', () => {
  it('builds the reaches variant for the owner family only', () => {
    expect(REACHES_VARIANT).toEqual({ public: false, owner: true });
  });
});
