import { describe, expect, it } from 'vitest';
import { KM_DIRECTIONS, validateRivers } from '../src/index.ts';

// registry/rivers.yaml (P6a): the schema and its cross-checks, on a small in-test document.

type Doc = ReturnType<typeof valid>;
const river = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name_nl: name,
  name_en: name,
  names: {},
  aliases: [],
  osm_relation_id: null as number | null,
  osm_way_name: null as string | null,
  wikidata: 'Q1',
  parent_river_id: null as string | null,
  km_direction: 'downstream',
  evidence: 'test',
  ...over,
});
const valid = () => ({
  version: 1,
  rivers: [
    river('rhine', 'Rijn', {
      names: { 'DE-1': ['RHEIN'], 'CH-1': ['Rhein'] },
      osm_relation_id: 123924,
      wikidata: 'Q584',
    }),
    river('waal', 'Waal', { osm_relation_id: 1, wikidata: 'Q2', parent_river_id: 'rhine' }),
    river('merkske', 'Merkske', { osm_way_name: 'Merkske', wikidata: 'Q3', drop_ways: [{ id: 5, reason: 'x' }] }),
    river('ems', 'Eems', { osm_relation_id: 2, wikidata: 'Q4' }),
    river('dortmund-ems-kanal', 'Dortmund-Ems-Kanal', {
      osm_relation_id: 3,
      wikidata: 'Q5',
      parent_river_id: 'ems',
      km_direction: 'none',
    }),
  ],
  excluded: [{ name: 'Lys', wikidata: 'Q6', reason: 'ambiguous' }],
});
const problems = (d: unknown) => validateRivers(d).problems.join('\n');
const at = (d: Doc, i: number) => d.rivers[i] as Record<string, unknown>;

describe('rivers.yaml schema', () => {
  it('validates the document and has three km directions', () => {
    const r = validateRivers(valid());
    expect(r.problems).toEqual([]);
    expect(r.rivers?.rivers).toHaveLength(5);
    expect(KM_DIRECTIONS).toEqual(['downstream', 'upstream', 'none']);
  });

  it('fails each mutation with its own problem', () => {
    const cases: [string, (d: Doc) => void, RegExp][] = [
      ['empty name_nl', (d) => (at(d, 0).name_nl = ''), /name_nl/],
      ['leading space', (d) => (at(d, 0).name_en = ' Rhine'), /name_en[\s\S]*whitespace|whitespace[\s\S]*name_en/],
      ['markup', (d) => (at(d, 0).name_en = '<b>Rhine'), /< or >/],
      ['zero-width space', (d) => (at(d, 0).name_en = 'Rh​ine'), /control or format/],
      ['bad slug', (d) => (at(d, 0).id = 'Rhine!'), /slug/],
      ['duplicate id', (d) => (at(d, 1).id = 'rhine'), /rhine: duplicate id rhine/],
      ['duplicate relation', (d) => (at(d, 1).osm_relation_id = 123924), /waal: duplicate osm_relation_id 123924/],
      ['duplicate wikidata', (d) => (at(d, 1).wikidata = 'Q584'), /waal: duplicate wikidata Q584/],
      ['both selectors', (d) => (at(d, 0).osm_way_name = 'Rhein'), /rhine: exactly one of/],
      ['no selector', (d) => (at(d, 0).osm_relation_id = null), /rhine: exactly one of/],
      ['unknown parent', (d) => (at(d, 1).parent_river_id = 'nowhere'), /waal: unknown parent_river_id nowhere/],
      ['parent cycle', (d) => (at(d, 0).parent_river_id = 'waal'), /parent cycle: (rhine -> waal|waal -> rhine)/],
      ['unknown key', (d) => (at(d, 0).extra = 1), /extra/],
      ['bad Qid', (d) => (at(d, 0).wikidata = 'Q0'), /Q-id/],
      ['bad km_direction', (d) => (at(d, 0).km_direction = 'sideways'), /km_direction/],
      [
        'excluded equals a river',
        (d) => (d.excluded[0] = { name: 'Waal', wikidata: 'Q9', reason: 'x' }),
        /excluded: "Waal"/,
      ],
      ['bad names key', (d) => (at(d, 0).names = { Rhein: ['RHEIN'] }), /Invalid key in record[\s\S]*names.Rhein/],
      ['duplicate spelling', (d) => (at(d, 0).names = { 'DE-1': ['A', 'A'] }), /rhine: names.DE-1 has a duplicate/],
      [
        'duplicate drop way',
        (d) =>
          (at(d, 2).drop_ways = [
            { id: 5, reason: 'a' },
            { id: 5, reason: 'b' },
          ]),
        /merkske: duplicate drop_ways id 5/,
      ],
    ];
    for (const [label, mutate, want] of cases) {
      const d = valid();
      mutate(d);
      expect(problems(d), label).toMatch(want);
    }
  });
});
