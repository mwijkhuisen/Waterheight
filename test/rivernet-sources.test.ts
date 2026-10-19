import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { validateRivers } from '../packages/contracts/src/rivers.ts';
import { validateWaterbodies, type WaterbodiesFile, type Waterbody } from '../packages/contracts/src/waterbodies.ts';
import { probeNames, ROOT, readSources, selection, waterbodyIds } from '../tools/geo/rivernet/sources.ts';

const IDS = [
  'netherlands',
  'belgium',
  'luxembourg',
  'switzerland',
  'baden-wuerttemberg',
  'bayern',
  'hessen',
  'rheinland-pfalz',
  'saarland',
  'nordrhein-westfalen',
  'niedersachsen',
  'alsace',
  'lorraine',
  'champagne-ardenne',
  'nord-pas-de-calais',
  'picardie',
];
type Doc = {
  geofabrik: { index_url: string; regions: { id: string; url: string }[] };
  canal_traps: unknown[];
  extra?: number;
};
const YAML_PATH = join(ROOT, 'registry/geo-sources.yaml');
const FIXTURE = join(ROOT, 'tools/geo/fixtures/geofabrik/index-v1-nogeom.trimmed.json');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** readSources on the committed file after `edit` changed its parsed form. */
function mutated(edit: (o: Doc) => void) {
  const o = parse(readFileSync(YAML_PATH, 'utf8'));
  edit(o);
  const dir = mkdtempSync(join(tmpdir(), 'rivernet-src-'));
  dirs.push(dir);
  const path = join(dir, 'geo-sources.yaml');
  writeFileSync(path, stringify(o));
  return () => readSources(path);
}

describe('registry/geo-sources.yaml', () => {
  it('validates and holds the 16 regions', () => {
    const s = readSources();
    expect(s.geofabrik.regions.map((r) => r.id)).toEqual(IDS);
    for (const r of s.geofabrik.regions)
      expect(r.url).toMatch(/^https:\/\/download\.geofabrik\.de\/europe\/.*-latest\.osm\.pbf$/);
    expect(s.euhydro.max_minutes).toBe(20);
    expect(s.nrw_stations.url).toBe('https://www.hochwasserportal.nrw/data/internet/stations/stations.json');
  });

  it('names every region url as the index has it', () => {
    const index = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      features: { properties: { id: string; urls: { pbf: string } } }[];
    };
    const pbf = new Map(index.features.map((f) => [f.properties.id, f.properties.urls.pbf]));
    for (const r of readSources().geofabrik.regions) expect(pbf.get(r.id)).toBe(r.url);
  });

  it('refuses http, another host, a duplicate id, an unknown key and an empty canal trap', () => {
    expect(mutated((o) => (o.geofabrik.index_url = 'http://download.geofabrik.de/x.json'))).toThrow();
    expect(
      mutated(
        (o) =>
          ((o.geofabrik.regions[0] as { url: string }).url = 'https://example.org/europe/netherlands-latest.osm.pbf'),
      ),
    ).toThrow();
    expect(mutated((o) => ((o.geofabrik.regions[1] as { id: string }).id = 'netherlands'))).toThrow();
    expect(
      mutated(
        (o) =>
          ((o.geofabrik.regions[0] as { url: string }).url =
            'https://download.geofabrik.de/europe/netherlands.osm.pbf'),
      ),
    ).toThrow();
    expect(mutated((o) => (o.extra = 1))).toThrow();
    expect(
      mutated(
        (o) => ((o as unknown as { nrw_stations: { url: string } }).nrw_stations.url = 'https://example.org/s.json'),
      ),
    ).toThrow();
    expect(
      mutated(
        (o) =>
          ((o as unknown as { nrw_stations: { url: string } }).nrw_stations.url =
            'http://www.hochwasserportal.nrw/s.json'),
      ),
    ).toThrow();
    expect(
      mutated((o) => (o.canal_traps = [{ name: 'X', osm_relation_id: null, wikidata: null, evidence: 'e' }])),
    ).toThrow();
    expect(
      mutated((o) => (o.canal_traps = [{ name: 'X', osm_relation_id: 5, wikidata: null, evidence: 'e' }])),
    ).not.toThrow();
  });
});

describe('selection', () => {
  const river = (id: number | null, way: string | null, q: string) => ({
    osm_relation_id: id,
    osm_way_name: way,
    wikidata: q,
  });
  it('sorts numerically and deduplicates', () => {
    const rivers = {
      rivers: [river(100, null, 'Q1'), river(9, null, 'Q2'), river(null, 'Ahr', 'Q30'), river(null, 'Eifel', 'Q4')],
    };
    const traps = {
      canal_traps: [
        { name: 'a', osm_relation_id: 9, wikidata: null, evidence: 'e' },
        { name: 'b', osm_relation_id: null, wikidata: 'Q4', evidence: 'e' },
        { name: 'c', osm_relation_id: 20, wikidata: 'Q99', evidence: 'e' },
      ],
    };
    expect(selection(rivers, traps)).toEqual({ relations: 'r9\nr20\nr100\n', qids: 'Q4,Q30' });
  });
  it('is empty without selections', () => {
    expect(selection({ rivers: [river(1, null, 'Q1')] }, { canal_traps: [] })).toEqual({ relations: 'r1\n', qids: '' });
  });
});

describe('the water-body selection (P17b)', () => {
  const body = (id: string, osm: Waterbody['osm'], names: Waterbody['names'] = {}): Waterbody => ({
    id,
    kind: 'lake',
    name_nl: `${id} nl`,
    name_en: `${id} en`,
    wikidata: 'Q1',
    osm,
    names,
    managed_level: true,
    outflows: [],
    reference_station: null,
    evidence: ['https://example.org/e'],
  });
  const file = (...waterbodies: Waterbody[]): WaterbodiesFile => ({ version: 1, waterbodies });

  it('lists the OSM objects, relations first, each by number, and no point-only body', () => {
    const f = file(
      body('a', { type: 'way', id: 30 }),
      body('b', { type: 'relation', id: 200 }),
      body('c', null),
      body('d', { type: 'way', id: 4 }),
      body('e', { type: 'relation', id: 9 }),
    );
    expect(waterbodyIds(f)).toBe('r9\nr200\nw4\nw30\n');
    expect(waterbodyIds(file(body('c', null)))).toBe('');
  });

  it('names every name_nl and published spelling once, sorted', () => {
    const f = file(
      body('a', null, { 'NL-1': ['Markermeer', 'IJmeer'], 'NL-2': ['Markermeer'] }),
      body('b', null, { 'NL-1': ['Rivière'] }),
    );
    expect(probeNames(f)).toBe('IJmeer\nMarkermeer\nRivière\na nl\nb nl\n');
  });

  it('gives extract.sh lines its patterns accept from the committed registry/waterbodies.yaml', () => {
    const rivers = validateRivers(parse(readFileSync(join(ROOT, 'registry/rivers.yaml'), 'utf8'))).rivers;
    const { waterbodies } = validateWaterbodies(
      parse(readFileSync(join(ROOT, 'registry/waterbodies.yaml'), 'utf8')),
      rivers ?? null,
    );
    expect(waterbodies).toBeDefined();
    const f = waterbodies as WaterbodiesFile;
    // the shell checks: `^[rw][1-9][0-9]*$` per id line, and per probe name ASCII letters, space, hyphen, apostrophe
    // or a non-ASCII character
    expect(waterbodyIds(f)).toMatch(/^([rw][1-9][0-9]*\n)+$/);
    for (const n of probeNames(f).split('\n').slice(0, -1)) expect(n).toMatch(/^(?:[A-Za-z' -]|\P{ASCII})+$/u);
  });
});
