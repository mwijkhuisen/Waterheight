import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type RiversFile, validateRivers } from '../../../packages/contracts/src/rivers.ts';
import { InputError, readGeoJsonSeq, type WayFeature } from './geojsonseq.ts';
import { parseOplRelations, type Relation } from './opl.ts';

// The P6a river graph builder (ADR-0012, PHASES §5 P6): curated OSM waterway
// relations (registry/rivers.yaml) → a directed graph whose nodes are the OSM
// nodes where kept ways meet or end and whose edges are the ways as drawn
// (OSM ways point downstream, catalogue §5.3), split at every such node. A node
// may have several downstream edges (Pannerdensche Kop, IJsselkop); a cycle
// fails the build. The output is an ODbL derivative database (D15): it holds
// OSM ids, geometry and our river ids only, no OSM name strings and no station.
// Same input, same bytes: sorted keys and arrays, 7-decimal coordinates, no clock.

export const ROOT = join(import.meta.dirname, '..', '..', '..');
export const ATTRIBUTION = '© OpenStreetMap contributors';
export const ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
export const LICENCE = 'ODbL-1.0';

/** A build failure: a fixed code and our own ids (r…, w…, n… or river ids), never OSM text. */
export class BuildError extends Error {
  readonly code: string;
  readonly ids: string[];
  constructor(code: string, ids: string[]) {
    super(`${code}: ${ids.join(', ')}`);
    this.code = code;
    this.ids = ids;
  }
}

export interface Provenance {
  schema_version: 1;
  osmium: string;
  replication_timestamp: string;
  regions: { id: string; url: string; bytes: number; md5: string; sha256: string }[];
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  way: number;
  rivers: string[];
  length_m: number;
  coords: [number, number][];
}

// Roles counted by name in the report; any other role is counted as `other_role`
// (a role string is OSM text and never becomes a key of our output).
const KNOWN_ROLES = ['side_stream', 'tributary', 'spring', 'mouth'] as const;
// Relation tags copied into the build report as seeds for the reviewed names.
const SEED_TAGS = ['type', 'waterway', 'name', 'name:nl', 'name:en', 'name:de', 'name:fr', 'wikidata'] as const;

const round7 = (x: number) => Number(x.toFixed(7));
const byNumber = (a: number, b: number) => a - b;
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function haversine([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface RiverSelection {
  kept: Set<number>;
  members: Record<string, number>;
  relationTags: Record<string, string> | null;
}

/** Which ways of `ways` belong to `river`, and why the others do not (counts only). */
function selectWays(
  river: RiversFile['rivers'][number],
  relation: Relation | undefined,
  ways: ReadonlyMap<number, WayFeature>,
): RiverSelection {
  const drop = new Set((river.drop_ways ?? []).map((d) => d.id));
  const members: Record<string, number> = {};
  const count = (k: string) => {
    members[k] = (members[k] ?? 0) + 1;
  };
  const kept = new Set<number>();
  if (relation === undefined) {
    // A documented way selection: waterway ways tagged with the river's Wikidata id and its name.
    for (const [id, way] of ways) {
      if (way.tags.waterway === undefined || way.tags.wikidata !== river.wikidata) continue;
      if (way.tags.name !== river.osm_way_name) continue;
      if (drop.has(id)) count('drop_ways');
      else kept.add(id);
    }
    members.selected = kept.size;
    return { kept, members, relationTags: null };
  }
  const main = new Set<number>();
  const empty = new Set<number>();
  for (const m of relation.members) {
    if (m.type === 'n') count('nodes');
    else if (m.type === 'r') count('child_relations');
    else if (drop.has(m.ref)) count('drop_ways');
    else if (!ways.has(m.ref)) count('missing');
    else if (ways.get(m.ref)?.tags.waterway === undefined) count('not_waterway');
    else if (m.role === 'main_stream') main.add(m.ref);
    else if (m.role === '') empty.add(m.ref);
    else count((KNOWN_ROLES as readonly string[]).includes(m.role) ? m.role : 'other_role');
  }
  members.main_stream = main.size;
  for (const id of main) kept.add(id);
  if (main.size === 0) {
    // No main_stream at all: the relation does not use roles, so every empty-role way is its stem.
    for (const id of empty) kept.add(id);
    members.empty_role_kept = empty.size;
    return { kept, members, relationTags: relation.tags };
  }
  // Empty-role ways that connect to the main stream through shared nodes, transitively.
  const byNode = new Map<number, number[]>();
  for (const id of empty) {
    for (const n of ways.get(id)?.nodes ?? []) byNode.set(n, [...(byNode.get(n) ?? []), id]);
  }
  const queue = [...main].flatMap((id) => ways.get(id)?.nodes ?? []);
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const n = queue.pop() as number;
    for (const id of byNode.get(n) ?? []) {
      if (kept.has(id)) continue;
      kept.add(id);
      for (const m of ways.get(id)?.nodes ?? []) {
        if (!seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
      }
    }
  }
  members.empty_role_kept = kept.size - main.size;
  members.empty_role_disconnected = empty.size - members.empty_role_kept;
  return { kept, members, relationTags: relation.tags };
}

/** Throws BuildError('cycle', way ids) if the edges contain a directed cycle. */
export function checkAcyclic(edges: readonly Edge[]): void {
  const indegree = new Map<string, number>();
  const out = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const e of edges) {
    indegree.set(e.from, indegree.get(e.from) ?? 0);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  }
  const queue = [...indegree].filter(([, d]) => d === 0).map(([n]) => n);
  let done = 0;
  while (queue.length > 0) {
    const n = queue.pop() as string;
    done++;
    for (const e of out.get(n) ?? []) {
      const d = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  if (done === indegree.size) return;
  // Every node left has an incoming edge from another node left, so walking
  // backwards from the smallest one must close a loop: that loop is a cycle.
  const left = new Set([...indegree].filter(([, d]) => d > 0).map(([n]) => n));
  const nodeNum = (n: string) => Number(n.slice(1));
  let at = [...left].sort((a, b) => nodeNum(a) - nodeNum(b))[0] as string;
  const path: Edge[] = [];
  const visited = new Map<string, number>();
  while (!visited.has(at)) {
    visited.set(at, path.length);
    const e = (incoming.get(at) ?? [])
      .filter((x) => left.has(x.from))
      .sort((a, b) => a.way - b.way || byString(a.id, b.id))[0] as Edge;
    path.push(e);
    at = e.from;
  }
  const loop = path.slice(visited.get(at)).reverse();
  throw new BuildError('cycle', [...new Set(loop.map((e) => `w${e.way}`))]);
}

export interface BuildResult {
  graph: unknown;
  reaches: unknown;
  report: unknown;
  edges: Edge[];
}

/** The pure core: ways, relations and the curated rivers in, graph, reaches and report out. */
export function buildGraph(
  ways: ReadonlyMap<number, WayFeature>,
  relations: readonly Relation[],
  rivers: RiversFile,
  provenance: Provenance,
): BuildResult {
  const relById = new Map(relations.map((r) => [r.id, r]));
  // Relations in the input that carry a river's Wikidata id: how a river without P402 finds its relation (report only).
  const byQid = new Map<string, number[]>();
  for (const r of relations) {
    const q = r.tags.wikidata;
    if (q !== undefined) byQid.set(q, [...(byQid.get(q) ?? []), r.id]);
  }
  const missing: string[] = [];
  const mismatch: string[] = [];
  const empty: string[] = [];
  const wayRivers = new Map<number, Set<string>>();
  const riverReports: Record<string, unknown>[] = [];
  for (const river of [...rivers.rivers].sort((a, b) => byString(a.id, b.id))) {
    const relation = river.osm_relation_id === null ? undefined : relById.get(river.osm_relation_id);
    if (river.osm_relation_id !== null && relation === undefined) {
      missing.push(`r${river.osm_relation_id}`);
      continue;
    }
    if (relation !== undefined && relation.tags.wikidata !== river.wikidata) mismatch.push(`r${relation.id}`);
    const sel = selectWays(river, relation, ways);
    if (sel.kept.size === 0) empty.push(river.id);
    for (const id of sel.kept) wayRivers.set(id, (wayRivers.get(id) ?? new Set()).add(river.id));
    const tags = sel.relationTags;
    riverReports.push({
      id: river.id,
      relation: river.osm_relation_id,
      relation_tags:
        tags === null ? null : Object.fromEntries(SEED_TAGS.filter((k) => k in tags).map((k) => [k, tags[k]])),
      members: sel.members,
      ways_kept: sel.kept.size,
      qid_relations: (byQid.get(river.wikidata) ?? []).filter((id) => id !== river.osm_relation_id).sort(byNumber),
    });
  }
  if (missing.length > 0) throw new BuildError('relation_missing', missing.sort());
  if (mismatch.length > 0) throw new BuildError('wikidata_mismatch', mismatch.sort());
  if (empty.length > 0) throw new BuildError('river_without_edges', empty.sort());

  // Graph nodes: the ends of every kept way and every node used more than once.
  const keptWays = [...wayRivers.keys()].sort(byNumber);
  const uses = new Map<number, number>();
  for (const id of keptWays) {
    for (const n of (ways.get(id) as WayFeature).nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  }
  const coordOf = new Map<number, [number, number]>();
  const edges: Edge[] = [];
  for (const id of keptWays) {
    const way = ways.get(id) as WayFeature;
    const rs = [...(wayRivers.get(id) as Set<string>)].sort(byString);
    const isNode = (i: number) => i === 0 || i === way.nodes.length - 1 || (uses.get(way.nodes[i] as number) ?? 0) > 1;
    let start = 0;
    let k = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      if (!isNode(i)) continue;
      const coords = way.coords.slice(start, i + 1).map(([x, y]) => [round7(x), round7(y)] as [number, number]);
      let length = 0;
      for (let j = start + 1; j <= i; j++) {
        length += haversine(way.coords[j - 1] as [number, number], way.coords[j] as [number, number]);
      }
      const from = way.nodes[start] as number;
      const to = way.nodes[i] as number;
      if (!coordOf.has(from)) coordOf.set(from, coords[0] as [number, number]);
      if (!coordOf.has(to)) coordOf.set(to, coords[coords.length - 1] as [number, number]);
      edges.push({
        id: `w${id}.${k++}`,
        from: `n${from}`,
        to: `n${to}`,
        way: id,
        rivers: rs,
        length_m: Math.round(length * 10) / 10,
        coords,
      });
      start = i;
    }
  }
  checkAcyclic(edges);

  const nodes = [...coordOf.keys()].sort(byNumber);
  const outEdges = new Map<string, Edge[]>();
  const indeg = new Map<string, number>();
  for (const e of edges) {
    outEdges.set(e.from, [...(outEdges.get(e.from) ?? []), e]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const bifurcations = nodes
    .map((n) => `n${n}`)
    .filter((n) => (outEdges.get(n)?.length ?? 0) > 1)
    .map((n) => {
      const out = outEdges.get(n) as Edge[];
      return {
        node: n,
        coord: coordOf.get(Number(n.slice(1))),
        out: out.map((e) => e.id).sort(byString),
        rivers: [...new Set(out.flatMap((e) => e.rivers))].sort(byString),
      };
    });
  const osm = {
    osmium: provenance.osmium,
    replication_timestamp: provenance.replication_timestamp,
    regions: [...provenance.regions].sort((a, b) => byString(a.id, b.id)),
  };
  const head = { attribution: ATTRIBUTION, attribution_url: ATTRIBUTION_URL, licence: LICENCE, osm, schema_version: 1 };
  const edgeCount = (river: string) => edges.filter((e) => e.rivers.includes(river)).length;
  const graph = {
    ...head,
    rivers: rivers.rivers
      .map((r) => r.id)
      .sort(byString)
      .map((id) => ({ id, edges: edgeCount(id) })),
    nodes: nodes.map((n) => ({ id: `n${n}`, coord: coordOf.get(n) })),
    edges: edges.map(({ coords: _, ...e }) => e),
  };
  const reaches = {
    ...head,
    type: 'FeatureCollection',
    features: edges.map(({ coords, ...e }) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: e,
    })),
  };
  const report = {
    schema_version: 1,
    rivers: riverReports,
    graph: {
      nodes: nodes.length,
      edges: edges.length,
      sources: nodes.filter((n) => !indeg.has(`n${n}`)).length,
      sinks: nodes.filter((n) => !outEdges.has(`n${n}`)).length,
      components: components(nodes, edges),
      bifurcations,
    },
  };
  return { graph, reaches, report, edges };
}

/** Weakly connected components. */
function components(nodes: readonly number[], edges: readonly Edge[]): number {
  const parent = new Map(nodes.map((n) => [`n${n}`, `n${n}`]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) parent.set(find(e.from), find(e.to));
  return new Set(nodes.map((n) => find(`n${n}`))).size;
}

/** JSON with every object's keys sorted, so the bytes depend on the content only. */
export function canonicalJson(value: unknown, indent?: number): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort(byString)
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}

/** Reads the osmium GeoJSONSeq export; a way id twice is an error. */
export async function readWays(chunks: AsyncIterable<Uint8Array>): Promise<Map<number, WayFeature>> {
  const ways = new Map<number, WayFeature>();
  for await (const way of readGeoJsonSeq(chunks)) {
    if (ways.has(way.id)) throw new BuildError('duplicate_way', [`w${way.id}`]);
    ways.set(way.id, way);
  }
  return ways;
}

export function readRivers(path = join(ROOT, 'registry/rivers.yaml')): RiversFile {
  const { problems, rivers } = validateRivers(parse(readFileSync(path, 'utf8')));
  if (rivers === undefined) throw new BuildError('rivers_invalid', problems);
  return rivers;
}

export interface BuildFiles {
  ways: string;
  relations: string;
  provenance: string;
  rivers?: string;
}

export async function buildFromFiles(files: BuildFiles): Promise<BuildResult> {
  const ways = await readWays(createReadStream(files.ways));
  const relations = parseOplRelations(readFileSync(files.relations, 'utf8'));
  const provenance = JSON.parse(readFileSync(files.provenance, 'utf8')) as Provenance;
  return buildGraph(ways, relations, readRivers(files.rivers), provenance);
}

export function writeOutputs(dir: string, result: BuildResult): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'river_graph.json'), canonicalJson(result.graph));
  writeFileSync(join(dir, 'reaches.geojson'), canonicalJson(result.reaches));
  writeFileSync(join(dir, 'build-report.json'), canonicalJson(result.report, 2));
}

const USAGE =
  'usage: node tools/geo/rivernet/build.ts --ways <geojsonseq> --relations <opl> --provenance <json> [--rivers <yaml>] --out <dir>';

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i] ?? '';
    const v = args[i + 1];
    if (
      !['--ways', '--relations', '--provenance', '--rivers', '--out'].includes(k) ||
      v === undefined ||
      k.slice(2) in opt
    ) {
      console.error(USAGE);
      process.exit(64);
    }
    opt[k.slice(2)] = v;
  }
  const { ways, relations, provenance, rivers, out } = opt;
  if (ways === undefined || relations === undefined || provenance === undefined || out === undefined) {
    console.error(USAGE);
    process.exit(64);
  }
  try {
    const result = await buildFromFiles({ ways, relations, provenance, ...(rivers === undefined ? {} : { rivers }) });
    writeOutputs(out, result);
    const g = (
      result.report as { graph: { nodes: number; edges: number; components: number; bifurcations: unknown[] } }
    ).graph;
    console.log(
      `build: ${g.nodes} nodes, ${g.edges} edges, ${g.components} components, ${g.bifurcations.length} bifurcations`,
    );
  } catch (err) {
    if (err instanceof BuildError || err instanceof InputError) console.error(`build: ${err.message}`);
    else console.error('build: unexpected error', err instanceof Error ? err.name : '');
    process.exitCode = 1;
  }
}
