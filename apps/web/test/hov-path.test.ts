import { readFileSync } from 'node:fs';
import type { ApiStation } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { buildPath, type Column } from '../src/features/flow/hovmoller/path.ts';
import { type ReachGraph, ReachGraphFile } from '../src/lib/data/contracts.ts';
import { HOV_PATHS, type HovPathId } from '../src/lib/url/url.ts';

// The columns of the Hovmöller panel (P11c, issue #26) on the committed river release (test/fixtures/reaches-fixture.json)
// and a synthetic stations.json built from its stations: the km axis runs upstream to downstream as in the registry.

const graph = ReachGraphFile.parse(
  JSON.parse(readFileSync(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url), 'utf8')),
);
const reachRiver = new Map(graph.reaches.map((r) => [r.id, r.river_id]));
const kmOf = new Map(graph.stations.map((s) => [s.id, s.km_to_nl_entry]));

function station(id: string, over: { tier?: 1 | 2; source?: 'NL-1' | 'BE-3'; tidal?: boolean } = {}): ApiStation {
  return {
    id,
    name: `name of ${id}`,
    waterName: null,
    country: 'NL',
    lon: null,
    lat: null,
    tier: over.tier ?? 1,
    flags: { tidal: over.tidal ?? null, impounded: null },
    series: [
      {
        id: 1,
        source: over.source ?? 'NL-1',
        quantity: 'H',
        valueKind: 'stage',
        unit: 'cm',
        datum: null,
        nativeUnit: 'cm',
        expectedStepSeconds: 600,
        stalenessLimitSeconds: 3600,
        dataSince: null,
      },
    ],
  };
}

/** Every station of the release as a stations.json row; `tiers` overrides the default tier 1. */
const all = (tiers: Record<string, 1 | 2> = {}) =>
  graph.stations.map((s) => station(s.id, tiers[s.id] === undefined ? {} : { tier: tiers[s.id] as 1 | 2 }));
const only = (...ids: string[]) => ids.map((i) => station(i));
const none = new Set<string>();
const ids = (cols: readonly Column[]) => cols.map((c) => c.id);
const build = (p: HovPathId, st: readonly ApiStation[] = all(), owners: ReadonlySet<string> = none) =>
  buildPath(p, graph, st, owners);

const RIVERS: Record<HovPathId, readonly string[]> = {
  'rhine-waal': ['rhine', 'waal'],
  'rhine-lek': ['rhine', 'pannerdensch-kanaal', 'nederrijn', 'lek'],
  'rhine-ijssel': ['rhine', 'pannerdensch-kanaal', 'nederrijn', 'ijssel'],
  meuse: ['meuse'],
};
const BASEL = 'ch.bafu.2289';
const CHOOZ = 'fr.sandre.B720000001';
/** Of a weir pair or of one chainage, the stations the default tiers drop (.boven and the smaller id win). */
const MERGED: Record<HovPathId, readonly string[]> = {
  'rhine-waal': [],
  'rhine-lek': ['nl.rws.amerongen.beneden', 'nl.rws.driel.beneden', 'nl.rws.hagestein.beneden'],
  'rhine-ijssel': ['nl.rws.westervoort.2'],
  meuse: ['fr.sandre.B720000004', 'nl.rws.grave.beneden', 'nl.rws.lith.beneden', 'nl.rws.sambeek.beneden'],
};
/** The Nederrijn gauges below the IJssel split: on the Lek path, not on the IJssel path. */
const BELOW_SPLIT = [
  'nl.rws.amerongen.boven',
  'nl.rws.amerongen.beneden',
  'nl.rws.driel.boven',
  'nl.rws.driel.beneden',
  'nl.rws.rhenen.grebbeberg',
];

describe('buildPath on the fixture release', { timeout: 30_000 }, () => {
  it('knows the four paths', () => {
    expect([...HOV_PATHS]).toEqual(Object.keys(RIVERS));
  });

  for (const p of HOV_PATHS) {
    it(`${p}: x strictly increasing, and the order is the registry's km, upstream first`, () => {
      const { columns } = build(p);
      const xs = columns.map((c) => c.x);
      expect(xs.length).toBeGreaterThan(20);
      for (let i = 1; i < xs.length; i++)
        expect(xs[i] as number, `${columns[i]?.id}`).toBeGreaterThan(xs[i - 1] as number);
      // Independently: the stations on reaches of the path's rivers, within the bounds, by km descending.
      const first = kmOf.get(p === 'meuse' ? CHOOZ : BASEL) as number;
      const last = p === 'meuse' ? (kmOf.get('nl.rws.lith.beneden') as number) : -Infinity;
      const expected = graph.stations
        .filter((s) => {
          const km = s.km_to_nl_entry;
          const river = s.reach_id === null ? undefined : reachRiver.get(s.reach_id);
          return (
            river !== undefined && RIVERS[p].includes(river) && typeof km === 'number' && km <= first && km >= last
          );
        })
        .filter((s) => p !== 'rhine-ijssel' || !BELOW_SPLIT.includes(s.id))
        .sort((a, b) => (b.km_to_nl_entry as number) - (a.km_to_nl_entry as number))
        .map((s) => s.id)
        .filter((i) => !MERGED[p].includes(i));
      expect(ids(columns)).toEqual(expected);
      for (const c of columns) expect(c.x).toBe(0 - (kmOf.get(c.id) as number));
      expect(columns[0]?.id).toBe(p === 'meuse' ? CHOOZ : BASEL);
    });
  }

  it('walks one branch: the Waal has no Pannerdensch Kanaal, Nederrijn, Lek or IJssel column, and vice versa', () => {
    const rivers = (p: HovPathId) => new Set(build(p).columns.map((c) => c.riverId));
    expect(rivers('rhine-waal')).toEqual(new Set(['rhine', 'waal']));
    expect(rivers('rhine-lek')).toEqual(new Set(['rhine', 'pannerdensch-kanaal', 'nederrijn', 'lek']));
    expect(rivers('rhine-ijssel')).toEqual(new Set(['rhine', 'pannerdensch-kanaal', 'ijssel']));
    expect(rivers('meuse')).toEqual(new Set(['meuse']));
    expect(ids(build('rhine-lek').columns)).toContain('nl.rws.driel.boven');
    expect(ids(build('rhine-lek').columns)).toContain('nl.rws.krimpenaandelek.lek');
    expect(ids(build('rhine-ijssel').columns)).toContain('nl.rws.kampen.ijssel');
    expect(ids(build('rhine-waal').columns)).toContain('nl.rws.zaltbommel');
    for (const i of BELOW_SPLIT) expect(ids(build('rhine-ijssel').columns)).not.toContain(i);
    for (const i of ['nl.rws.zaltbommel', 'nl.rws.nijmegen.waal']) {
      expect(ids(build('rhine-lek').columns)).not.toContain(i);
      expect(ids(build('rhine-ijssel').columns)).not.toContain(i);
    }
  });

  it('puts the Millingen gauges (river rhine on waal reaches) on the Waal path only', () => {
    const millingen = ['nl.rws.millingenaanderijn', 'nl.rws.millingenaanderijn.pannerdensekop'];
    for (const i of millingen) {
      const g = graph.stations.find((s) => s.id === i) as ReachGraph['stations'][number];
      expect(g.river_id).toBe('rhine');
      expect(reachRiver.get(g.reach_id as string)).toBe('waal');
      expect(ids(build('rhine-waal').columns)).toContain(i);
      expect(build('rhine-waal').columns.find((c) => c.id === i)?.riverId).toBe('waal');
      for (const p of ['rhine-lek', 'rhine-ijssel', 'meuse'] as const) expect(ids(build(p).columns)).not.toContain(i);
    }
  });

  it('keeps the stations above Basel, and the tributaries within the km bounds, out of the Rhine paths', () => {
    // lu.age.remich sits on the Moselle at km 503.74 to the entry: only its reach keeps it out.
    expect(kmOf.get('lu.age.remich')).toBeLessThan(kmOf.get(BASEL) as number);
    expect(kmOf.get('lu.age.remich')).toBeGreaterThan(0);
    for (const p of ['rhine-waal', 'rhine-lek', 'rhine-ijssel'] as const)
      expect(ids(build(p).columns)).not.toContain('lu.age.remich');
    const upstream = graph.stations.filter((s) => (s.km_to_nl_entry ?? 0) > (kmOf.get(BASEL) as number));
    expect(upstream.length).toBeGreaterThan(0);
    for (const p of ['rhine-waal', 'rhine-lek', 'rhine-ijssel'] as const)
      for (const s of upstream) expect(ids(build(p).columns)).not.toContain(s.id);
    // Above Chooz (the French Meuse) and the Meuse station without a km.
    const aboveChooz = graph.stations.filter(
      (s) => (s.km_to_nl_entry ?? 0) > (kmOf.get(CHOOZ) as number) && reachRiver.get(s.reach_id ?? '') === 'meuse',
    );
    expect(aboveChooz.length).toBeGreaterThan(0);
    for (const s of aboveChooz) expect(ids(build('meuse').columns)).not.toContain(s.id);
    expect(kmOf.get('fr.sandre.B022001001')).toBeNull();
    expect(ids(build('meuse').columns)).not.toContain('fr.sandre.B022001001');
  });

  it('puts Lixhe after Eijsden, the Grensmaas points in, and Maaseik and Herenlaak in two columns', () => {
    const m = ids(build('meuse').columns);
    expect(m.indexOf('nl.rws.lixhebiefaval')).toBe(m.indexOf('nl.rws.eijsden.grens') + 1);
    expect(kmOf.get('nl.rws.eijsden.grens')).toBeGreaterThan(kmOf.get('nl.rws.lixhebiefaval') as number);
    for (const i of ['nl.rws.lanaken', 'nl.rws.herenlaak', 'nl.rws.maaseik']) expect(m).toContain(i);
    expect(m.indexOf('nl.rws.maaseik')).toBe(m.indexOf('nl.rws.herenlaak') - 1);
    expect(m.at(-1)).toBe('nl.rws.lith.boven');
  });

  it('never makes a column of the canal point, the unsnapped gauge, the canary or an SPW gauge', () => {
    const extra = ['nl.rws.smeermaas.zuidwillemsvaart', 'nl.rws.kanne', 'nl.canary.owner', 'be.spw.5447'];
    for (const i of extra) expect(kmOf.has(i)).toBe(false);
    for (const p of HOV_PATHS) {
      const cols = ids(build(p, [...all(), ...extra.map((i) => station(i))]).columns);
      for (const i of extra) expect(cols).not.toContain(i);
    }
  });

  it('has a column only for a station that stations.json holds', () => {
    const base = ids(build('meuse').columns);
    expect(base).toContain('nl.rws.venlo');
    const without = ids(
      build(
        'meuse',
        all().filter((s) => s.id !== 'nl.rws.venlo'),
      ).columns,
    );
    expect(without).toEqual(base.filter((i) => i !== 'nl.rws.venlo'));
  });

  it('gives an empty path for a start station the graph does not hold', () => {
    const noBasel: ReachGraph = { ...graph, stations: graph.stations.filter((s) => s.id !== BASEL) };
    expect(buildPath('rhine-waal', noBasel, all(), none)).toEqual({ columns: [], gaps: [] });
    const noKm: ReachGraph = {
      ...graph,
      stations: graph.stations.map((s) => (s.id === CHOOZ ? { ...s, km_to_nl_entry: null } : s)),
    };
    expect(buildPath('meuse', noKm, all(), none)).toEqual({ columns: [], gaps: [] });
  });

  it('fills the column from the station and the graph: name, tier, river, owner, tidal', () => {
    const st = all({ 'nl.rws.venlo': 2 });
    const venlo = build('meuse', st).columns.find((c) => c.id === 'nl.rws.venlo');
    expect(venlo).toEqual({
      id: 'nl.rws.venlo',
      name: 'name of nl.rws.venlo',
      riverId: 'meuse',
      x: 0 - (kmOf.get('nl.rws.venlo') as number),
      tier: 2,
      tidal: false,
      owner: false,
    });
    // The owner flag is any series of an owner-audience source.
    const owned = build(
      'meuse',
      [...all().filter((s) => s.id !== 'nl.rws.venlo'), station('nl.rws.venlo', { source: 'BE-3' })],
      new Set(['BE-3']),
    );
    expect(owned.columns.find((c) => c.id === 'nl.rws.venlo')?.owner).toBe(true);
    expect(owned.columns.filter((c) => c.owner)).toHaveLength(1);
  });

  it('marks a column tidal from the reach flag or the station flag', () => {
    const lek = build('rhine-lek').columns;
    expect(lek.filter((c) => c.tidal).map((c) => c.id)).toEqual(['nl.rws.schoonhoven', 'nl.rws.krimpenaandelek.lek']);
    const flagged = [...all().filter((s) => s.id !== 'nl.rws.venlo'), station('nl.rws.venlo', { tidal: true })];
    expect(
      build('meuse', flagged)
        .columns.filter((c) => c.tidal)
        .map((c) => c.id),
    ).toContain('nl.rws.venlo');
    expect(build('meuse').columns.some((c) => c.tidal)).toBe(false);
  });
});

describe('weir pairs and one-chainage duplicates', { timeout: 30_000 }, () => {
  it('merges a .boven/.beneden pair into one column: the lower tier, a tie the .boven', () => {
    const lith = (tiers: Record<string, 1 | 2>) =>
      ids(build('meuse', all(tiers)).columns).filter((i) => i.startsWith('nl.rws.lith.'));
    expect(lith({})).toEqual(['nl.rws.lith.boven']);
    expect(lith({ 'nl.rws.lith.boven': 2, 'nl.rws.lith.beneden': 1 })).toEqual(['nl.rws.lith.beneden']);
    expect(lith({ 'nl.rws.lith.boven': 1, 'nl.rws.lith.beneden': 2 })).toEqual(['nl.rws.lith.boven']);
    const beneden = build('meuse', all({ 'nl.rws.lith.boven': 2 })).columns.at(-1);
    expect(beneden?.x).toBe(0 - (kmOf.get('nl.rws.lith.beneden') as number));
    // Sambeek, Grave and Driel merge the same way, each into one column.
    const pair = (p: HovPathId, base: string, tiers: Record<string, 1 | 2>) =>
      ids(build(p, all(tiers)).columns).filter((i) => i.startsWith(`${base}.`));
    expect(pair('meuse', 'nl.rws.grave', {})).toEqual(['nl.rws.grave.boven']);
    expect(pair('rhine-lek', 'nl.rws.driel', { 'nl.rws.driel.boven': 2 })).toEqual(['nl.rws.driel.beneden']);
  });

  it('does not merge a pair when only one side is a member', () => {
    const one = all().filter((s) => s.id !== 'nl.rws.lith.boven');
    expect(ids(build('meuse', one).columns)).toContain('nl.rws.lith.beneden');
  });

  it('merges stations at exactly one km: the smaller id on a tie, the lower tier before that', () => {
    const wv = (tiers: Record<string, 1 | 2>) =>
      ids(build('rhine-ijssel', all(tiers)).columns).filter(
        (i) => i.startsWith('nl.rws.westervoort.') && i !== 'nl.rws.westervoort.ijsselkop',
      );
    expect(kmOf.get('nl.rws.westervoort.1')).toBe(kmOf.get('nl.rws.westervoort.2'));
    expect(wv({})).toEqual(['nl.rws.westervoort.1']);
    expect(wv({ 'nl.rws.westervoort.1': 2 })).toEqual(['nl.rws.westervoort.2']);
    expect(kmOf.get(CHOOZ)).toBe(kmOf.get('fr.sandre.B720000004'));
    const fr = (tiers: Record<string, 1 | 2>) =>
      ids(build('meuse', all(tiers)).columns).filter(
        (i) => i.startsWith('fr.sandre.B72000000') && i !== 'fr.sandre.B720000002',
      );
    expect(fr({})).toEqual([CHOOZ]);
    expect(fr({ [CHOOZ]: 2 })).toEqual(['fr.sandre.B720000004']);
  });

  it('prefers the public station at one km, even at a worse tier', () => {
    const rows = [
      ...all().filter((s) => s.id !== 'nl.rws.westervoort.1' && s.id !== 'nl.rws.westervoort.2'),
      station('nl.rws.westervoort.1', { source: 'BE-3', tier: 1 }),
      station('nl.rws.westervoort.2', { tier: 2 }),
    ];
    const cols = build('rhine-ijssel', rows, new Set(['BE-3'])).columns;
    const wv = cols.filter((c) => c.id.startsWith('nl.rws.westervoort.') && c.id !== 'nl.rws.westervoort.ijsselkop');
    expect(wv.map((c) => c.id)).toEqual(['nl.rws.westervoort.2']);
    expect(wv[0]?.owner).toBe(false);
  });

  it('does not merge by proximity: Maaseik and Herenlaak stay two columns', () => {
    const cols = build('meuse').columns;
    const a = cols.find((c) => c.id === 'nl.rws.maaseik') as Column;
    const b = cols.find((c) => c.id === 'nl.rws.herenlaak') as Column;
    expect(b.x - a.x).toBeGreaterThan(0.5);
    expect(b.x - a.x).toBeLessThan(1.5);
  });
});

describe('gaps', { timeout: 30_000 }, () => {
  it('finds exactly one on the public Meuse: Wallonia, between the last French column and Eijsden', () => {
    const { columns, gaps } = build('meuse');
    expect(gaps).toHaveLength(1);
    const [gap] = gaps as [(typeof gaps)[number]];
    expect(gap.kind).toBe('wallonia');
    expect(columns.find((c) => c.x === gap.fromX)?.id).toBe('fr.sandre.B720000002');
    expect(columns.find((c) => c.x === gap.toX)?.id).toBe('nl.rws.eijsden.grens');
    expect(gap.km).toBeCloseTo(gap.toX - gap.fromX, 9);
    expect(gap.km).toBeCloseTo(139.23, 2);
    // Consecutive: nothing between the two.
    expect(columns.findIndex((c) => c.x === gap.toX)).toBe(columns.findIndex((c) => c.x === gap.fromX) + 1);
  });

  it('has none on the Rhine paths, whose longest stretch is under the ceiling', () => {
    for (const p of ['rhine-waal', 'rhine-lek', 'rhine-ijssel'] as const) expect(build(p).gaps).toEqual([]);
  });

  it('is plain off the Meuse, and on the Meuse when it ends below the NL entry', () => {
    const rhine = build('rhine-waal', only(BASEL, 'nl.rws.zaltbommel')).gaps;
    expect(rhine).toHaveLength(1);
    expect(rhine[0]?.kind).toBe('plain');
    expect(rhine[0]?.km).toBeCloseTo(700.64 + 71.57, 2);
    const meuse = build('meuse', only(CHOOZ, 'nl.rws.maaseik')).gaps;
    expect(meuse.map((g) => g.kind)).toEqual(['plain']);
    expect(build('meuse', only(CHOOZ, 'nl.rws.lixhebiefaval')).gaps.map((g) => g.kind)).toEqual(['wallonia']);
  });

  it('opens a gap only above the ceiling', () => {
    // Venlo to Megen is 81 km, Lixhe to Venlo 102 km, Lixhe to Megen 184 km (GAP_KM is 120).
    expect(build('meuse', only('nl.rws.venlo', 'nl.rws.megen.maas')).gaps).toEqual([]);
    expect(build('meuse', only('nl.rws.lixhebiefaval', 'nl.rws.megen.maas')).gaps).toHaveLength(1);
    expect(build('meuse', only('nl.rws.lixhebiefaval', 'nl.rws.venlo')).gaps).toEqual([]);
  });
});
