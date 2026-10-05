import { randomBytes } from 'node:crypto';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Busy, Lru, negotiate } from '../../src/api/lru.ts';

// The in-process answer cache of the public API: bounded, single flight, no failure kept.

type Opts = { maxEntries?: number; maxBytes?: number; maxInflight?: number; reserved?: string[] };

function setup(opts: Opts = {}) {
  const clock = { t: 1_000 };
  const lru = new Lru({ maxEntries: 100, maxBytes: 1_000_000, maxInflight: 64, ...opts, now: () => clock.t });
  return { clock, lru };
}

/** A compute that counts its calls per key and answers `body`. */
function counting() {
  const calls = new Map<string, number>();
  const compute = (key: string, body: string) => async () => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return body;
  };
  return { calls: (key: string) => calls.get(key) ?? 0, compute };
}

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
const TTL = 60_000;

describe('Lru: time to live', () => {
  it('serves a body within its TTL without computing again, and computes again at the TTL', async () => {
    const { clock, lru } = setup();
    const { calls, compute } = counting();
    expect(await lru.get('k', TTL, compute('k', 'one'))).toBe('one');
    clock.t += TTL - 1;
    expect(await lru.get('k', TTL, compute('k', 'two'))).toBe('one');
    expect(calls('k')).toBe(1);
    clock.t += 1;
    expect(await lru.get('k', TTL, compute('k', 'two'))).toBe('two');
    expect(calls('k')).toBe(2);
  });

  it('an expired entry is replaced, not added to: entries and bytes follow the new body', async () => {
    const { clock, lru } = setup();
    await lru.get('k', TTL, async () => 'aaaa');
    expect(lru.size).toEqual({ entries: 1, bytes: 4, inflight: 0 });
    clock.t += TTL;
    await lru.get('k', TTL, async () => 'bb');
    expect(lru.size).toEqual({ entries: 1, bytes: 2, inflight: 0 });
  });

  it('an expired entry is gone even when its recomputation fails', async () => {
    const { clock, lru } = setup();
    await lru.get('k', TTL, async () => 'aaaa');
    clock.t += TTL;
    await expect(lru.get('k', TTL, () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(lru.size).toEqual({ entries: 0, bytes: 0, inflight: 0 });
  });

  it('counts the TTL from when the answer arrived, and a hit does not extend it', async () => {
    const { clock, lru } = setup();
    const g = gate();
    const first = lru.get('k', TTL, () => g.promise);
    await tick();
    clock.t += 5_000;
    g.resolve('slow');
    expect(await first).toBe('slow');
    clock.t += TTL - 1;
    expect(await lru.get('k', 10 * TTL, async () => 'x')).toBe('slow');
    clock.t += 1;
    expect(await lru.get('k', 10 * TTL, async () => 'fresh')).toBe('fresh');
  });

  it('each call states the TTL of the body it stores', async () => {
    const { clock, lru } = setup();
    await lru.get('short', 1_000, async () => 's');
    await lru.get('long', 10_000, async () => 'l');
    clock.t += 1_000;
    expect(await lru.get('short', 1_000, async () => 's2')).toBe('s2');
    expect(await lru.get('long', 10_000, async () => 'l2')).toBe('l');
  });
});

describe('Lru: the bound on entries', () => {
  it('evicts the least recently used entry', async () => {
    const { lru } = setup({ maxEntries: 3 });
    const { calls, compute } = counting();
    for (const k of ['a', 'b', 'c', 'd']) await lru.get(k, TTL, compute(k, k));
    expect(lru.size.entries).toBe(3);
    // Only a was evicted; the others are hits (probed first: a miss would evict again).
    for (const k of ['b', 'c', 'd']) await lru.get(k, TTL, compute(k, k));
    expect(['b', 'c', 'd'].map(calls)).toEqual([1, 1, 1]);
    await lru.get('a', TTL, compute('a', 'a'));
    expect(calls('a')).toBe(2);
  });

  it('a hit makes the entry the most recently used', async () => {
    const { lru } = setup({ maxEntries: 3 });
    const { calls, compute } = counting();
    for (const k of ['a', 'b', 'c']) await lru.get(k, TTL, compute(k, k));
    await lru.get('a', TTL, compute('a', 'a'));
    await lru.get('d', TTL, compute('d', 'd'));
    // b was the least recently used.
    expect(lru.size).toEqual({ entries: 3, bytes: 3, inflight: 0 });
    for (const k of ['a', 'c', 'd']) await lru.get(k, TTL, compute(k, k));
    expect(['a', 'c', 'd'].map(calls)).toEqual([1, 1, 1]);
    await lru.get('b', TTL, compute('b', 'b'));
    expect(calls('b')).toBe(2);
  });

  it('a hit keeps the byte count', async () => {
    const { lru } = setup();
    await lru.get('a', TTL, async () => 'aaaa');
    await lru.get('b', TTL, async () => 'bb');
    for (let i = 0; i < 5; i++) await lru.get('a', TTL, async () => 'never');
    expect(lru.size).toEqual({ entries: 2, bytes: 6, inflight: 0 });
  });
});

describe('Lru: the bound on bytes', () => {
  it('counts UTF-8 bytes, not characters', async () => {
    const { lru } = setup();
    await lru.get('k', TTL, async () => 'aé€😀');
    // 1 + 2 + 3 + 4
    expect(lru.size.bytes).toBe(10);
    expect('aé€😀'.length).toBe(5);
  });

  it('evicts the least recently used until the bytes fit', async () => {
    const { lru } = setup({ maxBytes: 10 });
    const { calls, compute } = counting();
    await lru.get('a', TTL, compute('a', 'aaaa'));
    await lru.get('b', TTL, compute('b', 'bbbb'));
    expect(lru.size.bytes).toBe(8);
    // 6 bytes of 2 characters: 14 > 10, so a goes and b stays (4 + 6 = 10).
    await lru.get('c', TTL, compute('c', '€€'));
    expect(lru.size).toEqual({ entries: 2, bytes: 10, inflight: 0 });
    await lru.get('b', TTL, compute('b', 'bbbb'));
    await lru.get('c', TTL, compute('c', '€€'));
    expect([calls('b'), calls('c')]).toEqual([1, 1]);
    await lru.get('a', TTL, compute('a', 'aaaa'));
    expect(calls('a')).toBe(2);
  });

  it('one large body can evict several small ones', async () => {
    const { lru } = setup({ maxBytes: 10 });
    for (const k of ['a', 'b', 'c', 'd']) await lru.get(k, TTL, async () => k.repeat(2));
    expect(lru.size).toEqual({ entries: 4, bytes: 8, inflight: 0 });
    await lru.get('big', TTL, async () => 'x'.repeat(9));
    expect(lru.size).toEqual({ entries: 1, bytes: 9, inflight: 0 });
  });

  it('a body of exactly maxBytes is stored, one byte more is not', async () => {
    const { lru } = setup({ maxBytes: 10 });
    const { calls, compute } = counting();
    await lru.get('fits', TTL, compute('fits', 'x'.repeat(10)));
    await lru.get('fits', TTL, compute('fits', 'x'.repeat(10)));
    expect(calls('fits')).toBe(1);
    await lru.get('over', TTL, compute('over', 'x'.repeat(11)));
    await lru.get('over', TTL, compute('over', 'x'.repeat(11)));
    expect(calls('over')).toBe(2);
  });

  it('a body larger than maxBytes is returned but not stored, and evicts nothing', async () => {
    const { lru } = setup({ maxBytes: 10 });
    const { calls, compute } = counting();
    await lru.get('small', TTL, compute('small', 'abc'));
    // 4 characters, 12 bytes.
    expect(await lru.get('big', TTL, compute('big', '€€€€'))).toBe('€€€€');
    expect(lru.size).toEqual({ entries: 1, bytes: 3, inflight: 0 });
    expect(await lru.get('big', TTL, compute('big', '€€€€'))).toBe('€€€€');
    expect(calls('big')).toBe(2);
    await lru.get('small', TTL, compute('small', 'abc'));
    expect(calls('small')).toBe(1);
  });
});

describe('Lru: a failure is never stored', () => {
  it('a rejected compute is not cached: the next get computes again', async () => {
    const { lru } = setup();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 1) throw new Error('first');
      return 'ok';
    };
    await expect(lru.get('k', TTL, compute)).rejects.toThrow('first');
    expect(lru.size).toEqual({ entries: 0, bytes: 0, inflight: 0 });
    expect(await lru.get('k', TTL, compute)).toBe('ok');
    expect(await lru.get('k', TTL, compute)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('a failure keeps the entry of another key', async () => {
    const { lru } = setup();
    await lru.get('a', TTL, async () => 'a');
    await expect(lru.get('b', TTL, () => Promise.reject(new Error('b')))).rejects.toThrow('b');
    expect(lru.size).toEqual({ entries: 1, bytes: 1, inflight: 0 });
  });

  it('a compute that throws at once is a rejection and leaves no in-flight entry', async () => {
    const { lru } = setup({ maxInflight: 1 });
    const boom = new Error('sync');
    const p = lru.get('k', TTL, () => {
      throw boom;
    });
    await expect(p).rejects.toBe(boom);
    expect(lru.size.inflight).toBe(0);
    // The single in-flight slot is free again.
    expect(await lru.get('other', TTL, async () => 'ok')).toBe('ok');
    expect(await lru.get('k', TTL, async () => 'fine')).toBe('fine');
  });
});

describe('Lru: single flight', () => {
  it('concurrent gets of one key share one compute and one result', async () => {
    const { lru } = setup();
    const g = gate();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return g.promise;
    };
    const all = Array.from({ length: 20 }, () => lru.get('k', TTL, compute));
    await tick();
    expect(lru.size.inflight).toBe(1);
    g.resolve('shared');
    expect(await Promise.all(all)).toEqual(Array.from({ length: 20 }, () => 'shared'));
    expect(calls).toBe(1);
    expect(lru.size).toEqual({ entries: 1, bytes: 6, inflight: 0 });
    // And the next one is a hit.
    expect(await lru.get('k', TTL, compute)).toBe('shared');
    expect(calls).toBe(1);
  });

  it('concurrent gets of one key share one rejection, and none of them is stored', async () => {
    const { lru } = setup();
    const g = gate();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return g.promise;
    };
    const all = Array.from({ length: 20 }, () => lru.get('k', TTL, compute));
    await tick();
    const err = new Error('shared failure');
    g.reject(err);
    const settled = await Promise.allSettled(all);
    expect(settled.every((r) => r.status === 'rejected' && r.reason === err)).toBe(true);
    expect(calls).toBe(1);
    expect(lru.size).toEqual({ entries: 0, bytes: 0, inflight: 0 });
  });

  it('different keys are computed independently', async () => {
    const { lru } = setup();
    const { calls, compute } = counting();
    const [a, b] = await Promise.all([lru.get('a', TTL, compute('a', 'A')), lru.get('b', TTL, compute('b', 'B'))]);
    expect([a, b, calls('a'), calls('b')]).toEqual(['A', 'B', 1, 1]);
  });

  it('a caller after the answer arrived does not join a finished flight', async () => {
    const { lru } = setup({ maxBytes: 1 });
    const { calls, compute } = counting();
    // Too large to store: every get must compute, never reuse a settled promise.
    await lru.get('k', TTL, compute('k', 'xx'));
    await lru.get('k', TTL, compute('k', 'xx'));
    expect(calls('k')).toBe(2);
    expect(lru.size.inflight).toBe(0);
  });
});

describe('Lru: the in-flight cap', () => {
  it('rejects a new key with Busy, computes nothing for it and still joins a key in flight', async () => {
    const { lru } = setup({ maxInflight: 2 });
    const g = gate();
    const { calls, compute } = counting();
    const k1 = lru.get('k1', TTL, () => g.promise);
    const k2 = lru.get('k2', TTL, () => g.promise);
    await tick();
    expect(lru.size.inflight).toBe(2);

    const busy = lru.get('k3', TTL, compute('k3', 'x'));
    await expect(busy).rejects.toBeInstanceOf(Busy);
    await expect(busy).rejects.toThrow('busy');
    expect(calls('k3')).toBe(0);
    expect(lru.size.inflight).toBe(2);

    const joined = lru.get('k1', TTL, compute('k1', 'other'));
    expect(calls('k1')).toBe(0);
    g.resolve('done');
    expect(await Promise.all([k1, k2, joined])).toEqual(['done', 'done', 'done']);
    expect(lru.size.inflight).toBe(0);
  });

  it('serves a stored body while the cap is reached', async () => {
    const { lru } = setup({ maxInflight: 1 });
    await lru.get('hit', TTL, async () => 'stored');
    const g = gate();
    const running = lru.get('slow', TTL, () => g.promise);
    await tick();
    expect(await lru.get('hit', TTL, async () => 'never')).toBe('stored');
    await expect(lru.get('new', TTL, async () => 'never')).rejects.toBeInstanceOf(Busy);
    g.resolve('slow done');
    await running;
  });

  it('a settled key frees its slot, and so does a failed one', async () => {
    const { lru } = setup({ maxInflight: 1 });
    expect(await lru.get('a', TTL, async () => 'a')).toBe('a');
    await expect(lru.get('b', TTL, () => Promise.reject(new Error('b')))).rejects.toThrow('b');
    expect(await lru.get('c', TTL, async () => 'c')).toBe('c');
    expect(lru.size.inflight).toBe(0);
  });

  it('never refuses a reserved key: the map grows by at most the reserved keys', async () => {
    const { lru } = setup({ maxInflight: 1, reserved: ['meta', 'stations'] });
    const g = gate();
    const running = lru.get('a', TTL, () => g.promise);
    await tick();
    await expect(lru.get('b', TTL, async () => 'never')).rejects.toBeInstanceOf(Busy);
    const meta = lru.get('meta', TTL, () => g.promise);
    const stations = lru.get('stations', TTL, () => g.promise);
    await tick();
    expect(lru.size.inflight).toBe(3);
    // A reserved key in flight still counts against the others.
    await expect(lru.get('c', TTL, async () => 'never')).rejects.toBeInstanceOf(Busy);
    g.resolve('done');
    expect(await Promise.all([running, meta, stations])).toEqual(['done', 'done', 'done']);
    expect(lru.size.inflight).toBe(0);
  });

  it('a flood of distinct keys never holds more than maxInflight computations', async () => {
    const { lru } = setup({ maxInflight: 4 });
    const g = gate();
    let started = 0;
    const flood = Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        lru.get(`k${i}`, TTL, () => {
          started += 1;
          return g.promise;
        }),
      ),
    );
    await tick();
    expect(started).toBe(4);
    expect(lru.size.inflight).toBe(4);
    g.resolve('x');
    const settled = await flood;
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(settled.filter((r) => r.status === 'rejected' && r.reason instanceof Busy)).toHaveLength(46);
    expect(lru.size.inflight).toBe(0);
  });
});

describe('Lru: encoded variants (P9b)', () => {
  const doc = { series: 12, points: Array.from({ length: 200 }, (_, i) => ({ ts: i, v: i % 7 })), é: '€😀' };
  const json = JSON.stringify(doc);
  const computed = () => async () => ({ json });
  const text = (b: Buffer) => b.toString('utf8');

  it('serves identity, gzip and zstd bodies that decompress to the JSON', async () => {
    const { lru } = setup();
    const id = await lru.getEncoded('k', TTL, computed(), 'identity');
    const gz = await lru.getEncoded('k', TTL, computed(), 'gzip');
    const zs = await lru.getEncoded('k', TTL, computed(), 'zstd');
    expect(text(id.body)).toBe(json);
    expect(text(gunzipSync(gz.body))).toBe(json);
    expect(text(zstdDecompressSync(zs.body))).toBe(json);
    expect(gz.body.length).toBeLessThan(json.length);
    expect(zs.body.length).toBeLessThan(json.length);
    expect(JSON.parse(text(zstdDecompressSync(zs.body)))).toEqual(doc);
  });

  it('a variant is compressed once: the same bytes come back and size.bytes counts them once', async () => {
    const { lru } = setup();
    const { calls, compute } = counting();
    const one = () => async () => ({ json: await compute('k', json)() });
    const id = await lru.getEncoded('k', TTL, one(), 'identity');
    expect(lru.size).toEqual({ entries: 1, bytes: id.body.length, inflight: 0 });
    const gz1 = await lru.getEncoded('k', TTL, one(), 'gzip');
    const afterGzip = lru.size.bytes;
    expect(afterGzip).toBe(Buffer.byteLength(json) + gz1.body.length);
    const gz2 = await lru.getEncoded('k', TTL, one(), 'gzip');
    expect(gz2.body).toBe(gz1.body);
    expect(lru.size.bytes).toBe(afterGzip);
    const zs = await lru.getEncoded('k', TTL, one(), 'zstd');
    expect(lru.size.bytes).toBe(afterGzip + zs.body.length);
    expect(lru.size.entries).toBe(1);
    expect(calls('k')).toBe(1);
  });

  it('the plain get shares the entry of getEncoded', async () => {
    const { lru } = setup();
    const { calls, compute } = counting();
    await lru.getEncoded('k', TTL, async () => ({ json: await compute('k', json)() }), 'gzip');
    expect(await lru.get('k', TTL, compute('k', 'other'))).toBe(json);
    expect(calls('k')).toBe(1);
  });

  it('adding variants can evict older entries (the byte bound counts every variant)', async () => {
    const hex = () => randomBytes(500).toString('hex'); // 1,000 characters, about 4 bits each: gzip stays above 500
    const { lru } = setup({ maxBytes: 2_500 });
    const { calls, compute } = counting();
    const a = hex();
    const b = hex();
    await lru.getEncoded('b', TTL, async () => ({ json: await compute('b', b)() }), 'identity');
    await lru.getEncoded('a', TTL, async () => ({ json: await compute('a', a)() }), 'identity');
    expect(lru.size).toEqual({ entries: 2, bytes: 2_000, inflight: 0 });
    const gz = await lru.getEncoded('a', TTL, async () => ({ json: a }), 'gzip');
    expect(text(gunzipSync(gz.body))).toBe(a);
    // b was the least recently used and made room for a's gzip variant.
    expect(lru.size.entries).toBe(1);
    expect(lru.size.bytes).toBe(1_000 + gz.body.length);
    await lru.getEncoded('b', TTL, async () => ({ json: await compute('b', b)() }), 'identity');
    expect(calls('b')).toBe(2);
  });

  it('a body over maxBytes is returned in every encoding but nothing is stored or counted', async () => {
    const { lru } = setup({ maxBytes: 10 });
    const gz = await lru.getEncoded('k', TTL, computed(), 'gzip');
    expect(text(gunzipSync(gz.body))).toBe(json);
    expect(lru.size).toEqual({ entries: 0, bytes: 0, inflight: 0 });
  });

  it('an expired entry takes its variants with it', async () => {
    const { clock, lru } = setup();
    await lru.getEncoded('k', TTL, computed(), 'gzip');
    await lru.getEncoded('k', TTL, computed(), 'zstd');
    clock.t += TTL;
    await lru.getEncoded('k', TTL, async () => ({ json: 'tiny' }), 'identity');
    expect(lru.size).toEqual({ entries: 1, bytes: 4, inflight: 0 });
  });

  it('round-trips the tag and the cap of the computation, on a hit too', async () => {
    const { clock, lru } = setup();
    const compute = async () => ({ json, tag: '2026-10-01:3', capMs: 5_000 });
    const first = await lru.getEncoded('k', TTL, compute, 'identity');
    expect(first.tag).toBe('2026-10-01:3');
    expect(first.capUntil).toBe(1_000 + 5_000);
    clock.t += 1_000;
    const hit = await lru.getEncoded('k', TTL, async () => ({ json: 'never', tag: 'never' }), 'gzip');
    expect(hit.tag).toBe('2026-10-01:3');
    expect(hit.capUntil).toBe(6_000);
  });

  it('without a tag or a cap: an empty tag and a null cap; an infinite cap is no cap', async () => {
    const { lru } = setup();
    expect(await lru.getEncoded('a', TTL, computed(), 'identity')).toMatchObject({ tag: '', capUntil: null });
    const inf = await lru.getEncoded('b', TTL, async () => ({ json, capMs: Number.POSITIVE_INFINITY }), 'identity');
    expect(inf.capUntil).toBeNull();
    expect(lru.size.entries).toBe(2);
  });

  it('a cap of 0 (or less) is served but not stored: the next call computes again', async () => {
    const { clock, lru } = setup();
    let calls = 0;
    const compute = (capMs: number) => async () => {
      calls += 1;
      return { json, capMs };
    };
    const served = await lru.getEncoded('k', TTL, compute(0), 'gzip');
    expect(served.capUntil).toBe(clock.t);
    expect(text(gunzipSync(served.body))).toBe(json);
    expect(lru.size).toEqual({ entries: 0, bytes: 0, inflight: 0 });
    await lru.getEncoded('k', TTL, compute(0), 'gzip');
    expect(calls).toBe(2);
    await lru.getEncoded('k', TTL, compute(-5), 'identity');
    await lru.getEncoded('k', TTL, compute(-5), 'identity');
    expect(calls).toBe(4);
    expect(lru.size.entries).toBe(0);
  });

  it('a capped entry expires at its cap, before its TTL', async () => {
    const { clock, lru } = setup();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { json, capMs: 1_000 };
    };
    await lru.getEncoded('k', TTL, compute, 'identity');
    clock.t += 999;
    await lru.getEncoded('k', TTL, compute, 'identity');
    expect(calls).toBe(1);
    clock.t += 1;
    await lru.getEncoded('k', TTL, compute, 'identity');
    expect(calls).toBe(2);
  });

  it('a cap longer than the TTL does not extend it', async () => {
    const { clock, lru } = setup();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { json, capMs: 10 * TTL };
    };
    await lru.getEncoded('k', TTL, compute, 'identity');
    clock.t += TTL;
    await lru.getEncoded('k', TTL, compute, 'identity');
    expect(calls).toBe(2);
  });

  it('single flight: concurrent callers of different encodings share one computation', async () => {
    const { lru } = setup();
    const g = gate<{ json: string; tag: string }>();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return g.promise;
    };
    const all = (['zstd', 'gzip', 'identity', 'gzip', 'zstd'] as const).map((enc) =>
      lru.getEncoded('k', TTL, compute, enc),
    );
    await tick();
    expect(lru.size.inflight).toBe(1);
    g.resolve({ json, tag: 'T' });
    const [zs, gz, id, gz2, zs2] = await Promise.all(all);
    expect(calls).toBe(1);
    expect(text(zstdDecompressSync(zs?.body as Buffer))).toBe(json);
    expect(text(gunzipSync(gz?.body as Buffer))).toBe(json);
    expect(text(id?.body as Buffer)).toBe(json);
    expect(gz2?.body).toBe(gz?.body);
    expect(zs2?.body).toBe(zs?.body);
    expect([zs?.tag, gz?.tag, id?.tag]).toEqual(['T', 'T', 'T']);
    expect(lru.size.entries).toBe(1);
  });

  it('a failure is not stored and Busy still applies to getEncoded', async () => {
    const { lru } = setup({ maxInflight: 1 });
    await expect(lru.getEncoded('k', TTL, () => Promise.reject(new Error('down')), 'gzip')).rejects.toThrow('down');
    expect(lru.size).toEqual({ entries: 0, bytes: 0, inflight: 0 });
    const g = gate<{ json: string }>();
    const running = lru.getEncoded('a', TTL, () => g.promise, 'identity');
    await tick();
    await expect(lru.getEncoded('b', TTL, computed(), 'zstd')).rejects.toBeInstanceOf(Busy);
    g.resolve({ json });
    await running;
  });
});

describe('negotiate', () => {
  it.each([
    ['zstd, gzip', 'zstd'],
    ['gzip, zstd', 'zstd'],
    ['gzip, deflate, br, zstd', 'zstd'],
    ['gzip', 'gzip'],
    ['gzip, deflate', 'gzip'],
    ['GZIP', 'gzip'],
    ['Gzip;q=0.5', 'gzip'],
    ['zstd;q=1.0, gzip;q=0.5', 'zstd'],
    ['gzip;q=0.8, zstd;q=0.001', 'zstd'],
    ['gzip;q=0, zstd;q=0', 'identity'],
    ['gzip;q=0.0, zstd', 'zstd'],
    ['zstd;q=0, gzip', 'gzip'],
    ['br', 'identity'],
    ['br, deflate', 'identity'],
    ['identity', 'identity'],
    ['*', 'identity'],
    ['', 'identity'],
    ['gzipx', 'identity'],
    ['x-gzip', 'identity'],
  ])('%j gives %s', (header, enc) => {
    expect(negotiate(header)).toBe(enc);
  });

  it('a missing header is identity', () => {
    expect(negotiate(undefined)).toBe('identity');
  });

  it('an over-long header is identity, even when it starts with gzip', () => {
    expect(negotiate(`gzip, ${'x, '.repeat(300)}`)).toBe('identity');
    expect(negotiate(`gzip${' '.repeat(600)}`)).toBe('identity');
    // Right at the limit it is read.
    expect(negotiate(`gzip${' '.repeat(508)}`)).toBe('gzip');
  });
});
