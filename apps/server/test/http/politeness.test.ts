import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_CAP_MS,
  BREAKER_FIRST_PROBE_MS,
  BREAKER_PROBE_MS,
  ByteBudget,
  breakerOpenMs,
  fullJitter,
  Politeness,
  parseRetryAfter,
} from '../../src/http/politeness.ts';

// Criterion "[CI] Backoff and the circuit breaker behave correctly under fake
// timers, and Retry-After is honoured" (issue #16; A§7.3).

afterEach(() => {
  vi.useRealTimers();
});

describe('full-jitter backoff', () => {
  it('stays within [0, min(30 min, 30 s · 2^(n−1))]', () => {
    for (let n = 1; n <= 12; n += 1) {
      const ceiling = Math.min(BACKOFF_CAP_MS, 30_000 * 2 ** (n - 1));
      expect(fullJitter(n, () => 0)).toBe(0);
      expect(fullJitter(n, () => 0.999999)).toBeLessThan(ceiling);
      expect(fullJitter(n, () => 0.999999)).toBeGreaterThan(ceiling * 0.99);
    }
    expect(fullJitter(1, () => 0.5)).toBe(15_000);
    expect(fullJitter(20, () => 0.5)).toBe(BACKOFF_CAP_MS / 2);
  });
});

describe('Retry-After', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  it('reads seconds and HTTP-dates, capped at 30 min', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Fri, 02 Oct 2026 12:05:00 GMT', now)).toBe(300_000);
    expect(parseRetryAfter('86400', now)).toBe(BACKOFF_CAP_MS);
    expect(parseRetryAfter('Fri, 02 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });

  it('overrides the jitter when given', () => {
    const p = new Politeness(() => 0.99);
    p.failure('h', 1000, 5000);
    expect(p.gate('h', 1000)).toEqual({ wait: 5000 });
  });
});

describe('per-host circuit breaker under fake timers', () => {
  const MIN = 60_000;

  it('opens after 5 consecutive failures, probes once at a time, and a success closes it', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-02T00:00:00Z') });
    const p = new Politeness(() => 0);
    const host = 'hubeau.eaufrance.fr';
    for (let i = 0; i < 4; i += 1) p.failure(host, Date.now());
    expect(p.isOpen(host)).toBe(false);
    expect(p.gate(host, Date.now())).toEqual({ wait: 0 });
    p.failure(host, Date.now());
    expect(p.isOpen(host)).toBe(true);
    expect(p.gate(host, Date.now())).toEqual({ skip: 'breaker_open' });
    // Another host is unaffected.
    expect(p.gate('other.example', Date.now())).toEqual({ wait: 0 });

    vi.advanceTimersByTime(BREAKER_FIRST_PROBE_MS - 1);
    expect(p.gate(host, Date.now())).toEqual({ skip: 'breaker_open' });
    vi.advanceTimersByTime(1);
    expect(p.gate(host, Date.now())).toEqual({ wait: 0, probe: true }); // the half-open probe
    expect(p.gate(host, Date.now())).toEqual({ skip: 'breaker_open' }); // only one at a time
    p.failure(host, Date.now()); // the probe fails: open again, now for 2 min
    vi.advanceTimersByTime(2 * MIN - 1);
    expect(p.gate(host, Date.now())).toEqual({ skip: 'breaker_open' });
    vi.advanceTimersByTime(1);
    expect(p.gate(host, Date.now())).toEqual({ wait: 0, probe: true });
    p.success(host);
    expect(p.isOpen(host)).toBe(false);
    expect(p.gate(host, Date.now())).toEqual({ wait: 0 });
  });

  it('#250: each failed probe doubles the open time, 1, 2, 4, 8, 16, then 30 min; it starts again at 1 min after an hour without an opening', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(breakerOpenMs)).toEqual([1, 2, 4, 8, 16, 30, 30, 30].map((m) => m * MIN));
    expect(breakerOpenMs(6)).toBe(BREAKER_PROBE_MS);
    vi.useFakeTimers({ now: Date.parse('2026-11-04T15:11:00Z') });
    const p = new Politeness(() => 0);
    const host = 'ddapi20-waterwebservices.rijkswaterstaat.nl';
    const opens: number[] = [];
    for (let i = 0; i < 5; i += 1) p.failure(host, Date.now());
    for (let probe = 0; probe < 7; probe += 1) {
      const openedAt = Date.now();
      while (!('probe' in p.gate(host, Date.now()))) vi.advanceTimersByTime(1000);
      opens.push((Date.now() - openedAt) / MIN);
      p.failure(host, Date.now()); // the probe fails again
    }
    expect(opens).toEqual([1, 2, 4, 8, 16, 30, 30]);
    while (!('probe' in p.gate(host, Date.now()))) vi.advanceTimersByTime(1000);
    p.success(host);
    // Less than an hour after the last opening, the sequence goes on (#250 review SR-4).
    for (let i = 0; i < 5; i += 1) p.failure(host, Date.now());
    expect(p.until(host)).toBe(Date.now() + 30 * MIN);
    while (!('probe' in p.gate(host, Date.now()))) vi.advanceTimersByTime(1000);
    p.success(host);
    vi.advanceTimersByTime(60 * MIN); // an hour without an opening
    for (let i = 0; i < 5; i += 1) p.failure(host, Date.now());
    expect(p.until(host)).toBe(Date.now() + MIN);
  });

  it('#250 review SR-1: an opening lasts at least the Retry-After, and the jitter never holds the probe back', () => {
    const p = new Politeness(() => 0.99);
    for (let i = 0; i < 4; i += 1) p.failure('h', 0);
    p.failure('h', 0, 20 * MIN); // the fifth failure says Retry-After: 1200
    expect(p.until('h')).toBe(20 * MIN);
    expect(p.gate('h', 20 * MIN - 1)).toEqual({ skip: 'breaker_open' });
    expect(p.gate('h', 20 * MIN)).toEqual({ wait: 0, probe: true });
    // The client sends nothing while until() is ahead (client.ts): at the probe it is not.
    expect(p.until('h')).toBe(20 * MIN);
    // Without a Retry-After, 99 % of the largest jitter does not hold the 1-min probe back.
    const q = new Politeness(() => 0.99);
    for (let i = 0; i < 5; i += 1) q.failure('h', 0);
    expect(q.gate('h', MIN)).toEqual({ wait: 0, probe: true });
    expect(q.until('h')).toBe(MIN);
  });

  it('#250 review SR-4: a host that admits the probe and then fails again climbs as a failing one does', () => {
    const p = new Politeness(() => 0);
    let t = 0;
    const steps: number[] = [];
    for (let cycle = 0; cycle < 6; cycle += 1) {
      for (let i = 0; i < 5; i += 1) p.failure('h', t);
      const opened = t;
      t = p.until('h');
      expect(p.gate('h', t)).toEqual({ wait: 0, probe: true });
      p.success('h'); // the probe gets through; the next five requests fail again
      steps.push((t - opened) / MIN);
    }
    expect(steps).toEqual([1, 2, 4, 8, 16, 30]);
  });

  it('a request already in flight that fails while the breaker is open re-arms the current step, not the next', () => {
    const p = new Politeness(() => 0);
    for (let i = 0; i < 5; i += 1) p.failure('h', 0);
    expect(p.until('h')).toBe(MIN);
    p.failure('h', 10_000); // the second connection's answer, after the breaker opened
    expect(p.until('h')).toBe(10_000 + MIN);
    // The probe after it fails: the second opening, 2 min.
    expect(p.gate('h', 10_000 + MIN)).toEqual({ wait: 0, probe: true });
    p.failure('h', 10_000 + MIN);
    expect(p.until('h')).toBe(10_000 + 3 * MIN);
  });

  it('a probe that ends without an answer still counts as a failed probe', () => {
    const p = new Politeness(() => 0);
    for (let i = 0; i < 5; i += 1) p.failure('h', 0);
    expect(p.gate('h', MIN)).toEqual({ wait: 0, probe: true });
    p.release('h', MIN);
    expect(p.until('h')).toBe(3 * MIN);
  });

  it('a success resets the failure count', () => {
    const p = new Politeness(() => 0);
    for (let i = 0; i < 4; i += 1) p.failure('h', 0);
    p.success('h');
    for (let i = 0; i < 4; i += 1) p.failure('h', 0);
    expect(p.isOpen('h')).toBe(false);
  });
});

describe('ByteBudget', () => {
  it('holds a request until its bytes are free, and lets a request that fits pass a larger waiter', async () => {
    const b = new ByteBudget(100);
    const r1 = await b.acquire(60);
    const order: string[] = [];
    const p2 = b.acquire(60).then((r) => {
      order.push('2');
      return r;
    });
    const p3 = b.acquire(10).then((r) => {
      order.push('3');
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual(['3']);
    r1();
    (await p2)();
    (await p3)();
    expect(order).toEqual(['3', '2']);
    // An oversized request is clamped to the total instead of waiting forever.
    (await b.acquire(1000))();
  });
});
