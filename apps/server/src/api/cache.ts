/**
 * One computed value, kept for `ttlMs`; a failure is kept for `errorTtlMs`, so a
 * database that is down is not asked again by every request. Callers that
 * arrive while it is computed share that one computation (single flight): the
 * database sees at most one ask per route per period, whatever the traffic.
 * A failure that `transient` accepts (P9b: no free DB permit) is not kept: the
 * next caller tries again, and `lastGood` keeps the newest value for the caller
 * to serve stale meanwhile.
 */
export class TtlCache<T> {
  private readonly compute: () => Promise<T>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly transient: (err: unknown) => boolean;
  private done: { until: number; result: PromiseSettledResult<T> } | undefined;
  private good: { at: number; value: T } | undefined;
  private running: Promise<T> | undefined;

  constructor(
    compute: () => Promise<T>,
    now: () => number,
    ttlMs: number,
    errorTtlMs: number,
    transient: (err: unknown) => boolean = () => false,
  ) {
    this.compute = compute;
    this.now = now;
    this.ttlMs = ttlMs;
    this.errorTtlMs = errorTtlMs;
    this.transient = transient;
  }

  /** The newest computed value and when it was computed, if any (whatever its TTL). */
  get lastGood(): { at: number; value: T } | undefined {
    return this.good;
  }

  get(): Promise<T> {
    if (this.done !== undefined && this.now() < this.done.until) {
      const { result } = this.done;
      return result.status === 'fulfilled' ? Promise.resolve(result.value) : Promise.reject(result.reason);
    }
    // Deferred by a microtask, so a computation that throws at once still clears `running` after it is set.
    this.running ??= Promise.resolve().then(() => this.refresh());
    return this.running;
  }

  private async refresh(): Promise<T> {
    try {
      const value = await this.compute();
      this.done = { until: this.now() + this.ttlMs, result: { status: 'fulfilled', value } };
      this.good = { at: this.now(), value };
      return value;
    } catch (reason) {
      if (!this.transient(reason))
        this.done = { until: this.now() + this.errorTtlMs, result: { status: 'rejected', reason } };
      throw reason;
    } finally {
      this.running = undefined;
    }
  }
}
