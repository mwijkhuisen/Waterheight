import { describe, expect, it } from 'vitest';
import { RivernetFile, SnapOverride, validateRivernet, validateSnapOverrides } from '../src/index.ts';

// The P17b parts of the snap contracts: the waterbody override, canal edges and the water-body columns.

const ov = (over: Record<string, unknown>) => ({ station: 'nl.rws.a', reason: 'test', ...over });

describe('SnapOverride (P17b)', () => {
  it('accepts a waterbody alone and a waterbody beside a river', () => {
    for (const o of [
      ov({ waterbody: 'ijsselmeer' }),
      ov({ waterbody: 'ijsselmeer', waterbody_max_m: 800 }),
      ov({ river: 'ijssel', waterbody: 'ijsselmeer' }),
      ov({ river: 'ijssel', max_m: 300 }),
    ])
      expect(SnapOverride.safeParse(o).success, JSON.stringify(o)).toBe(true);
  });

  it('refuses the bad combinations', () => {
    for (const o of [
      ov({ river: 'ijssel', canal: 'amsterdam-rijnkanaal' }),
      ov({}),
      ov({ waterbody_max_m: 100 }),
      ov({ unsnapped: true, waterbody_max_m: 100 }),
      ov({ canal: 'amsterdam-rijnkanaal', max_m: 100 }),
      ov({ waterbody: 'ijsselmeer', max_m: 100 }),
      ov({ waterbody: 'ijsselmeer', waterbody_max_m: 0 }),
      ov({ waterbody: 'ijsselmeer', waterbody_max_m: 2001 }),
      ov({ waterbody: 'Bad Id' }),
    ])
      expect(SnapOverride.safeParse(o).success, JSON.stringify(o)).toBe(false);
  });
});

describe('validateSnapOverrides (P17b)', () => {
  const doc = (stations: unknown[]) => ({ version: 1, stations, waters: [] });
  it('reports an unknown waterbody id and accepts a known one', () => {
    const rivers = new Set(['ijssel']);
    const r = validateSnapOverrides(doc([ov({ waterbody: 'nope' })]), rivers, new Set(['ijsselmeer']));
    expect(r.problems).toEqual(['stations: nl.rws.a: unknown waterbody nope']);
    expect(
      validateSnapOverrides(doc([ov({ waterbody: 'ijsselmeer' })]), rivers, new Set(['ijsselmeer'])).problems,
    ).toEqual([]);
  });
});

const station = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  rule: 'name',
  river: 'ijssel',
  reach: null,
  km_official: null,
  km_official_system: null,
  km_graph: null,
  km_to_nl_entry: null,
  nl_entry_node: null,
  canal: null,
  waterbody: null,
  waterbody_rule: null,
  ...over,
});
const net = (stations: unknown[], waterbodiesSha: string | null = null) => ({
  version: 1,
  fixture: {
    source_run: 'https://github.com/mwijkhuisen/Waterheight/actions/runs/1',
    ways_sha256: 'a'.repeat(64),
    osm_replication_timestamp: '2026-11-16T20:00:00Z',
    waterbodies_sha256: waterbodiesSha,
  },
  stations,
  reaches: [],
});
const problems = (stations: unknown[]) => validateRivernet(net(stations)).problems.join('\n');

describe('validateRivernet (P17b)', () => {
  it('accepts canal, waterbody and plain rows', () => {
    expect(
      problems([
        station('nl.rws.a'),
        station('nl.rws.b', { rule: 'canal_edge', river: null, canal: 'noordzeekanaal' }),
        station('nl.rws.c', {
          rule: 'water_not_in_rivers',
          river: null,
          waterbody: 'ijsselmeer',
          waterbody_rule: 'waterbody_shore',
        }),
        station('nl.rws.d', { river: null, rule: 'water_not_in_rivers', waterbody_rule: 'waterbody_too_far' }),
      ]),
    ).toBe('');
  });

  it('fails each mutation with its own problem', () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['canal rule without a canal', { rule: 'canal_edge', river: null }, /canal exactly on canal_edge/],
      ['a canal without the rule', { canal: 'amsterdam-rijnkanaal' }, /canal exactly on canal_edge/],
      [
        'a canal station with a river',
        { rule: 'canal_edge', canal: 'amsterdam-rijnkanaal', river: 'ijssel' },
        /a canal station has no river, reach or km_graph/,
      ],
      [
        'a canal station with km_graph',
        { rule: 'canal_edge', canal: 'amsterdam-rijnkanaal', river: null, km_graph: 3 },
        /a canal station has no river, reach or km_graph/,
      ],
      ['a waterbody without a rule', { waterbody: 'ijsselmeer' }, /waterbody exactly with a waterbody rule/],
      [
        'a too_far rule with a waterbody',
        { waterbody: 'ijsselmeer', waterbody_rule: 'waterbody_too_far' },
        /waterbody exactly with a waterbody rule/,
      ],
      [
        'a rule without a waterbody',
        { waterbody_rule: 'waterbody_contains' },
        /waterbody exactly with a waterbody rule/,
      ],
    ];
    for (const [name, over, re] of cases) expect(problems([station('nl.rws.a', over)]), name).toMatch(re);
  });

  it('reads waterbodies_sha256 as null or a hex digest, and nothing else', () => {
    expect(RivernetFile.safeParse(net([])).success).toBe(true);
    expect(RivernetFile.safeParse(net([], 'b'.repeat(64))).success).toBe(true);
    expect(RivernetFile.safeParse(net([], 'xyz')).success).toBe(false);
  });
});
