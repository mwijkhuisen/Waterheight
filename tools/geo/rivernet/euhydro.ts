import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { captureEnv, captureUserAgent } from '../../../apps/server/src/capture/env.ts';
import { boundedJson } from '../../../packages/core/src/json.ts';
import { ATTRIBUTION, ATTRIBUTION_URL, LICENCE } from './build.ts';

// EU-Hydro QA (P6a, CI only): the digitised direction of every OSM reach is checked against EU-Hydro v1.3 segments
// read through the EEA ArcGIS REST service. Only segment ids and verdicts are kept; no EU-Hydro geometry is written
// and no provider text (`nameText`) is requested. Errors carry fixed codes only (invariant 3).

export type EuHydroConfig = {
  base_url: string;
  layers: number[];
  max_requests: number;
  min_interval_ms: number;
  timeout_ms: number;
  max_body_bytes: number;
  max_minutes: number;
};
export type Bbox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat
export type Segment = {
  objectId: string;
  nextDownId: string | null;
  strahler: number | null;
  paths: [number, number][][];
};
export type Deps = {
  userAgent: string;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
};
export type FetchResult = {
  segments: Segment[];
  requests: number;
  complete: boolean;
  layers_done: number[];
  error?: string;
};

export const EUHYDRO_CODES = [
  'euhydro_http',
  'euhydro_error',
  'euhydro_body_too_large',
  'euhydro_bad_json',
  'euhydro_bad_shape',
] as const;

export class EuHydroError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'EuHydroError';
    this.code = code;
  }
}

export const PAGE_SIZE = 1000;
// About 3.5 times the 113k features of layers 5 to 12 in the basin bbox (2026-10-02): past it the QA stops.
export const MAX_SEGMENTS = 400_000;
const OUT_FIELDS = 'OBJECT_ID,NEXTDOWNID,STRAHLER';
const JSON_CAPS = { maxNodes: 8_000_000, maxDepth: 12 };

const id = z.string().min(1).max(64);
const point = z
  .array(z.number())
  .min(2)
  .max(4)
  .transform((p): [number, number] => [p[0] as number, p[1] as number]);
const featureSchema = z.object({
  attributes: z.object({
    OBJECT_ID: id,
    NEXTDOWNID: id.nullish(),
    STRAHLER: z.number().int().min(0).max(20).nullish(),
  }),
  geometry: z.object({ paths: z.array(z.array(point).min(2).max(100_000)).min(1).max(1000) }),
});
// 2000 is twice the layers' maxRecordCount; the length is checked before an element is parsed.
const pageSchema = z.object({
  features: z.array(z.unknown()).max(2 * PAGE_SIZE),
  exceededTransferLimit: z.boolean().optional(),
});

export type Page = { segments: Segment[]; exceeded: boolean };

/** One response body to its segments. Throws EuHydroError with a fixed code, whatever the input. */
export function parsePage(text: string): Page {
  let doc: unknown;
  try {
    doc = boundedJson(text, JSON_CAPS);
  } catch {
    throw new EuHydroError('euhydro_bad_json');
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new EuHydroError('euhydro_bad_shape');
  if ('error' in doc) throw new EuHydroError('euhydro_error');
  const page = pageSchema.safeParse(doc);
  if (!page.success) throw new EuHydroError('euhydro_bad_shape');
  const segments: Segment[] = page.data.features.map((raw) => {
    const f = featureSchema.safeParse(raw);
    if (!f.success) throw new EuHydroError('euhydro_bad_shape');
    const { attributes: a, geometry } = f.data;
    return {
      objectId: a.OBJECT_ID,
      nextDownId: a.NEXTDOWNID ?? null,
      strahler: a.STRAHLER ?? null,
      paths: geometry.paths,
    };
  });
  return { segments, exceeded: page.data.exceededTransferLimit === true };
}

export function queryUrl(cfg: EuHydroConfig, layer: number, bbox: Bbox, offset: number): string {
  const q = new URLSearchParams({
    where: '1=1',
    geometry: bbox.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    maxAllowableOffset: '0.0002',
    geometryPrecision: '6',
    orderByFields: 'OBJECTID',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'json',
  });
  return `${cfg.base_url}/${layer}/query?${q}`;
}

/** One request: status, host and size checked, the body returned as text. Throws EuHydroError. */
export async function getBody(url: string, cfg: EuHydroConfig, deps: Deps): Promise<{ status: number; text: string }> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { 'user-agent': deps.userAgent, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
  } catch {
    throw new EuHydroError('euhydro_http');
  }
  try {
    if (res.url && new URL(res.url).host !== new URL(cfg.base_url).host) throw new EuHydroError('euhydro_http');
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > cfg.max_body_bytes) throw new EuHydroError('euhydro_body_too_large');
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      // A manual reader: the cancel of an over-cap body is never awaited (a for-await would wait for it).
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cfg.max_body_bytes) {
          void reader.cancel().catch(() => {});
          throw new EuHydroError('euhydro_body_too_large');
        }
        chunks.push(value);
      }
    }
    return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
  } catch (e) {
    void res.body?.cancel().catch(() => {});
    throw e instanceof EuHydroError ? e : new EuHydroError('euhydro_http');
  }
}

/**
 * Every segment of `cfg.layers` that meets `bbox`, paged, within the request budget, the request interval, the
 * wall-clock deadline (`max_minutes`: a request starts only before it) and `maxSegments`.
 */
export async function fetchSegments(
  bbox: Bbox,
  cfg: EuHydroConfig,
  deps: Deps,
  maxSegments = MAX_SEGMENTS,
): Promise<FetchResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + cfg.max_minutes * 60_000;
  const out: FetchResult = { segments: [], requests: 0, complete: false, layers_done: [] };
  for (const layer of cfg.layers) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (out.requests >= cfg.max_requests) return out;
      if (out.requests > 0) await sleep(cfg.min_interval_ms);
      if (now() >= deadline) {
        out.error = 'euhydro_timeout';
        return out;
      }
      out.requests++;
      try {
        const { status, text } = await getBody(queryUrl(cfg, layer, bbox, offset), cfg, deps);
        if (status !== 200) throw new EuHydroError('euhydro_http');
        // ArcGIS answers an error with HTTP 200 and an error object.
        const page = parsePage(text);
        out.segments.push(...page.segments);
        if (out.segments.length > maxSegments) {
          out.error = 'euhydro_too_many_segments';
          return out;
        }
        if (!page.exceeded) break;
      } catch (e) {
        out.error = e instanceof EuHydroError ? e.code : 'euhydro_http';
        return out;
      }
    }
    out.layers_done.push(layer);
  }
  out.complete = true;
  return out;
}

// ---------------------------------------------------------------- direction comparison

export type Edge = { id: string; way: number; rivers: string[]; coords: [number, number][] };
export type Disagreement = { edge: string; way: number; rivers: string[]; segments: string[]; next_down: string[] };
export type Comparison = {
  agree: number;
  disagree: number;
  unmatched: number;
  agreement_pct: number | null;
  disagreements: Disagreement[];
  unmatched_edges: string[];
};

const M_PER_DEG = 111_195;
const SAMPLE_M = 100;
const TANGENT_M = 50;
const MATCH_M = 200;

// One straight piece of a segment's path, with its own unit direction in digitised order.
type Piece = { ax: number; ay: number; bx: number; by: number; dx: number; dy: number; seg: number };

const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/**
 * Edges (drawn downstream) against EU-Hydro segments (digitised downstream): each sample's tangent against the
 * direction of the piece of the segment it matched, never the segment's chord (a meander's chord can point anywhere).
 * Strahler plays no part.
 */
export function compareDirections(edges: Edge[], segments: Segment[]): Comparison {
  let lonSum = 0;
  let latSum = 0;
  let n = 0;
  for (const e of edges) {
    for (const [lon, lat] of e.coords) {
      lonSum += lon;
      latSum += lat;
      n++;
    }
  }
  const lon0 = n ? lonSum / n : 0;
  const lat0 = n ? latSum / n : 0;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const proj = ([lon, lat]: [number, number]): [number, number] => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG];

  // Grid of 200 m cells: a piece goes into every cell of its box, a query reads the 3 x 3 cells around the sample.
  const grid = new Map<string, Piece[]>();
  const cell = (v: number) => Math.floor(v / MATCH_M);
  segments.forEach((s, seg) => {
    for (const path of s.paths) {
      for (let i = 1; i < path.length; i++) {
        const [ax, ay] = proj(path[i - 1] as [number, number]);
        const [bx, by] = proj(path[i] as [number, number]);
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue; // a repeated vertex has no direction
        const piece: Piece = { ax, ay, bx, by, dx: (bx - ax) / len, dy: (by - ay) / len, seg };
        for (let cx = cell(Math.min(ax, bx)); cx <= cell(Math.max(ax, bx)); cx++) {
          for (let cy = cell(Math.min(ay, by)); cy <= cell(Math.max(ay, by)); cy++) {
            const k = `${cx},${cy}`;
            const list = grid.get(k);
            if (list) list.push(piece);
            else grid.set(k, [piece]);
          }
        }
      }
    }
  });

  const nearest = (x: number, y: number): Piece | null => {
    let best: Piece | null = null;
    let bestD = MATCH_M;
    const seen = new Set<Piece>();
    for (let cx = cell(x) - 1; cx <= cell(x) + 1; cx++) {
      for (let cy = cell(y) - 1; cy <= cell(y) + 1; cy++) {
        for (const p of grid.get(`${cx},${cy}`) ?? []) {
          if (seen.has(p)) continue;
          seen.add(p);
          const vx = p.bx - p.ax;
          const vy = p.by - p.ay;
          const l2 = vx * vx + vy * vy;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - p.ax) * vx + (y - p.ay) * vy) / l2));
          const d = Math.hypot(x - (p.ax + t * vx), y - (p.ay + t * vy));
          if (d <= bestD) {
            best = p;
            bestD = d;
          }
        }
      }
    }
    return best;
  };

  let agree = 0;
  let disagree = 0;
  let unmatched = 0;
  const disagreements: Disagreement[] = [];
  const unmatchedEdges: string[] = [];
  for (const e of edges) {
    const pts = e.coords.map(proj);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as [number, number];
      const b = pts[i] as [number, number];
      cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[cum.length - 1] as number;
    if (!(total > 0)) {
      unmatched++;
      unmatchedEdges.push(e.id);
      continue;
    }
    const pointAt = (s: number): [number, number] => {
      const c = Math.max(0, Math.min(total, s));
      let i = 1;
      while (i < cum.length - 1 && (cum[i] as number) < c) i++;
      const a = pts[i - 1] as [number, number];
      const b = pts[i] as [number, number];
      const span = (cum[i] as number) - (cum[i - 1] as number);
      const t = span === 0 ? 0 : (c - (cum[i - 1] as number)) / span;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    };
    const samples = Math.max(1, Math.round(total / SAMPLE_M));
    let ok = 0;
    let bad = 0;
    const badSegs = new Set<number>();
    for (let i = 0; i < samples; i++) {
      const s = ((i + 0.5) * total) / samples;
      const [x, y] = pointAt(s);
      const p = nearest(x, y);
      if (!p) continue;
      const [x0, y0] = pointAt(s - TANGENT_M);
      const [x1, y1] = pointAt(s + TANGENT_M);
      const dot = (x1 - x0) * p.dx + (y1 - y0) * p.dy;
      if (dot > 0) ok++;
      else if (dot < 0) {
        bad++;
        badSegs.add(p.seg);
      }
    }
    if ((ok + bad) * 2 < samples) {
      unmatched++;
      unmatchedEdges.push(e.id);
    } else if (ok > bad) agree++;
    else {
      // A tie is reported as a disagreement: a person looks at it.
      disagree++;
      const segs = [...badSegs].map((i) => segments[i] as Segment);
      disagreements.push({
        edge: e.id,
        way: e.way,
        rivers: e.rivers,
        segments: uniqSorted(segs.map((s) => s.objectId)),
        next_down: uniqSorted(segs.flatMap((s) => (s.nextDownId ? [s.nextDownId] : []))),
      });
    }
  }
  disagreements.sort((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0));
  const decided = agree + disagree;
  return {
    agree,
    disagree,
    unmatched,
    agreement_pct: decided === 0 ? null : Math.round((agree / decided) * 10000) / 100,
    disagreements,
    unmatched_edges: unmatchedEdges.sort(),
  };
}

// ---------------------------------------------------------------- report and CLI

export const SOURCE_TEXT =
  'EU-Hydro River Network Database v1.3, © European Union, Copernicus Land Monitoring Service (https://land.copernicus.eu/)';
export const MODIFICATIONS_TEXT =
  'Queried through the EEA ArcGIS REST service, generalised server-side (maxAllowableOffset 0.0002°); only segment identifiers and direction verdicts are kept; no EU-Hydro geometry is published';
export const ENDORSEMENT_TEXT = 'No endorsement by the European Union is implied';
export const AGREEMENT_BASIS = 'edges matched within 200 m (agree + disagree); unmatched edges are listed separately';

/** JSON with sorted keys and 2-space indent. */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x !== null && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

const reachesSchema = z.object({
  features: z.array(
    z.object({
      geometry: z.object({ coordinates: z.array(point).min(2) }),
      properties: z.object({ id: z.string(), way: z.number(), rivers: z.array(z.string()) }),
    }),
  ),
});

// build-report.json as euhydro.ts embeds it: every river's `relation_tags` (OSM name strings, the local review
// seed) is dropped, so the published qa-report.json carries counts and our own ids only.
const buildReportSchema = z.looseObject({ rivers: z.array(z.looseObject({})) });
export const publishedBuild = (report: unknown) => {
  const r = buildReportSchema.parse(report);
  return { ...r, rivers: r.rivers.map(({ relation_tags: _, ...river }) => river) };
};

export const readEdges = (file: string): Edge[] =>
  reachesSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).features.map((f) => ({
    id: f.properties.id,
    way: f.properties.way,
    rivers: f.properties.rivers,
    coords: f.geometry.coordinates,
  }));

export function edgesBbox(edges: Edge[], pad = 0.01): Bbox {
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of edges)
    for (const [lon, lat] of e.coords) {
      b[0] = Math.min(b[0], lon);
      b[1] = Math.min(b[1], lat);
      b[2] = Math.max(b[2], lon);
      b[3] = Math.max(b[3], lat);
    }
  return b.map((v, i) => Number((i < 2 ? v - pad : v + pad).toFixed(6))) as Bbox;
}

const parseBbox = (s: string): Bbox | null => {
  const p = s.split(',').map(Number);
  return p.length === 4 &&
    p.every(Number.isFinite) &&
    (p[0] as number) < (p[2] as number) &&
    (p[1] as number) < (p[3] as number)
    ? (p as Bbox)
    : null;
};

export type MainOpts = { cfg?: EuHydroConfig; deps?: Partial<Omit<Deps, 'userAgent'>> };

/** The CLI. Exit codes: 0 (also when the QA is incomplete), 1 unreadable input or failed record, 64 usage, 78 no contact env. */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  opts: MainOpts = {},
): Promise<number> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith('--') || v === undefined || flags.has(k)) return 64;
    flags.set(k, v);
  }
  const dir = flags.get('--dir');
  const record = flags.get('--record');
  const allowed = record ? ['--record', '--layer', '--bbox', '--name'] : ['--dir', '--budget'];
  if (!!dir === !!record || [...flags.keys()].some((k) => !allowed.includes(k))) return 64;
  const budget = flags.get('--budget');
  if (budget !== undefined && !/^[1-9][0-9]{0,5}$/.test(budget)) return 64;
  const layer = flags.get('--layer');
  const rbbox = flags.get('--bbox');
  const name = flags.get('--name');
  if (record && !(layer && /^[0-9]{1,3}$/.test(layer) && rbbox && parseBbox(rbbox))) return 64;
  if (name !== undefined && !/^[a-z0-9][a-z0-9.-]{0,60}\.json$/.test(name)) return 64;

  const ce = captureEnv(env);
  if (typeof ce === 'string') {
    console.error('euhydro: RWS_DOMAIN and RWS_CONTACT_EMAIL are required');
    return 78;
  }
  const base = opts.cfg ?? (await import('./sources.ts')).readSources().euhydro;
  const cfg: EuHydroConfig = { ...base, ...(budget ? { max_requests: Number(budget) } : {}) };
  const deps: Deps = { ...opts.deps, userAgent: captureUserAgent(ce) };

  if (record) {
    if (env.CI) {
      console.error('euhydro: --record refuses to run under CI');
      return 64;
    }
    try {
      const bbox = parseBbox(rbbox as string) as Bbox;
      const { text } = await getBody(queryUrl(cfg, Number(layer), bbox, 0), cfg, deps);
      mkdirSync(record, { recursive: true });
      writeFileSync(join(record, name ?? `l${layer}-${bbox.join('_')}.json`), text);
      return 0;
    } catch (e) {
      console.error(`euhydro: ${e instanceof EuHydroError ? e.code : 'euhydro_http'}`);
      return 1;
    }
  }

  let edges: Edge[];
  let build: unknown;
  try {
    edges = readEdges(join(dir as string, 'reaches.geojson'));
    build = publishedBuild(JSON.parse(readFileSync(join(dir as string, 'build-report.json'), 'utf8')));
    if (edges.length === 0) throw new Error('no_edges');
  } catch {
    console.error('euhydro: reaches.geojson or build-report.json is unreadable');
    return 1;
  }
  const fetched = await fetchSegments(edgesBbox(edges), cfg, deps);
  const cmp = compareDirections(edges, fetched.segments);
  const report = {
    attribution: ATTRIBUTION,
    attribution_url: ATTRIBUTION_URL,
    licence: LICENCE,
    schema_version: 1,
    build,
    euhydro: {
      source: SOURCE_TEXT,
      modifications: MODIFICATIONS_TEXT,
      endorsement: ENDORSEMENT_TEXT,
      agreement_basis: AGREEMENT_BASIS,
      requests: fetched.requests,
      complete: fetched.complete,
      ...(fetched.error ? { error: fetched.error } : {}),
      layers: fetched.layers_done,
      ...cmp,
    },
  };
  writeFileSync(join(dir as string, 'qa-report.json'), canonicalJson(report));
  console.log(
    `euhydro: ${cmp.agree} agree, ${cmp.disagree} disagree, ${cmp.unmatched} unmatched, ${fetched.requests} requests, complete ${fetched.complete}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
