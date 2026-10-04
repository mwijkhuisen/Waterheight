import { describe, expect, it } from 'vitest';
import { loadAudience } from '../src/lib/config/runtime.ts';

const answer =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('loadAudience', () => {
  it('reads a strict {audience}; anything else is public', async () => {
    expect(await loadAudience(answer(200, { audience: 'owner' }))).toBe('owner');
    expect(await loadAudience(answer(200, { audience: 'public' }))).toBe('public');
    for (const f of [
      answer(200, { audience: 'admin' }),
      answer(200, { audience: 'owner', extra: 1 }),
      answer(401, { audience: 'owner' }),
      answer(200, 'x'),
      async () => {
        throw new TypeError('network');
      },
    ])
      expect(await loadAudience(f)).toBe('public');
  });
});
