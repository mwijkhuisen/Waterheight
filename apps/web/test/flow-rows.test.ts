import { readFileSync } from 'node:fs';
import type { ApiStation, Snapshot } from '@rws/contracts';
import { ReachRiver } from '@rws/contracts';
import { describe, expect, it } from 'vitest';
import { type ChainNode, chain } from '../src/features/flow/chain.ts';
import { type ChainContext, type ChainRow, chainRows, type StationRow } from '../src/features/flow/rows.ts';
import { basisKind, stateWord } from '../src/features/station/state.ts';
import { ReachGraphFile, ReachTravel } from '../src/lib/data/contracts.ts';
import { riverName } from '../src/lib/labels/labels.ts';
import type { StationState } from '../src/lib/stationStates.ts';
import { travelText } from '../src/lib/travel.ts';
import { m } from '../src/paraglide/messages.js';
import type { Locale } from '../src/paraglide/runtime.js';

// The texts of the upstream chain's rows (P11a, issue #26): names as published, rivers, state and basis, owner flag,
// the exact-pair travel text. The fixture is the committed river release (test/fixtures/reaches-fixture.json).

type Value = Snapshot['values'][number];
const LOCALES: Locale[] = ['nl', 'en'];
const raw: { rivers: unknown[]; travel_times: unknown[] } = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/reaches-fixture.json', import.meta.url), 'utf8'),
);
const graph = ReachGraphFile.parse(raw);
const rivers = raw.rivers.map((r) => ReachRiver.parse(r));
const travel = ReachTravel.parse(raw);
const LOBITH = 'nl.rws.lobith.bovenrijn.tolkamer';

let next = 1;
/** A station with one series of `source` (the fields the rows read). */
const station = (id: string, name: string, source = 'DE-1'): ApiStation =>
  ({ id, name, series: [{ id: next++, source, quantity: 'H' }] }) as unknown as ApiStation;
const value = (series: number, state: Value['state'], basis: Value['basis'] = null, section = false): Value =>
  ({ series, ts: '2026-10-01T00:00:00Z', value: 1, qc: 0, ageSeconds: 0, state, basis, section }) as unknown as Value;

const stationsOf = (ids: Iterable<string>, owner = new Set<string>()) =>
  new Map([...ids].map((id) => [id, station(id, `Name of ${id}`, owner.has(id) ? 'BE-3' : 'DE-1')]));

function ctx(locale: Locale, patch: Partial<ChainContext> = {}): ChainContext {
  return {
    locale,
    targetId: LOBITH,
    stations: stationsOf(graph.stations.map((s) => s.id)),
    rivers: new Map(rivers.map((r) => [r.id, r])),
    states: new Map<string, StationState>(),
    values: new Map(),
    ownerSources: new Set(),
    travel,
    ...patch,
  };
}

const first = (rows: readonly ChainRow[]): StationRow => {
  const row = rows[0];
  if (row?.kind !== 'station') throw new Error('not a station row');
  return row;
};
const node = (ids: string[], riverId = 'rhine', distKm = 1): ChainNode => ({ kind: 'station', ids, riverId, distKm });

describe('chainRows', () => {
  it.each(LOCALES)('keeps a station name with markup a plain string (%s)', (locale) => {
    const name = '<img src=x onerror=alert(1)> & "Köln"';
    const stations = new Map([['de.wsv.2730010', station('de.wsv.2730010', name)]]);
    const row = first(chainRows([node(['de.wsv.2730010'])], ctx(locale, { stations })));
    expect(row.name).toBe(name);
    expect(row.id).toBe('de.wsv.2730010');
  });

  it.each(LOCALES)('names the river by our label, else by the release, else by its id (%s)', (locale) => {
    const row = (riverId: string) => first(chainRows([node(['de.wsv.2730010'], riverId)], ctx(locale))).river;
    expect(row('rhine')).toBe(locale === 'nl' ? 'Rijn' : 'Rhine');
    // a river with no label of ours takes the release's name; an id the release lacks stays as it is
    const custom = new Map([
      ['zz', { id: 'zz', name_nl: 'Zee', name_en: 'Sea', parent_river_id: null, km_direction: 'none' as const }],
    ]);
    const ownName = first(chainRows([node(['de.wsv.2730010'], 'zz')], ctx(locale, { rivers: custom }))).river;
    expect(ownName).toBe(locale === 'nl' ? 'Zee' : 'Sea');
    expect(row('nowhere')).toBe('nowhere');
  });

  it.each(LOCALES)('flags a station of an owner source and no other (%s)', (locale) => {
    const stations = stationsOf(['a.b.c', 'd.e.f'], new Set(['a.b.c']));
    const c = ctx(locale, { stations, ownerSources: new Set(['BE-3']) });
    const rows = chainRows([node(['a.b.c']), node(['d.e.f'])], c);
    expect(rows.map((r) => r.kind === 'station' && r.owner)).toEqual([true, false]);
    expect(first(chainRows([node(['a.b.c'])], ctx(locale, { stations }))).owner).toBe(false);
  });

  it.each(LOCALES)('gives a state word and the NL-4 basis as a basis, never as a warning (%s)', (locale) => {
    const stations = stationsOf(['nl.rws.x']);
    const series = stations.get('nl.rws.x')?.series[0]?.id ?? 0;
    const basis = { source: 'NL-4', kind: 'provider_class', measure: 'stage', ref: 'NL4:x', label: 'Licht verhoogd' };
    const values = new Map([[series, value(series, 'elevated', basis as Value['basis'], true)]]);
    const row = first(chainRows([node(['nl.rws.x'])], ctx(locale, { stations, values })));
    expect(row.state).toBe(stateWord('elevated', locale));
    expect(row.basis).toBe(`${basisKind({ kind: 'provider_class', source: 'NL-4' }, locale)}: Licht verhoogd`);
    expect(row.basis).toContain(m.basis_nl4({}, { locale }));
    expect(row.section).toBe(true);
    // no value at t: no state and no basis
    const none = first(chainRows([node(['nl.rws.x'])], ctx(locale, { stations })));
    expect([none.state, none.basis, none.section]).toEqual([null, null, false]);
  });

  it.each(LOCALES)('while played says "played" instead of a state word, with no basis (%s)', (locale) => {
    const stations = stationsOf(['nl.rws.x', 'nl.rws.y']);
    const series = stations.get('nl.rws.x')?.series[0]?.id ?? 0;
    // a frame value is shaped like a snapshot value: no_ref, no basis
    const values = new Map([[series, value(series, 'no_ref')]]);
    const c = ctx(locale, { stations, values, played: true });
    const row = first(chainRows([node(['nl.rws.x'])], c));
    expect([row.state, row.basis, row.section]).toEqual([m.played_note({}, { locale }), null, false]);
    expect(row.state).not.toBe(stateWord('no_ref', locale));
    // no value for the hour: null, so the list says "no value" as before
    expect(first(chainRows([node(['nl.rws.y'])], c)).state).toBeNull();
    // played false keeps the state word
    expect(first(chainRows([node(['nl.rws.x'])], ctx(locale, { stations, values }))).state).toBe(
      stateWord('no_ref', locale),
    );
  });

  it('takes the highest state among the series of a row and of its co-located stations', () => {
    const stations = stationsOf(['a.b.c', 'a.b.d']);
    const [s1 = 0, s2 = 0] = ['a.b.c', 'a.b.d'].map((i) => stations.get(i)?.series[0]?.id ?? 0);
    const values = new Map([
      [s1, value(s1, 'low')],
      [s2, value(s2, 'high')],
    ]);
    const row = first(chainRows([node(['a.b.c', 'a.b.d'])], ctx('en', { stations, values })));
    expect(row.state).toBe(stateWord('high', 'en'));
    expect(row.basis).toBeNull();
  });

  it('reads a forecast state from the record after now, with no basis', () => {
    const states = new Map<string, StationState>([['a.b.c', { has: true, forecast: true, level: 3 } as StationState]]);
    const row = first(chainRows([node(['a.b.c'])], ctx('nl', { stations: stationsOf(['a.b.c']), states })));
    expect([row.state, row.basis]).toEqual([stateWord('elevated', 'nl'), null]);
  });

  it.each(LOCALES)('shows the exact sourced pair Emmerich to Lobith and no other (%s)', (locale) => {
    const pair = travel.travel_times.find((t) => t.from_station_id === 'de.wsv.2790020');
    expect(pair?.to_station_id).toBe(LOBITH);
    const row = first(chainRows([node(['de.wsv.2790020'])], ctx(locale)));
    const text = travelText({ kind: 'range', lo: 1, hi: 9, unit: 'h' }, locale);
    expect(row.travel).toBe(text ?? m.travel_no_source({}, { locale }));
    if (text === null) {
      expect([row.travelBasis, row.source, row.href]).toEqual([null, null, undefined]);
    } else {
      expect(text).toMatch(/indicatief|indicative/);
      expect(row.travelBasis).toBe(pair?.basis);
      expect(row.source).toBe(pair?.source);
      expect(row.href).toBe(pair?.source_url);
      expect(row.href?.startsWith('https://')).toBe(true);
    }
    // Rees has no pair: no text of ours and no arithmetic on its neighbours
    const rees = first(chainRows([node(['de.wsv.2790010'])], ctx(locale)));
    expect([rees.travel, rees.travelBasis, rees.source, rees.href]).toEqual([
      m.travel_no_source({}, { locale }),
      null,
      null,
      undefined,
    ]);
    // the same station towards another target has no pair either
    const other = first(chainRows([node(['de.wsv.2790020'])], ctx(locale, { targetId: 'nl.rws.nijmegen.waal' })));
    expect(other.travel).toBe(m.travel_no_source({}, { locale }));
  });

  it('finds the pair through a co-located station of the row', () => {
    const row = first(chainRows([node(['de.wsv.9999', 'de.wsv.2790020'])], ctx('en')));
    expect(row.travel).toBe(
      travelText({ kind: 'range', lo: 1, hi: 9, unit: 'h' }, 'en') ?? m.travel_no_source({}, { locale: 'en' }),
    );
  });

  it('finds the pair when the panel is open on a station co-located with the pair target (review round 1)', () => {
    const peer = 'nl.rws.lobith.peer';
    const open = { targetId: peer, targetIds: [peer, LOBITH] };
    expect(first(chainRows([node(['de.wsv.2790020'])], ctx('en', open))).travelBasis).not.toBeNull();
    expect(first(chainRows([node(['de.wsv.2790020'])], ctx('en', { targetId: peer }))).travelBasis).toBeNull();
  });

  it('labels a source arm of the river it joins a branch, not a tributary (review round 1)', () => {
    const arm: ChainNode = { kind: 'group', riverId: 'neckar', children: [node(['x.y.1'], 'neckar')], count: 1 };
    const [branch, tributary] = chainRows([{ ...arm, sameRiver: true }, arm], ctx('en'));
    const river = riverName('neckar', 'en') ?? 'neckar';
    expect(branch?.kind === 'group' && branch.summary).toBe(m.chain_branch({ river, count: '1' }, { locale: 'en' }));
    expect(tributary?.kind === 'group' && tributary.summary).toBe(
      m.chain_group({ river, count: '1' }, { locale: 'en' }),
    );
  });

  it('shows a link only for an https source', () => {
    const bad = {
      travel_times: [{ ...travel.travel_times[0], source_url: 'javascript:alert(1)' }],
    };
    const row = first(chainRows([node(['de.wsv.2790020'])], ctx('en', { travel: bad as never })));
    expect(row.href).toBeUndefined();
  });

  it.each(LOCALES)('words a gap with a rounded km and a group with its station count (%s)', (locale) => {
    const nodes: ChainNode[] = [
      { kind: 'gap', riverId: 'meuse', km: 81.8 },
      { kind: 'group', riverId: 'sambre', count: 2, children: [node(['a.b.c']), { kind: 'gap', riverId: 'x', km: 3 }] },
    ];
    const rows = chainRows(nodes, ctx(locale, { stations: stationsOf(['a.b.c']) }));
    const meuse = riverName('meuse', locale) ?? 'meuse';
    expect(rows[0]).toMatchObject({ kind: 'gap', text: m.chain_gap({ km: '82', river: meuse }, { locale }) });
    const group = rows[1];
    expect(group?.kind === 'group' && group.summary).toBe(
      m.chain_group({ river: riverName('sambre', locale) ?? 'sambre', count: '2' }, { locale }),
    );
    expect(group?.kind === 'group' && group.children.map((c) => c.kind)).toEqual(['station', 'gap']);
  });

  it.each(LOCALES)('rows the real Lobith and Eijsden chains with unique keys (%s)', (locale) => {
    const known = new Set(graph.stations.map((s) => s.id));
    for (const target of [LOBITH, 'nl.rws.eijsden.grens']) {
      const rows = chainRows(chain(graph, rivers, target, known), ctx(locale, { targetId: target }));
      const keys: string[] = [];
      const collect = (rs: readonly ChainRow[]) => {
        const here = rs.map((r) => r.key);
        expect(new Set(here).size).toBe(here.length);
        keys.push(...here);
        for (const r of rs) if (r.kind === 'group') collect(r.children);
      };
      collect(rows);
      expect(rows.length).toBeGreaterThan(3);
      // every travel text of a station row says it is indicative, or says there is no sourced value
      const all: StationRow[] = [];
      const stations = (rs: readonly ChainRow[]) => {
        for (const r of rs) r.kind === 'station' ? all.push(r) : r.kind === 'group' && stations(r.children);
      };
      stations(rows);
      for (const r of all) expect(r.travel).toMatch(/indicatief|indicative|geen bronwaarde|no sourced value/);
    }
  });
});
