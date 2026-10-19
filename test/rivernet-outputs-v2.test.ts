import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkReaches,
  ODBL_LICENCE,
  ODBL_URL,
  OSM_ATTRIBUTION,
  OSM_ATTRIBUTION_URL,
  ReachesFile,
} from '../packages/contracts/src/reaches.ts';
import type { RiversFile } from '../packages/contracts/src/rivers.ts';
import type { WaterbodiesFile, Waterbody } from '../packages/contracts/src/waterbodies.ts';
import { BuildError, canonicalJson, type Edge } from '../tools/geo/rivernet/build.ts';
import type { LonLat } from '../tools/geo/rivernet/network.ts';
import { downloadText, LICENCE_NOTE, reachesFile, snapReport, writeOutputs } from '../tools/geo/rivernet/outputs.ts';
import { type Placed, type PlacedStation, place } from '../tools/geo/rivernet/place.ts';
import type { WaterbodyInput } from '../tools/geo/rivernet/waterbodies.ts';
import { chain, chainNode, edge, overrides, river, riversFile, station } from './rivernet-synth.ts';

// P17b: the reaches file v2 (water bodies, mouths), the tile inputs `waterbodies` and `canals`, the download's extra
// features and the snap report's water-body fields, on a synthetic graph. The station fields that B3's placement
// fills are set here by hand, so these tests hold the writer only.

const VERSION = '20261117';
const OSM = '2026-10-17T20:20:51Z';
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof BuildError ? `${e.code} ${e.ids.join(',')}` : `other:${String(e)}`;
  }
  return undefined;
};

const square = (x: number, y: number, d = 0.1): LonLat[] => [
  [x, y],
  [x + d, y],
  [x + d, y + d],
  [x, y + d],
  [x, y],
];
const body = (id: string, extra: Partial<Waterbody> = {}): Waterbody => ({
  id,
  kind: 'lake',
  name_nl: `${id} nl`,
  name_en: `${id} en`,
  wikidata: 'Q1',
  osm: { type: 'relation', id: 945096 },
  names: {},
  managed_level: true,
  outflows: [],
  reference_station: null,
  evidence: ['https://example.org/e'],
  ...extra,
});
const bodies = (...waterbodies: Waterbody[]): WaterbodiesFile => ({ version: 1, waterbodies });
const input = (file: WaterbodiesFile): WaterbodyInput => ({
  file,
  areas: new Map(
    file.waterbodies
      .filter((w) => w.osm !== null)
      .map((w) => [w.id, { id: w.id, polygons: [[square(5.2, 51.2, 0.05), square(5.21, 51.21, 0.01)]] }]),
  ),
});
// zee comes first in the file: every list is sorted by id.
const FILE = bodies(
  body('zee', { kind: 'sea', osm: null, point: [4, 52.5], bbox: [3, 52, 5, 53], managed_level: false }),
  body('meer', { outflows: [{ to: 'zee', via: 'Afsluitdijk' }] }),
);

const rivers: RiversFile = {
  ...riversFile([river({ id: 'alpha' }), river({ id: 'kanaal', kind: 'canal', name_nl: 'Kanaal', name_en: 'Canal' })]),
  mouths: [{ id: 'alpha-zee', river: 'alpha', at: chainNode(3), max_m: 100, waterbody: 'zee', evidence: 'synthetic' }],
};
const canal = (id: string, from: string, to: string, coords: LonLat[]): Edge => ({
  ...edge(id, from, to, ['kanaal'], coords),
  direction: 'none',
  direction_reason: 'canal',
});
const EDGES: Edge[] = [
  ...chain('a', 3, ['alpha']),
  // in reverse id order: the layer sorts by edge id
  canal('k2', 'kn1', 'kn2', [
    [5.04, 51.02],
    [5.06, 51.03],
  ]),
  canal('k1', 'an1', 'kn1', [chainNode(1), [5.04, 51.02]]),
];
const STATIONS = [
  station('de.t.up', [chainNode(0)[0] + 0.01, 51], { river_hint: 'alpha' }),
  station('nl.t.lake2', [5.22, 51.22]),
  station('nl.t.lake1', [5.23, 51.23]),
  station('nl.t.canal', [5.05, 51.025]),
  station('be.spw.secret', [5.24, 51.24], { source: 'BE-3', audience: 'owner', public: false }),
];
// What B3's placement would set.
const ASSIGN: Record<string, Partial<PlacedStation>> = {
  'nl.t.lake1': { waterbody: 'meer', waterbody_rule: 'waterbody_contains', waterbody_distance_m: 0 },
  'nl.t.lake2': { waterbody: 'meer', waterbody_rule: 'waterbody_shore', waterbody_distance_m: 120 },
  'nl.t.canal': { rule: 'canal_edge', canal: 'kanaal', canal_distance_m: 12.5 },
  'be.spw.secret': { waterbody: 'meer', waterbody_rule: 'waterbody_contains', waterbody_distance_m: 0 },
};
function placed(file: WaterbodiesFile | null = FILE, stations = STATIONS): Placed {
  const p = place(EDGES, rivers, stations, overrides());
  return {
    ...p,
    waterbodies: file === null ? null : input(file),
    stations: p.stations.map((s) => ({ ...s, ...ASSIGN[s.id] })),
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'rivernet-outputs-v2-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
const outputs = (p: Placed) => {
  const dir = join(tmp, `o${++serial}`);
  writeOutputs(dir, p, rivers, VERSION, OSM);
  return dir;
};
const lines = (text: string) =>
  text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { geometry: { type: string; coordinates: unknown }; properties: object });

describe('reaches file v2', () => {
  const f = reachesFile(placed(), rivers, VERSION, OSM);

  it('parses with the contract, checks clean and is schema 2', () => {
    expect(ReachesFile.parse(JSON.parse(canonicalJson(f)))).toEqual(f);
    expect(checkReaches(f)).toEqual([]);
    expect(f.schema_version).toBe(2);
  });

  it('lists every body sorted, with its public stations sorted, its reference and outflows, and the mouths', () => {
    expect(f.waterbodies).toEqual([
      {
        id: 'meer',
        kind: 'lake',
        name_nl: 'meer nl',
        name_en: 'meer en',
        stations: ['nl.t.lake1', 'nl.t.lake2'],
        reference_station_id: null,
        outflows: [{ to: 'zee', via: 'Afsluitdijk' }],
      },
      {
        id: 'zee',
        kind: 'sea',
        name_nl: 'zee nl',
        name_en: 'zee en',
        stations: [],
        reference_station_id: null,
        outflows: [],
      },
    ]);
    expect(f.mouths).toEqual([{ id: 'alpha-zee', river_id: 'alpha', waterbody_id: 'zee' }]);
  });

  it('keeps lake and canal stations out of stations[] and canals out of rivers[]', () => {
    expect(f.stations.map((s) => s.id)).toEqual(['de.t.up']);
    expect(f.rivers.map((r) => r.id)).toEqual(['alpha']);
    expect(f.reaches.every((r) => r.river_id === 'alpha')).toBe(true);
  });

  it('takes a public reference station, and refuses one that is not public or not placed', () => {
    const ref = (id: string) => bodies(FILE.waterbodies[0] as Waterbody, body('meer', { reference_station: id }));
    expect(reachesFile(placed(ref('nl.t.lake1')), rivers, VERSION, OSM).waterbodies?.[0]?.reference_station_id).toBe(
      'nl.t.lake1',
    );
    expect(code(() => reachesFile(placed(ref('be.spw.secret')), rivers, VERSION, OSM))).toBe(
      'reference_station_not_public meer',
    );
    expect(code(() => reachesFile(placed(ref('nl.t.nowhere')), rivers, VERSION, OSM))).toBe(
      'reference_station_not_public meer',
    );
  });

  it('fails closed without water bodies (waterbodies_missing), in every writer that needs them', () => {
    const none = placed(null);
    expect(code(() => reachesFile(none, rivers, VERSION, OSM))).toBe('waterbodies_missing ');
    expect(code(() => downloadText(none, rivers, VERSION, OSM))).toBe('waterbodies_missing ');
    expect(code(() => writeOutputs(join(tmp, 'none'), none, rivers, VERSION, OSM))).toBe('waterbodies_missing ');
  });
});

describe('tile inputs and download', () => {
  const p = placed();
  const dir = outputs(p);
  const read = (n: string) => readFileSync(join(dir, n), 'utf8');

  it('writes one waterbodies feature per body: the polygon or the point, four properties, no station', () => {
    const w = lines(read('waterbodies.geojsonseq'));
    expect(w.map((x) => [x.geometry.type, x.properties])).toEqual([
      ['MultiPolygon', { waterbody_id: 'meer', kind: 'lake', name_nl: 'meer nl', name_en: 'meer en' }],
      ['Point', { waterbody_id: 'zee', kind: 'sea', name_nl: 'zee nl', name_en: 'zee en' }],
    ]);
    expect(w[0]?.geometry.coordinates).toEqual(p.waterbodies?.areas.get('meer')?.polygons);
    expect(w[1]?.geometry.coordinates).toEqual([4, 52.5]);
  });

  it('writes one canals line per canal edge, sorted, named after its canal, no station and no edge id', () => {
    const text = read('canals.geojsonseq');
    const c = lines(text);
    expect(c.map((x) => [x.geometry.type, x.properties])).toEqual([
      ['LineString', { river_id: 'kanaal', name_nl: 'Kanaal', name_en: 'Canal', kind: 'canal' }],
      ['LineString', { river_id: 'kanaal', name_nl: 'Kanaal', name_en: 'Canal', kind: 'canal' }],
    ]);
    expect(c.map((x) => x.geometry.coordinates)).toEqual([EDGES[4]?.coords, EDGES[3]?.coords]);
    expect(text).not.toMatch(/"k[12]"/);
    // no canal in the `rivers` layer
    expect(read('rivers.geojsonseq')).not.toContain('kanaal');
  });

  it('refuses a canal edge that names no canal', () => {
    const bad = { ...p, canalEdges: [{ ...(EDGES[3] as Edge), rivers: ['alpha'] }] };
    expect(code(() => writeOutputs(join(tmp, 'bad'), bad, rivers, VERSION, OSM))).toBe('canal_edge_without_canal k2');
  });

  it('keeps the download head, then the reach lines unchanged, then the bodies and the canals with `layer`', () => {
    const text = gunzipSync(readFileSync(join(dir, `rivers-${VERSION}.geojson.gz`))).toString('utf8');
    expect(downloadText(p, rivers, VERSION, OSM)).toBe(text);
    const head = JSON.stringify({
      type: 'FeatureCollection',
      name: `rivers-${VERSION}`,
      attribution: OSM_ATTRIBUTION,
      attribution_url: OSM_ATTRIBUTION_URL,
      licence: ODBL_LICENCE,
      licence_url: ODBL_URL,
      licence_note: LICENCE_NOTE,
      version: VERSION,
      osm_replication_timestamp: OSM,
    }).slice(0, -1);
    expect(text.startsWith(`${head},"features":[\n`)).toBe(true);
    const reachLines = read('rivers.geojsonseq').split('\n').slice(0, -1);
    const body = text.slice(`${head},"features":[\n`.length, -'\n]}\n'.length).split(',\n');
    expect(body.slice(0, reachLines.length)).toEqual(reachLines);
    const extra = body.slice(reachLines.length).map((l) => JSON.parse(l) as { properties: Record<string, unknown> });
    expect(extra.map((f) => [f.properties.layer, f.properties.waterbody_id ?? f.properties.river_id])).toEqual([
      ['waterbody', 'meer'],
      ['waterbody', 'zee'],
      ['canal', 'kanaal'],
      ['canal', 'kanaal'],
    ]);
    const doc = JSON.parse(text) as { features: unknown[] };
    expect(doc.features).toHaveLength(reachLines.length + 4);
  });

  it('writes the same bytes twice, and from the stations in reverse order', () => {
    const a = outputs(p);
    const b = outputs(placed(FILE, [...STATIONS].reverse()));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(
      [
        `reaches-${VERSION}.json`,
        `rivers-${VERSION}.geojson.gz`,
        'canals.geojsonseq',
        'reach-bins.geojsonseq',
        'rivers.geojsonseq',
        'snap-report.json',
        'VERSION',
        'waterbodies.geojsonseq',
      ].sort(),
    );
    for (const n of names) {
      expect(readFileSync(join(a, n)).equals(readFileSync(join(dir, n))), `${n} twice`).toBe(true);
      expect(readFileSync(join(b, n)).equals(readFileSync(join(dir, n))), `${n} reversed`).toBe(true);
    }
  });
});

describe('snap report and audience', () => {
  it('carries the canal and water-body fields of each public station and counts the water-body rules', () => {
    const r = JSON.parse(snapReport(placed(), VERSION, OSM)) as {
      counts: Record<string, Record<string, number>>;
      waterbody_counts: Record<string, Record<string, number>>;
      stations: Record<string, unknown>[];
    };
    expect(r.waterbody_counts).toEqual({
      public: { waterbody_contains: 1, waterbody_shore: 1 },
      public_not_shown: {},
    });
    expect(Object.keys(r.counts)).toEqual(['public', 'public_not_shown']);
    const by = new Map(r.stations.map((s) => [s.id, s]));
    expect(by.get('nl.t.lake2')).toMatchObject({ waterbody: 'meer', waterbody_rule: 'waterbody_shore', canal: null });
    expect(by.get('nl.t.canal')).toMatchObject({
      rule: 'canal_edge',
      canal: 'kanaal',
      canal_distance_m: 12.5,
      waterbody: null,
      waterbody_rule: null,
      river_id: null,
    });
  });

  it('puts the owner station in a lake in no output at all', () => {
    const p = placed();
    expect(p.stations.find((s) => s.id === 'be.spw.secret')).toMatchObject({ public: false, waterbody: 'meer' });
    const dir = outputs(p);
    for (const n of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, n));
      const text = (n.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
      expect(text, n).not.toContain('be.spw.secret');
      expect(text, n).not.toContain('BE-3');
    }
    // and the public bytes do not depend on it
    const without = outputs(
      placed(
        FILE,
        STATIONS.filter((s) => s.audience === 'public'),
      ),
    );
    for (const n of readdirSync(dir))
      expect(readFileSync(join(without, n)).equals(readFileSync(join(dir, n))), n).toBe(true);
  });
});
