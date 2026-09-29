// Politeness per host (A§7.3): full-jitter backoff from 30 s to 30 min that
// honours Retry-After, and a circuit breaker that opens after 5 consecutive
// failures and lets one probe through every 30 min. State lives in the process.

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

export type Gate = { wait: number } | { skip: 'breaker_open' };

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
      return { wait: 0 };
    }
    return { wait: Math.max(0, s.notBefore - now) };
  }

  success(host: string): void {
    this.hosts.set(host, { failures: 0, notBefore: 0, openUntil: null, probing: false });
  }

  /** A 5xx, 429, timeout or network error. */
  failure(host: string, now: number, retryAfterMs: number | null = null): void {
    const s = this.state(host);
    s.failures += 1;
    s.notBefore = now + (retryAfterMs ?? fullJitter(s.failures, this.random));
    if (s.probing || s.failures >= BREAKER_THRESHOLD) s.openUntil = now + BREAKER_PROBE_MS;
    s.probing = false;
  }

  isOpen(host: string): boolean {
    return this.hosts.get(host)?.openUntil != null;
  }
}

/**
 * A weighted semaphore over bytes in flight: each request reserves its decoded
 * cap, so several large bodies cannot exceed the capture container's memory.
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
    if (this.used + n > this.total || this.waiters.length > 0) {
      await new Promise<void>((resolve) => this.waiters.push({ n, resolve }));
    } else {
      this.used += n;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= n;
      while (this.waiters.length > 0) {
        const next = this.waiters[0] as { n: number; resolve: () => void };
        if (this.used + next.n > this.total) break;
        this.waiters.shift();
        this.used += next.n;
        next.resolve();
      }
    };
  }
}
