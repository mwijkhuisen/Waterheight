import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  checkReaches,
  ODBL_LICENCE,
  ODBL_URL,
  OSM_ATTRIBUTION,
  OSM_ATTRIBUTION_URL,
  REACHES_SCHEMA_VERSION,
  type ReachesFile,
  ReachesFile as ReachesSchema,
  RIVERS_VERSION_RE,
} from '../../../packages/contracts/src/reaches.ts';
import type { RiversFile } from '../../../packages/contracts/src/rivers.ts';
import { BIN_MINZOOM, binCount, binLines } from './bins.ts';
import { BuildError, canonicalJson, type Edge, MAX_WAYS_BYTES, readRivers } from './build.ts';
import { InputError } from './geojsonseq.ts';
import { byString } from './network.ts';
import { type Placed, place, readEmpirical, readOverrides } from './place.ts';
import { readStations } from './stations.ts';
import { loadWaterbodyInput, readWaterbodies, type WaterbodyInput } from './waterbodies.ts';

// The public P6b outputs (A§9.1; release assets of geo.yml):
//   reaches-<ver>.json       public reaches in graph order, public stations with km (ReachesFile); from P17b (schema 2)
//                            also the water bodies with their public stations, and the river mouths
//   rivers-<ver>.geojson.gz  the ODbL download: one line per reach, names, flags, then (P17b) the water bodies and the
//                            canal lines, each with `layer`; no station data
//   rivers.geojsonseq        the same lines for tippecanoe (rivers-<ver>.pmtiles layer `rivers`; not an asset)
//   reach-bins.geojsonseq    each drawn reach in 1…8 position bins (layer `reach_bins`, #112; not an asset)
//   waterbodies.geojsonseq   P17b: each water body's polygon, or its point (layer `waterbodies`; not an asset)
//   canals.geojsonseq        P17b: the canal edges, never in `rivers` (layer `canals`, D-3; not an asset)
//   snap-report.json         public stations per id; counts per rule of public-audience stations only
//   VERSION
// Only public stations appear in them (invariants 8, 11): owner and off
// stations got a reach in the placement but split nothing and are left out.
// Same input and version, same bytes.

export const LICENCE_NOTE =
  'The river network is derived from OpenStreetMap and is available under the ODbL 1.0. Station identifiers and kilometres are a separate collective database and are not covered by the ODbL.';

const km3 = (m: number) => Math.round(m) / 1000;
const km2 = (m: number) => Math.round(m / 10) / 100;
const byId = <T extends { id: string }>(a: T, b: T) => byString(a.id, b.id);

interface Feature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

/** The water bodies the placement read: every P17b writer needs them, so none writes without (fail closed). */
function bodiesOf(placed: Placed): WaterbodyInput {
  if (placed.waterbodies === null) throw new BuildError('waterbodies_missing', []);
  return placed.waterbodies;
}

export function reachesFile(placed: Placed, rivers: RiversFile, version: string, osmStamp: string): ReachesFile {
  const used = new Set(placed.reaches.map((r) => r.river));
  const stations = placed.stations.filter((s) => s.public && s.river !== null).sort((a, b) => (a.id < b.id ? -1 : 1));
  const shown = new Set(placed.stations.filter((s) => s.public).map((s) => s.id));
  const bodies = [...bodiesOf(placed).file.waterbodies].sort(byId);
  const file: ReachesFile = {
    schema_version: REACHES_SCHEMA_VERSION,
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
    // Public stations only: an owner or off station in a lake is in no body's list (invariants 8 and 11).
    waterbodies: bodies.map((w) => {
      if (w.reference_station !== null && !shown.has(w.reference_station))
        throw new BuildError('reference_station_not_public', [w.id]);
      return {
        id: w.id,
        kind: w.kind,
        name_nl: w.name_nl,
        name_en: w.name_en,
        stations: placed.stations
          .filter((s) => s.public && s.waterbody === w.id)
          .map((s) => s.id)
          .sort(byString),
        reference_station_id: w.reference_station,
        outflows: w.outflows.map((o) => ({ to: o.to, via: o.via })),
      };
    }),
    mouths: (rivers.mouths ?? []).map((m) => ({ id: m.id, river_id: m.river, waterbody_id: m.waterbody })).sort(byId),
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

/**
 * The position bins of each drawn reach (#112): `reach_id`, `bin` (0-based), `seg` = `<reach_id>/<bin>` (the web's
 * promoteId, unique per bin) and `tidal`; tippecanoe keeps them from zoom BIN_MINZOOM on.
 */
function binFeatures(placed: Placed): string[] {
  return placed.reaches.flatMap((r) =>
    r.coords.length < 2
      ? []
      : binLines(r.coords, binCount(km3(r.length_m))).map((coords, bin) =>
          JSON.stringify({
            type: 'Feature',
            tippecanoe: { minzoom: BIN_MINZOOM },
            geometry: { type: 'LineString', coordinates: coords },
            properties: { reach_id: r.id, bin, seg: `${r.id}/${bin}`, tidal: r.flags.tidal },
          }),
        ),
  );
}

/** The `waterbodies` layer (P17b): each body's polygon, or its point when it is point-only; no station data. */
function waterbodyFeatures(placed: Placed): Feature[] {
  const wb = bodiesOf(placed);
  return [...wb.file.waterbodies].sort(byId).map((w) => {
    const area = wb.areas.get(w.id);
    let geometry: Feature['geometry'];
    if (w.osm === null && w.point !== undefined) geometry = { type: 'Point', coordinates: w.point };
    else if (w.osm !== null && area !== undefined) geometry = { type: 'MultiPolygon', coordinates: area.polygons };
    else throw new BuildError('waterbody_unassembled', [w.id]);
    return {
      type: 'Feature',
      geometry,
      properties: { waterbody_id: w.id, kind: w.kind, name_nl: w.name_nl, name_en: w.name_en },
    };
  });
}

/** The `canals` layer (P17b, D-3): one line per canal edge, named after its canal; never in `rivers`. */
function canalFeatures(placed: Placed, rivers: RiversFile): Feature[] {
  const canals = new Map(rivers.rivers.filter((r) => r.kind === 'canal').map((r) => [r.id, r]));
  return [...placed.canalEdges].sort(byId).map((e) => {
    const c = [...e.rivers]
      .sort(byString)
      .map((r) => canals.get(r))
      .find((r) => r !== undefined);
    if (c === undefined) throw new BuildError('canal_edge_without_canal', [e.id]);
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: e.coords },
      properties: { river_id: c.id, name_nl: c.name_nl, name_en: c.name_en, kind: 'canal' },
    };
  });
}

const seq = (features: Feature[]) => features.map((f) => `${JSON.stringify(f)}\n`).join('');
const inLayer = (layer: string) => (f: Feature) => JSON.stringify({ ...f, properties: { ...f.properties, layer } });

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
  const features = [
    ...lineFeatures(placed, rivers),
    ...waterbodyFeatures(placed).map(inLayer('waterbody')),
    ...canalFeatures(placed, rivers).map(inLayer('canal')),
  ];
  return `${head},"features":[\n${features.join(',\n')}\n]}\n`;
}

export function snapReport(placed: Placed, version: string, osmStamp: string): string {
  // Counts per rule of the shown stations and of the public-audience ones not shown (mirrors, sources without
  // `display`); owner and off stations are not counted at all, so the report does not depend on them.
  const counts: Record<string, Record<string, number>> = { public: {}, public_not_shown: {} };
  const waterbodyCounts: Record<string, Record<string, number>> = { public: {}, public_not_shown: {} };
  for (const s of placed.stations) {
    if (s.audience !== 'public') continue;
    const group = s.public ? 'public' : 'public_not_shown';
    const c = counts[group] as Record<string, number>;
    c[s.rule] = (c[s.rule] ?? 0) + 1;
    const w = waterbodyCounts[group] as Record<string, number>;
    if (s.waterbody_rule !== null) w[s.waterbody_rule] = (w[s.waterbody_rule] ?? 0) + 1;
  }
  return canonicalJson(
    {
      attribution: OSM_ATTRIBUTION,
      attribution_url: OSM_ATTRIBUTION_URL,
      licence: ODBL_LICENCE,
      version,
      osm_replication_timestamp: osmStamp,
      counts,
      waterbody_counts: waterbodyCounts,
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
          canal: s.canal,
          canal_distance_m: s.canal_distance_m,
          waterbody: s.waterbody,
          waterbody_rule: s.waterbody_rule,
          waterbody_distance_m: s.waterbody_distance_m,
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
  writeFileSync(join(out, 'reach-bins.geojsonseq'), `${binFeatures(placed).join('\n')}\n`);
  writeFileSync(join(out, 'waterbodies.geojsonseq'), seq(waterbodyFeatures(placed)));
  writeFileSync(join(out, 'canals.geojsonseq'), seq(canalFeatures(placed, rivers)));
  writeFileSync(join(out, 'snap-report.json'), snapReport(placed, version, osmStamp));
  writeFileSync(join(out, 'VERSION'), `${version}\n`);
}

const USAGE =
  'usage: node tools/geo/rivernet/outputs.ts --graph <dir> --waterbodies <geojsonseq[.gz]> --version <YYYYMMDD> --out <dir> [--nonpublic <file>]';

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i] ?? '';
    const v = args[i + 1];
    if (
      !['--graph', '--waterbodies', '--version', '--out', '--nonpublic'].includes(k) ||
      v === undefined ||
      k.slice(2) in opt
    ) {
      console.error(USAGE);
      process.exit(64);
    }
    opt[k.slice(2)] = v;
  }
  const { graph, waterbodies, version, out, nonpublic } = opt;
  if (
    graph === undefined ||
    waterbodies === undefined ||
    version === undefined ||
    out === undefined ||
    !RIVERS_VERSION_RE.test(version)
  ) {
    console.error(USAGE);
    process.exit(64);
  }
  try {
    const rivers = readRivers();
    const bodies = readWaterbodies(rivers);
    const input = await loadWaterbodyInput(bodies, waterbodies);
    const { edges, osmStamp } = readGraphDir(graph);
    const stations = readStations();
    const placed = place(edges, rivers, stations, readOverrides(rivers, bodies), readEmpirical(), input);
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
    const inBody = placed.stations.filter((s) => s.public && s.waterbody !== null).length;
    console.log(
      `outputs: ${placed.reaches.length} reaches, ${shown} public stations placed, ${bodies.waterbodies.length} water bodies (${inBody} public stations in one), ${placed.canalEdges.length} canal edges, version ${version}`,
    );
  } catch (err) {
    if (err instanceof BuildError || err instanceof InputError) console.error(`outputs: ${err.message}`);
    else console.error('outputs: unexpected error', err instanceof Error ? err.name : '');
    process.exitCode = 1;
  }
}
