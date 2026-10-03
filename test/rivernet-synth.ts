import type { SnapOverridesFile } from '../packages/contracts/src/rivernet.ts';
import { type RiversFile, validateRivers } from '../packages/contracts/src/rivers.ts';
import type { Edge } from '../tools/geo/rivernet/build.ts';
import { haversine, type LonLat } from '../tools/geo/rivernet/network.ts';
import type { StationInput } from '../tools/geo/rivernet/stations.ts';

// Tiny hand-made graphs for the P6b placement unit tests (around 51 N, lon 5).

/** An edge whose length is the haversine of its coordinates (the P6a metric); from/to are the node ids. */
export function edge(id: string, from: string, to: string, rivers: string[], coords: LonLat[]): Edge {
  let length = 0;
  for (let i = 0; i + 1 < coords.length; i++) length += haversine(coords[i] as LonLat, coords[i + 1] as LonLat);
  return { id, from, to, way: 1, rivers, length_m: Math.round(length * 10) / 10, coords };
}

/** Nodes `n0..` of a straight chain along latitude `lat`, 0.02 degrees of longitude (about 1.4 km) apart. */
export const chainNode = (i: number, lat = 51, lon0 = 5): LonLat => [Math.round((lon0 + 0.02 * i) * 1e6) / 1e6, lat];

/** The straight chain `<prefix>1..<prefix>n` over nodes `<p>0..<p>n`, all of `rivers`. */
export function chain(prefix: string, n: number, rivers: string[], lat = 51, lon0 = 5): Edge[] {
  return Array.from({ length: n }, (_, i) =>
    edge(`${prefix}${i + 1}`, `${prefix}n${i}`, `${prefix}n${i + 1}`, rivers, [
      chainNode(i, lat, lon0),
      chainNode(i + 1, lat, lon0),
    ]),
  );
}

type RiverOpts = Partial<RiversFile['rivers'][number]> & { id: string };
let serial = 0;
export function river(o: RiverOpts): RiversFile['rivers'][number] {
  serial++;
  return {
    name_nl: o.id,
    name_en: o.id,
    names: {},
    aliases: [],
    osm_relation_id: 1000 + serial,
    osm_way_name: null,
    wikidata: `Q${5000 + serial}`,
    parent_river_id: null,
    km_direction: 'downstream',
    evidence: 'synthetic',
    ...o,
  };
}

export function riversFile(
  rivers: RiversFile['rivers'],
  extra: Pick<RiversFile, 'joins' | 'travel_times'> = {},
): RiversFile {
  const { problems, rivers: ok } = validateRivers({ version: 1, rivers, excluded: [], ...extra });
  if (ok === undefined) throw new Error(problems.join('; '));
  return ok;
}

export function station(id: string, at: LonLat | null, o: Partial<StationInput> = {}): StationInput {
  return {
    id,
    source: 'DE-1',
    audience: 'public',
    public: true,
    lon: at?.[0] ?? null,
    lat: at?.[1] ?? null,
    water_name: null,
    river_hint: null,
    km: null,
    ...o,
  };
}

export const overrides = (
  stations: SnapOverridesFile['stations'] = [],
  waters: SnapOverridesFile['waters'] = [],
): SnapOverridesFile => ({ version: 1, stations, waters });
