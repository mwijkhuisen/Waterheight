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

  it('has the reviewed root rivers only, and every parent exists', () => {
    // A root reaches the sea, a lake or a river outside the scope: the Rhine, the Meuse and the Scheldt the North
    // Sea, the Ems the Dollart, the Vechte the Zwarte Water and the Mark the Dintel (their P403 in `evidence`).
    // P17a: the Vechte now flows into the Zwarte Water (root: Zwarte Meer); canals are listed apart.
    const roots = (rivers?.rivers ?? []).filter((r) => r.parent_river_id === null);
    expect(
      roots
        .filter((r) => r.kind !== 'canal')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['ems', 'mark', 'meuse', 'rhine', 'scheldt', 'zwarte-water']);
    expect(
      roots
        .filter((r) => r.kind === 'canal')
        .map((r) => r.id)
        .sort(),
    ).toEqual([
      'eemskanaal',
      'eindhovensch-kanaal',
      'julianakanaal',
      'kanaal-gent-terneuzen',
      'kanaal-wessem-nederweert',
      'maas-waalkanaal',
      'noordzeekanaal',
      'reitdiep',
      'schelde-rijnkanaal',
      'zwolle-ijsselkanaal',
    ]);
    expect(byId.get('vechte')?.parent_river_id).toBe('zwarte-water');
    for (const r of rivers?.rivers ?? []) {
      if (r.parent_river_id !== null) expect(byId.has(r.parent_river_id), r.id).toBe(true);
    }
  });

  describe('the P17a delta channels, Zwarte Water and canals', () => {
    // [id, name_nl, name_en]: the 15 delta channels, Zwarte Water and the 15 canals, reviewed 2026-10-18.
    const reviewed: [string, string, string][] = [
      ['boven-merwede', 'Boven-Merwede', 'Boven-Merwede'],
      ['beneden-merwede', 'Beneden-Merwede', 'Beneden-Merwede'],
      ['nieuwe-merwede', 'Nieuwe Merwede', 'Nieuwe Merwede'],
      ['noord', 'Noord', 'Noord'],
      ['oude-maas', 'Oude Maas', 'Oude Maas'],
      ['nieuwe-maas', 'Nieuwe Maas', 'Nieuwe Maas'],
      ['het-scheur', 'Het Scheur', 'Het Scheur'],
      ['nieuwe-waterweg', 'Nieuwe Waterweg', 'Nieuwe Waterweg'],
      ['hollandse-ijssel', 'Hollandse IJssel', 'Hollandse IJssel'],
      ['dordtsche-kil', 'Dordtsche Kil', 'Dordtsche Kil'],
      ['spui', 'Spui', 'Spui'],
      ['amer', 'Amer', 'Amer'],
      ['bergsche-maas', 'Bergsche Maas', 'Bergsche Maas'],
      ['hollandsch-diep', 'Hollandsch Diep', 'Hollands Diep'],
      ['haringvliet', 'Haringvliet', 'Haringvliet'],
      ['zwarte-water', 'Zwarte Water', 'Zwarte Water'],
      ['noordzeekanaal', 'Noordzeekanaal', 'North Sea Canal'],
      ['amsterdam-rijnkanaal', 'Amsterdam-Rijnkanaal', 'Amsterdam-Rhine Canal'],
      ['maas-waalkanaal', 'Maas-Waalkanaal', 'Maas-Waal Canal'],
      ['julianakanaal', 'Julianakanaal', 'Juliana Canal'],
      ['kanaal-wessem-nederweert', 'Kanaal Wessem-Nederweert', 'Wessem-Nederweert Canal'],
      ['zuid-willemsvaart', 'Zuid-Willemsvaart', 'Zuid-Willemsvaart'],
      ['wilhelminakanaal', 'Wilhelminakanaal', 'Wilhelminakanaal'],
      ['eindhovensch-kanaal', 'Eindhovensch Kanaal', 'Eindhovensch Kanaal'],
      ['twentekanaal', 'Twentekanaal', 'Twentekanaal'],
      ['meppelerdiep', 'Meppelerdiep', 'Meppelerdiep'],
      ['zwolle-ijsselkanaal', 'Zwolle-IJsselkanaal', 'Zwolle-IJsselkanaal'],
      ['eemskanaal', 'Eemskanaal', 'Eemskanaal'],
      ['reitdiep', 'Reitdiep', 'Reitdiep'],
      ['schelde-rijnkanaal', 'Schelde-Rijnkanaal', 'Scheldt-Rhine Canal'],
      ['kanaal-gent-terneuzen', 'Kanaal Gent-Terneuzen', 'Ghent-Terneuzen Canal'],
    ];
    const raw: {
      id: string;
      kind?: string;
      tidal_zone?: boolean;
      osm_relation_id: number | null;
      evidence: string;
      flags?: Record<string, unknown>[];
    }[] = read('registry/rivers.yaml').rivers;

    it('carries `kind` explicitly in the YAML on exactly these rows', () => {
      expect(
        raw
          .filter((r) => r.kind !== undefined)
          .map((r) => r.id)
          .sort(),
      ).toEqual(reviewed.map(([id]) => id).sort());
      expect(raw.filter((r) => r.kind === 'delta_channel')).toHaveLength(15);
      expect(raw.filter((r) => r.kind === 'canal')).toHaveLength(15);
      expect(raw.find((r) => r.id === 'zwarte-water')?.kind).toBe('river');
    });

    it('has the reviewed Dutch and English names', () => {
      for (const [id, nl, en] of reviewed) expect([byId.get(id)?.name_nl, byId.get(id)?.name_en], id).toEqual([nl, en]);
    });

    it('cites its Wikidata P403 mouth, or for a canal without one the two-way P402 relation', () => {
      for (const [id] of reviewed) {
        const row = raw.find((r) => r.id === id);
        const twoWay = row?.kind === 'canal' && /two-way P402/.test(row.evidence);
        if (twoWay) expect(row?.evidence, id).toContain(`two-way P402 ${row?.osm_relation_id}`);
        else expect(row?.evidence, id).toMatch(/P403 Q[0-9]+/);
      }
    });

    it('has tidal_zone on exactly the 14 zone channels, and Het Scheur tidal over its whole length', () => {
      expect(
        raw
          .filter((r) => r.tidal_zone === true)
          .map((r) => r.id)
          .sort(),
      ).toEqual(
        reviewed
          .map(([id]) => id)
          .slice(0, 15)
          .filter((id) => id !== 'het-scheur')
          .sort(),
      );
      const scheur = raw.find((r) => r.id === 'het-scheur');
      expect(scheur?.tidal_zone).toBeUndefined();
      expect(scheur?.flags).toHaveLength(1);
      expect(scheur?.flags?.[0]).toMatchObject({ kind: 'tidal' });
      expect(scheur?.flags?.[0]).not.toHaveProperty('from');
      expect(scheur?.flags?.[0]).not.toHaveProperty('to');
    });
  });
});
