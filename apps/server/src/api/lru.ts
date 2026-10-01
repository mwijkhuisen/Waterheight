/** Too many distinct keys are being computed at once: a 503 with Retry-After. */
export class Busy extends Error {
  constructor() {
    super('busy');
  }
}

type Entry = { body: string; bytes: number; until: number };

/**
 * The answers of the API (A§9.2): bounded by entries and by bytes, each kept
 * for its own TTL (never longer than the max-age it is sent with), least
 * recently used first out. Only answers are stored, never a failure. Callers
 * that ask for a key while it is computed share that computation, its result or
 * its error (single flight); at most `maxInflight` keys are computed at once,
 * so a flood of distinct keys cannot grow the in-flight map. The `reserved`
 * keys, a closed set, are never refused: the map holds at most `maxInflight`
 * plus their number. One instance per process, and a process serves one
 * audience.
 */
export class Lru {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<string>>();
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

  get(key: string, ttlMs: number, compute: () => Promise<string>): Promise<string> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.drop(key, hit);
      if (this.now() < hit.until) {
        this.entries.set(key, hit); // most recently used again
        this.bytes += hit.bytes;
        return Promise.resolve(hit.body);
      }
    }
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    if (this.inflight.size >= this.maxInflight && !this.reserved.has(key)) return Promise.reject(new Busy());
    // Deferred by a microtask, so a compute that throws at once still reaches the cleanup below.
    const p = Promise.resolve()
      .then(compute)
      .then((body) => {
        this.put(key, body, ttlMs);
        return body;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  private put(key: string, body: string, ttlMs: number): void {
    const bytes = Buffer.byteLength(body);
    if (bytes > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old !== undefined) this.drop(key, old);
    this.entries.set(key, { body, bytes, until: this.now() + ttlMs });
    this.bytes += bytes;
    // Map order is insertion order: the first entries are the least recently used.
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.drop(k, e);
    }
  }
}
