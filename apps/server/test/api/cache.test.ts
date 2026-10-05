import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/api/cache.ts';

// The 30 s cache with single flight behind the health routes.

function setup(compute: () => Promise<number>) {
  const clock = { t: 0 };
  return { clock, cache: new TtlCache(compute, () => clock.t, 30_000, 5_000) };
}

describe('TtlCache', () => {
  it('computes once per period and again after it', async () => {
    let calls = 0;
    const { clock, cache } = setup(async () => ++calls);
    expect(await cache.get()).toBe(1);
    clock.t = 29_999;
    expect(await cache.get()).toBe(1);
    clock.t = 30_000;
    expect(await cache.get()).toBe(2);
    expect(calls).toBe(2);
  });

  it('concurrent callers share one computation', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { cache } = setup(async () => {
      calls += 1;
      await gate;
      return 7;
    });
    const all = Promise.all(Array.from({ length: 20 }, () => cache.get()));
    release();
    expect(await all).toEqual(Array.from({ length: 20 }, () => 7));
    expect(calls).toBe(1);
  });

  it('keeps a failure for 5 s, so a database that is down is not asked by every request', async () => {
    let calls = 0;
    const { clock, cache } = setup(async () => {
      calls += 1;
      throw new Error('down');
    });
    await expect(cache.get()).rejects.toThrow('down');
    clock.t = 4_999;
    await expect(cache.get()).rejects.toThrow('down');
    expect(calls).toBe(1);
    clock.t = 5_000;
    await expect(cache.get()).rejects.toThrow('down');
    expect(calls).toBe(2);
  });

  it('recovers after a failure, and survives a computation that throws at once', async () => {
    let calls = 0;
    const { clock, cache } = setup((() => {
      calls += 1;
      if (calls === 1) throw new Error('sync');
      return Promise.resolve(calls);
    }) as () => Promise<number>);
    await expect(cache.get()).rejects.toThrow('sync');
    clock.t = 5_000;
    expect(await cache.get()).toBe(2);
    expect(await cache.get()).toBe(2);
  });
});

describe('TtlCache: lastGood and transient failures (P9b)', () => {
  it('lastGood is undefined until the first success, then the newest value with its time', async () => {
    let n = 0;
    const clock = { t: 100 };
    const cache = new TtlCache(
      async () => {
        n += 1;
        if (n === 2) throw new Error('down');
        return n;
      },
      () => clock.t,
      30_000,
      5_000,
    );
    expect(cache.lastGood).toBeUndefined();
    expect(await cache.get()).toBe(1);
    expect(cache.lastGood).toEqual({ at: 100, value: 1 });
    clock.t = 31_000;
    await expect(cache.get()).rejects.toThrow('down');
    // A failure leaves the last good value and its time.
    expect(cache.lastGood).toEqual({ at: 100, value: 1 });
    clock.t = 40_000;
    expect(await cache.get()).toBe(3);
    expect(cache.lastGood).toEqual({ at: 40_000, value: 3 });
  });

  it('a transient failure is not cached: the next get computes again', async () => {
    let calls = 0;
    const busy = new Error('busy');
    const clock = { t: 0 };
    const cache = new TtlCache(
      async () => {
        calls += 1;
        if (calls <= 2) throw busy;
        return calls;
      },
      () => clock.t,
      30_000,
      5_000,
      (err) => err === busy,
    );
    await expect(cache.get()).rejects.toBe(busy);
    await expect(cache.get()).rejects.toBe(busy);
    expect(calls).toBe(2);
    expect(await cache.get()).toBe(3);
    expect(await cache.get()).toBe(3);
    expect(calls).toBe(3);
  });

  it('a non-transient failure is still cached for errorTtlMs when a transient test is given', async () => {
    let calls = 0;
    const clock = { t: 0 };
    const cache = new TtlCache(
      async () => {
        calls += 1;
        throw new Error('down');
      },
      () => clock.t,
      30_000,
      5_000,
      (err) => (err as Error).message === 'busy',
    );
    await expect(cache.get()).rejects.toThrow('down');
    clock.t = 4_999;
    await expect(cache.get()).rejects.toThrow('down');
    expect(calls).toBe(1);
    clock.t = 5_000;
    await expect(cache.get()).rejects.toThrow('down');
    expect(calls).toBe(2);
  });

  it('a transient failure after a good value leaves lastGood intact and the next get asks again', async () => {
    let calls = 0;
    const busy = new Error('busy');
    const clock = { t: 0 };
    const cache = new TtlCache(
      async () => {
        calls += 1;
        if (calls === 2) throw busy;
        return calls;
      },
      () => clock.t,
      1_000,
      5_000,
      (err) => err === busy,
    );
    expect(await cache.get()).toBe(1);
    clock.t = 1_000;
    await expect(cache.get()).rejects.toBe(busy);
    expect(cache.lastGood).toEqual({ at: 0, value: 1 });
    expect(await cache.get()).toBe(3);
  });

  it('concurrent callers share one transient failure', async () => {
    let calls = 0;
    const busy = new Error('busy');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cache = new TtlCache(
      async () => {
        calls += 1;
        await gate;
        throw busy;
      },
      () => 0,
      1_000,
      5_000,
      (err) => err === busy,
    );
    const all = Promise.allSettled(Array.from({ length: 10 }, () => cache.get()));
    release();
    expect((await all).every((r) => r.status === 'rejected' && r.reason === busy)).toBe(true);
    expect(calls).toBe(1);
  });
});
