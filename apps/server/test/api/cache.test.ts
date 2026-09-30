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
