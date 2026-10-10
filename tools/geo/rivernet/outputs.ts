import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  checkReaches,
  ODBL_LICENCE,
  ODBL_URL,
  OSM_ATTRIBUTION,
  OSM_ATTRIBUTION_URL,
  type ReachesFile,
  ReachesFile as ReachesSchema,
  RIVERS_VERSION_RE,
} from '../../../packages/contracts/src/reaches.ts';
import type { RiversFile } from '../../../packages/contracts/src/rivers.ts';
import { BuildError, canonicalJson, type Edge, MAX_WAYS_BYTES, readRivers } from './build.ts';
import { InputError } from './geojsonseq.ts';
import { type Placed, place, readOverrides } from './place.ts';
import { readStations } from './stations.ts';

// The public P6b outputs (A§9.1; release assets of geo.yml):
//   reaches-<ver>.json       public reaches in graph order, public stations with km (ReachesFile)
//   rivers-<ver>.geojson.gz  the ODbL download: one line per reach, names, flags; no station data
//   rivers.geojsonseq        the same lines for tippecanoe (rivers-<ver>.pmtiles; not an asset)
//   snap-report.json         public stations per id; counts per rule of public-audience stations only
//   VERSION
// Only public stations appear in them (invariants 8, 11): owner and off
// stations got a reach in the placement but split nothing and are left out.
// Same input and version, same bytes.

export const LICENCE_NOTE =
  'The river network is derived from OpenStreetMap and is available under the ODbL 1.0. Station identifiers and kilometres are a separate collective database and are not covered by the ODbL.';

const km3 = (m: number) => Math.round(m) / 1000;
const km2 = (m: number) => Math.round(m / 10) / 100;

export function reachesFile(placed: Placed, rivers: RiversFile, version: string, osmStamp: string): ReachesFile {
  const used = new Set(placed.reaches.map((r) => r.river));
  const stations = placed.stations.filter((s) => s.public && s.river !== null).sort((a, b) => (a.id < b.id ? -1 : 1));
  const file: ReachesFile = {
    schema_version: 1,
    version,
    attribution: OSM_ATTRIBUTION,
    attribution_url: OSM_ATTRIBUTION_URL,
    licence: ODBL_LICENCE,
    licence_url: ODBL_URL,
    licence_note: LICENCE_NOTE,
    osm_replication_timestamp: osmStamp,
    rivers: rivers.rivers
      .filter((r) => used.has(r.id))
      .map((r) => ({
        id: r.id,
        name_nl: r.name_nl,
        name_en: r.name_en,
        parent_river_id: r.parent_river_id,
        km_direction: r.km_direction,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    nl_entry_nodes: placed.net.entries.map((e) => ({
      id: e.id,
      river_id: e.river,
      node: e.node,
      name_nl: e.name_nl,
      name_en: e.name_en,
      coord: e.coord,
    })),
    reaches: placed.reaches.map((r) => ({
      id: r.id,
      river_id: r.river,
      seq: r.seq,
      up_station_id: r.up_station,
      down_station_id: r.down_station,
      length_km: km3(r.length_m),
      km_graph_from: km2(r.km_graph_from),
      km_graph_to: km2(r.km_graph_to),
      flags: r.flags,
      travel_time_h: r.travel_time_h,
      travel_time_source: r.travel_time_source,
      upstream: r.upstream,
      downstream: r.downstream,
    })),
    stations: stations.map((s) => ({
      id: s.id,
      river_id: s.river as string,
      reach_id: s.reach,
      km_official: s.km_official,
      km_official_system: s.km_official_system,
      km_graph: s.km_graph,
      km_to_nl_entry: s.km_to_nl_entry,
      nl_entry_node: s.nl_entry_node,
    })),
    travel_times: placed.travel.map(({ from_station, to_station, ...value }) => ({
      from_station_id: from_station,
      to_station_id: to_station,
      ...value,
    })),
  };
  const parsed = ReachesSchema.safeParse(file);
  if (!parsed.success) throw new BuildError('reaches_invalid', [parsed.error.issues[0]?.path.join('.') ?? '']);
  const problems = checkReaches(parsed.data);
  if (problems.length > 0) throw new BuildError('reaches_invalid', problems.slice(0, 5));
  return parsed.data;
}

function lineFeatures(placed: Placed, rivers: RiversFile): string[] {
  const names = new Map(rivers.rivers.map((r) => [r.id, r]));
  return placed.reaches.map((r) =>
    JSON.stringify({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.coords },
      properties: {
        reach_id: r.id,
        river_id: r.river,
        name_nl: names.get(r.river)?.name_nl,
        name_en: names.get(r.river)?.name_en,
        length_km: km3(r.length_m),
        tidal: r.flags.tidal,
        impounded: r.flags.impounded,
        bifurcation: r.flags.bifurcation,
      },
    }),
  );
}

/** The ODbL download: attribution and licence ahead of the features, so the first bytes carry them. */
export function downloadText(placed: Placed, rivers: RiversFile, version: string, osmStamp: string): string {
  const head = JSON.stringify({
    type: 'FeatureCollection',
    name: `rivers-${version}`,
    attribution: OSM_ATTRIBUTION,
    attribution_url: OSM_ATTRIBUTION_URL,
    licence: ODBL_LICENCE,
    licence_url: ODBL_URL,
    licence_note: LICENCE_NOTE,
    version,
    osm_replication_timestamp: osmStamp,
  }).slice(0, -1);
  return `${head},"features":[\n${lineFeatures(placed, rivers).join(',\n')}\n]}\n`;
}

export function snapReport(placed: Placed, version: string, osmStamp: string): string {
  // Counts per rule of the shown stations and of the public-audience ones not shown (mirrors, sources without
  // `display`); owner and off stations are not counted at all, so the report does not depend on them.
  const counts: Record<string, Record<string, number>> = { public: {}, public_not_shown: {} };
  for (const s of placed.stations) {
    if (s.audience !== 'public') continue;
    const c = counts[s.public ? 'public' : 'public_not_shown'] as Record<string, number>;
    c[s.rule] = (c[s.rule] ?? 0) + 1;
  }
  return canonicalJson(
    {
      attribution: OSM_ATTRIBUTION,
      attribution_url: OSM_ATTRIBUTION_URL,
      licence: ODBL_LICENCE,
      version,
      osm_replication_timestamp: osmStamp,
      counts,
      stations: placed.stations
        .filter((s) => s.public)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((s) => ({
          id: s.id,
          source: s.source,
          rule: s.rule,
          override: s.override,
          river_id: s.river,
          reach_id: s.reach,
          distance_m: s.placement?.distance_m ?? null,
          km_official: s.km_official,
          km_official_system: s.km_official_system,
          km_graph: s.km_graph,
          km_to_nl_entry: s.km_to_nl_entry,
          nl_entry_node: s.nl_entry_node,
        })),
    },
    1,
  );
}

/** The P6a reaches.geojson back as edges (our own output of the same job; size-capped all the same). */
export function readGraphDir(dir: string): { edges: Edge[]; osmStamp: string } {
  const path = join(dir, 'reaches.geojson');
  if (statSync(path).size > MAX_WAYS_BYTES) throw new InputError('graph_too_large', 0);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as {
    osm: { replication_timestamp: string };
    features: { geometry: { coordinates: [number, number][] }; properties: Omit<Edge, 'coords'> }[];
  };
  return {
    osmStamp: doc.osm.replication_timestamp,
    edges: doc.features.map((f) => ({ ...f.properties, coords: f.geometry.coordinates })),
  };
}

export function writeOutputs(out: string, placed: Placed, rivers: RiversFile, version: string, osmStamp: string) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `reaches-${version}.json`), canonicalJson(reachesFile(placed, rivers, version, osmStamp)));
  writeFileSync(
    join(out, `rivers-${version}.geojson.gz`),
    gzipSync(Buffer.from(downloadText(placed, rivers, version, osmStamp)), { level: 9 }),
  );
  writeFileSync(join(out, 'rivers.geojsonseq'), `${lineFeatures(placed, rivers).join('\n')}\n`);
  writeFileSync(join(out, 'snap-report.json'), snapReport(placed, version, osmStamp));
  writeFileSync(join(out, 'VERSION'), `${version}\n`);
}

const USAGE =
  'usage: node tools/geo/rivernet/outputs.ts --graph <dir> --version <YYYYMMDD> --out <dir> [--nonpublic <file>]';

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i] ?? '';
    const v = args[i + 1];
    if (!['--graph', '--version', '--out', '--nonpublic'].includes(k) || v === undefined || k.slice(2) in opt) {
      console.error(USAGE);
      process.exit(64);
    }
    opt[k.slice(2)] = v;
  }
  const { graph, version, out, nonpublic } = opt;
  if (graph === undefined || version === undefined || out === undefined || !RIVERS_VERSION_RE.test(version)) {
    console.error(USAGE);
    process.exit(64);
  }
  try {
    const rivers = readRivers();
    const { edges, osmStamp } = readGraphDir(graph);
    const stations = readStations();
    const placed = place(edges, rivers, stations, readOverrides(rivers));
    writeOutputs(out, placed, rivers, version, osmStamp);
    if (nonpublic !== undefined)
      writeFileSync(
        nonpublic,
        placed.stations
          .filter((s) => !s.public)
          .map((s) => `"${s.id}"\n`)
          .join(''),
      );
    const shown = placed.stations.filter((s) => s.public && s.river !== null).length;
    console.log(`outputs: ${placed.reaches.length} reaches, ${shown} public stations placed, version ${version}`);
  } catch (err) {
    if (err instanceof BuildError || err instanceof InputError) console.error(`outputs: ${err.message}`);
    else console.error('outputs: unexpected error', err instanceof Error ? err.name : '');
    process.exitCode = 1;
  }
}
