import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateRivers } from '../packages/contracts/src/rivers.ts';
import { repoRoot } from './catalogue.ts';

// registry/rivers.yaml (P6a) against the rest of the registry and the catalogue:
// the §5.3 relation IDs exactly, the reviewed NL/EN names, the §0.6 and D21 rivers,
// and provider spellings that really occur in the station registry.

const read = (path: string) => parse(readFileSync(`${repoRoot}${path}`, 'utf8'));
const { problems, rivers } = validateRivers(read('registry/rivers.yaml'));
const byId = new Map((rivers?.rivers ?? []).map((r) => [r.id, r]));
// An excluded name compares as a slug: lower case, no diacritics ("Prüm" is prum).
const slug = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll(' ', '-');
const excluded = (rivers?.excluded ?? []).map((e) => slug(e.name));

const stations: { source: string; water_name: string | null; river: string | null }[] = readdirSync(
  `${repoRoot}registry/stations`,
)
  .filter((f) => f.endsWith('.yaml'))
  .flatMap((f) => read(`registry/stations/${f}`).stations);
const sources: { id: string; audience: string }[] = read('registry/sources.yaml').sources;

describe('registry/rivers.yaml', () => {
  it('validates', () => {
    expect(problems).toEqual([]);
  });

  it('carries the catalogue §5.3 relation IDs exactly', () => {
    const catalogue = {
      rhine: 123924,
      meuse: 1075197,
      scheldt: 324288,
      moselle: 390416,
      ems: 370068,
      main: 412876,
      neckar: 123881,
      sambre: 1600647,
      ourthe: 2246211,
      rur: 384594,
      lahn: 412935,
      saar: 390393,
      sieg: 409090,
      ruhr: 364754,
      lippe: 379691,
    };
    for (const [id, relation] of Object.entries(catalogue)) expect(byId.get(id)?.osm_relation_id, id).toBe(relation);
  });

  it('has the reviewed names of the catalogue gap item 19 examples', () => {
    const reviewed: [string, string, string][] = [
      ['meuse', 'Maas', 'Meuse'],
      ['moselle', 'Moezel', 'Moselle'],
      ['sauer', 'Sûre', 'Sauer'],
      ['scheldt', 'Schelde', 'Scheldt'],
      ['lys', 'Leie', 'Lys'],
      ['rhine', 'Rijn', 'Rhine'],
    ];
    for (const [id, nl, en] of reviewed) expect([byId.get(id)?.name_nl, byId.get(id)?.name_en], id).toEqual([nl, en]);
  });

  it('resolves the Nahe and the Lys to the candidates that flow into the Rhine and the Scheldt', () => {
    expect(byId.get('nahe')).toMatchObject({ wikidata: 'Q168696', parent_river_id: 'rhine' });
    expect(byId.get('lys')).toMatchObject({ wikidata: 'Q208493', parent_river_id: 'scheldt' });
  });

  it('has the Dutch branches, the §0.6 rivers and the D21 rivers, or lists them as excluded with a reason', () => {
    const required = [
      ['bovenrijn', 'waal', 'pannerdensch-kanaal', 'nederrijn', 'lek', 'ijssel'],
      ['semois', 'chiers', 'ton', 'viroin', 'houille', 'thure', 'hante', 'trouille'],
      ['mark', 'dommel', 'aa-of-weerijs', 'tongelreep', 'keersop', 'merkske', 'voer', 'ahr', 'kyll', 'prum'],
    ].flat();
    const missing = required.filter((id) => !byId.has(id) && !excluded.includes(id));
    expect(missing).toEqual([]);
  });

  it('knows every river slug that the station registry already uses', () => {
    const slugs = [...new Set(stations.map((s) => s.river).filter((r) => r !== null))].sort();
    expect(slugs.filter((s) => !byId.has(s as string))).toEqual([]);
  });

  it('takes provider spellings only from public sources, verbatim as the station registry has them', () => {
    const publicSources = new Set(sources.filter((s) => s.audience === 'public').map((s) => s.id));
    const spellings = new Map<string, Set<string>>();
    for (const s of stations) {
      if (s.water_name !== null) spellings.set(s.source, (spellings.get(s.source) ?? new Set()).add(s.water_name));
    }
    const wrong: string[] = [];
    for (const r of rivers?.rivers ?? []) {
      for (const [source, names] of Object.entries(r.names)) {
        if (!publicSources.has(source)) wrong.push(`${r.id}: ${source} is not a public source`);
        for (const n of names) if (!spellings.get(source)?.has(n)) wrong.push(`${r.id}: ${source} has no "${n}"`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives every river a parent chain that ends in a river flowing into the sea or a lake', () => {
    for (const r of rivers?.rivers ?? []) {
      let at = r;
      for (let i = 0; i < 20 && at.parent_river_id !== null; i++) at = byId.get(at.parent_river_id) ?? at;
      expect(at.parent_river_id, r.id).toBeNull();
    }
  });
});
