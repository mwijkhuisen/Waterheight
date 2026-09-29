import { expect, it } from 'vitest';

it('fails any request that has no msw handler', async () => {
  await expect(fetch('https://example.invalid/unhandled')).rejects.toThrow();
});
