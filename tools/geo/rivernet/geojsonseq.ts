// Streaming readers for `osmium export -f geojsonseq`: the ways of the river extract (`-a type,id,way_nodes`, one
// LineString Feature per way) and, P17b, the water-body areas (`-a type,id --geometry-types=polygon`, one Polygon or
// MultiPolygon Feature per area). Input is untrusted: every limit is checked before the bytes are kept, and errors
// carry a fixed code and a line number only.

export class InputError extends Error {
  readonly code: string;
  readonly line: number;
  constructor(code: string, line: number) {
    super(`${code} at line ${line}`);
    this.name = 'InputError';
    this.code = code;
    this.line = line;
  }
}

export interface SeqCaps {
  maxLineBytes: number;
  maxTotalBytes: number;
  maxTags: number;
  maxTagChars: number;
  maxWayNodes: number;
}

export const SEQ_CAPS: SeqCaps = {
  maxLineBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 ** 3,
  maxTags: 200,
  maxTagChars: 255,
  maxWayNodes: 2000,
};

/** P17b: the caps of the water-body export, one area per line. */
export interface AreaCaps {
  maxLineBytes: number;
  maxTotalBytes: number;
  maxTags: number;
  maxTagChars: number;
  /** Positions of one area, all rings. */
  maxVertices: number;
  /** Rings of one area, outer and inner. */
  maxRings: number;
}

// Measured on the export of geo.yml run 39238147583 (P17b): 18 areas, 2.4 MB in all, at most 18,866 positions (the
// IJsselmeer). The total bounds the memory of all areas together (review R2-1): 64 MiB is 25 times the real export.
// A big lake's relation can carry a name:<lang> tag for every language.
export const AREA_CAPS: AreaCaps = {
  maxLineBytes: 16 * 1024 ** 2,
  maxTotalBytes: 64 * 1024 ** 2,
  maxTags: 1000,
  maxTagChars: 255,
  maxVertices: 2_000_000,
  maxRings: 20_000,
};

export interface WayFeature {
  id: number;
  nodes: number[];
  coords: [number, number][];
  tags: Record<string, string>;
}

/** An OSM area: its original object (a closed way or a multipolygon relation) and its geometry; tags are dropped. */
export interface AreaFeature {
  type: 'relation' | 'way';
  id: number;
  /** Polygons → rings (the first the outer ring, the rest holes) → [lon, lat]; every ring closed, 4 positions or more. */
  polygons: [number, number][][][];
}

const RS = 0x1e;
const LF = 0x0a;
const CR = 0x0d;
const FEATURE_KEYS = new Set(['type', 'geometry', 'properties', 'id']);
const AT_KEYS = new Set(['@type', '@id', '@way_nodes']);
const AREA_AT_KEYS = new Set(['@type', '@id']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const inRange = (v: unknown, lim: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;

function toWay(value: unknown, caps: SeqCaps, line: number): WayFeature {
  const bad = () => new InputError('bad_feature', line);
  if (!isObject(value) || !Object.keys(value).every((k) => FEATURE_KEYS.has(k)) || value.type !== 'Feature')
    throw bad();
  const { geometry, properties } = value;
  if (!isObject(geometry) || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) throw bad();
  if (!isObject(properties) || properties['@type'] !== 'way' || !isId(properties['@id'])) throw bad();
  const coordinates: unknown[] = geometry.coordinates;
  const nodes = properties['@way_nodes'];
  if (!Array.isArray(nodes) || nodes.length !== coordinates.length) throw bad();
  if (nodes.length < 2 || nodes.length > caps.maxWayNodes || !nodes.every(isId)) throw bad();
  const coords: [number, number][] = [];
  for (const c of coordinates) {
    if (!Array.isArray(c) || c.length !== 2 || !inRange(c[0], 180) || !inRange(c[1], 90)) throw bad();
    coords.push([c[0], c[1]]);
  }
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(properties)) {
    if (k.startsWith('@')) {
      if (!AT_KEYS.has(k)) throw bad();
      continue;
    }
    if (typeof v !== 'string' || k.length > caps.maxTagChars || v.length > caps.maxTagChars) throw bad();
    entries.push([k, v]);
  }
  if (entries.length > caps.maxTags) throw bad();
  // fromEntries defines own properties, so a tag named __proto__ stays data
  return { id: properties['@id'], nodes: nodes as number[], coords, tags: Object.fromEntries(entries) };
}

function toArea(value: unknown, caps: AreaCaps, line: number): AreaFeature {
  const bad = () => new InputError('bad_feature', line);
  if (!isObject(value) || !Object.keys(value).every((k) => FEATURE_KEYS.has(k)) || value.type !== 'Feature')
    throw bad();
  const { geometry, properties } = value;
  if (!isObject(geometry) || !Array.isArray(geometry.coordinates)) throw bad();
  let raw: unknown[];
  if (geometry.type === 'Polygon') raw = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') raw = geometry.coordinates;
  else throw bad();
  if (!isObject(properties) || !isId(properties['@id'])) throw bad();
  const type = properties['@type'];
  if (type !== 'way' && type !== 'relation') throw bad();
  // Tags are checked like a way's and then dropped: no OSM text (a name) leaves the reader.
  let tags = 0;
  for (const [k, v] of Object.entries(properties)) {
    if (k.startsWith('@')) {
      if (!AREA_AT_KEYS.has(k)) throw bad();
      continue;
    }
    if (typeof v !== 'string' || k.length > caps.maxTagChars || v.length > caps.maxTagChars) throw bad();
    tags++;
  }
  if (tags > caps.maxTags || raw.length === 0) throw bad();
  let rings = 0;
  let vertices = 0;
  const polygons: [number, number][][][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length === 0) throw bad();
    rings += p.length;
    if (rings > caps.maxRings) throw new InputError('too_many_rings', line);
    const polygon: [number, number][][] = [];
    for (const r of p) {
      if (!Array.isArray(r) || r.length < 4) throw bad();
      vertices += r.length;
      if (vertices > caps.maxVertices) throw new InputError('too_many_vertices', line);
      const ring: [number, number][] = [];
      for (const c of r) {
        if (!Array.isArray(c) || c.length !== 2 || !inRange(c[0], 180) || !inRange(c[1], 90)) throw bad();
        ring.push([c[0], c[1]]);
      }
      const first = ring[0] as [number, number];
      const last = ring[ring.length - 1] as [number, number];
      if (first[0] !== last[0] || first[1] !== last[1]) throw bad();
      polygon.push(ring);
    }
    polygons.push(polygon);
  }
  return { type, id: properties['@id'], polygons };
}

/** One line's JSON value, or null for an empty line (an RS alone, a CR alone). */
function parseLine(bytes: Uint8Array, line: number): { value: unknown } | null {
  let start = 0;
  let end = bytes.length;
  if (bytes[0] === RS) start = 1;
  if (end > start && bytes[end - 1] === CR) end--;
  if (end === start) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
  } catch {
    throw new InputError('bad_utf8', line);
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    throw new InputError('bad_json', line);
  }
}

/** The JSON values of a GeoJSONSeq byte stream with their line numbers (1-based); empty lines are skipped. */
async function* jsonLines(
  chunks: AsyncIterable<Uint8Array>,
  c: { maxLineBytes: number; maxTotalBytes: number },
): AsyncGenerator<[unknown, number]> {
  let parts: Uint8Array[] = [];
  let held = 0;
  let total = 0;
  let line = 1;

  const take = (piece: Uint8Array): void => {
    held += piece.length;
    if (held > c.maxLineBytes) throw new InputError('line_too_long', line);
    parts.push(piece);
  };
  const flush = (): [unknown, number] | null => {
    const bytes = parts.length === 1 ? (parts[0] as Uint8Array) : Buffer.concat(parts);
    parts = [];
    held = 0;
    const n = line++;
    const parsed = parseLine(bytes, n);
    return parsed === null ? null : [parsed.value, n];
  };

  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > c.maxTotalBytes) throw new InputError('input_too_large', line);
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(LF, pos);
      if (nl < 0) {
        take(chunk.subarray(pos));
        break;
      }
      take(chunk.subarray(pos, nl));
      pos = nl + 1;
      const v = flush();
      if (v) yield v;
    }
  }
  if (held > 0) {
    const v = flush();
    if (v) yield v;
  }
}

export async function* readGeoJsonSeq(
  chunks: AsyncIterable<Uint8Array>,
  caps: Partial<SeqCaps> = {},
): AsyncGenerator<WayFeature> {
  const c: SeqCaps = { ...SEQ_CAPS, ...caps };
  for await (const [value, line] of jsonLines(chunks, c)) yield toWay(value, c, line);
}

/** P17b: the areas of the water-body export (Polygon or MultiPolygon, `@type` way or relation and `@id` only). */
export async function* readAreaSeq(
  chunks: AsyncIterable<Uint8Array>,
  caps: Partial<AreaCaps> = {},
): AsyncGenerator<AreaFeature> {
  const c: AreaCaps = { ...AREA_CAPS, ...caps };
  for await (const [value, line] of jsonLines(chunks, c)) yield toArea(value, c, line);
}
