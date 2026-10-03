// Streaming reader for `osmium export -f geojsonseq -a type,id,way_nodes` (one Feature per way).
// Input is untrusted: every limit is checked before the bytes are kept, and errors carry a fixed code and a line number only.

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

export interface WayFeature {
  id: number;
  nodes: number[];
  coords: [number, number][];
  tags: Record<string, string>;
}

const RS = 0x1e;
const LF = 0x0a;
const CR = 0x0d;
const FEATURE_KEYS = new Set(['type', 'geometry', 'properties', 'id']);
const AT_KEYS = new Set(['@type', '@id', '@way_nodes']);

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

function parseLine(bytes: Uint8Array, caps: SeqCaps, line: number): WayFeature | null {
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
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InputError('bad_json', line);
  }
  return toWay(json, caps, line);
}

export async function* readGeoJsonSeq(
  chunks: AsyncIterable<Uint8Array>,
  caps: Partial<SeqCaps> = {},
): AsyncGenerator<WayFeature> {
  const c: SeqCaps = { ...SEQ_CAPS, ...caps };
  let parts: Uint8Array[] = [];
  let held = 0;
  let total = 0;
  let line = 1;

  const take = (piece: Uint8Array): void => {
    held += piece.length;
    if (held > c.maxLineBytes) throw new InputError('line_too_long', line);
    parts.push(piece);
  };
  const flush = (): WayFeature | null => {
    const bytes = parts.length === 1 ? (parts[0] as Uint8Array) : Buffer.concat(parts);
    parts = [];
    held = 0;
    return parseLine(bytes, c, line++);
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
      const way = flush();
      if (way) yield way;
    }
  }
  if (held > 0) {
    const way = flush();
    if (way) yield way;
  }
}
