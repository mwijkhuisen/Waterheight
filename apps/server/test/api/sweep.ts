import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import type { Hono } from 'hono';
import type { Logger } from 'pino';

// Helpers of the P9b integration tests (S3): one request in each content coding, decoded; a deterministic pseudo-random
// stream; the grep every sweep uses; and a structural reader of the series ids a JSON body names.

export const CODINGS = ['identity', 'gzip', 'zstd'] as const;
export type Coding = (typeof CODINGS)[number];

/** A client address in the documentation range: not private, so the limiter (when a test passes one) keys on it. */
export const CLIENT = '203.0.113.9';

export type Req = {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS';
  path: string;
  body?: string;
  type?: string;
  /** What the request is for, in the failure message of a hit. */
  label: string;
};

export type Answer = {
  coding: Coding;
  status: number;
  /** The `Content-Encoding` the answer carried. */
  encoding: string | null;
  /** Every header, `name: value`, one per line (a header value is a byte a leak could ride on). */
  headers: string;
  headerMap: Record<string, string>;
  /** The decoded body. */
  text: string;
};

/** One request in one coding; the body is decompressed by the coding the answer says it has. */
export async function ask(app: Hono, req: Req, coding: Coding, client: string | undefined = CLIENT): Promise<Answer> {
  const headers: Record<string, string> = { 'accept-encoding': coding };
  if (client !== undefined) headers['x-rws-client'] = client;
  if (req.type !== undefined) headers['content-type'] = req.type;
  const res = await app.request(req.path, {
    method: req.method ?? 'GET',
    headers,
    ...(req.body === undefined ? {} : { body: req.body }),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const encoding = res.headers.get('content-encoding');
  const bytes =
    raw.length === 0
      ? raw
      : encoding === 'gzip'
        ? gunzipSync(raw)
        : encoding === 'zstd'
          ? zstdDecompressSync(raw)
          : raw;
  const headerMap: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerMap[k] = v;
  });
  return {
    coding,
    status: res.status,
    encoding,
    headers: Object.entries(headerMap)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    headerMap,
    text: bytes.toString('utf8'),
  };
}

/** A tagged piece of output: the thing a needle is searched in. */
export type Piece = { label: string; text: string; tags?: readonly string[] };
export type Hit = { label: string; needle: string };

/** Every (piece, needle) pair in which the needle occurs: a string as a substring, a RegExp by `test`. */
export function grep(pieces: readonly Piece[], needles: readonly (string | RegExp)[]): Hit[] {
  const hits: Hit[] = [];
  for (const p of pieces)
    for (const n of needles)
      if (typeof n === 'string' ? p.text.includes(n) : n.test(p.text)) hits.push({ label: p.label, needle: String(n) });
  return hits;
}

/** The series ids a parsed body names: a number under a `series` key (or in its array) and the `id` of a series row. */
export function seriesIdsOf(json: unknown, out: Set<number> = new Set()): Set<number> {
  if (Array.isArray(json)) {
    for (const x of json) seriesIdsOf(x, out);
  } else if (json !== null && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'series' && typeof v === 'number') out.add(v);
      else if (k === 'series' && Array.isArray(v))
        for (const x of v) typeof x === 'number' ? out.add(x) : seriesIdsOf(x, out);
      else seriesIdsOf(v, out);
    }
    // A station's series row and a /series answer: `id` beside a quantity or a resolution.
    if (typeof o.id === 'number' && ('quantity' in o || 'res' in o)) out.add(o.id);
  }
  return out;
}

/** mulberry32: a small deterministic generator, so a "random" instant is the same on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An instant as the API reads it: UTC, seconds and `Z`. */
export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A pino-like logger that keeps every call as one JSON line. */
export function captureLog(lines: string[]) {
  const keep = (...args: unknown[]) => {
    lines.push(JSON.stringify(args));
  };
  return { error: keep, info: keep } as unknown as Pick<Logger, 'error' | 'info'>;
}
