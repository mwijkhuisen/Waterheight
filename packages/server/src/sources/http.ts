/**
 * The HTTP machinery every source adapter needs: a politeness cap on outbound
 * concurrency, retry with exponential backoff and jitter, and timeouts.
 *
 * This was Rijkswaterstaat-specific until sources became a dimension. None of
 * it ever was: what differs between services is how a response is *classified*
 * -- which statuses mean "no data", which mean "try again" -- not how requests
 * are paced. So classification stays in each adapter and the pacing lives here.
 *
 * The gate is per source and not global on purpose. Hub'Eau documents ~10
 * calls/s and PEGELONLINE documents nothing; one shared semaphore would let a
 * slow service throttle a fast one, and a backfill against one source would
 * stall every other source's refresh behind it.
 */

/** A failure from an upstream source, carrying enough to decide about retrying. */
export class SourceError extends Error {
  constructor(
    readonly sourceId: string,
    message: string,
    readonly status: number | null,
    readonly body?: unknown,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

/** Per-source tolerances. Services differ enough that one set will not do. */
export interface SourceHttpConfig {
  timeoutMs: number;
  /** Politeness cap on concurrent outbound calls to this source. */
  maxConcurrency: number;
  maxRetries: number;
}

/** Bounded-concurrency gate so we stay a polite API consumer. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, so retries do not synchronise. */
export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.random() * base;
}

export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface SourceHttpClient {
  readonly sourceId: string;
  readonly config: SourceHttpConfig;
  /**
   * Run one request through this source's gate and retry policy.
   *
   * `run` receives a signal already composed from the caller's and the timeout,
   * and is expected to throw a `SourceError` for anything it considers a
   * failure -- setting `retryable` decides whether it gets another go. Anything
   * else that throws (a socket reset, a timeout) is treated as retryable,
   * because it says nothing about whether the request was well-formed.
   */
  request<T>(label: string, run: (signal: AbortSignal) => Promise<T>, options?: RequestOptions): Promise<T>;
  /** A timeout signal at this source's configured tolerance. */
  timeoutSignal(timeoutMs?: number): AbortSignal;
  /** Run through the gate without the retry loop, for callers that retry themselves. */
  gated<T>(fn: () => Promise<T>): Promise<T>;
}

function createClient(sourceId: string, config: SourceHttpConfig): SourceHttpClient {
  const gate = new Semaphore(config.maxConcurrency);

  return {
    sourceId,
    config,

    timeoutSignal(timeoutMs = config.timeoutMs) {
      return AbortSignal.timeout(timeoutMs);
    },

    gated(fn) {
      return gate.run(fn);
    },

    async request<T>(
      label: string,
      run: (signal: AbortSignal) => Promise<T>,
      options: RequestOptions = {},
    ): Promise<T> {
      const maxRetries = options.maxRetries ?? config.maxRetries;
      const timeoutMs = options.timeoutMs ?? config.timeoutMs;
      let lastError: SourceError | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await sleep(backoffMs(attempt - 1));

        try {
          return await gate.run(() => {
            const timeout = AbortSignal.timeout(timeoutMs);
            const signal = options.signal
              ? AbortSignal.any([options.signal, timeout])
              : timeout;
            return run(signal);
          });
        } catch (err) {
          if (err instanceof SourceError) {
            lastError = err;
            if (!err.retryable) throw err;
          } else {
            // Network failures and timeouts are retryable.
            lastError = new SourceError(
              sourceId,
              `${sourceId} ${label} request failed: ${(err as Error).message}`,
              null,
              undefined,
              true,
            );
          }
        }
      }

      throw lastError ?? new SourceError(sourceId, `${sourceId} ${label} failed`, null);
    },
  };
}

/**
 * One client per source, created once.
 *
 * Memoised because the gate is the point: a second client would be a second
 * semaphore, and two semaphores of four are eight concurrent requests.
 */
const clients = new Map<string, SourceHttpClient>();

export function httpClientFor(sourceId: string, config: SourceHttpConfig): SourceHttpClient {
  let client = clients.get(sourceId);
  if (!client) {
    client = createClient(sourceId, config);
    clients.set(sourceId, client);
  }
  return client;
}
