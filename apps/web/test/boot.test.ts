import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootFiles, browserFetch, prefetchStatic } from '../src/lib/data/chain.ts';

// O4 (#220): the boot reads of main.tsx. `early` is module state, so every case consumes what it prefetched.

const ok = () => new Response('{}', { status: 200 });
const stub = (impl: () => Promise<Response> = async () => ok()) => {
  const f = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(impl);
  vi.stubGlobal('fetch', f);
  return f;
};

afterEach(() => vi.unstubAllGlobals());

describe('prefetchStatic and browserFetch', () => {
  it('hands the early answer to the first read only; a second read fetches again', async () => {
    const f = stub();
    prefetchStatic(['meta.json']);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[0]).toBe('/data/v1/meta.json');
    await browserFetch('/data/v1/meta.json');
    expect(f).toHaveBeenCalledTimes(1);
    await browserFetch('/data/v1/meta.json');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('leaves a path that was not prefetched to a normal fetch', async () => {
    const f = stub();
    prefetchStatic(['meta.json']);
    await browserFetch('/data/v1/stations.json');
    expect(f).toHaveBeenCalledTimes(2);
    await browserFetch('/data/v1/meta.json'); // consume
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('sends the same options early as on a normal read', async () => {
    const f = stub();
    prefetchStatic(['status.json']);
    await browserFetch('/data/v1/status.json');
    await browserFetch('/data/v1/status.json', new AbortController().signal);
    const [early, normal] = f.mock.calls.map((c) => c[1]);
    expect(early).toMatchObject({ redirect: 'error', headers: { accept: 'application/json' }, signal: null });
    expect({ ...normal, signal: null }).toEqual(early);
  });

  it('gives the reader a rejection and leaves none unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      stub(async () => {
        throw new TypeError('network');
      });
      prefetchStatic(['meta.json', 'stations.json']);
      await expect(browserFetch('/data/v1/meta.json')).rejects.toThrow('network');
      // stations.json is never read: its rejection is still handled
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
      await expect(browserFetch('/data/v1/stations.json')).rejects.toThrow('network');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('passes a non-OK answer on untouched, for getJson to turn into an HttpError', async () => {
    stub(async () => new Response('x', { status: 503 }));
    prefetchStatic(['meta.json']);
    expect((await browserFetch('/data/v1/meta.json')).status).toBe(503);
  });
});

describe('bootFiles', () => {
  const all = ['meta.json', 'stations.json', 'status.json'];
  const two = ['meta.json', 'stations.json'];

  it('skips status.json for each valid mode', () => {
    for (const m of ['state', 'delta', 'q']) expect(bootFiles(`?mode=${m}&s=x`)).toEqual(two);
  });

  it('reads status.json for an invalid or empty mode, or none (useMode then needs it)', () => {
    for (const s of ['', '?', '?mode=bogus', '?mode=', '?mode=DELTA', '?mode=delta%20', '?t=2026-11-20T14:00Z&s=a'])
      expect(bootFiles(s)).toEqual(all);
  });
});
