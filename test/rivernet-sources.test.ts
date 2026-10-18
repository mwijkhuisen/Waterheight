import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { ROOT, readSources, selection } from '../tools/geo/rivernet/sources.ts';

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
