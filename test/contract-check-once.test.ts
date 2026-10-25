import { describe, expect, it, vi } from 'vitest';
import { loadRegistry } from '../apps/server/src/capture/specs.ts';
import { readRegistry } from '../apps/server/src/load/registry-sync.ts';
import { check } from '../scripts/contract-check.ts';

// #217: scripts/contract-check.ts parses the registry once per process, however often check() runs (the CLI runs it
// once; test/contract-check.test.ts about 55 times). Its own file, so that this module state starts empty.

vi.mock('../apps/server/src/capture/specs.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../apps/server/src/capture/specs.ts')>();
  return { ...real, loadRegistry: vi.fn(real.loadRegistry) };
});
vi.mock('../apps/server/src/load/registry-sync.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../apps/server/src/load/registry-sync.ts')>();
  return { ...real, readRegistry: vi.fn(real.readRegistry) };
});

describe('the registry of the contract check', { timeout: 30_000 }, () => {
  it('is parsed once per process, however often check() runs', async () => {
    // Every fetch fails at once: no payload is parsed, only the registry is read.
    const deps = { fetch: async () => ({ ok: false as const, error: 'timeout' as const }), now: new Date() };
    const first = await check(deps);
    const second = await check(deps);
    expect(vi.mocked(loadRegistry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readRegistry)).toHaveBeenCalledTimes(1);
    for (const report of [first, second]) {
      expect(report.results).toHaveLength(12);
      expect(report.results.every((r) => r.code === 'fetch_timeout')).toBe(true);
    }
  });
});
