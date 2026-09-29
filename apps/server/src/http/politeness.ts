// Politeness per host (A§7.3): after a 5xx, 429, 403, 451, a status outside
// 100–599, a timeout or a network error, a full-jitter backoff from 30 s to 30 min that honours Retry-After,
// and a circuit breaker that opens after 5 consecutive failures and lets one
// probe through every 30 min. State lives in the process.

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 30 * 60_000;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_PROBE_MS = 30 * 60_000;

/** Full jitter: uniform in [0, min(cap, base · 2^(attempt−1))]. */
export function fullJitter(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

/** Retry-After as delay-seconds or an HTTP-date, capped at 30 min; null when absent or malformed. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  let ms: number;
  if (/^\d{1,10}$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(BACKOFF_CAP_MS, Math.max(0, ms));
}

type HostState = { failures: number; notBefore: number; openUntil: number | null; probing: boolean };

/** `probe`: this request is the one half-open probe; it must end in success, failure or release. */
export type Gate = { wait: number; probe?: true } | { skip: 'breaker_open' };

export class Politeness {
  private readonly hosts = new Map<string, HostState>();
  private readonly random: () => number;
  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { failures: 0, notBefore: 0, openUntil: null, probing: false };
      this.hosts.set(host, s);
    }
    return s;
  }

  /** May a request to `host` start now? A half-open breaker admits one probe at a time. */
  gate(host: string, now: number): Gate {
    const s = this.state(host);
    if (s.openUntil !== null) {
      if (now < s.openUntil || s.probing) return { skip: 'breaker_open' };
      s.probing = true;
      return { wait: 0, probe: true };
    }
    return { wait: Math.max(0, s.notBefore - now) };
  }

  success(host: string): void {
    this.hosts.set(host, { failures: 0, notBefore: 0, openUntil: null, probing: false });
  }

  /** A 5xx, 429, 403 or 451 (a WAF), a status outside 100–599, a timeout or a network error. */
  failure(host: string, now: number, retryAfterMs: number | null = null): void {
    const s = this.state(host);
    s.failures += 1;
    s.notBefore = now + (retryAfterMs ?? fullJitter(s.failures, this.random));
    if (s.probing || s.failures >= BREAKER_THRESHOLD) s.openUntil = now + BREAKER_PROBE_MS;
    s.probing = false;
  }

  /**
   * Ends a probe that got neither a success nor a failure (a DNS, redirect or
   * cap error): it counts as a failed probe, so the breaker re-arms instead of
   * staying half-open for good.
   */
  release(host: string, now: number): void {
    if (this.hosts.get(host)?.probing) this.failure(host, now);
  }

  isOpen(host: string): boolean {
    return this.hosts.get(host)?.openUntil != null;
  }
}

/**
 * A weighted semaphore over bytes in flight: each request reserves its decoded
 * cap for its transfer, so several large bodies cannot exceed the capture
 * container's memory.
 */
export class ByteBudget {
  private used = 0;
  private readonly waiters: { n: number; resolve: () => void }[] = [];
  readonly total: number;
  constructor(total: number) {
    this.total = total;
  }

  async acquire(bytes: number): Promise<() => void> {
    const n = Math.min(bytes, this.total);
    // A request that fits goes now, even past a larger waiter: no head-of-line blocking across hosts.
    if (this.used + n <= this.total) this.used += n;
    else await new Promise<void>((resolve) => this.waiters.push({ n, resolve }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= n;
      // ponytail: small requests can keep passing a large waiter; each holds its bytes for one transfer only.
      for (let i = 0; i < this.waiters.length; ) {
        const w = this.waiters[i] as { n: number; resolve: () => void };
        if (this.used + w.n > this.total) i += 1;
        else {
          this.waiters.splice(i, 1);
          this.used += w.n;
          w.resolve();
        }
      }
    };
  }
}
