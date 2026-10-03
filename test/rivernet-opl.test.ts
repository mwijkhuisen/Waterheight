import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InputError } from '../tools/geo/rivernet/geojsonseq.ts';
import { type Member, type OplCaps, parseOplRelations, type Relation } from '../tools/geo/rivernet/opl.ts';

function codeOf(text: string, caps?: Partial<OplCaps>): [string, number] {
  try {
    parseOplRelations(text, caps);
  } catch (e) {
    if (e instanceof InputError) return [e.code, e.line];
    throw e;
  }
  throw new Error('expected an InputError');
}

// Test-only encoder, the libosmium rules: raw inside these ranges, else %hex% (2 digits up to 0xff, else at least 4)
const RAW: [number, number][] = [
  [0x21, 0x24],
  [0x26, 0x2b],
  [0x2d, 0x3c],
  [0x3e, 0x3f],
  [0x41, 0x7e],
  [0xa1, 0xac],
  [0xae, 0x5ff],
];
function esc(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    out += RAW.some(([lo, hi]) => cp >= lo && cp <= hi) ? ch : `%${cp.toString(16).padStart(cp <= 0xff ? 2 : 4, '0')}%`;
  }
  return out;
}
function oplLine(r: Relation): string {
  const t = Object.entries(r.tags)
    .map(([k, v]) => `${esc(k)}=${esc(v)}`)
    .join(',');
  const m = r.members.map((x) => `${x.type}${x.ref}@${esc(x.role)}`).join(',');
  return `r${r.id} T${t} M${m}`;
}

describe('parseOplRelations', () => {
  it('parses realistic osmium lines', () => {
    const text = [
      'r123924 Ttype=waterway,waterway=river,name=Rhein,name:nl=Rijn,wikidata=Q584 Mw74917953@main_stream,w662657942@main_stream,w1@side_stream,n5@spring',
      'r2 T M',
      'r3 Ttype=waterway Mw7@,r9@x',
      '',
    ].join('\n');
    expect(parseOplRelations(text)).toEqual([
      {
        id: 123924,
        tags: { type: 'waterway', waterway: 'river', name: 'Rhein', 'name:nl': 'Rijn', wikidata: 'Q584' },
        members: [
          { type: 'w', ref: 74917953, role: 'main_stream' },
          { type: 'w', ref: 662657942, role: 'main_stream' },
          { type: 'w', ref: 1, role: 'side_stream' },
          { type: 'n', ref: 5, role: 'spring' },
        ],
      },
      { id: 2, tags: {}, members: [] },
      {
        id: 3,
        tags: { type: 'waterway' },
        members: [
          { type: 'w', ref: 7, role: '' },
          { type: 'r', ref: 9, role: 'x' },
        ],
      },
    ]);
  });

  it('decodes escapes; U+00F4 is written raw by libosmium', () => {
    const [r] = parseOplRelations('r1 Tname=Rhône%20%de%20%Rijn,a%2c%b=%2019%x,c%3d%=%40%%25% Mw1@a%20%b');
    expect(r?.tags).toEqual({ name: 'Rhône de Rijn', 'a,b': '’x', 'c=': '@%' });
    expect(r?.members[0]?.role).toBe('a b');
    expect(esc('Rhône ’')).toBe('Rhône%20%%2019%');
  });

  it('decodes a character beyond the BMP', () => {
    expect(parseOplRelations('r1 Tk=%1f30a% M')[0]?.tags).toEqual({ k: '\u{1f30a}' });
  });

  it.each<[string, string, string]>([
    ['not_relation', 'w1 T M', 'not_relation'],
    ['not_relation', 'xyz', 'not_relation'],
    ['bad_field: missing M', 'r1 Ta=b', 'bad_field'],
    ['bad_field: extra field', 'r1 Ta=b M v1', 'bad_field'],
    ['bad_field: order', 'r1 M T', 'bad_field'],
    ['bad_field: raw space in a value', 'r1 Ta=b c M', 'bad_field'],
    ['bad_field: id', 'r0 T M', 'bad_field'],
    ['bad_field: id text', 'r1x T M', 'bad_field'],
    ['bad_field: id over safe', 'r99999999999999999999 T M', 'bad_field'],
    ['bad_field: double space', 'r1  T M', 'bad_field'],
    ['bad_escape: unterminated', 'r1 Ta=b%20 M', 'bad_escape'],
    ['bad_escape: not hex', 'r1 Ta=%zz% M', 'bad_escape'],
    ['bad_escape: empty', 'r1 Ta=%% M', 'bad_escape'],
    ['bad_escape: upper hex', 'r1 Ta=%2C% M', 'bad_escape'],
    ['bad_escape: surrogate', 'r1 Ta=%d800% M', 'bad_escape'],
    ['bad_escape: beyond Unicode', 'r1 Ta=%110000% M', 'bad_escape'],
    ['bad_escape: raw non-ASCII libosmium escapes', 'r1 Ta=’ M', 'bad_escape'],
    ['bad_escape: raw control', 'r1 Ta=\u0001 M', 'bad_escape'],
    ['bad_member: raw @ in a role', 'r1 T Mw1@a@b', 'bad_member'],
    ['bad_escape: raw % in a role', 'r1 T Mw1@a%b', 'bad_escape'],
    ['bad_tag: no =', 'r1 Tabc M', 'bad_tag'],
    ['bad_tag: two =', 'r1 Ta=b=c M', 'bad_tag'],
    ['bad_tag: empty key', 'r1 T=b M', 'bad_tag'],
    ['bad_tag: duplicate key', 'r1 Ta=b,a=c M', 'bad_tag'],
    ['bad_tag: empty item', 'r1 Ta=b, M', 'bad_tag'],
    ['bad_member: type', 'r1 T Mx1@a', 'bad_member'],
    ['bad_member: no @', 'r1 T Mw1', 'bad_member'],
    ['bad_member: ref', 'r1 T Mw@a', 'bad_member'],
    ['bad_member: negative ref', 'r1 T Mw-1@a', 'bad_member'],
    ['bad_member: empty item', 'r1 T Mw1@a,', 'bad_member'],
  ])('%s', (_n, line, code) => {
    expect(codeOf(line)).toEqual([code, 1]);
  });

  it('reports the line number', () => {
    expect(codeOf('r1 T M\n\nr2 T M\nr3 Tx M')).toEqual(['bad_tag', 4]);
  });

  it('duplicate_relation', () => {
    expect(codeOf('r1 T M\nr2 T M\nr1 Ta=b M')).toEqual(['duplicate_relation', 3]);
  });

  it('caps', () => {
    expect(codeOf('r1 Ta=1,b=2,c=3 M', { maxTags: 2 })).toEqual(['too_many_tags', 1]);
    expect(codeOf('r1 T Mw1@,w2@,w3@', { maxMembers: 2 })).toEqual(['too_many_members', 1]);
    expect(codeOf('r1 T M\nr2 T M\nr3 T M', { maxLines: 2 })).toEqual(['too_many_lines', 3]);
    expect(codeOf('r1 T M\n', { maxBytes: 5 })[0]).toBe('input_too_large');
    expect(codeOf(`r1 Ta=${'x'.repeat(256)} M`)).toEqual(['bad_tag', 1]);
    expect(codeOf(`r1 T Mw1@${'x'.repeat(256)}`)).toEqual(['bad_member', 1]);
    expect(parseOplRelations(`r1 Ta=${'x'.repeat(255)} M`, { maxTags: 1 })).toHaveLength(1);
  });

  it('messages never carry input', () => {
    expect(() => parseOplRelations('r1 Tsecret M')).toThrow('bad_tag at line 1');
  });

  it('round trips random relations through the libosmium encoder', () => {
    const uni = fc
      .array(fc.oneof(fc.integer({ min: 0, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff })), {
        maxLength: 10,
      })
      .map((a) => String.fromCodePoint(...a));
    const member: fc.Arbitrary<Member> = fc.record({
      type: fc.constantFrom('n', 'w', 'r'),
      ref: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      role: uni,
    });
    const rel: fc.Arbitrary<Omit<Relation, 'id'>> = fc.record({
      tags: fc.dictionary(
        uni.filter((k) => k !== '' && k !== '__proto__'),
        uni,
        { maxKeys: 6 },
      ),
      members: fc.array(member, { maxLength: 8 }),
    });
    fc.assert(
      fc.property(fc.array(rel, { maxLength: 6 }), (rels) => {
        const all = rels.map((r, i) => ({ id: i + 1, ...r }));
        expect(parseOplRelations(`${all.map(oplLine).join('\n')}\n`)).toEqual(all);
      }),
      { numRuns: 300 },
    );
  });

  it('arbitrary text either parses or throws an InputError', () => {
    const piece = fc.constantFrom(
      'r',
      'T',
      'M',
      ' ',
      ',',
      '=',
      '@',
      '%',
      '\n',
      'w',
      'n',
      '1',
      '2',
      'a',
      '%2c%',
      '%zz%',
      '’',
      '\ud800',
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(piece, { maxLength: 40 }).map((a) => a.join('')),
          fc.string({ maxLength: 60 }),
        ),
        (text) => {
          try {
            parseOplRelations(text);
          } catch (e) {
            expect(e).toBeInstanceOf(InputError);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
