import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CANARY_RENDERINGS } from '../packages/contracts/src/canaries.ts';
import { TABLE, type WaterType } from '../scripts/rws-inventory.ts';
import { buildFromFiles, canonicalJson, readRivers } from '../tools/geo/rivernet/build.ts';
import { reachesFile, writeOutputs } from '../tools/geo/rivernet/outputs.ts';
import { type PlacedStation, place, readOverrides } from '../tools/geo/rivernet/place.ts';
import { readStations, type StationInput } from '../tools/geo/rivernet/stations.ts';
import type { WaterbodyInput } from '../tools/geo/rivernet/waterbodies.ts';
import { repoRoot } from './catalogue.ts';
import { station } from './rivernet-synth.ts';
import { fixtureWaterbodies } from './rivernet-waterbodies.ts';

// P17b criteria C1 and C2 (issue #65) on the committed fixtures (tools/geo/fixtures: the river graph and the
// water-body export of geo.yml run 39238147583): every public NL-1 station has an outcome, the 40 golden stations land
// where hand-checked, the lakes of the P15 inventory are bodies with polygons and reviewed names, and the reaches file
// lists them. The planted synthetic cases (containment without identity, identity too far, outside a point-only bbox)
// are in test/waterbody-place.test.ts; here they run once more against the real Markermeer polygon and the Waddenzee.

const FX = `${repoRoot}tools/geo/fixtures/`;
const SLOW = { timeout: 120_000 };
const VERSION = '20261001';

const build = await buildFromFiles({
  ways: `${FX}rivernet.ways.geojsonseq`,
  relations: `${FX}rivernet.relations.opl`,
  provenance: `${FX}rivernet.provenance.json`,
});
const rivers = readRivers();
const bodies = await fixtureWaterbodies(rivers);
const stations = readStations();
const overridesFile = readOverrides(rivers);
const placed = place(build.edges, rivers, stations, overridesFile, null, bodies);
const osm = (build.graph as { osm: { replication_timestamp: string } }).osm.replication_timestamp;
const by = new Map(placed.stations.map((s) => [s.id, s]));
const inputs = new Map(stations.map((s) => [s.id, s]));
const bodyBy = new Map(bodies.file.waterbodies.map((b) => [b.id, b]));
const overrideBy = new Map(overridesFile.stations.map((o) => [o.station, o]));

const get = (id: string): PlacedStation => {
  const s = by.get(id);
  if (s === undefined) throw new Error(`station ${id} is not in the registry`);
  return s;
};
/** The location code of an NL-1 station id, the key of the P15 TABLE. */
const codeOf = (id: string) => id.replace(/^nl\.rws\./, '');
const typeOf = (id: string): WaterType | undefined => TABLE[codeOf(id)]?.type;

const nl1 = placed.stations.filter((s) => s.public && s.source === 'NL-1');

describe('every public NL-1 station has an outcome (C1)', () => {
  it('has a P15 TABLE row for each of them', SLOW, () => {
    expect(nl1.length).toBeGreaterThan(350);
    expect(nl1.filter((s) => typeOf(s.id) === undefined).map((s) => s.id)).toEqual([]);
  });

  it('lands each on an edge, a canal edge, a water body or an unsnapped override with a reason', SLOW, () => {
    const outcome = (s: PlacedStation): string[] => {
      const o = overrideBy.get(s.id);
      return [
        ...(s.placement !== null ? ['edge'] : []),
        ...(s.rule === 'canal_edge' ? ['canal_edge'] : []),
        ...(s.waterbody !== null ? ['waterbody'] : []),
        ...(o !== undefined && (o.unsnapped === true || o.canal !== undefined) && o.reason.trim() !== ''
          ? ['reasoned']
          : []),
      ];
    };
    const none = nl1.filter((s) => outcome(s).length === 0).map((s) => `${s.id} (${s.rule})`);
    expect(none).toEqual([]);
    // The two stations that sit on a delta channel or the Scheldt AND in a body (the golden list names them).
    const both = nl1.filter((s) => s.placement !== null && s.waterbody !== null).map((s) => s.id);
    expect(both.sort()).toEqual(['nl.rws.hellevoetsluis', 'nl.rws.rilland.bath']);
  });

  // Every exception to "a lake, coast, scheldt or offshore location has a body": a new one shows in review.
  const NO_BODY: Record<string, string> = {
    'nl.rws.lelystad.houtribsluis.noord':
      'unsnapped by override: RWS does not say whether the gauge reads the IJsselmeer or the Markermeer side',
    'nl.rws.lelystad.houtribsluis.zuid':
      'unsnapped by override: RWS does not say whether the gauge reads the IJsselmeer or the Markermeer side',
    'nl.rws.nieuwvossemeer':
      'on the Schelde-Rijnkanaal edge (canal_edge); not on the Vossemeer polygon, no body by identity',
    'nl.rws.antwerpen':
      'Antwerp is on the Zeeschelde above the border: a river placement only, the Westerschelde body ends at the Dutch coast',
    'nl.rws.dronten.reevesluis.vossemeer':
      'unsnapped by override (review R1-3): named Vossemeer but inside the Drontermeer, 2.7 km from the Vossemeer polygon',
    'nl.rws.elburg.elburgerbrug':
      'unsnapped by override (review R1-4): where the Veluwemeer and the Drontermeer meet; RWS names neither',
  };

  it('gives every lake, coast, scheldt and offshore station a body, bar the listed exceptions', SLOW, () => {
    const water = new Set<WaterType>(['lake', 'coast', 'scheldt', 'offshore']);
    const missing = nl1.filter((s) => water.has(typeOf(s.id) as WaterType) && s.waterbody === null).map((s) => s.id);
    expect(missing.sort()).toEqual(Object.keys(NO_BODY).sort());
    for (const id of Object.keys(NO_BODY)) expect(get(id).waterbody, id).toBeNull();
  });

  it('takes a body only from identity: a waterbody override or an exact name of that body', SLOW, () => {
    const withBody = placed.stations.filter((s) => s.waterbody !== null);
    expect(withBody.length).toBeGreaterThan(90);
    for (const s of withBody) {
      const o = overrideBy.get(s.id);
      const named = (bodyBy.get(s.waterbody as string)?.names[s.source] ?? []).includes(
        inputs.get(s.id)?.water_name as string,
      );
      expect(o?.waterbody === s.waterbody || named, `${s.id} -> ${s.waterbody}`).toBe(true);
    }
  });
});

describe('the golden list of 40 stations (C1)', () => {
  interface Row {
    station: string;
    target: string;
    class: WaterType;
    reason: string;
  }
  const golden = (parse(readFileSync(`${repoRoot}test/fixtures/waterbody-golden.yaml`, 'utf8')) as { stations: Row[] })
    .stations;
  /** What the placement of a station is, by the row's class (see the header of the golden file). */
  const landing = (s: PlacedStation, cls: WaterType): string | null =>
    cls === 'delta' ? s.river : cls === 'canal' ? s.canal : s.waterbody;

  it('has exactly 40 distinct public NL-1 stations', () => {
    expect(golden).toHaveLength(40);
    expect(new Set(golden.map((g) => g.station)).size).toBe(40);
    for (const g of golden) {
      expect(g.reason.trim().length, g.station).toBeGreaterThan(20);
      expect(by.get(g.station)?.public, g.station).toBe(true);
      expect(by.get(g.station)?.source, g.station).toBe('NL-1');
    }
  });

  it('has the class of each station’s TABLE row, and covers all six classes', () => {
    expect(golden.filter((g) => typeOf(g.station) !== g.class).map((g) => g.station)).toEqual([]);
    expect(new Set(golden.map((g) => g.class))).toEqual(
      new Set(['lake', 'coast', 'scheldt', 'offshore', 'delta', 'canal']),
    );
  });

  it('lands every one on its target (100 %)', SLOW, () => {
    const wrong = golden
      .filter((g) => landing(get(g.station), g.class) !== g.target)
      .map((g) => `${g.station}: ${landing(get(g.station), g.class)} != ${g.target}`);
    expect(wrong).toEqual([]);
    // A canal row is a canal edge with no river; a delta row has a reach; a body row has a body.
    for (const g of golden) {
      const s = get(g.station);
      if (g.class === 'canal') expect(s, g.station).toMatchObject({ rule: 'canal_edge', river: null, reach: null });
      if (g.class === 'delta') expect(s.reach, g.station).not.toBeNull();
    }
  });
});

describe('planted cases on the real polygons (C1)', () => {
  const marker = inputs.get('nl.rws.markermeer.midden') as StationInput;
  const planted = (id: string, o: Partial<StationInput>): StationInput =>
    station(id, [marker.lon as number, marker.lat as number], { source: 'NL-1', ...o });
  const placeOne = (s: StationInput) =>
    place(build.edges, rivers, [...stations, s], overridesFile, null, bodies).stations.find(
      (x) => x.id === s.id,
    ) as PlacedStation;

  it('assigns nothing to a station inside the Markermeer polygon with no identity', SLOW, () => {
    expect(placeOne(planted('nl.t.1', {}))).toMatchObject({ waterbody: null, waterbody_rule: null });
    expect(placeOne(planted('nl.t.2', { water_name: 'markermeer' }))).toMatchObject({ waterbody: null });
  });

  it('gives waterbody_too_far and no body to the IJsselmeer by name, 9 km inside the Markermeer', SLOW, () => {
    const s = placeOne(planted('nl.t.1', { water_name: 'IJsselmeer' }));
    expect(s).toMatchObject({ waterbody: null, waterbody_rule: 'waterbody_too_far' });
    expect(s.waterbody_distance_m).toBeGreaterThan(500);
  });

  it('refuses the Waddenzee by name outside its bbox (the Markermeer lies south of it)', SLOW, () => {
    expect(() => placeOne(planted('nl.t.1', { water_name: 'Waddenzee' }))).toThrowError(
      expect.objectContaining({ code: 'waterbody_outside_bbox' }),
    );
  });
});

describe('the lakes of the P15 inventory (C2)', () => {
  // The issue's list: id -> [name_nl, name_en], reviewed (the Wikidata labels where they fit).
  const LAKES: Record<string, [string, string]> = {
    ijsselmeer: ['IJsselmeer', 'IJsselmeer'],
    markermeer: ['Markermeer', 'Markermeer'],
    ketelmeer: ['Ketelmeer', 'Ketelmeer'],
    'zwarte-meer': ['Zwarte Meer', 'Zwarte Meer'],
    vossemeer: ['Vossemeer', 'Vossemeer'],
    drontermeer: ['Drontermeer', 'Drontermeer'],
    veluwemeer: ['Veluwemeer', 'Veluwemeer'],
    wolderwijd: ['Wolderwijd', 'Wolderwijd'],
    nuldernauw: ['Nuldernauw', 'Nuldernauw'],
    nijkerkernauw: ['Nijkerkernauw', 'Nijkerkernauw'],
    eemmeer: ['Eemmeer', 'Eemmeer'],
    gooimeer: ['Gooimeer', 'Gooimeer'],
    volkerak: ['Volkerak', 'Volkerak'],
    zoommeer: ['Zoommeer', 'Zoommeer'],
    grevelingenmeer: ['Grevelingenmeer', 'Lake Grevelingen'],
    'veerse-meer': ['Veerse Meer', 'Veerse Meer'],
    haringvliet: ['Haringvliet', 'Haringvliet'],
  };

  it('has each as a lake or closed estuary with an OSM object, reviewed names and a polygon in the export', () => {
    for (const [id, [nl, en]] of Object.entries(LAKES)) {
      const b = bodyBy.get(id);
      expect(b, id).toBeDefined();
      expect(['lake', 'closed_estuary'], id).toContain(b?.kind);
      expect(b?.kind === 'closed_estuary', id).toBe(id === 'haringvliet');
      expect(b?.osm, id).not.toBeNull();
      expect([b?.name_nl, b?.name_en], id).toEqual([nl, en]);
      const area = bodies.areas.get(id);
      expect(area?.polygons.length ?? 0, `${id} polygon`).toBeGreaterThan(0);
      expect(area?.polygons[0]?.[0]?.length ?? 0, `${id} outer ring`).toBeGreaterThanOrEqual(4);
    }
  });

  it('has an OSM object for every lake and closed estuary, and none for a sea or open estuary', () => {
    for (const b of bodies.file.waterbodies) {
      const polygon = b.kind === 'lake' || b.kind === 'closed_estuary';
      if (polygon) expect(b.osm, b.id).not.toBeNull();
      else expect(b.point, `${b.id} is point-only`).toBeDefined();
    }
    // The 23 bodies: 18 with a polygon, 5 point-only (the sea and the open estuaries).
    expect(bodies.file.waterbodies.filter((b) => b.osm !== null)).toHaveLength(18);
    expect(bodies.areas.size).toBe(18);
  });

  it('puts every TABLE lake station in a lake or closed-estuary body, bar the listed exceptions', SLOW, () => {
    const EXCEPT = new Set([
      'nl.rws.lelystad.houtribsluis.noord',
      'nl.rws.lelystad.houtribsluis.zuid',
      'nl.rws.nieuwvossemeer',
      'nl.rws.dronten.reevesluis.vossemeer',
      'nl.rws.elburg.elburgerbrug',
    ]);
    const lakeStations = nl1.filter((s) => typeOf(s.id) === 'lake' && !EXCEPT.has(s.id));
    expect(lakeStations.length).toBeGreaterThan(25);
    for (const s of lakeStations) {
      const kind = bodyBy.get(s.waterbody as string)?.kind;
      expect(['lake', 'closed_estuary'], `${s.id} -> ${s.waterbody}`).toContain(kind);
    }
  });

  it('lists every body in reaches-<ver>.json with its public stations sorted and no D27 gauge (D-2)', SLOW, () => {
    const file = reachesFile(placed, rivers, VERSION, osm);
    expect(file.schema_version).toBe(2);
    expect(file.waterbodies?.map((w) => w.id)).toEqual([...bodyBy.keys()].sort());
    for (const w of file.waterbodies ?? []) {
      const want = placed.stations
        .filter((s) => s.public && s.waterbody === w.id)
        .map((s) => s.id)
        .sort();
      expect(w.stations, w.id).toEqual(want);
      expect(w.reference_station_id, w.id).toBeNull();
    }
    expect(file.mouths).toHaveLength(6);
    expect(file.mouths).toEqual(
      (rivers.mouths ?? [])
        .map((m) => ({ id: m.id, river_id: m.river, waterbody_id: m.waterbody }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it('flags every reach of a tidal-zone river tidal in the reaches file (P17a)', SLOW, () => {
    const zone = new Set(rivers.rivers.filter((r) => r.tidal_zone).map((r) => r.id));
    const reaches = reachesFile(placed, rivers, VERSION, osm).reaches.filter((r) => zone.has(r.river_id));
    expect(reaches.length).toBeGreaterThan(5);
    expect(reaches.filter((r) => !r.flags.tidal).map((r) => r.id)).toEqual([]);
  });
});

describe('determinism with the stations and the water bodies shuffled', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'waterbody-snap-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const write = (name: string, p: typeof placed) => {
    const dir = join(tmp, name);
    writeOutputs(dir, p, rivers, VERSION, osm);
    return dir;
  };
  const shuffled = <T>(a: readonly T[]): T[] => {
    // a fixed permutation: every 7th element first, then the rest reversed
    const head = a.filter((_, i) => i % 7 === 0);
    return [...head, ...a.filter((_, i) => i % 7 !== 0).reverse()];
  };
  const shuffledBodies: WaterbodyInput = {
    file: { ...bodies.file, waterbodies: shuffled(bodies.file.waterbodies) },
    areas: new Map(shuffled([...bodies.areas.entries()])),
  };

  it('writes the same bytes for every output', SLOW, () => {
    const a = write('a', placed);
    const b = write('b', place(build.edges, rivers, shuffled(stations), overridesFile, null, shuffledBodies));
    const names = ['waterbodies.geojsonseq', 'canals.geojsonseq', `reaches-${VERSION}.json`, 'snap-report.json'];
    for (const n of [...names, `rivers-${VERSION}.geojson.gz`, 'rivers.geojsonseq', 'reach-bins.geojsonseq']) {
      expect(readFileSync(join(b, n)).equals(readFileSync(join(a, n))), n).toBe(true);
    }
    expect(canonicalJson(JSON.parse(readFileSync(join(b, 'snap-report.json'), 'utf8')))).toBe(
      canonicalJson(JSON.parse(readFileSync(join(a, 'snap-report.json'), 'utf8'))),
    );
  });

  it('carries no canary rendering in the new outputs', SLOW, () => {
    const a = write('c', placed);
    for (const n of ['waterbodies.geojsonseq', 'canals.geojsonseq']) {
      const text = readFileSync(join(a, n), 'utf8');
      expect(
        CANARY_RENDERINGS.filter((c) => text.includes(c)),
        n,
      ).toEqual([]);
    }
  });
});
