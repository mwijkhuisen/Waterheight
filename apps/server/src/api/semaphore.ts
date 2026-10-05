// The DB-concurrency semaphore of one api process (P9b, A§9.2): at most `permits` computations touch the database
// at once (a whole LRU miss or health computation takes one permit, however many transactions it runs), at most
// `maxWaiters` wait, each for at most `waitMs`; beyond that the caller gets `Saturated` (503 busy + Retry-After),
// never an unbounded queue. A permit returns in `finally` on every path: success, a driver error, a
// statement_timeout, and a client abort (the computation continues for its single flight; the permit returns when
// it settles).
// ponytail: 16 permits > the pool's 10 connections, so up to 6 computations wait in pg's own queue for at most its
// connectionTimeoutMillis; set RWS_API_DB_CONCURRENCY to the pool size if that bites.

/** No permit within the bounded wait: the route answers 503 `busy` with Retry-After. */
export class Saturated extends Error {
  constructor() {
    super('saturated');
  }
}

export const DEFAULT_PERMITS = { public: 16, owner: 2 } as const;
export const WAIT_MS = 250;

/** `RWS_API_DB_CONCURRENCY`: a whole number 1..64, else the family's default. */
export function permitsFrom(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]?$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= 64 ? n : undefined;
}

export class Semaphore {
  readonly permits: number;
  readonly #maxWaiters: number;
  readonly #waitMs: number;
  #free: number;
  readonly #waiters: { grant: () => void }[] = [];

  constructor(opts: { permits: number; maxWaiters?: number; waitMs?: number }) {
    this.permits = opts.permits;
    this.#free = opts.permits;
    this.#maxWaiters = opts.maxWaiters ?? 2 * opts.permits;
    this.#waitMs = opts.waitMs ?? WAIT_MS;
  }

  get state(): { free: number; waiting: number } {
    return { free: this.#free, waiting: this.#waiters.length };
  }

  /** Runs `fn` under a permit, waiting at most `waitMs` for one. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    return this.#hold(fn);
  }

  /** Runs `fn` under a permit only if one is free now (health under saturation); else rejects with Saturated. */
  tryRun<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free === 0) return Promise.reject(new Saturated());
    this.#free--;
    return this.#hold(fn);
  }

  async #hold<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve();
    }
    if (this.#waiters.length >= this.#maxWaiters) return Promise.reject(new Saturated());
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Saturated());
      }, this.#waitMs);
      timer.unref();
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    // The permit passes straight to the next waiter; only without one does it become free.
    if (next !== undefined) next.grant();
    else this.#free++;
  }
}
