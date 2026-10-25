import { describe, expect, it, vi } from 'vitest';
import type { RenderCtx } from '../../src/publish/cycle.ts';
import { once } from '../../src/publish/render/series.ts';

// #218: the per-cycle memo of the publisher's shared reads. It hangs on the cycle's RenderCtx: one read per context
// and key, never shared between two contexts (another family, another database, the next cycle at the same clock),
// and a read that fails is not kept.

const dbA = {} as RenderCtx['db'];
const dbB = {} as RenderCtx['db'];
const ctx = (over: Partial<Pick<RenderCtx, 'db' | 'family' | 'now'>> = {}): RenderCtx =>
  ({ db: dbA, family: 'public', now: 1_000, ...over }) as RenderCtx;

describe('once (render/series.ts)', () => {
  it('reads once per context and key; another key is another read', async () => {
    const c = ctx();
    const read = vi.fn(async () => ({ n: 1 }));
    const a = await once(c, 'k', read);
    const b = await once(c, 'k', read);
    expect(b).toBe(a);
    expect(read).toHaveBeenCalledTimes(1);
    await once(c, 'other', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never hands one family, database or cycle the read of another', async () => {
    const read = (c: RenderCtx) => once(c, 'k', async () => `${c.family}:${c.db === dbA ? 'A' : 'B'}:${c.now}`);
    const pub = ctx();
    const own = ctx({ family: 'owner' });
    const other = ctx({ db: dbB });
    const next = ctx(); // the next cycle at the same clock (a test's fixed clock)
    expect(await read(pub)).toBe('public:A:1000');
    expect(await read(own)).toBe('owner:A:1000');
    expect(await read(other)).toBe('public:B:1000');
    const fresh = vi.fn(async () => 'next');
    expect(await once(next, 'k', fresh)).toBe('next');
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(await read(pub)).toBe('public:A:1000');
  });

  it('does not keep a read that failed: the next call reads again, and keeps that one', async () => {
    const c = ctx();
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('connection')).mockResolvedValue('ok');
    await expect(once(c, 'k', read)).rejects.toThrow('connection');
    expect(await once(c, 'k', read)).toBe('ok');
    expect(await once(c, 'k', read)).toBe('ok');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
