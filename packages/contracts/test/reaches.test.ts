import { describe, expect, it } from 'vitest';
import { checkReaches, REACHES_SCHEMA_VERSION, ReachesFile, StationTravelTime } from '../src/reaches.ts';

// The v2 travel shape (#110) of the reaches file: h or d, a range or a labelled single value, derived only true.
// A row of the pre-#110 files (an h range alone) stays valid, so schema_version stays 1.

const row = (over: Record<string, unknown> = {}) => ({
  from_station_id: 'de.wsv.2790020',
  to_station_id: 'nl.rws.lobith.bovenrijn.tolkamer',
  h: [1, 8],
  basis: 'flood peak',
  source: 'a note',
  source_url: 'https://example.org/note',
  ...over,
});
const label = { nl: 'hoogwater', en: 'flood' };
const omit = (r: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(r).filter(([x]) => x !== k));

describe('StationTravelTime', () => {
  it('keeps a pre-#110 row valid', () => {
    expect(StationTravelTime.safeParse(row()).success).toBe(true);
  });

  it('accepts a d range, a labelled single h, a labelled single d and derived true', () => {
    for (const r of [
      omit(row({ d: [4, 5] }), 'h'),
      row({ h: 23, label }),
      omit(row({ d: 2, label }), 'h'),
      row({ derived: true }),
    ])
      expect(StationTravelTime.safeParse(r).success, JSON.stringify(r)).toBe(true);
  });

  it('refuses the bad shapes', () => {
    for (const r of [
      omit(row(), 'h'),
      row({ d: [1, 2] }),
      row({ h: 23 }),
      row({ h: [8, 1] }),
      row({ h: [3, 3] }),
      row({ h: 0, label }),
      row({ derived: false }),
      row({ h: 23, label: { nl: 'x', en: '' } }),
      row({ h: 23, label: { nl: 'x', en: 'x', de: 'x' } }),
      row({ extra: 1 }),
    ])
      expect(StationTravelTime.safeParse(r).success, JSON.stringify(r)).toBe(false);
  });
});

// P17b: schema 2 adds `waterbodies` and `mouths`; schema 1 files (and readers of them) stay valid.
const file = (over: Record<string, unknown> = {}) => ({
  schema_version: 2,
  version: '20261117',
  attribution: '\u00a9 OpenStreetMap contributors',
  attribution_url: 'https://www.openstreetmap.org/copyright',
  licence: 'ODbL-1.0',
  licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  licence_note: 'Derived from OpenStreetMap.',
  osm_replication_timestamp: '2026-11-16T20:00:00Z',
  rivers: [{ id: 'rhine', name_nl: 'Rijn', name_en: 'Rhine', parent_river_id: null, km_direction: 'downstream' }],
  nl_entry_nodes: [],
  reaches: [],
  stations: [],
  travel_times: [],
  waterbodies: [
    {
      id: 'ijsselmeer',
      kind: 'lake',
      name_nl: 'IJsselmeer',
      name_en: 'IJsselmeer',
      stations: ['nl.rws.a', 'nl.rws.b'],
      reference_station_id: null,
      outflows: [{ to: 'waddenzee', via: 'Afsluitdijk' }],
    },
    {
      id: 'waddenzee',
      kind: 'sea',
      name_nl: 'Waddenzee',
      name_en: 'Wadden Sea',
      stations: [],
      reference_station_id: null,
      outflows: [],
    },
  ],
  mouths: [{ id: 'rhine-mouth', river_id: 'rhine', waterbody_id: 'waddenzee' }],
  ...over,
});
const problemsOf = (over: Record<string, unknown>) => {
  const p = ReachesFile.safeParse(file(over));
  expect(p.success, JSON.stringify(over)).toBe(true);
  return p.success ? checkReaches(p.data) : [];
};
const body = (i: number, over: Record<string, unknown>) => {
  const w = file().waterbodies.map((x) => ({ ...x }));
  w[i] = { ...(w[i] as object), ...over } as never;
  return w;
};
const without = (k: string) => Object.fromEntries(Object.entries(file()).filter(([x]) => x !== k));

describe('ReachesFile schema 2 (P17b)', () => {
  it('is version 2 and still reads schema 1 without the new keys', () => {
    expect(REACHES_SCHEMA_VERSION).toBe(2);
    const v1 = { ...without('waterbodies'), schema_version: 1 };
    const { mouths: _m, ...v1plain } = v1 as Record<string, unknown>;
    const p = ReachesFile.safeParse(v1plain);
    expect(p.success).toBe(true);
    expect(p.success ? checkReaches(p.data) : ['x']).toEqual([]);
  });

  it('accepts a clean schema 2 file', () => {
    expect(problemsOf({})).toEqual([]);
  });

  it('refuses schema 3', () => {
    expect(ReachesFile.safeParse(file({ schema_version: 3 })).success).toBe(false);
  });

  it('needs both keys at schema 2, neither at schema 1', () => {
    for (const k of ['waterbodies', 'mouths']) {
      const p = ReachesFile.safeParse(without(k));
      expect(p.success).toBe(true);
      expect(p.success ? checkReaches(p.data) : []).toEqual(['schema 2 needs waterbodies and mouths']);
    }
    expect(problemsOf({ schema_version: 1 })).toEqual(['schema 1 has no waterbodies or mouths']);
    expect(problemsOf({ schema_version: 1, mouths: undefined })).toEqual(['schema 1 has no waterbodies or mouths']);
    expect(problemsOf({ schema_version: 1, waterbodies: undefined })).toEqual([
      'schema 1 has no waterbodies or mouths',
    ]);
  });

  it('names each broken reference', () => {
    const w = file().waterbodies;
    expect(problemsOf({ waterbodies: [...w, w[1]] })).toContain('waterbody waddenzee twice');
    expect(problemsOf({ waterbodies: body(0, { stations: ['nl.rws.b', 'nl.rws.a'] }) })).toEqual([
      'waterbody ijsselmeer: stations not sorted and unique',
    ]);
    expect(problemsOf({ waterbodies: body(0, { stations: ['nl.rws.a', 'nl.rws.a'] }) })).toEqual([
      'waterbody ijsselmeer: stations not sorted and unique',
    ]);
    expect(problemsOf({ waterbodies: body(0, { reference_station_id: 'nl.rws.zz' }) })).toEqual([
      'waterbody ijsselmeer: reference station not among its stations',
    ]);
    expect(problemsOf({ waterbodies: body(0, { reference_station_id: 'nl.rws.b' }) })).toEqual([]);
    expect(problemsOf({ waterbodies: body(0, { outflows: [{ to: 'nowhere', via: 'x' }] }) })).toEqual([
      'waterbody ijsselmeer: bad outflow nowhere',
    ]);
    expect(problemsOf({ waterbodies: body(0, { outflows: [{ to: 'ijsselmeer', via: 'x' }] }) })).toEqual([
      'waterbody ijsselmeer: bad outflow ijsselmeer',
    ]);
    const m = file().mouths[0] as object;
    expect(problemsOf({ mouths: [m, m] })).toEqual(['mouth rhine-mouth twice']);
    expect(problemsOf({ mouths: [{ ...m, river_id: 'nope' }] })).toEqual(['mouth rhine-mouth: unknown river nope']);
    expect(problemsOf({ mouths: [{ ...m, waterbody_id: 'nope' }] })).toEqual([
      'mouth rhine-mouth: unknown waterbody nope',
    ]);
  });

  it('is strict about the new objects', () => {
    expect(ReachesFile.safeParse(file({ waterbodies: body(0, { extra: 1 }) })).success).toBe(false);
    expect(
      ReachesFile.safeParse(file({ mouths: [{ id: 'a-b', river_id: 'rhine', waterbody_id: 'c-d', x: 1 }] })).success,
    ).toBe(false);
  });
});
