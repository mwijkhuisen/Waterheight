import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { formatTravelEmpirical } from '../apps/server/src/travel/format.ts';
import { ReachesFile } from '../packages/contracts/src/reaches.ts';
import { type TravelEmpirical, validateTravelEmpirical } from '../packages/contracts/src/rivers.ts';
import { BuildError, buildFromFiles, readRivers } from '../tools/geo/rivernet/build.ts';
import { reachesFile } from '../tools/geo/rivernet/outputs.ts';
import {
  EMPIRICAL_BASIS,
  EMPIRICAL_SOURCE,
  EMPIRICAL_URL,
  empiricalSource,
  place,
  readEmpirical,
  readOverrides,
} from '../tools/geo/rivernet/place.ts';
import { readStations } from '../tools/geo/rivernet/stations.ts';
import { repoRoot } from './catalogue.ts';
import { chain, chainNode, overrides, river, riversFile, station } from './rivernet-synth.ts';
import { fixtureWaterbodies } from './rivernet-waterbodies.ts';

// P14f, plan section 3.6: the geo build reads registry/travel-empirical.yaml. A pair of public stations sets
// reach.travel_time_h and its source text and appends a derived travel_times entry; a sourced pair of rivers.yaml
// always wins; an unknown or non-public station fails the build; the shipped empty file changes nothing.

const SLOW = { timeout: 120_000 };
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof BuildError ? `${e.code}:${e.ids.join(',')}` : `other:${String(e)}`;
  }
  return undefined;
};

const pair = (over: Partial<TravelEmpirical['pairs'][number]> = {}): TravelEmpirical['pairs'][number] => ({
  from_station: 'de.t.1',
  to_station: 'de.t.2',
  h: [2, 7],
  classes: { low: [4, 7], mid: [3, 5], high: [2, 4] },
  quantity: 'H',
  years: [1995, 2026],
  windows: 120,
  ...over,
});
const file = (...pairs: TravelEmpirical['pairs']): TravelEmpirical => ({ version: 1, generated: null, pairs });

describe('the file', () => {
  it('ships empty, in the exact text the command writes', () => {
    const text = readFileSync(`${repoRoot}registry/travel-empirical.yaml`, 'utf8');
    expect(text).toBe(formatTravelEmpirical({ version: 1, generated: null, pairs: [] }));
    expect(readEmpirical().pairs).toEqual([]);
  });

  it('is validated: an h that is not the envelope, a pair twice, a pair on one station and a lo >= hi fail', () => {
    const v = (...pairs: unknown[]) => validateTravelEmpirical({ version: 1, generated: null, pairs });
    expect(v(pair()).problems).toEqual([]);
    expect(v(pair({ h: [3, 7] })).problems[0]).toContain('envelope');
    expect(v(pair(), pair()).problems[0]).toContain('twice');
    expect(v(pair({ to_station: 'de.t.1' })).problems[0]).toContain('same');
    expect(v(pair({ classes: { low: [4, 4] } })).problems[0]).toContain('lo < hi');
    expect(v(pair({ classes: {}, h: [2, 7] })).problems[0]).toContain('no flow class');
    expect(v(pair({ years: [2026, 1995] })).problems[0]).toContain('years');
    expect(validateTravelEmpirical({ version: 1, generated: 'yesterday', pairs: [] }).empirical).toBeUndefined();
    expect(validateTravelEmpirical({ version: 1, generated: null, pairs: [], extra: 1 }).empirical).toBeUndefined();
  });

  it('is written sorted, one pair a line, and reads back to the same data', () => {
    const f = file(pair({ from_station: 'de.t.9', to_station: 'de.t.2' }), pair());
    const text = formatTravelEmpirical({ ...f, generated: '2026-11-20T04:30:00Z' });
    expect(text.indexOf('de.t.1')).toBeLessThan(text.indexOf('de.t.9'));
    expect(validateTravelEmpirical(parse(text)).empirical?.pairs.map((p) => p.from_station)).toEqual([
      'de.t.1',
      'de.t.9',
    ]);
    expect(formatTravelEmpirical(f)).toBe(formatTravelEmpirical(file(...[...f.pairs].reverse())));
  });
});

describe('place() with an empirical file (synthetic graph)', () => {
  const A = chain('a', 4, ['alpha']);
  const at = (i: number): [number, number] => [chainNode(i)[0] + 0.01, 51];
  const stations = [
    station('de.t.1', at(1), { river_hint: 'alpha' }),
    station('de.t.2', at(3), { river_hint: 'alpha' }),
  ];
  const plain = riversFile([river({ id: 'alpha' })]);
  const reach = (p: ReturnType<typeof place>, id: string) => p.reaches.find((r) => r.id === id);

  it('sets the travel time, its source text and a derived pair on the reach between the two stations', () => {
    const p = place(A, plain, stations, overrides(), file(pair()));
    expect(reach(p, 'alpha.2')).toMatchObject({
      up_station: 'de.t.1',
      down_station: 'de.t.2',
      travel_time_h: [2, 7],
      travel_time_source: 'empirical: ΔH cross-correlation, 3/3 flow classes (terciles at de.t.1), 1995–2026',
    });
    expect(reach(p, 'alpha.1')?.travel_time_h).toBeNull();
    expect(reach(p, 'alpha.3')?.travel_time_h).toBeNull();
    expect(p.travel).toEqual([
      {
        from_station: 'de.t.1',
        to_station: 'de.t.2',
        h: [2, 7],
        derived: true,
        basis: EMPIRICAL_BASIS,
        source: EMPIRICAL_SOURCE,
        source_url: EMPIRICAL_URL,
      },
    ]);
  });

  it('attaches nothing to a reach of the tidal zone (P17a), and makes no derived pair of it', () => {
    const zoned = riversFile([river({ id: 'alpha', kind: 'delta_channel', tidal_zone: true })]);
    const edges = A.map((e) => ({ ...e, direction: 'none' as const, direction_reason: 'tidal_zone' as const }));
    const p = place(edges, zoned, stations, overrides(), file(pair()));
    expect(reach(p, 'alpha.2')).toMatchObject({ up_station: 'de.t.1', down_station: 'de.t.2', travel_time_h: null });
    expect(p.travel).toEqual([]);
  });

  it('counts the classes of the pair in the source text', () => {
    const p = place(
      A,
      plain,
      stations,
      overrides(),
      file(pair({ classes: { mid: [3, 5] }, h: [3, 5], quantity: 'Q' })),
    );
    expect(reach(p, 'alpha.2')?.travel_time_source).toContain('ΔQ cross-correlation, 1/3 flow classes');
  });

  it('lets a sourced pair of rivers.yaml win, in the reach and in travel_times', () => {
    const sourced = riversFile([river({ id: 'alpha' })], {
      travel_times: [
        {
          from_station: 'de.t.1',
          to_station: 'de.t.2',
          h: [1, 2],
          basis: 'b',
          source: 'a published table',
          source_url: 'https://example.org/t',
        },
      ],
    });
    const p = place(A, sourced, stations, overrides(), file(pair()));
    expect(reach(p, 'alpha.2')).toMatchObject({ travel_time_h: [1, 2], travel_time_source: 'a published table' });
    expect(p.travel).toHaveLength(1);
    expect(p.travel[0]?.derived).toBeUndefined();
    // even a sourced pair in days (no reach field) keeps the empirical one out
    const days = riversFile([river({ id: 'alpha' })], {
      travel_times: [
        {
          from_station: 'de.t.1',
          to_station: 'de.t.2',
          d: [1, 2],
          basis: 'b',
          source: 's',
          source_url: 'https://example.org/t',
        },
      ],
    });
    const q = place(A, days, stations, overrides(), file(pair()));
    expect(reach(q, 'alpha.2')?.travel_time_h).toBeNull();
    expect(q.travel).toHaveLength(1);
  });

  it('fails the build on an unknown station, and on a station that is not public (owner or off)', () => {
    expect(code(() => place(A, plain, stations, overrides(), file(pair({ to_station: 'de.t.9' }))))).toBe(
      'empirical_unknown_station:de.t.9',
    );
    const owner = [...stations, station('de.t.3', at(2), { river_hint: 'alpha', audience: 'owner', public: false })];
    expect(code(() => place(A, plain, owner, overrides(), file(pair({ to_station: 'de.t.3' }))))).toBe(
      'empirical_non_public_station:de.t.3',
    );
    const off = [...stations, station('de.t.4', at(2), { river_hint: 'alpha', audience: 'off', public: false })];
    expect(code(() => place(A, plain, off, overrides(), file(pair({ from_station: 'de.t.4' }))))).toBe(
      'empirical_non_public_station:de.t.4',
    );
  });

  it('keeps an owner station out of every output even when public stations around it have a pair', () => {
    const owner = [...stations, station('de.t.3', at(2), { river_hint: 'alpha', audience: 'owner', public: false })];
    const p = place(A, plain, owner, overrides(), file(pair()));
    expect(
      JSON.stringify([p.travel, p.reaches.map((r) => [r.up_station, r.down_station, r.travel_time_source])]),
    ).not.toContain('de.t.3');
  });

  it('changes nothing for the empty file, and a pair on no reach changes no reach', () => {
    const none = place(A, plain, stations, overrides());
    expect(place(A, plain, stations, overrides(), file())).toEqual(none);
    const wrongWay = place(
      A,
      plain,
      stations,
      overrides(),
      file(pair({ from_station: 'de.t.2', to_station: 'de.t.1' })),
    );
    expect(wrongWay.reaches).toEqual(none.reaches);
    expect(wrongWay.travel).toEqual([]);
  });

  it('keeps the source text within the 300 characters of the reach contract, whatever the station ids', () => {
    const long = `de.${'a'.repeat(30)}.${'b'.repeat(44)}`;
    expect(long.length).toBeLessThanOrEqual(80);
    expect(empiricalSource(pair({ from_station: long, quantity: 'Q' })).length).toBeLessThanOrEqual(300);
  });

  it('writes no digit into the basis (the site allows a digit in a travel row only beside "indicative")', () => {
    expect(EMPIRICAL_BASIS).not.toMatch(/\d/);
    expect(EMPIRICAL_BASIS.length).toBeLessThanOrEqual(200);
    expect(EMPIRICAL_SOURCE.length).toBeLessThanOrEqual(300);
    expect(EMPIRICAL_URL.startsWith('https://')).toBe(true);
  });
});

const FX = `${repoRoot}tools/geo/fixtures/`;
const empirical = readEmpirical(`${repoRoot}test/fixtures/travel-empirical.yaml`);
const rivers = readRivers();
const build = await buildFromFiles({
  ways: `${FX}rivernet.ways.geojsonseq`,
  relations: `${FX}rivernet.relations.opl`,
  provenance: `${FX}rivernet.provenance.json`,
});
const bodies = await fixtureWaterbodies(rivers);
const stations = readStations();
const base = place(build.edges, rivers, stations, readOverrides(rivers), null, bodies);
const withFile = place(build.edges, rivers, stations, readOverrides(rivers), empirical, bodies);
const osm = (build.graph as { osm: { replication_timestamp: string } }).osm.replication_timestamp;

describe('the committed fixture graph with a fixture file', () => {
  it('gives waal.6 its empirical range and leaves rhine.69 with the sourced [1, 9]', SLOW, () => {
    const by = (p: typeof base, id: string) => p.reaches.find((r) => r.id === id);
    expect(by(base, 'waal.6')?.travel_time_h).toBeNull();
    expect(by(withFile, 'waal.6')).toMatchObject({
      up_station: 'nl.rws.tiel.waal',
      down_station: 'nl.rws.zaltbommel',
      travel_time_h: [2, 7],
      travel_time_source: 'empirical: ΔH cross-correlation, 3/3 flow classes (terciles at nl.rws.tiel.waal), 1995–2026',
    });
    expect(by(withFile, 'rhine.69')).toEqual(by(base, 'rhine.69'));
    expect(by(withFile, 'rhine.69')?.travel_time_h).toEqual([1, 9]);
    // no other reach changed
    const changed = withFile.reaches.filter((r) => JSON.stringify(r) !== JSON.stringify(by(base, r.id)));
    expect(changed.map((r) => r.id)).toEqual(['waal.6']);
  });

  it('appends one derived pair to travel_times of the reaches file, which the contract accepts', SLOW, () => {
    const out = reachesFile(withFile, rivers, '20261120', osm);
    expect(ReachesFile.safeParse(out).success).toBe(true);
    const added = out.travel_times.filter((t) => t.derived === true && t.source === EMPIRICAL_SOURCE);
    expect(added).toEqual([
      {
        from_station_id: 'nl.rws.tiel.waal',
        to_station_id: 'nl.rws.zaltbommel',
        h: [2, 7],
        derived: true,
        basis: EMPIRICAL_BASIS,
        source: EMPIRICAL_SOURCE,
        source_url: EMPIRICAL_URL,
      },
    ]);
    expect(out.travel_times.length).toBe(reachesFile(base, rivers, '20261120', osm).travel_times.length + 1);
  });

  it('is byte-stable and independent of the order of the pairs', SLOW, () => {
    const reversed = place(
      build.edges,
      rivers,
      stations,
      readOverrides(rivers),
      {
        ...empirical,
        pairs: [...empirical.pairs].reverse(),
      },
      bodies,
    );
    expect(JSON.stringify(reachesFile(reversed, rivers, '20261120', osm).reaches)).toBe(
      JSON.stringify(reachesFile(withFile, rivers, '20261120', osm).reaches),
    );
  });
});
