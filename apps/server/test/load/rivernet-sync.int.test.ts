import type { RivernetFile, RiversFile } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readStations } from '../../../../tools/geo/rivernet/stations.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { readRegistry, readRiverRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { type Harness, harness } from './harness.ts';

// P6b: rivers, reaches and the placement fields of stations, synced with the registry in one transaction.

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

const registry = readRegistry();
const ids = (source: string, audience: string) => [
  ...new Set(registry.stations.filter((s) => s.source === source && s.audience === audience).map((s) => s.id)),
];
const [up, down] = ids('DE-1', 'public') as [string, string];
const owner = ids('BE-3', 'owner')[0] as string;
const off = ids('LU-1', 'off')[0] as string;

const river = (id: string, parent: string | null, names: Record<string, string[]>) => ({
  id,
  name_nl: id.toUpperCase(),
  name_en: `${id}-en`,
  names,
  aliases: [],
  osm_relation_id: 1,
  osm_way_name: null,
  wikidata: 'Q1',
  parent_river_id: parent,
  km_direction: 'downstream' as const,
  evidence: 'test',
});
const rivers = {
  version: 1,
  rivers: [river('rhine', null, { 'DE-1': ['RHEIN'] }), river('waal', 'rhine', { 'DE-1': ['WAAL'] })],
  excluded: [],
} as unknown as RiversFile;
const flags = (tidal: boolean) => ({ tidal, impounded: false, bifurcation: false });
const net = (): RivernetFile => ({
  version: 1,
  fixture: {
    source_run: 'https://github.com/mwijkhuisen/Waterheight/actions/runs/1',
    ways_sha256: '0'.repeat(64),
    osm_replication_timestamp: '2026-10-01T20:22:06Z',
  },
  stations: [
    {
      id: up,
      rule: 'override',
      river: 'rhine',
      reach: 'rhine.1',
      km_official: 10.5,
      km_official_system: 'RHEIN-km (TEST)',
      km_graph: 11,
      km_to_nl_entry: 5,
      nl_entry_node: 'emmerich',
    },
    {
      id: down,
      rule: 'name',
      river: 'rhine',
      reach: 'rhine.2',
      km_official: null,
      km_official_system: null,
      km_graph: null,
      km_to_nl_entry: null,
      nl_entry_node: null,
    },
    {
      id: owner,
      rule: 'override',
      river: 'waal',
      reach: null,
      km_official: 3,
      km_official_system: 'WAAL-km',
      km_graph: 3,
      km_to_nl_entry: null,
      nl_entry_node: null,
    },
    {
      id: off,
      rule: 'unsnapped',
      river: null,
      reach: null,
      km_official: null,
      km_official_system: null,
      km_graph: null,
      km_to_nl_entry: null,
      nl_entry_node: null,
    },
    {
      id: 'xx.unknown.1',
      rule: 'unsnapped',
      river: null,
      reach: null,
      km_official: null,
      km_official_system: null,
      km_graph: null,
      km_to_nl_entry: null,
      nl_entry_node: null,
    },
  ],
  reaches: [
    {
      id: 'rhine.1',
      river: 'rhine',
      seq: 1,
      up_station: up,
      down_station: down,
      length_km: 12.5,
      flags: flags(false),
      travel_time_h: [1.5, 3],
      travel_time_source: 'test',
    },
    {
      id: 'rhine.2',
      river: 'rhine',
      seq: 2,
      up_station: down,
      down_station: 'xx.unknown.1',
      length_km: 7,
      flags: flags(true),
      travel_time_h: null,
      travel_time_source: null,
    },
  ],
});

async function sync(rn: RivernetFile | null) {
  const { db, close } = h.dbAs('rws_migrator', 1);
  try {
    return await syncRegistry(db, registry, { rivers, rivernet: rn });
  } finally {
    await close();
  }
}
const q = async (text: string) => (await h.t.admin.query(text)).rows;

describe('rivernet sync', { timeout: 120_000 }, () => {
  it('writes rivers, reaches and station placement; a second run changes nothing', async () => {
    const res = await sync(net());
    expect(res.reaches).toBe(2);
    expect(res.rivernetUnknown).toBe(1);
    const r = await q(
      `SELECT id, names, osm_relation_id, wikidata, parent_river_id FROM river WHERE id IN ('rhine','waal') ORDER BY id`,
    );
    expect(r).toEqual([
      {
        id: 'rhine',
        names: { nl: 'RHINE', en: 'rhine-en', sources: { 'DE-1': ['RHEIN'] } },
        osm_relation_id: '1',
        wikidata: 'Q1',
        parent_river_id: null,
      },
      {
        id: 'waal',
        names: { nl: 'WAAL', en: 'waal-en', sources: { 'DE-1': ['WAAL'] } },
        osm_relation_id: '1',
        wikidata: 'Q1',
        parent_river_id: 'rhine',
      },
    ]);
    const reaches = await q(
      `SELECT id, river_id, seq, up_station_id, down_station_id, length_km, flags, travel_time_h::text AS tt, travel_time_source FROM reach ORDER BY seq`,
    );
    expect(reaches.map((x) => ({ ...x, id: undefined }))).toEqual([
      {
        id: undefined,
        river_id: 'rhine',
        seq: 1,
        up_station_id: up,
        down_station_id: down,
        length_km: 12.5,
        flags: flags(false),
        tt: '[1.5,3]',
        travel_time_source: 'test',
      },
      {
        id: undefined,
        river_id: 'rhine',
        seq: 2,
        up_station_id: down,
        down_station_id: null,
        length_km: 7,
        flags: flags(true),
        tt: null,
        travel_time_source: null,
      },
    ]);
    const st = await q(
      `SELECT s.id, s.river_id, s.km_official, s.km_system, s.km_to_nl_entry, s.nl_entry_node, r.river_id || '.' || r.seq AS reach FROM station s LEFT JOIN reach r ON r.id = s.reach_id WHERE s.id = ANY(ARRAY['${up}','${down}','${owner}','${off}'])`,
    );
    const by = Object.fromEntries(st.map((x) => [x.id, x]));
    expect(by[up]).toMatchObject({
      river_id: 'rhine',
      km_official: 10.5,
      km_system: 'RHEIN-km (TEST)',
      km_to_nl_entry: 5,
      nl_entry_node: 'emmerich',
      reach: 'rhine.1',
    });
    expect(by[down].reach).toBe('rhine.2');
    expect(by[owner]).toMatchObject({ river_id: 'waal', km_official: 3, km_system: 'WAAL-km', reach: null });
    expect(by[off].reach).toBeNull();

    const snap = async () =>
      JSON.stringify([
        await q('SELECT * FROM reach ORDER BY id'),
        await q(
          'SELECT id, river_id, reach_id, km_official, km_system, km_to_nl_entry, nl_entry_node FROM station ORDER BY id',
        ),
        await q('SELECT * FROM river ORDER BY id'),
      ]);
    const before = await snap();
    await sync(net());
    expect(await snap()).toBe(before);
  });

  it('deletes a reach that left the file and nulls the stations that pointed at it', async () => {
    const n = net();
    n.reaches = n.reaches.slice(0, 1);
    n.stations = n.stations.map((s) => (s.reach === 'rhine.2' ? { ...s, reach: null } : s));
    await sync(n);
    expect(await q('SELECT seq FROM reach')).toEqual([{ seq: 1 }]);
    expect((await q(`SELECT reach_id FROM station WHERE id = '${down}'`))[0]).toEqual({ reach_id: null });
    // Without a rivernet file the reaches stay, and so do every station's reach, entry km and entry node.
    const kept = async () =>
      JSON.stringify([
        await q('SELECT * FROM reach ORDER BY id'),
        await q('SELECT id, reach_id, km_to_nl_entry, nl_entry_node FROM station ORDER BY id'),
      ]);
    const before = await kept();
    const res = await sync(null);
    expect(await kept()).toBe(before);
    expect(res.reaches).toBe(1);
    expect((await q(`SELECT r.seq FROM station s JOIN reach r ON r.id = s.reach_id WHERE s.id = '${up}'`))[0]).toEqual({
      seq: 1,
    });
  });

  it('the public station view holds exactly the ids the placement calls public', async () => {
    await sync(null);
    const view = (await q(`SELECT DISTINCT id FROM ${VIEWS.public.station}`)).map((x) => x.id as string).sort();
    const wanted = readStations()
      .filter((s) => s.public)
      .map((s) => s.id)
      .sort();
    expect(view).toEqual(wanted);
  });

  it('reads the real river registry', () => {
    const r = readRiverRegistry();
    expect(r.rivers.rivers.length).toBeGreaterThan(0);
  });
});
