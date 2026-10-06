import { describe, expect, it } from 'vitest';
import { loadAudience, RuntimeConfigError } from '../src/lib/config/runtime.ts';

const answer =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('loadAudience', () => {
  it('reads a strict {audience}; a missing file or an invalid answer is public', async () => {
    expect(await loadAudience(answer(200, { audience: 'owner' }))).toBe('owner');
    expect(await loadAudience(answer(200, { audience: 'public' }))).toBe('public');
    for (const f of [
      answer(200, { audience: 'admin' }),
      answer(200, { audience: 'owner', extra: 1 }),
      answer(200, 'x'),
      answer(404, { audience: 'owner' }),
    ])
      expect(await loadAudience(f)).toBe('public');
  });

  it('throws on a failure to answer, so the owner site is never taken for the public one (review round 1)', async () => {
    for (const f of [
      answer(500, { audience: 'owner' }),
      answer(502, {}),
      answer(401, { audience: 'owner' }),
      async () => {
        throw new TypeError('network');
      },
    ])
      await expect(loadAudience(f)).rejects.toBeInstanceOf(RuntimeConfigError);
  });
});
