import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PERMITS, permitsFrom, Saturated, Semaphore, WAIT_MS } from '../../src/api/semaphore.ts';

// The DB-concurrency semaphore of one api process (P9b): bounded permits, bounded waiters, bounded wait.

function gate<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('Semaphore: permits', () => {
  it('runs at most `permits` computations at once and reports the free count', async () => {
    const s = new Semaphore({ permits: 2 });
    const g = gate();
    let running = 0;
    let peak = 0;
    const job = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await g.promise;
      running -= 1;
      return 'done';
    };
    const all = Array.from({ length: 4 }, () => s.run(job));
    await tick();
    expect(running).toBe(2);
    expect(s.state).toEqual({ free: 0, waiting: 2 });
    g.resolve('go');
    expect(await Promise.all(all)).toEqual(['done', 'done', 'done', 'done']);
    expect(peak).toBe(2);
    expect(s.state).toEqual({ free: 2, waiting: 0 });
  });

  it('defaults to 2 x permits waiters and 250 ms', () => {
    expect(WAIT_MS).toBe(250);
    expect(DEFAULT_PERMITS).toEqual({ public: 16, owner: 2 });
  });

  it('beyond 2 x permits waiters the caller is Saturated at once, without waiting', async () => {
    const s = new Semaphore({ permits: 1 }); // 2 waiters
    const g = gate();
    const held = s.run(() => g.promise);
    const w1 = s.run(async () => 1);
    const w2 = s.run(async () => 2);
    await tick();
    expect(s.state).toEqual({ free: 0, waiting: 2 });
    await expect(s.run(async () => 3)).rejects.toBeInstanceOf(Saturated);
    expect(s.state).toEqual({ free: 0, waiting: 2 });
    g.resolve('x');
    expect(await Promise.all([held, w1, w2])).toEqual(['x', 1, 2]);
    expect(s.state).toEqual({ free: 1, waiting: 0 });
  });

  it('an explicit maxWaiters of 0 refuses every caller beyond the permits', async () => {
    const s = new Semaphore({ permits: 1, maxWaiters: 0 });
    const g = gate();
    const held = s.run(() => g.promise);
    await expect(s.run(async () => 1)).rejects.toBeInstanceOf(Saturated);
    g.resolve('x');
    await held;
  });
});

describe('Semaphore: waiting', () => {
  it('a waiter gets the permit when one is released, in FIFO order', async () => {
    const s = new Semaphore({ permits: 1 });
    const order: string[] = [];
    const g = gate();
    const first = s.run(async () => {
      order.push('first');
      await g.promise;
    });
    const second = s.run(async () => {
      order.push('second');
    });
    const third = s.run(async () => {
      order.push('third');
    });
    await tick();
    expect(order).toEqual(['first']);
    g.resolve('go');
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(s.state).toEqual({ free: 1, waiting: 0 });
  });

  it('the permit passes straight to a waiter: a late arrival cannot overtake it', async () => {
    const s = new Semaphore({ permits: 1 });
    const g = gate();
    const order: string[] = [];
    const held = s.run(() => g.promise);
    const waiter = s.run(async () => {
      order.push('waiter');
    });
    await tick();
    g.resolve('x');
    await held;
    // The release has already handed the permit over: a new caller queues behind it.
    const late = s.run(async () => {
      order.push('late');
    });
    await Promise.all([waiter, late]);
    expect(order).toEqual(['waiter', 'late']);
  });

  it('a waiter that waits waitMs without a permit is Saturated and leaves the queue', async () => {
    vi.useFakeTimers();
    const s = new Semaphore({ permits: 1, waitMs: 250 });
    const g = gate();
    const held = s.run(() => g.promise);
    const waiter = s.run(async () => 'never');
    const settled = waiter.then(
      () => 'ok',
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toEqual({ free: 0, waiting: 1 });
    await vi.advanceTimersByTimeAsync(249);
    expect(s.state.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toBeInstanceOf(Saturated);
    expect(s.state).toEqual({ free: 0, waiting: 0 });
    // The holder still owns its permit; releasing it frees exactly one.
    g.resolve('x');
    await held;
    expect(s.state).toEqual({ free: 1, waiting: 0 });
  });

  it('the default wait is 250 ms', async () => {
    vi.useFakeTimers();
    const s = new Semaphore({ permits: 1 });
    const g = gate();
    const held = s.run(() => g.promise);
    const settled = s
      .run(async () => 'never')
      .then(
        () => 'ok',
        (e: unknown) => e,
      );
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(s.state.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toBeInstanceOf(Saturated);
    g.resolve('x');
    await held;
  });

  it('a waiter that was granted in time does not time out afterwards', async () => {
    vi.useFakeTimers();
    const s = new Semaphore({ permits: 1, waitMs: 250 });
    const g = gate();
    const held = s.run(() => g.promise);
    const waiter = s.run(async () => 'served');
    await vi.advanceTimersByTimeAsync(100);
    g.resolve('x');
    await held;
    expect(await waiter).toBe('served');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.state).toEqual({ free: 1, waiting: 0 });
  });
});

describe('Semaphore: tryRun', () => {
  it('runs with a free permit and never waits without one', async () => {
    const s = new Semaphore({ permits: 1 });
    const g = gate();
    const held = s.tryRun(() => g.promise);
    expect(s.state).toEqual({ free: 0, waiting: 0 });
    await expect(s.tryRun(async () => 'never')).rejects.toBeInstanceOf(Saturated);
    // It did not queue either.
    expect(s.state).toEqual({ free: 0, waiting: 0 });
    g.resolve('x');
    expect(await held).toBe('x');
    expect(await s.tryRun(async () => 'again')).toBe('again');
    expect(s.state).toEqual({ free: 1, waiting: 0 });
  });

  it('does not jump the queue past waiters: it needs a free permit, and a hand-over leaves none', async () => {
    const s = new Semaphore({ permits: 1 });
    const g = gate();
    const held = s.run(() => g.promise);
    const g2 = gate();
    const waiter = s.run(() => g2.promise);
    await tick();
    g.resolve('x');
    await held;
    // The permit went to the waiter, so none is free for tryRun until the waiter is done.
    expect(s.state).toEqual({ free: 0, waiting: 0 });
    await expect(s.tryRun(async () => 'never')).rejects.toBeInstanceOf(Saturated);
    g2.resolve('w');
    await waiter;
    expect(s.state).toEqual({ free: 1, waiting: 0 });
  });
});

describe('Semaphore: the permit always returns', () => {
  it('on success', async () => {
    const s = new Semaphore({ permits: 3 });
    expect(await s.run(async () => 'ok')).toBe('ok');
    expect(s.state).toEqual({ free: 3, waiting: 0 });
  });

  it('on a throwing function', async () => {
    const s = new Semaphore({ permits: 2 });
    await expect(
      s.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(
      s.tryRun(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(s.state).toEqual({ free: 2, waiting: 0 });
  });

  it('on a rejected promise, a statement_timeout (57014) included, and the error is passed on unchanged', async () => {
    const s = new Semaphore({ permits: 2 });
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    await expect(s.run(() => Promise.reject(err))).rejects.toBe(err);
    await expect(s.tryRun(() => Promise.reject(err))).rejects.toBe(err);
    expect(s.state).toEqual({ free: 2, waiting: 0 });
  });

  it('a failing holder hands its permit to the next waiter', async () => {
    const s = new Semaphore({ permits: 1 });
    const g = gate();
    const failing = s.run(async () => {
      await g.promise;
      throw new Error('boom');
    });
    const next = s.run(async () => 'next');
    await tick();
    g.resolve('go');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('next');
    expect(s.state).toEqual({ free: 1, waiting: 0 });
  });

  it('is exact after a mix of successes, failures, refusals and timeouts', async () => {
    vi.useFakeTimers();
    const s = new Semaphore({ permits: 2, waitMs: 50 });
    const g = gate();
    const results = [
      s.run(() => g.promise),
      s.run(() => g.promise),
      s.run(async () => 'queued'),
      s.run(async () => 'queued2'),
      s.run(() => Promise.reject(new Error('queued3'))),
      s.run(async () => 'queued4'),
      s.run(async () => 'refused'),
    ].map((p) =>
      p.then(
        (v) => v,
        (e: unknown) => e,
      ),
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(s.state.waiting).toBe(0);
    g.resolve('go');
    await vi.advanceTimersByTimeAsync(0);
    const done = await Promise.all(results);
    expect(done.filter((d) => d instanceof Saturated).length).toBe(5);
    expect(s.state).toEqual({ free: 2, waiting: 0 });
  });
});

describe('permitsFrom', () => {
  it.each([undefined, ''])('%j gives the fallback', (raw) => {
    expect(permitsFrom(raw, 16)).toBe(16);
    expect(permitsFrom(raw, 2)).toBe(2);
  });

  it.each(['1', '2', '9', '10', '16', '63', '64'])('%j is accepted', (raw) => {
    expect(permitsFrom(raw, 5)).toBe(Number(raw));
  });

  it.each(['0', '00', '01', '65', '99', '100', '1.5', '-1', '+1', 'x', ' 4', '4 ', '1e1', '0x10'])(
    '%j is refused',
    (raw) => {
      expect(permitsFrom(raw, 5)).toBeUndefined();
    },
  );
});
