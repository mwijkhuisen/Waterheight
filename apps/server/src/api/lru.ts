import { constants, gzipSync, zstdCompressSync } from 'node:zlib';

/** Too many distinct keys are being computed at once: a 503 with Retry-After. */
export class Busy extends Error {
  constructor() {
    super('busy');
  }
}

/** The encodings an answer is stored in (P9b): the JSON, and lazily its gzip and zstd forms. */
export const ENCODINGS = ['zstd', 'gzip', 'identity'] as const;
export type Encoding = (typeof ENCODINGS)[number];

/**
 * The encoding of an answer from `Accept-Encoding`: zstd, else gzip, else identity, among the codings the client
 * accepts with q > 0. Anything else in the header is ignored (a closed set, never a key part of its own).
 */
export function negotiate(header: string | undefined): Encoding {
  if (header === undefined || header.length > 512) return 'identity';
  const ok = new Set<string>();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)).find((m) => m !== null);
    if (q !== undefined && !(Number(q?.[1]) > 0)) continue;
    if (name !== undefined) ok.add(name.trim());
  }
  if (ok.has('zstd')) return 'zstd';
  if (ok.has('gzip')) return 'gzip';
  return 'identity';
}

const encode = (json: Buffer, enc: Exclude<Encoding, 'identity'>): Buffer =>
  enc === 'gzip'
    ? gzipSync(json, { level: 6 })
    : zstdCompressSync(json, { params: { [constants.ZSTD_c_compressionLevel]: 3 } });

/**
 * What a computation returns: the JSON, an optional tag (the day versions it was read at; versions.ts) and an
 * optional cap on how long it may be kept (KG-114: a value leaving its history window).
 */
export type Computed = { json: string; tag?: string; capMs?: number };
type Entry = {
  json: Buffer;
  gzip?: Buffer;
  zstd?: Buffer;
  tag: string;
  /** The instant past which this answer may not be served from any cache (KG-114); null: no cap. */
  capUntil: number | null;
  bytes: number;
  until: number;
};
/** One answer as served: the body in the asked encoding, the computation's tag and its cap. */
export type Served = { body: Buffer; tag: string; capUntil: number | null };

/**
 * The answers of the API (A§9.2): bounded by entries and by bytes (every stored variant counts), each kept for its
 * own TTL (never longer than the max-age it is sent with), least recently used first out. Only answers are stored,
 * never a failure. Callers that ask for a key while it is computed share that computation (single flight): its
 * result, or its error, which the route turns into a fresh fixed body, so no error object reaches a client. At most
 * `maxInflight` keys are computed at once, so a flood of distinct keys cannot grow the in-flight map. The `reserved`
 * keys, a closed set, are never refused. Keys are built from validated, normalised parameters only. One instance per
 * process, and a process serves one audience.
 */
export class Lru {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxInflight: number;
  private readonly reserved: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(opts: {
    maxEntries: number;
    maxBytes: number;
    maxInflight: number;
    reserved?: readonly string[];
    now: () => number;
  }) {
    this.maxEntries = opts.maxEntries;
    this.maxBytes = opts.maxBytes;
    this.maxInflight = opts.maxInflight;
    this.reserved = new Set(opts.reserved);
    this.now = opts.now;
  }

  get size(): { entries: number; bytes: number; inflight: number } {
    return { entries: this.entries.size, bytes: this.bytes, inflight: this.inflight.size };
  }

  /** The JSON of `key`, from the cache or one shared computation. */
  get(key: string, ttlMs: number, compute: () => Promise<string>): Promise<string> {
    return this.entry(key, ttlMs, async () => ({ json: await compute() })).then((e) => e.json.toString());
  }

  /** The answer of `key` in `enc`, compressed once per entry and variant; with the computation's tag. */
  async getEncoded(key: string, ttlMs: number, compute: () => Promise<Computed>, enc: Encoding): Promise<Served> {
    const e = await this.entry(key, ttlMs, compute);
    const served = (body: Buffer): Served => ({ body, tag: e.tag, capUntil: e.capUntil });
    if (enc === 'identity') return served(e.json);
    const have = e[enc];
    if (have !== undefined) return served(have);
    const body = encode(e.json, enc);
    if (this.entries.get(key) === e) {
      e[enc] = body;
      e.bytes += body.length;
      this.bytes += body.length;
      this.evict();
    }
    return served(body);
  }

  private entry(key: string, ttlMs: number, compute: () => Promise<Computed>): Promise<Entry> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.drop(key, hit);
      if (this.now() < hit.until) {
        this.entries.set(key, hit); // most recently used again
        this.bytes += hit.bytes;
        return Promise.resolve(hit);
      }
    }
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    if (this.inflight.size >= this.maxInflight && !this.reserved.has(key)) return Promise.reject(new Busy());
    // Deferred by a microtask, so a compute that throws at once still reaches the cleanup below.
    const p = Promise.resolve()
      .then(compute)
      .then((c) => this.put(key, c, ttlMs))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  private put(key: string, c: Computed, ttlMs: number): Entry {
    const json = Buffer.from(c.json);
    const now = this.now();
    const capUntil = c.capMs === undefined || !Number.isFinite(c.capMs) ? null : now + c.capMs;
    const until = Math.min(now + ttlMs, capUntil ?? Number.POSITIVE_INFINITY);
    const entry: Entry = { json, tag: c.tag ?? '', capUntil, bytes: json.length, until };
    if (json.length > this.maxBytes || until <= now) return entry;
    const old = this.entries.get(key);
    if (old !== undefined) this.drop(key, old);
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    this.evict();
    return entry;
  }

  /** Map order is insertion order: the first entries are the least recently used. */
  private evict(): void {
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.drop(k, e);
    }
  }
}
