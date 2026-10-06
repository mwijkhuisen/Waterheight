import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig, RuntimeConfigError } from '../src/lib/config/runtime.ts';

const answer =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('loadRuntimeConfig', () => {
  it('reads a strict {audience}; a missing file or an invalid answer is public', async () => {
    expect((await loadRuntimeConfig(answer(200, { audience: 'owner' }))).audience).toBe('owner');
    expect((await loadRuntimeConfig(answer(200, { audience: 'public' }))).audience).toBe('public');
    for (const f of [
      answer(200, { audience: 'admin' }),
      answer(200, { audience: 'owner', extra: 1 }),
      answer(200, 'x'),
      answer(404, { audience: 'owner' }),
    ])
      expect(await loadRuntimeConfig(f)).toEqual({ audience: 'public' });
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
      await expect(loadRuntimeConfig(f)).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it('reads the operator, the contact and the CDN that Caddy fills in (P10b)', async () => {
    const body = { audience: 'public', contact: 'contact@example.org', operator: 'Jan de Vries', cdn: '' };
    expect(await loadRuntimeConfig(answer(200, body))).toEqual(body);
  });

  it('drops a bad optional field on its own and keeps the audience (P10b)', async () => {
    for (const bad of [
      { contact: 'not an address' },
      { contact: '' },
      { operator: '' },
      { operator: '<img src=x onerror=alert(1)>' },
      { operator: 'line\nbreak' },
      { operator: 'x'.repeat(121) },
      { cdn: 'a<b' },
      { cdn: 7 },
    ]) {
      const got = await loadRuntimeConfig(answer(200, { audience: 'owner', ...bad }));
      expect(got.audience, JSON.stringify(bad)).toBe('owner');
      for (const key of Object.keys(bad)) expect(got[key as keyof typeof got], key).toBeUndefined();
    }
  });
});
