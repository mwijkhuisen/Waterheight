import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readRegistry } from '../apps/server/src/load/registry-sync.ts';
import { CANARY_RENDERINGS } from '../packages/contracts/src/canaries.ts';
import { checkReaches, ReachesFile } from '../packages/contracts/src/reaches.ts';
import { validateRivernet } from '../packages/contracts/src/rivernet.ts';
import { generate, RIVERNET_PATH } from '../scripts/gen-rivernet.ts';
import { buildFromFiles, canonicalJson, readRivers, readWays } from '../tools/geo/rivernet/build.ts';
import type { WayFeature } from '../tools/geo/rivernet/geojsonseq.ts';
import type { LonLat } from '../tools/geo/rivernet/network.ts';
import { parseOplRelations } from '../tools/geo/rivernet/opl.ts';
import { downloadText, reachesFile, snapReport, writeOutputs } from '../tools/geo/rivernet/outputs.ts';
import { type Placed, type PlacedStation, place, readOverrides } from '../tools/geo/rivernet/place.ts';
import { nearestOnRiver, riverOf, snapStations } from '../tools/geo/rivernet/snap.ts';
import { readSources } from '../tools/geo/rivernet/sources.ts';
import { readStations } from '../tools/geo/rivernet/stations.ts';
import { repoRoot } from './catalogue.ts';
import { station } from './rivernet-synth.ts';

// The P6b placement criteria (issue #21) on the committed fixture graph (tools/geo/fixtures, OSM 2026-10-01):
// the golden list, no name-mismatched snap on a canal trap, the §0.6 points, monotone chainage, paths to the
// NL entries, the P11 upstream chain, the owner/off audience rules and determinism.

const FX = `${repoRoot}tools/geo/fixtures/`;
const files = {
  ways: `${FX}rivernet.ways.geojsonseq`,
  relations: `${FX}rivernet.relations.opl`,
  provenance: `${FX}rivernet.provenance.json`,
};
const SLOW = { timeout: 120_000 };
const VERSION = '20261001';

const build = await buildFromFiles(files);
const rivers = readRivers();
const stations = readStations();
const overridesFile = readOverrides(rivers);
const placed = place(build.edges, rivers, stations, overridesFile);
const net = placed.net;
const osm = (build.graph as { osm: { replication_timestamp: string } }).osm.replication_timestamp;
const by = new Map(placed.stations.map((s) => [s.id, s]));
const inputs = new Map(stations.map((s) => [s.id, s]));
const reachBy = new Map(placed.reaches.map((r) => [r.id, r]));
const registryRows = readRegistry().stations;

const tmp = mkdtempSync(join(tmpdir(), 'rivernet-placement-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirSerial = 0;
/** Writes every output of a placement and returns its directory. */
const outputs = (p: Placed) => {
  const dir = join(tmp, `o${++dirSerial}`);
  writeOutputs(dir, p, rivers, VERSION, osm);
  return dir;
};
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');
/** The three files a public reader gets (snap-report holds counts of owner stations, so it differs by design). */
const publicBytes = (p: Placed) => {
  const dir = outputs(p);
  return {
    reaches: read(dir, `reaches-${VERSION}.json`),
    download: gunzipSync(readFileSync(join(dir, `rivers-${VERSION}.geojson.gz`))).toString('utf8'),
    tiles: read(dir, 'rivers.geojsonseq'),
  };
};
const full = publicBytes(placed);

const get = (id: string): PlacedStation => {
  const s = by.get(id);
  if (s === undefined) throw new Error(`station ${id} is not in the registry`);
  return s;
};

// Graph helpers over the routing view (OSM edges and joins).
const linkEnds = (l: string) => net.edges.get(l) ?? (net.joins.find((j) => j.id === l) as { from: string; to: string });
/** Every node reachable downstream from `start` (itself included). */
function forwardNodes(start: string): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    for (const l of net.out.get(stack.pop() as string) ?? []) {
      const t = linkEnds(l).to;
      if (!seen.has(t)) {
        seen.add(t);
        stack.push(t);
      }
    }
  }
  return seen;
}
function backwardNodes(start: string): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    for (const l of net.in.get(stack.pop() as string) ?? []) {
      const f = linkEnds(l).from;
      if (!seen.has(f)) {
        seen.add(f);
        stack.push(f);
      }
    }
  }
  return seen;
}
const edgeOf = (s: PlacedStation) =>
  net.edges.get((s.placement as { edge: string }).edge) as NonNullable<ReturnType<typeof net.edges.get>>;
const entryNode = (id: string) => (net.entries.find((e) => e.id === id) as { node: string }).node;

// ---- reading the trap ways of the fixture (as test/rivernet-fixture.test.ts does) ----
const allWays = await readWays(Readable.from([readFileSync(files.ways)]));
const allRelations = parseOplRelations(readFileSync(files.relations, 'utf8'));
const edgeWays = new Set(build.edges.map((e) => e.way));
const trapWays = (name: string): WayFeature[] => {
  const trap = readSources().canal_traps.find((t) => t.name === name);
  const rs = allRelations.filter(
    (r) => r.id === trap?.osm_relation_id || (trap?.wikidata != null && r.tags.wikidata === trap.wikidata),
  );
  const ids = new Set([
    ...rs.flatMap((r) => r.members.filter((m) => m.type === 'w').map((m) => m.ref)),
    ...[...allWays.values()].filter((w) => w.tags.wikidata === trap?.wikidata).map((w) => w.id),
  ]);
  return [...ids].filter((id) => allWays.has(id)).map((id) => allWays.get(id) as WayFeature);
};
/** Metres from a point to a polyline (local equirectangular metres per segment). */
function distToLine(at: LonLat, line: readonly LonLat[]): number {
  const kx = 111_320 * Math.cos((at[1] * Math.PI) / 180);
  const ky = 110_574;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = [((line[i] as LonLat)[0] - at[0]) * kx, ((line[i] as LonLat)[1] - at[1]) * ky];
    const [bx, by_] = [((line[i + 1] as LonLat)[0] - at[0]) * kx, ((line[i + 1] as LonLat)[1] - at[1]) * ky];
    const [vx, vy] = [bx - ax, by_ - ay];
    const l2 = vx * vx + vy * vy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2));
    best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
  }
  return best;
}
const TRAPS = ['Julianakanaal', 'Albertkanaal', 'Zuid-Willemsvaart', "Grand Canal d'Alsace", 'Bijlands Kanaal'];
const nearTrap = new Map(
  TRAPS.map((name) => {
    const ways = trapWays(name);
    const ids = stations
      .filter((s) => s.lon !== null && s.lat !== null)
      .filter((s) => ways.some((w) => distToLine([s.lon as number, s.lat as number], w.coords) <= 1000))
      .map((s) => s.id);
    return [name, ids] as const;
  }),
);
const trapCounts = TRAPS.map((n) => `${n} ${nearTrap.get(n)?.length}`).join(', ');

describe('placement golden list', () => {
  const golden = parse(readFileSync(`${repoRoot}test/fixtures/rivernet-golden.yaml`, 'utf8')) as {
    stations: {
      station: string;
      river: string | null;
      rule: string;
      km_official: number | null;
      nl_entry_node: string | null;
    }[];
  };

  it('has at least 50 entries and every one matches the placement exactly', SLOW, () => {
    expect(golden.stations.length).toBeGreaterThanOrEqual(50);
    const wrong = golden.stations
      .filter((g) => {
        const s = by.get(g.station);
        return !(
          s?.river === g.river &&
          s.rule === g.rule &&
          s.km_official === g.km_official &&
          s.nl_entry_node === g.nl_entry_node
        );
      })
      .map(
        (g) =>
          `${g.station}: want ${JSON.stringify(g)}, got ${JSON.stringify({ ...by.get(g.station), placement: undefined })}`,
      );
    expect(wrong).toEqual([]);
  });

  it('holds every §0.6 point and the 18 FR-1 partners', SLOW, () => {
    const ids = new Set(golden.stations.map((g) => g.station));
    for (const id of [
      'nl.rws.antwerpen',
      'nl.rws.lixhebiefaval',
      'nl.rws.maaseik',
      'nl.rws.herenlaak',
      'nl.rws.lanaken',
      'nl.rws.smeermaas.zuidwillemsvaart',
      'nl.rws.kanne',
    ])
      expect(ids.has(id), id).toBe(true);
    const partners = readFileSync(`${repoRoot}registry/seed/fr-1-be.csv`, 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .slice(1)
      .map((l) => `fr.sandre.${l.split(',')[0]}`);
    expect(partners).toHaveLength(18);
    expect(partners.filter((p) => !ids.has(p))).toEqual([]);
  });
});

describe(`canal traps (stations within 1 km of a trap way: ${trapCounts})`, () => {
  it('puts every placed station on an edge of its own river', SLOW, () => {
    const placedRules = new Set(['override', 'name', 'official_km']);
    const some = placed.stations.filter((s) => placedRules.has(s.rule));
    expect(some.length).toBeGreaterThan(400);
    const wrong = some.filter((s) => s.river === null || !edgeOf(s).rivers.includes(s.river)).map((s) => s.id);
    expect(wrong).toEqual([]);
  });

  it('places by name only on the river that the published water body names', SLOW, () => {
    const byName = placed.stations.filter((s) => s.rule === 'name');
    expect(byName.length).toBeGreaterThan(200);
    const wrong = byName
      .filter((s) => riverOf(net, overridesFile, inputs.get(s.id) as never) !== s.river)
      .map((s) => s.id);
    expect(wrong).toEqual([]);
    // and the name is a verbatim spelling of its source, an owner label of the table, or the DE-1 river of the generator
    for (const s of byName) {
      const i = inputs.get(s.id) as NonNullable<ReturnType<typeof inputs.get>>;
      const named =
        (i.water_name !== null &&
          (rivers.rivers.find((r) => r.id === s.river)?.names[i.source] ?? []).includes(i.water_name)) ||
        overridesFile.waters.some(
          (w) => w.source === i.source && w.water_name === i.water_name && w.river === s.river,
        ) ||
        i.river_hint === s.river;
      expect(named, s.id).toBe(true);
    }
  });

  it('never makes a canal way an edge, and places a station near a trap on its own river', SLOW, () => {
    for (const name of TRAPS) {
      const ways = trapWays(name);
      expect(ways.length, name).toBeGreaterThan(0);
      const asEdges = ways.filter((w) => edgeWays.has(w.id));
      // only river ways of a curated river are edges (the Bijlands Kanaal is the Rhine)
      expect(
        asEdges.filter((w) => w.tags.waterway !== 'river'),
        name,
      ).toEqual([]);
      if (['Julianakanaal', 'Albertkanaal', 'Zuid-Willemsvaart'].includes(name)) expect(asEdges, name).toEqual([]);
      const trapIds = new Set(ways.map((w) => w.id));
      for (const id of nearTrap.get(name) ?? []) {
        const s = get(id);
        if (s.river === null) continue;
        const e = edgeOf(s);
        expect(e.rivers.includes(s.river), `${id} on ${e.id}`).toBe(true);
        if (trapIds.has(e.way)) expect(e.rivers.includes(s.river), `${id} on trap way ${e.way}`).toBe(true);
      }
    }
    // Rheinweiler (DE-1, the Restrhein beside the Grand Canal d'Alsace) is one of them and stays on the Rhine.
    expect(nearTrap.get("Grand Canal d'Alsace")).toContain('de.wsv.23300130');
    expect(get('de.wsv.23300130')).toMatchObject({ river: 'rhine', rule: 'name' });
  });

  it("does not snap a station named Rhein onto a point of the Grand Canal d'Alsace (no_edge_within_500m)", SLOW, () => {
    const canalOnly = trapWays("Grand Canal d'Alsace").filter((w) => !edgeWays.has(w.id));
    const far = canalOnly
      .flatMap((w) => w.coords)
      .find((c) => (nearestOnRiver(net, 'rhine', c, 100_000)?.distance_m ?? Number.POSITIVE_INFINITY) > 500);
    expect(far, 'a canal point more than 500 m from the Rhine').toBeDefined();
    const at = far as LonLat;
    expect(nearestOnRiver(net, 'rhine', at, 500)).toBeNull();
    const [snap] = snapStations(net, [station('ch.test.rhein', at, { source: 'CH-1', water_name: 'Rhein' })], {
      ...overridesFile,
      stations: [],
    });
    expect(snap).toMatchObject({ rule: 'no_edge_within_500m', river: null, placement: null });
  });
});

describe('the §0.6 points', () => {
  it('places Antwerpen on the Scheldt and the Belgian Meuse gauges on the Meuse', SLOW, () => {
    expect(get('nl.rws.antwerpen')).toMatchObject({
      river: 'scheldt',
      rule: 'override',
      nl_entry_node: 'scheldt-border',
    });
    expect(get('nl.rws.antwerpen').km_to_nl_entry).toBe(25.06);
    for (const id of ['nl.rws.lixhebiefaval', 'nl.rws.maaseik', 'nl.rws.herenlaak', 'nl.rws.lanaken'])
      expect(get(id), id).toMatchObject({ river: 'meuse', rule: 'override', nl_entry_node: 'eijsden' });
  });

  it('places the Semois, Chiers, Viroin and Lys partners on their own rivers', SLOW, () => {
    const want: Record<string, string> = {
      B610000201: 'semois',
      B610000301: 'semois',
      B610000401: 'semois',
      B610000601: 'semois',
      B610000701: 'semois',
      B400101101: 'chiers',
      B422431101: 'chiers',
      B713000101: 'viroin',
      B713000201: 'viroin',
      B713000301: 'viroin',
      E381126601: 'lys',
    };
    for (const [code, river] of Object.entries(want)) expect(get(`fr.sandre.${code}`).river, code).toBe(river);
  });

  it('keeps the Smeermaas canal intake and Kanne off the Meuse and off every reach', SLOW, () => {
    expect(get('nl.rws.smeermaas.zuidwillemsvaart')).toMatchObject({
      rule: 'canal',
      river: null,
      placement: null,
      reach: null,
    });
    expect(get('nl.rws.kanne')).toMatchObject({ rule: 'unsnapped', river: null, placement: null, reach: null });
    for (const id of ['nl.rws.smeermaas.zuidwillemsvaart', 'nl.rws.kanne']) {
      expect(get(id).river).not.toBe('meuse');
      expect(placed.reaches.some((r) => r.up_station === id || r.down_station === id)).toBe(false);
    }
  });

  it('names every river in Dutch and English on one line', () => {
    expect(rivers.rivers.length).toBeGreaterThan(40);
    for (const r of rivers.rivers) {
      for (const n of [r.name_nl, r.name_en]) {
        expect(n.trim(), r.id).not.toBe('');
        expect(n, r.id).not.toMatch(/[\r\n]/);
      }
    }
  });
});

/** The stations of `river` between two placements, sorted by km_graph. */
function sequence(river: string, first: string, last: string): PlacedStation[] {
  const fwd = forwardNodes(edgeOf(get(first)).to);
  const bwd = backwardNodes(edgeOf(get(last)).from);
  const onPath = (s: PlacedStation) => {
    const e = edgeOf(s);
    const fromFirst = e.id === edgeOf(get(first)).id || fwd.has(e.from);
    const toLast = e.id === edgeOf(get(last)).id || bwd.has(e.to);
    return fromFirst && toLast;
  };
  return placed.stations
    .filter((s) => s.river === river && s.placement !== null && onPath(s))
    .sort((a, b) => rawKm(a) - rawKm(b) || (a.id < b.id ? -1 : 1));
}
/** km_graph in metres before the 10 m rounding of the published value. */
const rawKm = (s: PlacedStation) =>
  (net.kmGraph.get(s.river as string)?.get(edgeOf(s).from) ?? 0) + (s.placement?.offset_m ?? 0);

describe('monotone chainage per river sequence', () => {
  const moselleMouth = stations
    .filter((s) => s.river_hint === 'moselle' && s.km !== null && by.get(s.id)?.rule === 'name')
    .sort((a, b) => (a.km?.value as number) - (b.km?.value as number))[0]?.id as string;
  const cases = [
    {
      name: 'Rhine, Basel to Lobith',
      river: 'rhine',
      first: 'ch.bafu.2289',
      last: 'nl.rws.lobith.bovenrijn.tolkamer',
      min: 8,
      dir: 1,
    },
    {
      name: 'Meuse, Chooz to Lith',
      river: 'meuse',
      first: 'fr.sandre.B720000001',
      last: 'nl.rws.lith.boven',
      min: 5,
      dir: 1,
    },
    {
      name: 'Moselle, Uckange to the mouth',
      river: 'moselle',
      first: 'fr.sandre.A850061001',
      last: moselleMouth,
      min: 5,
      dir: -1,
    },
  ];
  for (const c of cases) {
    it(`${c.name}: km_graph rises, km_to_nl_entry falls, km_official follows the river`, SLOW, () => {
      const seq = sequence(c.river, c.first, c.last);
      expect(seq.length).toBeGreaterThanOrEqual(c.min);
      // the ends may be preceded or followed by a twin id within 10 m (ch.bafu-pq.2289 is 1.7 m above ch.bafu.2289)
      expect(Math.abs(rawKm(seq[0] as PlacedStation) - rawKm(get(c.first)))).toBeLessThan(10);
      expect(Math.abs(rawKm(seq.at(-1) as PlacedStation) - rawKm(get(c.last)))).toBeLessThan(10);
      expect(seq.map((x) => x.id)).toContain(c.first);
      expect(seq.map((x) => x.id)).toContain(c.last);
      const problems: string[] = [];
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1] as PlacedStation;
        const b = seq[i] as PlacedStation;
        const same = a.placement?.edge === b.placement?.edge && a.placement?.offset_m === b.placement?.offset_m;
        if (!(rawKm(a) < rawKm(b) || (same && rawKm(a) === rawKm(b))))
          problems.push(`km_graph ${a.id} ${a.km_graph} -> ${b.id} ${b.km_graph}`);
        if ((b.km_to_nl_entry as number) > (a.km_to_nl_entry as number))
          problems.push(`km_to_nl_entry ${a.id} ${a.km_to_nl_entry} -> ${b.id} ${b.km_to_nl_entry}`);
      }
      // per km system, never across systems (catalogue §4.7): values follow the river's km_direction
      const systems = new Map<string, PlacedStation[]>();
      // Strict, every station: a lock gauge off the river line (Wintrich OP, 655 m) is placed by its km (by_km).
      for (const s of seq)
        if (s.km_official !== null)
          systems.set(s.km_official_system as string, [...(systems.get(s.km_official_system as string) ?? []), s]);
      for (const [system, list] of systems)
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1] as PlacedStation;
          const b = list[i] as PlacedStation;
          if (((b.km_official as number) - (a.km_official as number)) * c.dir < 0)
            problems.push(`${system} ${a.id} ${a.km_official} -> ${b.id} ${b.km_official}`);
        }
      expect(problems).toEqual([]);
    });
  }
});

describe('paths to the NL entries', () => {
  const reachesEntry = (id: string, entry: string) => {
    const e = edgeOf(get(id));
    return e.from === entryNode(entry) || forwardNodes(e.to).has(entryNode(entry));
  };
  const cases: [string, string][] = [
    ['ch.bafu.2289', 'lobith'],
    ['de.wsv.26500100', 'lobith'],
    ['de.wsv.24900108', 'lobith'],
    ['fr.sandre.B720000001', 'eijsden'],
    ['fr.sandre.E131000202', 'scheldt-border'],
    ['fr.sandre.E240041101', 'scheldt-border'],
  ];
  for (const [id, entry] of cases)
    it(`${id} drains to ${entry} by a graph path`, SLOW, () => {
      expect(get(id).nl_entry_node).toBe(entry);
      expect(reachesEntry(id, entry)).toBe(true);
    });

  it('reaches the Waal, Nederrijn, Lek and IJssel downstream of Lobith', SLOW, () => {
    const lobith = edgeOf(get('nl.rws.lobith.bovenrijn.tolkamer'));
    const nodes = forwardNodes(lobith.to);
    const carried = new Set(build.edges.filter((e) => nodes.has(e.from)).flatMap((e) => e.rivers));
    for (const r of ['waal', 'nederrijn', 'lek', 'ijssel']) expect(carried.has(r), r).toBe(true);
  });

  it('measures the Rhine km to Lobith within 2 % + 1 km of the catalogue distance (862.0 - rkm)', SLOW, () => {
    const rows = placed.stations.filter(
      (s) =>
        s.river === 'rhine' &&
        s.km_official_system === 'RHEIN-km (PEGELONLINE)' &&
        (s.km_to_nl_entry ?? 0) > 0 &&
        s.nl_entry_node === 'lobith',
    );
    expect(rows.length).toBeGreaterThan(15);
    let worst = { id: '', excess: Number.NEGATIVE_INFINITY, got: 0, want: 0 };
    for (const s of rows) {
      const want = 862.0 - (s.km_official as number);
      const got = s.km_to_nl_entry as number;
      const excess = Math.abs(got - want) - (0.02 * want + 1);
      if (excess > worst.excess) worst = { id: s.id, excess, got, want };
    }
    expect(worst.excess, `worst ${JSON.stringify(worst)}`).toBeLessThanOrEqual(0);
  });
});

describe('the upstream chain of Lobith (P11)', () => {
  it('lists Emmerich, Rees, Wesel, Duisburg-Ruhrort, Duesseldorf and Koeln by walking upstream', SLOW, () => {
    const lobith = 'nl.rws.lobith.bovenrijn.tolkamer';
    let reach = placed.reaches.find((r) => r.down_station === lobith && r.river === 'rhine');
    expect(reach, 'the reach that ends at Lobith').toBeDefined();
    const found: string[] = [];
    for (let step = 0; step < 300 && found.length < 6 && reach !== undefined; step++) {
      if (reach.up_station !== null) found.push(reach.up_station);
      const ups = reach.upstream.filter((u) => reachBy.get(u)?.river === 'rhine');
      if (found.length < 6) expect(ups, `upstream of ${reach.id}`).toHaveLength(1);
      reach = reachBy.get(ups[0] as string);
    }
    expect(found).toEqual([
      'de.wsv.2790020',
      'de.wsv.2790010',
      'de.wsv.2770040',
      'de.wsv.2770010',
      'de.wsv.2750010',
      'de.wsv.2730010',
    ]);
  });
});

describe('owner and off audiences', () => {
  const SPW = [8702, 8067, 8059, 8022, 8017, 8001, 7197, 7141, 7137, 7133, 7117, 7102, 5451, 5447, 5436].map(
    (n) => `be.spw.${n}`,
  );

  it('places the SPW Meuse gauges in flow order, each with a reach, none cutting one', SLOW, () => {
    // The brief listed 5447 before 5451; Visé (5451, 50.726 N) lies upstream of Lixhe Bief Amont (5447, 50.746 N).
    const rows = SPW.map(get);
    for (const s of rows) {
      expect(s.river, s.id).toBe('meuse');
      expect(s.public, s.id).toBe(false);
      expect(s.reach, s.id).not.toBeNull();
      expect(
        placed.reaches.some((r) => r.up_station === s.id || r.down_station === s.id),
        s.id,
      ).toBe(false);
    }
    const km = rows.map((s) => s.km_graph as number);
    for (let i = 1; i < km.length; i++)
      expect(km[i], `${SPW[i - 1]} -> ${SPW[i]}`).toBeGreaterThanOrEqual(km[i - 1] as number);
    expect(km.at(-1)).toBeGreaterThan(km[0] as number);
  });

  const nonPublic = placed.stations.filter((s) => !s.public);
  const ownerRows = registryRows.filter((r) => r.audience === 'owner');
  // A label equal to a public river's name or spelling (the SPW 'Semois') is not a leak of the owner row.
  const riverWords = new Set(
    rivers.rivers.flatMap((r) => [r.name_nl, r.name_en, r.id, ...r.aliases, ...Object.values(r.names).flat()]),
  );
  const secrets = [
    ...new Set(
      ownerRows.flatMap((r) => [r.name, r.water_name ?? '']).filter((t) => t.length >= 6 && !riverWords.has(t)),
    ),
  ];
  const snap = snapReport(placed, VERSION, osm);
  const texts: [string, string][] = [
    ['reaches json', canonicalJson(reachesFile(placed, rivers, VERSION, osm))],
    ['download', downloadText(placed, rivers, VERSION, osm)],
    ['tiles', full.tiles],
    ['snap report', snap],
  ];

  it('keeps every non-public station id, owner name and canary out of every public output', SLOW, () => {
    expect(nonPublic.length).toBeGreaterThan(500);
    expect(secrets.length).toBeGreaterThan(20);
    for (const [what, text] of texts) {
      expect(
        nonPublic.filter((s) => text.includes(`"${s.id}"`)).map((s) => s.id),
        `${what}: ids`,
      ).toEqual([]);
      expect(
        secrets.filter((t) => text.includes(t)),
        `${what}: owner names`,
      ).toEqual([]);
      expect(
        CANARY_RENDERINGS.filter((c) => text.includes(c)),
        `${what}: canary`,
      ).toEqual([]);
    }
  });

  it('gives the same public bytes with owner and off stations left out of the placement', SLOW, () => {
    const keep = stations.filter((s) => s.audience === 'public');
    expect(keep.length).toBeLessThan(stations.length);
    const ids = new Set(keep.map((s) => s.id));
    const only = place(build.edges, rivers, keep, {
      ...overridesFile,
      stations: overridesFile.stations.filter((o) => ids.has(o.station)),
    });
    expect(publicBytes(only)).toEqual(full);
  });

  it('gives the same public bytes with an extra owner station between Koeln and Duesseldorf', SLOW, () => {
    const lo = get('de.wsv.2730010').km_graph as number;
    const hi = get('de.wsv.2750010').km_graph as number;
    const mid = (lo + hi) / 2;
    const e = [...(net.riverEdges.get('rhine') ?? [])]
      .map((id) => net.edges.get(id))
      .filter((x): x is NonNullable<typeof x> => x !== undefined && net.primary.get(x.id) === 'rhine')
      .map((x) => ({ x, km: ((net.kmGraph.get('rhine')?.get(x.from) ?? 0) + x.length_m / 2) / 1000 }))
      .filter((y) => y.km > lo && y.km < hi)
      .sort((a, b) => Math.abs(a.km - mid) - Math.abs(b.km - mid))[0]?.x;
    expect(e, 'a Rhine edge between Koeln and Duesseldorf').toBeDefined();
    const m = (e as NonNullable<typeof e>).coords[Math.floor((e as NonNullable<typeof e>).coords.length / 2)] as LonLat;
    const canary = station('nl.canary.owner', [m[0], m[1] + 100 / 110_574], {
      source: 'BE-3',
      audience: 'owner',
      public: false,
      water_name: null,
      river_hint: null,
    });
    const withCanary = place(build.edges, rivers, [...stations, canary], {
      ...overridesFile,
      stations: [...overridesFile.stations, { station: 'nl.canary.owner', river: 'rhine', reason: 'canary' }],
    });
    const c = withCanary.stations.find((s) => s.id === 'nl.canary.owner') as PlacedStation;
    expect(c).toMatchObject({ river: 'rhine', rule: 'override', public: false });
    expect(c.reach).not.toBeNull();
    expect(c.km_graph).toBeGreaterThan(lo);
    expect(c.km_graph).toBeLessThan(hi);
    expect(c.placement?.distance_m).toBeGreaterThan(50);
    expect(c.placement?.distance_m).toBeLessThan(200);
    expect(publicBytes(withCanary)).toEqual(full);
    expect(publicBytes(withCanary).reaches).not.toContain('nl.canary.owner');
  });
});

describe('flags and travel times', () => {
  it(
    'flags the reach of Antwerpen tidal, the Moselle reach of Trier UP impounded and the reach from Lobith neither',
    SLOW,
    () => {
      expect(reachBy.get(get('nl.rws.antwerpen').reach as string)?.flags.tidal).toBe(true);
      expect(reachBy.get(get('de.wsv.26500100').reach as string)?.flags.impounded).toBe(true);
      const fromLobith = placed.reaches.find((r) => r.up_station === 'nl.rws.lobith.bovenrijn.tolkamer');
      expect(fromLobith).toBeDefined();
      expect(fromLobith?.flags).toMatchObject({ tidal: false, impounded: false });
    },
  );

  it('gives Emmerich to Lobith [1, 8] h and no other reach a travel time without a curated pair', SLOW, () => {
    const emmerich = placed.reaches.find(
      (r) => r.up_station === 'de.wsv.2790020' && r.down_station === 'nl.rws.lobith.bovenrijn.tolkamer',
    );
    expect(emmerich?.id).toBe('rhine.56');
    expect(emmerich?.travel_time_h).toEqual([1, 8]);
    const pairs = new Set((rivers.travel_times ?? []).map((t) => `${t.from_station}>${t.to_station}`));
    const timed = placed.reaches.filter((r) => r.travel_time_h !== null);
    expect(timed.map((r) => r.id)).toEqual(['rhine.56']);
    for (const r of timed) expect(pairs.has(`${r.up_station}>${r.down_station}`), r.id).toBe(true);
  });
});

describe('known gaps', () => {
  it('KG-160: the Riviere Scarpe stations are not placed', SLOW, () => {
    const upper = stations.filter((s) => s.water_name === 'Rivière Scarpe');
    expect(upper.length).toBeGreaterThanOrEqual(1);
    for (const s of upper)
      expect(get(s.id), s.id).toMatchObject({ rule: 'unsnapped', river: null, placement: null, reach: null });
  });

  it('KG-162: no output holds an OSM edge id', SLOW, () => {
    const dir = outputs(placed);
    const texts = [
      full.reaches,
      full.download,
      full.tiles,
      read(dir, 'snap-report.json'),
      readFileSync(`${repoRoot}registry/rivernet.yaml`, 'utf8'),
    ];
    for (const t of texts) expect(t).not.toMatch(/\bw\d+\.\d+\b/);
  });
});

describe('determinism and the generated file', () => {
  it('writes byte-identical files twice, and from the stations in reverse order', SLOW, () => {
    const a = outputs(placed);
    const b = outputs(placed);
    const c = outputs(place(build.edges, rivers, [...stations].reverse(), overridesFile));
    const names = readdirSync(a).sort();
    expect(names).toEqual(
      [
        `reaches-${VERSION}.json`,
        `rivers-${VERSION}.geojson.gz`,
        'rivers.geojsonseq',
        'snap-report.json',
        'VERSION',
      ].sort(),
    );
    // `stations` of reachesFile and snapReport follow the order of the input stations (readStations sorts by id,
    // so the CLI is deterministic); an input in reverse order differs in that order only, compared sorted.
    const sorted = (dir: string, n: string) => {
      const doc = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { stations: { id: string }[] };
      doc.stations.sort((x, y) => (x.id < y.id ? -1 : 1));
      return canonicalJson(doc);
    };
    for (const n of names) {
      expect(readFileSync(join(b, n)).equals(readFileSync(join(a, n))), `${n} twice`).toBe(true);
      if (n === `reaches-${VERSION}.json` || n === 'snap-report.json')
        expect(sorted(c, n), `${n} reversed`).toBe(sorted(a, n));
      else expect(readFileSync(join(c, n)).equals(readFileSync(join(a, n))), `${n} reversed`).toBe(true);
    }
  });

  it('writes a reaches file that the schema and its cross-checks accept', SLOW, () => {
    const file = reachesFile(placed, rivers, VERSION, osm);
    const parsed = ReachesFile.parse(JSON.parse(canonicalJson(file)));
    expect(checkReaches(parsed)).toEqual([]);
    expect(parsed.reaches.length).toBeGreaterThan(600);
    expect(parsed.stations.length).toBeGreaterThan(400);
  });

  it('equals the committed registry/rivernet.yaml byte for byte, and that file validates', SLOW, async () => {
    const text = await generate();
    expect(readFileSync(RIVERNET_PATH, 'utf8') === text).toBe(true);
    const { problems } = validateRivernet(parse(text));
    expect(problems).toEqual([]);
  });
});
