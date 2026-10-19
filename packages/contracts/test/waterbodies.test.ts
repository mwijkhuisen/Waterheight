import { describe, expect, it } from 'vitest';
import { validateWaterbodies } from '../src/index.ts';

// registry/waterbodies.yaml (P17b): the schema and its cross-checks, on a small in-test document.

const body = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'lake',
  name_nl: id,
  name_en: id,
  wikidata: 'Q100',
  osm: { type: 'relation', id: 1 } as { type: string; id: number } | null,
  names: { 'NL-1': [id] } as Record<string, string[]>,
  managed_level: true,
  outflows: [] as { to: string; via: string }[],
  reference_station: null as string | null,
  evidence: ['https://www.openstreetmap.org/relation/1'],
  ...over,
});
const valid = () => ({
  version: 1,
  waterbodies: [
    body('ijsselmeer', { outflows: [{ to: 'waddenzee', via: 'Afsluitdijk' }] }),
    body('waddenzee', {
      kind: 'sea',
      wikidata: 'Q101',
      osm: null,
      point: [5.4, 53.2],
      bbox: [4.5, 52.8, 7.2, 53.6],
      managed_level: false,
      names: { 'NL-1': ['Waddenzee'] },
    }),
  ],
});
type Doc = ReturnType<typeof valid>;
const at = (d: Doc, i: number) => d.waterbodies[i] as Record<string, unknown>;
const mouths = { mouths: [{ id: 'rhine-mouth', waterbody: 'waddenzee' }] } as never;
const problems = (d: unknown, rivers: unknown = null) => validateWaterbodies(d, rivers as never).problems.join('\n');

describe('waterbodies.yaml', () => {
  it('validates a polygon lake and a point-only sea, with the mouths of rivers.yaml', () => {
    const r = validateWaterbodies(valid(), mouths);
    expect(r.problems).toEqual([]);
    expect(r.waterbodies?.waterbodies).toHaveLength(2);
    expect(problems(valid())).toBe('');
  });

  it('fails each cross-check with its own problem', () => {
    const cases: [string, (d: Doc) => void, RegExp, unknown?][] = [
      ['duplicate id', (d) => (at(d, 1).id = 'ijsselmeer'), /ijsselmeer: duplicate id/],
      ['duplicate wikidata', (d) => (at(d, 1).wikidata = 'Q100'), /waddenzee: duplicate wikidata Q100/],
      [
        'duplicate osm object',
        (d) => Object.assign(at(d, 1), { osm: { type: 'relation', id: 1 }, point: undefined, bbox: undefined }),
        /waddenzee: duplicate osm r1/,
      ],
      [
        'one (source, name) in two bodies',
        (d) => (at(d, 1).names = { 'NL-1': ['ijsselmeer'] }),
        /waddenzee: names\.NL-1 "ijsselmeer" is also ijsselmeer's/,
      ],
      [
        'duplicate spelling',
        (d) => (at(d, 0).names = { 'NL-1': ['IJsselmeer', 'IJsselmeer'] }),
        /ijsselmeer: names\.NL-1 has a duplicate spelling/,
      ],
      [
        'outflow to itself',
        (d) => (at(d, 0).outflows = [{ to: 'ijsselmeer', via: 'x' }]),
        /ijsselmeer: outflow to itself/,
      ],
      [
        'outflow to unknown',
        (d) => (at(d, 0).outflows = [{ to: 'nowhere', via: 'x' }]),
        /ijsselmeer: outflow to unknown nowhere/,
      ],
      [
        'osm null without point and bbox',
        (d) => Object.assign(at(d, 1), { point: undefined, bbox: undefined }),
        /waddenzee: osm null exactly when point and bbox are given/,
      ],
      [
        'osm set with a point',
        (d) => (at(d, 0).point = [5, 52]),
        /ijsselmeer: (osm null exactly when|a polygon body has no point or bbox)/,
      ],
      [
        'osm set with point and bbox',
        (d) => Object.assign(at(d, 0), { point: [5, 52], bbox: [4, 51, 6, 53] }),
        /ijsselmeer: a polygon body has no point or bbox/,
      ],
      [
        'bbox not [w, s, e, n]',
        (d) => (at(d, 1).bbox = [7.2, 52.8, 4.5, 53.6]),
        /waddenzee: bbox is not \[west, south, east, north\]/,
      ],
      ['point outside its bbox', (d) => (at(d, 1).point = [9, 53.2]), /waddenzee: point outside its bbox/],
      [
        'a mouth naming an unknown body',
        () => undefined,
        /mouths rhine-mouth: unknown waterbody waddenzee/,
        { mouths: [{ id: 'rhine-mouth', waterbody: 'waddenzee' }], drop: 'waddenzee' },
      ],
    ];
    for (const [name, mutate, re, extra] of cases) {
      const d = valid();
      mutate(d);
      let rivers: unknown = null;
      if (extra !== undefined) {
        d.waterbodies = d.waterbodies.filter((w) => w.id !== (extra as { drop: string }).drop);
        at(d, 0).outflows = [];
        rivers = { mouths: (extra as { mouths: unknown }).mouths };
      }
      const r = validateWaterbodies(d, rivers as never);
      expect(r.problems.join('\n'), name).toMatch(re);
      expect(r.waterbodies, name).toBeUndefined();
    }
  });

  it('fails each schema rule', () => {
    const cases: [string, (d: Doc) => void, RegExp][] = [
      ['unknown key', (d) => (at(d, 0).extra = 1), /extra/],
      ['markup in a name', (d) => (at(d, 0).name_nl = '<b>x'), /< or >/],
      ['zero-width space in a name', (d) => (at(d, 0).name_en = 'IJssel​meer'), /control or format/],
      ['leading space', (d) => (at(d, 0).name_nl = ' x'), /whitespace/],
      ['http evidence', (d) => (at(d, 0).evidence = ['http://example.org/x']), /evidence/],
      ['empty evidence', (d) => (at(d, 0).evidence = []), /evidence/],
      ['bad Q-id', (d) => (at(d, 0).wikidata = 'Q0'), /Q-id/],
      ['reference_station not a station id', (d) => (at(d, 0).reference_station = 'Lobith'), /station id/],
      ['unknown kind', (d) => (at(d, 0).kind = 'pond'), /kind/],
      ['bad source id in names', (d) => (at(d, 0).names = { nl1: ['x'] }), /Invalid key/],
      ['empty spelling list', (d) => (at(d, 0).names = { 'NL-1': [] }), /names/],
    ];
    for (const [name, mutate, re] of cases) {
      const d = valid();
      mutate(d);
      expect(problems(d), name).toMatch(re);
    }
    expect(problems({ version: 2, waterbodies: valid().waterbodies })).not.toBe('');
    expect(problems({ version: 1, waterbodies: [] })).not.toBe('');
  });

  it('accepts a null or a station reference gauge', () => {
    const d = valid();
    at(d, 0).reference_station = 'nl.rws.markermeer.midden';
    expect(problems(d)).toBe('');
  });
});
